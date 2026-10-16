// The two reads that decide which rows of "Open to holders now" show (docs/contracts/phase-6-holders.md
// section 2). Server side only, through the API service binding. Neither throws: a read that fails is
// `false`, so the page claims nothing it cannot back.
//
//   picturesOn     the room's public read answers `pictures: "on"` (revision 3, H2-SEC-10)
//   ownerHoldsOn   GET /api/token/me/owner-holds answers 200 or 401, not 404 (revision 4, H3-SEC-1)
//
// Each answer is a yes or no that is the same for every visitor (a session changes 401 into 200, both of
// which are "there"), so an isolate keeps it a minute, ten seconds when the read failed, as the site keeps
// its other probes. In a fixture build `?pictures=off` and `?ownerHolds=off` turn either off; both are on
// otherwise, and nothing is kept.
import { ownerHoldsRouteOn, roomWithPicturesResponseSchema } from '@prix/contracts';
import type { ApiContext } from '../../lib/api.ts';

const FIXTURES = typeof __PRIX_FIXTURES__ !== 'undefined' && __PRIX_FIXTURES__;
export const KEEP_MS = 60_000;
export const FAILED_KEEP_MS = 10_000;

export interface KeptSlot {
  kept?: { at: number; value: boolean; failed: boolean };
}

/** The kept answer while it is fresh, or a new one from `ask`. `ask` answers null when the read failed. */
export async function keptAnswer(slot: KeptSlot, now: number, ask: () => Promise<boolean | null>): Promise<boolean> {
  const kept = slot.kept;
  if (kept && now - kept.at < (kept.failed ? FAILED_KEEP_MS : KEEP_MS)) return kept.value;
  let answer: boolean | null;
  try {
    answer = await ask();
  } catch {
    answer = null;
  }
  slot.kept = { at: now, value: answer ?? false, failed: answer === null };
  return answer ?? false;
}

async function get(context: ApiContext, path: string): Promise<Response> {
  const { createServerTransport } = await import('../../lib/api-server.ts');
  return createServerTransport(context)({ method: 'GET', path });
}

const memory = globalThis as { __prixHoldersPictures?: KeptSlot; __prixHoldersOwnerHolds?: KeptSlot };

/** Whether the room's public read answers `pictures: "on"`. A room that is off, or a failed read, is false. */
export async function picturesOn(context: ApiContext): Promise<boolean> {
  if (FIXTURES) return context.url.searchParams.get('pictures') !== 'off';
  memory.__prixHoldersPictures ??= {};
  return keptAnswer(memory.__prixHoldersPictures, Date.now(), async () => {
    const response = await get(context, '/api/social/room');
    if (response.status === 404) return false;
    if (!response.ok) return null;
    const parsed = roomWithPicturesResponseSchema.safeParse(await response.json());
    return parsed.success ? parsed.data.pictures === 'on' : null;
  });
}

/** Whether the owner-holds route is there: 200 or 401. 404, any other status and a failed request are not. */
export async function ownerHoldsOn(context: ApiContext): Promise<boolean> {
  if (FIXTURES) return context.url.searchParams.get('ownerHolds') !== 'off';
  memory.__prixHoldersOwnerHolds ??= {};
  return keptAnswer(memory.__prixHoldersOwnerHolds, Date.now(), async () => {
    const response = await get(context, '/api/token/me/owner-holds');
    await response.body?.cancel();
    const on = ownerHoldsRouteOn(response.status);
    // 404 is a firm "not there"; any other refusal is a read that failed, asked again sooner.
    return on || response.status === 404 ? on : null;
  });
}
