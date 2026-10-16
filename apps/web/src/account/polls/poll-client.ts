import type { ApiError, ApiErrorCode, PollMeResponse, PollVoteResponse } from '@prix/contracts';
import type { ApiFailure, ApiResult } from '../../lib/api.ts';

/**
 * The client of the holders' poll's vote control (docs/contracts/phase-6-holders.md section 4.5). It calls
 * GET /api/polls/me and POST /api/polls/:id/vote and nothing else, and asks the wallet for nothing. It runs in
 * the browser only: the control asks the server once when it opens, never on a timer. A browser script does
 * not import zod (docs/CONTRACTS.md section 15), so an answer is checked for the shape the control reads and
 * no more; the server decides every vote. Under `__PRIX_FIXTURES__` it answers from fixtures.ts, and
 * `?pollfixture=` selects the state.
 */

export interface PollCall {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
}
export type PollTransport = (call: PollCall) => Promise<Response>;

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

const OPTION = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** GET /api/polls/me as the control reads it. */
export function looksLikeMe(body: unknown): body is PollMeResponse {
  if (typeof body !== 'object' || body === null) return false;
  const record = body as Record<string, unknown>;
  const pollId = record.pollId;
  const option = record.option;
  const refusal = record.refusal;
  return (
    (pollId === null || (typeof pollId === 'string' && OPTION.test(pollId))) &&
    (option === null || (typeof option === 'string' && OPTION.test(option))) &&
    typeof record.canVote === 'boolean' &&
    (refusal === null || refusal === 'poll_gate_off' || refusal === 'poll_not_holder')
  );
}

/** The 200 of a vote as the control reads it. */
export function looksLikeVote(body: unknown): body is PollVoteResponse {
  if (typeof body !== 'object' || body === null) return false;
  const record = body as Record<string, unknown>;
  return (
    typeof record.pollId === 'string' &&
    OPTION.test(record.pollId) &&
    typeof record.option === 'string' &&
    OPTION.test(record.option)
  );
}

function looksLikeApiError(body: unknown): body is ApiError {
  if (typeof body !== 'object' || body === null || !('error' in body)) return false;
  const error = (body as { error: unknown }).error;
  return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string';
}

const browserTransport: PollTransport = (call) => {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (call.method !== 'GET') headers['content-type'] = 'application/json';
  return fetch(call.path, {
    method: call.method,
    credentials: 'same-origin',
    headers,
    body: call.body === undefined ? undefined : JSON.stringify(call.body),
  });
};

async function transport(): Promise<PollTransport> {
  if (typeof __PRIX_FIXTURES__ !== 'undefined' && __PRIX_FIXTURES__) {
    const { createPollFixtureTransport } = await import('./fixtures.ts');
    return createPollFixtureTransport(new URL(window.location.href));
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

/** Sends one call through `send` (the browser's fetch unless a test gives one). Never throws. */
export async function exchange<T>(
  call: PollCall,
  looksRight: (body: unknown) => body is T,
  send?: PollTransport,
): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await (send ?? (await transport()))(call);
  } catch (cause) {
    // Logged by name only: never a body, a header or a query.
    console.error('poll_call_failed', call.method, call.path.split('?')[0], cause instanceof Error ? cause.name : '');
    return unusable(502);
  }
  const body = await readJson(response);
  if (!response.ok) {
    return looksLikeApiError(body)
      ? { ok: false, status: response.status, error: body.error }
      : unusable(response.status);
  }
  return looksRight(body) ? { ok: true, status: response.status, data: body } : unusable(502);
}

/** GET /api/polls/me: the signed-in wallet's choice in the open poll and whether a vote would pass. */
export function fetchPollMe(send?: PollTransport): Promise<ApiResult<PollMeResponse>> {
  return exchange({ method: 'GET', path: '/api/polls/me' }, looksLikeMe, send);
}

/** POST /api/polls/:id/vote. The server decides; the control shows what it answered. */
export function castVote(pollId: string, option: string, send?: PollTransport): Promise<ApiResult<PollVoteResponse>> {
  return exchange(
    { method: 'POST', path: `/api/polls/${encodeURIComponent(pollId)}/vote`, body: { option } },
    looksLikeVote,
    send,
  );
}
