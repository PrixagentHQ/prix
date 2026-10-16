import type {
  ApiError,
  LineageAgent,
  SessionRecord,
  SocialAgentRecord,
  SocialAgentRef,
  SocialApiDeps,
} from '@prix/contracts';
import { isHouseOwner } from '@prix/contracts';
import { ApiFailure, failures, json } from '../errors.ts';
import { readSession } from '../guard.ts';
import { shortAddress } from '../views.ts';

/**
 * What the Phase 6 routes share. docs/contracts/phase-6-social.md sections 6, 7 and 11.
 *
 * Every function here names the fields of a response one by one: an owner address, a prompt or a
 * figure of a hidden agent can never reach a Phase 6 response by way of a record that grew a field.
 */

/** The UTC day of an instant. */
export function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

/** `day` plus `days` calendar days. */
export function addDays(day: string, days: number): string {
  const at = new Date(`${day}T00:00:00.000Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/** An agent as a Phase 6 response names it: id, name, the short owner and the house mark. */
export function refOf(deps: SocialApiDeps, agent: SocialAgentRecord): SocialAgentRef {
  return {
    id: agent.id,
    name: agent.name,
    ownerShort: shortAddress(agent.owner),
    // The owner's full address is read for this mark and goes no further.
    house: isHouseOwner(deps.config.houseOwners, agent.owner),
  };
}

export function lineageAgentOf(deps: SocialApiDeps, agent: SocialAgentRecord, depth: number): LineageAgent {
  return { ...refOf(deps, agent), createdAt: agent.createdAt, depth };
}

/**
 * The fork rules and the one-open-war rule answer 409 with the code `invalid_input` (section 6).
 * The shared error map gives `invalid_input` 400, so this answer is built here, in the same shape,
 * with the same headers as every other error, and never cached.
 */
export function conflict(message: string, field: string): Response {
  const body: ApiError = { error: { code: 'invalid_input', message, field } };
  return json(body, 409, 'private');
}

export const socialFailures = {
  rivalryNotFound: () =>
    new ApiFailure('not_found', 'No rivalry has this id. Check the link, or open the list of rivalries.'),
  warNotFound: () => new ApiFailure('not_found', 'No paper experiment has this id. Check the link, or open the list.'),
  managerNotFound: () =>
    new ApiFailure('not_found', 'No paper manager has this id. Check the link, or open the list of paper managers.'),
  familyNotFound: () => new ApiFailure('not_found', 'No agent has this id. Check the link, or open the league.'),
};

/**
 * The admin check of every `/api/social/admin/*` route, before anything else is read: a request
 * that is not an admin session gets the generic route-not-found answer, byte for byte the answer to
 * an unknown path, so the routes cannot be found by asking.
 */
export async function adminOr404(deps: SocialApiDeps, request: Request): Promise<SessionRecord> {
  const session = await readSession(deps, request);
  const admins = deps.config.adminAddresses.map((address) => address.toLowerCase());
  if (session === null || !admins.includes(session.address.toLowerCase())) throw failures.routeNotFound();
  return session;
}

/**
 * Who did what to what: an address, an action name and an id. Nothing private. `reports` is the count of
 * reports of a picture that a hide removed (docs/contracts/phase-6-pictures.md section 9): a number, never
 * a reporter's address. A line without it is written exactly as before.
 */
export function audit(session: SessionRecord, action: string, target: string, reports?: number): void {
  const line = { event: 'admin_action', admin: session.address, action, target };
  console.log(JSON.stringify(reports === undefined ? line : { ...line, reports }));
}
