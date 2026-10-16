import type {
  AgentSocialResponse,
  ApiError,
  Division,
  FamilyResponse,
  ForkSourceResponse,
  ManagerDetailResponse,
  ManagerListResponse,
  MyManagersResponse,
  RivalriesResponse,
  RivalryDetailResponse,
  SocialStatusResponse,
  WarDetailResponse,
  WarListResponse,
  WarModel,
} from '@prix/contracts';
import {
  agentSocialResponseSchema,
  apiErrorSchema,
  familyResponseSchema,
  forkSourceResponseSchema,
  managerDetailResponseSchema,
  managerListResponseSchema,
  myManagersResponseSchema,
  rivalriesResponseSchema,
  rivalryDetailResponseSchema,
  socialStatusResponseSchema,
  WAR_MODELS,
  warDetailResponseSchema,
  warListResponseSchema,
} from '@prix/contracts';

/**
 * The typed reads of Phase 6 (docs/contracts/phase-6-social.md section 6). Server side only
 * (Astro frontmatter): every call is a GET through the `API` service binding, and every answer is
 * parsed with the contract's schema. A call never throws; it resolves to `{ ok: true, data }` or to
 * `{ ok: false, status, error }`, with the API's own status, so a route file can send the API's 404
 * as its own. Under __PRIX_FIXTURES__ the same functions answer from ./fixtures.ts, and
 * `?fixture=social-<state>` picks the state (fixtures.ts lists them). The two reads of the Community
 * chat and the probe of its switch are in ./room/client.ts.
 *
 * While the switch SOCIAL_ENABLED is off, every public route answers 404: the pages then answer
 * 404 and AgentSocial renders nothing. A read is made once per request: the route file and the
 * page it renders can both ask. The signed-in screens read through this file too; their writes,
 * sent from a browser script, are in ./writes.ts.
 */

/** What the client needs of a contract schema; apps/web does not depend on zod itself. */
interface Schema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

export interface Context {
  request: Request;
  url: URL;
  locals: App.Locals;
}

export type Read<T> = { ok: true; status: number; data: T } | { ok: false; status: number; error: ApiError['error'] };

const FIXTURES = typeof __PRIX_FIXTURES__ !== 'undefined' && __PRIX_FIXTURES__;
const UNUSABLE = 'The API did not give a usable answer. Try again in a minute.';

function failure(status: number, code: ApiError['error']['code'], message: string): Read<never> {
  return { ok: false, status, error: { code, message, field: null } };
}

function unusable(status: number): Read<never> {
  const failed = status >= 400 ? status : 502;
  const code = failed === 404 ? 'not_found' : failed === 429 ? 'rate_limited' : 'internal';
  return failure(failed, code, UNUSABLE);
}

async function fetchFromApi<T>(context: Context, path: string, schema: Schema<T>): Promise<Read<T>> {
  let response: Response;
  try {
    const { createServerTransport } = await import('../../lib/api-server.ts');
    response = await createServerTransport(context)({ method: 'GET', path });
  } catch (cause) {
    // Logged by path only: never a query, a body or a header.
    console.error('social_read_failed', path.split('?')[0], cause instanceof Error ? cause.name : '');
    return unusable(502);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return unusable(response.status);
  }
  if (!response.ok) {
    const error = apiErrorSchema.safeParse(body);
    return error.success ? { ok: false, status: response.status, error: error.data.error } : unusable(response.status);
  }
  const parsed = schema.safeParse(body);
  return parsed.success ? { ok: true, status: response.status, data: parsed.data } : unusable(502);
}

/**
 * One GET of a Phase 6 path, made once per request and parsed with `schema`. Exported for the reads
 * that live in a folder of their own (./room/client.ts); every read of this file goes through it.
 */
export function socialRead<T>(context: Context, path: string, schema: Schema<T>): Promise<Read<T>> {
  return read(context, path, schema);
}

function read<T>(context: Context, path: string, schema: Schema<T>): Promise<Read<T>> {
  context.locals.apiReads ??= new Map();
  const reads = context.locals.apiReads;
  const key = `social:${path}`;
  const earlier = reads.get(key) as Promise<Read<T>> | undefined;
  if (earlier) return earlier;
  const answer = FIXTURES
    ? import('./fixtures.ts').then((module) => {
        const body = module.socialAnswer(context.url.searchParams.get('fixture'), path);
        if (body.kind === 'error') return failure(body.status, body.code, body.message);
        const parsed = schema.safeParse(body.data);
        return parsed.success ? ({ ok: true, status: 200, data: parsed.data } as Read<T>) : unusable(502);
      })
    : fetchFromApi(context, path, schema);
  reads.set(key, answer);
  return answer;
}

const segment = (value: string): string => encodeURIComponent(value);

function withPage(path: string, page: number, extra: Record<string, string> = {}): string {
  const query = new URLSearchParams(extra);
  if (page > 1) query.set('page', String(page));
  const search = query.toString();
  return search ? `${path}?${search}` : path;
}

/** The page number of an address: a whole number from 1 to 100, else 1. */
export function pageOf(url: URL): number {
  const raw = url.searchParams.get('page');
  if (raw === null || !/^\d{1,3}$/.test(raw)) return 1;
  const page = Number(raw);
  return page >= 1 && page <= 100 ? page : 1;
}

/** GET /api/social/status: 200 while the switch is on, 404 while it is off. */
export function fetchSocialStatus(context: Context): Promise<Read<SocialStatusResponse>> {
  return read(context, '/api/social/status', socialStatusResponseSchema);
}

export type SocialSwitch = 'on' | 'off' | 'failed';

/** How long an isolate keeps the answer of the probe (docs/contracts/phase-6-social.md section 4). */
const PROBE_KEEP_MS = 60_000;
/** A probe that failed is asked again sooner, so a short outage does not hide Phase 6 for a minute. */
const PROBE_FAILED_KEEP_MS = 10_000;

/**
 * The probe of the switch: whether Phase 6 is on, kept 60 seconds in isolate memory, so that a page
 * that only shows Phase 6 when it is on (the agent page, the layout's links) costs no API call
 * while it is off. A route file of a Phase 6 page asks it first and answers 404 for 'off'. In
 * fixtures it follows `?fixture=social-off` and `social-error` and keeps nothing.
 */
/** What a status read says of its switch: on, off for the route's 404, and failed for anything else. */
export function switchOf(result: Read<unknown>): SocialSwitch {
  return result.ok ? 'on' : result.status === 404 ? 'off' : 'failed';
}

export async function socialIsOn(context: Context): Promise<SocialSwitch> {
  const answer = switchOf;
  if (FIXTURES) return answer(await fetchSocialStatus(context));
  const memory = globalThis as { __prixSocialOn?: { at: number; value: SocialSwitch } };
  const now = Date.now();
  const kept = memory.__prixSocialOn;
  if (kept && now - kept.at < (kept.value === 'failed' ? PROBE_FAILED_KEEP_MS : PROBE_KEEP_MS)) return kept.value;
  const value = answer(await fetchSocialStatus(context));
  memory.__prixSocialOn = { at: now, value };
  return value;
}

/**
 * The models an administrator can choose for a model war: the entries of the contract's allowlist
 * whose check is recorded. The server refuses any other. In fixtures, `?fixture=social-probed`
 * stands three models in as checked, so that the form can be seen.
 */
export async function chooseableModels(url: URL): Promise<WarModel[]> {
  if (FIXTURES) {
    const { fixtureModels } = await import('./fixtures.ts');
    return fixtureModels(url.searchParams.get('fixture'));
  }
  return WAR_MODELS.filter((model) => model.probe !== null);
}

/** GET /api/social/agents/:id: the strategy profile, the lineage and the active rivalries of one agent. */
export function fetchAgentSocial(context: Context, agentId: string): Promise<Read<AgentSocialResponse>> {
  return read(context, `/api/social/agents/${segment(agentId)}`, agentSocialResponseSchema);
}

/** GET /api/social/agents/:id/fork-source: what the fork builder may start from. */
export function fetchForkSource(context: Context, agentId: string): Promise<Read<ForkSourceResponse>> {
  return read(context, `/api/social/agents/${segment(agentId)}/fork-source`, forkSourceResponseSchema);
}

/** GET /api/social/families/:rootId */
export function fetchFamily(context: Context, rootId: string, page = 1): Promise<Read<FamilyResponse>> {
  return read(context, withPage(`/api/social/families/${segment(rootId)}`, page), familyResponseSchema);
}

/** GET /api/social/rivalries?division&page */
export function fetchRivalries(context: Context, division: Division, page = 1): Promise<Read<RivalriesResponse>> {
  return read(context, withPage('/api/social/rivalries', page, { division }), rivalriesResponseSchema);
}

/** GET /api/social/rivalries/:id */
export function fetchRivalry(context: Context, id: string): Promise<Read<RivalryDetailResponse>> {
  return read(context, `/api/social/rivalries/${segment(id)}`, rivalryDetailResponseSchema);
}

/** GET /api/social/wars?page */
export function fetchWars(context: Context, page = 1): Promise<Read<WarListResponse>> {
  return read(context, withPage('/api/social/wars', page), warListResponseSchema);
}

/** GET /api/social/wars/:id */
export function fetchWar(context: Context, id: string): Promise<Read<WarDetailResponse>> {
  return read(context, `/api/social/wars/${segment(id)}`, warDetailResponseSchema);
}

/** GET /api/social/managers?page */
export function fetchManagers(context: Context, page = 1): Promise<Read<ManagerListResponse>> {
  return read(context, withPage('/api/social/managers', page), managerListResponseSchema);
}

/** GET /api/social/managers/:id */
export function fetchManager(context: Context, id: string): Promise<Read<ManagerDetailResponse>> {
  return read(context, `/api/social/managers/${segment(id)}`, managerDetailResponseSchema);
}

/** GET /api/social/me/managers: signed in only; the visitor's cookie travels with the call. */
export function fetchMyManagers(context: Context): Promise<Read<MyManagersResponse>> {
  return read(context, '/api/social/me/managers', myManagersResponseSchema);
}

/**
 * The status a page is sent with: the API's own. 200 when the read worked, the API's status
 * (404, 429, 500, 503) when it did not, so an error page is never sent as 200.
 */
export function statusOf(result: Read<unknown>): number {
  return result.ok ? 200 : result.status >= 400 ? result.status : 500;
}
