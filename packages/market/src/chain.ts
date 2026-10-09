/**
 * The only file in this package that touches the network for a snapshot. It sends the one batched
 * read to one RPC endpoint and says exactly what came back: the decoded reads, or the kind of
 * failure with its HTTP status or JSON-RPC code. It never throws, so nothing about a failure is
 * lost on the way to `MarketConfig.onEndpointFailure` (docs/DECISIONS.md D-098).
 *
 * The request is a plain JSON-RPC `eth_call` over `fetch`. viem builds the calldata and decodes the
 * answer (`./wire.ts`); its HTTP transport is not used, because it wraps the status and the code
 * of a failure in layers of error classes that are not part of its stable interface.
 */
import type { MarketEndpointFailure, UniverseToken } from '@prix/contracts';
import { readCappedText, TOO_LARGE } from './body.ts';
import { decodeSnapshotResult, encodeSnapshotCall, MULTICALL_ADDRESS, type SnapshotReads } from './wire.ts';

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

/** What one request to one endpoint gave. */
export type ReadOutcome =
  | { ok: true; reads: SnapshotReads & { blockTimestamp: bigint } }
  | { ok: false; failure: Omit<MarketEndpointFailure, 'endpoint' | 'lagSeconds'> };

const malformed: ReadOutcome = { ok: false, failure: { kind: 'malformed' } };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A failure of `fetch` itself, or of reading the body: the time limit, or the connection. */
function thrown(error: unknown): ReadOutcome {
  const name = error instanceof Error || error instanceof DOMException ? error.name : '';
  return { ok: false, failure: { kind: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network' } };
}

/**
 * Reads every feed of the universe from one endpoint with a single `eth_call`: one outbound request.
 * An answer that is not the expected multicall result, that comes from another chain, or that does
 * not say the time of its block is `malformed`: the endpoint did not answer the question. Whether
 * the block is recent enough is for the caller, which knows the time of the snapshot.
 */
export async function readSnapshot(
  rpcUrl: string,
  universe: readonly UniverseToken[],
  fetchFn: typeof fetch = fetch,
  timeoutMs: number = RPC_TIMEOUT_MS,
): Promise<ReadOutcome> {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_call',
    params: [{ to: MULTICALL_ADDRESS, data: encodeSnapshotCall(universe) }, 'latest'],
  });
  let text: string | typeof TOO_LARGE;
  try {
    const response = await fetchFn(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status !== 200) {
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

  let reads: SnapshotReads;
  try {
    reads = decodeSnapshotResult(universe, result as `0x${string}`);
  } catch {
    return malformed;
  }
  if (reads.chainId !== EXPECTED_CHAIN_ID || reads.blockTimestamp === null) return malformed;
  return { ok: true, reads: { ...reads, blockTimestamp: reads.blockTimestamp } };
}
