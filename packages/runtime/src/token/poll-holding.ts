import {
  type Address,
  type CreatePollHoldingReader,
  computeTier,
  POLL_TALLY_ANSWER_MAX_BYTES,
  POLL_TALLY_FETCH_TIMEOUT_MS,
  POLL_TALLY_MAX_FETCHES,
  type PollHoldingReader,
  type PollTiersRead,
  pollTallySlowAnswerMarks,
  type TokenChainReader,
  TokenReadError,
} from '@prix/contracts';
import { endpointHost, isThirdPartyEndpoint } from '@prix/market/chain';

/**
 * The holders' poll tally's one way to the chain (docs/contracts/phase-6-holders.md section 5, revision 4
 * HB3-4): `PollHoldingReader.tiersNow(wallets, atBlock)` is one `TokenChainReader.readBalances` (one Multicall3
 * `eth_call` under the two-endpoint agreement), each tier by `computeTier` at the configured thresholds. It
 * has no store: the hold before a tier rises does not apply (a vote already waited its hour) and no row of
 * `token_holders` is ever written. `atBlock` null reads at the head with no block tag; a number is passed as
 * the read's block tag. A read that fails throws.
 *
 * Its fetches are reported to the run (H2-SEC-4, "engine-runtime's choice of how, inside poll-holding.ts"):
 * the fetches happen inside the chain reader, which the entry builds, so the entry routes that reader's
 * `fetch` through a `PollFetchMeter` of this file and hands the same meter to this reader. A head read
 * (`atBlock` null) starts a run, since every tally or prune run starts with exactly one; from then on the
 * meter refuses, without sending it, every fetch past POLL_TALLY_MAX_FETCHES, so the read throws and the run
 * fails at `read`; and each answer carries `fetches`, the run's count so far, which `tallyPoll` checks before
 * it asks for another read. Build one meter and one reader for each run (each invocation of the social step,
 * each request of the admin route): a meter shared by two runs at once would count them together.
 */

/** A `fetch` that counts and caps a run's outbound requests. */
export interface PollFetchMeter {
  /** The counted fetch: hand it to `createTokenChainReader` as its `fetchFn`. */
  fetch: typeof fetch;
  /** Starts a run: the count goes back to zero. */
  startRun(): void;
  /** Fetches sent in the current run, refused ones not included. */
  spent(): number;
}

/** What `tiersNow` answers when a meter counts its fetches. */
export type MeteredPollTiersRead = PollTiersRead & {
  /** The run's fetches so far, this read's included; absent when no meter was given. */
  fetches?: number;
};

export interface MeteredPollHoldingReader extends PollHoldingReader {
  tiersNow(wallets: readonly Address[], atBlock: number | null): Promise<MeteredPollTiersRead>;
}

/** Thrown by the meter's fetch past the cap; carries nothing, so no URL can reach a log. */
export class PollFetchCapReached extends Error {
  constructor() {
    super('The tally run has spent its fetches.');
    this.name = 'PollFetchCapReached';
  }
}

/**
 * Thrown by the meter's fetch for an endpoint the run has marked, an input with no host, a fetch that failed or
 * was aborted, an answer whose status is not 2xx (its body cancelled unread), a body longer than
 * POLL_TALLY_ANSWER_MAX_BYTES or a body whose read failed. It carries nothing: no URL, no host, no word of the
 * endpoint's, so nothing of it can reach a log. The chain reader reads it as a transport failure and moves on to the
 * next endpoint.
 */
export class PollFetchRefused extends Error {
  constructor() {
    super('The tally run did not use this endpoint.');
    this.name = 'PollFetchRefused';
  }
}

/** The URL of a fetch's input: the string, a URL's href or a Request's url. */
function inputUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** Thrown inside the meter when the run's abort came first; never leaves it. */
class Aborted extends Error {}
/** Thrown inside the meter for a body longer than POLL_TALLY_ANSWER_MAX_BYTES; never leaves it. */
class TooLong extends Error {}

/** `promise`, or `Aborted` as soon as `signal` aborts. */
function orAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Aborted());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Aborted());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/** Reads a body whole, at most POLL_TALLY_ANSWER_MAX_BYTES, before `signal` aborts. */
async function readCapped(body: ReadableStream<Uint8Array> | null, signal: AbortSignal): Promise<Uint8Array> {
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await orAbort(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > POLL_TALLY_ANSWER_MAX_BYTES) throw new TooLong();
      chunks.push(value);
    }
  } catch (error) {
    reader.cancel().catch(() => undefined);
    throw error;
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

/** True for one JSON-RPC answer with a `result` member (an `error` member, -32005 inside HTTP 200 among them, is not). */
function isResultAnswer(bytes: Uint8Array): boolean {
  try {
    const answer: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof answer === 'object' && answer !== null && !Array.isArray(answer) && 'result' in answer;
  } catch {
    return false;
  }
}

/**
 * A meter of at most `max` fetches a run (POLL_TALLY_MAX_FETCHES unless a test says otherwise), with the run's
 * endpoint memory (docs/contracts/phase-6-holders.md section 5, "One endpoint memory per run", revisions 8 to 8f):
 *
 * 1. The run keeps the hosts (`endpointHost` of the input's URL: a string, a URL's href or a Request's url) that
 *    failed or refused in it; `startRun()` empties them as it zeroes the count. An input whose host is null is
 *    refused like a marked one, uncounted.
 * 2. A host is marked when its fetch rejects or is aborted; when its answer's status is not 2xx (429 among them),
 *    whose body is then cancelled unread and the fetch rejects with `PollFetchRefused`, so no body outside 2xx is
 *    read by anyone (PF5-SEC-1); when a 2xx answer's body, read from a clone before the answer is handed on, is
 *    not a JSON-RPC answer with a `result` member. The meter aborts each fetch POLL_TALLY_FETCH_TIMEOUT_MS after its call, joined to the
 *    caller's signal, and the milliseconds run to the end of the clone's read: headers in time with no whole body
 *    by then mark the host and the fetch rejects with `PollFetchRefused`. The clone is read up to
 *    POLL_TALLY_ANSWER_MAX_BYTES: a longer body, a Content-Length above it, or a read that rejects marks the host
 *    and the fetch rejects with `PollFetchRefused`. An answer of an endpoint taken alone (not
 *    `isThirdPartyEndpoint` of its input URL: the official endpoint or a set RPC_URL) that comes later than
 *    POLL_TALLY_SLOW_ANSWER_MS after its call, to the end of the clone's read, is used and marks its host
 *    (`pollTallySlowAnswerMarks`); a third party's answer is never marked for its time alone.
 * 3. A fetch to a marked host is refused before anything is sent, with `PollFetchRefused`, and not counted. A
 *    fetch past the cap is refused with `PollFetchCapReached`.
 *
 * `clock` gives the milliseconds of the slow mark (the real clock unless a test says otherwise).
 */
export function createPollFetchMeter(
  fetchFn: typeof fetch = fetch,
  max: number = POLL_TALLY_MAX_FETCHES,
  clock: () => number = () => Date.now(),
): PollFetchMeter {
  let count = 0;
  const marked = new Set<string>();

  const metered = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = inputUrl(input);
    const host = endpointHost(url);
    if (host === null || marked.has(host)) throw new PollFetchRefused();
    if (count >= max) throw new PollFetchCapReached();
    count += 1;
    const takenAlone = !isThirdPartyEndpoint(url);
    const started = clock();

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), POLL_TALLY_FETCH_TIMEOUT_MS);
    const caller = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const onCallerAbort = () => abort.abort();
    if (caller) {
      if (caller.aborted) abort.abort();
      else caller.addEventListener('abort', onCallerAbort, { once: true });
    }
    const refuse = (): never => {
      marked.add(host);
      throw new PollFetchRefused();
    };
    try {
      let response: Response;
      try {
        response = await orAbort(fetchFn(input, { ...init, signal: abort.signal }), abort.signal);
      } catch {
        return refuse();
      }
      // Outside 2xx (429 among them, and a 3xx before withoutRedirects sees it): the body is cancelled unread and the
      // fetch rejects with the error that carries nothing, so no body outside 2xx is read by anyone (PF5-SEC-1; the
      // caller would read it after this meter's timer is cleared, with no bound).
      if (response.status < 200 || response.status > 299) {
        response.body?.cancel().catch(() => undefined);
        return refuse();
      }
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > POLL_TALLY_ANSWER_MAX_BYTES) {
        response.body?.cancel().catch(() => undefined);
        return refuse();
      }
      let bytes: Uint8Array;
      try {
        bytes = await readCapped(response.clone().body, abort.signal);
      } catch {
        response.body?.cancel().catch(() => undefined);
        return refuse();
      }
      if (!isResultAnswer(bytes)) marked.add(host);
      else if (pollTallySlowAnswerMarks(clock() - started, takenAlone)) marked.add(host);
      return response;
    } finally {
      clearTimeout(timer);
      caller?.removeEventListener('abort', onCallerAbort);
    }
  };

  return {
    fetch: metered as typeof fetch,
    startRun() {
      count = 0;
      marked.clear();
    },
    spent: () => count,
  };
}

export interface PollHoldingReaderDeps {
  chain: TokenChainReader;
  config: () => Promise<{
    token: Address | null;
    thresholdsPpm: readonly [number, number, number];
    gatingOn: boolean;
  }>;
  /** The meter the chain reader's fetch goes through; absent, no count is reported. */
  meter?: PollFetchMeter;
}

export const createPollHoldingReader = ((deps: PollHoldingReaderDeps): MeteredPollHoldingReader => ({
  async tiersNow(wallets, atBlock) {
    if (atBlock === null) deps.meter?.startRun();
    const config = await deps.config();
    const token = config.token;
    if (!config.gatingOn || token === null) {
      // Gating off or no token: the tally waits, and nothing is read from the chain.
      return withCount({ gatingOn: false, tiers: wallets.map(() => 0 as const), blockNumber: 0 }, deps.meter);
    }
    const read =
      atBlock === null
        ? await deps.chain.readBalances(token, wallets)
        : await deps.chain.readBalances(token, wallets, atBlock);
    if (read.balances.length !== wallets.length) throw new TokenReadError('invalid_answer');
    const blockNumber = Number(read.blockNumber);
    if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) throw new TokenReadError('invalid_answer');
    const tiers = read.balances.map((balance) => computeTier(balance, read.totalSupply, config.thresholdsPpm));
    return withCount({ gatingOn: true, tiers, blockNumber }, deps.meter);
  },
})) satisfies CreatePollHoldingReader;

function withCount(read: PollTiersRead, meter: PollFetchMeter | undefined): MeteredPollTiersRead {
  return meter === undefined ? read : { ...read, fetches: meter.spent() };
}
