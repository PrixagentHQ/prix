import type {
  AgentFeedResponse,
  ApiError,
  ApiErrorCode,
  FollowingFeedResponse,
  FollowResponse,
  FollowsResponse,
  LeagueFeedResponse,
  NotificationsResponse,
  PutFollowInput,
  SeasonResultsResponse,
  SetTelegramInput,
  TelegramLinkResponse,
} from '@prix/contracts';
import type { ApiContext, ApiFailure, ApiResult } from './api.ts';
import type { FollowCall as ApiCall, FollowTransport as Transport } from './follow-fixtures.ts';

/**
 * The follow client (docs/contracts/phase-3-follow.md section 5), the sibling of `createApi` in
 * api.ts and built the same way: on the server pass the Astro global, in a browser call it with
 * no argument. Every call resolves to `{ ok, status, data }` or `{ ok: false, status, error }` and
 * never throws. Under `__PRIX_FIXTURES__` it answers from follow-fixtures.ts and `?fixture=`
 * selects the state.
 *
 * The server entry checks every answer against the contract schemas. The browser entry does not
 * import zod: the schemas are loaded by a dynamic import behind `import.meta.env.SSR`, which the
 * build drops from every browser script.
 */

export interface FeedQueryArgs {
  cursor?: string;
  limit?: number;
}

export interface FollowApi {
  follows(): Promise<ApiResult<FollowsResponse>>;
  putFollow(agentId: string, input: PutFollowInput): Promise<ApiResult<FollowResponse>>;
  deleteFollow(agentId: string): Promise<ApiResult<null>>;
  agentFeed(agentId: string, query?: FeedQueryArgs): Promise<ApiResult<AgentFeedResponse>>;
  feed(query?: FeedQueryArgs): Promise<ApiResult<FollowingFeedResponse>>;
  /**
   * GET /api/feed/league: the newest decisions of every visible agent, both divisions together.
   * It needs no session and is the same for everyone: it is always cut by the delay of a visitor
   * who is not signed in, and `delay` in the answer says which. Every item says `house`.
   */
  leagueFeed(query?: FeedQueryArgs): Promise<ApiResult<LeagueFeedResponse>>;
  notifications(): Promise<ApiResult<NotificationsResponse>>;
  telegramLink(): Promise<ApiResult<TelegramLinkResponse>>;
  setTelegram(input: SetTelegramInput): Promise<ApiResult<NotificationsResponse>>;
  unlinkTelegram(): Promise<ApiResult<null>>;
  seasonResults(number: number): Promise<ApiResult<SeasonResultsResponse>>;
}

type SchemaName =
  | 'follows'
  | 'follow'
  | 'agentFeed'
  | 'feed'
  | 'leagueFeed'
  | 'notifications'
  | 'telegramLink'
  | 'seasonResults'
  | 'apiError';

/** Server only. Returns undefined for a body that fails the contract. */
async function check<T>(name: SchemaName, body: unknown): Promise<T | undefined> {
  if (!import.meta.env.SSR) return body as T;
  const contracts = await import('@prix/contracts');
  const schemas = {
    follows: contracts.followsResponseSchema,
    follow: contracts.followResponseSchema,
    agentFeed: contracts.agentFeedResponseSchema,
    feed: contracts.followingFeedResponseSchema,
    leagueFeed: contracts.leagueFeedResponseSchema,
    notifications: contracts.notificationsResponseSchema,
    telegramLink: contracts.telegramLinkResponseSchema,
    seasonResults: contracts.seasonResultsResponseSchema,
    apiError: contracts.apiErrorSchema,
  };
  const parsed = schemas[name].safeParse(body);
  return parsed.success ? (parsed.data as T) : undefined;
}

function looksLikeApiError(body: unknown): body is ApiError {
  if (typeof body !== 'object' || body === null || !('error' in body)) return false;
  const error = (body as { error: unknown }).error;
  return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string';
}

const UNUSABLE_MESSAGE = 'The API did not give a usable answer. Try again in a minute.';

function codeForStatus(status: number): ApiErrorCode {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  return 'internal';
}

function unusable(status: number): ApiFailure {
  const failed = status >= 400 ? status : 502;
  return { ok: false, status: failed, error: { code: codeForStatus(failed), message: UNUSABLE_MESSAGE, field: null } };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

const browserTransport: Transport = (call) => {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (call.method !== 'GET') headers['content-type'] = 'application/json';
  return fetch(call.path, {
    method: call.method,
    credentials: 'same-origin',
    headers,
    body: call.body === undefined ? undefined : JSON.stringify(call.body),
  });
};

async function transportFor(context: ApiContext | undefined): Promise<Transport> {
  if (import.meta.env.SSR && !context) throw new Error('createFollowApi() needs the Astro global on the server.');
  if (typeof __PRIX_FIXTURES__ !== 'undefined' && __PRIX_FIXTURES__) {
    const { createFollowFixtureTransport } = await import('./follow-fixtures.ts');
    return createFollowFixtureTransport(context ? context.url : new URL(window.location.href));
  }
  if (import.meta.env.SSR && context) {
    const { createServerTransport } = await import('./api-server.ts');
    // The server transport passes `call.method` through as it is, so it carries PUT too.
    return createServerTransport(context) as Transport;
  }
  return browserTransport;
}

async function exchange(context: ApiContext | undefined, call: ApiCall): Promise<Response | ApiFailure> {
  let response: Response;
  try {
    const transport = await transportFor(context);
    response = await transport(call);
  } catch (cause) {
    // Logged by name only: never a body, a header or a query.
    console.error('follow_call_failed', call.method, call.path.split('?')[0], cause instanceof Error ? cause.name : '');
    return unusable(502);
  }
  if (response.ok) return response;
  const body = await readJson(response);
  const error = import.meta.env.SSR
    ? await check<ApiError>('apiError', body)
    : looksLikeApiError(body)
      ? body
      : undefined;
  return error ? { ok: false, status: response.status, error: error.error } : unusable(response.status);
}

async function sendForData<T>(
  context: ApiContext | undefined,
  call: ApiCall,
  schema: SchemaName,
): Promise<ApiResult<T>> {
  const answer = await exchange(context, call);
  if (!(answer instanceof Response)) return answer;
  const data = await check<T>(schema, await readJson(answer));
  return data !== undefined ? { ok: true, status: answer.status, data } : unusable(502);
}

async function sendForNothing(context: ApiContext | undefined, call: ApiCall): Promise<ApiResult<null>> {
  const answer = await exchange(context, call);
  return answer instanceof Response ? { ok: true, status: answer.status, data: null } : answer;
}

const segment = (value: string): string => encodeURIComponent(value);

function withQuery(path: string, query: FeedQueryArgs | undefined): string {
  const params = new URLSearchParams();
  if (query?.cursor) params.set('cursor', query.cursor);
  if (query?.limit) params.set('limit', String(query.limit));
  const search = params.toString();
  return search ? `${path}?${search}` : path;
}

/** The follow API for one page render, or for one browser script. A server read is made once per request. */
export function createFollowApi(context?: ApiContext): FollowApi {
  function read<T>(path: string, schema: SchemaName): Promise<ApiResult<T>> {
    if (!context) return sendForData<T>(context, { method: 'GET', path }, schema);
    context.locals.apiReads ??= new Map();
    const reads = context.locals.apiReads;
    const earlier = reads.get(path) as Promise<ApiResult<T>> | undefined;
    if (earlier) return earlier;
    const answer = sendForData<T>(context, { method: 'GET', path }, schema);
    reads.set(path, answer);
    return answer;
  }

  /** A write can change what a read returns, so the reads made so far are forgotten. */
  function forgetReads(): void {
    context?.locals.apiReads?.clear();
  }

  function write<T>(method: ApiCall['method'], path: string, body: unknown, schema: SchemaName): Promise<ApiResult<T>> {
    forgetReads();
    return sendForData<T>(context, { method, path, body }, schema);
  }

  function writeForNothing(method: ApiCall['method'], path: string, body?: unknown): Promise<ApiResult<null>> {
    forgetReads();
    return sendForNothing(context, { method, path, body });
  }

  return {
    follows: () => read<FollowsResponse>('/api/follows', 'follows'),
    putFollow: (agentId, input) => write<FollowResponse>('PUT', `/api/follows/${segment(agentId)}`, input, 'follow'),
    deleteFollow: (agentId) => writeForNothing('DELETE', `/api/follows/${segment(agentId)}`),
    agentFeed: (agentId, query) =>
      read<AgentFeedResponse>(withQuery(`/api/agents/${segment(agentId)}/feed`, query), 'agentFeed'),
    feed: (query) => read<FollowingFeedResponse>(withQuery('/api/feed', query), 'feed'),
    leagueFeed: (query) => read<LeagueFeedResponse>(withQuery('/api/feed/league', query), 'leagueFeed'),
    notifications: () => read<NotificationsResponse>('/api/notifications', 'notifications'),
    telegramLink: () =>
      write<TelegramLinkResponse>('POST', '/api/notifications/telegram/link', undefined, 'telegramLink'),
    setTelegram: (input) =>
      write<NotificationsResponse>('PATCH', '/api/notifications/telegram', input, 'notifications'),
    unlinkTelegram: () => writeForNothing('DELETE', '/api/notifications/telegram'),
    seasonResults: (number) =>
      read<SeasonResultsResponse>(`/api/seasons/${segment(String(number))}/results`, 'seasonResults'),
  };
}
