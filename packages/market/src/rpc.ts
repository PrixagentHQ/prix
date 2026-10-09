import { ChainUnavailableError, type MarketEndpointFailure } from '@prix/contracts';
import { readCappedText, TOO_LARGE } from './body.ts';
import { isTransient } from './rules.ts';

/** The only methods this package sends for the data API. Reads only. */
const ALLOWED = new Set([
  'eth_getLogs',
  'eth_call',
  'eth_getCode',
  'eth_getStorageAt',
  'eth_getTransactionReceipt',
  'eth_blockNumber',
]);
const TIMEOUT_MS = 8000;

/**
 * Thrown by `createRpc` when every endpoint failed in a way that may pass on another
 * (`movesToNextEndpoint`): a transport failure, 429, 5xx or a timeout. A `ChainUnavailableError`
 * like any other, so callers that do not care see no difference; `readWithAgreement` uses it to
 * know when an endpoint of its own may be asked next.
 */
export class ChainTransientError extends ChainUnavailableError {}

export interface RpcCall {
  method: string;
  params: unknown[];
}
export interface Rpc {
  call(method: string, params: unknown[]): Promise<unknown>;
  /** One fetch for the whole batch; results in call order. */
  batch(calls: RpcCall[]): Promise<unknown[]>;
}

interface RpcAnswer {
  id?: unknown;
  result?: unknown;
  error?: unknown;
}

type Failure = Pick<MarketEndpointFailure, 'kind' | 'code'>;

/** What one request to one endpoint gave: the results in call order, or why not. */
type Outcome = { ok: true; results: unknown[] } | { ok: false; failure: Failure };

const malformed: Outcome = { ok: false, failure: { kind: 'malformed' } };

/**
 * True when the next endpoint is worth asking (docs/CONTRACTS.md section 20): only after a failure
 * that may pass on another endpoint, by the `isTransient` rule of the snapshot: a transport failure,
 * HTTP 429 (or 408), a 5xx, or a timeout. A JSON-RPC refusal never moves on, whatever its code: the
 * same request gets the same refusal everywhere (a getLogs range too wide, a revert), and asking
 * again only spends the rate limits of the public endpoints that the price read depends on. A
 * refusal by HTTP status (other 4xx) and an answer that cannot be read do not move on either.
 */
export function movesToNextEndpoint(failure: Failure): boolean {
  return failure.kind !== 'rpc_error' && isTransient(failure);
}

/**
 * JSON-RPC over fetch. Tries the urls in order, 8 s each, no retry, and moves to the next url only
 * when `movesToNextEndpoint` says so. At most `RPC_MAX_RESPONSE_BYTES` of an answer are read.
 * Throws ChainUnavailableError and nothing else; it never carries a URL, which may hold a key.
 */
export function createRpc(urls: readonly string[], fetchFn: typeof fetch = fetch): Rpc {
  async function send(url: string, calls: RpcCall[]): Promise<Outcome> {
    const body = calls.map((c, i) => ({ jsonrpc: '2.0', id: i + 1, method: c.method, params: c.params }));
    let text: string | typeof TOO_LARGE;
    try {
      const response = await fetchFn(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        return { ok: false, failure: { kind: 'http', code: response.status } };
      }
      text = await readCappedText(response);
    } catch (error) {
      const name = error instanceof Error || error instanceof DOMException ? error.name : '';
      return { ok: false, failure: { kind: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network' } };
    }
    if (text === TOO_LARGE) return malformed;

    let answers: unknown;
    try {
      answers = JSON.parse(text);
    } catch {
      return malformed;
    }
    if (!Array.isArray(answers)) return malformed;
    const byId = new Map<unknown, RpcAnswer>();
    for (const a of answers as RpcAnswer[]) {
      if (typeof a === 'object' && a !== null) byId.set(a.id, a);
    }
    const results: unknown[] = [];
    for (let i = 0; i < calls.length; i++) {
      const a = byId.get(i + 1);
      if (a === undefined) return malformed;
      if (a.error !== undefined) return { ok: false, failure: { kind: 'rpc_error' } };
      if (!('result' in a)) return malformed;
      results.push(a.result);
    }
    return { ok: true, results };
  }

  async function batch(calls: RpcCall[]): Promise<unknown[]> {
    if (calls.length === 0) return [];
    for (const c of calls) if (!ALLOWED.has(c.method)) throw new ChainUnavailableError();
    for (const url of urls) {
      let outcome: Outcome;
      try {
        outcome = await send(url, calls);
      } catch {
        // Nothing in send should throw; if something does, it is not a reason to ask anyone else.
        throw new ChainUnavailableError();
      }
      if (outcome.ok) return outcome.results;
      if (!movesToNextEndpoint(outcome.failure)) throw new ChainUnavailableError();
    }
    throw new ChainTransientError();
  }

  return {
    async call(method, params) {
      const [result] = await batch([{ method, params }]);
      return result;
    },
    batch,
  };
}
