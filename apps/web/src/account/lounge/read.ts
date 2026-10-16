import type { LoungeResponse } from '@prix/contracts';
import { loungeResponseSchema } from '@prix/contracts';
import type { ApiContext } from '../../lib/api.ts';

/**
 * The account page's read of the lounge, `GET /api/lounge` (docs/contracts/phase-6-holders-2.md sections
 * 4.5 and 4.7). Server side only (Astro frontmatter): the call goes through the `API` service binding with
 * the visitor's own cookie, once per render, and the answer is parsed with the contract's schema. The API
 * decides everything: whether the lounge is on (the generic 404 while it is not), the session (401), the
 * wallet's holding and its linked Telegram account. Nothing of this read is ever sent to the browser but
 * what the block renders.
 *
 * It never throws. A usable answer is `{ ok: true, data }`; anything else is `{ ok: false, status }`, and the
 * block is then absent: it is shown only when the API answered 200 with a body the schema takes.
 */

export type LoungeRead = { ok: true; data: LoungeResponse } | { ok: false; status: number };

/** What the block shows: nothing, a state, or the state `open` with the invite link the API sent. */
export type LoungeView = null | { state: 'not_holder' } | { state: 'link_telegram' } | { state: 'open'; url: string };

const FIXTURES = typeof __PRIX_FIXTURES__ !== 'undefined' && __PRIX_FIXTURES__;

/** An answer of the API as the block reads it: only a 200 the contract's schema takes is usable. */
export function loungeReadOf(status: number, body: unknown): LoungeRead {
  if (status !== 200) return { ok: false, status };
  const parsed = loungeResponseSchema.safeParse(body);
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, status: 502 };
}

/** The block's view of a read: null on any read that is not usable, and the link in state `open` only. */
export function loungeViewOf(read: LoungeRead): LoungeView {
  if (!read.ok) return null;
  const { state, url } = read.data;
  if (state === 'open') return url === null ? null : { state, url };
  return { state };
}

/** GET /api/lounge with the visitor's cookie. Under __PRIX_FIXTURES__ it answers from ./fixtures.ts. */
export async function fetchLounge(context: ApiContext): Promise<LoungeRead> {
  if (FIXTURES) {
    const { loungeFixture } = await import('./fixtures.ts');
    return loungeFixture(context.url.searchParams.get('lounge'));
  }
  let response: Response;
  try {
    const { createServerTransport } = await import('../../lib/api-server.ts');
    response = await createServerTransport(context)({ method: 'GET', path: '/api/lounge' });
  } catch (cause) {
    // Logged by name only: never an answer, a header or a link.
    console.error('lounge_read_failed', cause instanceof Error ? cause.name : '');
    return { ok: false, status: 502 };
  }
  if (response.status !== 200) {
    // The body of a refusal is not read: the block is absent whatever it says.
    await response.body?.cancel().catch(() => undefined);
    return { ok: false, status: response.status };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, status: 502 };
  }
  return loungeReadOf(response.status, body);
}
