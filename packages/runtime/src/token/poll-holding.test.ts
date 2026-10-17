import type { Address, TokenBalances, TokenChainReader } from '@prix/contracts';
import {
  POLL_TALLY_ANSWER_MAX_BYTES,
  POLL_TALLY_FETCH_TIMEOUT_MS,
  POLL_TALLY_MAX_FETCHES,
  POLL_TALLY_SLOW_ANSWER_MS,
  TokenReadError,
} from '@prix/contracts';
import { PUBLIC_RPC_URLS } from '@prix/market/chain';
import { describe, expect, it } from 'vitest';
import { createPollFetchMeter, createPollHoldingReader } from './poll-holding.ts';

/**
 * The tally's holding reader (docs/contracts/phase-6-holders.md section 5): one `readBalances` a call, each
 * tier by `computeTier` at the configured thresholds, no hold before a rise, no `token_holders` row (the
 * reader has no store at all), `atBlock` passed as the read's block tag, and its fetches counted to the run.
 */

const TOKEN = '0xa74ac6e9f2f8493344923c23972d496364241044' as Address;
const SUPPLY = 1_000_000_000n * 10n ** 18n;
const whole = (tokens: bigint): bigint => tokens * 10n ** 18n;
const wallet = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}` as Address;

const CONFIG = { token: TOKEN, thresholdsPpm: [10, 100, 1000] as const, gatingOn: true };

function chainOf(balances: (wallets: readonly Address[]) => bigint[], head = 1_000n) {
  const calls: { token: Address; wallets: readonly Address[]; args: number; atBlock: number | undefined }[] = [];
  const chain: TokenChainReader = {
    async readBalances(token, wallets, ...rest: [number?]): Promise<TokenBalances> {
      const atBlock = rest[0];
      calls.push({ token, wallets, args: 2 + rest.length, atBlock });
      return {
        totalSupply: SUPPLY,
        decimals: 18,
        balances: balances(wallets),
        blockNumber: atBlock === undefined ? head : BigInt(atBlock),
      };
    },
  };
  return { chain, calls };
}

describe('tiersNow', () => {
  it('computes each tier at the configured thresholds, in the wallets order, with no hold', async () => {
    const amounts = [0n, whole(9_999n), whole(10_000n), whole(100_000n), whole(1_000_000n)];
    const { chain, calls } = chainOf(() => amounts);
    const reader = createPollHoldingReader({ chain, config: async () => CONFIG });
    const wallets = [1, 2, 3, 4, 5].map(wallet);
    const read = await reader.tiersNow(wallets, null);
    expect(read.gatingOn).toBe(true);
    expect(read.tiers).toEqual([0, 0, 1, 2, 3]);
    expect(read.blockNumber).toBe(1_000);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.token).toBe(TOKEN);
    expect(calls[0]?.wallets).toEqual(wallets);
  });

  it('reads at the head with no block tag, and at a block with that block as the tag', async () => {
    const { chain, calls } = chainOf((w) => w.map(() => 0n));
    const reader = createPollHoldingReader({ chain, config: async () => CONFIG });
    await reader.tiersNow([wallet(1)], null);
    const pinned = await reader.tiersNow([wallet(1)], 950);
    expect(calls[0]?.args).toBe(2);
    expect(calls[0]?.atBlock).toBeUndefined();
    expect(calls[1]?.args).toBe(3);
    expect(calls[1]?.atBlock).toBe(950);
    expect(pinned.blockNumber).toBe(950);
  });

  it('uses the configured thresholds, not the defaults', async () => {
    const { chain } = chainOf(() => [whole(7_000n)]);
    const reader = createPollHoldingReader({
      chain,
      config: async () => ({ ...CONFIG, thresholdsPpm: [7, 100, 1000] as const }),
    });
    expect((await reader.tiersNow([wallet(1)], null)).tiers).toEqual([1]);
  });

  it('answers gating off with no chain read while gating is off or no token is configured', async () => {
    for (const config of [
      { ...CONFIG, gatingOn: false },
      { ...CONFIG, token: null },
    ]) {
      const { chain, calls } = chainOf((w) => w.map(() => whole(1_000_000n)));
      const reader = createPollHoldingReader({ chain, config: async () => config });
      const read = await reader.tiersNow([wallet(1), wallet(2)], null);
      expect(read.gatingOn).toBe(false);
      expect(read.tiers).toEqual([0, 0]);
      expect(calls).toHaveLength(0);
    }
  });

  it('throws when the chain answers a different number of balances or a block that is not a safe number', async () => {
    const short = chainOf(() => [0n]);
    await expect(
      createPollHoldingReader({ chain: short.chain, config: async () => CONFIG }).tiersNow(
        [wallet(1), wallet(2)],
        null,
      ),
    ).rejects.toBeInstanceOf(TokenReadError);
    const huge = chainOf(() => [0n], 2n ** 60n);
    await expect(
      createPollHoldingReader({ chain: huge.chain, config: async () => CONFIG }).tiersNow([wallet(1)], null),
    ).rejects.toBeInstanceOf(TokenReadError);
  });

  it('passes a chain failure on', async () => {
    const chain: TokenChainReader = {
      async readBalances() {
        throw new TokenReadError('rpc_unavailable');
      },
    };
    await expect(
      createPollHoldingReader({ chain, config: async () => CONFIG }).tiersNow([wallet(1)], null),
    ).rejects.toThrow(TokenReadError);
  });
});

const [OFFICIAL, PUBLICNODE, DRPC] = PUBLIC_RPC_URLS as [string, string, string];
const OK_BODY = '{"jsonrpc":"2.0","id":1,"result":"0x01"}';
const okAnswer = (): Response =>
  new Response(OK_BODY, { status: 200, headers: { 'content-type': 'application/json' } });
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const urlOf = (input: RequestInfo | URL): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
const hostOf = (input: RequestInfo | URL): string => new URL(urlOf(input)).host;

/** A body whose bytes come `delayMs` after the headers, on the real clock; never, when `delayMs` is null. */
function lateBody(text: string, delayMs: number | null): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (delayMs === null) return;
      setTimeout(() => {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      }, delayMs);
    },
  });
}

/** A fake fetch per host, counting what reaches it. */
function endpoints(answer: (host: string, n: number, init?: RequestInit) => Promise<Response>) {
  const sent: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const host = hostOf(input);
    sent.push(host);
    return answer(host, sent.filter((h) => h === host).length, init);
  }) as typeof fetch;
  return { fetchFn, sent, count: (url: string) => sent.filter((h) => h === new URL(url).host).length };
}

/** The error the meter rejects with carries nothing: no URL, no host, no word of the endpoint's. */
async function carriesNothing(promise: Promise<unknown>): Promise<void> {
  const error = await promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (e: unknown) => e,
  );
  const text = `${String((error as Error)?.message)} ${String((error as Error)?.stack)}`;
  for (const url of PUBLIC_RPC_URLS) expect(text).not.toContain(new URL(url).host);
  expect(text).not.toContain('secret-word');
}

/**
 * The run's endpoint memory (docs/contracts/phase-6-holders.md section 5, "One endpoint memory per run",
 * revisions 8 to 8f): an endpoint that failed or refused once is not asked again in the run; the 1,500 ms abort
 * runs to the end of the clone's read; the clone is read up to POLL_TALLY_ANSWER_MAX_BYTES; an answer taken alone
 * that comes later than POLL_TALLY_SLOW_ANSWER_MS is used and marks its endpoint, a third party's never.
 */
describe('the run endpoint memory', () => {
  it('reads every figure from @prix/contracts', () => {
    expect(POLL_TALLY_MAX_FETCHES).toBe(11);
    expect(POLL_TALLY_FETCH_TIMEOUT_MS).toBe(1_500);
    expect(POLL_TALLY_SLOW_ANSWER_MS).toBe(750);
    expect(POLL_TALLY_ANSWER_MAX_BYTES).toBe(262_144);
  });

  it('asks an endpoint that answered 429 once a run, refuses it after without counting, and asks it again in a new run', async () => {
    const e = endpoints(async (host) =>
      host === new URL(OFFICIAL).host ? new Response('slow down secret-word', { status: 429 }) : okAnswer(),
    );
    const meter = createPollFetchMeter(e.fetchFn);
    meter.startRun();
    // An answer outside 2xx is never handed on: the fetch rejects with the error that carries nothing.
    await carriesNothing(meter.fetch(OFFICIAL));
    await carriesNothing(meter.fetch(OFFICIAL));
    expect((await meter.fetch(PUBLICNODE)).status).toBe(200);
    expect(e.count(OFFICIAL)).toBe(1);
    expect(meter.spent()).toBe(2);
    meter.startRun();
    expect(meter.spent()).toBe(0);
    await carriesNothing(meter.fetch(OFFICIAL));
    expect(e.count(OFFICIAL)).toBe(2);
  });

  it('cancels the body of an answer outside 2xx unread and rejects at once: 429, 403, 503 and 301 whose bodies never end (PF5-SEC-1)', async () => {
    const cancelled: string[] = [];
    const statusOf: Record<string, number> = {
      [new URL(OFFICIAL).host]: 429,
      [new URL(PUBLICNODE).host]: 503,
      [new URL(DRPC).host]: 403,
    };
    /** A body that never sends a byte and records its cancel. */
    const stalled = (host: string): ReadableStream<Uint8Array> =>
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelled.push(host);
        },
      });
    const e = endpoints(async (host) => new Response(stalled(host), { status: statusOf[host] ?? 301 }));
    const meter = createPollFetchMeter(e.fetchFn);
    const start = Date.now();
    for (const url of [OFFICIAL, PUBLICNODE, DRPC, 'https://rpc.example.test/']) await carriesNothing(meter.fetch(url));
    // Rejected on the status, without waiting for a body or for the 1,500 ms.
    expect(Date.now() - start).toBeLessThan(POLL_TALLY_FETCH_TIMEOUT_MS);
    await sleep(0);
    expect(cancelled.sort()).toEqual(
      [new URL(OFFICIAL).host, new URL(PUBLICNODE).host, new URL(DRPC).host, 'rpc.example.test'].sort(),
    );
    // Each host is marked: refused after without being asked or counted.
    for (const url of [OFFICIAL, PUBLICNODE, DRPC, 'https://rpc.example.test/']) await carriesNothing(meter.fetch(url));
    expect(e.sent).toHaveLength(4);
    expect(meter.spent()).toBe(4);
  });

  it('marks an endpoint whose 200 holds a JSON-RPC error and hands that answer on', async () => {
    const e = endpoints(
      async () =>
        new Response('{"jsonrpc":"2.0","id":1,"error":{"code":-32005,"message":"secret-word"}}', { status: 200 }),
    );
    const meter = createPollFetchMeter(e.fetchFn);
    const answer = await meter.fetch(OFFICIAL);
    expect(await answer.json()).toMatchObject({ error: { code: -32005 } });
    await carriesNothing(meter.fetch(OFFICIAL));
    expect(e.count(OFFICIAL)).toBe(1);
  });

  it('marks an endpoint whose fetch rejects, and rejects with an error that carries nothing', async () => {
    const e = endpoints(async () => {
      throw new Error(`connect failed to ${new URL(OFFICIAL).host} secret-word`);
    });
    const meter = createPollFetchMeter(e.fetchFn);
    await carriesNothing(meter.fetch(OFFICIAL));
    await carriesNothing(meter.fetch(OFFICIAL));
    expect(e.count(OFFICIAL)).toBe(1);
    expect(meter.spent()).toBe(1);
  });

  it('aborts a fetch that never answers after 1,500 ms and marks its endpoint', async () => {
    let aborted = false;
    const e = endpoints(
      (_host, _n, init) =>
        new Promise<Response>(() => {
          init?.signal?.addEventListener('abort', () => {
            aborted = true;
          });
        }),
    );
    const meter = createPollFetchMeter(e.fetchFn);
    const start = Date.now();
    await carriesNothing(meter.fetch(OFFICIAL));
    const took = Date.now() - start;
    expect(took).toBeGreaterThanOrEqual(POLL_TALLY_FETCH_TIMEOUT_MS - 20);
    expect(took).toBeLessThan(POLL_TALLY_FETCH_TIMEOUT_MS + 400);
    expect(aborted).toBe(true);
    await carriesNothing(meter.fetch(OFFICIAL));
    expect(e.count(OFFICIAL)).toBe(1);
  });

  it('runs the 1,500 ms to the end of the clone read: headers at once and no whole body by then marks the endpoint', async () => {
    const e = endpoints(async () => new Response(lateBody(OK_BODY, null), { status: 200 }));
    const meter = createPollFetchMeter(e.fetchFn);
    const start = Date.now();
    await carriesNothing(meter.fetch(OFFICIAL));
    expect(Date.now() - start).toBeLessThan(POLL_TALLY_FETCH_TIMEOUT_MS + 400);
    await carriesNothing(meter.fetch(OFFICIAL));
    expect(e.count(OFFICIAL)).toBe(1);
  });

  it('marks an endpoint whose body passes POLL_TALLY_ANSWER_MAX_BYTES, or whose Content-Length says so', async () => {
    const long = `{"jsonrpc":"2.0","id":1,"result":"0x${'0'.repeat(1024 * 1024)}"}`;
    const e = endpoints(async (host) =>
      host === new URL(OFFICIAL).host
        ? new Response(long, { status: 200 })
        : new Response(lateBody(OK_BODY, null), {
            status: 200,
            headers: { 'content-length': String(POLL_TALLY_ANSWER_MAX_BYTES + 1) },
          }),
    );
    const meter = createPollFetchMeter(e.fetchFn);
    await carriesNothing(meter.fetch(OFFICIAL));
    await carriesNothing(meter.fetch(OFFICIAL));
    const start = Date.now();
    await carriesNothing(meter.fetch(PUBLICNODE));
    // Refused on its header, without waiting for a body.
    expect(Date.now() - start).toBeLessThan(500);
    await carriesNothing(meter.fetch(PUBLICNODE));
    expect(e.count(OFFICIAL)).toBe(1);
    expect(e.count(PUBLICNODE)).toBe(1);
  });

  it('marks an endpoint whose clone read rejects', async () => {
    const e = endpoints(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new Error('secret-word'));
            },
          }),
          { status: 200 },
        ),
    );
    const meter = createPollFetchMeter(e.fetchFn);
    await carriesNothing(meter.fetch(OFFICIAL));
    await carriesNothing(meter.fetch(OFFICIAL));
    expect(e.count(OFFICIAL)).toBe(1);
  });

  it('takes the host of a string, a URL and a Request, and refuses an input with no host, uncounted', async () => {
    const e = endpoints(async () => new Response('no', { status: 503 }));
    const meter = createPollFetchMeter(e.fetchFn);
    await carriesNothing(meter.fetch(new URL(OFFICIAL)));
    await carriesNothing(meter.fetch(OFFICIAL));
    await carriesNothing(meter.fetch(new Request(`${OFFICIAL}/`, { method: 'POST', body: '{}' })));
    await carriesNothing(meter.fetch(new Request(PUBLICNODE, { method: 'POST', body: '{}' })));
    await carriesNothing(meter.fetch(new URL(PUBLICNODE)));
    await carriesNothing(meter.fetch('not a url'));
    expect(e.sent).toHaveLength(2);
    expect(meter.spent()).toBe(2);
  });

  it('uses a late answer of the official endpoint and marks it: headers at once, the body after 1,000 ms', async () => {
    const e = endpoints(async () => new Response(lateBody(OK_BODY, 1_000), { status: 200 }));
    const meter = createPollFetchMeter(e.fetchFn);
    const answer = await meter.fetch(OFFICIAL);
    expect(await answer.json()).toMatchObject({ result: '0x01' });
    await carriesNothing(meter.fetch(OFFICIAL));
    expect(e.count(OFFICIAL)).toBe(1);
  });

  it('never marks a third party for its time alone: a publicnode answer after 1,000 ms marks nothing', async () => {
    const e = endpoints(async () => {
      await sleep(1_000);
      return okAnswer();
    });
    const meter = createPollFetchMeter(e.fetchFn);
    for (const url of [PUBLICNODE, DRPC, PUBLICNODE]) {
      const answer = await meter.fetch(url);
      expect(await answer.json()).toMatchObject({ result: '0x01' });
    }
    expect(e.count(PUBLICNODE)).toBe(2);
    expect(e.count(DRPC)).toBe(1);
  });

  it('does not mark an answer taken alone that comes within 750 ms', async () => {
    const e = endpoints(async () => {
      await sleep(300);
      return okAnswer();
    });
    const meter = createPollFetchMeter(e.fetchFn);
    await meter.fetch(OFFICIAL);
    await meter.fetch(OFFICIAL);
    expect(e.count(OFFICIAL)).toBe(2);
  });
});

describe('the fetch meter', () => {
  it('counts every fetch of a run, starts a new run at each head read, and reports the count with the read', async () => {
    let real = 0;
    const meter = createPollFetchMeter((async () => {
      real += 1;
      return okAnswer();
    }) as typeof fetch);
    // A chain that makes two fetches a read, as a third-party answer and its confirmation would.
    const chain: TokenChainReader = {
      async readBalances(_token, wallets, atBlock) {
        await meter.fetch(PUBLICNODE);
        await meter.fetch(DRPC);
        return {
          totalSupply: SUPPLY,
          decimals: 18,
          balances: wallets.map(() => 0n),
          blockNumber: BigInt(atBlock ?? 99),
        };
      },
    };
    const reader = createPollHoldingReader({ chain, config: async () => CONFIG, meter });
    expect((await reader.tiersNow([wallet(1)], null)).fetches).toBe(2);
    expect((await reader.tiersNow([wallet(1)], 49)).fetches).toBe(4);
    expect(meter.spent()).toBe(4);
    // A new head read is a new run.
    expect((await reader.tiersNow([wallet(1)], null)).fetches).toBe(2);
    expect(real).toBe(6);
  });

  it('refuses the fetch past POLL_TALLY_MAX_FETCHES without sending it, so the read fails', async () => {
    let real = 0;
    const meter = createPollFetchMeter((async () => {
      real += 1;
      return okAnswer();
    }) as typeof fetch);
    const chain: TokenChainReader = {
      async readBalances(_token, wallets, atBlock) {
        // Three fetches a read, each answered well, so that only the cap refuses one.
        for (const url of [OFFICIAL, PUBLICNODE, DRPC]) {
          try {
            await meter.fetch(url);
          } catch {
            throw new TokenReadError('rpc_unavailable');
          }
        }
        return {
          totalSupply: SUPPLY,
          decimals: 18,
          balances: wallets.map(() => 0n),
          blockNumber: BigInt(atBlock ?? 99),
        };
      },
    };
    const reader = createPollHoldingReader({ chain, config: async () => CONFIG, meter });
    await reader.tiersNow([wallet(1)], null);
    let reads = 1;
    let failed = false;
    while (reads < 20) {
      try {
        await reader.tiersNow([wallet(1)], 49);
        reads += 1;
      } catch {
        failed = true;
        break;
      }
    }
    expect(failed).toBe(true);
    expect(reads).toBe(Math.floor(POLL_TALLY_MAX_FETCHES / 3));
    expect(real).toBe(POLL_TALLY_MAX_FETCHES);
    expect(meter.spent()).toBe(POLL_TALLY_MAX_FETCHES);
  });

  it('reports no count when no meter is given', async () => {
    const { chain } = chainOf(() => [0n]);
    const read = await createPollHoldingReader({ chain, config: async () => CONFIG }).tiersNow([wallet(1)], null);
    expect(read.fetches).toBeUndefined();
  });
});
