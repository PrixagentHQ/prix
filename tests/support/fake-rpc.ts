import { isStockToken } from '@prix/contracts';
import { UNIVERSE } from '@prix/market';
import {
  decodeMulticall,
  encodeFunctionResult,
  encodeMulticallResult,
  feedAbi,
  type Hex,
  type InnerAnswer,
  type InnerCall,
  L2_MULTICALL_ADDRESS,
  MULTICALL3_ADDRESS,
  multicallAbi,
  SELECTOR,
  stockTokenAbi,
} from './abi.ts';
import { FakeArbitrum, isArbitrumFeed } from './fake-arbitrum.ts';

/**
 * A fake JSON-RPC endpoint for the market tests, passed to `createMarket` as `fetch`.
 * No test ever reaches a real chain.
 *
 * It answers what the market really sends to Robinhood Chain (docs/CONTRACTS.md sections 5, 15 and
 * 21): one `eth_call` to the chain's L2 Multicall carrying the multicall's own
 * `getCurrentBlockTimestamp()`, Multicall3's `getChainId()`, each Robinhood Chain feed's
 * `latestRoundData()` and `decimals()`, and each Stock Token's `oraclePaused()` (`false` unless a
 * test says otherwise). A crypto entry (section 21) has only its feed's two answers. Each inner call
 * is answered by its target and selector, so the fake does not depend on how the market lays the
 * calls out. A feed that exists only on Arbitrum One (section 23) has no code here: a market that
 * reads SOL, BNB or HYPE on Robinhood Chain gets nothing for it.
 * Any other method, or a call to any other contract, is an error, as a node would say.
 *
 * A request to an Arbitrum endpoint goes to `arbitrum` (tests/support/fake-arbitrum.ts), which
 * answers the Arbitrum feeds set here with `setFeed`, so a suite that sets every universe feed gets a
 * healthy Arbitrum read too. Those requests are recorded in `arbitrum.requests`, not in `httpRequests`.
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
  /** Arbitrum One, for SOL, BNB and HYPE (section 23): it answers the Arbitrum feeds set here. */
  readonly arbitrum: FakeArbitrum = new FakeArbitrum(
    (address) => this.feeds.get(address.toLowerCase()),
    () => this.blockTimestamp,
  );
  /** Every HTTP request to Robinhood Chain, by endpoint URL. */
  readonly httpRequests: { url: string; methods: string[] }[] = [];
  /** Every contract address that was read on Robinhood Chain, directly or inside the multicall. */
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
    if (this.arbitrum.handles(url)) return this.arbitrum.fetch(url, text, init?.signal ?? request.signal);
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
    const data = String(call.data ?? call.input ?? '0x').toLowerCase() as Hex;
    this.callTargets.push(to);
    // The only call the market makes on Robinhood Chain: the whole snapshot, through the L2 Multicall.
    if (to !== L2_MULTICALL_ADDRESS) throw new Revert();
    const decoded = decodeMulticall(data);
    if (decoded === null) throw new Revert();
    this.calledAddresses.add(to);
    let answers = decoded.calls.map((inner) => {
      this.calledAddresses.add(inner.target);
      return this.answerInner(inner);
    });
    // A well-formed answer that is one result short: the endpoint did not answer the question.
    if (mode === 'short_answer') answers = answers.slice(0, -1);
    return encodeMulticallResult(decoded.functionName, answers, BigInt(this.blockNumber));
  }

  private answerInner(inner: InnerCall): InnerAnswer {
    const { target, selector } = inner;
    const multicall = target === L2_MULTICALL_ADDRESS || target === MULTICALL3_ADDRESS;
    if (multicall && selector === SELECTOR.getCurrentBlockTimestamp) {
      return this.blockTimestampFails
        ? null
        : encodeFunctionResult(multicallAbi, 'getCurrentBlockTimestamp', BigInt(this.blockTimestamp));
    }
    if (target === MULTICALL3_ADDRESS && selector === SELECTOR.getChainId) {
      return this.chainId === null ? null : encodeFunctionResult(multicallAbi, 'getChainId', BigInt(this.chainId));
    }
    // A Stock Token's own flag.
    const token = UNIVERSE.find((entry) => isStockToken(entry) && entry.tokenAddress.toLowerCase() === target);
    if (token !== undefined) {
      if (selector !== SELECTOR.oraclePaused) return null;
      const feed = this.feeds.get(token.feedAddress.toLowerCase());
      if (feed === undefined || feed.reverts || feed.pauseReadFails) return null;
      return encodeFunctionResult(stockTokenAbi, 'oraclePaused', feed.oraclePaused ?? false);
    }
    // A feed of Robinhood Chain. The Arbitrum feeds have no code here.
    if (isArbitrumFeed(target)) return null;
    const feed = this.feeds.get(target);
    if (feed === undefined || feed.reverts) return null;
    if (selector === SELECTOR.latestRoundData) {
      return encodeFunctionResult(feedAbi, 'latestRoundData', [
        1n,
        feed.answer,
        BigInt(feed.updatedAt),
        BigInt(feed.updatedAt),
        1n,
      ]);
    }
    if (selector === SELECTOR.decimals) {
      return feed.decimalsFails ? null : encodeFunctionResult(feedAbi, 'decimals', feed.decimals);
    }
    return null;
  }
}

class Revert extends Error {}

function normalise(url: string): string {
  return url.replace(/\/+$/, '');
}
