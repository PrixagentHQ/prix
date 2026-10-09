import { AGENT_NAME_MAX, AGENT_NAME_MIN } from '@prix/contracts';
import { text } from '../../content/index.ts';

/**
 * Every sentence the listing script shows, rendered on the server from the copy deck and
 * handed to the script as JSON. The script holds no sentence of its own. Error sentences are
 * named `<step>_<code>`: the step is what the person was doing (claim, create, status, load).
 */
export function listWords(): Record<string, string> {
  const limits = { min: AGENT_NAME_MIN, max: AGENT_NAME_MAX };
  return {
    nameShort: text('reputation.listNameShort', 'That name is too short. Use at least {min} characters.', limits),
    nameLong: text('reputation.listNameLong', 'That name is too long. Use at most {max} characters.', limits),
    nameReserved: text(
      'reputation.listNameReserved',
      'That name is reserved, because it could pass for Prix, its staff or a partner. Choose another name.',
    ),
    nameRejected: text(
      'reputation.listNameRejected',
      'Use letters, digits, spaces, dots, underscores and hyphens, with single spaces.',
    ),
    walletMissing: text('reputation.listWalletMissing', 'Enter the agent’s wallet address.'),
    walletRejected: text(
      'reputation.listWalletRejected',
      'That is not a wallet address. It starts with 0x and has 40 more characters, 0 to 9 and a to f.',
    ),
    walletChecksum: text(
      'reputation.listWalletChecksum',
      'The capital letters in that address do not match its checksum, so it may have a typing mistake. Copy the address again.',
    ),
    walletZero: text('reputation.listWalletZero', 'That is the zero address. Enter the wallet your agent trades from.'),
    signatureMissing: text(
      'reputation.listSignatureMissing',
      'Paste the signature, or sign with your connected wallet.',
    ),
    signatureRejected: text(
      'reputation.listSignatureRejected',
      'That is not a signature. It starts with 0x and holds at least 130 hex characters.',
    ),
    rejected: text('reputation.listRejected', 'The request was not accepted. {message}'),
    copied: text('reputation.listCopied', 'Message copied'),
    copyFailed: text('reputation.listCopyFailed', 'The message could not be copied. Select it and copy it by hand.'),
    expired: text(
      'reputation.listExpired',
      'The message has expired. Get a new message and sign again; it stays valid for ten minutes.',
    ),
    noWallet: text(
      'reputation.listNoWallet',
      'No wallet was found in this browser. Paste a signature made elsewhere instead.',
    ),
    walletDeclined: text(
      'reputation.listWalletDeclined',
      'The signature was declined in your wallet. Nothing was sent.',
    ),
    walletMismatch: text(
      'reputation.listWalletMismatch',
      'Your wallet would not sign with {wallet}. The connected account must be the agent’s wallet. Connect it, or paste a signature made elsewhere.',
    ),
    walletPending: text(
      'reputation.listWalletPending',
      'Your wallet already has a request open. Answer it, then try again.',
    ),
    walletFailed: text(
      'reputation.listWalletFailed',
      'Your wallet did not return a signature. Try again, or paste a signature made elsewhere.',
    ),
    listedTitle: text('reputation.listListedTitle', 'Agent listed'),
    listedBody: text(
      'reputation.listListedBody',
      '{name} is listed. Its record is {state}. The record is an estimate from the wallet’s public activity.',
    ),
    syncBackfill: text('reputation.listSyncBackfill', 'being read from the chain now'),
    syncLive: text('reputation.listSyncLive', 'up to date'),
    syncError: text(
      'reputation.listSyncError',
      'not updating, because the chain could not be read; Prix retries on its own',
    ),
    syncTooActive: text(
      'reputation.listSyncTooActive',
      'stopped, because the wallet has more activity than a record can hold',
    ),
    statusActive: text('reputation.listStatusActive', 'Listed'),
    statusRemoved: text('reputation.listStatusRemoved', 'Removed'),
    syncLabel: text('reputation.listSyncLabel', 'Record'),
    eventsLabel: text('reputation.listEventsLabel', 'Transfers read'),
    claimedLabel: text('reputation.listClaimedLabel', 'Listed on'),
    walletLabel: text('reputation.listWalletLabel', 'Wallet'),
    explorerLabel: text('reputation.listExplorerLabel', 'View the wallet on the explorer'),
    remaining: text('reputation.listRemainingOther', 'You can list {count} more wallets.'),
    remainingOne: text('reputation.listRemainingOne', 'You can list 1 more wallet.'),
    remainingNone: text('reputation.listRemainingNone', 'You have reached your limit of listed wallets.'),
    remove: text('reputation.listRemove', 'Remove listing'),
    listAgain: text('reputation.listListAgain', 'List again'),
    removing: text('reputation.listRemoving', 'Removing the listing'),
    listingAgain: text('reputation.listListingAgain', 'Listing again'),
    emptyTitle: text('reputation.listEmptyTitle', 'No wallet listed yet'),
    emptyBody: text(
      'reputation.listEmptyBody',
      'Enter your agent’s wallet and a name above to list it. You sign one message with that wallet.',
    ),
    loadFailedTitle: text('reputation.listLoadFailedTitle', 'Your listings were not loaded'),
    statusFailedTitle: text('reputation.listStatusFailedTitle', 'The listing was not changed'),
    sessionEnded: text('errors.sessionEnded', 'Your session has ended. Sign in again to continue.'),
    offline: text('errors.offline', 'Prix could not be reached. Check your connection and try again.'),
    // What went wrong while asking for the message to sign.
    claim_forbidden: text(
      'reputation.listClaimForbidden',
      'Prix refused the request because it did not come from this site. Reload the page and try again.',
    ),
    claim_rate_limited: text(
      'reputation.listClaimRateLimited',
      'Too many listing requests. Wait a few minutes, then ask for the message again.',
    ),
    claim_name_taken: text(
      'reputation.listClaimNameTaken',
      'That name is already used by an agent or a listing. Choose another name.',
    ),
    claim_name_not_allowed: text(
      'reputation.listClaimNameNotAllowed',
      'That name is not allowed. Choose another name.',
    ),
    claim_other: text(
      'reputation.listClaimOther',
      'The message could not be prepared, because of a fault on Prix’s side. Try again in a minute.',
    ),
    // What went wrong while sending the signature.
    create_unauthorized: text(
      'reputation.listCreateUnauthorized',
      'The signature could not be accepted. Check that it was made with the agent’s wallet on the message above, with nothing changed. If your session ended, sign in again.',
    ),
    create_forbidden: text(
      'reputation.listCreateForbidden',
      'This account has reached its limit of listed wallets, or the request did not come from this site. Remove a listing below, or reload the page.',
    ),
    create_rate_limited: text(
      'reputation.listCreateRateLimited',
      'Too many listing attempts today or from this network. Wait, then ask for a new message.',
    ),
    create_name_taken: text(
      'reputation.listCreateNameTaken',
      'That name was taken while you signed. Change the name and ask for a new message.',
    ),
    create_league_full: text(
      'reputation.listCreateFull',
      'The list of on-chain agents is full for now. Try again later.',
    ),
    create_invalid_input: text(
      'reputation.listCreateInvalid',
      'The message was not accepted, usually because it expired. Ask for a new message and sign it again.',
    ),
    create_other: text(
      'reputation.listCreateOther',
      'The listing was not made, because of a fault on Prix’s side. Try again in a minute.',
    ),
    // What went wrong while changing a listing.
    status_forbidden: text(
      'reputation.listStatusForbidden',
      'Only the account that listed this wallet can change the listing.',
    ),
    status_not_found: text('reputation.listStatusNotFound', 'That listing no longer exists. Reload the page.'),
    status_rate_limited: text('reputation.listStatusRateLimited', 'Too many changes. Wait a minute and try again.'),
    status_other: text('reputation.listStatusOther', 'The listing was not changed. Try again in a minute.'),
    load_rate_limited: text('reputation.listLoadRateLimited', 'Too many requests. Wait a minute and reload the page.'),
    load_other: text('reputation.listLoadOther', 'Your listings could not be loaded. Reload the page to try again.'),
  };
}
