import { isStockToken } from '@prix/contracts';
import { UNIVERSE } from '@prix/market';
import type { FeedRead } from '@prix/market/rules';
import { encodeSnapshotCall, encodeSnapshotResult, MULTICALL_ADDRESS } from '@prix/market/wire';

/**
 * A fake JSON-RPC endpoint for the market tests, passed to `createMarket` as `fetch`.
 * No test ever reaches a real chain.
 *
 * It answers what the market really sends (docs/CONTRACTS.md section 15, "Market"): one
 * `eth_call` to the chain's Multicall, `tryBlockAndAggregate`, whose calldata is built with the
 * encoder that `@prix/market/wire` exports. The fake checks that the calldata is exactly that,
 * so a market that sends anything else, or more than one request, fails a test. The answer is
 * built with the inverse encoder from the feeds the test has set: each feed's `latestRoundData()`
 * and `decimals()`, and each Stock Token's `oraclePaused()`, `false` unless a test says otherwise. A crypto entry
 * (section 21) has only its feed's two answers.
 * Any other method, or a call to any other contract, is an error, as a node would say.
 */

export interface FeedState {
  /** The feed's answer, in the feed's own decimals. */
  answer: bigint;
  /** Unix seconds of the feed's last update. */
  updatedAt: number;
  decimals: number;
  /** When true, the feed's `latestRoundData()` and `decimals()` revert. */
  reverts?: boolean;
  /** What the token's `oraclePaused()` answers. False when not set. */
  oraclePaused?: boolean;
  /** When true, the token's `oraclePaused()` reverts, so it cannot be read. */
  pauseReadFails?: boolean;
  /** When true, only `decimals()` reverts. */
  decimalsFails?: boolean;
}

export type EndpointMode =
  | 'ok'
  | 'network_error'
  | 'http_500'
  | 'garbage'
  | 'html'
  | 'rpc_error'
  | 'empty_result'
  /** A well-formed multicall answer with the wrong number of results: the endpoint did not answer the question. */
  | 'short_answer';

interface RpcRequest {
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

export class FakeRpc {
  readonly feeds = new Map<string, FeedState>();
  readonly modes = new Map<string, EndpointMode>();
  /** Every HTTP request, by endpoint URL. */
  readonly httpRequests: { url: string; methods: string[] }[] = [];
  /** Every contract address that was read, directly or inside the multicall. */
  readonly calledAddresses = new Set<string>();
  /** The `to` of every `eth_call` that arrived. */
  readonly callTargets: string[] = [];
  blockNumber = 4_242_424;
  blockTimestamp = 0;
  /** When true, the multicall's own `getCurrentBlockTimestamp()` fails, so the node's age is unknown. */
  blockTimestampFails = false;
  /** The chain ID the endpoint answers for; null means the call fails. */
  chainId: number | null = 4663;

  setFeed(address: string, state: FeedState): void {
    this.feeds.set(address.toLowerCase(), state);
  }

  setMode(url: string, mode: EndpointMode): void {
    this.modes.set(normalise(url), mode);
  }

  requestsTo(url: string): number {
    return this.httpRequests.filter((request) => request.url === normalise(url)).length;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = normalise(request.url);
    const text = await request.text();
    let methods: string[] = [];
    let payload: unknown = null;
    try {
      payload = JSON.parse(text);
      const list = Array.isArray(payload) ? payload : [payload];
      methods = list.map((item) => String((item as RpcRequest).method));
    } catch {
      methods = ['unparseable'];
    }
    this.httpRequests.push({ url, methods });

    const mode = this.modes.get(url) ?? 'ok';
    if (mode === 'network_error') throw new TypeError('fetch failed');
    if (mode === 'http_500') return new Response('upstream error', { status: 500 });
    if (mode === 'garbage') return new Response('{"jsonrpc":"2.0","id":1,"result":', { status: 200 });
    if (mode === 'html') {
      return new Response('<html><body>Too many requests</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }

    const answer = (item: RpcRequest): unknown => {
      if (mode === 'rpc_error') {
        return { jsonrpc: '2.0', id: item.id ?? null, error: { code: -32005, message: 'limit exceeded' } };
      }
      if (mode === 'empty_result') return { jsonrpc: '2.0', id: item.id ?? null, result: '0x' };
      try {
        return { jsonrpc: '2.0', id: item.id ?? null, result: this.handle(item, mode) };
      } catch (error) {
        const reverted = error instanceof Revert;
        return {
          jsonrpc: '2.0',
          id: item.id ?? null,
          error: reverted
            ? { code: 3, message: 'execution reverted', data: '0x' }
            : { code: -32601, message: 'method not supported' },
        };
      }
    };
    const body = Array.isArray(payload)
      ? payload.map((item) => answer(item as RpcRequest))
      : answer(payload as RpcRequest);
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  private handle(request: RpcRequest, mode: EndpointMode): unknown {
    const params = Array.isArray(request.params) ? request.params : [];
    if (request.method !== 'eth_call') throw new Error('unsupported method');
    const call = (params[0] ?? {}) as { to?: string; data?: string; input?: string };
    const to = String(call.to ?? '').toLowerCase();
    const data = String(call.data ?? call.input ?? '0x').toLowerCase();
    this.callTargets.push(to);
    // The only call the market makes: the whole snapshot, in the order the encoder lays it out.
    if (to !== MULTICALL_ADDRESS.toLowerCase() || data !== encodeSnapshotCall(UNIVERSE).toLowerCase()) {
      throw new Revert();
    }
    this.calledAddresses.add(to);
    for (const token of UNIVERSE) {
      this.calledAddresses.add(token.feedAddress.toLowerCase());
      // Only a Stock Token is asked for `oraclePaused()`; a crypto entry has no token (section 21).
      if (isStockToken(token)) this.calledAddresses.add(token.tokenAddress.toLowerCase());
    }
    const universe = mode === 'short_answer' ? UNIVERSE.slice(0, UNIVERSE.length - 1) : UNIVERSE;
    const reads = universe.map((token): FeedRead => {
      const feed = this.feeds.get(token.feedAddress.toLowerCase());
      if (!feed || feed.reverts) return { round: null, decimals: null, oraclePaused: null };
      return {
        round: { answer: feed.answer, updatedAt: BigInt(feed.updatedAt) },
        decimals: feed.decimalsFails ? null : feed.decimals,
        // The encoder lays out no pause answer for a crypto entry, whatever is set here.
        oraclePaused: feed.pauseReadFails ? null : (feed.oraclePaused ?? false),
      };
    });
    return encodeSnapshotResult(universe, {
      blockNumber: BigInt(this.blockNumber),
      blockTimestamp: this.blockTimestampFails ? null : BigInt(this.blockTimestamp),
      chainId: this.chainId === null ? null : BigInt(this.chainId),
      reads,
    });
  }
}

class Revert extends Error {}

function normalise(url: string): string {
  return url.replace(/\/+$/, '');
}
