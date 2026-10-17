import {
  type Address,
  POLL_TALLY_CHAIN_BLOCKS_PER_SECOND,
  POLL_TALLY_FETCH_LATENCY_MS,
  POLL_TALLY_KEYLESS_STATE_BLOCKS,
  POLL_TALLY_QA_NEVER_ANSWERING_LATENCY_MS,
} from '@prix/contracts';
import { PUBLIC_RPC_URLS } from '@prix/market';
import { encodeTokenResult } from '@prix/market/token-wire';

/**
 * The holders' tally's fake chain (docs/contracts/phase-6-holders.md section 25, qa row (2); CR8B-1, CR8C-2,
 * R8E-B2): three endpoints at the URLs of `PUBLIC_RPC_URLS`, so that `isThirdPartyEndpoint` and the agreement see
 * them as production does. Every fetch is answered after `POLL_TALLY_FETCH_LATENCY_MS` on the real clock (the
 * meter's abort is real time), or after the case's `latencyMs` (revision 8g, H5); the head moves `POLL_TALLY_CHAIN_BLOCKS_PER_SECOND` blocks a second of the real
 * clock; and the publicnode-shaped endpoint answers HTTP 403 to a block tag more than
 * `POLL_TALLY_KEYLESS_STATE_BLOCKS` behind its head, judged when it receives the request. A test changes how one
 * call of one endpoint is answered through `plan`.
 */

export const [OFFICIAL_URL, PUBLICNODE_URL, DRPC_URL] = PUBLIC_RPC_URLS as [string, string, string];
export type EndpointName = 'official' | 'publicnode' | 'drpc';

const BALANCE_OF = '70a08231';
const SUPPLY = 10n ** 27n;

/** How one call is answered. */
export type Plan =
  | { kind: 'answer'; delayMs?: number; headBehind?: number }
  /**
   * An answer outside 2xx. With `stalledBody`, its headers arrive and its body sends a few bytes and never ends
   * (PF5-SEC-1, revision 8g): only an abort of the fetch's signal errors it, as a real fetch's body does.
   */
  | { kind: 'status'; status: number; delayMs?: number; stalledBody?: boolean }
  | { kind: 'rpcError'; delayMs?: number }
  | { kind: 'never' }
  | { kind: 'noBody'; delayMs?: number };

export interface CallSeen {
  endpoint: EndpointName;
  /** This endpoint's call number, from 1. */
  call: number;
  /** The block tag asked, or null for the head. */
  tag: number | null;
  /** The publicnode-shaped endpoint's head when it received the request. */
  head: number;
  at: number;
  answered: string;
}

function nameOf(url: string): EndpointName | null {
  const given = url.replace(/\/+$/, '');
  if (given === OFFICIAL_URL.replace(/\/+$/, '')) return 'official';
  if (given === PUBLICNODE_URL.replace(/\/+$/, '')) return 'publicnode';
  if (given === DRPC_URL.replace(/\/+$/, '')) return 'drpc';
  return null;
}

function sleep(ms: number, signal: AbortSignal | undefined | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface FakeChainOptions {
  /** The head of the publicnode-shaped endpoint at the fake's start. */
  head?: number;
  /** Whether publicnode refuses a block more than POLL_TALLY_KEYLESS_STATE_BLOCKS behind its head (default true). */
  window?: boolean;
  /** How call `call` of `endpoint` is answered; absent, a correct answer after POLL_TALLY_FETCH_LATENCY_MS. */
  plan?: (endpoint: EndpointName, call: number) => Plan | undefined;
  /** The balance of a wallet; absent, 10^23 of a supply of 10^27 (tier 2). */
  balanceOf?: (wallet: string) => bigint;
  /**
   * The milliseconds after which a fetch is answered when its plan names none; absent, POLL_TALLY_FETCH_LATENCY_MS
   * (300, the contract's figure). A case whose first fetch costs the meter's whole POLL_TALLY_FETCH_TIMEOUT_MS runs
   * at POLL_TALLY_QA_NEVER_ANSWERING_LATENCY_MS (250, revision 8g, H5), so that the load of the full suite cannot eat its margin to
   * POLL_TALLY_MAX_RUN_SECONDS; the contract's figures at 300 are computed by its check and measured by gate 3's
   * script, not here.
   */
  latencyMs?: number;
}

/**
 * The test latency of a fetch for a case whose first fetch costs the meter's whole timeout (revision 8g, H5), read
 * from @prix/contracts: POLL_TALLY_QA_NEVER_ANSWERING_LATENCY_MS (250).
 */
export const TEST_LATENCY_MS = POLL_TALLY_QA_NEVER_ANSWERING_LATENCY_MS;

export function fakeChain(options: FakeChainOptions = {}) {
  const started = Date.now();
  const base = options.head ?? 5_000_000;
  const counts: Record<EndpointName, number> = { official: 0, publicnode: 0, drpc: 0 };
  const seen: CallSeen[] = [];
  const windowOn = { on: options.window ?? true };
  const latency = options.latencyMs ?? POLL_TALLY_FETCH_LATENCY_MS;
  const headNow = () => base + Math.floor(((Date.now() - started) / 1000) * POLL_TALLY_CHAIN_BLOCKS_PER_SECOND);

  const fetchFn: typeof fetch = async (input, init) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const endpoint = nameOf(raw);
    if (endpoint === null) return new Response('unknown endpoint', { status: 404 });
    counts[endpoint] += 1;
    const call = counts[endpoint];
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const body = JSON.parse(String(init?.body ?? '{}')) as
      | { id?: unknown; params?: unknown[] }
      | { id?: unknown; params?: unknown[] }[];
    const calls = Array.isArray(body) ? body : [body];
    const first = calls[0];
    const tagRaw = (first?.params ?? [])[1];
    const tag = typeof tagRaw === 'string' && tagRaw.startsWith('0x') ? Number(BigInt(tagRaw)) : null;
    const head = headNow();
    const record: CallSeen = { endpoint, call, tag, head, at: Date.now() - started, answered: '' };
    seen.push(record);
    const plan = options.plan?.(endpoint, call) ?? { kind: 'answer' };

    if (endpoint === 'publicnode' && windowOn.on && tag !== null && head - tag > POLL_TALLY_KEYLESS_STATE_BLOCKS) {
      await sleep(latency, signal);
      record.answered = '403';
      return new Response('state not served', { status: 403 });
    }
    if (plan.kind === 'never') {
      record.answered = 'never';
      await sleep(3_600_000, signal);
      return new Response('late', { status: 200 });
    }
    await sleep(plan.delayMs ?? latency, signal);
    if (plan.kind === 'status') {
      if (plan.stalledBody === true) {
        record.answered = `${plan.status}-stalled`;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0","error":'));
            const onAbort = () => controller.error(new DOMException('aborted', 'AbortError'));
            if (signal?.aborted) onAbort();
            else signal?.addEventListener('abort', onAbort, { once: true });
          },
        });
        return new Response(stream, { status: plan.status, headers: { 'content-type': 'application/json' } });
      }
      record.answered = String(plan.status);
      return new Response('refused', { status: plan.status });
    }
    if (plan.kind === 'noBody') {
      record.answered = 'noBody';
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0",'));
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (plan.kind === 'rpcError') {
      record.answered = 'rpcError';
      const errors = calls.map((c) => ({
        jsonrpc: '2.0',
        id: c.id,
        error: { code: -32005, message: 'limit exceeded' },
      }));
      return new Response(JSON.stringify(Array.isArray(body) ? errors : errors[0]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    const answerHead = headNow() - (plan.headBehind ?? 0);
    const answers = calls.map((c) => {
      const [tx] = (c.params ?? []) as [{ data?: string }];
      const data = String(tx?.data ?? '');
      const wallets = walletsOf(data);
      return {
        jsonrpc: '2.0',
        id: c.id,
        result: encodeTokenResult({
          blockNumber: BigInt(tag ?? answerHead),
          blockTimestamp: BigInt(Math.floor(Date.now() / 1000)),
          totalSupply: SUPPLY,
          decimals: 18,
          balances: wallets.map((w) => options.balanceOf?.(w) ?? 10n ** 23n),
        }),
      };
    });
    record.answered = 'ok';
    return new Response(JSON.stringify(Array.isArray(body) ? answers : answers[0]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  return {
    fetch: fetchFn,
    seen,
    counts,
    headNow,
    window: windowOn,
    of: (endpoint: EndpointName) => seen.filter((c) => c.endpoint === endpoint),
  };
}

/** The wallets of a Multicall3 call's balanceOf calls, in order (the selector and a 32-byte word each). */
function walletsOf(data: string): string[] {
  const out: string[] = [];
  let at = data.indexOf(BALANCE_OF);
  while (at >= 0) {
    const word = data.slice(at + BALANCE_OF.length, at + BALANCE_OF.length + 64);
    out.push(`0x${word.slice(24)}`.toLowerCase());
    at = data.indexOf(BALANCE_OF, at + BALANCE_OF.length + 64);
  }
  return out;
}

export const voterWallet = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
