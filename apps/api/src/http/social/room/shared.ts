import type {
  HoldersGate,
  IsoTime,
  RoomAdminPicture,
  RoomAdminResponse,
  RoomApiDeps,
  RoomHoldersApiDeps,
  RoomHolding,
  RoomHoldingWithTier,
  RoomMessage,
  RoomMessageRecord,
  RoomPictureBytes,
  RoomPictureMessage,
  RoomPictureMessageRecord,
  RoomPictureRecord,
  RoomServablePicture,
} from '@prix/contracts';
import {
  ROOM_PICTURE_FETCH_HEADERS,
  ROOM_PICTURE_LOG_EVENTS,
  ROOM_PICTURE_MIN_TOKENS,
  ROOM_PICTURE_TTL_SECONDS,
  ROOM_WRITE_MIN_TOKENS,
  roomHolderMark,
  roomPictureHeaders,
  roomPictureView,
  storedTierOf,
} from '@prix/contracts';
import { ApiFailure, failures } from '../../errors.ts';
import { shortAddress } from '../../views.ts';
import { pictureBytesFailure } from './refusals.ts';

/**
 * What the room's routes share. Every function names the fields of a response one by one: a whole
 * address, who hid a message or when can never reach a public response by way of a record that grew a
 * field (docs/contracts/phase-6-room.md sections 3 and 13).
 */

/** The admin wallets, in lower case: the one form an address is compared in. */
export function adminSet(deps: RoomApiDeps): ReadonlySet<string> {
  return new Set(deps.config.adminAddresses.map((address) => address.toLowerCase()));
}

/** The host of the site's origin: the one host a message may hold. */
export function siteHostOf(deps: RoomApiDeps): string {
  return new URL(deps.config.siteOrigin).host;
}

/**
 * A message as a page shows it. The writer is the short address, as an agent's page shows an owner. The
 * whole address is read for the admin mark and goes no further; the mark is computed here, at the read,
 * from the author's address in lower case.
 */
export function publicMessage(
  message: RoomMessageRecord,
  admins: ReadonlySet<string>,
  holder?: HolderMarkOf,
): RoomMessage {
  const admin = admins.has(message.author.toLowerCase());
  const shown: RoomMessage = {
    id: message.id,
    at: message.at,
    authorShort: shortAddress(message.author),
    admin,
    text: message.text,
  };
  return holder === undefined ? shown : { ...shown, holder: holder(message, admin) };
}

// --- Phase 6.8, holders in the chat (docs/contracts/phase-6-holders-2.md section 2) -----------------------

/**
 * The Holder mark of one message, given while ROOM_HOLDERS is on; absent, no `holder` field is sent at all.
 * It reads the message and whether its author is an admin now, and nothing of a request.
 */
export type HolderMarkOf = (message: RoomMessageRecord, admin: boolean) => boolean;

/**
 * Whether the holders' part of the room is on: `roomHoldersOn` and the gate's read both given. Absent counts
 * as off (section 2.1): no `holder` field and every cap ROOM_MESSAGES_PER_WALLET_PER_DAY.
 */
export function holdersOn(deps: RoomHoldersApiDeps): boolean {
  return deps.roomHoldersOn === true && typeof deps.holdersGate === 'function';
}

/**
 * The mark of the public read: `roomHolderMark` of the author's stored tier (`storedTierOf` of the row the
 * store joined), judged at the route's one reading of the clock against the gate it read once.
 */
export function storedHolderMark(gate: HoldersGate, now: IsoTime): HolderMarkOf {
  return (message, admin) => roomHolderMark(admin, storedTierOf(message.authorHolder, gate, now));
}

/** The mark of a writer's own new message: the tier of the holding the cap was read from (section 2.1, L5). */
export function ownHolderMark(holding: RoomHoldingWithTier | null): HolderMarkOf {
  return (_message, admin) => roomHolderMark(admin, holding?.tier ?? 0);
}

/**
 * A message as the admins' page needs it: the whole address, and the three things that keep a message
 * from the public. `muted` and `cut` are the store's own answers and are not judged again here.
 */
export function adminMessage(
  message: RoomMessageRecord & { muted: boolean; cut: boolean },
  admins: ReadonlySet<string>,
): RoomAdminResponse['messages'][number] {
  return {
    id: message.id,
    at: message.at,
    author: message.author,
    text: message.text,
    hidden: message.hiddenAt !== null,
    muted: message.muted,
    cut: message.cut,
    admin: admins.has(message.author.toLowerCase()),
  };
}

/**
 * Why a wallet that is no admin may not write, by its holding as the token service read it: the gate
 * first, then the holding (docs/contracts/phase-6-room.md section 3, revision 7). Null: it may. No tier is
 * asked. The holding is compared as "not at least", so that a figure that is no number never writes.
 */
export function holdingRefusal(holding: RoomHolding): 'gate_off' | 'not_holder' | null {
  if (!holding.gatingOn) return 'gate_off';
  if (!(holding.tokens >= ROOM_WRITE_MIN_TOKENS)) return 'not_holder';
  return null;
}

// --- pictures (docs/contracts/phase-6-pictures.md) ------------------------------------------------------

/**
 * Why a wallet that is no admin may not upload or report, by its holding: the gate first, then the holding
 * of a picture, which is a constant of its own (section 3). Null: it may. Compared as "not at least", so
 * that a figure that is no number never uploads.
 */
export function pictureHoldingRefusal(holding: RoomHolding): 'gate_off' | 'not_holder' | null {
  if (!holding.gatingOn) return 'gate_off';
  if (!(holding.tokens >= ROOM_PICTURE_MIN_TOKENS)) return 'not_holder';
  return null;
}

/**
 * A message as a page shows it from Phase 6.4 on: the message, and its picture as `roomPictureView` says
 * it at `now` (null for a message of text). The admin mark is computed here, at the read, and a picture
 * whose writer is an admin wallet now is shown as gone. Never a key, a hash, a count of reports or an
 * address of a picture: the fields are named one by one in the contract's function.
 */
export function pictureMessage(
  message: RoomPictureMessageRecord,
  admins: ReadonlySet<string>,
  now: IsoTime,
  holder?: HolderMarkOf,
): RoomPictureMessage {
  const shown = publicMessage(message, admins, holder);
  return {
    ...shown,
    picture: message.picture === null ? null : roomPictureView(message.picture, message.at, now, shown.admin),
  };
}

/**
 * A picture as the admins' page lists it: the facts the server read, the first 12 hex characters of the
 * hash, its state and its count of reports. `viewable` says what `getAdminPicture` and the admin's look
 * would: a picture that is not removed, has a key, whose message is not hidden and is younger than seven
 * days, and whose writer is no admin wallet now. `bytesGone`: Prix has deleted the bytes. Never the key.
 */
export function adminPicture(
  message: RoomPictureMessageRecord,
  picture: RoomPictureRecord,
  admins: ReadonlySet<string>,
  now: IsoTime,
): RoomAdminPicture {
  const young = Date.parse(now) - Date.parse(message.at) < ROOM_PICTURE_TTL_SECONDS * 1_000;
  return {
    type: picture.type,
    width: picture.width,
    height: picture.height,
    bytes: picture.bytes,
    frames: picture.frames,
    sha256Short: picture.sha256.slice(0, 12),
    state: picture.state,
    reports: picture.reports,
    viewable:
      picture.state !== 'removed' &&
      picture.key !== null &&
      message.hiddenAt === null &&
      young &&
      !admins.has(message.author.toLowerCase()),
    bytesGone: picture.key === null,
  };
}

/** The log lines of pictures that tell of a fault; the others tell of something that happened as designed. */
const PICTURE_FAULTS: ReadonlySet<string> = new Set([
  ROOM_PICTURE_LOG_EVENTS.deleteFailed,
  ROOM_PICTURE_LOG_EVENTS.lengthMismatch,
  ROOM_PICTURE_LOG_EVENTS.orphan,
  ROOM_PICTURE_LOG_EVENTS.uploadFailed,
  ROOM_PICTURE_LOG_EVENTS.reportFailed,
]);

/**
 * A log line of pictures: the event and a message's id, a count or the number of a step, and nothing
 * else. The type takes no other field, so that no address, key, hash or byte can be written into one.
 */
export function logPicture(
  event: (typeof ROOM_PICTURE_LOG_EVENTS)[keyof typeof ROOM_PICTURE_LOG_EVENTS],
  detail: { id: number } | { count: number } | { step: number },
): void {
  const line = JSON.stringify({ event, ...detail });
  if (PICTURE_FAULTS.has(event)) console.error(line);
  else console.log(line);
}

/**
 * The log line of a fault in work that was handed to `waitUntil` (the upload's steps 6 to 11, a report's
 * steps 4 to 6): the event and the number of the step that threw, and nothing of what was thrown. It is
 * written inside the work's own failure path, before the work rejects: once the client has left, the
 * error handler never sees the fault. A refusal of the guard (`ApiFailure`: the limiter, a limit of the
 * day) is an answer and no fault, and writes no line.
 */
export function logWorkFault(
  event: typeof ROOM_PICTURE_LOG_EVENTS.uploadFailed | typeof ROOM_PICTURE_LOG_EVENTS.reportFailed,
  step: number,
  thrown: unknown,
): void {
  if (thrown instanceof ApiFailure) return;
  logPicture(event, { step });
}

/**
 * The two headers a request for bytes must carry, each present and exactly so (section 7, step 2): an
 * `<img>` on Prix's own page sends both. A request with either absent or with any other value is refused:
 * "refuse only a wrong value" is never the rule. This is what keeps a stored file that is also a script
 * from ever being loaded as one, beside the type from the row and `nosniff`.
 */
export function fromOwnImage(request: Request): boolean {
  for (const [name, value] of Object.entries(ROOM_PICTURE_FETCH_HEADERS)) {
    if (request.headers.get(name) !== value) return false;
  }
  return true;
}

/**
 * Steps 7 to 9 of a bytes route, for a key that the gate (or the admin's own look) has just answered in
 * this request: the read of KV (null is the generic 404 and the row is not touched; a throw is the 503);
 * the length against the row's; then a 200 with exactly the contract's headers and nothing else. The type
 * and the length are the row's: never the upload's, never KV's, never the request's.
 */
export async function servePicture(
  bytes: RoomPictureBytes,
  id: number,
  picture: RoomServablePicture,
): Promise<Response> {
  let held: Uint8Array | null;
  try {
    held = await bytes.get(picture.key);
  } catch {
    return pictureBytesFailure();
  }
  if (held === null) throw failures.routeNotFound();
  if (held.length !== picture.bytes) {
    logPicture(ROOM_PICTURE_LOG_EVENTS.lengthMismatch, { id });
    throw failures.routeNotFound();
  }
  return new Response(held, { status: 200, headers: roomPictureHeaders(id, picture.type, picture.bytes) });
}
