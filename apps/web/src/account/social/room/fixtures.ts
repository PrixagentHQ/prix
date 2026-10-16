import type {
  RoomAdminPicture,
  RoomAdminWithPicturesResponse,
  RoomMeResponse,
  RoomMeWithPicturesResponse,
  RoomPictureRefusalField,
  RoomPicturesAdminResponse,
  RoomRefusalField,
} from '@prix/contracts';
import type { Answer } from './answers.ts';
import type { RoomCall } from './client.ts';

/**
 * SAMPLE DATA. Used only when the site is built with PRIX_FIXTURES=1; a production build never reaches
 * this file. Every address, time and line below is invented for reviewing the composer and the admins'
 * page of the Community chat.
 *
 * `?fixture=` takes names separated by commas (the other groups keep theirs: `signed-in` and
 * `signed-in-admin` of src/lib/fixtures decide who is asking). The names of these two screens:
 *
 *   The composer's `me` (none: a holder with 12 messages left today)
 *     social-room-me-last      a holder with one message left
 *     social-room-me-used      a holder whose day is used up
 *     social-room-me-below     holds less than one whole $PRIX
 *     social-room-me-muted     muted
 *     social-room-me-gate-off  the token gate is off
 *     social-room-me-ended     the session has ended (401)
 *     social-room-me-fails     the check fails (500)
 *     social-room-me-holders   ROOM_HOLDERS is on: `me` carries `dayCap` (60 for a writer, 30 otherwise);
 *                              it goes with any name above
 *
 *   The send (none: 201)
 *     social-room-send-<field>  refused with that field of ROOM_REFUSALS, dashes for underscores:
 *                               social-room-send-text-bait, social-room-send-too-soon, ...
 *     social-room-send-limit    refused by `requireWriter` (429 rate_limited)
 *     social-room-send-day      refused by `requireWriter` (503 daily_limit)
 *     social-room-send-unknown  refused with a field this page does not know
 *     social-room-send-ended    the session has ended (401)
 *     social-room-send-closed   the chat was switched off (404)
 *     social-room-send-fails    a fault of the server (500)
 *
 *   The admins' page (none: six messages, one of each kind, and an older page)
 *     social-room-mod-empty        nothing stored
 *     social-room-mod-fails        the read fails (500)
 *     social-room-mod-gone         a control answers the generic 404
 *     social-room-mod-refused      "Mute writer" answers 400 with the field admin
 *     social-room-mod-limit        a control is refused by `requireWriter` (429)
 *     social-room-mod-ended        the session has ended (401)
 *     social-room-mod-write-fails  a control fails (500)
 *
 *   Pictures in the composer's `me` (none: this wallet may add 3 more pictures today, and may report)
 *     social-room-me-pic-last   one picture left today
 *     social-room-me-pic-used   the wallet's pictures of the day are used up
 *     social-room-me-pic-admin  an admin wallet: it cannot add a picture
 *     social-room-me-pic-new    the first message is not an hour old
 *     social-room-me-pic-no     this wallet adds no picture, and the page does not say why
 *     social-room-me-pic-none   an API older than pictures: `me` carries nothing of them
 *   Whether pictures are on is the page's own: the list of messages carries it (the other owner's).
 *
 *   The upload (none: 201)
 *     social-room-pic-<field>   refused with that field of ROOM_PICTURE_REFUSALS, dashes for underscores:
 *                               social-room-pic-picture-blocked, social-room-pic-pictures-off, ...
 *     social-room-pic-too-soon  refused with the room's own field
 *     social-room-pic-limit     refused by the writer's budget (429 rate_limited)
 *     social-room-pic-ended     the session has ended (401)
 *     social-room-pic-closed    pictures are not enabled any more (404)
 *     social-room-pic-fails     a fault of the server (500)
 *
 *   A report (none: 204)
 *     social-room-report-own, -day, -new   refused: the wallet's own picture, its reports of the day,
 *                                          a first message not a day old
 *     social-room-report-closed            the picture takes no report (the generic 404)
 *     social-room-report-ended, -fails     the session has ended (401), a fault of the server (500)
 *
 *   Pictures on the admins' page (none: pictures are on, two reported pictures wait, four in the list)
 *     social-room-pics-off       switched off by an admin
 *     social-room-pics-auto-off  switched off by the count of pictures hidden in one hour
 *     social-room-pics-none      no reported picture waits
 *     social-room-pics-many      more reported pictures wait than the page shows
 *     social-room-pics-fails     the read of the reported pictures fails (500)
 *     social-room-pics-old-api   an API older than pictures: no picture in the list, no such read (404)
 *     The controls of a picture answer as the other controls do (social-room-mod-*).
 */

/** The status of each refusal, as ROOM_REFUSALS has it. A new field does not compile without its line. */
const REFUSAL_STATUS: Record<RoomRefusalField, number> = {
  text_empty: 400,
  text_length: 400,
  text_characters: 400,
  text_address: 400,
  text_cashtag: 400,
  text_link: 400,
  text_number: 400,
  text_bait: 400,
  text_spelled: 400,
  text_words: 400,
  not_holder: 403,
  gate_off: 403,
  muted: 403,
  too_soon: 429,
  wallet_day: 429,
  room_hour: 429,
  room_day: 429,
  admin: 400,
};

const MESSAGE = 'A sample answer of the fixtures.';

function namesOf(fixture: string | null): Set<string> {
  return new Set((fixture ?? '').split(',').map((name) => name.trim()));
}

function failure(status: number, code: string, field: string | null = null): Answer {
  return { status, body: { error: { code, message: MESSAGE, field } } };
}

/** The status of each refusal of pictures, as ROOM_PICTURE_REFUSALS has it. A new field does not compile without its line. */
const PICTURE_REFUSAL_STATUS: Record<RoomPictureRefusalField, number> = {
  picture_size: 400,
  picture_type: 400,
  picture_malformed: 400,
  picture_dimensions: 400,
  picture_frames: 400,
  picture_blocked: 403,
  picture_admin: 403,
  picture_new_writer: 403,
  picture_not_allowed: 403,
  picture_paused: 403,
  pictures_off: 403,
  picture_wallet_day: 429,
  picture_room_hour: 429,
  picture_room_day: 429,
  picture_views_day: 429,
  picture_storage: 503,
  report_own: 400,
  report_new_writer: 403,
  report_wallet_day: 429,
};

/** What `me` says of pictures, by the fixture's name; nothing for an API older than pictures. */
function pictureOfMe(
  names: Set<string>,
  write: RoomMeResponse['write'],
): Pick<RoomMeWithPicturesResponse, 'picture' | 'picturesLeft' | 'report'> {
  if (names.has('social-room-me-pic-none')) return {};
  if (write !== 'yes') return { picture: 'no', picturesLeft: 0, report: false };
  if (names.has('social-room-me-pic-admin')) return { picture: 'admin', picturesLeft: 0, report: false };
  if (names.has('social-room-me-pic-new')) return { picture: 'new_writer', picturesLeft: 0, report: false };
  if (names.has('social-room-me-pic-no')) return { picture: 'no', picturesLeft: 0, report: false };
  if (names.has('social-room-me-pic-used')) return { picture: 'yes', picturesLeft: 0, report: true };
  if (names.has('social-room-me-pic-last')) return { picture: 'yes', picturesLeft: 1, report: true };
  return { picture: 'yes', picturesLeft: 3, report: true };
}

function me(names: Set<string>): Answer {
  // ROOM_HOLDERS on (docs/contracts/phase-6-holders-2.md section 2.2): `me` carries the wallet's cap of the day.
  const cap = (write: RoomMeResponse['write']): Pick<RoomMeResponse, 'dayCap'> =>
    names.has('social-room-me-holders') ? { dayCap: write === 'yes' ? 60 : 30 } : {};
  const answer = (write: RoomMeResponse['write'], left: number): Answer => ({
    status: 200,
    body: { write, left, ...cap(write), ...pictureOfMe(names, write) },
  });
  if (names.has('social-room-me-ended')) return failure(401, 'unauthorized');
  if (names.has('social-room-me-fails')) return failure(500, 'internal');
  if (names.has('social-room-me-below')) return answer('not_holder', 0);
  if (names.has('social-room-me-muted')) return answer('muted', 0);
  if (names.has('social-room-me-gate-off')) return answer('gate_off', 0);
  if (names.has('social-room-me-used')) return answer('yes', 0);
  if (names.has('social-room-me-last')) return answer('yes', 1);
  return answer('yes', 12);
}

function sent(names: Set<string>): Answer {
  for (const name of names) {
    if (!name.startsWith('social-room-send-')) continue;
    const word = name.slice('social-room-send-'.length);
    if (word === 'limit') return failure(429, 'rate_limited');
    if (word === 'day') return failure(503, 'daily_limit');
    if (word === 'unknown') return failure(400, 'invalid_input', 'text_future_rule');
    if (word === 'ended') return failure(401, 'unauthorized');
    if (word === 'closed') return failure(404, 'not_found');
    if (word === 'fails') return failure(500, 'internal');
    const field = word.replaceAll('-', '_');
    if (Object.hasOwn(REFUSAL_STATUS, field)) {
      return failure(REFUSAL_STATUS[field as RoomRefusalField], 'invalid_input', field);
    }
  }
  return {
    status: 201,
    body: {
      message: {
        id: 48,
        at: '2026-10-11T12:30:00.000Z',
        authorShort: '0x1111…1111',
        admin: false,
        text: 'A sample message of the fixtures.',
      },
      left: 11,
    },
  };
}

/**
 * What the API would answer an upload. The 201 carries the message as it was stored; no script reads it.
 * The file that would have been sent is kept on the window of the sample page, for the page driver
 * (./check-pictures.mjs) to read what the composer made of a chosen picture. A sample build only.
 */
function uploaded(names: Set<string>, call: RoomCall): Answer {
  (globalThis as { prixSampleUpload?: Blob }).prixSampleUpload = call.bytes;
  for (const name of names) {
    if (!name.startsWith('social-room-pic-')) continue;
    const word = name.slice('social-room-pic-'.length);
    if (word === 'limit') return failure(429, 'rate_limited');
    if (word === 'ended') return failure(401, 'unauthorized');
    if (word === 'closed') return failure(404, 'not_found');
    if (word === 'fails') return failure(500, 'internal');
    const field = word.replaceAll('-', '_');
    if (Object.hasOwn(PICTURE_REFUSAL_STATUS, field)) {
      return failure(PICTURE_REFUSAL_STATUS[field as RoomPictureRefusalField], 'invalid_input', field);
    }
    if (Object.hasOwn(REFUSAL_STATUS, field)) {
      return failure(REFUSAL_STATUS[field as RoomRefusalField], 'invalid_input', field);
    }
  }
  return {
    status: 201,
    body: {
      message: {
        id: 52,
        at: '2026-10-11T12:40:00.000Z',
        authorShort: '0x1111…1111',
        admin: false,
        text: 'Picture',
        picture: { type: 'jpeg', width: 1600, height: 1200, bytes: 211_456, frames: 1, state: 'shown' },
      },
      left: 11,
      picturesLeft: 2,
    },
  };
}

/**
 * What the API would answer a report. Every report a sample page sends is counted on its window, for the
 * page driver (./check-pictures.mjs) to see that a first press sends none and that the yes sends one. A
 * sample build only.
 */
function reported(names: Set<string>): Answer {
  const sample = globalThis as { prixSampleReports?: number };
  sample.prixSampleReports = (sample.prixSampleReports ?? 0) + 1;
  if (names.has('social-room-report-ended')) return failure(401, 'unauthorized');
  if (names.has('social-room-report-fails')) return failure(500, 'internal');
  if (names.has('social-room-report-closed')) return failure(404, 'not_found');
  if (names.has('social-room-report-own')) return failure(400, 'invalid_input', 'report_own');
  if (names.has('social-room-report-new')) return failure(403, 'invalid_input', 'report_new_writer');
  if (names.has('social-room-report-day')) return failure(429, 'invalid_input', 'report_wallet_day');
  return { status: 204, body: null };
}

function control(names: Set<string>, call: RoomCall): Answer {
  if (names.has('social-room-mod-ended')) return failure(401, 'unauthorized');
  if (names.has('social-room-mod-gone')) return failure(404, 'not_found');
  if (names.has('social-room-mod-limit')) return failure(429, 'rate_limited');
  if (names.has('social-room-mod-write-fails')) return failure(500, 'internal');
  if (names.has('social-room-mod-refused') && call.method === 'PUT') return failure(400, 'invalid_input', 'admin');
  return { status: 204, body: null };
}

/** What the API would answer a call of one of the two scripts. */
export function roomFixtureAnswer(fixture: string | null, call: RoomCall): Answer {
  const names = namesOf(fixture);
  const path = call.path.split('?')[0] ?? '';
  if (call.method === 'GET' && path === '/api/social/room/me') return me(names);
  if (call.method === 'POST' && path === '/api/social/room') return sent(names);
  if (call.method === 'POST' && path === '/api/social/room/pictures') return uploaded(names, call);
  if (call.method === 'POST' && /^\/api\/social\/room\/pictures\/[1-9]\d*\/report$/.test(path)) return reported(names);
  if (path.startsWith('/api/social/admin/room/messages/')) return control(names, call);
  if (path.startsWith('/api/social/admin/room/pictures/') && call.method !== 'GET') return control(names, call);
  return failure(404, 'not_found');
}

const HOLDER = '0x1111111111111111111111111111111111111111';
const SECOND = '0x2222222222222222222222222222222222222222';
const MUTED = '0x3333333333333333333333333333333333333333';
const LIFTED = '0x4444444444444444444444444444444444444444';
const ADMIN = '0x5555555555555555555555555555555555555555';

/**
 * What the API would answer the admins' read: one message of each kind the page tells apart. With
 * `before`, the older page, which is the last.
 */
export function roomAdminFixture(
  fixture: string | null,
  before: number | null,
): { kind: 'data'; data: RoomAdminWithPicturesResponse } | { kind: 'error'; status: number } {
  const names = namesOf(fixture);
  if (names.has('social-room-mod-fails')) return { kind: 'error', status: 500 };
  if (names.has('social-room-mod-empty')) return { kind: 'data', data: { messages: [], older: null } };
  const plain = { hidden: false, muted: false, cut: false, admin: false };
  // An API older than pictures answers no `picture` at all; this one answers null for a message of text.
  const old = names.has('social-room-pics-old-api');
  const pictureMessages: RoomAdminWithPicturesResponse['messages'] = old
    ? []
    : [
        { ...plain, id: 51, at: '2026-10-11T12:36:02.000Z', author: SECOND, text: 'Picture', picture: PICTURE_SHOWN },
        { ...plain, id: 50, at: '2026-10-11T12:33:47.000Z', author: THIRD, text: 'Picture', picture: PICTURE_REPORTED },
        { ...plain, id: 49, at: '2026-10-11T12:30:15.000Z', author: HOLDER, text: 'Picture', picture: PICTURE_KEPT },
        {
          ...plain,
          id: 48,
          at: '2026-10-11T12:26:31.000Z',
          author: MUTED,
          hidden: true,
          muted: true,
          cut: true,
          text: 'Picture',
          picture: PICTURE_REMOVED,
        },
      ];
  const ofText = <T extends object>(message: T): T & { picture?: null } =>
    old ? message : { ...message, picture: null };
  if (before !== null) {
    return {
      kind: 'data',
      data: {
        messages: [
          ofText({
            ...plain,
            id: 41,
            at: '2026-10-11T08:02:11.000Z',
            author: SECOND,
            text: 'First line of the day. Good morning.',
          }),
        ],
        older: null,
      },
    };
  }
  return {
    kind: 'data',
    data: {
      messages: [
        ...pictureMessages,
        ...[
          {
            ...plain,
            id: 47,
            at: '2026-10-11T12:21:40.000Z',
            author: HOLDER,
            text: 'Momentum Five held cash again today. Does anyone know which return it could not read?',
          },
          {
            ...plain,
            id: 46,
            at: '2026-10-11T12:14:05.000Z',
            author: ADMIN,
            admin: true,
            text: 'The round of 15:00 UTC on Monday is the first with 25 assets.',
          },
          {
            ...plain,
            id: 45,
            at: '2026-10-11T11:58:32.000Z',
            author: SECOND,
            hidden: true,
            text: 'averyveryverylongwordwithnobreakinitatallaveryveryverylongwordwithnobreakinitatallaveryveryverylongword',
          },
          {
            ...plain,
            id: 44,
            at: '2026-10-11T11:40:19.000Z',
            author: MUTED,
            muted: true,
            cut: true,
            text: 'buy now buy now buy now',
          },
          {
            ...plain,
            id: 43,
            at: '2026-10-11T10:05:54.000Z',
            author: LIFTED,
            cut: true,
            text: 'Which agent has traded the most this season?',
          },
          {
            ...plain,
            id: 42,
            at: '2026-10-11T09:31:07.000Z',
            author: MUTED,
            hidden: true,
            muted: true,
            cut: true,
            text: 'NVDA > AAPL <b>and no markup is ever read</b> & "quotes" stay text',
          },
        ].map(ofText),
      ],
      older: 42,
    },
  };
}

const sha = (letter: string): string => letter.repeat(12);

/** Shown to the public, with one report so far. An animated GIF. */
const PICTURE_SHOWN: RoomAdminPicture = {
  type: 'gif',
  width: 480,
  height: 270,
  bytes: 243_711,
  frames: 48,
  sha256Short: sha('a'),
  state: 'ok',
  reports: 1,
  viewable: true,
  bytesGone: false,
};
/** Hidden after three reports: it waits for an admin. */
const PICTURE_REPORTED: RoomAdminPicture = {
  type: 'jpeg',
  width: 1600,
  height: 1200,
  bytes: 211_456,
  frames: 1,
  sha256Short: sha('b'),
  state: 'reported',
  reports: 3,
  viewable: true,
  bytesGone: false,
};
/** Reported, looked at and kept by an admin. */
const PICTURE_KEPT: RoomAdminPicture = {
  type: 'png',
  width: 1024,
  height: 640,
  bytes: 96_304,
  frames: 1,
  sha256Short: sha('c'),
  state: 'kept',
  reports: 3,
  viewable: true,
  bytesGone: false,
};
/** Removed by an admin; its file is deleted. */
const PICTURE_REMOVED: RoomAdminPicture = {
  type: 'jpeg',
  width: 720,
  height: 960,
  bytes: 143_870,
  frames: 1,
  sha256Short: sha('d'),
  state: 'removed',
  reports: 2,
  viewable: false,
  bytesGone: true,
};
const THIRD = '0x6666666666666666666666666666666666666666';
const REPORTER_ONE = '0x7777777777777777777777777777777777777777';
const REPORTER_TWO = '0x8888888888888888888888888888888888888888';

/**
 * What the API would answer the admins' read of the reported pictures: whether pictures are off and
 * why, and the pictures that wait for a decision, oldest first.
 */
export function roomPicturesAdminFixture(
  fixture: string | null,
): { kind: 'data'; data: RoomPicturesAdminResponse } | { kind: 'error'; status: number } {
  const names = namesOf(fixture);
  if (names.has('social-room-pics-old-api')) return { kind: 'error', status: 404 };
  if (names.has('social-room-pics-fails')) return { kind: 'error', status: 500 };
  const off: RoomPicturesAdminResponse['off'] = names.has('social-room-pics-off')
    ? { at: '2026-10-11T12:04:00.000Z', by: ADMIN, why: 'admin' }
    : names.has('social-room-pics-auto-off')
      ? { at: '2026-10-11T03:12:44.000Z', by: null, why: 'reports_hour' }
      : null;
  if (names.has('social-room-pics-none')) return { kind: 'data', data: { off, reported: [], more: false } };
  return {
    kind: 'data',
    data: {
      off,
      reported: [
        {
          id: 38,
          at: '2026-10-11T07:15:09.000Z',
          author: LIFTED,
          // Its file expired or was lost: nothing is left to look at, and it can still be decided.
          picture: {
            ...PICTURE_REPORTED,
            type: 'png',
            width: 640,
            height: 640,
            bytes: 51_200,
            sha256Short: sha('e'),
            viewable: false,
          },
          reporters: [
            { address: REPORTER_ONE, at: '2026-10-11T07:20:31.000Z' },
            { address: HOLDER, at: '2026-10-11T07:22:02.000Z' },
            { address: REPORTER_TWO, at: '2026-10-11T07:40:57.000Z' },
          ],
        },
        {
          id: 50,
          at: '2026-10-11T12:33:47.000Z',
          author: THIRD,
          picture: PICTURE_REPORTED,
          reporters: [
            { address: HOLDER, at: '2026-10-11T12:34:10.000Z' },
            { address: REPORTER_ONE, at: '2026-10-11T12:34:58.000Z' },
            { address: REPORTER_TWO, at: '2026-10-11T12:35:20.000Z' },
          ],
        },
      ],
      more: names.has('social-room-pics-many'),
    },
  };
}
