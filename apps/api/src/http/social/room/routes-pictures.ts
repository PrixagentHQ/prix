import type { RoomHoldersApiDeps, RoomPicturePostResponse } from '@prix/contracts';
import {
  newRoomPictureKey,
  ROOM_MESSAGES_PER_HOUR,
  ROOM_PICTURE_AUTO_OFF_REPORTED,
  ROOM_PICTURE_BODY_SECONDS,
  ROOM_PICTURE_LOG_EVENTS,
  ROOM_PICTURE_MAX_BYTES,
  ROOM_PICTURE_MIN_BYTES,
  ROOM_PICTURE_POST_WRITE_ROWS,
  ROOM_PICTURE_REPORT_FIELDS,
  ROOM_PICTURE_REPORT_WRITE_ROWS,
  ROOM_PICTURE_REPORTS_PER_DAY,
  ROOM_PICTURE_TTL_SECONDS,
  ROOM_PICTURE_VIEW_SAMPLE,
  ROOM_PICTURES_PER_HOUR,
  ROOM_SCAN,
  roomDayKey,
  roomHourKey,
  roomIdParamSchema,
  roomPictureCheck,
  roomPictureDayKey,
  roomPictureHourKey,
  roomPictureReportHidesKey,
  roomPictureReportRefusal,
  roomPictureReportsKey,
  roomPictureTurnRefusal,
  roomPictureViewsKey,
  roomWalletDayCap,
} from '@prix/contracts';
import type { Hono } from 'hono';
import { failures, json, noContent } from '../../errors.ts';
import {
  assertFromSite,
  assertPictureFromSite,
  clientNetwork,
  enforceLimit,
  requireSession,
  requireWriter,
  spendWrite,
} from '../../guard.ts';
import { matches } from '../../input.ts';
import { dayOf } from '../shared.ts';
import {
  pictureBytesFailure,
  pictureRefusal,
  pictureTurnRefusal,
  pictureWait,
  roomRefusal,
  roomWait,
} from './refusals.ts';
import {
  adminSet,
  fromOwnImage,
  holdersOn,
  logPicture,
  logWorkFault,
  ownHolderMark,
  pictureHoldingRefusal,
  pictureMessage,
  servePicture,
} from './shared.ts';

/**
 * The length a request declares for its body, when it is one a picture may have: present, digits only,
 * from the least to the most bytes of a picture. Null otherwise. Judged before a byte is read.
 */
function declaredPictureLength(request: Request): number | null {
  const declared = request.headers.get('content-length');
  if (declared === null || !/^\d{1,7}$/.test(declared)) return null;
  const length = Number(declared);
  return length >= ROOM_PICTURE_MIN_BYTES && length <= ROOM_PICTURE_MAX_BYTES ? length : null;
}

/**
 * Reads exactly `declared` bytes of a body through a counting reader, against one deadline, and nothing
 * past them. Null when the body is absent, shorter or longer than declared, when it broke, or when it had
 * not come whole after `seconds`: each is `picture_malformed` for the caller, and none is ever a 500.
 *
 * - ONE timer for the whole body, started here, which every read races: never a timer for each read, or a
 *   body that trickles would never end. When the timer wins, the reader is cancelled.
 * - Each read races a promise made for that read alone, which the one timer settles through `wake`. Never
 *   one promise for the whole body: a race leaves its outcome reachable from every promise it was given
 *   that is still pending, so a promise that lives as long as the body keeps every finished read, and the
 *   buffer under its piece, until the timer is cleared. `late` is looked at before each read.
 * - A read that rejects (the client hung up, the body broke) is answered as a body that is not whole.
 * - No piece is kept. The Workers runtime hands each piece on a buffer of 4,096 bytes whatever the piece
 *   carries, so the pieces of a body written a byte at a time are 4,096 times the body. One buffer of the
 *   declared length is made when the first piece arrives, never before, and each piece is copied into it
 *   at its place. At its worst the reader holds `declared` bytes and the buffer of the one piece in its
 *   hands. A body longer than declared is refused as soon as it is, without waiting for its end, and the
 *   piece that passes the length is not copied.
 * - Never `request.arrayBuffer()`: Cloudflare itself accepts a body of 100 MB, and a length is only what a
 *   client says.
 */
async function readDeclaredBody(request: Request, declared: number, seconds: number): Promise<Uint8Array | null> {
  if (request.body === null) return null;
  const reader = request.body.getReader();
  // A cancel is asked for and not waited for: the answer never hangs on a stream that will not end, and a
  // cancel that rejects changes nothing.
  const stop = (): void => {
    reader.cancel().catch(() => undefined);
  };
  // Whether the one timer has fired. Looked at before each read, because the timer fires once and wakes
  // only the read that is waiting then: one that had already won its race is not woken, and the read begun
  // after it would wait for ever.
  let late = false;
  // Settles the promise that the read waiting now races. Set anew for each read.
  let wake: (() => void) | undefined;
  const timer = setTimeout(() => {
    late = true;
    wake?.();
  }, seconds * 1_000);
  let bytes: Uint8Array | null = null;
  let received = 0;
  try {
    for (;;) {
      if (late) {
        stop();
        return null;
      }
      const next = await Promise.race([
        reader.read(),
        new Promise<'late'>((resolve) => {
          wake = () => resolve('late');
        }),
      ]);
      if (next === 'late') {
        stop();
        return null;
      }
      if (next.done) break;
      const piece = next.value as Uint8Array;
      if (received + piece.byteLength > declared) {
        stop();
        return null;
      }
      bytes ??= new Uint8Array(declared);
      bytes.set(piece, received);
      received += piece.byteLength;
    }
  } catch {
    stop();
    return null;
  } finally {
    clearTimeout(timer);
  }
  return received === declared ? bytes : null;
}

/** SHA-256 of the bytes that are stored, in lower-case hex. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  let hex = '';
  for (const byte of digest) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/**
 * The upload of a picture, its bytes and the report: docs/contracts/phase-6-pictures.md sections 5, 7 and
 * 8. Mounted only while pictures are enabled.
 *
 * A picture is the first thing in Prix that a stranger made and Prix cannot read. So nothing of a request
 * is trusted but the bytes themselves, and of those only what `roomPictureCheck` hands back is stored: the
 * type, the dimensions, the frames, the size, the key, the author, the time and every count are the
 * server's. No route here drops a cached answer and none has a handle on the Cache API.
 */
export function registerRoomPictureRoutes(app: Hono, deps: RoomHoldersApiDeps): void {
  const { pictures, bytes, reputation } = deps;
  const admins = adminSet(deps);

  /**
   * Gives a count of the room back. A count that cannot be given back stays spent until its hour or its
   * day ends; the request still gets the answer it was on its way to. The log line names no wallet.
   */
  async function giveBack(keys: readonly string[]): Promise<void> {
    for (const key of [...keys].reverse()) {
      try {
        await reputation.giveBackCounter(key);
      } catch (error) {
        console.error(
          JSON.stringify({
            event: 'room_count_not_given_back',
            error: error instanceof Error ? error.name : 'unknown',
          }),
        );
      }
    }
  }

  // Uploading a picture: the eleven steps of section 5, in this order, and nothing of a later step before
  // an earlier one has passed. What each refusal leaves is said beside it. Steps 1 to 5 leave nothing: no
  // row, no count, no key; steps 1 to 3 read no byte of the body.
  app.post('/social/room/pictures', async (c) => {
    const request = c.req.raw;

    // 1. From the chat's own page, as that page sends it: the guard's own refusal. Then the length the
    //    request declares, with no byte read. Then the session (401 before anything is counted), then the
    //    limiter's `write` rule for the wallet. Step 6 asks that rule again.
    assertPictureFromSite(deps, request);
    const declared = declaredPictureLength(request);
    if (declared === null) return pictureRefusal('picture_size');
    const session = await requireSession(deps, request);
    await enforceLimit(deps, 'write', session.address);
    const address = session.address.toLowerCase();

    // 2. Who. An admin wallet uploads nothing: Prix never posts a picture here. Any other wallet by its
    //    stored holding (`cachedOnly`), which is the token service's and never a figure of the request.
    if (admins.has(address)) return pictureRefusal('picture_admin');
    const holding = await deps.holding(address, { cachedOnly: true });
    const held = pictureHoldingRefusal(holding);
    if (held !== null) return roomRefusal(held);
    // Phase 6.8 (docs/contracts/phase-6-holders-2.md section 2.2): a picture is a message, and counts
    // against the wallet's cap of the day by the tier of this same stored holding (30 while off).
    const holders = holdersOn(deps);
    const dayCap = roomWalletDayCap(holding, holders);

    // The route's reading of the clock: this `now`, with its UTC day and hour, is the one of every later
    // step. The clock is read once more after step 5, only to refuse a request whose body took too long.
    const at = deps.now();
    const now = at.toISOString();
    const day = dayOf(now);
    const hour = at.getUTCHours();
    // The room's four counts, in the order step 9 takes them.
    const counts = [
      { key: roomHourKey(day, hour), cap: ROOM_MESSAGES_PER_HOUR, refuse: () => roomWait('room_hour', now, null) },
      { key: roomDayKey(day), cap: deps.roomDailyCap, refuse: () => roomWait('room_day', now, null) },
      {
        key: roomPictureHourKey(day, hour),
        cap: ROOM_PICTURES_PER_HOUR,
        refuse: () => pictureWait('picture_room_hour', now),
      },
      { key: roomPictureDayKey(day), cap: deps.picturesDailyCap, refuse: () => pictureWait('picture_room_day', now) },
    ] as const;
    const [roomHour, roomDay, pictureHour, pictureDay] = counts;

    // 3. Looked at, and not taken: the writer's row, then the switch and the room's four counts in one
    //    call. A wallet that may not upload and a full room cost reads and nothing else.
    const uploader = await pictures.getUploader(address);
    const early = roomPictureTurnRefusal(uploader, now, day, dayCap);
    if (early !== null) return pictureTurnRefusal(early, now, uploader?.lastAt ?? null);
    const stand = await pictures.getPictureCounts({
      hour: roomHour.key,
      day: roomDay.key,
      pictureHour: pictureHour.key,
      pictureDay: pictureDay.key,
    });
    if (stand.off !== null) return pictureRefusal('pictures_off');
    if (stand.hour >= roomHour.cap) return roomHour.refuse();
    if (stand.day >= roomDay.cap) return roomDay.refuse();
    if (stand.pictureHour >= pictureHour.cap) return pictureHour.refuse();
    if (stand.pictureDay >= pictureDay.cap) return pictureDay.refuse();

    // 4. Only now the body, through the counting reader and against its deadline: one timer for the whole
    //    body, started here. Received must equal declared. A body that is late, broken, shorter or longer
    //    is malformed, with nothing spent.
    const sent = await readDeclaredBody(request, declared, ROOM_PICTURE_BODY_SECONDS);
    if (sent === null) return pictureRefusal('picture_malformed');

    // 5. The rule, on whatever arrived. Only its own serialisation goes on: `checked.bytes`. Then the
    //    hash of those bytes, kept for step 8. Nothing is asked of D1 here.
    const checked = roomPictureCheck(sent);
    if (!checked.ok) return pictureRefusal(`picture_${checked.problem}`);
    const clean = checked.bytes;
    const sha256 = await sha256Hex(clean);

    // The clock, once more, after step 5 and before the context is taken, for one thing only: a request
    // that is more than the body's seconds past its own `now` is refused, with nothing spent. This is the
    // rule by the route's own clock, whatever the timer of step 4 did: steps 6 to 11 never run on a `now`
    // that is older than that, so no count lands on an hour or a day that has passed. This reading is
    // never a step's `now`, day or hour.
    if (deps.now().getTime() - at.getTime() > ROOM_PICTURE_BODY_SECONDS * 1_000) {
      return pictureRefusal('picture_malformed');
    }

    // Steps 6 to 11, as one piece of work. What it spends and what each refusal leaves is said beside each
    // step. A refusal of the room or of a picture is its answer; a refusal of the guard and a fault are
    // thrown, and reach the error handler through the `await` below. A fault is logged here first, with
    // the number of its step, because the handler never sees it once the client has left.
    let step = 6;
    const steps = async (): Promise<Response> => {
      // 6. The limiter once more, the wallet's write of the day and the day's rows. Its refusals keep
      //    their own codes, and it leaves what it spent itself.
      await spendWrite(deps, session.address, ROOM_PICTURE_POST_WRITE_ROWS);

      // 7. The turn, which decides what step 3 only looked at: the message's turn and the wallet's
      //    picture of the day, both or neither. A refusal leaves no turn. The turn that won a race is no
      //    older than this request, so the wait named for `too_soon` is the whole of the seconds between
      //    two messages.
      step = 7;
      const turn = await pictures.takePictureTurn(address, now, day, dayCap);
      if (!turn.ok) return pictureTurnRefusal(turn.why, now, now);

      // 8. Whether an admin removed these bytes before. Asked only now, so that the answer costs the
      //    wallet a turn and one of its pictures of the day.
      step = 8;
      if (await pictures.isBlocked(sha256)) return pictureRefusal('picture_blocked');

      // 9. The room's four counts, in their order. A refusal or a throw gives back what this step took;
      //    the turn is never given back.
      step = 9;
      const taken: string[] = [];
      for (const count of counts) {
        let took: boolean;
        try {
          took = await reputation.takeCounter(count.key, count.cap, day, now);
        } catch (error) {
          await giveBack(taken);
          throw error;
        }
        if (!took) {
          await giveBack(taken);
          return count.refuse();
        }
        taken.push(count.key);
      }

      // 10. The bytes, under a key made here, with the seven days of expiry. From here on no count is
      //     given back: a put that threw may have written, and the day's count of pictures is what bounds
      //     the puts of a day. A put that throws is answered and is no fault of the work.
      step = 10;
      const key = newRoomPictureKey();
      try {
        await bytes.put(key, clean, ROOM_PICTURE_TTL_SECONDS);
      } catch {
        return pictureWait('picture_storage', now);
      }

      // 11. The message and its picture, in one insert. Every field is the server's.
      step = 11;
      let stored: Awaited<ReturnType<typeof pictures.putPicture>>;
      try {
        stored = await pictures.putPicture({
          author: address,
          now,
          key,
          type: checked.type,
          width: checked.width,
          height: checked.height,
          frames: checked.frames,
          bytes: clean.length,
          sha256,
        });
      } catch (error) {
        // The insert may have stored the row, so the key is left as it is: a key that no row names
        // expires within the seven days.
        logPicture(ROOM_PICTURE_LOG_EVENTS.orphan, { count: 1 });
        throw error;
      }
      if (!stored.ok) {
        // No row names the key. One delete is tried, once and never again: a key that stays expires.
        logPicture(ROOM_PICTURE_LOG_EVENTS.orphan, { count: 1 });
        try {
          await bytes.delete(key);
        } catch {
          // Left to its expiry.
        }
        return stored.why === 'muted' ? roomRefusal('muted') : pictureRefusal('pictures_off');
      }
      return json<RoomPicturePostResponse>(
        {
          message: pictureMessage(stored.message, admins, now, holders ? ownHolderMark(holding) : undefined),
          left: turn.left,
          picturesLeft: turn.picturesLeft,
        },
        201,
        'private',
      );
    };
    const run = (): Promise<Response> =>
      steps().catch((error: unknown) => {
        logWorkFault(ROOM_PICTURE_LOG_EVENTS.uploadFailed, step, error);
        throw error;
      });

    // From step 6 on the route is one promise, handed to the request's execution context before it is
    // awaited, so that a client that leaves does not stop it between a count and the insert. The context
    // is taken here, once, and outside any `try`: with none this line throws, the upload is a 500 with
    // nothing spent, and no path runs steps 6 to 11 without `waitUntil`. There is no fallback. Nothing of
    // step 6 is called before the hand-over, and what is handed over never rejects.
    const ctx = c.executionCtx;
    const work = Promise.resolve().then(run);
    ctx.waitUntil(
      work.then(
        () => undefined,
        () => undefined,
      ),
    );
    return await work;
  });

  // The bytes of a picture: the nine steps of section 7. It reads no session and no query, and nothing of
  // the request but its two fetch headers, its id and where it comes from. Every answer that is not a 200
  // is JSON and never cached; no answer of this route ever enters a cache.
  app.get('/social/room/pictures/:id', async (c) => {
    const request = c.req.raw;

    // 1. A HEAD never runs the route. The entry answers it before the app is asked; this is the same
    //    answer for a caller that has no entry in front of it.
    if (request.method !== 'GET') return headNotAllowed();

    // 2. Only an `<img>` on the site's own pages: both headers present and exactly so, else the generic
    //    404 with no D1 and no KV. A hard rule: this is what keeps a file that is also a script inert.
    if (!fromOwnImage(request)) throw failures.routeNotFound();

    // 3. The id's shape.
    const param = c.req.param('id');
    if (!matches(roomIdParamSchema, param)) throw failures.routeNotFound();
    const id = Number(param);

    // 4. The `picture` rule of the limiter, for the network the request comes from: never the /64.
    if (!(await deps.pictureLimiter.allow(clientNetwork(request)))) throw failures.rateLimited(60);

    // 5. The gate: D1 decides, in one statement, before KV is asked anything. At the day's cap of views
    //    every picture rests; otherwise one answer for every reason a picture is not served.
    const now = deps.now().toISOString();
    const viewsKey = roomPictureViewsKey(dayOf(now));
    const { picture, views } = await pictures.getServable(id, ROOM_SCAN, now, viewsKey);
    if (views >= deps.pictureViewsCap) return pictureWait('picture_views_day', now);
    if (picture === null || admins.has(picture.author.toLowerCase())) throw failures.routeNotFound();

    // 6. One view in 25 is counted, as 25. A view that cannot be counted is not served.
    if (deps.random() * ROOM_PICTURE_VIEW_SAMPLE < 1) {
      let count: number;
      try {
        count = await pictures.addViews(viewsKey, ROOM_PICTURE_VIEW_SAMPLE, now);
      } catch {
        return pictureBytesFailure();
      }
      // Once a day, by the one request whose sample crossed the cap.
      if (count >= deps.pictureViewsCap && count - ROOM_PICTURE_VIEW_SAMPLE < deps.pictureViewsCap) {
        logPicture(ROOM_PICTURE_LOG_EVENTS.viewsCap, { count });
      }
    }

    // 7 to 9. The bytes, their length against the row, and the whole header set.
    return servePicture(bytes, id, picture);
  });

  // Reporting a picture: the seven steps of section 8. It takes no body and no free text: no stranger's
  // words reach an admin. A report deletes nothing and never learns a count.
  app.post('/social/room/pictures/:id/report', async (c) => {
    const request = c.req.raw;

    // 1. From the site, a session, the limiter's `write` rule for the wallet; then the id's shape.
    assertFromSite(deps, request);
    const session = await requireSession(deps, request);
    await enforceLimit(deps, 'write', session.address);
    const param = c.req.param('id');
    if (!matches(roomIdParamSchema, param)) throw failures.routeNotFound();
    const id = Number(param);
    const reporter = session.address.toLowerCase();

    // 2. Who. An admin wallet reports nothing: an admin removes. Any other wallet by its stored holding.
    if (admins.has(reporter)) return pictureRefusal('picture_admin');
    const held = pictureHoldingRefusal(await deps.holding(reporter, { cachedOnly: true }));
    if (held !== null) return roomRefusal(held);

    // The route's one reading of the clock.
    const at = deps.now();
    const now = at.toISOString();
    const day = dayOf(now);

    // 3. Looked at, and nothing written. A picture the public does not see and may not report is the
    //    generic 404, whatever the reason; so is one whose writer is an admin wallet now, which the store
    //    cannot know. Then the one order of the refusals: a struck wallet and a second report of one
    //    picture are answered as a counted report is, with nothing written.
    const look = await pictures.lookReport(id, reporter, ROOM_SCAN, now);
    if (look === null || !look.open || admins.has(look.author.toLowerCase())) throw failures.routeNotFound();
    const refused = roomPictureReportRefusal(look.reporter, look.author, look.already, now, day);
    if (refused === 'struck' || refused === 'already') return noContent();
    if (refused !== null) {
      const field = ROOM_PICTURE_REPORT_FIELDS[refused];
      if (field === 'muted') return roomRefusal('muted');
      return field === 'report_wallet_day' ? pictureWait(field, now) : pictureRefusal(field);
    }

    // Steps 4 to 6, as one piece of work. A refusal of the guard and a fault are thrown, and reach the
    // error handler through the `await` below. A fault is logged here first, with the number of its step,
    // because the handler never sees it once the reporter has left.
    let step = 4;
    const steps = async (): Promise<void> => {
      // 4. The limiter once more, the wallet's write of the day and the day's rows.
      await requireWriter(deps, request, ROOM_PICTURE_REPORT_WRITE_ROWS);

      // 5. The report, each write under every condition step 3 only looked at.
      step = 5;
      const done = await pictures.putReport(
        id,
        reporter,
        ROOM_SCAN,
        now,
        day,
        roomPictureReportHidesKey(day, at.getUTCHours()),
      );
      if (done.hid) logPicture(ROOM_PICTURE_LOG_EVENTS.reported, { id });
      if (done.off) logPicture(ROOM_PICTURE_LOG_EVENTS.autoOff, { count: ROOM_PICTURE_AUTO_OFF_REPORTED });

      // 6. Only for a report that was counted: one of the room's reports of the day. The counted report
      //    that finds them spent switches pictures off: a crowd can buy that, never that a picture stays up.
      step = 6;
      if (done.counted) {
        const key = roomPictureReportsKey(day);
        if (!(await reputation.takeCounter(key, ROOM_PICTURE_REPORTS_PER_DAY, day, now))) {
          if (await pictures.setPicturesOff(null, 'reports_day', now)) {
            logPicture(ROOM_PICTURE_LOG_EVENTS.autoOff, { count: ROOM_PICTURE_REPORTS_PER_DAY });
          }
        }
      }
    };
    const run = (): Promise<void> =>
      steps().catch((error: unknown) => {
        logWorkFault(ROOM_PICTURE_LOG_EVENTS.reportFailed, step, error);
        throw error;
      });

    // From step 4 on the route is one promise, handed to the request's execution context before it is
    // awaited, in the upload's own order: a reporter who leaves after the report was counted does not keep
    // it out of the room's reports of the day. The context is taken here, once, and outside any `try`:
    // with none this line throws, the report is a 500 with nothing written, and no path runs steps 4 to 6
    // without `waitUntil`. There is no fallback. Nothing of step 4 is called before the hand-over, and
    // what is handed over never rejects.
    const ctx = c.executionCtx;
    const work = Promise.resolve().then(run);
    ctx.waitUntil(
      work.then(
        () => undefined,
        () => undefined,
      ),
    );
    await work;

    // 7. Always: a reporter never learns a count, nor whether the report hid the picture.
    return noContent();
  });
}

/** The answer to a HEAD of a picture's bytes: 405, and the one method that reads them. As the entry answers it. */
function headNotAllowed(): Response {
  return new Response(null, { status: 405, headers: { Allow: 'GET', 'Cache-Control': 'no-store' } });
}
