import type { RoomStatusResponse, RoomWithPicturesResponse } from '@prix/contracts';
import { roomStatusResponseSchema, roomWithPicturesResponseSchema } from '@prix/contracts';
import { type Context, type Read, type SocialSwitch, socialIsOn, socialRead, switchOf } from '../client.ts';

/**
 * The typed reads of the Community chat (the room, docs/contracts/phase-6-room.md section 6). Server side
 * only, through the `API` binding, as every Phase 6 read is: a call never throws, and its answer is parsed
 * with the contract's schema. Under __PRIX_FIXTURES__ the same functions answer from ./fixtures.ts.
 *
 * The room has two public reads, and neither takes a query. Whether the room is on is asked through
 * `roomIsOn`, kept a minute; the messages are read only by the page `/chat`, and only after that probe
 * answered on. The session's read (`me`) and the send are the composer's (apps/web/src/account/social/room).
 */

/** GET /api/social/room/status: 200 while the room is on, 404 while it is off. */
export function fetchRoomStatus(context: Context): Promise<Read<RoomStatusResponse>> {
  return socialRead(context, '/api/social/room/status', roomStatusResponseSchema);
}

/**
 * GET /api/social/room: the newest messages, with the one address and the one host a message may hold.
 * Read with the schema of Phase 6.4 (docs/contracts/phase-6-pictures.md, section 10): it takes the answer
 * of an API before pictures, which carries neither `pictures` nor a `picture` on a message, and the answer
 * with both. The room's older schema is strict and would refuse the second.
 */
export function fetchRoom(context: Context): Promise<Read<RoomWithPicturesResponse>> {
  return socialRead(context, '/api/social/room', roomWithPicturesResponseSchema);
}

/** How long an isolate keeps the answer of the probe: a minute (the contract's section 6). */
export const PROBE_KEEP_MS = 60_000;
/** A probe that failed is asked again sooner, so that a short outage does not hide the chat for a minute. */
export const PROBE_FAILED_KEEP_MS = 10_000;

/** Where an answer of the probe is kept: one slot for each isolate of the site's Worker. */
export interface RoomProbeSlot {
  kept?: { at: number; value: SocialSwitch };
}

/**
 * Whether the room is on, from what is kept or by asking. While Phase 6 itself is not on the room cannot
 * be, so it is not asked and nothing is kept: the answer is Phase 6's own. Otherwise the kept answer
 * stands for a minute (ten seconds when it failed), and `ask` is called once it is older than that.
 */
export async function roomSwitch(input: {
  slot: RoomProbeSlot;
  now: number;
  social: SocialSwitch;
  ask(): Promise<SocialSwitch>;
}): Promise<SocialSwitch> {
  const { slot, now, social, ask } = input;
  if (social !== 'on') return social;
  const kept = slot.kept;
  if (kept && now - kept.at < (kept.value === 'failed' ? PROBE_FAILED_KEEP_MS : PROBE_KEEP_MS)) return kept.value;
  const value = await ask();
  slot.kept = { at: now, value };
  return value;
}

/**
 * The probe of the room's switch, beside `socialIsOn`: the entry "Chat" of the Social navigation shows only
 * on 'on', and the page `/chat` asks the room's read only on 'on'. Kept in isolate memory, so a page costs
 * no call of its own while the answer is fresh. In fixtures it follows `?fixture=` and keeps nothing.
 */
export async function roomIsOn(context: Context): Promise<SocialSwitch> {
  const memory = globalThis as { __prixRoomOn?: RoomProbeSlot };
  memory.__prixRoomOn ??= {};
  const fixtures = typeof __PRIX_FIXTURES__ !== 'undefined' && __PRIX_FIXTURES__;
  return roomSwitch({
    slot: fixtures ? {} : memory.__prixRoomOn,
    now: Date.now(),
    social: await socialIsOn(context),
    ask: async () => switchOf(await fetchRoomStatus(context)),
  });
}
