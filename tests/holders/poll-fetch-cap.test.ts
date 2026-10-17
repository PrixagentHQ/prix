import {
  type Address,
  HOLDER_POLLS,
  POLL_MAX_VOTERS,
  POLL_TALLY_FETCH_TIMEOUT_MS,
  POLL_TALLY_MAX_FETCHES,
} from '@prix/contracts';
import { PUBLIC_RPC_URLS } from '@prix/market';
import { encodeTokenResult } from '@prix/market/token-wire';
import { tallyPoll } from '@prix/runtime/social/poll-tally';
import { createPollFetchMeter, PollFetchCapReached, PollFetchRefused } from '@prix/runtime/token/poll-holding';
import { describe, expect, it } from 'vitest';
import { pollHoldingFor } from '../../apps/api/src/poll-holding.ts';

/**
 * HB1-SEC-1 (docs/contracts/phase-6-holders.md section 5, H2-SEC-4): the tally's fetch cap holds as the entry
 * wires it. `pollHoldingFor` is the builder apps/api/src/index.ts calls for each run: a real chain reader whose
 * `fetch` goes through the run's meter. Here the official endpoint refuses every call, as Robinhood's endpoint
 * refuses Cloudflare (D-131): the run's first read costs three fetches (refused, a third party's answer, its
 * confirmation), and every later read two, since the run does not ask a failed endpoint again (revision 8, R8-2).
 * A full poll of POLL_MAX_VOTERS (1,600) is then 3 + 2 x 4 = POLL_TALLY_MAX_FETCHES (11), and a 12th is refused.
 */

const [OFFICIAL, PUBLICNODE, DRPC] = PUBLIC_RPC_URLS as [string, string, string];
const POLL = HOLDER_POLLS[0];
const TOKEN = '0x00000000000000000000000000000000000070c0' as Address;
const SUPPLY = 10n ** 27n;
const HEAD = 1_000_000;
const BALANCE_OF = '70a08231';

const wallet = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;

interface RpcCall {
  id?: unknown;
  method?: string;
  params?: unknown[];
}

/** Three endpoints behind one fetch: the official one down, the two third parties agreeing. */
function chainFetch(): { fetch: typeof fetch; sent: () => number; official: () => number } {
  let sent = 0;
  let official = 0;
  const fake: typeof fetch = async (input, init) => {
    sent += 1;
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = raw.replace(/\/+$/, '');
    if (url === OFFICIAL.replace(/\/+$/, '')) official += 1;
    if (url === OFFICIAL || (url !== PUBLICNODE && url !== DRPC)) return new Response('unavailable', { status: 503 });
    const body = JSON.parse(String(init?.body ?? '{}')) as RpcCall | RpcCall[];
    const calls = Array.isArray(body) ? body : [body];
    const answers = calls.map((call) => {
      const [tx, tag] = (call.params ?? []) as [{ data?: string }, string | undefined];
      const data = String(tx?.data ?? '');
      const count = data.split(BALANCE_OF).length - 1;
      const blockNumber = typeof tag === 'string' && tag.startsWith('0x') ? BigInt(tag) : BigInt(HEAD);
      return {
        jsonrpc: '2.0',
        id: call.id,
        result: encodeTokenResult({
          blockNumber,
          blockTimestamp: BigInt(Math.floor(Date.now() / 1000)),
          totalSupply: SUPPLY,
          decimals: 18,
          balances: Array.from({ length: count }, () => 10n ** 23n),
        }),
      };
    });
    return new Response(JSON.stringify(Array.isArray(body) ? answers : answers[0]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch: fake, sent: () => sent, official: () => official };
}

describe('the tally fetch cap as the entry wires it', () => {
  it('tallies a full poll of POLL_MAX_VOTERS in exactly POLL_TALLY_MAX_FETCHES fetches when the first endpoint refuses', async () => {
    if (POLL === undefined) throw new Error('no poll');
    const chain = chainFetch();
    const holding = pollHoldingFor(
      [OFFICIAL, PUBLICNODE, DRPC],
      async () => ({
        token: TOKEN,
        thresholdsPpm: [10, 100, 1_000] as const,
        gatingOn: true,
      }),
      chain.fetch,
    );
    const rows = Array.from({ length: POLL_MAX_VOTERS }, (_, i) => ({
      wallet: wallet(0x1000 + i),
      option: 'index-core',
    }));
    let written = false;
    const polls = {
      async listVoters(_poll: string, after: string | null, _before: string, limit: number) {
        return rows.filter((row) => after === null || row.wallet > after).slice(0, limit);
      },
      async getResults() {
        return [];
      },
      async putResult() {
        written = true;
        return true;
      },
    };
    const close = Date.parse(POLL.closesAt);
    const outcome = await tallyPoll(
      {
        polls,
        holding,
        adminAddresses: [],
        houseOwners: [],
        tallyDelaySeconds: async () => 0,
        social: { async putCursor() {} },
        reputation: {
          async getJobState() {
            return null;
          },
        },
        now: () => new Date(close + 120_000),
        log: () => undefined,
      } as never,
      POLL,
    );
    // Revision 8 (R8-2): the official endpoint is asked once a run, so the head read costs three fetches and each
    // of the four pages two: 3 + 2 x 4 = POLL_TALLY_MAX_FETCHES (11), and the full poll is tallied within it.
    expect(outcome).toEqual({ outcome: 'done', step: null });
    expect(chain.sent()).toBe(POLL_TALLY_MAX_FETCHES);
    expect(chain.official()).toBe(1);
    expect(written).toBe(true);
  });

  it('refuses the fetch past POLL_TALLY_MAX_FETCHES without sending it (the 12th)', async () => {
    const chain = chainFetch();
    const meter = createPollFetchMeter(chain.fetch);
    meter.startRun();
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] });
    for (let i = 0; i < POLL_TALLY_MAX_FETCHES; i += 1) await meter.fetch(PUBLICNODE, { method: 'POST', body });
    expect(chain.sent()).toBe(POLL_TALLY_MAX_FETCHES);
    await expect(meter.fetch(PUBLICNODE, { method: 'POST', body })).rejects.toBeInstanceOf(PollFetchCapReached);
    expect(chain.sent()).toBe(POLL_TALLY_MAX_FETCHES);
    meter.startRun();
    await meter.fetch(PUBLICNODE, { method: 'POST', body });
    expect(chain.sent()).toBe(POLL_TALLY_MAX_FETCHES + 1);
  });

  it('PF5-SEC-1: a 429 whose body never ends is refused within POLL_TALLY_FETCH_TIMEOUT_MS, its body cancelled unread, its host marked', async () => {
    let cancelled = false;
    let sent = 0;
    const stalled: typeof fetch = async () => {
      sent += 1;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0","error":'));
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(stream, { status: 429, headers: { 'content-type': 'application/json' } });
    };
    const meter = createPollFetchMeter(stalled);
    meter.startRun();
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] });
    const t0 = Date.now();
    // Whatever the meter hands back, a caller that reads it (as viem's transport does before it looks at the
    // status) must be done within the meter's timeout: an answer, an error, or a refusal.
    const outcome = await Promise.race([
      meter.fetch(OFFICIAL, { method: 'POST', body }).then(
        async (answer) => {
          await answer.text();
          return 'read';
        },
        (error: unknown) => (error instanceof PollFetchRefused ? 'refused' : 'rejected'),
      ),
      new Promise((resolve) => setTimeout(() => resolve('pending'), POLL_TALLY_FETCH_TIMEOUT_MS + 1_000)),
    ]);
    expect(outcome).toBe('refused');
    expect(Date.now() - t0).toBeLessThanOrEqual(POLL_TALLY_FETCH_TIMEOUT_MS + 100);
    expect(cancelled).toBe(true);
    expect(meter.spent()).toBe(1);
    // Marked: the next fetch to that host is refused before anything is sent, and not counted.
    await expect(meter.fetch(OFFICIAL, { method: 'POST', body })).rejects.toBeInstanceOf(PollFetchRefused);
    expect(sent).toBe(1);
    expect(meter.spent()).toBe(1);
  });

  it('gives each run a meter of its own', async () => {
    const chain = chainFetch();
    const config = async () => ({ token: TOKEN, thresholdsPpm: [10, 100, 1_000] as const, gatingOn: true });
    const a = pollHoldingFor([OFFICIAL, PUBLICNODE, DRPC], config, chain.fetch);
    const b = pollHoldingFor([OFFICIAL, PUBLICNODE, DRPC], config, chain.fetch);
    const first = (await a.tiersNow([wallet(1)], null)) as { fetches?: number };
    const second = (await b.tiersNow([wallet(2)], null)) as { fetches?: number };
    const again = (await a.tiersNow([wallet(3)], HEAD - 5)) as { fetches?: number };
    expect(first.fetches).toBe(3);
    expect(second.fetches).toBe(3);
    // Run a's official endpoint failed once, so a's later read asks only the two third parties (revision 8).
    expect(again.fetches).toBe(5);
  });
});
