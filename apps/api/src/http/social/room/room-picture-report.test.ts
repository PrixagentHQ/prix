import {
  ROOM_PICTURE_AUTO_OFF_REPORTED,
  ROOM_PICTURE_LOG_EVENTS,
  ROOM_PICTURE_REFUSALS,
  ROOM_PICTURE_REPORT_STRIKES,
  ROOM_PICTURE_REPORT_WRITE_ROWS,
  ROOM_PICTURE_REPORTS_PER_DAY,
  ROOM_PICTURE_REPORTS_PER_WALLET_PER_DAY,
  ROOM_PICTURE_REPORTS_TO_HIDE,
  ROOM_REFUSALS,
  ROOM_SCAN,
  type RoomPictureMessageRecord,
  type RoomPictureRefusalField,
  type RoomRefusalField,
  roomPictureReportHidesKey,
  roomPictureReportPath,
  roomPictureReportsKey,
} from '@prix/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { failures } from '../../errors.ts';
import { ROOM_PICTURE_SENTENCES, ROOM_SENTENCES } from './refusals.ts';
import {
  ADMIN,
  createHarness,
  DAY,
  errorOf,
  type Harness,
  HOLDER,
  OTHER,
  type Reply,
  type RequestOptions,
  START,
  STRANGER,
  stepsOf,
  THIRD,
} from './test-support.ts';

/**
 * The report of a picture against docs/contracts/phase-6-pictures.md section 8: the seven steps in their
 * order, each refused once, and what each leaves. A store in memory, no D1.
 */

const REPORTS_KEY = roomPictureReportsKey(DAY);
const HIDES_KEY = roomPictureReportHidesKey(DAY, 12);
/** Two days before the harness's clock: a first message old enough for a report. */
const LONG_AGO = '2026-10-18T12:00:00.000Z';
const POSTED = '2026-10-20T11:00:00.000Z';

/** Pictures on; a picture of OTHER; HOLDER may report. */
async function ready(): Promise<{ h: Harness; cookie: string; picture: RoomPictureMessageRecord }> {
  const h = createHarness({ pictures: true });
  h.room.firstAt.set(HOLDER, LONG_AGO);
  h.room.firstAt.set(THIRD, LONG_AGO);
  const picture = h.pictures.seedPicture(OTHER, POSTED);
  const cookie = await h.signIn(HOLDER);
  h.trace.length = 0;
  return { h, cookie, picture };
}

function report(
  h: Harness,
  cookie: string | undefined,
  id: number | string,
  options: RequestOptions = {},
): Promise<Reply> {
  const path = typeof id === 'number' ? roomPictureReportPath(id) : id;
  return h.fetch('POST', path, { ...(cookie === undefined ? {} : { cookie }), ...options });
}

function expectRefusal(reply: Reply, field: RoomPictureRefusalField | RoomRefusalField): void {
  const room = field in ROOM_REFUSALS;
  expect(reply.status).toBe(
    room ? ROOM_REFUSALS[field as RoomRefusalField] : ROOM_PICTURE_REFUSALS[field as RoomPictureRefusalField],
  );
  expect(errorOf(reply)).toEqual({
    code: 'invalid_input',
    message: room
      ? ROOM_SENTENCES[field as RoomRefusalField]
      : ROOM_PICTURE_SENTENCES[field as keyof typeof ROOM_PICTURE_SENTENCES],
    field,
  });
  expect(reply.headers.get('Cache-Control')).toBe('no-store');
}

function expectDone(reply: Reply): void {
  expect(reply.status).toBe(204);
  expect(reply.text).toBe('');
  expect(reply.headers.get('Cache-Control')).toBe('no-store');
}

async function generic404(h: Harness): Promise<string> {
  const unknown = await h.fetch('GET', '/api/social/no-such-route');
  h.trace.length = 0;
  return unknown.text;
}

async function logged(run: () => Promise<void>): Promise<Record<string, unknown>[]> {
  const lines: Record<string, unknown>[] = [];
  const keep = (text: unknown): void => {
    lines.push(JSON.parse(String(text)) as Record<string, unknown>);
  };
  const log = vi.spyOn(console, 'log').mockImplementation(keep);
  const error = vi.spyOn(console, 'error').mockImplementation(keep);
  try {
    await run();
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
  return lines;
}

const LOOK = (id: number): string => `pictures.lookReport:${id}:${ROOM_SCAN}`;
const BEFORE_LOOK = [`limiter:write:${HOLDER}`, 'holding:cachedOnly'];
/** Step 4 as it stands in the trace: the hand-over to the context first, then what `requireWriter` books. */
const BOOKED = [
  'ctx.waitUntil',
  `limiter:write:${HOLDER}`,
  'store.spendWalletWrite',
  `store.spendApiWrites:${ROOM_PICTURE_REPORT_WRITE_ROWS}`,
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a counted report (section 8, the whole order)', () => {
  it('runs the seven steps in their order and answers 204 with no body', async () => {
    const { h, cookie, picture } = await ready();
    const lines = await logged(async () => {
      expectDone(await report(h, cookie, picture.id));
    });
    expect(stepsOf(h.trace)).toEqual([
      ...BEFORE_LOOK,
      LOOK(picture.id),
      ...BOOKED,
      `pictures.putReport:${picture.id}:${ROOM_SCAN}:${HIDES_KEY}`,
      `counter.take:${REPORTS_KEY}`,
    ]);
    expect(h.pictures.reports).toEqual([{ messageId: picture.id, reporter: HOLDER, at: START }]);
    expect(h.pictures.pictures.get(picture.id)).toMatchObject({ state: 'ok', reports: 1 });
    expect(h.counters.get(REPORTS_KEY)).toBe(1);
    expect(h.spent).toEqual({ walletWrites: 1, rows: ROOM_PICTURE_REPORT_WRITE_ROWS });
    expect(lines).toEqual([]);
    // A report deletes nothing.
    expect(h.trace.filter((step) => step.startsWith('bytes.'))).toEqual([]);
  });

  it('reads the clock once for itself, after step 2: the look and the report are of one reading', async () => {
    const { h, cookie, picture } = await ready();
    h.clock.stepMs = 1_000;
    expectDone(await report(h, cookie, picture.id));
    expect(h.pictures.reports[0]?.at).toBe(h.clock.reads[1]);
    const second = h.trace.indexOf('clock', h.trace.indexOf('clock') + 1);
    expect(h.trace.indexOf('holding:cachedOnly')).toBeLessThan(second);
    expect(second).toBeLessThan(h.trace.indexOf(LOOK(picture.id)));
  });
});

describe('step 1: from the site, the session, the limiter, the id', () => {
  it.each<[string, RequestOptions]>([
    ['another origin', { origin: 'https://evil.test' }],
    ['a form', { contentType: 'application/x-www-form-urlencoded' }],
    ["the upload's content type", { contentType: 'application/octet-stream' }],
  ])("refuses %s with the guard's own answer", async (_name, options) => {
    const { h, cookie, picture } = await ready();
    const reply = await report(h, cookie, picture.id, options);
    expect(reply.status).toBe(403);
    expect(errorOf(reply).message).toBe(failures.badRequestOrigin().message);
    expect(h.trace.filter((step) => !step.startsWith('limiter:read:'))).toEqual([]);
  });

  it('answers 401 without a session, and 429 when the limiter refuses, each with nothing asked of the room', async () => {
    const { h, cookie, picture } = await ready();
    expect((await report(h, undefined, picture.id)).status).toBe(401);
    expect(stepsOf(h.trace)).toEqual([]);
    h.limiter.denied.add('write');
    const reply = await report(h, cookie, picture.id);
    expect(reply.status).toBe(429);
    expect(errorOf(reply).code).toBe('rate_limited');
    expect(stepsOf(h.trace)).toEqual([`limiter:write:${HOLDER}`]);
  });

  it.each(['abc', '0', '01', '1.5'])('answers the generic 404 for the id %s after the limiter', async (id) => {
    const { h, cookie } = await ready();
    const text = await generic404(h);
    const reply = await report(h, cookie, `/api/social/room/pictures/${id}/report`);
    expect(reply.status).toBe(404);
    expect(reply.text).toBe(text);
    expect(stepsOf(h.trace)).toEqual([`limiter:write:${HOLDER}`]);
  });
});

describe('step 2: who', () => {
  it('refuses an admin wallet before anything of the picture is read', async () => {
    const { h, picture } = await ready();
    h.room.firstAt.set(ADMIN, LONG_AGO);
    expectRefusal(await report(h, await h.signIn(ADMIN), picture.id), 'picture_admin');
    expect(stepsOf(h.trace)).toEqual([`limiter:write:${ADMIN}`]);
  });

  it('refuses by the stored holding: the gate, then one whole token', async () => {
    const { h, cookie, picture } = await ready();
    h.holding.gatingOn = false;
    expectRefusal(await report(h, cookie, picture.id), 'gate_off');
    h.holding.gatingOn = true;
    h.holding.tokens.set(HOLDER, 0.5);
    expectRefusal(await report(h, cookie, picture.id), 'not_holder');
    expect(h.holding.asked.map((asked) => asked.options)).toEqual([{ cachedOnly: true }, { cachedOnly: true }]);
    expect(h.trace).not.toContain(LOOK(picture.id));
  });
});

describe('step 3: looked at, and nothing written', () => {
  type Arrange = (h: Harness, picture: RoomPictureMessageRecord) => void;
  const state =
    (value: string): Arrange =>
    (h, p) =>
      void Object.assign(h.pictures.pictures.get(p.id) ?? {}, { state: value });

  it.each<[string, Arrange]>([
    ['hidden by reports already', state('reported')],
    ['kept by an admin', state('kept')],
    ['removed', state('removed')],
    [
      'of a hidden message',
      (h, p) => void Object.assign(h.room.messages.find((m) => m.id === p.id) ?? {}, { hiddenAt: START }),
    ],
    ['switched off', (h) => void Object.assign(h.pictures, { off: { at: START, by: ADMIN, why: 'admin' } })],
    ['seven days old', (h) => h.setNow('2026-10-27T11:00:00.000Z')],
  ])('answers the generic 404 for a picture that is %s', async (_name, arrange) => {
    const { h, cookie, picture } = await ready();
    arrange(h, picture);
    const text = await generic404(h);
    const before = h.ledger();
    const reply = await report(h, cookie, picture.id);
    expect(reply.status).toBe(404);
    expect(reply.text).toBe(text);
    expect(stepsOf(h.trace)).toEqual([...BEFORE_LOOK, LOOK(picture.id)]);
    expect(h.ledger()).toEqual(before);
  });

  it('answers the generic 404 for an id no message has, and for a message of text', async () => {
    const { h, cookie } = await ready();
    const line = h.room.seed(OTHER, 'a line', POSTED);
    const text = await generic404(h);
    for (const id of [line.id, 99]) {
      expect((await report(h, cookie, id)).text).toBe(text);
      expect(stepsOf(h.trace).at(-1)).toBe(LOOK(id));
    }
  });

  it('answers the generic 404 for a picture whose writer is an admin wallet now, and counts nothing', async () => {
    const { h, cookie } = await ready();
    const picture = h.pictures.seedPicture(ADMIN, POSTED);
    const text = await generic404(h);
    const before = h.ledger();
    const reply = await report(h, cookie, picture.id);
    expect(reply.status).toBe(404);
    expect(reply.text).toBe(text);
    expect(stepsOf(h.trace)).toEqual([...BEFORE_LOOK, LOOK(picture.id)]);
    expect(h.ledger()).toEqual(before);
  });

  it.each<[string, Arrange, RoomPictureRefusalField | RoomRefusalField]>([
    ['a muted wallet', (h) => h.room.setWriter(HOLDER, { mutedAt: START, cutAt: START }), 'muted'],
    ['a wallet that was muted once', (h) => h.room.setWriter(HOLDER, { cutAt: LONG_AGO }), 'picture_not_allowed'],
    ['a wallet with no stored message', (h) => h.room.firstAt.delete(HOLDER), 'report_new_writer'],
    [
      'a wallet whose first message is 23 hours old',
      (h) => h.room.firstAt.set(HOLDER, '2026-10-19T13:00:00.000Z'),
      'report_new_writer',
    ],
    [
      'a wallet at its reports of the day',
      (h) => h.pictures.setExtra(HOLDER, { reportsDay: DAY, reportsCount: ROOM_PICTURE_REPORTS_PER_WALLET_PER_DAY }),
      'report_wallet_day',
    ],
  ])('refuses %s, and spends and writes nothing', async (_name, arrange, field) => {
    const { h, cookie, picture } = await ready();
    arrange(h, picture);
    const before = h.ledger();
    const reply = await report(h, cookie, picture.id);
    expectRefusal(reply, field);
    expect(reply.headers.get('Retry-After')).toBe(field === 'report_wallet_day' ? String(12 * 3_600) : null);
    expect(stepsOf(h.trace)).toEqual([...BEFORE_LOOK, LOOK(picture.id)]);
    expect(h.ledger()).toEqual(before);
  });

  it("refuses a report of the wallet's own picture", async () => {
    const { h, cookie } = await ready();
    const own = h.pictures.seedPicture(HOLDER, POSTED);
    const before = h.ledger();
    expectRefusal(await report(h, cookie, own.id), 'report_own');
    expect(h.ledger()).toEqual(before);
  });

  it.each<[string, Arrange]>([
    ['a struck wallet', (h) => h.pictures.setExtra(HOLDER, { reportStrikes: ROOM_PICTURE_REPORT_STRIKES })],
    [
      'a second report of one picture',
      (h, p) => void h.pictures.reports.push({ messageId: p.id, reporter: HOLDER, at: POSTED }),
    ],
  ])('answers 204 to %s and writes nothing, so that it reads as a counted report', async (_name, arrange) => {
    const { h, cookie, picture } = await ready();
    arrange(h, picture);
    const before = h.ledger();
    expectDone(await report(h, cookie, picture.id));
    expect(stepsOf(h.trace)).toEqual([...BEFORE_LOOK, LOOK(picture.id)]);
    expect(h.ledger()).toEqual(before);
  });

  it("answers 204 for a picture reported before and 429 for any other, once the day's cap is reached", async () => {
    const { h, cookie, picture } = await ready();
    const other = h.pictures.seedPicture(OTHER, POSTED);
    h.pictures.reports.push({ messageId: picture.id, reporter: HOLDER, at: POSTED });
    h.pictures.setExtra(HOLDER, { reportsDay: DAY, reportsCount: ROOM_PICTURE_REPORTS_PER_WALLET_PER_DAY });
    expectDone(await report(h, cookie, picture.id));
    expectRefusal(await report(h, cookie, other.id), 'report_wallet_day');
  });

  it('judges a struck wallet before its own picture and its day', async () => {
    const { h, cookie } = await ready();
    const own = h.pictures.seedPicture(HOLDER, POSTED);
    h.pictures.setExtra(HOLDER, { reportStrikes: ROOM_PICTURE_REPORT_STRIKES });
    expectDone(await report(h, cookie, own.id));
  });
});

/** Lets everything that is ready run: a few turns of the event loop. */
async function turns(count = 20): Promise<void> {
  for (let turn = 0; turn < count; turn += 1) await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** The longest a test waits for something the route must do, by the machine's own clock. */
const PATIENCE_MS = 3_000;

/**
 * Waits, a turn at a time, until `done` says so. A route that never gets there fails the test with what it
 * never did: a wait without an end would outlive the test and keep its worker alive.
 */
async function until(what: string, done: () => boolean): Promise<void> {
  const end = Date.now() + PATIENCE_MS;
  while (!done()) {
    if (Date.now() > end) throw new Error(`the route never ${what}`);
    await turns(1);
  }
}

describe('steps 4 to 6: one promise, handed to waitUntil before it is awaited (revision 6, S3)', () => {
  it('hands the work over before the first call of step 4', async () => {
    const { h, cookie, picture } = await ready();
    expectDone(await report(h, cookie, picture.id));
    const steps = stepsOf(h.trace);
    expect(h.ctx.waited).toHaveLength(1);
    expect(steps.indexOf('ctx.waitUntil')).toBe(steps.indexOf(LOOK(picture.id)) + 1);
    expect(steps.indexOf('ctx.waitUntil')).toBeLessThan(steps.lastIndexOf(`limiter:write:${HOLDER}`));
    expect(steps.filter((step) => step === `limiter:write:${HOLDER}`)).toHaveLength(2);
    // By the whole trace, not only its steps: `requireWriter` reads the session first, and that reads the
    // clock before its first wait. Work that was run on the spot would leave that reading before the
    // hand-over; work made as `Promise.resolve().then(run)` leaves it after.
    const handed = h.trace.indexOf('ctx.waitUntil');
    expect(h.trace.slice(handed - 1, handed + 2)).toEqual([LOOK(picture.id), 'ctx.waitUntil', 'clock']);
  });

  it("finishes without the reporter: the report and the room's count are there when only the handed promise is awaited", async () => {
    const { h, cookie, picture } = await ready();
    const answer = report(h, cookie, picture.id);
    await until('handed its work to the context', () => h.ctx.waited.length > 0);
    await expect(h.ctx.waited[0]).resolves.toBeUndefined();
    expect(h.pictures.reports).toEqual([{ messageId: picture.id, reporter: HOLDER, at: START }]);
    expect(h.counters.get(REPORTS_KEY)).toBe(1);
    expectDone(await answer);
  });

  it('hands over a promise that never rejects, also when step 4 refuses or a later step throws', async () => {
    const { h, cookie, picture } = await ready();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    h.limits.rowsLeft = 0;
    expect((await report(h, cookie, picture.id)).status).toBe(503);
    h.limits.rowsLeft = Number.POSITIVE_INFINITY;
    h.pictures.fail.add('putReport');
    expect((await report(h, cookie, picture.id)).status).toBe(500);
    expect(h.ctx.waited).toHaveLength(2);
    for (const handed of h.ctx.waited) await expect(handed).resolves.toBeUndefined();
  });

  it('answers 500 with nothing written when the app was given no execution context', async () => {
    const { h, cookie, picture } = await ready();
    const before = h.ledger();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const reply = await report(h, cookie, picture.id, { context: false });
    expect(reply.status).toBe(500);
    expect(errorOf(reply).code).toBe('internal');
    // A wait before anything is asserted: work that was made before the context was read would run on
    // after the 500, and only then leave its steps in the trace and its report in the ledger.
    await turns();
    expect(error).toHaveBeenCalledTimes(1);
    expect(stepsOf(h.trace)).toEqual([...BEFORE_LOOK, LOOK(picture.id)]);
    expect(h.ledger()).toEqual(before);
  });

  it('answers what steps 1 to 3 answer with or without a context, and hands nothing over', async () => {
    const { h, cookie, picture } = await ready();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const none: RequestOptions = { context: false };
    expect((await report(h, undefined, picture.id, none)).status).toBe(401);
    expect((await report(h, cookie, 99, none)).status).toBe(404);
    const own = h.pictures.seedPicture(HOLDER, POSTED);
    expectRefusal(await report(h, cookie, own.id, none), 'report_own');
    h.pictures.reports.push({ messageId: picture.id, reporter: HOLDER, at: POSTED });
    expectDone(await report(h, cookie, picture.id, none));
    expectDone(await report(h, cookie, picture.id));
    expect(error).not.toHaveBeenCalled();
    expect(h.ctx.waited).toEqual([]);
  });
});

describe('a fault of steps 4 to 6 is logged inside the work, with the number of its step (revision 6)', () => {
  type Arrange = (h: Harness) => void;
  const FAILED = ROOM_PICTURE_LOG_EVENTS.reportFailed;

  it.each<[number, string, Arrange]>([
    [4, "the booking of the day's rows throws", (h) => void Object.assign(h.faults, { spend: true })],
    [5, 'the report throws', (h) => void h.pictures.fail.add('putReport')],
    [6, "the take of the room's count throws", (h) => void h.faults.take.add(REPORTS_KEY)],
    [
      6,
      'the switch throws',
      (h) => {
        h.counters.set(REPORTS_KEY, ROOM_PICTURE_REPORTS_PER_DAY);
        h.pictures.fail.add('setPicturesOff');
      },
    ],
  ])('logs step %d when %s, before the work rejects', async (step, _name, arrange) => {
    const { h, cookie, picture } = await ready();
    arrange(h);
    let status = 0;
    const lines = await logged(async () => {
      status = (await report(h, cookie, picture.id)).status;
    });
    expect(status).toBe(500);
    const events = lines.map((line) => line.event);
    expect(lines.filter((line) => line.event === FAILED)).toEqual([{ event: FAILED, step }]);
    expect(events.indexOf(FAILED)).toBeLessThan(events.indexOf('api_error'));
    expect(JSON.stringify(lines)).not.toContain(HOLDER);
  });

  it.each<[string, Arrange, number]>([
    ["the limiter's refusal at step 4", (h) => void Object.assign(h.limiter, { writesAllowed: 1 }), 429],
    ["the wallet's writes of the day at step 4", (h) => void Object.assign(h.limits, { walletWritesLeft: 0 }), 503],
  ])('is not written for %s: a refusal is an answer and no fault', async (_name, arrange, expected) => {
    const { h, cookie, picture } = await ready();
    arrange(h);
    let status = 0;
    const lines = await logged(async () => {
      status = (await report(h, cookie, picture.id)).status;
    });
    expect(status).toBe(expected);
    expect(lines).toEqual([]);
  });
});

describe('step 4: the write of the day', () => {
  it('books a report with requireWriter, and its refusal writes no report', async () => {
    const { h, cookie, picture } = await ready();
    h.limits.rowsLeft = ROOM_PICTURE_REPORT_WRITE_ROWS - 1;
    const reply = await report(h, cookie, picture.id);
    expect(reply.status).toBe(503);
    expect(errorOf(reply).code).toBe('daily_limit');
    expect(stepsOf(h.trace)).toEqual([...BEFORE_LOOK, LOOK(picture.id), ...BOOKED]);
    expect(h.pictures.reports).toEqual([]);
    expect(h.counters.size).toBe(0);
  });
});

describe("steps 5 and 6: the report, then the room's count", () => {
  it("takes the room's count only for a report that was counted", async () => {
    const { h, cookie, picture } = await ready();
    // The same wallet's other request wins between the look and the write: this one is not counted.
    h.pictures.before.set(
      'putReport',
      () => void h.pictures.reports.push({ messageId: picture.id, reporter: HOLDER, at: START }),
    );
    expectDone(await report(h, cookie, picture.id));
    expect(stepsOf(h.trace).at(-1)).toBe(`pictures.putReport:${picture.id}:${ROOM_SCAN}:${HIDES_KEY}`);
    expect(h.counters.has(REPORTS_KEY)).toBe(false);
  });

  it('hides a picture at the third report, logs its id, and deletes nothing', async () => {
    const { h, cookie, picture } = await ready();
    for (const reporter of [THIRD, STRANGER].slice(0, ROOM_PICTURE_REPORTS_TO_HIDE - 1)) {
      h.pictures.reports.push({ messageId: picture.id, reporter, at: POSTED });
    }
    Object.assign(h.pictures.pictures.get(picture.id) ?? {}, { reports: ROOM_PICTURE_REPORTS_TO_HIDE - 1 });
    const lines = await logged(async () => {
      expectDone(await report(h, cookie, picture.id));
    });
    expect(lines).toEqual([{ event: ROOM_PICTURE_LOG_EVENTS.reported, id: picture.id }]);
    expect(h.pictures.pictures.get(picture.id)).toMatchObject({
      state: 'reported',
      reports: ROOM_PICTURE_REPORTS_TO_HIDE,
    });
    expect(h.pictures.pictures.get(picture.id)?.key).not.toBeNull();
    expect(h.trace.filter((step) => step.startsWith('bytes.'))).toEqual([]);
    expect(h.counters.get(HIDES_KEY)).toBe(1);
    expect(JSON.stringify(lines)).not.toContain(HOLDER);
  });

  it('logs that pictures switched themselves off when the fifth picture of the hour is hidden', async () => {
    const { h, cookie, picture } = await ready();
    Object.assign(h.pictures.pictures.get(picture.id) ?? {}, { reports: ROOM_PICTURE_REPORTS_TO_HIDE - 1 });
    h.counters.set(HIDES_KEY, ROOM_PICTURE_AUTO_OFF_REPORTED - 1);
    const lines = await logged(async () => {
      expectDone(await report(h, cookie, picture.id));
    });
    expect(lines).toEqual([
      { event: ROOM_PICTURE_LOG_EVENTS.reported, id: picture.id },
      { event: ROOM_PICTURE_LOG_EVENTS.autoOff, count: ROOM_PICTURE_AUTO_OFF_REPORTED },
    ]);
    expect(h.pictures.off).toEqual({ at: START, by: null, why: 'reports_hour' });
  });

  it("switches pictures off when the counted report finds the room's reports of the day full, and still answers 204", async () => {
    const { h, cookie, picture } = await ready();
    h.counters.set(REPORTS_KEY, ROOM_PICTURE_REPORTS_PER_DAY);
    const lines = await logged(async () => {
      expectDone(await report(h, cookie, picture.id));
    });
    expect(stepsOf(h.trace).slice(-2)).toEqual([`counter.take:${REPORTS_KEY}`, 'pictures.setPicturesOff:reports_day']);
    expect(h.pictures.off).toEqual({ at: START, by: null, why: 'reports_day' });
    expect(lines).toEqual([{ event: ROOM_PICTURE_LOG_EVENTS.autoOff, count: ROOM_PICTURE_REPORTS_PER_DAY }]);
    // The report itself stands: it was counted before the room's count was asked.
    expect(h.pictures.reports).toHaveLength(1);
  });

  it("takes one of the room's hundred below the cap and leaves pictures on", async () => {
    const { h, cookie, picture } = await ready();
    h.counters.set(REPORTS_KEY, ROOM_PICTURE_REPORTS_PER_DAY - 1);
    expectDone(await report(h, cookie, picture.id));
    expect(h.counters.get(REPORTS_KEY)).toBe(ROOM_PICTURE_REPORTS_PER_DAY);
    expect(h.pictures.off).toBeNull();
    expect(h.trace).not.toContain('pictures.setPicturesOff:reports_day');
  });
});
