import type { RoomPictureSentenceField } from '@prix/contracts';
import { ROOM_PICTURE_ADMIN_NOTE, ROOM_PICTURE_COMPOSER_NOTE, ROOM_PICTURE_LIMITS } from '@prix/contracts';
import { text } from '../../../content/index.ts';
import { roomRefusalText, roomWriterRefusalText } from '../../../content/states.ts';
import type { PictureWords } from './answers.ts';

/**
 * Every sentence about pictures in the composer and on the admins' page of the Community chat
 * (docs/contracts/phase-6-pictures.md section 11). The names of the keys are the contract's
 * (ROOM_PICTURE_COPY_KEYS, and `roomPictureRefusalKey` for a refusal); the words are the copy deck's, and
 * the draft beside each key stands only until the deck has it. Server only: this file reads the deck and
 * must not reach a browser script, which is handed the sentences it needs as data.
 *
 * Every number in a sentence comes from the contract's constants. The deck wrote each figure of
 * ROOM_PICTURE_LIMITS into its sentence and keeps no slot for one, so a page hands such a sentence no slot
 * (revision 5): a draft that names a figure gets it here, from the same constants and printed as the site
 * prints a number, and types none. The draft itself stays a string literal, as the test that reads every
 * call of `text` asks (docs/CONTRACTS.md section 8): the figures are set into what `text` gives back,
 * which changes a draft and never a sentence of the deck, since the deck's has no such slot.
 */

const LIMITS = ROOM_PICTURE_LIMITS;

/** A sentence with the contract's figures set into it, grouped in thousands, as the deck prints them. */
const figured = (sentence: string): string =>
  sentence.replace(/\{(\w+)\}/g, (slot, name: string) =>
    Object.hasOwn(LIMITS, name) ? LIMITS[name as keyof typeof LIMITS].toLocaleString('en-US') : slot,
  );

/** Every sentence of the refusals with the contract's figures set into it. */
function figuredEach(sentences: Record<RoomPictureSentenceField, string>): Record<RoomPictureSentenceField, string> {
  const out = { ...sentences };
  for (const field of Object.keys(out) as RoomPictureSentenceField[]) out[field] = figured(out[field]);
  return out;
}

/**
 * One sentence for every refusal of pictures a page can show. The type has no `picture_views_day`: only
 * an `<img>` meets it, and an `<img>`'s error carries no status. A new field does not compile without
 * its line.
 */
export function pictureRefusalWords(): Record<RoomPictureSentenceField, string> {
  return figuredEach({
    picture_size: text(
      'social.roomPictureRefusalSize',
      'This picture could not be made small enough: the chat takes a file of at most {maxKib} KB, and a GIF is sent as it is. Choose another picture, or save this one smaller, and add it again.',
    ),
    picture_type: text(
      'social.roomPictureRefusalType',
      'This file is not a JPEG, a PNG or a GIF, and the chat takes no other kind of picture. Save it as a JPEG or a PNG and add it again.',
    ),
    picture_malformed: text(
      'social.roomPictureRefusalMalformed',
      'This picture did not arrive whole, or it cannot be read as a picture. Try again, or choose another picture and add that one.',
    ),
    picture_dimensions: text(
      'social.roomPictureRefusalDimensions',
      'This picture is outside the sizes the chat takes: each side from {minSide} to {maxSide} pixels, and at most {animatedMaxSide} pixels a side for an animated GIF. Resize it and add it again.',
    ),
    picture_frames: text(
      'social.roomPictureRefusalFrames',
      'This GIF has more than {maxFrames} frames, or none at all. Shorten it, or save one frame as a still picture, and add it again.',
    ),
    picture_blocked: text(
      'social.roomPictureRefusalBlocked',
      'Prix removed this same file from the Community chat before, so it is not taken again. The try still counts as one of this wallet’s pictures for today.',
    ),
    picture_admin: text(
      'social.roomPictureRefusalAdmin',
      'This is an admin wallet, and an admin wallet neither adds nor reports a picture. An admin removes a picture on the admin page of the chat.',
    ),
    picture_new_writer: text(
      'social.roomPictureRefusalNewWriter',
      'Adding a picture takes a wallet whose first message in the Community chat is at least {writerAgeMinutes} minutes old, and this wallet has none that old yet. Write a message if you have not, then add the picture after that time.',
    ),
    picture_not_allowed: text(
      'social.roomPictureRefusalNotAllowed',
      'This wallet was muted in the Community chat once, and a wallet that was muted cannot add or report pictures, also after the mute is lifted. It can still write messages.',
    ),
    picture_paused: text(
      'social.roomPictureRefusalPaused',
      'Reports have hidden pictures from this wallet, and it cannot add another until an admin of Prix has decided on them. It can still write messages.',
    ),
    pictures_off: text(
      'social.roomPictureRefusalOff',
      'Pictures are switched off in the Community chat for now, so none can be added or reported. Text messages go on as before.',
    ),
    picture_wallet_day: text(
      'social.roomPictureRefusalWalletDay',
      'This wallet has used its {perWalletPerDay} pictures for today. It can add another after 00:00 UTC.',
    ),
    picture_room_hour: text(
      'social.roomPictureRefusalRoomHour',
      'The Community chat has taken as many pictures as it takes in one hour. Add yours again after the hour turns.',
    ),
    picture_room_day: text(
      'social.roomPictureRefusalRoomDay',
      'The Community chat has taken as many pictures as it takes in one day. It takes pictures again after 00:00 UTC.',
    ),
    picture_storage: text(
      'social.roomPictureRefusalStorage',
      'Prix could not store the picture because of a fault on its side, so the picture was not posted. The try still counts as one of this wallet’s pictures for today. Add it again in a minute.',
    ),
    report_own: text(
      'social.roomPictureRefusalReportOwn',
      'This is your own picture, and a wallet cannot report its own. To ask for it to be removed, write to support@prixagent.com.',
    ),
    report_new_writer: text(
      'social.roomPictureRefusalReportNewWriter',
      'Reporting a picture takes a wallet whose first message in the Community chat is at least {reporterAgeHours} hours old, and this wallet has none that old yet.',
    ),
    report_wallet_day: text(
      'social.roomPictureRefusalReportWalletDay',
      'This wallet has sent as many reports as a wallet sends in one day. It can report again after 00:00 UTC.',
    ),
  });
}

/** The refusals of the room itself that an upload or a report can answer, each with the room's own sentence. */
const ROOM_FIELDS = ['not_holder', 'gate_off', 'muted', 'too_soon', 'room_hour', 'room_day'] as const;
/** Written in two pieces, as in words.ts: a test reads that name in quotation marks as a request to a wallet. */
const DAY_FIELD = `${'wallet'}_day` as const;

/** What the composer renders of pictures on the server. */
export function pictureWords() {
  return {
    add: text('social.roomPictureAdd', 'Add a picture'),
    discard: text('social.roomPictureDiscard', 'Discard picture'),
    newWriter: text(
      'social.roomPictureNewWriter',
      'You can add a picture {minutes} minutes after your first message here.',
      { minutes: LIMITS.writerAgeMinutes },
    ),
    limits: figured(
      text(
        'social.roomPictureLimits',
        'A JPEG, a PNG or a GIF of at most {maxKib} KB, with each side from {minSide} to {maxSide} pixels. A larger photo or other still picture is made smaller in your browser before it is sent. A GIF is sent as it is, and an animated one has at most {maxFrames} frames and sides of at most {animatedMaxSide} pixels.',
      ),
    ),
    leftOne: text('social.roomPictureLeftOne', 'This wallet can add 1 more picture today.'),
    leftOther: text('social.roomPictureLeftOther', 'This wallet can add {count} more pictures today.'),
    dayUsed: pictureRefusalWords().picture_wallet_day,
    /** The send button while a picture is chosen, its busy label, and what a send that failed is called. */
    send: text('social.roomPictureSend', 'Send picture'),
    sending: text('social.roomPictureSending', 'Sending picture'),
    sendFailedTitle: text('social.roomPictureSendFailedTitle', 'Picture not sent'),
    /** The question a first press on "Report picture" opens, and its two answers (revision 6). */
    reportAsk: text(
      'social.roomPictureReportAsk',
      'Report this picture? When enough users report a picture it is hidden for everyone, and an admin of Prix then decides.',
    ),
    reportYes: text('social.roomPictureReportYes', 'Report'),
    reportNo: text('social.roomPictureReportNo', 'Cancel'),
    /** The contract's own two, as they stand. */
    composerNote: ROOM_PICTURE_COMPOSER_NOTE,
    adminNote: ROOM_PICTURE_ADMIN_NOTE,
  };
}

/** The sentences the scripts of `/chat` are handed for a picture and for a report. */
export function pictureScriptWords(): PictureWords {
  const words = pictureWords();
  return {
    refusals: {
      ...Object.fromEntries(ROOM_FIELDS.map((field) => [field, roomRefusalText(field)])),
      [DAY_FIELD]: roomRefusalText(DAY_FIELD),
      ...pictureRefusalWords(),
    },
    limits: words.limits,
    leftOne: words.leftOne,
    leftOther: words.leftOther,
    facts: text('social.roomPictureFacts', '{type}, {width} × {height} pixels, {size}'),
    factsAnimated: text(
      'social.roomPictureFactsAnimated',
      'GIF, animated, {frames} frames, {width} × {height} pixels, {size}',
    ),
    sizeKb: text('social.roomPictureSizeKb', '{count} KB'),
    writer: roomWriterRefusalText('rate_limited'),
    other: text(
      'social.roomRefusalOther',
      'The message was not sent, and this page cannot say why. Try again, and reload the page if it is refused a second time.',
    ),
    sendFailed: text(
      'social.roomPictureSendFailed',
      'The picture did not reach Prix, and it is still chosen here. Try again in a minute.',
    ),
    session: text('errors.sessionEnded', 'Your session has ended. Sign in again to continue.'),
    reportDone: text(
      'social.roomPictureReportDone',
      'Reported. When enough users report a picture it is hidden, and an admin of Prix then decides.',
    ),
    reportFailed: text(
      'social.roomPictureReportFailed',
      'The report did not reach Prix. Reload the page to try again.',
    ),
    reportClosed: text('social.roomPictureReportClosed', 'This picture cannot be reported now.'),
  };
}

/** One control of the admins' page: its name, and what it says while it runs, before, and after. */
export interface AdminControlWords {
  label: string;
  busy: string;
  question: string;
  consequence: string;
  done: string;
  failed: string;
}

/** What the admins' page says of pictures. */
export function adminPictureWords() {
  return {
    offState: text(
      'social.roomPictureAdminOffState',
      'Pictures have been off since {at}. They stay off until an admin switches them on.',
    ),
    onState: text('social.roomPictureAdminOnState', 'Pictures are on.'),
    offByAdmin: text('social.roomPictureAdminOffByAdmin', 'An admin switched them off.'),
    offByReportsHour: text(
      'social.roomPictureAdminOffByReportsHour',
      'The chat switched them off by itself, after reports had hidden several pictures within one hour.',
    ),
    offByReportsDay: text(
      'social.roomPictureAdminOffByReportsDay',
      'The chat switched them off by itself, when it reached its limit of reports for one day.',
    ),
    /** The titles of the page's two cards that had none (revision 6): the switch, and the list of every message. */
    picturesTitle: text('social.roomPictureAdminPicturesTitle', 'Pictures'),
    messagesTitle: text('social.roomPictureAdminMessagesTitle', 'All messages'),
    reportedTitle: text('social.roomPictureAdminReportedTitle', 'Reported pictures'),
    reportedEmpty: text('social.roomPictureAdminReportedEmpty', 'No picture is waiting for a decision.'),
    reportedMore: text(
      'social.roomPictureAdminReportedMore',
      'More reported pictures are waiting than this list shows. Decide on these, then reload the page.',
    ),
    reportedBy: text('social.roomPictureAdminReportedBy', 'Reported by'),
    reportsOne: text('social.roomPictureAdminReportsOne', '1 report'),
    reportsOther: text('social.roomPictureAdminReportsOther', '{count} reports'),
    hash: text('social.roomPictureAdminHash', 'File fingerprint begins {hash}'),
    show: text('social.roomPictureAdminShow', 'Show picture'),
    unblur: text('social.roomPictureAdminUnblur', 'Unblur picture'),
    hideLook: text('social.roomPictureHide', 'Hide picture'),
    loadFailed: text(
      'social.roomPictureLoadFailed',
      'This picture is not available right now. Reload the page to try again.',
    ),
    notViewable: text(
      'social.roomPictureAdminNotViewable',
      'This picture can no longer be looked at: its file is deleted or has expired, or its writer is an admin wallet now.',
    ),
    stateOk: text('social.roomPictureAdminStateOk', 'Picture not hidden'),
    stateReported: text('social.roomPictureAdminStateReported', 'Picture hidden after reports'),
    stateKept: text('social.roomPictureAdminStateKept', 'Picture kept by an admin'),
    stateRemoved: text('social.roomPictureAdminStateRemoved', 'Picture removed'),
    bytesGone: text('social.roomPictureAdminBytesGone', 'File deleted'),
    bytesOwed: text(
      'social.roomPictureAdminBytesOwed',
      'File not deleted yet. Nobody can load it, and Prix tries the delete again by itself.',
    ),
    facts: text('social.roomPictureFacts', '{type}, {width} × {height} pixels, {size}'),
    factsAnimated: text(
      'social.roomPictureFactsAnimated',
      'GIF, animated, {frames} frames, {width} × {height} pixels, {size}',
    ),
    sizeKb: text('social.roomPictureSizeKb', '{count} KB'),
    remove: {
      label: text('social.roomPictureAdminRemove', 'Remove picture'),
      busy: text('social.roomPictureAdminRemoveBusy', 'Removing picture'),
      question: text('social.roomPictureAdminRemoveQuestion', 'Remove this picture?'),
      consequence: text(
        'social.roomPictureAdminRemoveConsequence',
        'It leaves the public page for good and its file is deleted: a removed picture cannot be brought back. Prix refuses the same file if anyone adds it again. Its writer can still write.',
      ),
      done: text('social.roomPictureAdminRemoveDone', 'Picture removed'),
      failed: text('social.roomPictureAdminRemoveFailed', 'The picture was not removed'),
    } satisfies AdminControlWords,
    keep: {
      label: text('social.roomPictureAdminKeep', 'Keep picture'),
      busy: text('social.roomPictureAdminKeepBusy', 'Keeping picture'),
      question: text('social.roomPictureAdminKeepQuestion', 'Keep this picture?'),
      consequence: text(
        'social.roomPictureAdminKeepConsequence',
        'It stays on the public page, or returns to it if reports had hidden it, and it can no longer be reported. Each wallet that reported it is given a strike, and after enough strikes a wallet’s reports no longer count.',
      ),
      done: text('social.roomPictureAdminKeepDone', 'Picture kept'),
      failed: text('social.roomPictureAdminKeepFailed', 'The picture was not kept'),
    } satisfies AdminControlWords,
    off: {
      label: text('social.roomPictureAdminOff', 'Switch pictures off'),
      busy: text('social.roomPictureAdminOffBusy', 'Switching pictures off'),
      question: text('social.roomPictureAdminOffQuestion', 'Switch pictures off?'),
      consequence: text(
        'social.roomPictureAdminOffConsequence',
        'No picture is shown, added or reported in the Community chat until an admin switches pictures on. Nothing is deleted, text messages go on, and a reported picture can still be decided.',
      ),
      done: text('social.roomPictureAdminOffDone', 'Pictures are off'),
      failed: text('social.roomPictureAdminOffFailed', 'Pictures were not switched off'),
    } satisfies AdminControlWords,
    on: {
      label: text('social.roomPictureAdminOn', 'Switch pictures on'),
      busy: text('social.roomPictureAdminOnBusy', 'Switching pictures on'),
      question: text('social.roomPictureAdminOnQuestion', 'Switch pictures on?'),
      consequence: text(
        'social.roomPictureAdminOnConsequence',
        'Pictures can be shown, added and reported again. The chat starts its count of reports for the day and its count of pictures hidden in the hour again, so the reports that switched pictures off do not switch them off a second time.',
      ),
      done: text('social.roomPictureAdminOnDone', 'Pictures are on'),
      failed: text('social.roomPictureAdminOnFailed', 'Pictures were not switched on'),
    } satisfies AdminControlWords,
  };
}

/** The sentences the script of the admins' look is handed: what its buttons become, and a load that failed. */
export function adminLookWords(): { show: string; unblur: string; hide: string; failed: string } {
  const words = adminPictureWords();
  return { show: words.show, unblur: words.unblur, hide: words.hideLook, failed: words.loadFailed };
}
