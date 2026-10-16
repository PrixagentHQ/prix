import type { ArbitrumReadConfig, MarketEndpointFailure } from '@prix/contracts';
import {
  ARBITRUM_CHAIN_ID,
  ARBITRUM_CONFIRMING_RPC_URLS,
  ARBITRUM_OFFICIAL_RPC_URL,
  ARBITRUM_SEQUENCER_GRACE_SECONDS,
} from '@prix/contracts';
import {
  ARBSYS_ADDRESS,
  arbSysAbi,
  decodeMulticall,
  encodeFunctionResult,
  encodeMulticallResult,
  feedAbi,
  type Hex,
  type InnerAnswer,
  type InnerCall,
  MULTICALL3_ADDRESS,
  multicallAbi,
  SELECTOR,
} from './abi.ts';
import type { FeedState } from './fake-rpc.ts';

/**
 * A fake Arbitrum One for the market tests (docs/CONTRACTS.md section 23). `FakeRpc` hands it every
 * request to an Arbitrum endpoint, so one `fetch` serves both chains, as in the Worker. No test ever
 * reaches a real chain.
 *
 * It answers what section 23 says the market sends: one `eth_call` to Multicall3, whichever
 * aggregate function it uses, carrying `getChainId`, `getCurrentBlockTimestamp`,
 * `ArbSys.arbBlockNumber()`, the sequencer uptime feed's `latestRoundData` and `latestRoundData`
 * and `decimals` of each Arbitrum feed. Each inner call is answered by its target and selector. The
 * multicall's own block number, and Multicall3's `getBlockNumber()`, answer the Ethereum block
 * (`l1Block`), as they do on Arbitrum, so a market that dates its read with them is caught.
 *
 * A JSON-RPC batch is refused, as dRPC refuses one of more than 3 calls; every request is recorded,
 * with the block it was pinned to. An eth_call pinned to a block answers `arbBlockNumber()` with
 * that block. Each endpoint can be given its own state (`setEndpoint`), so one can lie, lag, answer
 * for another chain or fail while the others tell the truth.
 */

/** The Arbitrum endpoints of the tests, in the order of `ArbitrumReadConfig`: positions 0, 1 and 2. */
export const TEST_ARBITRUM: ArbitrumReadConfig = Object.freeze({
  officialRpcUrl: 'https://arb-official.test/rpc',
  confirmingRpcUrls: Object.freeze(['https://arb-pair-one.test', 'https://arb-pair-two.test']) as readonly [
    string,
    string,
  ],
  sequencerGraceSeconds: ARBITRUM_SEQUENCER_GRACE_SECONDS,
});
export const [ARB_OFFICIAL, ARB_PAIR_ONE, ARB_PAIR_TWO] = [
  TEST_ARBITRUM.officialRpcUrl,
  ...TEST_ARBITRUM.confirmingRpcUrls,
] as [string, string, string];

/** The three Arbitrum feeds of section 23 (Standard Proxies, 8 decimals), lower case. */
export const ARBITRUM_FEEDS = Object.freeze({
  SOL: '0x24cea4b8ce57cda5058b924b9b9987992450590c',
  BNB: '0x6970460aabf80c5be983c6b74e5d06dedca95d4a',
  HYPE: '0xf9ce4fe2f0ece0362cb416844ae179a49591d567',
});
export const ARBITRUM_SYMBOLS: readonly string[] = Object.freeze(['BNB', 'HYPE', 'SOL']);
/** The L2 Sequencer Uptime Status Feed on Arbitrum One (section 23), lower case. */
export const ARBITRUM_SEQUENCER_FEED = '0xfdb631f5ee196f0ed6faa767959853a9f217697d';

const ARBITRUM_FEED_SET: ReadonlySet<string> = new Set(Object.values(ARBITRUM_FEEDS));

/** True for a feed that exists only on Arbitrum One: the Robinhood fake does not answer it. */
export function isArbitrumFeed(address: string): boolean {
  return ARBITRUM_FEED_SET.has(address.toLowerCase());
}

const norm = (url: string): string => url.trim().replace(/\/+$/, '');

/** The Arbitrum endpoints a fake answers: the tests' and the product's, never a real network. */
const ARBITRUM_URLS: ReadonlySet<string> = new Set(
  [
    TEST_ARBITRUM.officialRpcUrl,
    ...TEST_ARBITRUM.confirmingRpcUrls,
    ARBITRUM_OFFICIAL_RPC_URL,
    ...ARBITRUM_CONFIRMING_RPC_URLS,
  ].map(norm),
);

export function isArbitrumUrl(url: string): boolean {
  return ARBITRUM_URLS.has(norm(url));
}

/** The position of an Arbitrum endpoint in `TEST_ARBITRUM`: 0 official, 1 and 2 the pair. */
export function arbitrumPosition(url: string): number {
  return [ARB_OFFICIAL, ARB_PAIR_ONE, ARB_PAIR_TWO].map(norm).indexOf(norm(url));
}

export type ArbitrumMode =
  | 'ok'
  | 'network_error'
  | 'http_429'
  | 'http_500'
  | 'rpc_error'
  | 'garbage'
  /** Never answers; the request ends only when the market aborts it. */
  | 'hang'
  /** A well-formed answer with more than 256 KB of padding: it must not be read (section 20). */
  | 'huge'
  /** Answers at `latest`, and with a "missing trie node" error at any pinned block. */
  | 'no_history';

export interface SequencerState {
  /** 0 up, 1 down. */
  answer: bigint;
  /** When the current status began, Unix seconds. */
  startedAt: bigint;
}

export interface ArbitrumState {
  mode: ArbitrumMode;
  chainId: number | null;
  /** The endpoint's head: the L2 block `arbBlockNumber()` answers at `latest`. */
  l2Block: number;
  /** The Ethereum block that `block.number` and `getBlockNumber()` give on Arbitrum. */
  l1Block: number;
  /** The block timestamp; null follows the Robinhood fake's, so a test that moves one moves both. */
  blockTimestamp: number | null;
  /** The uptime feed's answer, or 'reverts'. Null: up since 30 days before the block timestamp. */
  sequencer: SequencerState | 'reverts' | null;
  /** Changes to the feeds this endpoint answers, by feed address (lower case). */
  feedPatches: ReadonlyMap<string, Partial<FeedState>>;
}

export interface ArbitrumRequest {
  url: string;
  /** True when the body was a JSON-RPC batch. */
  batch: boolean;
  methods: string[];
  /** The `to` and data of the eth_call, when there was one. */
  to: string | null;
  data: Hex | null;
  /** The block parameter of the eth_call: 'latest', a hex block number, or whatever was sent. */
  blockTag: unknown;
  /** The inner calls of the multicall, decoded; empty when it was no multicall. */
  calls: InnerCall[];
}

/** The Arbitrum head of the tests: a plausible L2 block in October 2026. */
export const ARB_L2_BLOCK = 391_234_567;
export const ARB_L1_BLOCK = 23_456_789;

class Revert extends Error {}

export class FakeArbitrum {
  readonly requests: ArbitrumRequest[] = [];
  private readonly base: ArbitrumState = {
    mode: 'ok',
    chainId: ARBITRUM_CHAIN_ID,
    l2Block: ARB_L2_BLOCK,
    l1Block: ARB_L1_BLOCK,
    blockTimestamp: null,
    sequencer: null,
    feedPatches: new Map(),
  };
  private readonly endpoints = new Map<string, Partial<ArbitrumState>>();

  constructor(
    /** The feed states the Robinhood fake was given: an Arbitrum feed set there is answered here. */
    private readonly feedOf: (address: string) => FeedState | undefined,
    /** The Robinhood fake's block timestamp. */
    private readonly defaultTimestamp: () => number,
  ) {}

  /** Changes every Arbitrum endpoint. */
  set(patch: Partial<ArbitrumState>): void {
    Object.assign(this.base, patch);
  }

  /** Changes one endpoint only. */
  setEndpoint(url: string, patch: Partial<ArbitrumState>): void {
    this.endpoints.set(norm(url), { ...this.endpoints.get(norm(url)), ...patch });
  }

  /** Changes one feed on one endpoint only (a lying or lagging endpoint). */
  patchFeedAt(url: string, address: string, patch: Partial<FeedState>): void {
    const current = this.stateOf(url).feedPatches;
    const next = new Map(current);
    next.set(address.toLowerCase(), { ...current.get(address.toLowerCase()), ...patch });
    this.setEndpoint(url, { feedPatches: next });
  }

  stateOf(url: string): ArbitrumState {
    return { ...this.base, ...this.endpoints.get(norm(url)) };
  }

  /** The requests to one endpoint. */
  requestsTo(url: string): ArbitrumRequest[] {
    return this.requests.filter((request) => request.url === norm(url));
  }

  handles(url: string): boolean {
    return isArbitrumUrl(url);
  }

  async fetch(rawUrl: string, body: string, signal: AbortSignal | null): Promise<Response> {
    const url = norm(rawUrl);
    const state = this.stateOf(url);
    let payload: unknown = null;
    try {
      payload = JSON.parse(body);
    } catch {
      payload = null;
    }
    const batch = Array.isArray(payload);
    const items = (batch ? payload : [payload]) as { id?: unknown; method?: unknown; params?: unknown }[];
    const first = items[0] ?? {};
    const params = Array.isArray(first.params) ? first.params : [];
    const call = (params[0] ?? {}) as { to?: unknown; data?: unknown; input?: unknown };
    const data = typeof (call.data ?? call.input) === 'string' ? ((call.data ?? call.input) as string) : null;
    const decoded = data === null ? null : decodeMulticall(data.toLowerCase() as Hex);
    this.requests.push({
      url,
      batch,
      methods: items.map((item) => String(item?.method)),
      to: typeof call.to === 'string' ? call.to.toLowerCase() : null,
      data: data === null ? null : (data.toLowerCase() as Hex),
      blockTag: params[1],
      calls: decoded?.calls ?? [],
    });

    if (state.mode === 'network_error') throw new TypeError('fetch failed');
    if (state.mode === 'http_429') return new Response('rate limited', { status: 429 });
    if (state.mode === 'http_500') return new Response('upstream error', { status: 500 });
    if (state.mode === 'garbage') return new Response('{"jsonrpc":"2.0","id":1,"result":', { status: 200 });
    if (state.mode === 'hang') {
      return new Promise<Response>((_resolve, reject) => {
        const abort = (): void => reject(signal?.reason ?? new DOMException('aborted', 'AbortError'));
        if (signal?.aborted) abort();
        signal?.addEventListener('abort', abort);
      });
    }
    if (batch) {
      // dRPC refuses a batch of more than 3; section 23 says the market never sends one at all.
      const refusal = items.map((item) => ({
        jsonrpc: '2.0',
        id: item?.id ?? null,
        error: { code: -32600, message: 'batch is not allowed' },
      }));
      return json(refusal);
    }
    const id = first.id ?? null;
    if (state.mode === 'rpc_error') {
      return json({ jsonrpc: '2.0', id, error: { code: -32005, message: 'limit exceeded' } });
    }
    const pinned = parseBlockTag(params[1]);
    if (state.mode === 'no_history' && pinned !== null) {
      return json({ jsonrpc: '2.0', id, error: { code: -32000, message: 'missing trie node' } });
    }
    let reply: unknown;
    try {
      reply = { jsonrpc: '2.0', id, result: this.answer(first, state, pinned) };
    } catch (error) {
      reply = {
        jsonrpc: '2.0',
        id,
        error:
          error instanceof Revert
            ? { code: 3, message: 'execution reverted', data: '0x' }
            : { code: -32601, message: 'method not supported' },
      };
    }
    if (state.mode === 'huge') {
      return json({ ...(reply as object), padding: 'x'.repeat(300 * 1024) });
    }
    return json(reply);
  }

  private answer(request: { method?: unknown; params?: unknown }, state: ArbitrumState, pinned: number | null): Hex {
    if (request.method !== 'eth_call') throw new Error('unsupported method');
    const params = Array.isArray(request.params) ? request.params : [];
    const call = (params[0] ?? {}) as { to?: unknown; data?: unknown; input?: unknown };
    const to = String(call.to ?? '').toLowerCase();
    const data = String(call.data ?? call.input ?? '0x').toLowerCase() as Hex;
    if (to !== MULTICALL3_ADDRESS) throw new Revert();
    const decoded = decodeMulticall(data);
    if (decoded === null) throw new Revert();
    const timestamp = state.blockTimestamp ?? this.defaultTimestamp();
    const l2Block = pinned ?? state.l2Block;
    const answers = decoded.calls.map((inner) => this.answerInner(inner, state, timestamp, l2Block));
    return encodeMulticallResult(decoded.functionName, answers, BigInt(state.l1Block));
  }

  private answerInner(inner: InnerCall, state: ArbitrumState, timestamp: number, l2Block: number): InnerAnswer {
    const { target, selector } = inner;
    if (target === MULTICALL3_ADDRESS) {
      if (selector === SELECTOR.getChainId) {
        return state.chainId === null ? null : encodeFunctionResult(multicallAbi, 'getChainId', BigInt(state.chainId));
      }
      if (selector === SELECTOR.getCurrentBlockTimestamp) {
        return encodeFunctionResult(multicallAbi, 'getCurrentBlockTimestamp', BigInt(timestamp));
      }
      if (selector === SELECTOR.getBlockNumber) {
        return encodeFunctionResult(multicallAbi, 'getBlockNumber', BigInt(state.l1Block));
      }
      return null;
    }
    if (target === ARBSYS_ADDRESS) {
      return selector === SELECTOR.arbBlockNumber
        ? encodeFunctionResult(arbSysAbi, 'arbBlockNumber', BigInt(l2Block))
        : null;
    }
    if (target === ARBITRUM_SEQUENCER_FEED) {
      const sequencer = state.sequencer ?? { answer: 0n, startedAt: BigInt(timestamp - 30 * 86_400) };
      if (sequencer === 'reverts') return null;
      if (selector === SELECTOR.latestRoundData) {
        return encodeFunctionResult(feedAbi, 'latestRoundData', [
          7n,
          sequencer.answer,
          sequencer.startedAt,
          sequencer.startedAt,
          7n,
        ]);
      }
      if (selector === SELECTOR.decimals) return encodeFunctionResult(feedAbi, 'decimals', 0);
      return null;
    }
    if (!isArbitrumFeed(target)) return null;
    const known = this.feedOf(target);
    if (known === undefined) return null;
    const feed: FeedState = { ...known, ...state.feedPatches.get(target) };
    if (feed.reverts) return null;
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

function parseBlockTag(tag: unknown): number | null {
  if (typeof tag === 'string' && /^0x[0-9a-f]+$/i.test(tag)) return Number.parseInt(tag, 16);
  if (typeof tag === 'object' && tag !== null && 'blockNumber' in tag) {
    const value = (tag as { blockNumber: unknown }).blockNumber;
    if (typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value)) return Number.parseInt(value, 16);
  }
  return null;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

// --- helpers for suites that look at one chain only --------------------------------------------

/** True for a log line or failure about Arbitrum One: it names chain 42161 (section 23, rule 11). */
export function aboutArbitrum(item: unknown): boolean {
  if (typeof item !== 'object' || item === null) return false;
  return Object.values(item as Record<string, unknown>).some((value) => value === ARBITRUM_CHAIN_ID);
}

/** The endpoint failures of Robinhood Chain only: an Arbitrum one carries `chainId` 42161. */
export function robinhoodFailures(failures: readonly MarketEndpointFailure[]): MarketEndpointFailure[] {
  return failures.filter((failure) => failure.chainId !== ARBITRUM_CHAIN_ID);
}

/**
 * The market's log lines about Robinhood Chain, with only the fields a stage 1 suite checks. Section
 * 23 rule 11 has every line say its chain; how a Robinhood line says it is the market's choice.
 */
export function robinhoodLines(lines: readonly object[]): Record<string, unknown>[] {
  return lines
    .filter((line) => !aboutArbitrum(line))
    .map((line) => {
      const { event, endpoint, confirmedBy, reason } = line as Record<string, unknown>;
      return reason === undefined ? { event, endpoint, confirmedBy } : { event, endpoint, confirmedBy, reason };
    });
}

/** The market's log lines about Arbitrum One. */
export function arbitrumLines(lines: readonly object[]): Record<string, unknown>[] {
  return lines.filter((line) => aboutArbitrum(line)) as Record<string, unknown>[];
}
