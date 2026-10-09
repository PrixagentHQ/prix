import { text } from '../../content/index.ts';

/**
 * Every sentence of the API page. Server only: this file reads the copy deck, so the browser
 * script never imports it. The page renders the result into `data-words` and the script moves
 * those sentences into the page; it holds none of its own. `{name}` marks a slot the script fills.
 */
export function dataWords() {
  return {
    // Page and sheets
    title: text('data.pageTitle', 'API keys'),
    description: text('data.pageDescription', 'Your Prix API keys, your usage and your credits.'),
    intro: text(
      'data.intro',
      'A key lets a program read Prix data. Every call counts against this wallet, whichever key makes it.',
    ),
    signInToOpen: text('data.signInToOpen', 'Sign in with your wallet to manage your keys.'),
    noScriptTitle: text('data.noScriptTitle', 'JavaScript is off'),
    noScriptBody: text('data.noScriptBody', 'Keys, usage and credits need JavaScript. Turn it on and reload the page.'),
    loadingTitle: text('data.loadingTitle', 'Loading'),
    loadingBody: text('data.loadingBody', 'Prix is reading this from your account.'),
    loadFailedTitle: text('data.loadFailedTitle', 'This could not be loaded'),
    retry: text('data.retry', 'Try again'),

    // Keys
    keysTitle: text('data.keysTitle', 'Keys'),
    keysIntro: text(
      'data.keysIntro',
      'Send a key as a Bearer token in the Authorization header. Keep it out of web pages and public code.',
    ),
    keysMax: text('data.keysMax', 'A wallet can hold {max} active keys.'),
    keysCaption: text('data.keysCaption', 'Your API keys'),
    keyColPrefix: text('data.keyColPrefix', 'Key'),
    keyColLabel: text('data.keyColLabel', 'Label'),
    keyColCreated: text('data.keyColCreated', 'Created'),
    keyColLastUsed: text('data.keyColLastUsed', 'Last used'),
    keyColStatus: text('data.keyColStatus', 'Status'),
    keyColAction: text('data.keyColAction', 'Action'),
    keyActive: text('data.keyActive', 'Active'),
    keyRevoked: text('data.keyRevoked', 'Revoked'),
    keyNeverUsed: text('data.keyNeverUsed', 'Never'),
    keysEmptyTitle: text('data.keysEmptyTitle', 'No keys yet'),
    keysEmptyBody: text('data.keysEmptyBody', 'Create a key below to make your first call.'),
    keysFullTitle: text('data.keysFullTitle', 'No room for another key'),
    keysFullBody: text('data.keysFullBody', 'This wallet already has {max} active keys. Revoke one to create another.'),
    labelLabel: text('data.labelForNew', 'Label for a new key'),
    labelHint: text(
      'data.labelHint',
      'A name to tell your keys apart, up to {max} letters, digits, spaces, dots, dashes or underscores.',
    ),
    labelInvalid: text(
      'data.labelInvalid',
      'That label is not accepted. Use 1 to {max} letters, digits, spaces, dots, dashes or underscores.',
    ),
    createKey: text('data.createKey', 'Create key'),
    creatingKey: text('data.creatingKey', 'Creating the key'),
    createFailedTitle: text('data.createFailedTitle', 'The key was not created'),
    secretTitle: text('data.secretTitle', 'Key created'),
    secretLead: text(
      'data.secretLead',
      'Copy this key now. It will not be shown again. Prix keeps only a fingerprint of it.',
    ),
    secretLabel: text('data.secretLabel', 'Your new key'),
    copyKey: text('data.copyKey', 'Copy key'),
    copied: text('data.copied', 'Copied'),
    copyFailed: text('data.copyFailed', 'Copying was blocked. Select the key and copy it by hand.'),
    secretDone: text('data.secretDone', 'I have saved it'),
    revoke: text('data.revoke', 'Revoke key'),
    revoking: text('data.revoking', 'Revoking the key'),
    revokeQuestion: text('data.revokeQuestion', 'Revoke the key {prefix}?'),
    revokeConsequence: text(
      'data.revokeConsequence',
      'Calls that use it stop working at once. A revoked key cannot be turned back on.',
    ),
    revokeFailedTitle: text('data.revokeFailedTitle', 'The key was not revoked'),
    revokedTitle: text('data.revokedTitle', 'Key revoked'),
    cancel: text('data.cancel', 'Cancel'),

    // Usage
    usageTitle: text('data.usageTitle', 'Usage'),
    usageIntro: text(
      'data.usageIntro',
      'Calls are counted per wallet and reset at 00:00 UTC. After the free calls, a call uses one credit.',
    ),
    usagePreview: text(
      'data.usagePreview',
      'Preview: every wallet has the same free calls while the token tiers are off.',
    ),
    usageTier: text('data.usageTier', 'Tier {tier} quota while the token tiers are on.'),
    quotaLabel: text('data.quotaLabel', 'Free calls a day'),
    usedLabel: text('data.usedLabel', 'Used today'),
    remainingLabel: text('data.remainingLabel', 'Free calls left'),
    creditsLabel: text('data.creditsLabel', 'Credits'),
    resetLabel: text('data.resetLabel', 'Resets'),
    usedValue: text('data.usedValue', '{free} free, {paid} paid'),
    historyCaption: text('data.historyCaption', 'Calls in the last 30 days'),
    historyColDay: text('data.historyColDay', 'Day'),
    historyColFree: text('data.historyColFree', 'Free calls'),
    historyColPaid: text('data.historyColPaid', 'Paid calls'),
    historyEmptyTitle: text('data.historyEmptyTitle', 'No calls yet'),
    historyEmptyBody: text('data.historyEmptyBody', 'Days with calls appear here once a key has been used.'),

    // Credits
    creditsTitle: text('data.creditsTitle', 'Credits'),
    creditsIntro: text(
      'data.creditsIntro',
      'Credits pay for calls beyond the free ones. They are not a deposit and Prix does not trade with them.',
    ),
    creditsOffTitle: text('data.creditsOffTitle', 'Credits are not on sale yet'),
    creditsOffBody: text(
      'data.creditsOffBody',
      'The free calls work now. Credits will be sold here when payments open.',
    ),
    creditsBalance: text('data.creditsBalance', 'Balance'),
    payStepSendTitle: text('data.payStepSendTitle', 'Send USDG from your own wallet app'),
    payStepSendBody: text(
      'data.payStepSendBody',
      'Send it from the wallet you are signed in with, to the address above. A payment from another wallet or an exchange cannot be credited.',
    ),
    payStepWaitTitle: text('data.payStepWaitTitle', 'Wait for the confirmations'),
    payStepWaitBody: text(
      'data.payStepWaitBody',
      'The payment can be credited once the chain has confirmed it. This takes a few minutes.',
    ),
    payStepHashTitle: text('data.payStepHashTitle', 'Paste the transaction hash'),
    payStepHashBody: text('data.payStepHashBody', 'Paste it below and credit the payment.'),
    payNoWallet: text('data.payNoWallet', 'This page never asks your wallet to send anything.'),
    payAddressLabel: text('data.payAddressLabel', 'Send to'),
    payTokenLabel: text('data.payTokenLabel', 'Token'),
    payTokenValue: text('data.payTokenName', 'USDG on Robinhood Chain, chain {chain}'),
    payContractLabel: text('data.payContractLabel', 'Contract'),
    copyAddress: text('data.copyAddress', 'Copy address'),
    payPriceLabel: text('data.payPriceLabel', 'Price'),
    payPriceValue: text('data.payPriceValue', '{price} USDG a call'),
    payMinLabel: text('data.payMinLabel', 'Minimum'),
    payMinValue: text('data.payMinValue', '{min} USDG a payment'),
    payConfirmLabel: text('data.payConfirmLabel', 'Confirmations'),
    hashLabel: text('data.hashLabel', 'Transaction hash'),
    hashHint: text('data.hashHint', 'It starts with 0x and has 66 characters in all.'),
    hashInvalid: text('data.hashInvalid', 'That is not a transaction hash. Paste the whole hash, starting with 0x.'),
    submitHash: text('data.submitHash', 'Credit this payment'),
    submittingHash: text('data.submittingHash', 'Checking the payment'),
    payPendingTitle: text('data.payPendingTitle', 'Payment pending'),
    payPendingBody: text(
      'data.payPendingBody',
      'The transaction is not final yet, or the chain does not know it yet. Wait a few minutes and submit it again.',
    ),
    payInvalidTitle: text('data.payInvalidTitle', 'Payment not valid'),
    payInvalidBody: text(
      'data.payInvalidBody',
      'This transaction cannot be credited. It must send at least the minimum in USDG from your signed-in wallet to the address above.',
    ),
    payAlreadyTitle: text('data.payAlreadyTitle', 'Already credited'),
    payAlreadyBody: text('data.payAlreadyBody', 'This payment was credited before. Nothing more was added.'),
    payOtherWalletBody: text('data.payOtherWalletBody', 'This payment was credited to another wallet.'),
    payCreditedTitle: text('data.payCreditedTitle', 'Credited'),
    payCreditedBody: text('data.payCreditedBody', '{amount} USDG added. Your balance is {balance} USDG.'),
    payFailedTitle: text('data.payFailedTitle', 'The payment was not credited'),
    paymentsCaption: text('data.paymentsCaption', 'Your payments'),
    payColTime: text('data.payColTime', 'Credited'),
    payColAmount: text('data.payColAmount', 'Amount, USDG'),
    payColHash: text('data.payColHash', 'Transaction'),
    paymentsEmptyTitle: text('data.paymentsEmptyTitle', 'No payments yet'),
    paymentsEmptyBody: text('data.paymentsEmptyBody', 'A credited payment is listed here with its transaction.'),

    // Errors, by API error code
    errors: {
      missing_key: text('data.errorUnauthorized', 'Your session has ended. Sign in again to continue.'),
      invalid_key: text('data.errorUnauthorized', 'Your session has ended. Sign in again to continue.'),
      unauthorized: text('data.errorUnauthorized', 'Your session has ended. Sign in again to continue.'),
      forbidden: text('data.errorForbidden', 'Prix refused this request. Reload the page and try again.'),
      not_found: text('data.errorNotFound', 'That no longer exists. Reload the page to see what is current.'),
      invalid_input: text('data.errorInvalidInput', 'Prix did not accept that entry. Check it and try again.'),
      rate_limited: text('data.errorRateLimited', 'Too many requests in a short time. Wait a minute and try again.'),
      quota_exceeded: text('data.errorQuota', 'The free calls for today are used up. They reset at 00:00 UTC.'),
      api_busy: text('data.errorBusy', 'The API is at its daily limit for everyone. It resumes after 00:00 UTC.'),
      daily_limit: text(
        'data.errorDailyLimit',
        'Prix has used up a daily limit of its hosting. It resumes after 00:00 UTC.',
      ),
      key_limit_reached: text(
        'data.errorKeyLimit',
        'This wallet has the most active keys it can hold. Revoke one first.',
      ),
      key_create_limit_reached: text(
        'data.errorKeyCreateLimit',
        'Too many keys were created today. Try again after 00:00 UTC.',
      ),
      unavailable: text('data.errorUnavailable', 'This is not switched on yet. Try again later.'),
      payment_pending: text(
        'data.errorPaymentPending',
        'The transaction is not final yet. Wait a few minutes and submit it again.',
      ),
      payment_invalid: text(
        'data.errorPaymentInvalid',
        'This transaction cannot be credited. It must send at least the minimum in USDG from your signed-in wallet to the address shown.',
      ),
      payment_already_credited: text(
        'data.errorPaymentCredited',
        'This transaction was already credited to another wallet.',
      ),
      chain_unavailable: text(
        'data.errorChain',
        'Prix could not read the chain just now. Wait a minute and try again.',
      ),
      internal: text('data.errorInternal', 'Something failed on Prix’s side. Try again in a moment.'),
      offline: text('data.errorOffline', 'Prix could not be reached. Check your connection and try again.'),
      bad_answer: text(
        'data.errorBadAnswer',
        'Prix answered with something this page could not read. Reload and try again.',
      ),
    },
  };
}

export type DataWords = ReturnType<typeof dataWords>;
