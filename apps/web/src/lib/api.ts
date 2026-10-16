import type {
  AgentPublic,
  AgentResponse,
  ApiError,
  ApiErrorCode,
  CreateAgentInput,
  CreateModelKeyInput,
  Division,
  HoldsResponse,
  LeagueResponse,
  MarketPricesResponse,
  MarketResponse,
  MeResponse,
  ModelKeyResponse,
  NonceResponse,
  OwnerHoldsSetting,
  PollMeResponse,
  PollsResponse,
  PollTallyOutcome,
  PollVoteBody,
  PollVoteResponse,
  ProvidersResponse,
  SeasonsResponse,
  SessionResponse,
  SetHiddenInput,
  TelegramWebhookAdminResponse,
  TelegramWebhookState,
  UpdateAgentInput,
  VerifyInput,
} from '@prix/contracts';

/**
 * The one way a page calls the API (docs/CONTRACTS.md section 4).
 *
 * On the server, pass the Astro global: `createApi(Astro).league()`. The call goes through the
 * `API` service binding and carries the visitor's session cookie. In a browser script, call
 * `createApi()`: the call is a same-origin fetch.
 *
 * Every answer is checked against the contract schema. A call never throws: it resolves to
 * `{ ok: true, data }` or to `{ ok: false, status, error }`, where `error` is the API's own
 * error object. A page chooses its sentence from `error.code` (section 8).
 *
 * When the site is built with PRIX_FIXTURES=1 the same functions answer from
 * `src/lib/fixtures/`, and `?fixture=<name>` on the page URL selects the state.
 */

/** What a server-side call needs. The Astro global and a middleware context both fit. */
export interface ApiContext {
  request: Request;
  url: URL;
  locals: App.Locals;
}

export type ApiSuccess<T> = { ok: true; status: number; data: T };
/** A failed call: the HTTP status and the API's error object, `{ error: { code, message, field } }`. */
export type ApiFailure = ApiError & { ok: false; status: number };
export type ApiResult<T> = ApiSuccess<T> | ApiFailure;

export interface LeagueQuery {
  division?: Division;
  /** A season id. Left out, the API picks the active season. */
  season?: string;
  page?: number;
}

export interface Api {
  /** GET /api/market */
  market(): Promise<ApiResult<MarketResponse>>;
  /**
   * GET /api/market/prices: every symbol of the universe at the latest round, for the price strip
   * (docs/CONTRACTS.md section 17.2). Before the first round `tickId` is null and `prices` empty.
   */
  marketPrices(): Promise<ApiResult<MarketPricesResponse>>;
  /** GET /api/seasons */
  seasons(): Promise<ApiResult<SeasonsResponse>>;
  /** GET /api/league */
  league(query?: LeagueQuery): Promise<ApiResult<LeagueResponse>>;
  /** GET /api/agents/:id. `not_found` for an unknown or hidden agent. */
  agent(id: string): Promise<ApiResult<AgentPublic>>;
  /** GET /api/providers */
  providers(): Promise<ApiResult<ProvidersResponse>>;
  /** GET /api/siwe/nonce */
  nonce(): Promise<ApiResult<NonceResponse>>;
  /** POST /api/siwe/verify. The API sets the session cookie. */
  verify(input: VerifyInput): Promise<ApiResult<SessionResponse>>;
  /** POST /api/siwe/logout */
  logout(): Promise<ApiResult<null>>;
  /** GET /api/me. `unauthorized` without a session. */
  me(): Promise<ApiResult<MeResponse>>;
  /** POST /api/agents */
  createAgent(input: CreateAgentInput): Promise<ApiResult<AgentResponse>>;
  /** PATCH /api/agents/:id */
  updateAgent(id: string, input: UpdateAgentInput): Promise<ApiResult<AgentResponse>>;
  /** POST /api/model-keys. The only call that ever carries a key. */
  createModelKey(input: CreateModelKeyInput): Promise<ApiResult<ModelKeyResponse>>;
  /** DELETE /api/model-keys/:id */
  deleteModelKey(id: string): Promise<ApiResult<null>>;
  /** POST /api/admin/agents/:id/hidden */
  setAgentHidden(id: string, input: SetHiddenInput): Promise<ApiResult<null>>;
  /** GET /api/admin/holds */
  holds(): Promise<ApiResult<HoldsResponse>>;
  /** POST /api/admin/holds/:symbol/release */
  releaseHold(symbol: string): Promise<ApiResult<null>>;

  // Phase 6.7, the holders round (docs/contracts/phase-6-holders.md). Each answers the generic 404 while its
  // route is not mounted; a page reads `status` for that (e.g. `ownerHoldsRouteOn`, the poll's status probe).
  /** GET /api/polls: public, cached 30 seconds, no per-wallet data. */
  polls(): Promise<ApiResult<PollsResponse>>;
  /** GET /api/polls/status: `{ on: true }` while POLLS_ENABLED is on, the generic 404 otherwise. */
  pollsStatus(): Promise<ApiResult<{ on: true }>>;
  /** GET /api/polls/me: a session; never on a timer (section 4.5). */
  pollsMe(): Promise<ApiResult<PollMeResponse>>;
  /** POST /api/polls/:id/vote. A refusal is `invalid_input` with a field of POLL_REFUSALS. */
  vote(pollId: string, input: PollVoteBody): Promise<ApiResult<PollVoteResponse>>;
  /** GET /api/token/me/owner-holds: the wallet's choice of the mark. 404 while the route is not mounted. */
  ownerHolds(): Promise<ApiResult<OwnerHoldsSetting>>;
  /** PUT /api/token/me/owner-holds: changes the choice and answers the stored one. */
  setOwnerHolds(input: OwnerHoldsSetting): Promise<ApiResult<OwnerHoldsSetting>>;
  /** POST /api/admin/polls/:id/tally: an admin runs a closed poll's tally; answers its outcome. */
  adminTallyPoll(pollId: string): Promise<ApiResult<PollTallyOutcome>>;
  /** POST /api/admin/telegram/webhook: prix-api sets its webhook and answers the three fields the founder pastes back. */
  adminSetTelegramWebhook(): Promise<ApiResult<TelegramWebhookAdminResponse>>;
  /** GET /api/admin/telegram/webhook: the webhook's watch. */
  adminTelegramWebhook(): Promise<ApiResult<TelegramWebhookState>>;
}

/** One request to the API, before a transport sends it. */
export interface ApiCall {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** Path and query, for example /api/league?division=open. */
  path: string;
  /** The JSON body, for a request that has one. */
  body?: unknown;
}

/** Sends one call and returns the raw response. It may throw; `createApi` catches it. */
export type Transport = (call: ApiCall) => Promise<Response>;

type SchemaName = keyof typeof import('./schemas.ts').schemas;

/**
 * Checks a body against the contract. On the server this is a real check. In a browser it is
 * not: schemas.ts, and zod with it, is left out of the script, and the body is taken as sent.
 * Returns undefined for a body that fails.
 */
async function check<T>(name: SchemaName, body: unknown): Promise<T | undefined> {
  if (!import.meta.env.SSR) return body as T;
  const { schemas } = await import('./schemas.ts');
  const parsed = schemas[name].safeParse(body);
  return parsed.success ? (parsed.data as T) : undefined;
}

/** The shape of the API's error object, for the browser, which does not run the schema. */
function looksLikeApiError(body: unknown): body is ApiError {
  if (typeof body !== 'object' || body === null || !('error' in body)) return false;
  const error = (body as { error: unknown }).error;
  return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string';
}

const UNUSABLE_MESSAGE = 'The API did not give a usable answer. Try again in a minute.';

/** The code for an error response that does not carry the API's own error object. */
function codeForStatus(status: number): ApiErrorCode {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  return 'internal';
}

/** The failure for an answer that is missing, unreadable or not what the contract says. */
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

/** A same-origin request from a browser script. The browser adds the cookie and the Origin header. */
const browserTransport: Transport = (call) => {
  const headers: Record<string, string> = { accept: 'application/json' };
  // The API rejects a request that changes state unless it says it is JSON.
  if (call.method !== 'GET') headers['content-type'] = 'application/json';
  return fetch(call.path, {
    method: call.method,
    credentials: 'same-origin',
    headers,
    body: call.body === undefined ? undefined : JSON.stringify(call.body),
  });
};

async function transportFor(context: ApiContext | undefined): Promise<Transport> {
  if (import.meta.env.SSR && !context) throw new Error('createApi() needs the Astro global on the server.');
  if (typeof __PRIX_FIXTURES__ !== 'undefined' && __PRIX_FIXTURES__) {
    const { createFixtureTransport } = await import('./fixtures/index.ts');
    return createFixtureTransport(context ? context.url : new URL(window.location.href));
  }
  if (import.meta.env.SSR && context) {
    const { createServerTransport } = await import('./api-server.ts');
    return createServerTransport(context);
  }
  return browserTransport;
}

/** Sends a call. Resolves to the response of a successful call, or to the failure. Never throws. */
async function exchange(context: ApiContext | undefined, call: ApiCall): Promise<Response | ApiFailure> {
  let response: Response;
  try {
    const transport = await transportFor(context);
    response = await transport(call);
  } catch (cause) {
    // Logged by name only: never a body, a header or a query.
    console.error('api_call_failed', call.method, call.path.split('?')[0], cause instanceof Error ? cause.name : '');
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

function leaguePath(query: LeagueQuery): string {
  const params = new URLSearchParams();
  if (query.division) params.set('division', query.division);
  if (query.season) params.set('season', query.season);
  if (query.page) params.set('page', String(query.page));
  const search = params.toString();
  return search ? `/api/league?${search}` : '/api/league';
}

/**
 * The API for one page render, or for one browser script.
 *
 * On the server a read is made once per request: a second call for the same path gets the
 * first call's answer. A route file and the page component it renders can therefore both ask
 * for the same record, and the page view still costs one API call.
 */
export function createApi(context?: ApiContext): Api {
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
    market: () => read<MarketResponse>('/api/market', 'market'),
    marketPrices: () => read<MarketPricesResponse>('/api/market/prices', 'marketPrices'),
    seasons: () => read<SeasonsResponse>('/api/seasons', 'seasons'),
    league: (query = {}) => read<LeagueResponse>(leaguePath(query), 'league'),
    agent: (id) => read<AgentPublic>(`/api/agents/${segment(id)}`, 'agent'),
    providers: () => read<ProvidersResponse>('/api/providers', 'providers'),
    // Not remembered: every nonce is new.
    nonce: () => sendForData<NonceResponse>(context, { method: 'GET', path: '/api/siwe/nonce' }, 'nonce'),
    verify: (input) => write<SessionResponse>('POST', '/api/siwe/verify', input, 'session'),
    logout: () => writeForNothing('POST', '/api/siwe/logout'),
    me: () => read<MeResponse>('/api/me', 'me'),
    createAgent: (input) => write<AgentResponse>('POST', '/api/agents', input, 'agentResponse'),
    updateAgent: (id, input) => write<AgentResponse>('PATCH', `/api/agents/${segment(id)}`, input, 'agentResponse'),
    createModelKey: (input) => write<ModelKeyResponse>('POST', '/api/model-keys', input, 'modelKey'),
    deleteModelKey: (id) => writeForNothing('DELETE', `/api/model-keys/${segment(id)}`),
    setAgentHidden: (id, input) => writeForNothing('POST', `/api/admin/agents/${segment(id)}/hidden`, input),
    holds: () => read<HoldsResponse>('/api/admin/holds', 'holds'),
    releaseHold: (symbol) => writeForNothing('POST', `/api/admin/holds/${segment(symbol)}/release`),
    polls: () => read<PollsResponse>('/api/polls', 'polls'),
    pollsStatus: () => read<{ on: true }>('/api/polls/status', 'pollStatus'),
    // Not remembered within a render: a vote changes it, and the control asks it once when it opens.
    pollsMe: () => sendForData<PollMeResponse>(context, { method: 'GET', path: '/api/polls/me' }, 'pollMe'),
    vote: (pollId, input) => write<PollVoteResponse>('POST', `/api/polls/${segment(pollId)}/vote`, input, 'pollVote'),
    ownerHolds: () =>
      sendForData<OwnerHoldsSetting>(context, { method: 'GET', path: '/api/token/me/owner-holds' }, 'ownerHolds'),
    setOwnerHolds: (input) => write<OwnerHoldsSetting>('PUT', '/api/token/me/owner-holds', input, 'ownerHolds'),
    adminTallyPoll: (pollId) =>
      write<PollTallyOutcome>('POST', `/api/admin/polls/${segment(pollId)}/tally`, undefined, 'pollTallyOutcome'),
    adminSetTelegramWebhook: () =>
      write<TelegramWebhookAdminResponse>('POST', '/api/admin/telegram/webhook', undefined, 'telegramWebhookAdmin'),
    adminTelegramWebhook: () =>
      sendForData<TelegramWebhookState>(
        context,
        { method: 'GET', path: '/api/admin/telegram/webhook' },
        'telegramWebhookState',
      ),
  };
}
