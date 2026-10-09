import type { ApiError, ListingResponse, ListingsResponse, TrackRecordResponse } from '@prix/contracts';
import {
  apiErrorSchema,
  listingResponseSchema,
  listingsResponseSchema,
  trackRecordResponseSchema,
} from '@prix/contracts';

/** What the client needs of a contract schema; apps/web does not depend on zod itself. */
interface Schema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

/**
 * The typed reads of the reputation pages. Server side only (Astro frontmatter): every call is a
 * GET through the `API` service binding, and every answer is parsed with the contract's schema.
 * A call never throws; it resolves to `{ ok: true, data }` or to `{ ok: false, status, error }`.
 * Under __PRIX_FIXTURES__ the same functions answer from ./fixtures.ts, and `?fixture=` picks the state.
 *
 * A read is made once per request: the route file and the page it renders can both ask.
 */

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
    console.error('reputation_read_failed', path.split('?')[0], cause instanceof Error ? cause.name : '');
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

function read<T>(context: Context, path: string, schema: Schema<T>, fixture: string): Promise<Read<T>> {
  context.locals.apiReads ??= new Map();
  const reads = context.locals.apiReads;
  const key = `reputation:${path}`;
  const earlier = reads.get(key) as Promise<Read<T>> | undefined;
  if (earlier) return earlier;
  const answer = FIXTURES
    ? import('./fixtures.ts').then(async (module) => {
        const body = module.answer(context.url.searchParams.get('fixture'), fixture, path);
        if (body.kind === 'error') return failure(body.status, body.code, body.message);
        const parsed = schema.safeParse(body.data);
        return parsed.success ? ({ ok: true, status: 200, data: parsed.data } as Read<T>) : unusable(502);
      })
    : fetchFromApi(context, path, schema);
  reads.set(key, answer);
  return answer;
}

const segment = (value: string): string => encodeURIComponent(value);

/** GET /api/reputation/agents/:id/record */
export function fetchRecord(context: Context, agentId: string): Promise<Read<TrackRecordResponse>> {
  return read(context, `/api/reputation/agents/${segment(agentId)}/record`, trackRecordResponseSchema, 'record');
}

/** GET /api/reputation/listings */
export function fetchListings(context: Context, page: number): Promise<Read<ListingsResponse>> {
  return read(context, `/api/reputation/listings?page=${page}`, listingsResponseSchema, 'listings');
}

/** GET /api/reputation/listings/:id */
export function fetchListing(context: Context, id: string): Promise<Read<ListingResponse>> {
  return read(context, `/api/reputation/listings/${segment(id)}`, listingResponseSchema, 'listing');
}
