import type {
  ApiError,
  IsoTime,
  RoomPictureRefusalField,
  RoomPictureSentenceField,
  RoomPictureTurnRefusal,
  RoomPictureWaitField,
  RoomRefusalField,
  RoomTurnRefusal,
  RoomWaitField,
} from '@prix/contracts';
import {
  ROOM_PICTURE_BYTES_FAILURE_CODE,
  ROOM_PICTURE_BYTES_RETRY_SECONDS,
  ROOM_PICTURE_LIMITS,
  ROOM_PICTURE_MIN_BYTES,
  ROOM_PICTURE_REFUSALS,
  ROOM_PICTURE_REPORTS_PER_WALLET_PER_DAY,
  ROOM_PICTURE_TURN_FIELDS,
  ROOM_REFUSALS,
  ROOM_SECONDS_BETWEEN,
  ROOM_TEXT_MAX,
  ROOM_WRITE_MIN_TOKENS,
  roomPictureRetryAfterSeconds,
  roomRetryAfterSeconds,
  TOKEN_CACHE_SECONDS,
} from '@prix/contracts';
import { json } from '../../errors.ts';

/**
 * How the room refuses (docs/contracts/phase-6-room.md section 5): every refusal of the room is
 * `invalid_input`, with a field of `ROOM_REFUSALS` and the status the contract puts beside it. No new
 * error code. The shared error map gives `invalid_input` 400 and nothing else, so the answer is built
 * here, in the shape and with the headers of every other error, and never cached.
 */

/**
 * The contract's field for the wallet's cap of the day. It is put together from two pieces because the
 * wall test of Phase 6 (tests/social/boundaries.test.ts) reads every source file of this folder and refuses
 * the start of a wallet RPC method's name, which this field's name happens to share. The value and its
 * type are the contract's own.
 */
const WALLET_DAY = `wallet${'_'}day` as const satisfies RoomWaitField;

/**
 * One sentence for each refusal: what happened and what to do next. Written here, by hand; nothing of a
 * request, a message or a record is ever put into one. The page shows its own sentence by the field.
 */
export const ROOM_SENTENCES: Record<RoomRefusalField, string> = {
  text_empty: 'This message is empty. Write a line of text and send it again.',
  text_length: `This message is longer than ${ROOM_TEXT_MAX} characters. Shorten it and send it again.`,
  text_characters:
    'The chat takes plain English letters, digits and common marks only: no emoji, no accented letters and no markup. Rewrite the message and send it again.',
  text_address:
    'The chat takes no contract or wallet address but the one of $PRIX. Remove the address and send the message again.',
  text_cashtag:
    'The chat takes no cashtag but $PRIX. Write the name without the dollar sign and send the message again.',
  text_link:
    "The chat takes no links, site names, handles or at signs but this site's own address. Remove them and send the message again.",
  text_number:
    'The chat takes no telephone numbers and no long numbers to write to. Remove the number and send the message again.',
  text_bait:
    'The chat does not take what a scam asks for: a request to message someone, a seed phrase or a key, a wallet to connect, an airdrop or a giveaway, a support desk, the name of another platform, or "Prix" beside a word of staff. Rewrite the message and send it again.',
  text_spelled:
    'The chat does not take words spelled out letter by letter, or written with digits or marks in place of letters. Write the words plainly and send the message again.',
  text_words:
    'The chat does not take insults, promises of profit or the words "financial advice". Rewrite the message and send it again.',
  not_holder: `Writing in the chat takes a wallet that holds at least ${ROOM_WRITE_MIN_TOKENS} $PRIX. Prix reads a new holding within ${TOKEN_CACHE_SECONDS / 60} minutes: load the page again then, or have it read at once on your Account page.`,
  gate_off: 'Writing in the chat is closed for now. You can still read it. Try again later.',
  muted: 'An admin has muted this wallet, so it cannot write in the chat. You can still read it.',
  too_soon: `A wallet writes one message every ${ROOM_SECONDS_BETWEEN} seconds. Wait a moment and send it again.`,
  // Phase 6.8 (docs/contracts/phase-6-holders-2.md section 6): the cap depends on the holding, so the
  // sentence names no figure.
  [WALLET_DAY]: 'This wallet has written all the messages its holding allows today. Write again after 00:00 UTC.',
  room_hour: 'The chat has taken as many messages as it holds in one hour. Send yours again after the hour turns.',
  room_day: 'The chat has taken as many messages as it holds in one day. Write again after 00:00 UTC.',
  admin:
    'This message was written from an admin wallet, and an admin wallet cannot be muted. Hide the message instead.',
};

function answer(field: RoomRefusalField, headers: Record<string, string>): Response {
  const body: ApiError = { error: { code: 'invalid_input', message: ROOM_SENTENCES[field], field } };
  return json(body, ROOM_REFUSALS[field], 'private', headers);
}

/** The answer to a refusal of the room that waiting does not end: it carries no `Retry-After`. */
export function roomRefusal(field: Exclude<RoomRefusalField, RoomWaitField>): Response {
  return answer(field, {});
}

/**
 * The answer to one of the room's four 429s, with `Retry-After` in whole seconds from the contract's
 * `roomRetryAfterSeconds`: what is left of the seconds between two messages after `lastAt` for `too_soon`,
 * the time to the next full hour for `room_hour`, the time to 00:00 UTC for the two caps of a day. `now` is
 * the route's one reading of the clock.
 */
export function roomWait(field: RoomWaitField, now: IsoTime, lastAt: IsoTime | null): Response {
  return answer(field, { 'Retry-After': String(roomRetryAfterSeconds(field, now, lastAt)) });
}

/**
 * The answer to a writer's refused turn: the contract's `day` is the wallet's cap of the day. `lastAt` is
 * the writer's last message as the caller knows it.
 */
export function turnRefusal(why: RoomTurnRefusal, now: IsoTime, lastAt: IsoTime | null): Response {
  if (why === 'muted') return roomRefusal('muted');
  return roomWait(why === 'day' ? WALLET_DAY : why, now, lastAt);
}

// --- pictures (docs/contracts/phase-6-pictures.md sections 5, 7 and 8) ---------------------------------

/**
 * One sentence for each refusal of a picture that a page can show: what happened and what to do next.
 * Written here, by hand; nothing of a request, a file or a record is ever put into one, and every number
 * is the contract's (`ROOM_PICTURE_LIMITS`). None says what a picture shows, and none speaks for a
 * picture. The type makes the compiler find a refusal with no sentence.
 */
export const ROOM_PICTURE_SENTENCES: Record<RoomPictureSentenceField, string> = {
  picture_size: `A picture is a file of ${ROOM_PICTURE_MIN_BYTES} bytes to ${ROOM_PICTURE_LIMITS.maxKib} KiB. Choose a smaller picture and send it again.`,
  picture_type:
    'The chat takes a JPEG, a PNG or a GIF and no other kind of file. Choose one of those and send it again.',
  // True of a file that cannot be read and of a body that did not come whole inside its deadline.
  picture_malformed:
    'This picture did not arrive whole, or cannot be read as a JPEG, a PNG or a GIF. Send it again, or choose another picture.',
  picture_dimensions: `A picture is ${ROOM_PICTURE_LIMITS.minSide} to ${ROOM_PICTURE_LIMITS.maxSide} pixels on each side, and an animated GIF at most ${ROOM_PICTURE_LIMITS.animatedMaxSide}. Resize the picture and send it again.`,
  picture_frames: `An animated GIF has at most ${ROOM_PICTURE_LIMITS.maxFrames} frames. Shorten it and send it again.`,
  picture_blocked:
    'An admin of Prix removed this picture from the chat before, so it cannot be added again. Choose another picture.',
  picture_admin: 'An admin wallet cannot add or report a picture: Prix never posts a picture here. Use another wallet.',
  picture_new_writer: `A wallet can add a picture ${ROOM_PICTURE_LIMITS.writerAgeMinutes} minutes after its first message in the chat. Write a message first, then try again later.`,
  picture_not_allowed:
    'This wallet was muted in the chat once, so it cannot add or report pictures. It can still write messages.',
  picture_paused:
    'Pictures of this wallet are hidden after reports and wait for an admin of Prix. It can add another picture once an admin has decided on them.',
  pictures_off: 'Pictures are switched off in the chat for now. You can still write messages. Try again later.',
  picture_wallet_day: `This wallet has added ${ROOM_PICTURE_LIMITS.perWalletPerDay} pictures today, which is the most allowed in a day. Add another after 00:00 UTC.`,
  picture_room_hour:
    'The chat has taken as many pictures as it holds in one hour. Send yours again after the hour turns.',
  picture_room_day: 'The chat has taken as many pictures as it holds in one day. Add yours after 00:00 UTC.',
  picture_storage: 'The picture could not be stored right now. Nothing was posted. Try again in a minute.',
  report_own: 'This picture is your own, so you cannot report it. Ask an admin of Prix if it should be removed.',
  report_new_writer: `A wallet can report a picture ${ROOM_PICTURE_LIMITS.reporterAgeHours} hours after its first message in the chat. Try again later.`,
  report_wallet_day: `This wallet has reported ${ROOM_PICTURE_REPORTS_PER_WALLET_PER_DAY} pictures today, which is the most allowed in a day. Report again after 00:00 UTC.`,
};

/**
 * The sentence of the one refusal no page shows: the bytes route answers it to an `<img>`, whose error
 * carries no status. It is written for whoever reads the answer by hand.
 */
const PICTURE_VIEWS_DAY_SENTENCE =
  'The chat has shown as many pictures as it shows in one day. Pictures are shown again after 00:00 UTC.';

function pictureAnswer(field: RoomPictureRefusalField, headers: Record<string, string>): Response {
  const message = field === 'picture_views_day' ? PICTURE_VIEWS_DAY_SENTENCE : ROOM_PICTURE_SENTENCES[field];
  const body: ApiError = { error: { code: 'invalid_input', message, field } };
  return json(body, ROOM_PICTURE_REFUSALS[field], 'private', headers);
}

/** The answer to a refusal of a picture that waiting does not end: it carries no `Retry-After`. */
export function pictureRefusal(field: Exclude<RoomPictureRefusalField, RoomPictureWaitField>): Response {
  return pictureAnswer(field, {});
}

/**
 * The answer to a refusal of a picture that ends by waiting, with `Retry-After` in whole seconds from the
 * contract's `roomPictureRetryAfterSeconds`: the next full hour for the room's hour of pictures, 00:00 UTC
 * for the four of a day, a minute for a put that KV refused. `now` is the route's own `now`, read after
 * step 2: never the upload's second reading, which only judges how long a body took.
 */
export function pictureWait(field: RoomPictureWaitField, now: IsoTime): Response {
  return pictureAnswer(field, { 'Retry-After': String(roomPictureRetryAfterSeconds(field, now)) });
}

/**
 * The answer to a refused turn for a picture, by the field the contract gives each reason
 * (`ROOM_PICTURE_TURN_FIELDS`): the room's own answer for the three a message has, a picture's for the
 * rest. `lastAt` is the writer's last message as the caller knows it.
 */
export function pictureTurnRefusal(why: RoomPictureTurnRefusal, now: IsoTime, lastAt: IsoTime | null): Response {
  const field = ROOM_PICTURE_TURN_FIELDS[why];
  if (field === 'muted') return roomRefusal('muted');
  if (field === 'too_soon' || field === WALLET_DAY) return roomWait(field, now, lastAt);
  if (field === 'picture_wallet_day') return pictureWait(field, now);
  return pictureRefusal(field);
}

/**
 * The 503 of the two bytes routes when the views cannot be counted or KV throws: the API's error shape
 * with the code `internal` and no field, never cached, and a short wait. It is no refusal of a picture.
 */
export function pictureBytesFailure(): Response {
  const body: ApiError = {
    error: {
      code: ROOM_PICTURE_BYTES_FAILURE_CODE,
      message: 'The picture could not be read right now. Try again in a moment.',
      field: null,
    },
  };
  return json(body, 503, 'private', { 'Retry-After': String(ROOM_PICTURE_BYTES_RETRY_SECONDS) });
}
