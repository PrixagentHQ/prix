import type {
  RoomHoldersApiDeps,
  RoomHoldingWithTier,
  RoomMeResponse,
  RoomMeWithPicturesResponse,
  RoomPostResponse,
  RoomResponse,
  RoomStatusResponse,
  RoomWithPicturesResponse,
} from '@prix/contracts';
import {
  ROOM_MESSAGES_PER_HOUR,
  ROOM_MESSAGES_PER_WALLET_PER_DAY,
  ROOM_PAGE,
  ROOM_POST_WRITE_ROWS,
  ROOM_SCAN,
  roomDayKey,
  roomFoldText,
  roomHourKey,
  roomLeftToday,
  roomPictureReporterRefusal,
  roomPictureRowRefusal,
  roomPicturesLeft,
  roomPictureViewsKey,
  roomPostRequestSchema,
  roomTextProblem,
  roomTurnRefusal,
  roomWalletDayCap,
} from '@prix/contracts';
import type { Hono } from 'hono';
import { json } from '../../errors.ts';
import { assertFromSite, enforceLimit, requireSession, requireWriter } from '../../guard.ts';
import { readInput } from '../../input.ts';
import { dayOf } from '../shared.ts';
import { roomRefusal, roomWait, turnRefusal } from './refusals.ts';
import {
  adminSet,
  holdersOn,
  holdingRefusal,
  ownHolderMark,
  pictureMessage,
  publicMessage,
  siteHostOf,
  storedHolderMark,
} from './shared.ts';

/**
 * The room's public and writer routes: docs/contracts/phase-6-room.md sections 5, 6 and 8. Mounted only
 * while the room is on.
 *
 * It is the one place of Prix that publishes what a stranger typed, so nothing of a request is trusted but
 * the text itself, and the text is judged here: the author, the time, the id, the admin mark, the one
 * allowed address and every count are the server's. No route here drops a cached answer: the entry does.
 */
export function registerRoomRoutes(app: Hono, deps: RoomHoldersApiDeps): void {
  const { room, reputation } = deps;
  const admins = adminSet(deps);
  const siteHost = siteHostOf(deps);
  // Phase 6.8 (docs/contracts/phase-6-holders-2.md section 2): the mark and the caps by tier, decided once.
  const holders = holdersOn(deps);

  /** The wallet's cap of the day from a holding the token service read: 30 while the holders' part is off. */
  const dayCapOf = (holding: RoomHoldingWithTier): number => roomWalletDayCap(holding, holders);

  /** `me`'s `dayCap`, sent only while the holders' part is on (section 2.2). */
  const withDayCap = <T extends object>(answer: T, dayCap: number): T & { dayCap?: number } =>
    holders ? { ...answer, dayCap } : answer;

  /**
   * Gives the room's count of the hour back. A count that cannot be given back stays spent until its hour
   * ends; the request still gets the answer it was on its way to. The log line names no wallet.
   */
  async function giveBack(key: string): Promise<void> {
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

  /**
   * `me` while pictures are enabled (docs/contracts/phase-6-pictures.md section 10): the same order as
   * before, the gate, the holding, the mute, with three fields more, from one read of the writer's row
   * (`getUploader` in place of `getWriter`). An admin writes and neither uploads nor reports, whatever its
   * row says. A wallet that may not write has no picture and no report.
   *
   * `picture` is what the row says of pictures alone, by `roomPictureRowRefusal`, and never a wait of the
   * room (the contract's revision 8, section 26): `yes` for null and for `picture_day`, the wallet's own
   * pictures of the day, a wait that the upload says, with none left; `new_writer` for that answer; `no`
   * for `not_allowed` and `paused`. The seconds between two messages and the wallet's messages of the day
   * are not asked here, so they hide nothing and change nothing: a wallet whose first message is seconds
   * old reads `new_writer` while it waits for its next message, and one that may add a picture reads
   * `yes` inside such a wait, which the upload then says. `roomPictureTurnRefusal` is the upload's rule and
   * is not asked here: it answers the room's turn first, and read here it offered the picker to a wallet
   * seconds after its first message (production, 2026-10-12; the upload refused it).
   *
   * `report` asks the row alone, and a struck wallet is told true, so that it does not learn it. No field
   * carries a time.
   */
  async function meWithPictures(address: string): Promise<RoomMeWithPicturesResponse> {
    const none = { picture: 'no', picturesLeft: 0, report: false } as const;
    if (admins.has(address)) {
      return withDayCap(
        { write: 'yes', left: ROOM_MESSAGES_PER_WALLET_PER_DAY, picture: 'admin', picturesLeft: 0, report: false },
        ROOM_MESSAGES_PER_WALLET_PER_DAY,
      );
    }
    // Phase 6.8: the cap of the day from the holding read here, without `cachedOnly`.
    const holding = await deps.holding(address);
    const dayCap = dayCapOf(holding);
    const refused = holdingRefusal(holding);
    if (refused !== null) return withDayCap({ write: refused, left: 0, ...none }, dayCap);
    const writer = await deps.pictures.getUploader(address);
    if (writer !== null && writer.mutedAt !== null) return withDayCap({ write: 'muted', left: 0, ...none }, dayCap);
    const now = deps.now().toISOString();
    const day = dayOf(now);
    const row = roomPictureRowRefusal(writer, now, day);
    const may = row === null || row === 'picture_day';
    const reporter = roomPictureReporterRefusal(writer, now);
    return withDayCap(
      {
        write: 'yes',
        left: roomLeftToday(writer, day, dayCap),
        picture: may ? 'yes' : row === 'new_writer' ? 'new_writer' : 'no',
        picturesLeft: may ? roomPicturesLeft(writer, day) : 0,
        report: reporter === null || reporter === 'struck',
      },
      dayCap,
    );
  }

  app.get('/social/room/status', () => json<RoomStatusResponse>({ on: true }, 200, 'public'));

  // The newest messages and nothing older. It takes no query: the URL's is never read, so no value of a
  // request can make the store read further down or make a second answer to cache. It reads no session.
  app.get('/social/room', async () => {
    // Phase 6.8 (section 2.1): while the holders' part is on, the gate is read once beside the other reads,
    // and each message's mark is its author's stored row at the route's one reading of the clock. It reads
    // no chain: the store joined the rows. Off, no message carries a `holder` field at all.
    const gateRead = holders && deps.holdersGate !== undefined ? deps.holdersGate() : null;
    if (deps.picturesEnabled) {
      // Phase 6.4: each message with its picture, and whether a page may offer "Show picture". Still one
      // cached read under one key. `off` while the switch that needs no deploy is set, else `resting`
      // while the day's views have reached the cap, else `on`.
      const now = deps.now().toISOString();
      const [read, prixAddress, gate] = await Promise.all([
        deps.pictures.readRoom(ROOM_PAGE, ROOM_SCAN, roomPictureViewsKey(dayOf(now))),
        deps.prixAddress(),
        gateRead,
      ]);
      const mark = gate === null ? undefined : storedHolderMark(gate, now);
      return json<RoomWithPicturesResponse>(
        {
          on: true,
          messages: read.messages.map((message) => pictureMessage(message, admins, now, mark)),
          pictures: read.off !== null ? 'off' : read.views >= deps.pictureViewsCap ? 'resting' : 'on',
          prixAddress,
          siteHost,
        },
        200,
        'public',
      );
    }
    // While pictures are not enabled: as Phase 6.3 answers, with neither field and no picture message.
    const [messages, prixAddress, gate] = await Promise.all([
      room.listNewest(ROOM_PAGE, ROOM_SCAN),
      deps.prixAddress(),
      gateRead,
    ]);
    const mark = gate === null ? undefined : storedHolderMark(gate, deps.now().toISOString());
    return json<RoomResponse>(
      { on: true, messages: messages.map((message) => publicMessage(message, admins, mark)), prixAddress, siteHost },
      200,
      'public',
    );
  });

  // Whether the signed-in wallet may write, asked once when the composer opens. The order is the schema's:
  // the gate, the holding, the mute. It asks the holding without `cachedOnly`: a stored read older than
  // TOKEN_CACHE_SECONDS is made again, within the token service's own budget of reads on demand. No tier
  // is asked.
  app.get('/social/room/me', async (c) => {
    const session = await requireSession(deps, c.req.raw);
    const address = session.address.toLowerCase();
    if (deps.picturesEnabled) return json<RoomMeWithPicturesResponse>(await meWithPictures(address), 200, 'private');
    // An admin is `yes` whatever its writer's row says, and takes no turn: its day is always whole.
    if (admins.has(address)) {
      return json<RoomMeResponse>(
        withDayCap({ write: 'yes', left: ROOM_MESSAGES_PER_WALLET_PER_DAY }, ROOM_MESSAGES_PER_WALLET_PER_DAY),
        200,
        'private',
      );
    }
    // Phase 6.8: the cap of the day from this same holding, read without `cachedOnly` (section 2.2).
    const holding = await deps.holding(address);
    const dayCap = dayCapOf(holding);
    const refused = holdingRefusal(holding);
    if (refused !== null) return json<RoomMeResponse>(withDayCap({ write: refused, left: 0 }, dayCap), 200, 'private');
    const writer = await room.getWriter(address);
    if (writer !== null && writer.mutedAt !== null) {
      return json<RoomMeResponse>(withDayCap({ write: 'muted', left: 0 }, dayCap), 200, 'private');
    }
    const left = roomLeftToday(writer, dayOf(deps.now().toISOString()), dayCap);
    return json<RoomMeResponse>(withDayCap({ write: 'yes', left }, dayCap), 200, 'private');
  });

  // Writing a message: the eight steps of section 5, in this order, and nothing of a later step before an
  // earlier one has passed. What each refusal leaves is said beside it. Everything a request spends before
  // the room's counts is its sender's own, so nobody uses up the room faster than by writing messages.
  app.post('/social/room', async (c) => {
    const request = c.req.raw;

    // 1. From the site, a session (401 before anything is counted), then the limiter's `write` rule for
    //    the wallet. Step 5 asks that rule again: a message counts twice against it, which is wanted.
    assertFromSite(deps, request);
    const session = await requireSession(deps, request);
    await enforceLimit(deps, 'write', session.address);
    const address = session.address.toLowerCase();

    // 2. The body, then the text, folded and judged here. The one address a message may hold comes from
    //    the token's config, never from the request. An empty string passes the schema and is refused by
    //    the rule like every other problem; a body the schema refuses keeps the input reader's own answer.
    //    A refused text counts nothing and writes nothing.
    const input = await readInput(roomPostRequestSchema, request);
    const problem = roomTextProblem(input.text, { prixAddress: await deps.prixAddress(), siteHost });
    if (problem !== null) return roomRefusal(`text_${problem}`);
    const text = roomFoldText(input.text);

    // 3. Who may write. An admin passes to step 5. Any other wallet by its stored holding (`cachedOnly`),
    //    so that a stranger cannot make the Worker read the chain with every request: it is `me` that
    //    reads a wallet's holding again. The holding is the token service's, never a figure of the
    //    request. Phase 6.8: the same stored holding gives the wallet's cap of the day by its tier
    //    (`roomWalletDayCap`, 30 while the holders' part is off), and nothing else is asked for it.
    const admin = admins.has(address);
    let holding: RoomHoldingWithTier | null = null;
    let dayCap = ROOM_MESSAGES_PER_WALLET_PER_DAY;
    if (!admin) {
      holding = await deps.holding(address, { cachedOnly: true });
      const refused = holdingRefusal(holding);
      if (refused !== null) return roomRefusal(refused);
      dayCap = dayCapOf(holding);
    }

    // The route's one reading of the clock: this `now`, with its UTC day and hour, is the one of every
    // later step.
    const at = deps.now();
    const now = at.toISOString();
    const day = dayOf(now);
    const hourKey = roomHourKey(day, at.getUTCHours());
    const dayKey = roomDayKey(day);

    // 4. Looked at, and not taken: the writer's row, then the room's two counts in one call. A muted or
    //    hurried holder and a full room cost reads and nothing else. An admin skips this step.
    if (!admin) {
      const writer = await room.getWriter(address);
      const early = roomTurnRefusal(writer, now, day, dayCap);
      if (early !== null) return turnRefusal(early, now, writer?.lastAt ?? null);
      const counts = await room.getCounts(hourKey, dayKey);
      if (counts.hour >= ROOM_MESSAGES_PER_HOUR) return roomWait('room_hour', now, null);
      if (counts.day >= deps.roomDailyCap) return roomWait('room_day', now, null);
    }

    // 5. The limiter once more, the wallet's write of the day and the day's rows, for an admin too. Its
    //    own refusals keep their own codes. From here on what it spent stays spent: the store cannot give
    //    it back.
    await requireWriter(deps, request, ROOM_POST_WRITE_ROWS);

    let left = ROOM_MESSAGES_PER_WALLET_PER_DAY;
    if (!admin) {
      // 6. The writer's turn, which decides what step 4 only looked at. A refusal or a throw leaves no
      //    turn and nothing of the room: nothing of the room was asked for yet. The turn that won the
      //    race is not known here, only that it is no older than this request, so the wait named for
      //    `too_soon` is the whole of the seconds between two messages: a bound.
      const turn = await room.takeTurn(address, now, day, dayCap);
      if (!turn.ok) return turnRefusal(turn.why, now, now);
      left = turn.left;

      // 7. The room's hour, then the room's day. When the day refuses or throws, the hour's count is
      //    given back. The turn is never given back: a count of the room costs its sender a turn first.
      if (!(await reputation.takeCounter(hourKey, ROOM_MESSAGES_PER_HOUR, day, now))) {
        return roomWait('room_hour', now, null);
      }
      let dayTaken: boolean;
      try {
        dayTaken = await reputation.takeCounter(dayKey, deps.roomDailyCap, day, now);
      } catch (error) {
        await giveBack(hourKey);
        throw error;
      }
      if (!dayTaken) {
        await giveBack(hourKey);
        return roomWait('room_day', now, null);
      }
    }

    // 8. The message. A message that fails here leaves the turn and the room's counts spent.
    //    While the holders' part is on, the answer carries the writer's mark from the cap's own holding,
    //    so the new row shows it before the next read (section 2.1).
    const message = await room.putMessage(address, text, now);
    const mark = holders ? ownHolderMark(holding) : undefined;
    return json<RoomPostResponse>({ message: publicMessage(message, admins, mark), left }, 201, 'private');
  });
}
