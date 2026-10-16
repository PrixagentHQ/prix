import type { RoomAllowed } from '@prix/contracts/room-text';
import { ROOM_TEXT_MAX, roomFoldText, roomTextProblem } from '@prix/contracts/room-text';

/**
 * What the two scripts of the Community chat make of an answer of the API (docs/contracts/phase-6-room.md
 * sections 5, 7 and 9). Nothing here touches the page, so every rule can be tested without a browser.
 *
 * The server's answer decides. A script reads three things of it and nothing else: the status, the
 * error's code and the error's field. It never reads the words of an answer, of a refusal or of a
 * stored line, and so can never show them: every sentence a person reads was rendered by the server
 * from the copy deck and handed to the script as data.
 *
 * A browser script loads no zod: the text rule comes from the contract's file that has none.
 */

/** An answer as a script sees it. Status 0: the call got no answer at all. */
export interface Answer {
  status: number;
  body: unknown;
}

/** The sentences the composer's script is handed, each the deck's own. */
export interface ComposerWords {
  /** One for each field of ROOM_REFUSALS, by the field's name. For a text rule, its first sentence. */
  refusals: Record<string, string>;
  /** What follows that first sentence, for each text rule and for no other field. */
  more: Record<string, string>;
  /** For both codes a refusal of `requireWriter` keeps. */
  writer: string;
  /** For a refusal the page has no sentence for. */
  other: string;
  /** For a send that got no answer, or a fault of the server. */
  sendFailed: string;
  /** With the slot `{count}`. */
  count: string;
  leftOne: string;
  /** With the slot `{count}`. */
  leftOther: string;
  /**
   * The caps of a day by holding (docs/contracts/phase-6-holders-2.md section 7, `social.roomDayCaps`), shown
   * under the composer exactly when `me` answers `dayCap`. Optional: without it nothing is shown.
   */
  dayCaps?: string;
}

/** The sentences the script of the admins' page is handed. */
export interface AdminWords {
  /** One for each code of the API, and `offline`. */
  codes: Record<string, string>;
  /** For the 400 of a mute: an admin wallet wrote the line. */
  admin: string;
}

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The code and the field of the API's error object, or nulls for a body that is not one. */
function errorOf(body: unknown): { code: string | null; field: string | null } {
  const error = isObj(body) && isObj(body.error) ? body.error : null;
  return {
    code: error && typeof error.code === 'string' ? error.code : null,
    field: error && typeof error.field === 'string' ? error.field : null,
  };
}

const WRITER_CODES: ReadonlySet<string> = new Set(['rate_limited', 'daily_limit']);

// --- the composer -----------------------------------------------------------------------------------

/**
 * The field of ROOM_REFUSALS a text would be refused with, or null: the contract's own rule, asked
 * before a send so that a writer need not wait for the server to hear it. A courtesy only.
 */
export function textRefusal(text: string, allowed: RoomAllowed): string | null {
  const problem = roomTextProblem(text, allowed);
  return problem === null ? null : `text_${problem}`;
}

/**
 * What the page says for a field of ROOM_REFUSALS: its sentence, and for a text rule what follows it,
 * which the composer sets under the sentence in regular weight. A field the page does not know gets the
 * one general sentence and nothing after it.
 */
export function refusalWords(field: string, words: ComposerWords): { sentence: string; more: string } {
  if (!Object.hasOwn(words.refusals, field)) return { sentence: words.other, more: '' };
  const more = Object.hasOwn(words.more, field) ? words.more[field] : undefined;
  return { sentence: words.refusals[field] ?? words.other, more: more ?? '' };
}

/** The count the field shows: the length of the text as it would be stored, folded. */
export function countOf(text: string): { count: number; over: boolean } {
  const count = roomFoldText(text).length;
  return { count, over: count > ROOM_TEXT_MAX };
}

export type ComposerState = 'yes' | 'not_holder' | 'muted' | 'gate_off' | 'day_used' | 'ended' | 'failed';

/**
 * What the composer shows for the answer of `GET /api/social/room/me`. The field opens only for an
 * answer that says `yes` with a whole count above zero; at zero the wallet's day is used up. Anything
 * the composer cannot read is `failed`, which keeps the field closed.
 */
export function composerState(answer: Answer): { state: ComposerState; left: number } {
  const closed = (state: ComposerState) => ({ state, left: 0 });
  if (answer.status === 401) return closed('ended');
  if (answer.status !== 200 || !isObj(answer.body)) return closed('failed');
  const { write, left } = answer.body;
  if (typeof left !== 'number' || !Number.isInteger(left) || left < 0) return closed('failed');
  if (write === 'not_holder' || write === 'muted' || write === 'gate_off') return closed(write);
  if (write !== 'yes') return closed('failed');
  return left === 0 ? closed('day_used') : { state: 'yes', left };
}

/**
 * The wallet's cap of the day as `me` answered it, or null when the answer does not carry one
 * (docs/contracts/phase-6-holders-2.md section 2.2): the API sends `dayCap` while ROOM_HOLDERS is on and
 * leaves it out while it is off. Only a 200 with a whole count counts. The page never computes a cap.
 */
export function dayCapOf(answer: Answer): number | null {
  if (answer.status !== 200 || !isObj(answer.body)) return null;
  const { dayCap } = answer.body;
  return typeof dayCap === 'number' && Number.isInteger(dayCap) && dayCap >= 0 ? dayCap : null;
}

/**
 * The sentence under the composer: the deck's `social.roomDayCaps` exactly when `me` answers `dayCap`, and
 * null otherwise. It names every cap of the contract, so it is the same sentence whatever the wallet's cap.
 */
export function dayCapsSentence(answer: Answer, words: Pick<ComposerWords, 'dayCaps'>): string | null {
  if (dayCapOf(answer) === null || typeof words.dayCaps !== 'string' || words.dayCaps === '') return null;
  return words.dayCaps;
}

/** What is left of the wallet's day, in the deck's sentence for one or for more. */
export function leftSentence(left: number, words: ComposerWords): string {
  return left === 1 ? words.leftOne : words.leftOther.replace('{count}', String(left));
}

export type SendOutcome =
  /** 201: the page is loaded again. Nothing of the answer is kept. */
  | { kind: 'sent' }
  /** A text rule: the sentence stands beside the field, and what follows it under the sentence. */
  | { kind: 'field'; sentence: string; more: string }
  /** Any other refusal, and a send that failed: the sentence stands under the form. */
  | { kind: 'notice'; sentence: string }
  /** The session ended while the page was open. */
  | { kind: 'session' }
  /** The chat was switched off between the page and the send. */
  | { kind: 'closed' };

/**
 * What a send ended as. The field of the error chooses the sentence, since the status does not tell
 * the room's refusals apart: four of them are 429 and three are 403. A field the page does not know,
 * a refusal with no field and a code with no sentence get the one general sentence.
 */
export function sendOutcome(answer: Answer, words: ComposerWords): SendOutcome {
  if (answer.status === 201) return { kind: 'sent' };
  const { code, field } = errorOf(answer.body);
  if (answer.status === 401) return { kind: 'session' };
  if (code !== null && WRITER_CODES.has(code)) return { kind: 'notice', sentence: words.writer };
  if (answer.status === 404) return { kind: 'closed' };
  if (answer.status < 400 || answer.status >= 500) return { kind: 'notice', sentence: words.sendFailed };
  if (code === 'invalid_input' && field !== null && Object.hasOwn(words.refusals, field)) {
    const said = refusalWords(field, words);
    return field.startsWith('text_') ? { kind: 'field', ...said } : { kind: 'notice', sentence: said.sentence };
  }
  return { kind: 'notice', sentence: words.other };
}

// --- pictures (docs/contracts/phase-6-pictures.md section 11) ---------------------------------------

/** The sentences the scripts of `/chat` are handed for a picture and for a report, each the deck's own. */
export interface PictureWords {
  /** One for each field of the pictures' refusals a page can show, and the room's own that an upload or a report answers. */
  refusals: Record<string, string>;
  /** What a picture may be, every number the contract's. It stands under a file the page itself refused. */
  limits: string;
  leftOne: string;
  /** With the slot `{count}`. */
  leftOther: string;
  /** With the slots `{type}`, `{width}`, `{height}` and `{size}`. */
  facts: string;
  /** For a GIF of more than one frame: with `{frames}`, `{width}`, `{height}` and `{size}`. */
  factsAnimated: string;
  /** A size in whole kilobytes of 1,024 bytes, rounded up, with the slot `{count}`: the one key `SizeKb`. */
  sizeKb: string;
  /** For both codes a refusal of the writer's budget keeps. */
  writer: string;
  /** For a refusal the page has no sentence for. */
  other: string;
  /** For an upload that got no answer, or a fault of the server. */
  sendFailed: string;
  /** For a report after the session ended. */
  session: string;
  reportDone: string;
  /** For a report that got no answer, a fault of the server, or a refusal the page does not know. */
  reportFailed: string;
  /** For the generic 404 of a report: the picture is not one that may be reported. It names no reason. */
  reportClosed: string;
}

/** What the composer offers of pictures, beside the send. */
export type PictureOffer =
  /** Nothing of pictures is shown. */
  | { kind: 'none' }
  /** "Add a picture", with the wallet's pictures left today. */
  | { kind: 'add'; left: number }
  /** The wallet has added its pictures of the day. */
  | { kind: 'day_used' }
  /** An admin wallet: the contract's note in the control's place. */
  | { kind: 'admin' }
  /** The rule of the first message, in one sentence. */
  | { kind: 'new_writer' };

/**
 * What the composer offers of pictures: from the one answer of `me`, and from the value of
 * `data-room-pictures` on the page's list, which is the read's own `pictures`. Anything is offered only
 * while that value is exactly `on`: with no list, no attribute or any other value there is nothing, and
 * nothing either for an answer of an API older than pictures or one the page cannot read.
 */
export function pictureOffer(answer: Answer, pictures: string | null): PictureOffer {
  const none: PictureOffer = { kind: 'none' };
  if (pictures !== 'on' || answer.status !== 200 || !isObj(answer.body)) return none;
  const { write, picture, picturesLeft } = answer.body;
  if (write !== 'yes') return none;
  if (picture === 'admin' || picture === 'new_writer') return { kind: picture };
  if (picture !== 'yes') return none;
  if (typeof picturesLeft !== 'number' || !Number.isInteger(picturesLeft) || picturesLeft < 0) return none;
  return picturesLeft === 0 ? { kind: 'day_used' } : { kind: 'add', left: picturesLeft };
}

/** Whether the one answer of `me` says this wallet may report a picture. The server judges every report again. */
export function reportOn(answer: Answer): boolean {
  return answer.status === 200 && isObj(answer.body) && answer.body.report === true;
}

/** What is left of the wallet's pictures today, in the deck's sentence for one or for more. */
export function picturesLeftSentence(left: number, words: PictureWords): string {
  return left === 1 ? words.leftOne : words.leftOther.replace('{count}', String(left));
}

/** What an upload ended as: the page is loaded again, the session ended, or one sentence under the form. */
export type PictureOutcome = { kind: 'sent' } | { kind: 'session' } | { kind: 'notice'; sentence: string };

/**
 * What an upload ended as. The field chooses the sentence, never the status: `picture_storage` is a 503
 * like a fault of the server, and six refusals are 403. A 404 is the route of a room whose pictures are
 * not enabled any more, so it reads as pictures that are switched off.
 */
export function pictureOutcome(answer: Answer, words: PictureWords): PictureOutcome {
  if (answer.status === 201) return { kind: 'sent' };
  if (answer.status === 401) return { kind: 'session' };
  const { code, field } = errorOf(answer.body);
  if (code !== null && WRITER_CODES.has(code)) return { kind: 'notice', sentence: words.writer };
  if (code === 'invalid_input' && field !== null && Object.hasOwn(words.refusals, field)) {
    return { kind: 'notice', sentence: words.refusals[field] ?? words.other };
  }
  if (answer.status === 404) return { kind: 'notice', sentence: words.refusals.pictures_off ?? words.other };
  if (answer.status < 400 || answer.status >= 500) return { kind: 'notice', sentence: words.sendFailed };
  return { kind: 'notice', sentence: words.other };
}

/**
 * The sentence a report ended as. 204 is the one sentence whatever the server counted: a reporter never
 * learns a count, nor whether the report hid the picture.
 */
export function reportSentence(answer: Answer, words: PictureWords): string {
  if (answer.status === 204) return words.reportDone;
  if (answer.status === 401) return words.session;
  const { code, field } = errorOf(answer.body);
  if (code !== null && WRITER_CODES.has(code)) return words.writer;
  if (code === 'invalid_input' && field !== null && Object.hasOwn(words.refusals, field)) {
    return words.refusals[field] ?? words.reportFailed;
  }
  if (answer.status === 404) return words.reportClosed;
  return words.reportFailed;
}

/** What is said of a picture's file: its type, its sides, its size, and for a GIF that moves its frames. */
export interface PictureFacts {
  type: string;
  width: number;
  height: number;
  frames: number;
  bytes: number;
}

/** A whole number as the site prints one: grouped in thousands ("1,600"). */
const grouped = (value: number): string => value.toLocaleString('en-US');

/**
 * The facts of a picture in the deck's sentence. The sides are printed grouped. The size is whole
 * kilobytes of 1,024 bytes ROUNDED UP, by the one key `SizeKb`, so that a file never reads smaller than
 * it is and a file below one kilobyte reads as one.
 */
export function factsSentence(
  facts: PictureFacts,
  words: Pick<PictureWords, 'facts' | 'factsAnimated' | 'sizeKb'>,
): string {
  const slots: Record<string, string> = {
    type: facts.type.toUpperCase(),
    width: grouped(facts.width),
    height: grouped(facts.height),
    frames: grouped(facts.frames),
    size: words.sizeKb.replace('{count}', grouped(Math.max(1, Math.ceil(facts.bytes / 1024)))),
  };
  const sentence = facts.type === 'gif' && facts.frames > 1 ? words.factsAnimated : words.facts;
  return sentence.replace(/\{(\w+)\}/g, (match, name: string) => slots[name] ?? match);
}

// --- the admins' page -------------------------------------------------------------------------------

export type AdminOutcome = { kind: 'done' } | { kind: 'session' } | { kind: 'failed'; sentence: string };

/**
 * What a control of the admins' page ended as: 204 is done; the generic 404 is a line that is no
 * longer stored; the 400 of the field `admin` is a mute of an admin's line. The sentence comes from
 * the code, never from the answer's words.
 */
export function adminOutcome(answer: Answer, words: AdminWords): AdminOutcome {
  if (answer.status === 204) return { kind: 'done' };
  if (answer.status === 401) return { kind: 'session' };
  const { code, field } = errorOf(answer.body);
  const fallback = words.codes.internal ?? '';
  if (answer.status === 0) return { kind: 'failed', sentence: words.codes.offline ?? fallback };
  if (code === 'invalid_input' && field === 'admin') return { kind: 'failed', sentence: words.admin };
  if (answer.status === 404) return { kind: 'failed', sentence: words.codes.not_found ?? fallback };
  const known = code !== null && Object.hasOwn(words.codes, code) ? words.codes[code] : undefined;
  return { kind: 'failed', sentence: known ?? fallback };
}
