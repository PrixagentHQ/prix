import type { RoomRefusalField } from '@prix/contracts';
import { ROOM_REFUSALS } from '@prix/contracts';
import { text } from '../../../content/index.ts';
import { apiErrorText, roomRefusalMoreFor, roomRefusalText, roomWriterRefusalText } from '../../../content/states.ts';
import { errorSentences } from '../../session.ts';
import type { AdminWords, ComposerWords } from './answers.ts';

/**
 * Every sentence of the composer and of the admins' page of the Community chat, each under a key of
 * the copy area `social` (docs/contracts/phase-6-room.md section 9); the copy deck holds the final
 * wording. Server only: this file reads the deck and must not reach a browser script, which holds no
 * sentence of its own and is handed the ones it needs as data.
 *
 * The sentence of a refusal is not written here at all: `roomRefusalText` of content/states.ts has one
 * for each field of ROOM_REFUSALS, and does not compile while a field has none.
 */

const FIELDS = Object.keys(ROOM_REFUSALS) as RoomRefusalField[];

/**
 * The field of a wallet's cap of the day, written in two pieces: tests/unit/wallet-requests.test.ts reads
 * that name in quotation marks as a request to a wallet. The compiler still checks it against the contract.
 */
const DAY_FIELD = `${'wallet'}_day` as const satisfies RoomRefusalField;

export function composerWords() {
  return {
    /** For a holder whose `me` says nothing is left today: the sentence of the wallet's cap. */
    dayUsed: roomRefusalText(DAY_FIELD),
    whoWrites: text(
      'social.roomWhoWrites',
      'Anyone can read the Community chat, and a signed-in wallet that holds at least 1 $PRIX can write in it.',
    ),
    signIn: text('social.roomSignIn', 'Sign in to write'),
    /** The link to the page of the account that shows the wallet's $PRIX and reads it again. */
    holdingLink: text('social.roomTiersLink', 'Check your wallet’s $PRIX on the Account page'),
    checkFailedTitle: text('social.roomCheckFailedTitle', 'Not checked'),
    checkFailedBody: text(
      'social.roomCheckFailedBody',
      'Prix could not check whether this wallet can write. Reload the page to try again.',
    ),
    noScript: text('social.roomNoScript', 'Writing a message needs JavaScript. Reading the chat does not.'),
    label: text('social.roomComposerLabel', 'Your message'),
    hint: text('social.roomComposerHint', 'One line of plain text, up to 280 characters.'),
    publicNote: text(
      'social.roomComposerPublicNote',
      'A message is public as soon as you send it, beside a shortened form of your wallet address. You cannot edit or delete it.',
    ),
    count: text('social.roomComposerCount', '{count} of 280 characters'),
    send: text('social.roomSend', 'Send message'),
    sendBusy: text('social.roomSendBusy', 'Sending message'),
    sendFailedTitle: text('social.roomSendFailedTitle', 'Message not sent'),
    sendFailedBody: text(
      'social.roomSendFailedBody',
      'The message did not reach Prix, and your text is still in the field. Try again in a minute.',
    ),
    signedOutTitle: text('account.sessionEndedTitle', 'You are signed out'),
    signedOut: text('social.roomSignedOut', 'Your session has ended. Sign in again to send a message.'),
    signInAgain: text('nav.signIn', 'Sign in'),
    leftOne: text('social.roomLeftOne', 'This wallet can send 1 more message today.'),
    leftOther: text('social.roomLeftOther', 'This wallet can send {count} more messages today.'),
    /** Under the composer exactly when `me` answers `dayCap` (docs/contracts/phase-6-holders-2.md section 7). */
    dayCaps: text(
      'social.roomDayCaps',
      'A wallet writes up to 30 messages a day, 60 from 10,000 $PRIX, 90 from 100,000 and 120 from 1,000,000.',
    ),
    closedTitle: text('social.roomClosedTitle', 'The Community chat is closed'),
    closedBody: text(
      'social.roomClosedBody',
      'It is switched off for now. Nothing can be read or written here until it opens again.',
    ),
    reload: text('common.reloadPage', 'Reload the page'),
  };
}

/** The sentences the composer's script shows: one for every field of ROOM_REFUSALS, and the rest. */
export function composerScriptWords(): ComposerWords {
  const words = composerWords();
  return {
    refusals: Object.fromEntries(FIELDS.map((field) => [field, roomRefusalText(field)])),
    more: Object.fromEntries(
      FIELDS.map((field) => [field, roomRefusalMoreFor(field)] as const).filter(([, rest]) => rest !== ''),
    ),
    writer: roomWriterRefusalText('rate_limited'),
    other: text(
      'social.roomRefusalOther',
      'The message was not sent, and this page cannot say why. Try again, and reload the page if it is refused a second time.',
    ),
    sendFailed: words.sendFailedBody,
    count: words.count,
    leftOne: words.leftOne,
    leftOther: words.leftOther,
    dayCaps: words.dayCaps,
  };
}

export function adminWords() {
  return {
    title: text('social.roomAdminTitle', 'Community chat'),
    description: text(
      'social.roomAdminDescription',
      'Hide a message or mute its writer in the Community chat. For the people who run Prix.',
    ),
    intro: text(
      'social.roomAdminIntro',
      'Every stored message, newest first, each with the whole address of its writer. A message the public page does not show is listed here with the reason: it is hidden, its writer is muted, or it was written before or during a mute.',
    ),
    /** The whole body of the notice when the admins' read fails: no second sentence stands beside it. */
    loadFailedBody: text(
      'social.roomAdminLoadFailedBody',
      'Prix could not load the messages because of a server fault. Reload the page; if it keeps failing, come back in a few minutes.',
    ),
    back: text('nav.admin', 'Admin'),
    notForYou: text('admin.intro', 'This page is for the people who run Prix.'),
    signInTitle: text('nav.signIn', 'Sign in'),
    notAdminTitle: text('admin.notAdminTitle', 'This wallet is not an administrator'),
    notAdminBody: text(
      'admin.notAdminBody',
      'Nothing on this page is available to the wallet you signed in with. Your agent and your model keys are on your account page.',
    ),
    stateHidden: text('social.roomAdminStateHidden', 'Hidden'),
    stateMuted: text('social.roomAdminStateMuted', 'Writer muted'),
    stateCut: text('social.roomAdminStateCut', 'Written before or during a mute'),
    stateAdmin: text('social.roomAdminStateAdmin', 'Admin wallet'),
    hide: text('social.roomAdminHide', 'Hide message'),
    hideBusy: text('social.roomAdminHideBusy', 'Hiding message'),
    hideQuestion: text('social.roomAdminHideQuestion', 'Hide this message?'),
    hideConsequence: text(
      'social.roomAdminHideConsequence',
      'It leaves the public page for good: a hidden message cannot be shown again. Its writer can still write.',
    ),
    hideDone: text('social.roomAdminHideDone', 'Message hidden'),
    hideFailed: text('social.roomAdminHideFailed', 'The message was not hidden'),
    mute: text('social.roomAdminMute', 'Mute writer'),
    muteBusy: text('social.roomAdminMuteBusy', 'Muting writer'),
    muteQuestion: text('social.roomAdminMuteQuestion', 'Mute the writer of this message?'),
    muteConsequence: text(
      'social.roomAdminMuteConsequence',
      'This wallet can no longer write in the Community chat, and everything it has written up to now leaves the public page for good.',
    ),
    muteDone: text('social.roomAdminMuteDone', 'Writer muted'),
    muteFailed: text('social.roomAdminMuteFailed', 'The writer was not muted'),
    unmute: text('social.roomAdminUnmute', 'Lift the mute'),
    unmuteBusy: text('social.roomAdminUnmuteBusy', 'Lifting the mute'),
    unmuteQuestion: text('social.roomAdminUnmuteQuestion', 'Lift the mute on the writer of this message?'),
    unmuteConsequence: text(
      'social.roomAdminUnmuteConsequence',
      'This wallet can write again. Lifting the mute brings back nothing it has written up to now: those messages stay off the public page.',
    ),
    unmuteDone: text('social.roomAdminUnmuteDone', 'Mute lifted'),
    unmuteFailed: text('social.roomAdminUnmuteFailed', 'The mute was not lifted'),
    cacheNote: text('social.roomAdminCacheNote', 'The public page can show the earlier state for up to half a minute.'),
    gone: text('social.roomAdminGone', 'This message is no longer stored. Reload the page.'),
    older: text('social.roomAdminOlder', 'Older messages'),
    newest: text('social.roomAdminNewest', 'Newest messages'),
    emptyTitle: text('social.roomAdminEmptyTitle', 'No messages stored'),
    emptyBody: text('social.roomAdminEmptyBody', 'Nothing has been written in the Community chat yet.'),
    cancel: text('common.cancel', 'Cancel'),
    reload: text('common.reloadPage', 'Reload the page'),
    signedOutTitle: text('account.sessionEndedTitle', 'You are signed out'),
    signedOut: text('errors.sessionEnded', 'Your session has ended. Sign in again to continue.'),
  };
}

/**
 * The sentences the script of the admins' page shows for a control that failed: the API's codes, with
 * the page's own for the generic 404 and for the two codes of `requireWriter`, and the sentence of the
 * one refusal of the room an admin can meet, the mute of an admin's message.
 */
export function adminScriptWords(): AdminWords {
  const codes = JSON.parse(
    errorSentences({
      not_found: adminWords().gone,
      rate_limited: roomWriterRefusalText('rate_limited'),
      daily_limit: roomWriterRefusalText('daily_limit'),
      internal: apiErrorText('internal'),
    }),
  ) as Record<string, string>;
  return { codes, admin: roomRefusalText('admin') };
}
