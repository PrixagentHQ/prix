import type { RoomMessage, RoomPictureMessage, RoomPictureView, RoomWithPicturesResponse } from '@prix/contracts';
import {
  ROOM_PAGE,
  ROOM_PICTURE_MAX_BYTES,
  ROOM_PICTURE_MAX_FRAMES,
  ROOM_PICTURE_MAX_SIDE,
  ROOM_PICTURE_MIN_SIDE,
  ROOM_PICTURE_TEXT,
  ROOM_TEXT_MAX,
} from '@prix/contracts';

/**
 * SAMPLE DATA of the Community chat (the room, docs/contracts/phase-6-room.md). Used only when the site is
 * built with PRIX_FIXTURES=1; a production build never reaches this file. Every writer, time and message
 * below is invented for reviewing the page. Nobody wrote them.
 *
 * `?fixture=` takes names separated by commas, as every group does. The room's group, beside the Phase 6
 * names of ../fixtures.ts (`social-off` and `social-error` take the room with them):
 *
 *   (none)                 the room is on, with a short conversation and one message of an admin.
 *   social-room-empty      on, and nothing to show.
 *   social-room-full       a full page: the 50 messages a read answers at most.
 *   social-room-admin      a message of an admin beside a message that only uses the name in its text.
 *   social-room-longest    a message at the longest length, and one made of the longest words the rule takes.
 *   social-room-no-token   the token has no address yet: the note on the token is left out.
 *   social-room-markup     NOT what the API answers: texts the text rule refuses (tags, a link, 280
 *                          characters without a space), to see that the page prints any text as text.
 *   social-room-error      the status answers on and the read fails with 500.
 *   social-room-off        the room is off: its status and its read answer 404; the rest of Phase 6 is on.
 *
 * Pictures (docs/contracts/phase-6-pictures.md). The states above are what the API answers before
 * pictures: no message carries `picture` and the read carries no `pictures`. In the states below it
 * carries both. No file stands behind a sample picture: its type, sides, size and frames are invented
 * (no size is above ROOM_PICTURE_MAX_BYTES: the read's schema refuses a larger one), and
 * a sample build has no bytes route, so "Show picture" ends there as a load that failed (check-pages.mjs
 * answers the address with a picture it draws itself).
 *
 *   social-room-pictures          pictures are on: text beside a picture of every type and in every
 *                                 state (shown, reported, gone), an animated GIF at the most frames, the
 *                                 smallest and the largest file, the widest and the tallest picture, and
 *                                 a picture whose writer is an admin wallet now, which is gone.
 *   social-room-pictures-off      the same messages while pictures are switched off.
 *   social-room-pictures-resting  the same messages while the day's views are used up.
 *   social-room-pictures-full     a full page of 50 pictures, every one of them shown.
 *   social-room-pictures-empty    pictures are on and the room has nothing to show.
 *
 * Holders (docs/contracts/phase-6-holders-2.md, section 2.1). While ROOM_HOLDERS is on the read sends
 * `holder` on every message, from the writer's stored token row; an admin's is always false.
 *
 *   social-room-pictures-holders  text and pictures with pictures on, some writers holders and some not,
 *                                 and an admin's message, whose `holder` is false.
 */

export const ROOM_FIXTURES = [
  'social-room-empty',
  'social-room-full',
  'social-room-admin',
  'social-room-longest',
  'social-room-no-token',
  'social-room-markup',
  'social-room-error',
  'social-room-off',
  'social-room-pictures',
  'social-room-pictures-off',
  'social-room-pictures-resting',
  'social-room-pictures-full',
  'social-room-pictures-empty',
  'social-room-pictures-holders',
] as const;
export type RoomFixture = (typeof ROOM_FIXTURES)[number];

export type RoomFixtureAnswer =
  | { kind: 'data'; data: unknown }
  | { kind: 'error'; status: number; code: 'not_found' | 'internal'; message: string };

/** The room's state that `fixture` names, or null when it names none. The first of its names decides. */
export function roomFixtureOf(fixture: string | null): RoomFixture | null {
  for (const name of (fixture ?? '').split(',')) {
    const known = ROOM_FIXTURES.find((entry) => entry === name.trim());
    if (known) return known;
  }
  return null;
}

/** The sample's one address and one host a message may hold. The address is the token fixture's, not $PRIX's. */
export const ROOM_SAMPLE_PRIX_ADDRESS = '0x1111111111111111111111111111111111111111';
export const ROOM_SAMPLE_SITE_HOST = 'prixagent.com';

const WRITERS = [
  '0x7a3f…c91e',
  '0x51d0…8e2b',
  '0xa04c…17f3',
  '0x2be9…44a0',
  '0xd3c8…0b51',
  '0x3f62…a9e7',
  '0xc5a1…20f8',
] as const;
const ADMIN = '0x9e14…6c2d';

/** The newest sample message was written at this time; each one before it is a few minutes older. */
const NEWEST_AT = Date.parse('2026-10-09T18:42:10.000Z');
const NEWEST_ID = 1_284;

function message(index: number, text: string, admin = false): RoomMessage {
  // Uneven gaps, so that a page of 50 reaches back over midnight UTC and shows two days.
  const minutesBack = index * 7 + Math.floor(index / 3) * 11 + Math.floor(index / 5) * 23;
  return {
    id: NEWEST_ID - index * 2 - (index % 2),
    at: new Date(NEWEST_AT - minutesBack * 60_000).toISOString(),
    authorShort: admin ? ADMIN : (WRITERS[(index * 3) % WRITERS.length] ?? WRITERS[0]),
    admin,
    text,
  };
}

/** Plain sentences about the league, every one of which the text rule lets through (room.test.ts checks). */
const TALK = [
  'Did the 15:00 UTC round run on time today?',
  'It did. My agent held cash again, third day in a row.',
  'Is there a page that shows how the score is worked out?',
  'Yes, the methodology page has it, with the days an agent needs before it gets a rank.',
  'Momentum Mule and Slow Compounder swapped places again. That rivalry page is fun to watch.',
  'How long does a new holding take before the chat lets a wallet write?',
  'Within 15 minutes, then reload the page. It says so under the box.',
  'Does anyone else watch the model war? Day 6 of 10 and the two are almost level.',
  'Paper portfolios only, right? No real orders anywhere in the league?',
  'Right. It is a simulation, and the footer says so on every page.',
  'My agent made no decision at 16:00 UTC. The page says the model answer was not valid JSON.',
  'Same here last week. It decided again at the next round without me changing anything.',
  'Why is my agent shown but not ranked yet?',
  'It needs five trading days first. Mine got its rank on day six.',
  'The market was closed on Friday, so nothing filled. The page said so, which I liked.',
  'Can a prompt be changed after the agent is built?',
  'Yes, from the account page. The profile starts its window again from that day.',
  'Three agents hold SGOV as their largest position this week. Interesting.',
] as const;

const page = (texts: readonly string[]): RoomMessage[] => texts.map((text, index) => message(index, text));

const FULL = page(Array.from({ length: ROOM_PAGE }, (_, index) => TALK[index % TALK.length] ?? TALK[0]));

const ADMIN_NOTE = 'The chat is open. Keep it civil, and remember that nothing written here is advice.';

const SHORT: RoomMessage[] = [
  ...page(TALK.slice(0, 4)),
  message(4, ADMIN_NOTE, true),
  ...TALK.slice(4, 9).map((text, index) => message(index + 5, text)),
];

/** The contract's own example of a line that passes by nature: the name in the text is not the mark. */
const NAME_IN_TEXT = 'Prix here, the chat moves';

const WITH_ADMIN: RoomMessage[] = [
  message(0, NAME_IN_TEXT),
  message(1, ADMIN_NOTE, true),
  message(2, 'Is that first message from Prix? It has no mark.'),
  message(3, 'The round of 19:00 UTC is the last one today. The next is tomorrow at 15:00 UTC.', true),
];

/** Two texts of exactly ROOM_TEXT_MAX characters (room.test.ts counts them). */
const LONG_ONE =
  'This message is as long as the chat takes. It is here to show how a full one sits on a narrow screen and on a wide one: where the lines break, how far the text runs under the writer and the time, and whether the page still reads as a list once every message is this long. The end.';
const LONG_FROM_ADMIN =
  "A note from an admin wallet at the longest length, so that the mark and a long text meet. The league runs its rounds at 15:00, 16:00, 17:00, 18:00 and 19:00 UTC on trading days, the market's own closed days are skipped, and nothing in this chat changes what an agent does. Thanks.";

const LONGEST: RoomMessage[] = [
  message(0, LONG_ONE),
  // Twenty-five letters: one more and the rule reads a word as an address.
  message(1, 'Antidisestablishmentarian Antidisestablishmentarian Antidisestablishmentarian'),
  message(2, 'Ok'),
  message(3, LONG_FROM_ADMIN, true),
];

/**
 * Texts the API never answers, because `roomTextProblem` refuses each of them. The page does not rest on
 * that: whatever a message holds is printed as text, and wraps.
 */
const MARKUP: RoomMessage[] = [
  message(0, '<script>document.title = "room-markup-ran"</script>'),
  message(1, '<img src="x" onerror="document.title = \'room-markup-ran\'"> <b>bold</b> &amp; <i>italic</i>'),
  message(2, '</p></li></ol></section><h1>Prix</h1>'),
  message(3, 'Visit https://prixagent.example/claim or www.prixagent.example and write to help@prixagent.example'),
  message(4, 'W'.repeat(ROOM_TEXT_MAX)),
  message(5, '{{ 7 * 7 }} <%= 7 * 7 %> &lt;escaped once already&gt; "double" \'single\' `tick`', true),
  message(6, 'Call +62 812 3456 7890 or 0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'),
];

/** A sample picture as the read gives it. Its figures are invented: no file stands behind them. */
function picture(
  type: RoomPictureView['type'],
  width: number,
  height: number,
  bytes: number,
  more: Partial<Pick<RoomPictureView, 'frames' | 'state'>> = {},
): RoomPictureView {
  return { type, width, height, bytes, frames: 1, state: 'shown', ...more };
}

/** Message `index` of a page as a picture message: the contract's word as its text, which no page shows. */
const pictured = (index: number, view: RoomPictureView, admin = false): RoomPictureMessage => ({
  ...message(index, ROOM_PICTURE_TEXT, admin),
  picture: view,
});
/** Message `index` of a page as text, the way the API answers it while pictures are enabled. */
const worded = (index: number, text: string, admin = false): RoomPictureMessage => ({
  ...message(index, text, admin),
  picture: null,
});

const SIDE = ROOM_PICTURE_MAX_SIDE;

/** Text beside a picture of every type and in every state, at the limits a file has. */
const WITH_PICTURES: RoomPictureMessage[] = [
  worded(0, 'Here is the chart of my agent from this week.'),
  pictured(1, picture('jpeg', 1_600, 1_200, 187_904)),
  worded(2, 'And the round of 15:00 UTC as it ran, frame by frame.'),
  pictured(3, picture('gif', 480, 270, 249_216, { frames: ROOM_PICTURE_MAX_FRAMES })),
  pictured(4, picture('png', SIDE, 256, 201_728)),
  pictured(5, picture('png', 800, 600, 96_300, { state: 'reported' })),
  worded(6, ADMIN_NOTE, true),
  pictured(7, picture('jpeg', 1_280, 720, 143_360, { state: 'gone' })),
  pictured(8, picture('png', 512, SIDE, 229_530)),
  pictured(9, picture('gif', ROOM_PICTURE_MIN_SIDE, ROOM_PICTURE_MIN_SIDE, 96)),
  pictured(10, picture('jpeg', SIDE, SIDE, ROOM_PICTURE_MAX_BYTES)),
  // Posted before its writer became an admin wallet: the read gives it as gone, and no page shows it.
  pictured(11, picture('png', 640, 480, 58_200, { state: 'gone' }), true),
  worded(12, 'Thanks. The second one is easier to read on a phone.'),
];

/** A full page of pictures, all of them shown: what a page asks for before any click is nothing. */
const FULL_OF_PICTURES: RoomPictureMessage[] = Array.from({ length: ROOM_PAGE }, (_, index) => {
  const type = (['jpeg', 'png', 'gif'] as const)[index % 3] ?? 'jpeg';
  // From 40 KB up to the largest file the contract takes, which the last one is.
  const bytes = Math.min(ROOM_PICTURE_MAX_BYTES, 40_960 + index * 4_608);
  // An animated GIF is at most 512 pixels a side; every second sample GIF moves.
  if (type === 'gif' && index % 2 === 0) return pictured(index, picture(type, 480, 270, bytes, { frames: 12 + index }));
  return pictured(index, picture(type, 640 + (index % 5) * 160, 480 + (index % 4) * 120, bytes));
});

/**
 * A conversation while ROOM_HOLDERS is on: every message says `holder`, true for some writers and false for
 * others, never true for an admin. Which writer holds is invented; the server decides it from a stored row.
 */
const WITH_HOLDERS: RoomPictureMessage[] = WITH_PICTURES.slice(0, 9).map((entry, index) => ({
  ...entry,
  holder: !entry.admin && index % 3 !== 2,
}));

const PICTURES_OF: Partial<Record<RoomFixture, NonNullable<RoomWithPicturesResponse['pictures']>>> = {
  'social-room-pictures-holders': 'on',
  'social-room-pictures': 'on',
  'social-room-pictures-off': 'off',
  'social-room-pictures-resting': 'resting',
  'social-room-pictures-full': 'on',
  'social-room-pictures-empty': 'on',
};

const MESSAGES: Record<RoomFixture, RoomPictureMessage[] | null> = {
  'social-room-empty': [],
  'social-room-full': FULL,
  'social-room-admin': WITH_ADMIN,
  'social-room-longest': LONGEST,
  'social-room-no-token': SHORT,
  'social-room-markup': MARKUP,
  'social-room-error': null,
  'social-room-off': null,
  'social-room-pictures': WITH_PICTURES,
  'social-room-pictures-off': WITH_PICTURES,
  'social-room-pictures-resting': WITH_PICTURES,
  'social-room-pictures-full': FULL_OF_PICTURES,
  'social-room-pictures-empty': [],
  'social-room-pictures-holders': WITH_HOLDERS,
};

/** What `GET /api/social/room` answers in the state that `fixture` names; null where it answers no page. */
export function roomSample(fixture: string | null): RoomWithPicturesResponse | null {
  const state = roomFixtureOf(fixture);
  const messages = state === null ? SHORT : MESSAGES[state];
  if (messages === null) return null;
  const pictures = state === null ? undefined : PICTURES_OF[state];
  return {
    on: true,
    messages,
    prixAddress: state === 'social-room-no-token' ? null : ROOM_SAMPLE_PRIX_ADDRESS,
    siteHost: ROOM_SAMPLE_SITE_HOST,
    // The field is absent in an answer of the API before pictures, never undefined in it.
    ...(pictures === undefined ? {} : { pictures }),
  };
}

const NOT_FOUND: RoomFixtureAnswer = {
  kind: 'error',
  status: 404,
  code: 'not_found',
  message: 'No route matches this path.',
};

/**
 * What the API would answer a GET of the room's status or of the room, in the state that `fixture` names.
 * The read takes no query, so a path with one is answered as the path alone. The session's read (`me`) is
 * not answered here: the composer asks it from the browser and has samples of its own.
 */
export function roomAnswer(fixture: string | null, path: string): RoomFixtureAnswer {
  const state = roomFixtureOf(fixture);
  const route = path.split('?')[0] ?? '';
  if (state === 'social-room-off') return NOT_FOUND;
  if (route === '/api/social/room/status') return { kind: 'data', data: { on: true } };
  if (route !== '/api/social/room') return NOT_FOUND;
  const sample = roomSample(fixture);
  if (sample === null) {
    return { kind: 'error', status: 500, code: 'internal', message: 'Something went wrong on our side. Try again.' };
  }
  return { kind: 'data', data: sample };
}
