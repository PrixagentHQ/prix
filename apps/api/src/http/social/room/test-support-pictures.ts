import type {
  RoomMessageRecord,
  RoomPictureBytes,
  RoomPictureCounts,
  RoomPictureInput,
  RoomPictureMessageRecord,
  RoomPictureRecord,
  RoomPictureState,
  RoomPictureStore,
  RoomPicturesOff,
  RoomPicturesOffReason,
  RoomPictureTurn,
  RoomPictureType,
  RoomPictureWriterRecord,
  RoomServablePicture,
  RoomWriterRecord,
} from '@prix/contracts';
import {
  ROOM_MESSAGES_PER_WALLET_PER_DAY,
  ROOM_PICTURE_AUTO_OFF_REPORTED,
  ROOM_PICTURE_REPORTS_TO_HIDE,
  ROOM_PICTURE_TEXT,
  ROOM_PICTURE_TTL_SECONDS,
  ROOM_PICTURES_PER_WALLET_PER_DAY,
  roomPictureReportRefusal,
  roomPictureTurnRefusal,
} from '@prix/contracts';

/**
 * The pictures' store and the bytes in memory, for the unit tests of the routes: each keeps the rules its
 * interface states (packages/contracts/src/phase6-room-pictures.ts). They stand on the room's own store in
 * memory, since a picture is columns of its message's row. Every call writes a step to the one `trace` of
 * the harness. Nothing here is imported by the Worker.
 */

/** What the pictures' store needs of the room's store in memory: the two tables, and the rows it adds to. */
export interface RoomTables {
  readonly messages: RoomMessageRecord[];
  readonly writers: Map<string, RoomWriterRecord>;
  /** `room_writers.first_at`: set by `putMessage` where there is none, cleared by a hide of the message that set it. */
  readonly firstAt: Map<string, string>;
  /** The ids of picture messages: `listNewest` leaves them out. */
  readonly pictureIds: Set<number>;
  seed(author: string, text: string, at: string, hiddenAt?: string | null): RoomMessageRecord;
  setWriter(address: string, fields: Partial<RoomWriterRecord>): void;
  /** The messages the public read lets through, newest first. */
  visible(limit: number, scan: number): RoomMessageRecord[];
}

interface WriterExtra {
  picturesDay: string | null;
  picturesCount: number;
  reportsDay: string | null;
  reportsCount: number;
  reportStrikes: number;
}

interface BlockRow {
  at: string;
  by: string;
  messageId: number;
  author: string;
  postedAt: string;
  type: RoomPictureType;
  bytes: number;
  width: number;
  height: number;
  frames: number;
  reports: number;
}

export type PictureStoreMethod = keyof RoomPictureStore;

/** `RoomPictureStore` in memory, by the rules its interface states. */
export class MemoryRoomPictureStore implements RoomPictureStore {
  readonly pictures = new Map<number, RoomPictureRecord>();
  readonly extras = new Map<string, WriterExtra>();
  readonly reports: { messageId: number; reporter: string; at: string }[] = [];
  readonly blocks = new Map<string, BlockRow>();
  off: RoomPicturesOff | null = null;
  /** The methods a test makes throw, and what runs when one is called, before it looks at anything. */
  readonly fail = new Set<PictureStoreMethod>();
  readonly before = new Map<PictureStoreMethod, () => void>();

  constructor(
    private readonly trace: string[],
    private readonly room: RoomTables,
    private readonly counters: Map<string, number>,
  ) {}

  private step(method: PictureStoreMethod, detail = ''): void {
    this.trace.push(`pictures.${method}${detail}`);
    if (this.fail.has(method)) throw new Error(`${method} failed`);
    this.before.get(method)?.();
  }

  /** A picture message put straight into the tables, for a fixture. */
  seedPicture(
    author: string,
    at: string,
    fields: Partial<RoomPictureRecord> = {},
    hiddenAt: string | null = null,
  ): RoomPictureMessageRecord {
    const message = this.room.seed(author, ROOM_PICTURE_TEXT, at, hiddenAt);
    const picture: RoomPictureRecord = {
      type: 'gif',
      width: 16,
      height: 16,
      frames: 1,
      bytes: 37,
      sha256: `${String(message.id).padStart(4, '0')}${'ab'.repeat(30)}`,
      key: `pic/${String(message.id).padStart(32, '0')}`,
      state: 'ok',
      reports: 0,
      decidedAt: null,
      decidedBy: null,
      goneAt: null,
      ...fields,
    };
    this.room.pictureIds.add(message.id);
    this.pictures.set(message.id, picture);
    return { ...message, picture: { ...picture } };
  }

  setExtra(address: string, fields: Partial<WriterExtra>): void {
    this.extras.set(address, { ...this.extraOf(address), ...fields });
  }

  private extraOf(address: string): WriterExtra {
    return (
      this.extras.get(address) ?? {
        picturesDay: null,
        picturesCount: 0,
        reportsDay: null,
        reportsCount: 0,
        reportStrikes: 0,
      }
    );
  }

  private uploaderOf(address: string): RoomPictureWriterRecord | null {
    const row = this.room.writers.get(address);
    const firstAt = this.room.firstAt.get(address) ?? null;
    if (row === undefined && firstAt === null && !this.extras.has(address)) return null;
    const base: RoomWriterRecord = row ?? {
      address,
      lastAt: null,
      day: null,
      count: 0,
      mutedAt: null,
      mutedBy: null,
      cutAt: null,
    };
    let reportedOpen = 0;
    for (const message of this.room.messages) {
      if (message.author === address && this.pictures.get(message.id)?.state === 'reported') reportedOpen += 1;
    }
    return { ...base, firstAt, ...this.extraOf(address), reportedOpen };
  }

  private messageOf(id: number): RoomMessageRecord | undefined {
    return this.room.messages.find((message) => message.id === id);
  }

  private young(message: RoomMessageRecord, now: string): boolean {
    return Date.parse(message.at) > Date.parse(now) - ROOM_PICTURE_TTL_SECONDS * 1_000;
  }

  private withPicture(message: RoomMessageRecord): RoomPictureMessageRecord {
    const picture = this.pictures.get(message.id);
    return { ...message, picture: picture === undefined ? null : { ...picture } };
  }

  /** The gate's own conditions, for the states named. */
  private open(
    id: number,
    scan: number,
    now: string,
    states: readonly RoomPictureState[],
  ): { message: RoomMessageRecord; picture: RoomPictureRecord } | null {
    const message = this.messageOf(id);
    const picture = this.pictures.get(id);
    if (message === undefined || picture === undefined) return null;
    const writer = this.room.writers.get(message.author);
    const newest = this.room.messages.reduce((most, entry) => Math.max(most, entry.id), 0);
    if (!states.includes(picture.state) || picture.key === null) return null;
    if (message.hiddenAt !== null) return null;
    if (writer !== undefined && writer.mutedAt !== null) return null;
    if (writer !== undefined && writer.cutAt !== null && message.at <= writer.cutAt) return null;
    if (!(id > newest - scan) || !this.young(message, now) || this.off !== null) return null;
    return { message, picture };
  }

  async readRoom(
    limit: number,
    scan: number,
    viewsKey: string,
  ): Promise<{ messages: RoomPictureMessageRecord[]; off: RoomPicturesOff | null; views: number }> {
    this.step('readRoom', `:${limit}:${scan}:${viewsKey}`);
    return {
      messages: this.room.visible(limit, scan).map((message) => this.withPicture(message)),
      off: this.off === null ? null : { ...this.off },
      views: this.counters.get(viewsKey) ?? 0,
    };
  }

  async getServable(
    id: number,
    scan: number,
    now: string,
    viewsKey: string,
  ): Promise<{ picture: RoomServablePicture | null; views: number }> {
    this.step('getServable', `:${id}:${scan}:${viewsKey}`);
    const views = this.counters.get(viewsKey) ?? 0;
    const found = this.open(id, scan, now, ['ok', 'kept']);
    if (found === null || found.picture.key === null) return { picture: null, views };
    const { message, picture } = found;
    return {
      picture: { key: found.picture.key, type: picture.type, bytes: picture.bytes, author: message.author },
      views,
    };
  }

  async addViews(viewsKey: string, add: number): Promise<number> {
    this.step('addViews', `:${viewsKey}:${add}`);
    const count = (this.counters.get(viewsKey) ?? 0) + add;
    this.counters.set(viewsKey, count);
    return count;
  }

  async getAdminPicture(id: number, now: string): Promise<RoomServablePicture | null> {
    this.step('getAdminPicture', `:${id}`);
    const message = this.messageOf(id);
    const picture = this.pictures.get(id);
    if (message === undefined || picture === undefined || picture.key === null) return null;
    if (picture.state === 'removed' || message.hiddenAt !== null || !this.young(message, now)) return null;
    return { key: picture.key, type: picture.type, bytes: picture.bytes, author: message.author };
  }

  async getUploader(address: string): Promise<RoomPictureWriterRecord | null> {
    this.step('getUploader');
    return this.uploaderOf(address);
  }

  async getPictureCounts(keys: {
    hour: string;
    day: string;
    pictureHour: string;
    pictureDay: string;
  }): Promise<RoomPictureCounts> {
    this.step('getPictureCounts', `:${keys.hour}:${keys.day}:${keys.pictureHour}:${keys.pictureDay}`);
    return {
      off: this.off === null ? null : { ...this.off },
      hour: this.counters.get(keys.hour) ?? 0,
      day: this.counters.get(keys.day) ?? 0,
      pictureHour: this.counters.get(keys.pictureHour) ?? 0,
      pictureDay: this.counters.get(keys.pictureDay) ?? 0,
    };
  }

  async isBlocked(sha256: string): Promise<boolean> {
    this.step('isBlocked');
    return this.blocks.has(sha256);
  }

  /** Every `dayCap` the upload passed, in order (Phase 6.8): undefined when it left it out. */
  readonly dayCaps: (number | undefined)[] = [];

  async takePictureTurn(address: string, now: string, day: string, dayCap?: number): Promise<RoomPictureTurn> {
    this.step('takePictureTurn');
    this.dayCaps.push(dayCap);
    const cap = dayCap ?? ROOM_MESSAGES_PER_WALLET_PER_DAY;
    const row = this.uploaderOf(address);
    const why = roomPictureTurnRefusal(row, now, day, cap);
    if (why !== null || row === null) return { ok: false, why: why ?? 'new_writer' };
    const count = (row.day === day ? row.count : 0) + 1;
    const picturesCount = (row.picturesDay === day ? row.picturesCount : 0) + 1;
    this.room.setWriter(address, { lastAt: now, day, count });
    this.setExtra(address, { picturesDay: day, picturesCount });
    return {
      ok: true,
      left: Math.max(0, cap - count),
      picturesLeft: ROOM_PICTURES_PER_WALLET_PER_DAY - picturesCount,
    };
  }

  async putPicture(
    input: RoomPictureInput,
  ): Promise<{ ok: true; message: RoomPictureMessageRecord } | { ok: false; why: 'muted' | 'off' }> {
    this.step('putPicture');
    if ((this.room.writers.get(input.author)?.mutedAt ?? null) !== null) return { ok: false, why: 'muted' };
    if (this.off !== null) return { ok: false, why: 'off' };
    const { author, now, key, bytes, sha256, type, width, height, frames } = input;
    const stored = this.seedPicture(author, now, { type, width, height, frames, bytes, sha256, key });
    return { ok: true, message: stored };
  }

  async lookReport(
    id: number,
    reporter: string,
    scan: number,
    now: string,
  ): Promise<{ open: boolean; author: string; already: boolean; reporter: RoomPictureWriterRecord | null } | null> {
    this.step('lookReport', `:${id}:${scan}`);
    const message = this.messageOf(id);
    if (message === undefined || !this.pictures.has(id)) return null;
    return {
      open: this.open(id, scan, now, ['ok']) !== null,
      author: message.author,
      already: this.reports.some((report) => report.messageId === id && report.reporter === reporter),
      reporter: this.uploaderOf(reporter),
    };
  }

  async putReport(
    id: number,
    reporter: string,
    scan: number,
    now: string,
    day: string,
    hidesKey: string,
  ): Promise<{ counted: boolean; hid: boolean; off: boolean }> {
    this.step('putReport', `:${id}:${scan}:${hidesKey}`);
    const none = { counted: false, hid: false, off: false };
    const found = this.open(id, scan, now, ['ok']);
    if (found === null) return none;
    const row = this.uploaderOf(reporter);
    const already = this.reports.some((report) => report.messageId === id && report.reporter === reporter);
    if (roomPictureReportRefusal(row, found.message.author, already, now, day) !== null || row === null) return none;
    this.reports.push({ messageId: id, reporter, at: now });
    this.setExtra(reporter, { reportsDay: day, reportsCount: (row.reportsDay === day ? row.reportsCount : 0) + 1 });
    found.picture.reports += 1;
    if (found.picture.reports < ROOM_PICTURE_REPORTS_TO_HIDE) return { counted: true, hid: false, off: false };
    found.picture.state = 'reported';
    const hidden = (this.counters.get(hidesKey) ?? 0) + 1;
    this.counters.set(hidesKey, hidden);
    if (hidden < ROOM_PICTURE_AUTO_OFF_REPORTED || this.off !== null) return { counted: true, hid: true, off: false };
    this.off = { at: now, by: null, why: 'reports_hour' };
    return { counted: true, hid: true, off: true };
  }

  /** A removal gives up the key of a picture whose message is seven days old, with no KV call. */
  private giveUpOld(message: RoomMessageRecord, picture: RoomPictureRecord, now: string): void {
    if (picture.key === null || this.young(message, now)) return;
    picture.key = null;
    picture.goneAt = now;
  }

  async hideWithPicture(
    id: number,
    by: string,
    now: string,
  ): Promise<{ outcome: 'hidden' | 'already' | 'none'; key: string | null; removed: boolean; reports: number }> {
    this.step('hideWithPicture', `:${id}`);
    const message = this.messageOf(id);
    if (message === undefined) return { outcome: 'none', key: null, removed: false, reports: 0 };
    const outcome = message.hiddenAt === null ? 'hidden' : 'already';
    if (message.hiddenAt === null) {
      message.hiddenAt = now;
      message.hiddenBy = by;
    }
    if (this.room.firstAt.get(message.author) === message.at) this.room.firstAt.delete(message.author);
    const picture = this.pictures.get(id);
    if (picture === undefined) return { outcome, key: null, removed: false, reports: 0 };
    const removed = picture.state !== 'removed';
    if (removed) {
      picture.state = 'removed';
      picture.decidedAt = now;
      picture.decidedBy = by;
      if (!this.blocks.has(picture.sha256)) {
        const { type, bytes, width, height, frames, reports } = picture;
        this.blocks.set(picture.sha256, {
          at: now,
          by,
          messageId: id,
          author: message.author,
          postedAt: message.at,
          type,
          bytes,
          width,
          height,
          frames,
          reports,
        });
      }
    }
    this.giveUpOld(message, picture, now);
    return { outcome, key: picture.key, removed, reports: removed ? picture.reports : 0 };
  }

  async muteWithPictures(
    address: string,
    by: string,
    now: string,
    limit: number,
  ): Promise<{ muted: boolean; removed: number; pictures: { id: number; key: string }[] }> {
    this.step('muteWithPictures', `:${limit}`);
    const muted = (this.room.writers.get(address)?.mutedAt ?? null) === null;
    if (muted) this.room.setWriter(address, { mutedAt: now, mutedBy: by, cutAt: now });
    let removed = 0;
    const owed: { id: number; key: string }[] = [];
    for (const message of [...this.room.messages].sort((a, b) => b.id - a.id)) {
      const picture = this.pictures.get(message.id);
      if (message.author !== address || picture === undefined) continue;
      if (picture.state !== 'removed') {
        picture.state = 'removed';
        picture.decidedAt = now;
        picture.decidedBy = by;
        removed += 1;
      }
      this.giveUpOld(message, picture, now);
      if (picture.key !== null) owed.push({ id: message.id, key: picture.key });
    }
    return { muted, removed, pictures: owed.slice(0, limit) };
  }

  async markGone(ids: readonly number[], now: string): Promise<void> {
    this.step('markGone', `:${ids.join(',')}`);
    for (const id of ids) {
      const picture = this.pictures.get(id);
      if (picture === undefined) continue;
      picture.key = null;
      picture.goneAt = now;
    }
  }

  async keepPicture(id: number, by: string, now: string): Promise<'kept' | 'already' | 'none'> {
    this.step('keepPicture', `:${id}`);
    const picture = this.pictures.get(id);
    if (this.messageOf(id) === undefined || picture === undefined || picture.state === 'removed') return 'none';
    if (picture.state === 'kept') return 'already';
    picture.state = 'kept';
    picture.decidedAt = now;
    picture.decidedBy = by;
    for (const report of this.reports) {
      if (report.messageId !== id) continue;
      this.setExtra(report.reporter, { reportStrikes: this.extraOf(report.reporter).reportStrikes + 1 });
    }
    return 'kept';
  }

  async listOwedDeletes(limit: number): Promise<{ id: number; key: string }[]> {
    this.step('listOwedDeletes');
    const owed: { id: number; key: string }[] = [];
    for (const [id, picture] of [...this.pictures.entries()].sort((a, b) => b[0] - a[0])) {
      if (picture.state === 'removed' && picture.key !== null) owed.push({ id, key: picture.key });
    }
    return owed.slice(0, limit);
  }

  async listAllWithPictures(
    before: number | null,
    limit: number,
  ): Promise<(RoomPictureMessageRecord & { muted: boolean; cut: boolean })[]> {
    this.step('listAllWithPictures', `:${before}:${limit}`);
    return this.room.messages
      .filter((message) => before === null || message.id < before)
      .sort((a, b) => b.id - a.id)
      .slice(0, limit)
      .map((message) => {
        const writer = this.room.writers.get(message.author);
        const cutAt = writer?.cutAt ?? null;
        return {
          ...this.withPicture(message),
          muted: (writer?.mutedAt ?? null) !== null,
          cut: cutAt !== null && message.at <= cutAt,
        };
      });
  }

  async listReported(
    limit: number,
  ): Promise<(RoomPictureMessageRecord & { reporters: { address: string; at: string }[] })[]> {
    this.step('listReported', `:${limit}`);
    return this.room.messages
      .filter((message) => this.pictures.get(message.id)?.state === 'reported')
      .sort((a, b) => a.id - b.id)
      .slice(0, limit)
      .map((message) => ({
        ...this.withPicture(message),
        reporters: this.reports
          .filter((report) => report.messageId === message.id)
          .map((report) => ({ address: report.reporter, at: report.at })),
      }));
  }

  async getPicturesOff(): Promise<RoomPicturesOff | null> {
    this.step('getPicturesOff');
    return this.off === null ? null : { ...this.off };
  }

  async setPicturesOff(by: string | null, why: RoomPicturesOffReason, now: string): Promise<boolean> {
    this.step('setPicturesOff', `:${why}`);
    if (this.off !== null) return false;
    this.off = { at: now, by, why };
    return true;
  }

  async clearPicturesOff(reportsKey: string, hidesKey: string): Promise<boolean> {
    this.step('clearPicturesOff', `:${reportsKey}:${hidesKey}`);
    if (this.off === null) return false;
    this.off = null;
    this.counters.delete(reportsKey);
    this.counters.delete(hidesKey);
    return true;
  }

  /** What the store holds that a refusal could have changed, as one value to compare. */
  ledger(): unknown {
    return {
      pictures: [...this.pictures.entries()].map(([id, picture]) => ({ id, ...picture })),
      extras: [...this.extras.entries()].map(([address, extra]) => ({ address, ...extra })),
      reports: this.reports.map((report) => ({ ...report })),
      blocks: [...this.blocks.keys()],
      off: this.off === null ? null : { ...this.off },
    };
  }
}

/**
 * `RoomPictureBytes` in memory. It keeps the expiry each put was given beside the bytes, so that a test
 * finds a put that carried none, or another than the contract's. It has no list, as the port has none.
 */
export class MemoryRoomPictureBytes implements RoomPictureBytes {
  readonly held = new Map<string, { bytes: Uint8Array; ttlSeconds: number }>();
  /** Every key a delete was asked for, in order, whether it answered or threw. */
  readonly deletes: string[] = [];
  /** What a test sets to make a call throw: every put, every get, or the delete of these keys (`*`: of every key). */
  readonly fail = { put: false, get: false, delete: new Set<string>() };

  constructor(private readonly trace: string[]) {}

  async put(key: string, bytes: Uint8Array, ttlSeconds: number): Promise<void> {
    this.trace.push('bytes.put');
    if (this.fail.put) throw new Error('put failed');
    this.held.set(key, { bytes: bytes.slice(), ttlSeconds });
  }

  async get(key: string): Promise<Uint8Array | null> {
    this.trace.push('bytes.get');
    if (this.fail.get) throw new Error('get failed');
    return this.held.get(key)?.bytes.slice() ?? null;
  }

  async delete(key: string): Promise<void> {
    this.trace.push('bytes.delete');
    this.deletes.push(key);
    if (this.fail.delete.has(key) || this.fail.delete.has('*')) throw new Error('delete failed');
    this.held.delete(key);
  }

  ledger(): unknown {
    return [...this.held.entries()].map(([key, value]) => ({ key, length: value.bytes.length, ttl: value.ttlSeconds }));
  }
}

/**
 * A request's execution context that records what `waitUntil` was handed, as Cloudflare's does not let a
 * test see. The step `ctx.waitUntil` in the trace says when the hand-over happened.
 */
export class RecordingContext {
  readonly waited: Promise<unknown>[] = [];
  readonly props = {};

  constructor(private readonly trace: string[]) {}

  waitUntil(promise: Promise<unknown>): void {
    this.trace.push('ctx.waitUntil');
    this.waited.push(promise);
  }

  passThroughOnException(): void {}
}

/** Writes `value` as `count` bytes, lowest first. */
function le(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}

/**
 * A smallest GIF the contract's rule takes: one frame of `side` pixels, a table of two colours. With
 * `comment` it also carries a comment extension, which the rule drops: what is stored is then not what was
 * sent. `frames` above 1 repeats the frame.
 */
export function gifBytes(
  options: { side?: number; comment?: string; frames?: number; tint?: number } = {},
): Uint8Array {
  const side = options.side ?? 16;
  const out: number[] = [...new TextEncoder().encode('GIF89a'), ...le(side), ...le(side), 0x80, 0, 0];
  out.push(0, 0, 0, options.tint ?? 255, 255, 255);
  if (options.comment !== undefined) {
    const words = new TextEncoder().encode(options.comment);
    out.push(0x21, 0xfe, words.length, ...words, 0);
  }
  for (let frame = 0; frame < (options.frames ?? 1); frame += 1) {
    out.push(0x2c, ...le(0), ...le(0), ...le(side), ...le(side), 0, 2, 4, 0x84, 0x8f, 0xa9, 0xcb, 0);
  }
  out.push(0x3b);
  return Uint8Array.from(out);
}
