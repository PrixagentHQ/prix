/**
 * The only file in this package that touches the network for a snapshot. It sends one batched read
 * to one RPC endpoint, of Robinhood Chain (`readSnapshot`) or of Arbitrum One (`readArbitrum`,
 * docs/CONTRACTS.md section 23), and says exactly what came back: the decoded reads, or the kind of
 * failure with its HTTP status or JSON-RPC code. It never throws, so nothing about a failure is
 * lost on the way to `MarketConfig.onEndpointFailure` (docs/DECISIONS.md D-098).
 *
 * The request is a plain JSON-RPC `eth_call` over `fetch`. viem builds the calldata and decodes the
 * answer (`./wire.ts`); its HTTP transport is not used, because it wraps the status and the code
 * of a failure in layers of error classes that are not part of its stable interface.
 */
import type { MarketEndpointFailure, UniverseToken } from '@prix/contracts';
import { ARBITRUM_CHAIN_ID } from '@prix/contracts';
import type { Hex } from 'viem';
import { readCappedText, TOO_LARGE } from './body.ts';
import type { FeedRead } from './rules.ts';
import { ARBITRUM_SEQUENCER_FEED, UNIVERSE } from './universe.ts';
import {
  type ArbitrumReads,
  arbitrumCalldata,
  arbitrumResultMaxBytes,
  decodeArbitrumResult,
  decodeSnapshotResult,
  MULTICALL_ADDRESS,
  MULTICALL3_ADDRESS,
  type SequencerRound,
  type SnapshotReads,
  snapshotCalldata,
  snapshotResultMaxBytes,
} from './wire.ts';

/**
 * The public RPC endpoint of Robinhood Chain mainnet, chain ID 4663. It is the fallback behind the
 * keyed endpoint in `RPC_URL`, and the only endpoint when that secret is not set.
 * Source: https://docs.robinhood.com/chain/connecting, "Public Endpoints", read 2026-10-06. Checked
 * again on 2026-10-07 for a second public endpoint: there is none; every other endpoint the page
 * names needs an account and a key (RESEARCH.md, section 1, says how that check was made).
 * The same page calls it rate-limited and not for production use.
 */
export const PUBLIC_RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';

/**
 * Every public endpoint, in the order a chain read tries them: the official one, then two
 * independent free public endpoints that answer chain ID 4663, found on 2026-10-07 after the
 * official one went quiet from about 18:00 UTC two days running (docs/DECISIONS.md D-098).
 * publicnode: https://robinhood-rpc.publicnode.com. dRPC: https://robinhood.drpc.org, a provider
 * the Robinhood page names under "Other Providers". Both answered `eth_chainId` 0x1237 and a block
 * of the current second when read on 2026-10-08 (RESEARCH.md, section 1, has the trust they get).
 * They are used only after the one before them failed. A snapshot either of them serves is
 * accepted only when a second independent endpoint agrees on every feed (`isThirdPartyEndpoint`,
 * docs/CONTRACTS.md section 20): the "node is behind" check and the suspect-move rule stop a node
 * that lags, not one that lies.
 */
export const PUBLIC_RPC_URLS: readonly string[] = [
  PUBLIC_RPC_URL,
  'https://robinhood-rpc.publicnode.com',
  'https://robinhood.drpc.org',
];

/** The endpoints of `PUBLIC_RPC_URLS` that neither Robinhood nor the operator runs: publicnode and dRPC. */
export const THIRD_PARTY_RPC_URLS: readonly string[] = PUBLIC_RPC_URLS.filter((url) => url !== PUBLIC_RPC_URL);

const withoutTrailingSlash = (url: string): string => url.trim().replace(/\/+$/, '');

/**
 * True for an endpoint of `THIRD_PARTY_RPC_URLS`, however many slashes end it. The keyed `RPC_URL`
 * (any other address, set by the operator) and the official endpoint are not third parties: a
 * snapshot from them is accepted alone. Pure.
 */
export function isThirdPartyEndpoint(url: string): boolean {
  const given = withoutTrailingSlash(url);
  return THIRD_PARTY_RPC_URLS.some((known) => withoutTrailingSlash(known) === given);
}

/**
 * The host of an endpoint, lower case, or null when it is not a URL. Two endpoints on one host are
 * one provider and cannot confirm each other. Pure.
 */
export function endpointHost(url: string): string | null {
  try {
    return new URL(url.trim()).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * The endpoints of one chain read, in order: a valid keyed `RPC_URL` first when set, then
 * `PUBLIC_RPC_URLS`, with no endpoint twice. A keyed value that is not an https URL is left out.
 * Pure: the caller logs `rpc_url_ignored` if it wants to know.
 */
export function rpcEndpoints(keyed: string | undefined): string[] {
  const key = typeof keyed === 'string' ? keyed.trim() : '';
  let usable = false;
  try {
    usable = key !== '' && new URL(key).protocol === 'https:';
  } catch {
    usable = false;
  }
  const list = usable ? [key, ...PUBLIC_RPC_URLS] : [...PUBLIC_RPC_URLS];
  return list.filter((url, index) => list.indexOf(url) === index);
}

/** Robinhood Chain mainnet. An answer for any other chain is a failed request. */
export const EXPECTED_CHAIN_ID = 4663n;

/** How long one request gets, the reading of its body included. */
export const RPC_TIMEOUT_MS = 8_000;

/** A request that gave nothing usable, and why. The caller adds the endpoint (and its chain). */
export interface RequestFailed {
  ok: false;
  failure: Omit<MarketEndpointFailure, 'endpoint' | 'lagSeconds' | 'chainId'>;
}

/** What one request to one endpoint gave. */
export type ReadOutcome = { ok: true; reads: SnapshotReads & { blockTimestamp: bigint } } | RequestFailed;

const malformed: RequestFailed = { ok: false, failure: { kind: 'malformed' } };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A failure of `fetch` itself, or of reading the body: the time limit, or the connection. */
function thrown(error: unknown): RequestFailed {
  const name = error instanceof Error || error instanceof DOMException ? error.name : '';
  return { ok: false, failure: { kind: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network' } };
}

/** The raw answer of one `eth_call`, or why there is none. */
type CallOutcome = { ok: true; result: Hex } | RequestFailed;

/**
 * Sends one `eth_call` to one endpoint: one outbound request, no retry. Never throws. The answer is
 * read up to RPC_MAX_RESPONSE_BYTES; an answer that is not a JSON-RPC result holding non-empty hex
 * is `malformed`.
 *
 * A redirect is never followed (`redirect: 'manual'`): the 3xx comes back as it is and is an `http`
 * failure with its code, which `isTransient` does not retry. Followed, every hop of a redirect chain
 * would be one more subrequest of the Worker's invocation ("Each subrequest in a redirect chain
 * counts against this limit", https://developers.cloudflare.com/workers/platform/limits/, read
 * 2026-10-09; "If set to manual, the 3xx redirect response will be returned to the caller as-is",
 * https://developers.cloudflare.com/workers/runtime-apis/request/, read 2026-10-09), so one endpoint
 * could spend the requests of the whole step, and a listed host could hand the question to a host
 * that is not on the list.
 */
async function ethCall(
  rpcUrl: string,
  to: string,
  data: Hex,
  block: Hex | 'latest',
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<CallOutcome> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, block] });
  let text: string | typeof TOO_LARGE;
  try {
    const response = await fetchFn(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status !== 200) {
      // A redirect ends here too: a 3xx, or 0 where a runtime hides the status of an unfollowed one.
      // The body says nothing the status does not, and leaving it unread holds the connection.
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, failure: { kind: 'http', code: response.status } };
    }
    // At most RPC_MAX_RESPONSE_BYTES are read, Content-Length or not (docs/CONTRACTS.md section 20).
    text = await readCappedText(response);
  } catch (error) {
    return thrown(error);
  }

  if (text === TOO_LARGE) return malformed;
  let answer: unknown;
  try {
    answer = JSON.parse(text);
  } catch {
    return malformed;
  }
  if (!isRecord(answer)) return malformed;
  if (answer.error !== undefined) {
    const code = isRecord(answer.error) ? answer.error.code : undefined;
    return {
      ok: false,
      failure: typeof code === 'number' && Number.isInteger(code) ? { kind: 'rpc_error', code } : { kind: 'rpc_error' },
    };
  }
  const result = answer.result;
  if (typeof result !== 'string' || !/^0x[0-9a-fA-F]*$/.test(result) || result === '0x') return malformed;
  return { ok: true, result: result as Hex };
}

/** One answer that was decoded: the universe it was decoded for, its bytes, and what they hold. */
interface Decoded<T> {
  universe: readonly UniverseToken[];
  data: Hex;
  /** Null when the answer did not decode: it is not the answer of the read. */
  reads: T | null;
}

/**
 * The answers the reads of one snapshot have decoded so far, each chain's apart. A read that is given
 * one decodes an answer only when no earlier read of the same universe got the same bytes: two
 * endpoints that agree mostly say the same bytes (on Arbitrum the confirming pair must), and decoding
 * them is the dearest thing a read does (1.14 ms for the Robinhood answer, tools/perf, 2026-10-09).
 * The same bytes decode to the same reads, so what a read returns does not change; two reads may
 * return the same objects, which nothing writes to. Make one per snapshot with `createDecodedAnswers`
 * and let it go with the snapshot: it holds every answer it has seen. An earlier answer is found by
 * the universe array itself, not by its content, so the array must not change while one is in use.
 */
export interface DecodedAnswers {
  robinhood: Decoded<SnapshotReads>[];
  arbitrum: Decoded<ArbitrumReads>[];
}

export function createDecodedAnswers(): DecodedAnswers {
  return { robinhood: [], arbitrum: [] };
}

/**
 * Decodes `data`, or returns what an earlier read made of the same bytes for the same universe. Null
 * when the answer does not decode. An answer over `maxBytes` is not kept: the decoder refuses it by
 * its length alone, so nothing is saved by remembering it and nothing that large is held.
 */
function decodeOnce<T>(
  seen: Decoded<T>[] | undefined,
  universe: readonly UniverseToken[],
  data: Hex,
  maxBytes: number,
  decode: (universe: readonly UniverseToken[], data: Hex) => T,
): T | null {
  if (seen !== undefined) {
    for (const earlier of seen) {
      if (earlier.universe === universe && earlier.data === data) return earlier.reads;
    }
  }
  let reads: T | null;
  try {
    reads = decode(universe, data);
  } catch {
    reads = null;
  }
  if (seen !== undefined && data.length <= 2 + 2 * maxBytes) seen.push({ universe, data, reads });
  return reads;
}

/**
 * Reads every Robinhood Chain feed of the universe from one endpoint with a single `eth_call`: one
 * outbound request. An answer that is not the expected multicall result, that comes from another
 * chain, or that does not say the time of its block is `malformed`: the endpoint did not answer the
 * question. Whether the block is recent enough is for the caller, which knows the time of the snapshot.
 *
 * The result is bounded before anything decodes it (`multicallResultProblem` in `./wire.ts`, called by
 * `decodeSnapshotResult`): at most `snapshotResultMaxBytes(universe)` bytes, exactly the expected
 * number of results, and results that do not share their bytes. Anything else is `malformed` at a
 * cost that does not depend on what the endpoint sent.
 *
 * The calldata is `encodeSnapshotCall(universe)`, encoded once for a universe and not once for a
 * request (`snapshotCalldata`). With `decoded`, an answer whose bytes an earlier read of the same
 * snapshot already decoded is not decoded again (`DecodedAnswers`).
 */
export async function readSnapshot(
  rpcUrl: string,
  universe: readonly UniverseToken[],
  fetchFn: typeof fetch = fetch,
  timeoutMs: number = RPC_TIMEOUT_MS,
  decoded?: DecodedAnswers,
): Promise<ReadOutcome> {
  const call = await ethCall(rpcUrl, MULTICALL_ADDRESS, snapshotCalldata(universe), 'latest', fetchFn, timeoutMs);
  if (!call.ok) return call;
  const reads = decodeOnce(
    decoded?.robinhood,
    universe,
    call.result,
    snapshotResultMaxBytes(universe),
    decodeSnapshotResult,
  );
  if (reads === null) return malformed;
  if (reads.chainId !== EXPECTED_CHAIN_ID || reads.blockTimestamp === null) return malformed;
  return { ok: true, reads: { ...reads, blockTimestamp: reads.blockTimestamp } };
}

/** Arbitrum One. An Arbitrum read that answers for any other chain is a failed request. */
export const EXPECTED_ARBITRUM_CHAIN_ID = BigInt(ARBITRUM_CHAIN_ID);

/** A decoded Arbitrum read that answered the question: every field the rules need is there. */
export interface ArbitrumAnswer {
  /** The L2 block, from ArbSys. */
  l2BlockNumber: bigint;
  /** The time of that block, Unix seconds. */
  blockTimestamp: bigint;
  /** The sequencer uptime feed's round, or null when that inner call failed (`judgeSequencer` says unknown). */
  sequencer: SequencerRound | null;
  /** One read per universe entry, in universe order; entries not on Arbitrum are all null. */
  reads: FeedRead[];
  /**
   * The `eth_call` result exactly as the endpoint sent it, lower case. Two endpoints agree only when
   * these are byte-identical (docs/CONTRACTS.md section 23, rule 3).
   */
  raw: Hex;
}

/** What one Arbitrum request gave. */
export type ArbitrumReadOutcome = { ok: true; answer: ArbitrumAnswer } | RequestFailed;

/**
 * Reads the Arbitrum One feeds of the universe and the sequencer uptime feed from one endpoint with a
 * single `eth_call` to Multicall3, at `block` (an L2 block number, sent as a hex tag) or at `latest`:
 * one outbound request, no retry (docs/CONTRACTS.md section 23). Never throws. An answer that does not
 * decode, that is not for chain 42161, or that lacks its block time or its ArbSys block is
 * `malformed`. Whether the block is recent enough is for the caller. The Ethereum block that
 * Multicall3 returns is never used.
 *
 * The result is bounded before anything decodes it, as in `readSnapshot`: at most
 * `arbitrumResultMaxBytes(universe)` bytes (4,480 for three feeds), exactly the expected number of
 * results, and results that do not share their bytes (`decodeArbitrumResult`).
 *
 * The calldata is `encodeArbitrumCall(universe, sequencerFeed)`, encoded once for a universe and a
 * sequencer feed and not once for a request (`arbitrumCalldata`). With `decoded`, an answer whose
 * bytes an earlier read of the same snapshot already decoded is not decoded again (`DecodedAnswers`):
 * the second endpoint of a pair that agrees.
 */
export async function readArbitrum(
  rpcUrl: string,
  block: bigint | 'latest',
  universe: readonly UniverseToken[] = UNIVERSE,
  fetchFn: typeof fetch = fetch,
  timeoutMs: number = RPC_TIMEOUT_MS,
  sequencerFeed: string = ARBITRUM_SEQUENCER_FEED.address,
  decoded?: DecodedAnswers,
): Promise<ArbitrumReadOutcome> {
  try {
    if (block !== 'latest' && block < 0n) return malformed;
    const tag: Hex | 'latest' = block === 'latest' ? 'latest' : `0x${block.toString(16)}`;
    const call = await ethCall(
      rpcUrl,
      MULTICALL3_ADDRESS,
      arbitrumCalldata(universe, sequencerFeed),
      tag,
      fetchFn,
      timeoutMs,
    );
    if (!call.ok) return call;
    const reads = decodeOnce(
      decoded?.arbitrum,
      universe,
      call.result,
      arbitrumResultMaxBytes(universe),
      decodeArbitrumResult,
    );
    if (reads === null) return malformed;
    const { chainId, blockTimestamp, l2BlockNumber } = reads;
    if (chainId !== EXPECTED_ARBITRUM_CHAIN_ID || blockTimestamp === null || l2BlockNumber === null) return malformed;
    return {
      ok: true,
      answer: {
        l2BlockNumber,
        blockTimestamp,
        sequencer: reads.sequencer,
        reads: reads.reads,
        raw: call.result.toLowerCase() as Hex,
      },
    };
  } catch {
    // Nothing above should throw (a bad `fetch` argument, say). If it does, the endpoint gave nothing.
    return { ok: false, failure: { kind: 'network' } };
  }
}
