import type { RoomPictureRefusalField, RoomRefusalField } from '@prix/contracts';
import {
  API_WRITE_ROWS_PER_DAY,
  ROOM_PICTURE_AUTO_OFF_REPORTED,
  ROOM_PICTURE_LOG_EVENTS,
  ROOM_PICTURE_REFUSALS,
  ROOM_PICTURE_REPORT_STRIKES,
  ROOM_PICTURE_REPORT_WRITE_ROWS,
  ROOM_PICTURE_REPORTER_AGE_SECONDS,
  ROOM_PICTURE_REPORTS_PER_DAY,
  ROOM_PICTURE_REPORTS_PER_WALLET_PER_DAY,
  ROOM_PICTURE_REPORTS_TO_HIDE,
  ROOM_PICTURES_ADMIN_PATH,
  ROOM_REFUSALS,
  ROOM_SCAN,
  roomMeWithPicturesResponseSchema,
  roomPicturePath,
  roomPictureReportHidesKey,
  roomPictureReportPath,
  roomPictureReportsKey,
  roomPicturesAdminResponseSchema,
  roomWithPicturesResponseSchema,
  SESSION_COOKIE,
} from '@prix/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Reply } from './api/harness.ts';
import { errorOf } from './api/harness.ts';
import { db } from './support/d1.ts';
import { GIF_SMALLEST, gifTinted } from './support/picture-files.ts';
import type { PictureWorld, WorldOptions } from './support/pictures.ts';
import {
  ADMIN,
  counterOf,
  createPictureWorld,
  emptyPictureTables,
  eventsOf,
  pictureLedger,
  pictureRow,
  reportCounts,
  SITE,
  seedCount,
  seedPicture,
  seedWriter,
  TestContext,
  withOver,
} from './support/pictures.ts';

/**
 * Reporting a picture, the admin's keep and the switch (docs/contracts/phase-6-pictures.md sections 8
 * and 9, at revision 3), behind `createApp` on the real stores of a local D1.
 *
 * A report is the stronger lever, so each rule of it is a condition inside a statement: three distinct
 * holders hide a picture and delete nothing; a wallet counts once for a picture, however often and
 * however fast it asks; the room's reports of a day are taken only for a report that was counted; a
 * reporter never learns a count. Only an admin keeps, and only an admin switches pictures on again.
 */

const NOW = '2026-10-20T12:10:30.000Z';
const DAY = '2026-10-20';
const REPORTS_KEY = roomPictureReportsKey(DAY);
const HIDES_KEY = roomPictureReportHidesKey(DAY, 12);
/** 12:10:30 UTC to 00:00 UTC. */
const TO_MIDNIGHT = 11 * 3_600 + 49 * 60 + 30;

const WRITER = '0x00000000000000000000000000000000000005b2';
const R1 = '0x00000000000000000000000000000000000006a1';
const R2 = '0x00000000000000000000000000000000000006a2';
const R3 = '0x00000000000000000000000000000000000006a3';
const R4 = '0x00000000000000000000000000000000000006a4';
const OFF_PATH = `${ROOM_PICTURES_ADMIN_PATH}/off`;
const keepPath = (id: number): string => `${ROOM_PICTURES_ADMIN_PATH}/${id}/keep`;

function world(options: WorldOptions = {}): PictureWorld {
  return createPictureWorld(db, { now: NOW, ...options });
}

const at = (secondsAgo: number): string => new Date(Date.parse(NOW) - secondsAgo * 1_000).toISOString();
const report = (w: PictureWorld, cookie: string | undefined, id: number): Promise<Reply> =>
  w.fetch('POST', roomPictureReportPath(id), { cookie });

function expectRefusal(reply: Reply, field: RoomPictureRefusalField | RoomRefusalField): void {
  const status =
    field in ROOM_PICTURE_REFUSALS
      ? ROOM_PICTURE_REFUSALS[field as RoomPictureRefusalField]
      : ROOM_REFUSALS[field as RoomRefusalField];
  expect(reply.status, reply.text).toBe(status);
  expect(errorOf(reply)).toMatchObject({ code: 'invalid_input', field });
  expect(reply.headers.get('Cache-Control')).toBe('no-store');
}
function expectNotFound(reply: Reply, name = ''): void {
  expect(reply.status, name).toBe(404);
  expect(errorOf(reply).code, name).toBe('not_found');
}

/** Everything a report can write, read from the tables. */
async function reportState(w: PictureWorld, id: number, reporter: string) {
  const picture = await pictureRow(db, id);
  const rows = await db
    .prepare('SELECT reporter FROM room_picture_reports WHERE message_id = ?1 ORDER BY reporter')
    .bind(id)
    .all<{ reporter: string }>();
  const writer = await db
    .prepare('SELECT reports_day, reports_count, report_strikes FROM room_writers WHERE address = ?1')
    .bind(reporter)
    .first<{ reports_day: string | null; reports_count: number; report_strikes: number }>();
  return {
    state: picture?.pic_state ?? null,
    /** The picture's own count of reports; `reports` below is the room's counter of the day. */
    counted: picture?.pic_reports ?? null,
    reporters: rows.results.map((row) => row.reporter),
    reporterCount: writer?.reports_day === DAY ? writer.reports_count : 0,
    strikes: writer?.report_strikes ?? 0,
    ...(await reportCounts(w)),
    flags: (await db.prepare('SELECT COUNT(*) AS n FROM room_flags').first<{ n: number }>())?.n ?? 0,
  };
}

/** Three holders who may report, the writer, and one picture of the writer's. */
async function scene(w: PictureWorld) {
  const writer = await seedWriter(w, WRITER);
  const reporters: { address: string; cookie: string }[] = [];
  for (const address of [R1, R2, R3]) reporters.push({ address, cookie: (await seedWriter(w, address)).cookie });
  const picture = await seedPicture(w, WRITER, GIF_SMALLEST, { at: at(600) });
  return { writer, reporters, picture };
}

let logged: unknown[][] = [];
const events = (name: string): unknown[] => eventsOf(logged).filter((line) => line.event === name);

beforeEach(async () => {
  await emptyPictureTables(db);
  logged = [];
  for (const method of ['log', 'error', 'warn'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void logged.push(args));
  }
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('three holders hide a picture', () => {
  it('counts each wallet once, hides at the third, deletes nothing, and answers every report alike', async () => {
    const w = world();
    const { reporters, picture } = await scene(w);
    const replies: Reply[] = [];

    for (const [n, reporter] of reporters.entries()) {
      replies.push(await report(w, reporter.cookie, picture.id));
      const state = await reportState(w, picture.id, reporter.address);
      expect(state.counted).toBe(n + 1);
      expect(state.state).toBe(n + 1 < ROOM_PICTURE_REPORTS_TO_HIDE ? 'ok' : 'reported');
      expect(state.reporterCount).toBe(1);
    }

    // 204, always: a reporter never learns a count, nor whether the report hid the picture.
    for (const reply of replies) {
      expect(reply.status).toBe(204);
      expect(reply.text).toBe('');
      expect([...reply.headers.entries()].sort()).toEqual([...(replies[0] as Reply).headers.entries()].sort());
    }
    const state = await reportState(w, picture.id, R1);
    expect(state).toMatchObject({
      state: 'reported',
      counted: 3,
      reporters: [R1, R2, R3],
      reports: 3,
      hides: 1,
      flags: 0,
    });
    expect(await counterOf(db, REPORTS_KEY)).toBe(3);
    // A report that hides deletes nothing: the bytes stay for the admins, and KV was never asked.
    expect(w.kv.calls()).toBe(0);
    expect(w.kv.held.has(picture.key)).toBe(true);
    expect((await pictureRow(db, picture.id))?.pic_key).toBe(picture.key);
    expect(events(ROOM_PICTURE_LOG_EVENTS.reported)).toEqual([{ event: 'room_picture_reported', id: picture.id }]);
  });

  it('is refused by the gate at once, shown as hidden after reports, and still there for an admin', async () => {
    const w = world();
    const { reporters, picture } = await scene(w);
    for (const reporter of reporters) await report(w, reporter.cookie, picture.id);
    const admin = await w.signIn(ADMIN);

    expect((await w.image(roomPicturePath(picture.id))).status).toBe(404);
    const read = roomWithPicturesResponseSchema.parse((await w.fetch('GET', '/api/social/room')).json);
    expect(read.messages.find((message) => message.id === picture.id)?.picture?.state).toBe('reported');
    expect(read.pictures).toBe('on');

    const list = await w.fetch('GET', ROOM_PICTURES_ADMIN_PATH, { cookie: admin });
    const listed = roomPicturesAdminResponseSchema.parse(list.json);
    expect(listed.reported).toHaveLength(1);
    expect(listed.reported[0]).toMatchObject({ id: picture.id, author: WRITER });
    expect(listed.reported[0]?.reporters.map((reporter) => reporter.address).sort()).toEqual([R1, R2, R3]);
    expect(listed.reported[0]?.picture).toMatchObject({
      state: 'reported',
      reports: 3,
      viewable: true,
      bytesGone: false,
    });
    expect(listed.reported[0]?.picture.sha256Short).toBe(picture.sha256.slice(0, 12));
    // Never the key, and never the whole hash.
    expect(list.text).not.toContain('pic/');
    expect(list.text).not.toContain(picture.sha256);
    expect(list.headers.get('Cache-Control')).toBe('no-store');
    // Anyone else: an unknown path.
    expectNotFound(await w.fetch('GET', ROOM_PICTURES_ADMIN_PATH, { cookie: reporters[0]?.cookie }));
    expectNotFound(await w.fetch('GET', ROOM_PICTURES_ADMIN_PATH));
  });

  it('takes no further report of a picture that is hidden: the generic 404, and nothing written', async () => {
    const w = world();
    const { reporters, picture } = await scene(w);
    for (const reporter of reporters) await report(w, reporter.cookie, picture.id);
    const fourth = await seedWriter(w, R4);
    const before = await reportState(w, picture.id, R4);

    expectNotFound(await report(w, fourth.cookie, picture.id));

    expect(await reportState(w, picture.id, R4)).toEqual(before);
  });

  it("keeps a reporter's address in the report's own row and nowhere else: not in a block, not in a log line", async () => {
    const w = world();
    const { reporters, picture } = await scene(w);
    for (const reporter of reporters) await report(w, reporter.cookie, picture.id);
    const admin = await w.signIn(ADMIN);

    // An admin removes it: the record of the removal carries the count, a number.
    expect((await w.fetch('DELETE', `/api/social/admin/room/messages/${picture.id}`, { cookie: admin })).status).toBe(
      204,
    );

    const block = await db.prepare('SELECT * FROM room_picture_blocks').first<Record<string, unknown>>();
    expect(block).toMatchObject({
      sha256: picture.sha256,
      author: WRITER,
      by: ADMIN,
      reports: 3,
      message_id: picture.id,
    });
    const columns = await db
      .prepare("SELECT name FROM pragma_table_info('room_picture_blocks')")
      .all<{ name: string }>();
    expect(columns.results.map((column) => column.name).sort()).toEqual(
      [
        'at',
        'author',
        'by',
        'bytes',
        'frames',
        'height',
        'message_id',
        'posted_at',
        'reports',
        'sha256',
        'type',
        'width',
      ].sort(),
    );
    const everything = `${JSON.stringify(block)}\n${logged.map((call) => call.map(String).join(' ')).join('\n')}`;
    for (const reporter of [R1, R2, R3]) expect(everything).not.toContain(reporter);
    // The audit line of the removal: the action, the id and the count.
    expect(eventsOf(logged).filter((line) => line.event === 'admin_action')).toEqual([
      { event: 'admin_action', admin: ADMIN, action: 'room_hide', target: String(picture.id), reports: 3 },
    ]);
  });
});

describe('steps 4 to 6 of a report: one promise, handed to the context before anything of step 4 is called (revision 6, S3)', () => {
  /** A report as the page sends it, not sent: for a test that hands the app a context of its own, or none. */
  const reportRequest = (cookie: string | undefined, id: number): Request =>
    new Request(`${SITE}${roomPictureReportPath(id)}`, {
      method: 'POST',
      headers: {
        'CF-Connecting-IP': '203.0.113.9',
        Origin: SITE,
        'Content-Type': 'application/json',
        Cookie: `${SESSION_COOKIE}=${cookie ?? ''}`,
      },
    });
  const isWrite = (step: string): boolean => /^d1 (insert|update|delete|replace)\b/i.test(step);

  it('records the promise before the second asking of the write rule, and hands over exactly one', async () => {
    const w = world();
    const { reporters, picture } = await scene(w);
    const context = new TestContext(w.trace);
    const mark = w.trace.length;

    const response = await w.app.fetch(reportRequest(reporters[0]?.cookie, picture.id), context as never);

    expect(response.status).toBe(204);
    const asked = w.trace.slice(mark);
    const handed = asked.indexOf('ctx.waitUntil');
    const rules = asked.flatMap((step, index) => (step === 'limit.write' ? [index] : []));
    expect(rules).toHaveLength(2);
    expect(handed).toBeGreaterThan(rules[0] ?? -1);
    // The first call of step 4 is the second asking of the limiter's `write` rule.
    expect(handed).toBeLessThan(rules[1] ?? -1);
    // Nothing is written before the hand-over.
    expect(asked.slice(0, handed).filter(isWrite)).toEqual([]);
    expect(context.waited).toHaveLength(1);
    await expect(context.waited[0]).resolves.toBeUndefined();
  });

  it("takes the room's report of the day though nobody ever awaits the answer: only what the context was handed", async () => {
    const w = world();
    const { reporters, picture } = await scene(w);
    const context = new TestContext(w.trace);

    // The response is never awaited before the check: a reporter who hung up would not have read it either.
    const answer = w.app.fetch(reportRequest(reporters[0]?.cookie, picture.id), context as never);
    const settled = Promise.resolve(answer).then(
      (response) => response.status,
      () => -1,
    );
    await vi.waitFor(() => expect(context.waited).toHaveLength(1), { timeout: 5_000, interval: 5 });
    await context.waited[0];

    // The counted report did not stay out of the room's hundred.
    expect(await counterOf(db, REPORTS_KEY)).toBe(1);
    expect(await reportState(w, picture.id, R1)).toMatchObject({ counted: 1, reporters: [R1], reporterCount: 1 });
    expect(await settled).toBe(204);
  });

  it('answers 500 with nothing written when the app was given no context, and runs nothing of steps 4 to 6', async () => {
    const w = world();
    const { reporters, picture } = await scene(w);
    const before = { ...(await reportState(w, picture.id, R1)), ledger: await pictureLedger(w, R1) };
    const mark = w.trace.length;

    const response = await w.app.fetch(reportRequest(reporters[0]?.cookie, picture.id));

    expect(response.status).toBe(500);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('internal');
    // There is no fallback: the limiter was asked once, and nothing was written.
    const asked = w.trace.slice(mark);
    expect(asked.filter((step) => step === 'limit.write')).toHaveLength(1);
    expect(asked.filter(isWrite)).toEqual([]);
    // Give a stray promise the time to run, had the route started its work before it asked for the context.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect({ ...(await reportState(w, picture.id, R1)), ledger: await pictureLedger(w, R1) }).toEqual(before);
  });

  it('answers what steps 1 to 3 answer with or without a context, and hands nothing over', async () => {
    const w = world();
    const { reporters, picture } = await scene(w);
    const admin = await w.signIn(ADMIN);
    const cases: [number, Request][] = [
      [401, reportRequest(undefined, picture.id)],
      [403, reportRequest(admin, picture.id)],
      [404, reportRequest(reporters[0]?.cookie, picture.id + 999)],
    ];
    for (const [status, request] of cases) {
      const context = new TestContext(w.trace);
      expect((await w.app.fetch(request.clone(), context as never)).status).toBe(status);
      expect(context.waited).toEqual([]);
      expect((await w.app.fetch(request)).status).toBe(status);
    }
  });

  it('hands over a promise that never rejects, and writes room_picture_report_failed with the step that threw and nothing else', async () => {
    // The operator's reading of revision 6: the ninth log line. Once the reporter has left, the error handler
    // never sees a fault of steps 4 to 6, so the work writes it itself before it rejects.
    const away = async (): Promise<never> => {
      throw new Error(`D1 is away for ${R1}`);
    };
    const faults: [number, WorldOptions][] = [
      [5, { wrapPictures: (store) => withOver(store, { putReport: away }) }],
      [6, { wrapReputation: (store) => withOver(store, { takeCounter: away }) }],
    ];
    for (const [step, options] of faults) {
      await emptyPictureTables(db);
      logged = [];
      const w = world(options);
      const { reporters, picture } = await scene(w);
      const context = new TestContext(w.trace);

      const response = await w.app.fetch(reportRequest(reporters[0]?.cookie, picture.id), context as never);

      expect(response.status, `step ${step}`).toBe(500);
      expect(context.waited, `step ${step}`).toHaveLength(1);
      await expect(context.waited[0], `step ${step}`).resolves.toBeUndefined();
      expect(events(ROOM_PICTURE_LOG_EVENTS.reportFailed), `step ${step}`).toEqual([
        { event: 'room_picture_report_failed', step },
      ]);
    }

    // A refusal of the guard is an answer and no fault: the limiter's second asking writes no line.
    await emptyPictureTables(db);
    logged = [];
    const w = world();
    const { reporters, picture } = await scene(w);
    w.limiter.writesAllowed = 1;
    const context = new TestContext(w.trace);
    const refused = await w.app.fetch(reportRequest(reporters[0]?.cookie, picture.id), context as never);
    expect(refused.status).toBe(429);
    await expect(context.waited[0]).resolves.toBeUndefined();
    expect(events(ROOM_PICTURE_LOG_EVENTS.reportFailed)).toEqual([]);
  });
});

describe('reports sent at once, and again', () => {
  it("counts 50 reports of one picture by one wallet, sent at once, as one: the room's counter is at 1", async () => {
    const w = world();
    const { reporters, picture } = await scene(w);
    const cookie = reporters[0]?.cookie;

    const replies = await Promise.all(Array.from({ length: 50 }, () => report(w, cookie, picture.id)));

    expect(replies.map((reply) => reply.status)).toEqual(new Array<number>(50).fill(204));
    expect(await counterOf(db, REPORTS_KEY)).toBe(1);
    expect(await reportState(w, picture.id, R1)).toMatchObject({
      state: 'ok',
      counted: 1,
      reports: 1,
      reporters: [R1],
      reporterCount: 1,
      hides: 0,
    });
  });

  it('answers a second report of one picture 204 and writes nothing, not even a booked row', async () => {
    const w = world();
    const { reporters, picture } = await scene(w);
    const cookie = reporters[0]?.cookie;
    expect((await report(w, cookie, picture.id)).status).toBe(204);
    const before = { ...(await reportState(w, picture.id, R1)), ledger: await pictureLedger(w, R1) };
    const mark = w.trace.length;

    for (let n = 0; n < 5; n += 1) expect((await report(w, cookie, picture.id)).status).toBe(204);

    expect({ ...(await reportState(w, picture.id, R1)), ledger: await pictureLedger(w, R1) }).toEqual(before);
    expect(w.trace.slice(mark).filter((step) => /^d1 (insert|update|delete|replace)\b/i.test(step))).toEqual([]);
  });

  it('answers 204 for a picture it reported before and 429 for any other, once the wallet is at its cap of the day', async () => {
    const w = world();
    const { reporters } = await scene(w);
    const cookie = reporters[0]?.cookie;
    const pictures = [];
    for (let n = 0; n < ROOM_PICTURE_REPORTS_PER_WALLET_PER_DAY + 1; n += 1) {
      pictures.push(await seedPicture(w, WRITER, gifTinted(n + 1), { at: at(500 - n) }));
    }
    for (const picture of pictures.slice(0, ROOM_PICTURE_REPORTS_PER_WALLET_PER_DAY)) {
      expect((await report(w, cookie, picture.id)).status).toBe(204);
    }
    expect(ROOM_PICTURE_REPORTS_PER_WALLET_PER_DAY).toBe(5);

    const again = await report(w, cookie, (pictures[0] as { id: number }).id);
    const other = await report(w, cookie, (pictures[5] as { id: number }).id);

    expect(again.status).toBe(204);
    expectRefusal(other, 'report_wallet_day');
    expect(other.headers.get('Retry-After')).toBe(String(TO_MIDNIGHT));
    expect(await counterOf(db, REPORTS_KEY)).toBe(ROOM_PICTURE_REPORTS_PER_WALLET_PER_DAY);
    expect((await pictureRow(db, (pictures[5] as { id: number }).id))?.pic_reports).toBe(0);
  });
});

describe('who reports', () => {
  it('refuses a request that is not from the site, has no session, or is refused by the limiter, in that order', async () => {
    const w = world();
    const { reporters, picture } = await scene(w);
    const cookie = reporters[0]?.cookie;
    const path = roomPictureReportPath(picture.id);
    const before = await reportState(w, picture.id, R1);

    const foreign = await w.fetch('POST', path, { cookie, headers: { Origin: 'https://evil.example' } });
    const form = await w.fetch('POST', path, { cookie, headers: { 'Content-Type': 'text/plain' } });
    const nobody = await w.fetch('POST', path);
    w.limiter.writesAllowed = 0;
    const limited = await w.fetch('POST', path, { cookie });

    expect([foreign.status, form.status, nobody.status, limited.status]).toEqual([403, 403, 401, 429]);
    expect(errorOf(foreign).code).toBe('forbidden');
    expect(errorOf(limited).code).toBe('rate_limited');
    expect(await reportState(w, picture.id, R1)).toEqual(before);
  });

  it('answers the generic 404 for an id that is none', async () => {
    const w = world();
    const { reporters } = await scene(w);
    for (const id of ['0', 'abc', '012', '1234567890123456']) {
      expectNotFound(
        await w.fetch('POST', `/api/social/room/pictures/${id}/report`, { cookie: reporters[0]?.cookie }),
        id,
      );
    }
  });

  it('refuses an admin wallet with picture_admin: an admin removes, and reports nothing', async () => {
    const w = world();
    const { picture } = await scene(w);
    const admin = await w.signIn(ADMIN);
    w.holdings.set(ADMIN, 1_000);

    expectRefusal(await report(w, admin, picture.id), 'picture_admin');

    expect(w.holdingReads).toEqual([]);
    expect((await pictureRow(db, picture.id))?.pic_reports).toBe(0);
  });

  it('asks the stored holding only, and refuses a wallet below one token and everyone while the gate is off', async () => {
    const w = world();
    const { reporters, picture } = await scene(w);
    w.holdings.set(R1, 0.5);

    expectRefusal(await report(w, reporters[0]?.cookie, picture.id), 'not_holder');
    w.gate.on = false;
    expectRefusal(await report(w, reporters[1]?.cookie, picture.id), 'gate_off');

    expect(w.holdingReads).toEqual([
      { address: R1, cachedOnly: true },
      { address: R2, cachedOnly: true },
    ]);
    expect((await pictureRow(db, picture.id))?.pic_reports).toBe(0);
  });

  it('refuses a reporter whose first message is 23 hours old, and takes one whose first message is a day old', async () => {
    const w = world();
    const { picture } = await scene(w);
    const young = await seedWriter(w, R4, { ageSeconds: 23 * 3_600 });
    expect(ROOM_PICTURE_REPORTER_AGE_SECONDS).toBe(24 * 3_600);

    expectRefusal(await report(w, young.cookie, picture.id), 'report_new_writer');
    expect((await pictureRow(db, picture.id))?.pic_reports).toBe(0);
    // An hour later the same wallet's first message is a day old.
    w.advance(3_600_000);
    expect((await report(w, young.cookie, picture.id)).status).toBe(204);
    expect((await pictureRow(db, picture.id))?.pic_reports).toBe(1);
  });

  it('refuses a reader who never wrote, a muted wallet, one that was muted once, and the writer of the picture', async () => {
    const w = world();
    const { writer, reporters, picture } = await scene(w);
    w.holdings.set(R4, 1);
    const reader = await w.signIn(R4);
    await db
      .prepare('UPDATE room_writers SET muted_at = ?2, muted_by = ?3, cut_at = ?2 WHERE address = ?1')
      .bind(R1, at(60), ADMIN)
      .run();
    await db.prepare('UPDATE room_writers SET cut_at = ?2 WHERE address = ?1').bind(R2, at(90_000)).run();

    expectRefusal(await report(w, reader, picture.id), 'report_new_writer');
    expectRefusal(await report(w, reporters[0]?.cookie, picture.id), 'muted');
    expectRefusal(await report(w, reporters[1]?.cookie, picture.id), 'picture_not_allowed');
    expectRefusal(await report(w, writer.cookie, picture.id), 'report_own');

    expect((await pictureRow(db, picture.id))?.pic_reports).toBe(0);
    expect(await counterOf(db, REPORTS_KEY)).toBe(0);
  });

  it('books ROOM_PICTURE_REPORT_WRITE_ROWS for a counted report, and keeps daily_limit when the day is spent', async () => {
    const w = world();
    const { reporters, picture } = await scene(w);

    expect((await report(w, reporters[0]?.cookie, picture.id)).status).toBe(204);
    expect(await pictureLedger(w, R1)).toMatchObject({ walletWrites: 1, dayRows: ROOM_PICTURE_REPORT_WRITE_ROWS });

    await db.prepare('UPDATE api_writes SET rows = ?2 WHERE day = ?1').bind(DAY, API_WRITE_ROWS_PER_DAY).run();
    const refused = await report(w, reporters[1]?.cookie, picture.id);
    expect(refused.status).toBe(503);
    expect(errorOf(refused).code).toBe('daily_limit');
    expect((await pictureRow(db, picture.id))?.pic_reports).toBe(1);
  });
});

describe('which picture takes a report', () => {
  const set = (id: number, sql: string, ...values: unknown[]): Promise<unknown> =>
    db
      .prepare(`UPDATE room_messages SET ${sql} WHERE id = ?1`)
      .bind(id, ...values)
      .run();
  const closed: [string, (w: PictureWorld, id: number) => Promise<unknown>][] = [
    ['hidden', (_w, id) => set(id, 'hidden_at = ?2, hidden_by = ?3', NOW, ADMIN)],
    ['kept by an admin', (_w, id) => set(id, "pic_state = 'kept'")],
    ['removed', (_w, id) => set(id, "pic_state = 'removed'")],
    ['gone from KV', (_w, id) => set(id, 'pic_key = NULL')],
    ['seven days old', (_w, id) => set(id, 'at = ?2', at(7 * 86_400))],
    ['switched off with every other', (w) => w.deps.pictures.setPicturesOff(ADMIN, 'admin', NOW)],
    [
      `below the newest ${ROOM_SCAN} ids`,
      () =>
        db
          .prepare(
            `WITH RECURSIVE n (i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
             INSERT INTO room_messages (at, author, text) SELECT ?2, ?3, 'line ' || i FROM n`,
          )
          .bind(ROOM_SCAN, NOW, R4)
          .run(),
    ],
  ];
  for (const [name, arrange] of closed) {
    it(`answers the generic 404 for a picture that is ${name}, and writes nothing`, async () => {
      const w = world();
      const { reporters, picture } = await scene(w);
      await arrange(w, picture.id);
      const before = await reportState(w, picture.id, R1);

      expectNotFound(await report(w, reporters[0]?.cookie, picture.id));

      expect(await reportState(w, picture.id, R1)).toEqual(before);
      expect((await pictureLedger(w, R1)).walletWrites).toBe(0);
    });
  }

  it('answers the generic 404 for a message of text and for an id no message has', async () => {
    const w = world();
    const { writer, reporters, picture } = await scene(w);

    expectNotFound(await report(w, reporters[0]?.cookie, writer.firstId));
    expectNotFound(await report(w, reporters[0]?.cookie, picture.id + 999));
  });

  it('answers the generic 404 for a picture whose writer is an admin wallet now: three crafted reports count nothing', async () => {
    const before = world();
    const { picture } = await scene(before);
    const w = world({ adminAddresses: [ADMIN, WRITER] });
    for (const address of [R1, R2, R3]) {
      w.holdings.set(address, 1);
      expectNotFound(await report(w, await w.signIn(address), picture.id), address);
    }

    expect(await reportState(w, picture.id, R1)).toMatchObject({ state: 'ok', counted: 0, reporters: [], reports: 0 });
    expect(await counterOf(db, REPORTS_KEY)).toBe(0);
  });
});

describe("the room's reports of a day, and the counts that switch pictures off", () => {
  it(`switches pictures off when a counted report finds the day's ${ROOM_PICTURE_REPORTS_PER_DAY} spent`, async () => {
    const w = world();
    const { reporters, picture } = await scene(w);
    await seedCount(db, REPORTS_KEY, ROOM_PICTURE_REPORTS_PER_DAY, NOW);

    expect((await report(w, reporters[0]?.cookie, picture.id)).status).toBe(204);

    expect(await w.deps.pictures.getPicturesOff()).toEqual({ at: NOW, by: null, why: 'reports_day' });
    expect(events(ROOM_PICTURE_LOG_EVENTS.autoOff)).toEqual([
      { event: 'room_pictures_auto_off', count: ROOM_PICTURE_REPORTS_PER_DAY },
    ]);
    // The report itself was counted on the picture: nothing a wallet does lowers a count.
    expect((await pictureRow(db, picture.id))?.pic_reports).toBe(1);
    const read = roomWithPicturesResponseSchema.parse((await w.fetch('GET', '/api/social/room')).json);
    expect(read.pictures).toBe('off');
  });

  it('does not take one of them for a report that was not counted, with the day spent or not', async () => {
    const w = world();
    const { reporters, picture } = await scene(w);
    expect((await report(w, reporters[0]?.cookie, picture.id)).status).toBe(204);
    await seedCount(db, REPORTS_KEY, ROOM_PICTURE_REPORTS_PER_DAY, NOW);

    // A repeated report, and one of a struck wallet: 204, and the full count switches nothing off.
    expect((await report(w, reporters[0]?.cookie, picture.id)).status).toBe(204);
    await db
      .prepare('UPDATE room_writers SET report_strikes = ?2 WHERE address = ?1')
      .bind(R2, ROOM_PICTURE_REPORT_STRIKES)
      .run();
    expect((await report(w, reporters[1]?.cookie, picture.id)).status).toBe(204);

    expect(await w.deps.pictures.getPicturesOff()).toBeNull();
    expect(await counterOf(db, REPORTS_KEY)).toBe(ROOM_PICTURE_REPORTS_PER_DAY);
    expect((await pictureRow(db, picture.id))?.pic_reports).toBe(1);
  });

  it(`switches pictures off by itself when ${ROOM_PICTURE_AUTO_OFF_REPORTED} pictures were hidden by reports in one hour`, async () => {
    const w = world();
    const { reporters } = await scene(w);
    const pictures = [];
    for (let n = 0; n < ROOM_PICTURE_AUTO_OFF_REPORTED; n += 1) {
      pictures.push(await seedPicture(w, WRITER, gifTinted(n + 1), { at: at(500 - n) }));
    }

    for (const [n, picture] of pictures.entries()) {
      for (const reporter of reporters) expect((await report(w, reporter.cookie, picture.id)).status).toBe(204);
      expect(await counterOf(db, HIDES_KEY)).toBe(n + 1);
      expect((await w.deps.pictures.getPicturesOff()) === null).toBe(n + 1 < ROOM_PICTURE_AUTO_OFF_REPORTED);
    }

    expect(await w.deps.pictures.getPicturesOff()).toEqual({ at: NOW, by: null, why: 'reports_hour' });
    expect(events(ROOM_PICTURE_LOG_EVENTS.autoOff)).toEqual([
      { event: 'room_pictures_auto_off', count: ROOM_PICTURE_AUTO_OFF_REPORTED },
    ]);
    expect(events(ROOM_PICTURE_LOG_EVENTS.reported)).toHaveLength(ROOM_PICTURE_AUTO_OFF_REPORTED);
    // Nothing was deleted: fifteen reports, and KV was never asked.
    expect(w.kv.calls()).toBe(0);
    // No log line of it names a wallet.
    const text = logged.map((call) => call.map(String).join(' ')).join('\n');
    expect(text).not.toMatch(/0x[0-9a-fA-F]{40}/);
  });
});

describe("the admin's keep", () => {
  it('shows a reported picture again, closes it to reports, and gives every wallet that reported it a strike', async () => {
    const w = world();
    const { reporters, picture } = await scene(w);
    for (const reporter of reporters) await report(w, reporter.cookie, picture.id);
    const admin = await w.signIn(ADMIN);
    expect((await w.image(roomPicturePath(picture.id))).status).toBe(404);

    const kept = await w.fetch('PUT', keepPath(picture.id), { cookie: admin });

    expect(kept.status).toBe(204);
    expect(await pictureRow(db, picture.id)).toMatchObject({
      pic_state: 'kept',
      pic_decided_by: ADMIN,
      pic_key: picture.key,
    });
    expect((await w.image(roomPicturePath(picture.id))).status).toBe(200);
    for (const reporter of reporters) expect((await reportState(w, picture.id, reporter.address)).strikes).toBe(1);
    // Closed to further reports.
    expectNotFound(await report(w, (await seedWriter(w, R4)).cookie, picture.id));
    expect(eventsOf(logged).filter((line) => line.event === 'admin_action')).toEqual([
      { event: 'admin_action', admin: ADMIN, action: 'room_picture_keep', target: String(picture.id) },
    ]);
  });

  it(`answers and counts nowhere the reports of a wallet with ${ROOM_PICTURE_REPORT_STRIKES} strikes, and tells it nothing`, async () => {
    const w = world();
    const { reporters } = await scene(w);
    const admin = await w.signIn(ADMIN);
    for (let round = 0; round < ROOM_PICTURE_REPORT_STRIKES; round += 1) {
      const picture = await seedPicture(w, WRITER, gifTinted(round + 1), { at: at(400 - round) });
      for (const reporter of reporters) await report(w, reporter.cookie, picture.id);
      expect((await w.fetch('PUT', keepPath(picture.id), { cookie: admin })).status).toBe(204);
    }
    const next = await seedPicture(w, WRITER, gifTinted(9), { at: at(100) });
    const before = { ...(await reportState(w, next.id, R1)), ledger: await pictureLedger(w, R1) };
    expect(before.strikes).toBe(ROOM_PICTURE_REPORT_STRIKES);

    const reply = await report(w, reporters[0]?.cookie, next.id);

    expect(reply.status).toBe(204);
    expect({ ...(await reportState(w, next.id, R1)), ledger: await pictureLedger(w, R1) }).toEqual(before);
    // `me` still says that it may report: a struck wallet does not learn it.
    const me = roomMeWithPicturesResponseSchema.parse(
      (await w.fetch('GET', '/api/social/room/me', { cookie: reporters[0]?.cookie })).json,
    );
    expect(me.report).toBe(true);
  });

  it('answers 204 for a picture that is kept already and audits nothing, and the generic 404 where there is none to keep', async () => {
    const w = world();
    const { writer, picture } = await scene(w);
    const removed = await seedPicture(w, WRITER, gifTinted(4), { state: 'removed' });
    const admin = await w.signIn(ADMIN);
    expect((await w.fetch('PUT', keepPath(picture.id), { cookie: admin })).status).toBe(204);
    const audited = eventsOf(logged).filter((line) => line.event === 'admin_action').length;

    expect((await w.fetch('PUT', keepPath(picture.id), { cookie: admin })).status).toBe(204);
    expectNotFound(await w.fetch('PUT', keepPath(removed.id), { cookie: admin }));
    expectNotFound(await w.fetch('PUT', keepPath(writer.firstId), { cookie: admin }));
    expectNotFound(await w.fetch('PUT', keepPath(picture.id + 999), { cookie: admin }));

    expect(eventsOf(logged).filter((line) => line.event === 'admin_action')).toHaveLength(audited);
    expect(audited).toBe(1);
  });

  it("is an admin's alone: anyone else gets an unknown path, and nothing a wallet does lifts a state", async () => {
    const w = world();
    const { reporters, picture } = await scene(w);
    for (const reporter of reporters) await report(w, reporter.cookie, picture.id);

    expectNotFound(await w.fetch('PUT', keepPath(picture.id), { cookie: reporters[0]?.cookie }));
    expectNotFound(await w.fetch('PUT', keepPath(picture.id)));

    expect((await pictureRow(db, picture.id))?.pic_state).toBe('reported');
  });
});

describe('the switch that needs no deploy', () => {
  it('stops serving, uploading and reporting from its statement on, says `off` in the read, and still lets an admin decide', async () => {
    const w = world();
    const { writer, reporters } = await scene(w);
    const reported = await seedPicture(w, WRITER, gifTinted(2), { state: 'reported', reports: 3, at: at(300) });
    const open = await seedPicture(w, WRITER, gifTinted(3), { at: at(200) });
    const admin = await w.signIn(ADMIN);

    const off = await w.fetch('PUT', OFF_PATH, { cookie: admin });

    expect(off.status).toBe(204);
    expect(await w.deps.pictures.getPicturesOff()).toEqual({ at: NOW, by: ADMIN, why: 'admin' });
    expect((await w.image(roomPicturePath(open.id))).status).toBe(404);
    expectRefusal(await w.upload(gifTinted(7), { cookie: writer.cookie }), 'pictures_off');
    expectNotFound(await report(w, reporters[0]?.cookie, open.id));
    const read = roomWithPicturesResponseSchema.parse((await w.fetch('GET', '/api/social/room')).json);
    expect(read.pictures).toBe('off');
    // Text goes on.
    expect(
      (
        await w.fetch('POST', '/api/social/room', {
          cookie: writer.cookie,
          body: { text: 'the league looks good today' },
        })
      ).status,
    ).toBe(201);
    // A reported picture is still decided while it is set.
    expect((await w.fetch('PUT', keepPath(reported.id), { cookie: admin })).status).toBe(204);
    expect((await w.image(`${ROOM_PICTURES_ADMIN_PATH}/${reported.id}`, { cookie: admin })).status).toBe(200);
    const list = roomPicturesAdminResponseSchema.parse(
      (await w.fetch('GET', ROOM_PICTURES_ADMIN_PATH, { cookie: admin })).json,
    );
    expect(list.off).toEqual({ at: NOW, by: ADMIN, why: 'admin' });
  });

  it('is set once: the first reason stays, and a second "Pictures off" is not audited', async () => {
    const w = world();
    await w.deps.pictures.setPicturesOff(null, 'reports_hour', at(60));
    const admin = await w.signIn(ADMIN);

    expect((await w.fetch('PUT', OFF_PATH, { cookie: admin })).status).toBe(204);

    expect(await w.deps.pictures.getPicturesOff()).toEqual({ at: at(60), by: null, why: 'reports_hour' });
    expect(eventsOf(logged).filter((line) => line.event === 'admin_action')).toEqual([]);
  });

  it('is cleared by an admin alone, whoever set it', async () => {
    const w = world();
    const { reporters } = await scene(w);
    await w.deps.pictures.setPicturesOff(null, 'reports_day', NOW);

    expectNotFound(await w.fetch('DELETE', OFF_PATH, { cookie: reporters[0]?.cookie }));
    expectNotFound(await w.fetch('PUT', OFF_PATH, { cookie: reporters[0]?.cookie }));
    expectNotFound(await w.fetch('DELETE', OFF_PATH));
    expect(await w.deps.pictures.getPicturesOff()).not.toBeNull();

    expect((await w.fetch('DELETE', OFF_PATH, { cookie: await w.signIn(ADMIN) })).status).toBe(204);
    expect(await w.deps.pictures.getPicturesOff()).toBeNull();
    expect(eventsOf(logged).filter((line) => line.event === 'admin_action')).toEqual([
      { event: 'admin_action', admin: ADMIN, action: 'room_pictures_on', target: 'pictures' },
    ]);
  });

  it('gives the room its day\'s reports and its hour\'s hides again: a counted report after "Pictures on" leaves pictures on', async () => {
    // The day's hundred reports had switched pictures off (the second security look's N5).
    const w = world();
    const { reporters, picture } = await scene(w);
    await seedCount(db, REPORTS_KEY, ROOM_PICTURE_REPORTS_PER_DAY, NOW);
    await seedCount(db, HIDES_KEY, ROOM_PICTURE_AUTO_OFF_REPORTED, NOW);
    expect((await report(w, reporters[0]?.cookie, picture.id)).status).toBe(204);
    expect((await w.deps.pictures.getPicturesOff())?.why).toBe('reports_day');
    const admin = await w.signIn(ADMIN);

    expect((await w.fetch('DELETE', OFF_PATH, { cookie: admin })).status).toBe(204);

    expect(await w.deps.pictures.getPicturesOff()).toBeNull();
    expect(await counterOf(db, REPORTS_KEY)).toBe(0);
    expect(await counterOf(db, HIDES_KEY)).toBe(0);
    // The next honest reports are counted, hide the picture, and pictures stay on.
    expect((await report(w, reporters[1]?.cookie, picture.id)).status).toBe(204);
    expect((await report(w, reporters[2]?.cookie, picture.id)).status).toBe(204);
    expect(await w.deps.pictures.getPicturesOff()).toBeNull();
    expect(await reportState(w, picture.id, R2)).toMatchObject({ state: 'reported', counted: 3, reports: 2, hides: 1 });
    expect(roomWithPicturesResponseSchema.parse((await w.fetch('GET', '/api/social/room')).json).pictures).toBe('on');
  });

  it('deletes no counter and audits nothing when there is nothing to switch', async () => {
    const w = world();
    await seedCount(db, REPORTS_KEY, 40, NOW);
    await seedCount(db, HIDES_KEY, 3, NOW);
    const admin = await w.signIn(ADMIN);

    expect((await w.fetch('DELETE', OFF_PATH, { cookie: admin })).status).toBe(204);

    expect(await counterOf(db, REPORTS_KEY)).toBe(40);
    expect(await counterOf(db, HIDES_KEY)).toBe(3);
    expect(eventsOf(logged).filter((line) => line.event === 'admin_action')).toEqual([]);
  });

  it('asks for the site and the JSON type like every write of an admin', async () => {
    const w = world();
    const admin = await w.signIn(ADMIN);

    const refused: Record<string, string | null>[] = [
      { Origin: 'https://evil.example' },
      { 'Content-Type': 'text/plain' },
      { Origin: null },
    ];
    for (const headers of refused) {
      const reply = await w.fetch('PUT', OFF_PATH, { cookie: admin, headers });
      expect(reply.status, JSON.stringify(headers)).toBe(403);
    }
    expect(await w.deps.pictures.getPicturesOff()).toBeNull();
  });
});
