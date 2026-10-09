import type {
  ApiError,
  ApiErrorCode,
  CreateManagerInput,
  CreateWarInput,
  LinkForkResponse,
  ManagerDetailResponse,
  PatchManagerInput,
  WarDetailResponse,
} from '@prix/contracts';

/**
 * The writes of Phase 6, sent from a browser script of the signed-in screens (docs/contracts/
 * phase-6-social.md section 6): link a fork, create or change a paper manager, create or stop a
 * model war. The reads are in ./client.ts, on the server. These calls ask a wallet for nothing:
 * the session cookie travels with them, and the API decides every one of them.
 *
 * A call never throws: it resolves to `{ ok: true, status, data }` or `{ ok: false, status, error }`.
 * A browser script does not load zod (docs/CONTRACTS.md section 15), so an answer is checked for
 * the shape the script reads and nothing more. Under __PRIX_FIXTURES__ the calls answer from
 * ./fixtures.ts, with the state that `?fixture=social-<state>` names on the page's address.
 */

export interface SocialWrite {
  method: 'POST' | 'PATCH';
  path: string;
  body?: unknown;
}

export type WriteResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: ApiError['error'] };

type Shape = 'link' | 'manager' | 'war' | 'none';

const UNUSABLE = 'The API did not give a usable answer. Try again in a minute.';

function codeForStatus(status: number): ApiErrorCode {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  return 'internal';
}

function unusable(status: number): WriteResult<never> {
  const failed = status >= 400 ? status : 502;
  return { ok: false, status: failed, error: { code: codeForStatus(failed), message: UNUSABLE, field: null } };
}

function looksRight(shape: Shape, body: unknown): boolean {
  if (shape === 'none') return true;
  if (typeof body !== 'object' || body === null) return false;
  const record = body as Record<string, unknown>;
  if (shape === 'link') return typeof record.agentId === 'string';
  if (shape === 'manager') return typeof record.manager === 'object' && record.manager !== null;
  return typeof record.war === 'object' && record.war !== null;
}

function looksLikeError(body: unknown): body is ApiError {
  if (typeof body !== 'object' || body === null) return false;
  const error = (body as { error?: unknown }).error;
  return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string';
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

async function transport(call: SocialWrite): Promise<Response> {
  if (typeof __PRIX_FIXTURES__ !== 'undefined' && __PRIX_FIXTURES__) {
    const { socialWriteAnswer } = await import('./fixtures.ts');
    return socialWriteAnswer(new URL(window.location.href).searchParams.get('fixture'), call);
  }
  return fetch(call.path, {
    method: call.method,
    credentials: 'same-origin',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: call.body === undefined ? undefined : JSON.stringify(call.body),
  });
}

async function send<T>(call: SocialWrite, shape: Shape): Promise<WriteResult<T>> {
  let response: Response;
  try {
    response = await transport(call);
  } catch (cause) {
    // Logged by path only: never a body, a header or a query.
    console.error(
      'social_write_failed',
      call.method,
      call.path.split('?')[0],
      cause instanceof Error ? cause.name : '',
    );
    return unusable(502);
  }
  const body = response.status === 204 ? null : await readJson(response);
  if (!response.ok) {
    return looksLikeError(body) ? { ok: false, status: response.status, error: body.error } : unusable(response.status);
  }
  return looksRight(shape, body) ? { ok: true, status: response.status, data: body as T } : unusable(502);
}

const segment = (value: string): string => encodeURIComponent(value);

/** POST /api/social/agents/:childId/lineage: the server decides whether the fork may be linked. */
export function linkFork(childId: string, parentId: string): Promise<WriteResult<LinkForkResponse>> {
  return send({ method: 'POST', path: `/api/social/agents/${segment(childId)}/lineage`, body: { parentId } }, 'link');
}

/** POST /api/social/managers */
export function createManager(input: CreateManagerInput): Promise<WriteResult<ManagerDetailResponse>> {
  return send({ method: 'POST', path: '/api/social/managers', body: input }, 'manager');
}

/** PATCH /api/social/managers/:id: a new allocation or a new status, one at a time. */
export function patchManager(id: string, input: PatchManagerInput): Promise<WriteResult<ManagerDetailResponse>> {
  return send({ method: 'PATCH', path: `/api/social/managers/${segment(id)}`, body: input }, 'manager');
}

/** POST /api/social/admin/wars. The server checks the administrator, the models and the dates. */
export function createWar(input: CreateWarInput): Promise<WriteResult<WarDetailResponse>> {
  return send({ method: 'POST', path: '/api/social/admin/wars', body: input }, 'war');
}

/** POST /api/social/admin/wars/:id/stop */
export function stopWar(id: string): Promise<WriteResult<null>> {
  return send({ method: 'POST', path: `/api/social/admin/wars/${segment(id)}/stop` }, 'none');
}
