import { decodeMulticall, decodeMulticallResult, encodeMulticallResult, type Hex, type InnerAnswer } from './abi.ts';

/**
 * Two faults of an RPC endpoint that the fake chains do not have, as wrappers around a fake `fetch`
 * (docs/CONTRACTS.md sections 20 and 23; security review of the second-chain read):
 *
 * - `redirecting`: an endpoint that answers with a redirect. The fake chains never redirect, so a
 *   market that lets `fetch` follow one passes every suite that uses them alone. This wrapper does
 *   what `fetch` does: with `redirect: 'manual'` it hands the 3xx back; with the default it sends the
 *   request on to the new place, a host nobody named, and returns that host's answer.
 * - `reshaping`: an endpoint whose multicall answer still decodes but is not the answer to the
 *   question: padded far past what an honest read can be, or with the wrong number of results.
 *
 * Nothing here reaches a network.
 */

const norm = (url: string): string => url.trim().replace(/\/+$/, '');

/** One request as it left the Worker: a request the market made, or one `fetch` made following a redirect. */
export interface Hop {
  url: string;
  /** The redirect mode of the request: 'follow' is the default of `fetch`. */
  redirect: string;
  /** The endpoint whose redirect sent this request here, or null for a request the market itself made. */
  followedFrom: string | null;
}

export interface Redirect {
  status: number;
  location: string;
}

/**
 * A `fetch` in front of `inner` where each endpoint of `redirects` answers with its redirect.
 * `elsewhere` answers a request that was sent on. `hops` lists every request in order.
 */
export function redirecting(
  inner: typeof fetch,
  redirects: ReadonlyMap<string, Redirect>,
  elsewhere: typeof fetch,
): { fetch: typeof fetch; hops: Hop[] } {
  const hops: Hop[] = [];
  const table = new Map([...redirects].map(([url, redirect]) => [norm(url), redirect]));
  const fetchFn: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = norm(request.url);
    const mode = String(request.redirect);
    hops.push({ url, redirect: mode, followedFrom: null });
    const redirect = table.get(url);
    if (redirect === undefined) return inner(input, init);
    if (mode === 'manual') {
      return new Response(null, { status: redirect.status, headers: { location: redirect.location } });
    }
    if (mode === 'error') throw new TypeError('fetch failed: unexpected redirect');
    // The default: `fetch` goes where the endpoint says, and the caller never sees the 3xx.
    hops.push({ url: norm(redirect.location), redirect: mode, followedFrom: url });
    return elsewhere(redirect.location, init);
  };
  return { fetch: fetchFn, hops };
}

/** An honest multicall answer, decoded: what a reshaped answer starts from. */
export interface HonestAnswer {
  /** The outer multicall function the market called. */
  functionName: string;
  blockNumber: bigint;
  /** One inner answer per inner call, in order; null for a failed one. */
  answers: InnerAnswer[];
  /** The `eth_call` result exactly as the honest endpoint sent it. */
  result: Hex;
}

/**
 * Gives the `eth_call` result to send instead of the honest one. `padBytes` is how many bytes (a
 * multiple of 32) can be added to the result while the whole response stays under `bodyBytes`.
 */
export type Reshape = (honest: HonestAnswer, padBytes: number) => Hex;

/** One answer that was reshaped. */
export interface Reshaped {
  url: string;
  functionName: string;
  honest: Hex;
  result: Hex;
  /** The size of the response body that was sent, in bytes. */
  bodyBytes: number;
}

/**
 * A `fetch` in front of `inner` where each endpoint of `targets` answers with its honest multicall
 * answer changed by `reshape`. An answer that is no multicall result (an error, another status) is
 * passed on unchanged. `sent` lists what was sent, for a suite to check its own fault.
 */
export function reshaping(
  inner: typeof fetch,
  targets: readonly string[],
  reshape: Reshape,
  bodyBytes: number,
): { fetch: typeof fetch; sent: Reshaped[] } {
  const sent: Reshaped[] = [];
  const wanted = new Set(targets.map(norm));
  const fetchFn: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = norm(request.url);
    const response = await inner(input, init);
    if (!wanted.has(url) || response.status !== 200) return response;
    const text = await response.text();
    const pass = (): Response => new Response(text, { status: 200, headers: { 'content-type': 'application/json' } });
    let call: { params?: unknown };
    let answer: Record<string, unknown>;
    try {
      call = JSON.parse(await request.text()) as { params?: unknown };
      answer = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return pass();
    }
    const params = Array.isArray(call.params) ? call.params : [];
    const data = (params[0] as { data?: unknown } | undefined)?.data;
    const result = answer.result;
    if (typeof data !== 'string' || typeof result !== 'string') return pass();
    const outer = decodeMulticall(data.toLowerCase() as Hex);
    const honest = outer === null ? null : decodeMulticallResult(outer.functionName, result as Hex);
    if (outer === null || honest === null) return pass();
    const room = Math.max(0, Math.floor((bodyBytes - text.length) / 2));
    const changed = reshape(
      {
        functionName: outer.functionName,
        blockNumber: honest.blockNumber,
        answers: honest.answers,
        result: result as Hex,
      },
      room - (room % 32),
    );
    const body = JSON.stringify({ ...answer, result: changed });
    sent.push({
      url,
      functionName: outer.functionName,
      honest: result as Hex,
      result: changed,
      bodyBytes: body.length,
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch: fetchFn, sent };
}

/** The honest answer with `padBytes` zero bytes added to its last successful inner answer. Still decodes. */
export const paddedInside: Reshape = ({ functionName, blockNumber, answers }, padBytes) => {
  let last = -1;
  answers.forEach((answer, index) => {
    if (answer !== null) last = index;
  });
  const padded = answers.map((answer, index) =>
    index === last && answer !== null ? (`${answer}${'00'.repeat(padBytes)}` as Hex) : answer,
  );
  return encodeMulticallResult(functionName, padded, blockNumber);
};

/** The honest answer with `padBytes` zero bytes after it. Still decodes. */
export const paddedAfter: Reshape = ({ result }, padBytes) => `${result}${'00'.repeat(padBytes)}` as Hex;

/** The honest answer without its last result: a well-formed multicall answer to another question. */
export const oneResultShort: Reshape = ({ functionName, blockNumber, answers }) =>
  encodeMulticallResult(functionName, answers.slice(0, -1), blockNumber);

/** The honest answer with its last result twice. */
export const oneResultExtra: Reshape = ({ functionName, blockNumber, answers }) =>
  encodeMulticallResult(functionName, [...answers, answers[answers.length - 1] ?? null], blockNumber);

/** The honest answer, decoded and encoded again: it must be the same bytes, or the faults above change more than they say. */
export const unchanged: Reshape = ({ functionName, blockNumber, answers }) =>
  encodeMulticallResult(functionName, answers, blockNumber);
