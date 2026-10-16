import { ownerHoldsRouteOn, roomWithPicturesResponseSchema } from '@prix/contracts';
import type { ApiContext, ApiResult } from '../../lib/api.ts';

/**
 * What decides the rows of "Open to holders now" on /account/token (docs/contracts/phase-6-holders.md
 * section 2). Server side only. Neither read throws, and a read that fails is `false`, so the page claims
 * nothing it cannot back:
 *
 *   picturesOn    the room's public read answers `pictures: "on"` (revision 3, H2-SEC-10)
 *   ownerHoldsOn  GET /api/token/me/owner-holds answers 200 or 401, not 404 (revision 4, H3-SEC-1)
 *
 * The account page reads the owner-holds route anyway, for the switch, so its status decides both the row
 * and the switch. In a fixture build `?pictures=off` turns the pictures row off.
 */

/** The room's public read answers `pictures: "on"`. A room that is off, or a read that failed, is false. */
export async function readPicturesOn(context: ApiContext): Promise<boolean> {
  if (typeof __PRIX_FIXTURES__ !== 'undefined' && __PRIX_FIXTURES__) {
    return context.url.searchParams.get('pictures') !== 'off';
  }
  try {
    const { createServerTransport } = await import('../../lib/api-server.ts');
    const response = await createServerTransport(context)({ method: 'GET', path: '/api/social/room' });
    if (!response.ok) {
      await response.body?.cancel();
      return false;
    }
    const parsed = roomWithPicturesResponseSchema.safeParse(await response.json());
    return parsed.success && parsed.data.pictures === 'on';
  } catch {
    return false;
  }
}

/** The status the owner-holds read answered with, or null when it never reached the API (`ownerHoldsRouteOn`). */
export function ownerHoldsOnOf(read: ApiResult<unknown> | null): boolean {
  if (read === null) return false;
  // A failure the client made itself (502 for an answer it could not read) is not the route answering.
  if (!read.ok && read.status === 502) return ownerHoldsRouteOn(null);
  return ownerHoldsRouteOn(read.status);
}
