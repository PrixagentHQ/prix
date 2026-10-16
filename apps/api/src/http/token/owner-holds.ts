import type { Address, ApiDeps, OwnerHoldsSetting, TokenApiDeps } from '@prix/contracts';
import { OWNER_HOLDS_WRITE_ROWS, ownerHoldsOf, ownerHoldsSettingSchema } from '@prix/contracts';
import type { Hono } from 'hono';
import { failures, json } from '../errors.ts';
import { enforceLimit, requireSession, requireWriter } from '../guard.ts';
import { readInput } from '../input.ts';

/**
 * Part B of docs/contracts/phase-6-holders.md (section 3): the owner's choice to show "Owner holds $PRIX" on
 * its agents' pages, off by default. Both routes are the generic 404 while `ApiDeps.ownerHolds` is absent,
 * before the session is asked, so that the page reads the route as absent (H3-SEC-1: 200 or 401 is there).
 * The address is the session's and nothing else.
 */
export function registerOwnerHoldsRoutes(app: Hono, deps: ApiDeps & { token: TokenApiDeps }): void {
  app.get('/token/me/owner-holds', async (c) => {
    const store = deps.ownerHolds;
    if (store === undefined) throw failures.routeNotFound();
    const session = await requireSession(deps, c.req.raw);
    await enforceLimit(deps, 'read', session.address);
    const show = await store.getShowHolds(session.address as Address);
    return json<OwnerHoldsSetting>({ show }, 200, 'private');
  });

  app.put('/token/me/owner-holds', async (c) => {
    const store = deps.ownerHolds;
    if (store === undefined) throw failures.routeNotFound();
    const session = await requireWriter(deps, c.req.raw, OWNER_HOLDS_WRITE_ROWS);
    const { show } = await readInput(ownerHoldsSettingSchema, c.req.raw);
    await store.setShowHolds(session.address as Address, show, deps.now().toISOString());
    return json<OwnerHoldsSetting>({ show }, 200, 'private');
  });
}

/**
 * `ownerHolds` of GET /api/agents/:id (section 3). The owner's choice is read first; while it is off, or
 * for a house agent, the entitlements are not asked. The tier is the STORED one (`cachedOnly`), so a public
 * request never reads the chain. A read that fails for any reason (a missing column before migration 0018,
 * a D1 error, the port) answers false and logs `owner_holds_read_failed` once, with no address and no error
 * text: the agent read never fails because of the mark.
 */
export async function ownerHoldsFor(
  deps: Pick<ApiDeps, 'ownerHolds' | 'entitlements'>,
  owner: string,
  house: boolean,
): Promise<boolean> {
  const store = deps.ownerHolds;
  const entitlements = deps.entitlements;
  if (house || store === undefined || entitlements === undefined) return false;
  try {
    const shown = await store.getShowHolds(owner as Address);
    if (!shown) return false;
    return ownerHoldsOf(await entitlements.entitlementsFor(owner, { cachedOnly: true }), house, shown);
  } catch {
    console.error(JSON.stringify({ event: 'owner_holds_read_failed' }));
    return false;
  }
}
