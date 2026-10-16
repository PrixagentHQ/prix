import type { RoomPictureView, RoomWithPicturesResponse } from '@prix/contracts';
import { ROOM_PICTURE_ALT, ROOM_TOKEN_NOTE } from '@prix/contracts';
import { formatCount } from '../../../content/format.ts';
import { text } from '../../../content/index.ts';
import { siteHref } from '../../words.ts';

/**
 * The links, the one chosen sentence and the one filled sentence of the Community chat's page. Server
 * only. The sentences are the editor's keys (`social.room<Name>`) or the contract's own (ROOM_DISCLAIMER,
 * ROOM_TOKEN_NOTE), read where they are shown. The editor's sentence says what a wallet must hold to
 * write, with the contract's figure already in it: nothing here fills it.
 */

/**
 * The page itself: where "Load new messages" leads, and the entry of the Social navigation. It carries no
 * query of the page it is rendered on (a sample build keeps its `fixture`, as every link of the site does).
 */
export const roomHref = (current: URL): string => siteHref('/chat', {}, current);

/**
 * What an empty room says under its title. A visitor who is not signed in reads how to write; a signed-in
 * one is never told to sign in, and whether that wallet can write is the composer's to say, above the list.
 * `signedIn` is what the API confirmed of the session, as the route file read it.
 */
export function emptyRoomBody(signedIn: boolean): string {
  return signedIn
    ? text(
        'social.roomEmptyBodySignedIn',
        'There is nothing to read here right now. If this wallet can write, the first message is yours to send above.',
      )
    : text(
        'social.roomEmptyBody',
        'There is nothing to read here right now. To write a message, sign in with a wallet that holds at least 1 $PRIX.',
      );
}

/** ROOM_TOKEN_NOTE around its address, so that the page can set the address as a piece of its own. */
export interface TokenNote {
  before: string;
  address: string;
  after: string;
}

/** The contract's note on the token with `{address}` filled, or null while the token has no address. */
export function tokenNoteParts(prixAddress: string | null): TokenNote | null {
  if (prixAddress === null) return null;
  const slot = '{address}';
  const at = ROOM_TOKEN_NOTE.indexOf(slot);
  // A note without the slot would name no address: it is shown whole, and the address after it.
  if (at < 0) return { before: `${ROOM_TOKEN_NOTE} `, address: prixAddress, after: '' };
  return { before: ROOM_TOKEN_NOTE.slice(0, at), address: prixAddress, after: ROOM_TOKEN_NOTE.slice(at + slot.length) };
}

// --- pictures (docs/contracts/phase-6-pictures.md, section 11) -----------------------------------------
//
// The names of the keys are the contract's (ROOM_PICTURE_COPY_KEYS) and the words are the editor's; each
// draft below is the deck's own sentence for that key. Two sentences are the contract's own and are read
// where they are shown: ROOM_PICTURE_DISCLAIMER on the page and ROOM_PICTURE_ROW_NOTE in a row.

/** The words of a picture's row that are the same in every row. Read once for a list. */
export interface PictureWords {
  show: string;
  hide: string;
  report: string;
  off: string;
  /** The long sentence of resting pictures: the page says it once, under the heading of the list. */
  resting: string;
  /** The short form every picture row keeps while pictures rest. */
  restingRow: string;
  reported: string;
  gone: string;
  loadFailed: string;
}

export function pictureWords(): PictureWords {
  return {
    show: text('social.roomPictureShow', 'Show picture'),
    hide: text('social.roomPictureHide', 'Hide picture'),
    report: text('social.roomPictureReport', 'Report picture'),
    off: text('social.roomPictureOff', 'Pictures are switched off for now.'),
    resting: text(
      'social.roomPictureResting',
      'The chat has shown as many pictures as it shows in one day. Pictures can be shown again after 00:00 UTC.',
    ),
    restingRow: text('social.roomPictureRestingRow', 'Not shown until 00:00 UTC.'),
    reported: text(
      'social.roomPictureReported',
      'Hidden after reports from users. An admin of Prix decides whether it is shown again.',
    ),
    gone: text('social.roomPictureGone', 'This picture is no longer available.'),
    loadFailed: text(
      'social.roomPictureLoadFailed',
      'This picture is not available right now. Reload the page to try again.',
    ),
  };
}

/**
 * The size of a file as a row says it: whole kilobytes of 1,024 bytes, rounded up, by the contract's one
 * key. So a file never reads smaller than it is, and one below a kilobyte reads "1 KB". `bytes` is the
 * server's count; this only writes it shorter.
 */
export function pictureSize(bytes: number): string {
  return text('social.roomPictureSizeKb', '{count} KB', { count: formatCount(Math.max(1, Math.ceil(bytes / 1_024))) });
}

/**
 * The facts of a file in a row: its type, its sides and its size, and for a GIF of more than one frame
 * that it moves and how many frames it has, so that a reader knows before the click. Every figure is the
 * server's own (it read them from the file it stored); nothing here is measured or guessed.
 */
export function pictureFacts(picture: Pick<RoomPictureView, 'type' | 'width' | 'height' | 'bytes' | 'frames'>): string {
  const size = pictureSize(picture.bytes);
  const { frames } = picture;
  // The sides are printed grouped, as the site prints every number: "1,600 × 1,200 pixels".
  const width = formatCount(picture.width);
  const height = formatCount(picture.height);
  if (picture.type === 'gif' && frames > 1) {
    return text(
      'social.roomPictureFactsAnimated',
      'GIF, animated, {frames} frames, {width} × {height} pixels, {size}',
      {
        frames,
        width,
        height,
        size,
      },
    );
  }
  // The name of a format is written in capitals: JPEG, PNG, GIF.
  return text('social.roomPictureFacts', '{type}, {width} × {height} pixels, {size}', {
    type: picture.type.toUpperCase(),
    width,
    height,
    size,
  });
}

/**
 * What the row of a picture holds, by the table of the contract's section 11:
 *
 *   offer   the picture may be shown: the note, the facts and the button "Show picture".
 *   closed  the picture could be shown, but pictures are off or resting: the note, the facts, a sentence
 *           (for resting its short form), and no button.
 *   said    one sentence and nothing else: hidden after reports, or no longer available.
 */
export type PictureRow =
  | { kind: 'offer'; facts: string }
  | { kind: 'closed'; facts: string; sentence: string }
  | { kind: 'said'; sentence: string };

/**
 * The row of `picture` while the read says `pictures`. Both are the server's: a picture is offered only
 * when its state is `shown` and the room's pictures are `on`. A read that says nothing of pictures offers
 * none (the API then sends no picture message at all; this is what a page does if one came anyway).
 */
export function pictureRow(picture: RoomPictureView, pictures: RoomWithPicturesResponse['pictures']): PictureRow {
  const words = pictureWords();
  if (picture.state === 'reported') return { kind: 'said', sentence: words.reported };
  if (picture.state === 'gone') return { kind: 'said', sentence: words.gone };
  const facts = pictureFacts(picture);
  if (pictures === 'on') return { kind: 'offer', facts };
  // While pictures rest a row keeps the short form: the long sentence is said once, above the list.
  return { kind: 'closed', facts, sentence: pictures === 'resting' ? words.restingRow : words.off };
}

/** The words that stand in a shown picture's place: the contract's, with the writer's short address. */
export function pictureAlt(authorShort: string): string {
  return ROOM_PICTURE_ALT.replace('{author}', authorShort);
}
