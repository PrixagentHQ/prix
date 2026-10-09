import type {
  ApiKeyPublic,
  CreateApiKeyResponse,
  DataUsage,
  ListApiKeysResponse,
  ListPaymentsResponse,
  PaymentPublic,
  PricingResponse,
  SubmitPaymentResponse,
} from '@prix/contracts';

/**
 * The browser's client for /api/data. Same origin, cookie session, JSON in and out. The browser
 * imports no zod (docs/CONTRACTS.md section 15), so each answer is checked by a small guard for
 * exactly the fields the page displays. The server decides everything; a guard only keeps a
 * malformed answer from reaching the page.
 *
 * Nothing here touches a wallet, storage, a cookie or the console.
 */

/** Every code the data API can answer, plus two the client itself reports. */
export type FailureCode =
  | 'missing_key'
  | 'invalid_key'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'invalid_input'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'api_busy'
  | 'daily_limit'
  | 'key_limit_reached'
  | 'key_create_limit_reached'
  | 'unavailable'
  | 'payment_pending'
  | 'payment_invalid'
  | 'payment_already_credited'
  | 'chain_unavailable'
  | 'internal'
  | 'offline'
  | 'bad_answer';

const CODES: ReadonlySet<string> = new Set<FailureCode>([
  'missing_key',
  'invalid_key',
  'unauthorized',
  'forbidden',
  'not_found',
  'invalid_input',
  'rate_limited',
  'quota_exceeded',
  'api_busy',
  'daily_limit',
  'key_limit_reached',
  'key_create_limit_reached',
  'unavailable',
  'payment_pending',
  'payment_invalid',
  'payment_already_credited',
  'chain_unavailable',
  'internal',
]);

export interface Failure {
  ok: false;
  status: number;
  code: FailureCode;
}
export type Result<T> = { ok: true; data: T } | Failure;

/** What a page-side call needs from a transport: a status and a parsed body. */
export interface Answer {
  status: number;
  body: unknown;
}
export type Send = (method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) => Promise<Answer>;

// --- guards ------------------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';

function isKey(v: unknown): v is ApiKeyPublic {
  return (
    isObj(v) &&
    isStr(v.id) &&
    isStr(v.prefix) &&
    isStr(v.label) &&
    isStr(v.createdAt) &&
    (v.lastUsedDay === null || isStr(v.lastUsedDay)) &&
    isBool(v.revoked)
  );
}
function isPayment(v: unknown): v is PaymentPublic {
  return isObj(v) && isStr(v.txHash) && isNum(v.amountMicro) && isNum(v.blockNumber) && isStr(v.creditedAt);
}
function isKeyList(v: unknown): v is ListApiKeysResponse {
  return isObj(v) && Array.isArray(v.keys) && v.keys.every(isKey) && isNum(v.maxActive);
}
function isCreated(v: unknown): v is CreateApiKeyResponse {
  return isObj(v) && isKey(v.key) && isStr(v.secret);
}
function isUsage(v: unknown): v is DataUsage {
  return (
    isObj(v) &&
    [v.tier, v.quotaPerDay, v.usedFree, v.usedPaid, v.remainingFree, v.creditsMicro, v.callPriceMicro].every(isNum) &&
    isBool(v.gatingOn) &&
    isBool(v.paymentsEnabled) &&
    isStr(v.resetsAt) &&
    Array.isArray(v.history) &&
    v.history.every((row) => isObj(row) && isStr(row.day) && isNum(row.free) && isNum(row.paid))
  );
}
function isPricing(v: unknown): v is PricingResponse {
  return (
    isObj(v) &&
    isBool(v.enabled) &&
    isBool(v.paymentsEnabled) &&
    isBool(v.gatingOn) &&
    [v.freeQuotaPerDay, v.callPriceMicro, v.minPaymentMicro, v.confirmations].every(isNum) &&
    (v.paymentAddress === null || isStr(v.paymentAddress)) &&
    isObj(v.token) &&
    isStr(v.token.address) &&
    isNum(v.token.chainId)
  );
}
function isPayments(v: unknown): v is ListPaymentsResponse {
  return isObj(v) && Array.isArray(v.payments) && v.payments.every(isPayment) && isNum(v.balanceMicro);
}
function isSubmitted(v: unknown): v is SubmitPaymentResponse {
  return isObj(v) && isPayment(v.payment) && isNum(v.balanceMicro) && isBool(v.alreadyCredited);
}

// --- the client --------------------------------------------------------------------------------

/** The sentence key for a status the body did not explain. */
function codeForStatus(status: number): FailureCode {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'key_limit_reached';
  if (status === 422) return 'payment_invalid';
  if (status === 429) return 'rate_limited';
  if (status === 503) return 'unavailable';
  return 'internal';
}

function failureOf(answer: Answer): Failure {
  const error = isObj(answer.body) && isObj(answer.body.error) ? answer.body.error : null;
  const code = error && isStr(error.code) && CODES.has(error.code) ? (error.code as FailureCode) : null;
  return { ok: false, status: answer.status, code: code ?? codeForStatus(answer.status) };
}

/** The envelope `{ notice, data }` of a success answer, or null. */
function dataOf(body: unknown): unknown {
  return isObj(body) && 'data' in body ? body.data : body;
}

async function sendOverHttp(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<Answer> {
  // Every state-changing call carries the JSON content type; the API refuses one without it.
  const headers: Record<string, string> = { accept: 'application/json' };
  if (method !== 'GET') headers['content-type'] = 'application/json';
  const response = await fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    cache: 'no-store',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed: unknown = await response.json().catch(() => null);
  return { status: response.status, body: parsed };
}

async function pick(): Promise<Send> {
  if (typeof __PRIX_FIXTURES__ !== 'undefined' && __PRIX_FIXTURES__) {
    const { createFixtureSend } = await import('./fixtures.ts');
    const names = (new URLSearchParams(window.location.search).get('data') ?? '').split(',');
    return createFixtureSend(names.map((name) => `data-${name.trim()}`).join(','));
  }
  return sendOverHttp;
}

export interface DataClient {
  keys(): Promise<Result<ListApiKeysResponse>>;
  createKey(label: string): Promise<Result<CreateApiKeyResponse>>;
  revokeKey(id: string): Promise<Result<null>>;
  usage(): Promise<Result<DataUsage>>;
  pricing(): Promise<Result<PricingResponse>>;
  payments(): Promise<Result<ListPaymentsResponse>>;
  submitPayment(txHash: string): Promise<Result<SubmitPaymentResponse>>;
}

export function createDataClient(): DataClient {
  let sender: Promise<Send> | null = null;
  async function call<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    guard: (v: unknown) => v is T,
    body?: unknown,
  ): Promise<Result<T>> {
    try {
      sender ??= pick();
      const answer = await (await sender)(method, path, body);
      if (answer.status < 200 || answer.status >= 300) return failureOf(answer);
      const data = dataOf(answer.body);
      return guard(data) ? { ok: true, data } : { ok: false, status: answer.status, code: 'bad_answer' };
    } catch {
      return { ok: false, status: 0, code: 'offline' };
    }
  }
  return {
    keys: () => call('GET', '/api/data/keys', isKeyList),
    createKey: (label) => call('POST', '/api/data/keys', isCreated, { label }),
    async revokeKey(id) {
      try {
        sender ??= pick();
        const answer = await (await sender)('DELETE', `/api/data/keys/${encodeURIComponent(id)}`);
        return answer.status === 204 || answer.status === 200 ? { ok: true, data: null } : failureOf(answer);
      } catch {
        return { ok: false, status: 0, code: 'offline' };
      }
    },
    usage: () => call('GET', '/api/data/usage', isUsage),
    pricing: () => call('GET', '/api/data/pricing', isPricing),
    payments: () => call('GET', '/api/data/payments', isPayments),
    submitPayment: (txHash) => call('POST', '/api/data/payments', isSubmitted, { txHash }),
  };
}
