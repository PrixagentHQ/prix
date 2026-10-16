import type {
  ApiError,
  ApiErrorCode,
  PollTallyOutcome,
  TelegramWebhookAdminResponse,
  TelegramWebhookState,
} from '@prix/contracts';
import type { ApiContext, ApiFailure, ApiResult } from '../../../lib/api.ts';

/**
 * The client of /admin/holders (docs/contracts/phase-6-holders.md sections 4.4 and 7). It calls
 * POST /api/admin/telegram/webhook (no body), GET /api/admin/telegram/webhook and
 * POST /api/admin/polls/:id/tally, and nothing else. The API checks the administrator again on every call and
 * answers the generic 404 to anyone else. Neither secret is ever in an answer; the page shows the three fields
 * the API answers and nothing more. A browser script does not import zod (docs/CONTRACTS.md section 15): on
 * the server the answer is checked against the contract's schema, in a browser for the shape the page reads.
 * Under `__PRIX_FIXTURES__` it answers from fixtures.ts, and `?holdersfixture=` selects the state.
 */

export interface AdminCall {
  method: 'GET' | 'POST';
  path: string;
}
export type AdminTransport = (call: AdminCall) => Promise<Response>;

type SchemaName = 'webhook' | 'watch' | 'tally';

const STEPS = ['results', 'list', 'read', 'block', 'write'];
const OUTCOMES = ['done', 'already', 'waiting', 'open', 'failed'];

/** The browser's guard: enough to know the answer has the shape the page reads. */
export function looksRight(name: SchemaName, body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const record = body as Record<string, unknown>;
  if (name === 'webhook') {
    return (
      typeof record.url === 'string' &&
      typeof record.pendingUpdateCount === 'number' &&
      Number.isInteger(record.pendingUpdateCount) &&
      record.pendingUpdateCount >= 0 &&
      (record.lastErrorMessage === null || typeof record.lastErrorMessage === 'string')
    );
  }
  if (name === 'watch') {
    return typeof record.moved === 'boolean' && (record.movedAt === null || typeof record.movedAt === 'string');
  }
  return (
    typeof record.outcome === 'string' &&
    OUTCOMES.includes(record.outcome) &&
    (record.step === null || (typeof record.step === 'string' && STEPS.includes(record.step)))
  );
}

async function check<T>(name: SchemaName, body: unknown): Promise<T | undefined> {
  if (!import.meta.env.SSR) return looksRight(name, body) ? (body as T) : undefined;
  const contracts = await import('@prix/contracts');
  const schemas = {
    webhook: contracts.telegramWebhookAdminResponseSchema,
    watch: contracts.telegramWebhookStateSchema,
    tally: contracts.pollTallyOutcomeSchema,
  };
  const parsed = schemas[name].safeParse(body);
  return parsed.success ? (parsed.data as T) : undefined;
}

const UNUSABLE = 'The API did not give a usable answer. Try again in a minute.';

function codeForStatus(status: number): ApiErrorCode {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  return 'internal';
}

function unusable(status: number): ApiFailure {
  const failed = status >= 400 ? status : 502;
  return { ok: false, status: failed, error: { code: codeForStatus(failed), message: UNUSABLE, field: null } };
}

function looksLikeApiError(body: unknown): body is ApiError {
  if (typeof body !== 'object' || body === null || !('error' in body)) return false;
  const error = (body as { error: unknown }).error;
  return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string';
}

const browserTransport: AdminTransport = (call) =>
  fetch(call.path, {
    method: call.method,
    credentials: 'same-origin',
    // The API refuses a request that changes state unless it says it is JSON. The body is empty.
    headers:
      call.method === 'GET'
        ? { accept: 'application/json' }
        : { accept: 'application/json', 'content-type': 'application/json' },
  });

async function transportFor(context: ApiContext | undefined): Promise<AdminTransport> {
  if (import.meta.env.SSR && !context)
    throw new Error('The holders admin client needs the Astro global on the server.');
  if (typeof __PRIX_FIXTURES__ !== 'undefined' && __PRIX_FIXTURES__) {
    const { createHoldersAdminFixtureTransport } = await import('./fixtures.ts');
    return createHoldersAdminFixtureTransport(context ? context.url : new URL(window.location.href));
  }
  if (import.meta.env.SSR && context) {
    const { createServerTransport } = await import('../../../lib/api-server.ts');
    return createServerTransport(context);
  }
  return browserTransport;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/** Sends one call. Never throws. `send` is for tests. */
export async function exchange<T>(
  call: AdminCall,
  schema: SchemaName,
  context?: ApiContext,
  send?: AdminTransport,
): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await (send ?? (await transportFor(context)))(call);
  } catch (cause) {
    // Logged by name only: never a body, a header or a query.
    console.error('holders_admin_call_failed', call.method, call.path, cause instanceof Error ? cause.name : '');
    return unusable(502);
  }
  const body = await readJson(response);
  if (!response.ok) {
    return looksLikeApiError(body)
      ? { ok: false, status: response.status, error: body.error }
      : unusable(response.status);
  }
  const data = await check<T>(schema, body);
  return data !== undefined ? { ok: true, status: response.status, data } : unusable(502);
}

/** POST /api/admin/telegram/webhook: prix-api sets the webhook with its own secrets and answers three fields. */
export function setTelegramWebhook(send?: AdminTransport): Promise<ApiResult<TelegramWebhookAdminResponse>> {
  return exchange({ method: 'POST', path: '/api/admin/telegram/webhook' }, 'webhook', undefined, send);
}

/** GET /api/admin/telegram/webhook: whether the hourly watch saw the webhook moved. */
export function fetchWebhookWatch(
  context?: ApiContext,
  send?: AdminTransport,
): Promise<ApiResult<TelegramWebhookState>> {
  return exchange({ method: 'GET', path: '/api/admin/telegram/webhook' }, 'watch', context, send);
}

/** POST /api/admin/polls/:id/tally: the job's own tally of one closed poll. */
export function runPollTally(pollId: string, send?: AdminTransport): Promise<ApiResult<PollTallyOutcome>> {
  return exchange(
    { method: 'POST', path: `/api/admin/polls/${encodeURIComponent(pollId)}/tally` },
    'tally',
    undefined,
    send,
  );
}
