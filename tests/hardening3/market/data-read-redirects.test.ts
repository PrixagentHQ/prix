import { type Address, ChainUnavailableError, TokenReadError } from '@prix/contracts';
import { isRedirect, RedirectRefusedError, withoutRedirects } from '@prix/market/redirect';
import { ChainTransientError, createRpc } from '@prix/market/rpc';
import { createTokenChainReader } from '@prix/market/token-balances';
import { encodeTokenResult } from '@prix/market/token-wire';
import { createWalletActivityReader } from '@prix/market/wallet-activity';
import { describe, expect, it, vi } from 'vitest';
import { KEYED, OFFICIAL } from './support.ts';

/**
 * No data read follows a redirect (docs/CONTRACTS.md section 20; security review of the second-chain
 * read): `createRpc` of the data API, the wallet activity reader and the token balance reader, as the
 * snapshot's reads already do (tests/arbitrum/redirects.test.ts). A followed redirect is one more
 * subrequest, to a host nobody listed, whose answer would be taken as the endpoint's own: for the
 * keyed and the official endpoint, alone.
 *
 * `wire` below does what `fetch` does with a redirect: asked with `redirect: 'manual'` it hands the
 * 3xx back; asked any other way it goes where the endpoint says and returns that host's answer, which
 * lies. `stubborn` hands the 3xx back however it is asked, as a runtime does that was told `manual`.
 * Nothing here reaches a network.
 */

const A = 'https://rpc-a.test';
const B = 'https://rpc-b.test';
const ELSEWHERE = 'https://elsewhere.test/rpc';
const STATUSES = [301, 302, 307, 308] as const;

const norm = (url: string): string => url.trim().replace(/\/+$/, '');
const urlOf = (input: RequestInfo | URL): string =>
  norm(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);

interface Sent {
  url: string;
  /** The redirect mode the reader asked for: undefined is the default of `fetch`, which follows. */
  redirect: RequestInit['redirect'];
}

interface Wire {
  fetch: typeof fetch;
  /** Every request a reader made, in order. */
  sent: Sent[];
  /** Every place `fetch` went because a redirect said so. There must be none. */
  followed: string[];
  /** Every 3xx that was handed back, each with a spy on its `json`. */
  redirects: { response: Response; json: ReturnType<typeof vi.spyOn> }[];
}

type Answer = (init: RequestInit | undefined) => Response;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * `redirecting` maps an endpoint to the status and body of its redirect; `answering` maps an endpoint
 * to its honest answer; `elsewhere` is what the host behind the redirects says.
 */
function wire(options: {
  redirecting: Record<string, { status: number; body?: string }>;
  answering?: Record<string, Answer>;
  elsewhere: Answer;
  /** Hand the 3xx back whatever redirect mode the request asked for. */
  stubborn?: boolean;
}): Wire {
  const out: Wire = { fetch: async () => json(null), sent: [], followed: [], redirects: [] };
  out.fetch = async (input, init) => {
    const url = urlOf(input);
    out.sent.push({ url, redirect: init?.redirect });
    const redirect = options.redirecting[url];
    if (redirect === undefined) {
      const answer = options.answering?.[url];
      return answer === undefined ? new Response('unavailable', { status: 503 }) : answer(init);
    }
    if (init?.redirect === 'manual' || options.stubborn === true) {
      const response = new Response(redirect.body ?? null, {
        status: redirect.status,
        headers: { location: ELSEWHERE, 'content-type': 'application/json' },
      });
      out.redirects.push({ response, json: vi.spyOn(response, 'json') });
      return response;
    }
    if (init?.redirect === 'error') throw new TypeError('fetch failed: unexpected redirect');
    out.followed.push(ELSEWHERE);
    return options.elsewhere(init);
  };
  return out;
}

describe('isRedirect and withoutRedirects (redirect.ts)', () => {
  it('calls every 3xx a redirect, and status 0, and nothing else', () => {
    for (const status of [0, 300, 301, 302, 303, 304, 307, 308, 399]) {
      expect(isRedirect({ status }), String(status)).toBe(true);
    }
    for (const status of [200, 204, 299, 400, 404, 429, 500, 503]) {
      expect(isRedirect({ status }), String(status)).toBe(false);
    }
  });

  it("sends every request with redirect manual, over a caller's own follow", async () => {
    const seen: (RequestInit | undefined)[] = [];
    const answer = json({ ok: true });
    const inner: typeof fetch = async (_input, init) => {
      seen.push(init);
      return answer;
    };
    const guarded = withoutRedirects(inner);
    await expect(guarded(A, { method: 'POST', body: '{}', redirect: 'follow' })).resolves.toBe(answer);
    await guarded(A, { redirect: 'error' });
    await guarded(A);
    expect(seen.map((init) => init?.redirect)).toEqual(['manual', 'manual', 'manual']);
    // The request is otherwise sent as given.
    expect(seen[0]).toMatchObject({ method: 'POST', body: '{}' });
  });

  it.each(STATUSES)('throws RedirectRefusedError for a %i, with its body cancelled and no URL', async (status) => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const inner: typeof fetch = async () => new Response(body, { status, headers: { location: ELSEWHERE } });
    const error: unknown = await withoutRedirects(inner)(`${A}/v2/secret-key`, { redirect: 'follow' }).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(RedirectRefusedError);
    expect(cancelled).toBe(true);
    expect(String((error as Error).message)).not.toContain('secret-key');
    expect(String((error as Error).message)).not.toContain('elsewhere');
  });
});

describe('createRpc and a redirect', () => {
  const lie: Answer = () => json([{ jsonrpc: '2.0', id: 1, result: '0xbad' }]);
  const honest: Answer = () => json([{ jsonrpc: '2.0', id: 1, result: '0x10' }]);

  it.each(STATUSES)(
    '%i: one request with redirect manual, a failure, and the next endpoint is not asked',
    async (status) => {
      const w = wire({ redirecting: { [A]: { status } }, answering: { [B]: honest }, elsewhere: lie });
      const error: unknown = await createRpc([A, B], w.fetch)
        .call('eth_blockNumber', [])
        .catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(ChainUnavailableError);
      expect(error).not.toBeInstanceOf(ChainTransientError);
      expect(w.sent).toEqual([{ url: A, redirect: 'manual' }]);
      expect(w.followed).toEqual([]);
    },
  );

  it('a batch that is redirected is one request too', async () => {
    const w = wire({ redirecting: { [A]: { status: 307 } }, answering: { [B]: honest }, elsewhere: lie });
    const batch = createRpc([A, B], w.fetch).batch([
      { method: 'eth_blockNumber', params: [] },
      { method: 'eth_getCode', params: ['0x00000000000000000000000000000000000000a1', 'latest'] },
    ]);
    await expect(batch).rejects.toBeInstanceOf(ChainUnavailableError);
    expect(w.sent).toEqual([{ url: A, redirect: 'manual' }]);
    expect(w.followed).toEqual([]);
  });

  it('a redirect whose status the runtime hides (0) is a failure of one request', async () => {
    const sent: Sent[] = [];
    const hidden: typeof fetch = async (input, init) => {
      sent.push({ url: urlOf(input), redirect: init?.redirect });
      return { status: 0, ok: false, body: null, headers: new Headers() } as unknown as Response;
    };
    const error: unknown = await createRpc([A, B], hidden)
      .call('eth_blockNumber', [])
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ChainUnavailableError);
    expect(error).not.toBeInstanceOf(ChainTransientError);
    expect(sent).toEqual([{ url: A, redirect: 'manual' }]);
  });

  it('every request that is answered says redirect manual too', async () => {
    const w = wire({ redirecting: {}, answering: { [A]: honest }, elsewhere: lie });
    await expect(createRpc([A, B], w.fetch).call('eth_blockNumber', [])).resolves.toBe('0x10');
    expect(w.sent).toEqual([{ url: A, redirect: 'manual' }]);
  });
});

describe('the wallet activity reader and a redirect', () => {
  const WALLET = '0x00000000000000000000000000000000000000a1' as Address;
  /** The words of an endpoint whose getLogs range is too wide, as the body of a redirect. */
  const TOO_WIDE = JSON.stringify([
    { jsonrpc: '2.0', id: 0, error: { code: -32005, message: 'query exceeds limit of 10000' } },
    { jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'query exceeds limit of 10000' } },
  ]);
  const head: Answer = () =>
    json([
      { jsonrpc: '2.0', id: 0, result: '0x10' },
      { jsonrpc: '2.0', id: 1, result: { number: '0x10', timestamp: '0x65' } },
    ]);
  const lyingHead: Answer = () =>
    json([
      { jsonrpc: '2.0', id: 0, result: '0x999' },
      { jsonrpc: '2.0', id: 1, result: { number: '0x999', timestamp: '0x1' } },
    ]);
  const lyingLogs: Answer = () =>
    json([
      { jsonrpc: '2.0', id: 0, result: [] },
      { jsonrpc: '2.0', id: 1, result: [] },
    ]);

  it.each(STATUSES)('%i from every endpoint: one request each with redirect manual, and no answer', async (status) => {
    const w = wire({ redirecting: { [A]: { status }, [B]: { status } }, elsewhere: lyingLogs });
    const reader = createWalletActivityReader({ rpcUrls: [A, B], fetch: w.fetch });
    expect(await reader.readTransfers(WALLET, 1, 2)).toEqual({ ok: false, reason: 'rpc_unavailable' });
    expect(w.sent).toEqual([
      { url: A, redirect: 'manual' },
      { url: B, redirect: 'manual' },
    ]);
    expect(w.followed).toEqual([]);
    expect(w.redirects).toHaveLength(2);
    for (const redirect of w.redirects) expect(redirect.json).not.toHaveBeenCalled();
  });

  it('never reads the body of a redirect: a 307 that says the window is too large is rpc_unavailable', async () => {
    const w = wire({
      redirecting: { [A]: { status: 307, body: TOO_WIDE }, [B]: { status: 307, body: TOO_WIDE } },
      elsewhere: lyingLogs,
      stubborn: true,
    });
    const reader = createWalletActivityReader({ rpcUrls: [A, B], fetch: w.fetch });
    expect(await reader.readTransfers(WALLET, 1, 2)).toEqual({ ok: false, reason: 'rpc_unavailable' });
    expect(w.sent.map((request) => request.url)).toEqual([A, B]);
    expect(w.redirects).toHaveLength(2);
    for (const redirect of w.redirects) expect(redirect.json).not.toHaveBeenCalled();
  });

  it('uses the next listed endpoint that answers, and never the host the redirect names', async () => {
    const w = wire({ redirecting: { [A]: { status: 307 } }, answering: { [B]: head }, elsewhere: lyingHead });
    const reader = createWalletActivityReader({ rpcUrls: [A, B], fetch: w.fetch });
    expect(await reader.headBlock()).toEqual({ number: 16, timestamp: 101 });
    expect(w.sent).toEqual([
      { url: A, redirect: 'manual' },
      { url: B, redirect: 'manual' },
    ]);
    expect(w.followed).toEqual([]);
  });

  it('gives no head and no block times when every endpoint redirects', async () => {
    const w = wire({ redirecting: { [A]: { status: 302 }, [B]: { status: 302 } }, elsewhere: lyingHead });
    const reader = createWalletActivityReader({ rpcUrls: [A, B], fetch: w.fetch });
    expect(await reader.headBlock()).toBeNull();
    expect(await reader.blockTimes([16])).toBeNull();
    expect(w.followed).toEqual([]);
    expect(w.sent.every((request) => request.redirect === 'manual')).toBe(true);
    expect(w.sent.map((request) => request.url)).toEqual([A, B, A, B]);
  });
});

describe('the token balance reader and a redirect', () => {
  const TOKEN = '0x00000000000000000000000000000000000070c0' as Address;
  const WALLET = '0x00000000000000000000000000000000000000a1' as Address;
  const SUPPLY = 10n ** 27n;

  /** A chain where the wallet holds `balance`, answering viem's single `eth_call`. */
  function chain(balance: bigint): Answer {
    return (init) => {
      const call = JSON.parse(String(init?.body)) as { id?: unknown };
      return json({
        jsonrpc: '2.0',
        id: call.id,
        result: encodeTokenResult({
          blockNumber: 1_000n,
          blockTimestamp: BigInt(Math.floor(Date.now() / 1000)),
          totalSupply: SUPPLY,
          decimals: 18,
          balances: [balance],
        }),
      });
    };
  }
  /** The host behind the redirects: the wallet holds a tenth of the supply. */
  const lie = chain(10n ** 26n);

  it.each(STATUSES)(
    '%i from the keyed endpoint: one request, and the official endpoint is read instead',
    async (status) => {
      const w = wire({
        redirecting: { [KEYED]: { status } },
        answering: { [norm(OFFICIAL)]: chain(5n) },
        elsewhere: lie,
      });
      const read = await createTokenChainReader([KEYED, OFFICIAL], w.fetch).readBalances(TOKEN, [WALLET]);
      expect(read.balances).toEqual([5n]);
      expect(w.sent).toEqual([
        { url: KEYED, redirect: 'manual' },
        { url: norm(OFFICIAL), redirect: 'manual' },
      ]);
      expect(w.followed).toEqual([]);
    },
  );

  it.each(STATUSES)('%i from every endpoint: one request each, and TokenReadError rpc_unavailable', async (status) => {
    const w = wire({
      redirecting: { [KEYED]: { status }, [norm(OFFICIAL)]: { status } },
      elsewhere: lie,
    });
    const error: unknown = await createTokenChainReader([KEYED, OFFICIAL], w.fetch)
      .readBalances(TOKEN, [WALLET])
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(TokenReadError);
    expect((error as TokenReadError).code).toBe('rpc_unavailable');
    expect(w.sent).toEqual([
      { url: KEYED, redirect: 'manual' },
      { url: norm(OFFICIAL), redirect: 'manual' },
    ]);
    expect(w.followed).toEqual([]);
    // The error names no endpoint: a URL can hold a key.
    expect(String((error as Error).message)).not.toContain('secret-key');
  });

  it('an endpoint that answers is asked with redirect manual too', async () => {
    const w = wire({ redirecting: {}, answering: { [KEYED]: chain(7n) }, elsewhere: lie });
    const read = await createTokenChainReader([KEYED, OFFICIAL], w.fetch).readBalances(TOKEN, [WALLET]);
    expect(read.balances).toEqual([7n]);
    expect(w.sent).toEqual([{ url: KEYED, redirect: 'manual' }]);
  });
});
