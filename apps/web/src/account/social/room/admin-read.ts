import type { ApiError, RoomAdminWithPicturesResponse, RoomPicturesAdminResponse } from '@prix/contracts';
import {
  apiErrorSchema,
  ROOM_PICTURES_ADMIN_PATH,
  roomAdminWithPicturesResponseSchema,
  roomIdParamSchema,
  roomPicturesAdminResponseSchema,
} from '@prix/contracts';
import type { ApiContext } from '../../../lib/api.ts';

/**
 * The admins' two reads of the Community chat: `GET /api/social/admin/room?before=<id>`
 * (docs/contracts/phase-6-room.md section 7), every stored message, from Phase 6.4 on each with its
 * picture; and `GET /api/social/admin/room/pictures` (docs/contracts/phase-6-pictures.md section 10),
 * whether pictures are off and the pictures that wait for a decision. Server side only (Astro
 * frontmatter): a call goes through the `API` service binding with the visitor's own cookie, and the
 * answer is parsed with the contract's schema. The API checks the admin itself and answers the generic
 * 404 to anyone else, so these reads give a wallet nothing the API would not.
 *
 * Neither throws: each resolves to `{ ok: true, data }` or to `{ ok: false, status, error }` with the
 * API's own status. Under __PRIX_FIXTURES__ they answer from ./fixtures.ts.
 *
 * The schema of the list knows a picture and asks for none: an API older than pictures answers messages
 * without the field, and that answer is read as before. Such an API has no read of the reported
 * pictures either; its 404 is the sign that the page shows nothing of pictures.
 */

type Read<T> = { ok: true; status: number; data: T } | { ok: false; status: number; error: ApiError['error'] };
export type AdminRead = Read<RoomAdminWithPicturesResponse>;
export type AdminPicturesRead = Read<RoomPicturesAdminResponse>;

const FIXTURES = typeof __PRIX_FIXTURES__ !== 'undefined' && __PRIX_FIXTURES__;
const UNUSABLE = 'The API did not give a usable answer. Try again in a minute.';
const PATH = '/api/social/admin/room';

function unusable(status: number): { ok: false; status: number; error: ApiError['error'] } {
  const failed = status >= 400 ? status : 502;
  const code = failed === 404 ? 'not_found' : failed === 429 ? 'rate_limited' : 'internal';
  return { ok: false, status: failed, error: { code, message: UNUSABLE, field: null } };
}

/** The `before` of the page's address: a message's id as the contract writes one, else null (the newest). */
export function beforeOf(url: URL): number | null {
  const parsed = roomIdParamSchema.safeParse(url.searchParams.get('before'));
  return parsed.success ? Number(parsed.data) : null;
}

/** One GET of the API with the visitor's cookie, read as `parse` reads it. `name` is what a failure is logged as. */
async function read<T>(
  context: ApiContext,
  path: string,
  name: string,
  parse: (body: unknown) => { success: true; data: T } | { success: false },
): Promise<Read<T>> {
  let response: Response;
  try {
    const { createServerTransport } = await import('../../../lib/api-server.ts');
    response = await createServerTransport(context)({ method: 'GET', path });
  } catch (cause) {
    // Logged by path only: never a query, a body or a header.
    console.error(name, path.split('?')[0], cause instanceof Error ? cause.name : '');
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
  const parsed = parse(body);
  return parsed.success ? { ok: true, status: response.status, data: parsed.data } : unusable(502);
}

export async function fetchAdminRoom(context: ApiContext, before: number | null): Promise<AdminRead> {
  if (FIXTURES) {
    const { roomAdminFixture } = await import('./fixtures.ts');
    const sample = roomAdminFixture(context.url.searchParams.get('fixture'), before);
    if (sample.kind === 'error') return unusable(sample.status);
    const parsed = roomAdminWithPicturesResponseSchema.safeParse(sample.data);
    return parsed.success ? { ok: true, status: 200, data: parsed.data } : unusable(502);
  }
  const path = before === null ? PATH : `${PATH}?before=${before}`;
  return read(context, path, 'room_admin_read_failed', (body) => roomAdminWithPicturesResponseSchema.safeParse(body));
}

/** The pictures that wait for a decision, and whether pictures are off. Never cached by the API. */
export async function fetchAdminPictures(context: ApiContext): Promise<AdminPicturesRead> {
  if (FIXTURES) {
    const { roomPicturesAdminFixture } = await import('./fixtures.ts');
    const sample = roomPicturesAdminFixture(context.url.searchParams.get('fixture'));
    if (sample.kind === 'error') return unusable(sample.status);
    const parsed = roomPicturesAdminResponseSchema.safeParse(sample.data);
    return parsed.success ? { ok: true, status: 200, data: parsed.data } : unusable(502);
  }
  return read(context, ROOM_PICTURES_ADMIN_PATH, 'room_admin_pictures_read_failed', (body) =>
    roomPicturesAdminResponseSchema.safeParse(body),
  );
}
