import {
  ROOM_MESSAGES_PER_WALLET_PER_DAY,
  ROOM_PAGE,
  ROOM_PICTURE_REPORT_STRIKES,
  ROOM_PICTURE_TEXT,
  ROOM_PICTURES_PATH,
  ROOM_PICTURES_PER_WALLET_PER_DAY,
  ROOM_REPORTED_PICTURES_PAUSE,
  ROOM_SCAN,
  ROOM_SECONDS_BETWEEN,
  roomMeResponseSchema,
  roomMeWithPicturesResponseSchema,
  roomPictureViewsKey,
  roomResponseSchema,
  roomWithPicturesResponseSchema,
} from '@prix/contracts';
import { describe, expect, it } from 'vitest';
import { shortAddress } from '../../views.ts';
import {
  ADMIN,
  createHarness,
  DAY,
  errorOf,
  type Harness,
  HOLDER,
  OTHER,
  SITE_HOST,
  START,
  stepsOf,
  TOKEN,
} from './test-support.ts';
import { gifBytes } from './test-support-pictures.ts';

/**
 * The room's read and `me` with pictures, against docs/contracts/phase-6-pictures.md section 10: what each
 * carries while pictures are enabled, and that both answer as Phase 6.3 does while they are not.
 */

const VIEWS_KEY = roomPictureViewsKey(DAY);
const POSTED = '2026-10-20T11:00:00.000Z';
const FACTS = { type: 'gif', width: 16, height: 16, bytes: 37, frames: 1 };
/** A first message two days old: old enough for a picture and for a report. */
const LONG_AGO = '2026-10-18T12:00:00.000Z';
/** A first message two hours old: old enough for a picture, and a day too young for a report. */
const TWO_HOURS_AGO = '2026-10-20T10:00:00.000Z';
/** A first message 59 minutes old: a minute too young for a picture. */
const NOT_AN_HOUR_AGO = '2026-10-20T11:01:00.000Z';
/** Five seconds before the harness's clock: inside the seconds between two messages. */
const A_MOMENT_AGO = '2026-10-20T11:59:55.000Z';

describe('GET /api/social/room while pictures are enabled', () => {
  it('answers each message with its picture, null for a message of text, as one cached read', async () => {
    const h = createHarness({ pictures: true });
    h.room.seed(HOLDER, 'a line', '2026-10-20T10:00:00.000Z');
    h.pictures.seedPicture(OTHER, POSTED);
    const reply = await h.fetch('GET', '/api/social/room');
    expect(reply.status).toBe(200);
    expect(reply.headers.get('Cache-Control')).toBe('public, max-age=30');
    expect(roomWithPicturesResponseSchema.parse(reply.json)).toEqual({
      on: true,
      messages: [
        {
          id: 2,
          at: POSTED,
          authorShort: shortAddress(OTHER),
          admin: false,
          text: ROOM_PICTURE_TEXT,
          picture: { ...FACTS, state: 'shown' },
        },
        {
          id: 1,
          at: '2026-10-20T10:00:00.000Z',
          authorShort: shortAddress(HOLDER),
          admin: false,
          text: 'a line',
          picture: null,
        },
      ],
      pictures: 'on',
      prixAddress: TOKEN,
      siteHost: SITE_HOST,
    });
    expect(stepsOf(h.trace)).toEqual([`pictures.readRoom:${ROOM_PAGE}:${ROOM_SCAN}:${VIEWS_KEY}`, 'prixAddress']);
    expect(h.trace).not.toContain('store.getSession');
  });

  it('says of each picture what the bytes route would: reported, gone by age, by a lost key and by an admin wallet', async () => {
    const h = createHarness({ pictures: true });
    h.pictures.seedPicture(HOLDER, POSTED, { state: 'reported', reports: 3 });
    h.pictures.seedPicture(HOLDER, '2026-10-13T12:00:00.000Z');
    h.pictures.seedPicture(HOLDER, POSTED, { key: null });
    h.pictures.seedPicture(ADMIN, POSTED);
    h.pictures.seedPicture(HOLDER, POSTED, { state: 'kept' });
    const body = roomWithPicturesResponseSchema.parse((await h.fetch('GET', '/api/social/room')).json);
    expect(body.messages.map((message) => message.picture?.state)).toEqual([
      'shown',
      'gone',
      'gone',
      'gone',
      'reported',
    ]);
  });

  it('answers no key, no hash, no count of reports and no whole address', async () => {
    const h = createHarness({ pictures: true });
    const stored = h.pictures.seedPicture(HOLDER, POSTED, { state: 'reported', reports: 3 });
    const reply = await h.fetch('GET', '/api/social/room');
    expect(reply.text).not.toContain('pic/');
    expect(reply.text).not.toContain(stored.picture?.sha256 ?? 'none');
    expect(reply.text).not.toContain(HOLDER);
    expect(reply.text).not.toContain('reports');
    expect(reply.text).not.toContain('/api/');
  });

  it.each<[string, (h: Harness) => void, 'on' | 'off' | 'resting']>([
    ['on', () => {}, 'on'],
    ['on one view below the cap', (h) => void h.counters.set(VIEWS_KEY, 99), 'on'],
    ['resting at the cap of views', (h) => void h.counters.set(VIEWS_KEY, 100), 'resting'],
    [
      'off while the switch is set',
      (h) => void Object.assign(h.pictures, { off: { at: START, by: ADMIN, why: 'admin' } }),
      'off',
    ],
    [
      'off before resting',
      (h) => {
        h.counters.set(VIEWS_KEY, 100);
        h.pictures.off = { at: START, by: null, why: 'reports_hour' };
      },
      'off',
    ],
  ])('says that pictures are %s', async (_name, arrange, state) => {
    const h = createHarness({ pictures: true, pictureViewsCap: 100 });
    h.pictures.seedPicture(HOLDER, POSTED);
    arrange(h);
    const body = roomWithPicturesResponseSchema.parse((await h.fetch('GET', '/api/social/room')).json);
    expect(body.pictures).toBe(state);
    // The picture's own state does not change: the page reads `pictures` for the button.
    expect(body.messages[0]?.picture?.state).toBe('shown');
    expect(JSON.stringify(body)).not.toContain(ADMIN);
  });
});

describe('GET /api/social/room while pictures are not enabled', () => {
  it('answers as Phase 6.3 does: neither field, and no picture message', async () => {
    const h = createHarness();
    h.room.seed(HOLDER, 'a line', '2026-10-20T10:00:00.000Z');
    h.pictures.seedPicture(OTHER, POSTED);
    const reply = await h.fetch('GET', '/api/social/room');
    // The older schema is strict: a field it does not know would refuse the answer.
    const body = roomResponseSchema.parse(reply.json);
    expect(body.messages.map((message) => message.id)).toEqual([1]);
    expect(reply.text).not.toContain('picture');
    expect(stepsOf(h.trace)).toEqual([`room.listNewest:${ROOM_PAGE}:${ROOM_SCAN}`, 'prixAddress']);
  });
});

describe('GET /api/social/room/me while pictures are enabled', () => {
  async function me(h: Harness, address: string): Promise<ReturnType<typeof roomMeWithPicturesResponseSchema.parse>> {
    const reply = await h.fetch('GET', '/api/social/room/me', { cookie: await h.signIn(address) });
    expect(reply.status).toBe(200);
    expect(reply.headers.get('Cache-Control')).toBe('no-store');
    return roomMeWithPicturesResponseSchema.parse(reply.json);
  }

  it('answers a wallet that may upload and report, from one read of its row', async () => {
    const h = createHarness({ pictures: true });
    h.room.firstAt.set(HOLDER, LONG_AGO);
    h.pictures.setExtra(HOLDER, { picturesDay: DAY, picturesCount: 1 });
    expect(await me(h, HOLDER)).toEqual({
      write: 'yes',
      left: ROOM_MESSAGES_PER_WALLET_PER_DAY,
      picture: 'yes',
      picturesLeft: ROOM_PICTURES_PER_WALLET_PER_DAY - 1,
      report: true,
    });
    expect(stepsOf(h.trace)).toEqual(['holding:full', 'pictures.getUploader']);
    expect(h.trace).not.toContain('room.getWriter');
  });

  it('answers an admin wallet: it writes, it never uploads and never reports, whatever its row says', async () => {
    const h = createHarness({ pictures: true });
    h.room.firstAt.set(ADMIN, LONG_AGO);
    expect(await me(h, ADMIN)).toEqual({
      write: 'yes',
      left: ROOM_MESSAGES_PER_WALLET_PER_DAY,
      picture: 'admin',
      picturesLeft: 0,
      report: false,
    });
    expect(stepsOf(h.trace)).toEqual([]);
  });

  type Arrange = (h: Harness) => void;
  it.each<[string, Arrange, { write: string; picture: string; picturesLeft: number; report: boolean }]>([
    [
      'no row at all',
      (h) => h.room.firstAt.delete(HOLDER),
      { write: 'yes', picture: 'new_writer', picturesLeft: 0, report: false },
    ],
    [
      'a row and no stored message: a turn that stored none, or a first line an admin hid',
      (h) => {
        h.room.firstAt.delete(HOLDER);
        h.room.setWriter(HOLDER, { lastAt: TWO_HOURS_AGO, day: DAY, count: 1 });
      },
      { write: 'yes', picture: 'new_writer', picturesLeft: 0, report: false },
    ],
    [
      'a first message 59 minutes old',
      (h) => h.room.firstAt.set(HOLDER, NOT_AN_HOUR_AGO),
      { write: 'yes', picture: 'new_writer', picturesLeft: 0, report: false },
    ],
    [
      'a first message two hours old: a picture, and no report before a day',
      (h) => h.room.firstAt.set(HOLDER, TWO_HOURS_AGO),
      { write: 'yes', picture: 'yes', picturesLeft: ROOM_PICTURES_PER_WALLET_PER_DAY, report: false },
    ],
    [
      'a mute that was lifted',
      (h) => h.room.setWriter(HOLDER, { cutAt: LONG_AGO }),
      { write: 'yes', picture: 'no', picturesLeft: 0, report: false },
    ],
    [
      'two pictures hidden by reports',
      (h) => {
        for (let n = 0; n < ROOM_REPORTED_PICTURES_PAUSE; n += 1)
          h.pictures.seedPicture(HOLDER, POSTED, { state: 'reported' });
      },
      { write: 'yes', picture: 'no', picturesLeft: 0, report: true },
    ],
    [
      'its pictures of the day made: a wait of pictures, so still yes, with none left',
      (h) => h.pictures.setExtra(HOLDER, { picturesDay: DAY, picturesCount: ROOM_PICTURES_PER_WALLET_PER_DAY }),
      { write: 'yes', picture: 'yes', picturesLeft: 0, report: true },
    ],
    [
      'a message a moment ago: a wait of the room, which changes nothing of pictures',
      (h) => h.room.setWriter(HOLDER, { lastAt: '2026-10-20T11:59:59.000Z' }),
      { write: 'yes', picture: 'yes', picturesLeft: ROOM_PICTURES_PER_WALLET_PER_DAY, report: true },
    ],
    [
      'two strikes: it is told true, so that it does not learn it',
      (h) => h.pictures.setExtra(HOLDER, { reportStrikes: ROOM_PICTURE_REPORT_STRIKES }),
      { write: 'yes', picture: 'yes', picturesLeft: ROOM_PICTURES_PER_WALLET_PER_DAY, report: true },
    ],
    [
      'a mute',
      (h) => h.room.setWriter(HOLDER, { mutedAt: START, cutAt: START }),
      { write: 'muted', picture: 'no', picturesLeft: 0, report: false },
    ],
    [
      'the gate off',
      (h) => void Object.assign(h.holding, { gatingOn: false }),
      { write: 'gate_off', picture: 'no', picturesLeft: 0, report: false },
    ],
    [
      'less than one whole token',
      (h) => void h.holding.tokens.set(HOLDER, 0.5),
      { write: 'not_holder', picture: 'no', picturesLeft: 0, report: false },
    ],
  ])('answers a wallet with %s', async (_name, arrange, expected) => {
    const h = createHarness({ pictures: true });
    h.room.firstAt.set(HOLDER, LONG_AGO);
    arrange(h);
    expect(await me(h, HOLDER)).toMatchObject(expected);
  });

  // Revision 8 of the contract (its section 26), found on production in the first minute a wallet wrote:
  // `picture` is what the row says of pictures (`roomPictureRowRefusal`), and a wait of the room, the
  // seconds between two messages or the wallet's messages of the day, neither hides it nor changes it.
  it('tells a wallet that has just written its first message that it is a new writer, as the upload then does', async () => {
    const h = createHarness({ pictures: true });
    const cookie = await h.signIn(HOLDER);
    const posted = await h.fetch('POST', '/api/social/room', { cookie, body: { text: 'Good morning to the league' } });
    expect(posted.status).toBe(201);
    // Five seconds on: the page asks `me` while the wallet still waits for its next message.
    h.setNow('2026-10-20T12:00:05.000Z');
    expect(await me(h, HOLDER)).toEqual({
      write: 'yes',
      left: ROOM_MESSAGES_PER_WALLET_PER_DAY - 1,
      picture: 'new_writer',
      picturesLeft: 0,
      report: false,
    });
    // 29 seconds after the message, as on production: the wait is over, and the upload gives the same reason.
    h.setNow('2026-10-20T12:00:29.000Z');
    const refused = await h.fetch('POST', ROOM_PICTURES_PATH, { cookie, bytes: gifBytes() });
    expect(refused.status).toBe(403);
    expect(errorOf(refused).field).toBe('picture_new_writer');
    expect(h.pictures.pictures.size).toBe(0);
  });

  describe('inside a wait of the room', () => {
    /** A wait of the room on the holder's row, and what `left` then reads. */
    const waits: [string, Arrange, number][] = [
      [
        `inside its ${ROOM_SECONDS_BETWEEN} seconds`,
        (h) => h.room.setWriter(HOLDER, { lastAt: A_MOMENT_AGO, day: DAY, count: 1 }),
        ROOM_MESSAGES_PER_WALLET_PER_DAY - 1,
      ],
      [
        `at its ${ROOM_MESSAGES_PER_WALLET_PER_DAY} messages of the day`,
        (h) => h.room.setWriter(HOLDER, { lastAt: NOT_AN_HOUR_AGO, day: DAY, count: ROOM_MESSAGES_PER_WALLET_PER_DAY }),
        0,
      ],
    ];
    /** What the row says of pictures, and what `me` answers for it whatever the room's wait. */
    const rows: [string, Arrange, { picture: string; picturesLeft: number; report: boolean }][] = [
      [
        'whose first message is seconds old',
        (h) => h.room.firstAt.set(HOLDER, A_MOMENT_AGO),
        { picture: 'new_writer', picturesLeft: 0, report: false },
      ],
      [
        'whose first message is 59 minutes old',
        (h) => h.room.firstAt.set(HOLDER, NOT_AN_HOUR_AGO),
        { picture: 'new_writer', picturesLeft: 0, report: false },
      ],
      [
        'that has no stored message',
        (h) => h.room.firstAt.delete(HOLDER),
        { picture: 'new_writer', picturesLeft: 0, report: false },
      ],
      [
        'that was muted once and lifted',
        (h) => h.room.setWriter(HOLDER, { cutAt: LONG_AGO }),
        { picture: 'no', picturesLeft: 0, report: false },
      ],
      [
        'whose pictures wait for an admin',
        (h) => {
          for (let n = 0; n < ROOM_REPORTED_PICTURES_PAUSE; n += 1)
            h.pictures.seedPicture(HOLDER, POSTED, { state: 'reported' });
        },
        { picture: 'no', picturesLeft: 0, report: true },
      ],
      [
        'whose first message is older than the hour, with its pictures left',
        (h) => {
          h.room.firstAt.set(HOLDER, TWO_HOURS_AGO);
          h.pictures.setExtra(HOLDER, { picturesDay: DAY, picturesCount: 1 });
        },
        { picture: 'yes', picturesLeft: ROOM_PICTURES_PER_WALLET_PER_DAY - 1, report: false },
      ],
      [
        'at its pictures of the day, with none left',
        (h) => h.pictures.setExtra(HOLDER, { picturesDay: DAY, picturesCount: ROOM_PICTURES_PER_WALLET_PER_DAY }),
        { picture: 'yes', picturesLeft: 0, report: true },
      ],
    ];
    const cases = waits.flatMap(([wait, hurry, left]) =>
      rows.map(([row, arrange, expected]) => [`${row}, ${wait}`, hurry, arrange, left, expected] as const),
    );

    it.each(cases)('answers a wallet %s', async (_name, hurry, arrange, left, expected) => {
      const h = createHarness({ pictures: true });
      h.room.firstAt.set(HOLDER, LONG_AGO);
      arrange(h);
      hurry(h);
      expect(await me(h, HOLDER)).toEqual({ write: 'yes', left, ...expected });
      expect(stepsOf(h.trace)).toEqual(['holding:full', 'pictures.getUploader']);
    });

    it.each(waits)('still answers a muted wallet %s that it is muted', async (_name, hurry) => {
      const h = createHarness({ pictures: true });
      h.room.firstAt.set(HOLDER, LONG_AGO);
      hurry(h);
      h.room.setWriter(HOLDER, { mutedAt: START, cutAt: START });
      expect(await me(h, HOLDER)).toEqual({ write: 'muted', left: 0, picture: 'no', picturesLeft: 0, report: false });
    });
  });

  it('carries no time and nothing of another wallet', async () => {
    const h = createHarness({ pictures: true });
    h.room.firstAt.set(HOLDER, LONG_AGO);
    const reply = await h.fetch('GET', '/api/social/room/me', { cookie: await h.signIn(HOLDER) });
    expect(Object.keys(reply.json).sort()).toEqual(['left', 'picture', 'picturesLeft', 'report', 'write']);
    expect(reply.text).not.toContain('2026');
  });
});

describe('GET /api/social/room/me while pictures are not enabled', () => {
  it('answers as Phase 6.3 does, with none of the three fields', async () => {
    const h = createHarness();
    h.room.firstAt.set(HOLDER, LONG_AGO);
    for (const address of [HOLDER, ADMIN]) {
      const reply = await h.fetch('GET', '/api/social/room/me', { cookie: await h.signIn(address) });
      expect(roomMeResponseSchema.parse(reply.json)).toEqual({ write: 'yes', left: ROOM_MESSAGES_PER_WALLET_PER_DAY });
    }
    expect(h.trace).toContain('room.getWriter');
    expect(h.trace).not.toContain('pictures.getUploader');
  });
});
