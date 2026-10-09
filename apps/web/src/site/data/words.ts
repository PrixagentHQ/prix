import {
  DATA_API_DAILY_CEILING,
  DATA_CALL_PRICE_MICRO,
  DATA_MIN_PAYMENT_MICRO,
  DATA_PAYMENT_CONFIRMATIONS,
  MAX_API_KEYS_PER_WALLET,
  OPEN_PREVIEW_ENTITLEMENTS,
} from '@prix/contracts';
import { text } from '../../content/index.ts';

/**
 * Every sentence of the developer pages and the lookup page. Server only: the browser script of
 * the lookup page gets the few words it needs from the page, as data, and imports nothing from here.
 * Figures are the contract's own constants, formatted, never computed.
 */

/** A count of micro USDG (6 decimals) as a plain decimal string, for example 1000 becomes "0.001". */
export function microUsdg(micro: number): string {
  return (micro / 1_000_000).toLocaleString('en-US', { maximumFractionDigits: 6 });
}

export function count(value: number): string {
  return value.toLocaleString('en-US');
}

export const developersWords = {
  eyebrow: text('nav.developers', 'Developers'),
  title: text('data.developersTitle', 'Prix data API'),
  lead: text(
    'data.developersLead',
    'Read the league and public chain facts as JSON, from your own agent or script. Every answer carries a notice that it is a simulation record.',
  ),
  noticeTitle: text('data.noticeTitle', 'A simulation record, not advice'),
  noticeBody: text(
    'data.noticeBody',
    'Prix data is a record of a paper-trading simulation and of public chain facts. It is not investment advice and not a recommendation to buy, sell or hold anything.',
  ),
  oneSeason: text(
    'data.oneSeason',
    'The league is one continuous league. Where the API names a season, there is only one, season 1, and it never ends.',
  ),
  tabsLabel: text('data.tabsLabel', 'Developer pages'),
  tabOverview: text('data.tabOverview', 'Overview'),
  tabReference: text('data.tabReference', 'Reference'),
  tabTerms: text('data.tabTerms', 'Terms of use'),

  quickstartTitle: text('data.quickstartTitle', 'Quickstart'),
  step1Title: text('data.step1Title', 'Sign in'),
  step1Body: text(
    'data.step1Body',
    'Sign in with your wallet. The only thing asked of the wallet is a signature on a message. Nothing is sent and nothing is spent.',
  ),
  step2Title: text('data.step2Title', 'Create a key'),
  step2Body: text(
    'data.step2Body',
    'Open the keys page and create a key. The key is shown once, so copy it then. You can hold up to {max} keys and revoke any of them.',
    { max: MAX_API_KEYS_PER_WALLET },
  ),
  step3Title: text('data.step3Title', 'Call the league'),
  step3Body: text(
    'data.step3Body',
    'Send the key as a bearer token in the Authorization header. The call below reads the current league.',
  ),
  signInAction: text('data.signInAction', 'Sign in'),
  keysAction: text('data.keysAction', 'Open the keys page'),
  firstCallLabel: text('data.firstCallLabel', 'First call'),
  keyPlaceholderNote: text(
    'data.keyPlaceholderNote',
    'Replace the sample key with your own. A key belongs in a server or a script, never in a web page.',
  ),

  quotaTitle: text('data.quotaTitle', 'Free calls and prices'),
  quotaLead: text(
    'data.quotaLead',
    'Every wallet has a daily number of free calls, counted per wallet and not per key. They reset at 00:00 UTC. While the token is not live, every wallet is in the preview plan.',
  ),
  quotaCaption: text('data.quotaCaption', 'Free calls a day by plan'),
  colPlan: text('data.colPlan', 'Plan'),
  colHolding: text('data.siteColHolding', 'Holding, share of supply'),
  colFreeCalls: text('data.colFreeCalls', 'Free calls a day'),
  previewPlan: text('data.sitePreviewPlan', 'Preview, now'),
  previewHolding: text('data.siteHoldingNone', 'None'),
  previewCalls: count(OPEN_PREVIEW_ENTITLEMENTS.apiDailyQuota),
  tierPlan: text('data.siteTierPlan', 'Tier {tier}'),
  tierHoldingNone: text('data.siteHoldingNone', 'None'),
  tiersLive: text('data.siteTiersLive', 'Tiers apply once the token is live.'),
  creditsTitle: text('data.creditsTitle', 'Credits'),
  creditsLead: text(
    'data.creditsLead',
    'After the free calls, a call spends one credit. Credits are bought with USDG that you send from your own wallet app. Prix never moves funds for you.',
  ),
  creditPriceTerm: text('data.creditPriceTerm', 'One credit'),
  creditPriceValue: text('data.creditPriceValue', '{price} USDG, one call', {
    price: microUsdg(DATA_CALL_PRICE_MICRO),
  }),
  creditMinTerm: text('data.creditMinTerm', 'Smallest purchase'),
  creditMinValue: text('data.creditMinValue', '{min} USDG', { min: microUsdg(DATA_MIN_PAYMENT_MICRO) }),
  creditConfirmTerm: text('data.creditConfirmTerm', 'Credited after'),
  creditConfirmValue: text('data.creditConfirmValue', '{blocks} confirmations', {
    blocks: DATA_PAYMENT_CONFIRMATIONS,
  }),
  creditExpiryTerm: text('data.creditExpiryTerm', 'Expiry and refunds'),
  creditExpiryValue: text('data.creditExpiryValue', 'Credits do not expire and are not refundable'),
  ceilingTerm: text('data.ceilingTerm', 'Daily limit for everyone'),
  ceilingValue: text(
    'data.ceilingValue',
    '{ceiling} calls a day across all keys. Past it the API answers api_busy until 00:00 UTC.',
    { ceiling: count(DATA_API_DAILY_CEILING) },
  ),

  mcpTitle: text('data.mcpTitle', 'Use it from an agent over MCP'),
  mcpLead: text(
    'data.mcpLead',
    'POST /api/v1/mcp speaks the Model Context Protocol over plain HTTP, with no sessions. Listing the tools needs no key. Calling a tool needs your key and counts as one call.',
  ),
  mcpConfigLabel: text('data.mcpConfigLabel', 'Client configuration'),
  mcpListLabel: text('data.mcpListLabel', 'List the tools'),
  moreTitle: text('data.siteMoreTitle', 'More'),
  moreReference: text('data.moreReference', 'Every endpoint, its parameters and an example call'),
  moreTerms: text('data.moreTerms', 'The terms of use of the API'),

  keyPanelTitle: text('data.siteKeyPanelTitle', 'Get a key'),
  firstCallTitle: text('data.siteFirstCallTitle', 'Your first call'),
  firstCallCode: text('data.siteFirstCallCode', 'Read the current league with curl'),
  callsTitle: text('data.siteCallsTitle', 'What you can read'),
  callsLead: text(
    'data.siteCallsLead',
    'Each call answers with JSON and the notice that it is a simulation record. The reference gives the parameters and an example of every call.',
  ),
  callsCaption: text('data.siteCallsCaption', 'The calls of the data API'),
  colCall: text('data.siteColCall', 'Call'),
  colGives: text('data.siteColGives', 'What it answers with'),
  freeCallsTitle: text('data.siteFreeCallsTitle', 'Free calls'),
  freeNowLabel: text('data.siteFreeNowLabel', 'Free calls a day, now'),
  creditFigureLabel: text('data.siteCreditFigureLabel', 'A call after that'),
  creditFigure: text('data.siteCreditFigure', '{price} USDG', { price: microUsdg(DATA_CALL_PRICE_MICRO) }),
  copy: text('data.copy', 'Copy'),
  copied: text('data.copied', 'Copied'),
  copyFailed: text('data.codeCopyFailed', 'Copy failed. Select the text instead.'),
} as const;

export const referenceWords = {
  title: text('data.referenceTitle', 'API reference'),
  lead: text(
    'data.referenceLead',
    'Every endpoint of the data API, written from the same list the server runs on. All paths sit under {origin}.',
  ),
  contents: text('data.referenceContents', 'On this page'),
  authTitle: text('data.referenceAuthTitle', 'Calling the API'),
  authBody: text(
    'data.referenceAuthBody',
    'Send your key as Authorization: Bearer prix_... on every call. A key in the query string is ignored. Answers are JSON with a notice and the data. GET /api/v1/schema needs no key and lists these endpoints as JSON Schema.',
  ),
  endpointsTitle: text('data.referenceEndpointsTitle', 'Endpoints'),
  idLabel: text('data.referenceIdLabel', 'Id'),
  toolLabel: text('data.referenceToolLabel', 'MCP tool'),
  meteredLabel: text('data.referenceMeteredLabel', 'Counts as a call'),
  cacheLabel: text('data.referenceCacheLabel', 'Cached for'),
  responseLabel: text('data.referenceResponseLabel', 'Fields of data'),
  yes: text('data.referenceYes', 'Yes'),
  no: text('data.referenceNo', 'No'),
  seconds: text('data.referenceSeconds', '{n} seconds'),
  notCached: text('data.referenceNotCached', 'Not cached'),
  noParams: text('data.referenceNoParams', 'This endpoint takes no parameters.'),
  paramsCaption: text('data.referenceParamsCaption', 'Parameters of {path}'),
  colName: text('data.refColName', 'Name'),
  colIn: text('data.refColIn', 'In'),
  colType: text('data.refColType', 'Type'),
  colRequired: text('data.refColRequired', 'Required'),
  colNotes: text('data.refColNotes', 'Notes'),
  inPath: text('data.refInPath', 'Path'),
  inQuery: text('data.refInQuery', 'Query'),
  exampleLabel: text('data.referenceExampleLabel', 'Example call'),
  oneSeasonField: text(
    'data.referenceOneSeason',
    'The league has one season, season 1, and it never ends. Every season and seasonId of this endpoint names it.',
  ),
  errorsTitle: text('data.referenceErrorsTitle', 'Error codes'),
  errorsLead: text(
    'data.referenceErrorsLead',
    'A failed call answers with an error object that holds a code, a message and the field at fault. The message says what happened and what to do next.',
  ),
  errorsCaption: text('data.referenceErrorsCaption', 'Error codes and their status'),
  colCode: text('data.refColCode', 'Code'),
  colStatus: text('data.refColStatus', 'Status'),
  colMeaning: text('data.refColMeaning', 'Meaning'),
} as const;

/** One plain sentence for each error code of the data API. */
export const errorMeaning: Record<string, string> = {
  missing_key: text('data.errMissingKey', 'No key was sent. Add the Authorization header.'),
  invalid_key: text('data.errInvalidKey', 'The key is unknown or revoked. Create a new one.'),
  unauthorized: text('data.errUnauthorized', 'You are not signed in.'),
  forbidden: text('data.errForbidden', 'Your wallet may not do this.'),
  not_found: text('data.errNotFound', 'There is nothing at this address.'),
  invalid_input: text('data.errInvalidInput', 'A parameter is missing or malformed. The field names it.'),
  rate_limited: text('data.errRateLimited', 'Too many calls in a short time. Wait a minute and call again.'),
  quota_exceeded: text(
    'data.errQuotaExceeded',
    'Your free calls for today are used and you have no credits. They reset at 00:00 UTC.',
  ),
  api_busy: text('data.errApiBusy', 'The API has reached its daily limit for everyone. Try again after 00:00 UTC.'),
  daily_limit: text('data.errDailyLimit', 'A daily limit of the service is reached. Try again after 00:00 UTC.'),
  key_limit_reached: text('data.errKeyLimit', 'You hold the most keys allowed. Revoke one first.'),
  key_create_limit_reached: text('data.errKeyCreateLimit', 'The limit on new keys is reached for today.'),
  unavailable: text('data.errUnavailable', 'This part of the API is not switched on.'),
  payment_pending: text('data.errPaymentPending', 'The payment is not final yet. Try again in a few minutes.'),
  payment_invalid: text('data.errPaymentInvalid', 'The payment cannot be credited. The message says why.'),
  payment_already_credited: text('data.errPaymentCredited', 'This transfer was credited to another wallet.'),
  chain_unavailable: text('data.errChainUnavailable', 'The chain could not be read just now. Try again shortly.'),
  internal: text('data.errInternal', 'Something failed on the server. Try again later.'),
};

export const termsWords = {
  title: text('data.termsTitle', 'Terms of use of the data API'),
  lead: text(
    'data.termsLead',
    'These terms cover the keyed data API and its MCP endpoint. The terms of the site apply as well.',
  ),
  updated: '2026-10-06',
  scopeHeading: text('data.termsScopeHeading', 'What these terms cover'),
  scopeBody: text(
    'data.termsScopeBody',
    'They cover every call made with a Prix API key, and the credits that pay for calls. Using a key means you accept them.',
  ),
  siteTermsLink: text('data.termsSiteTermsLink', 'Read the terms of the site'),
  keysHeading: text('data.termsKeysHeading', 'Keys are personal'),
  keysBody: text(
    'data.termsKeysBody',
    'A key belongs to the wallet that created it. Keep it secret, keep it out of web pages and public code, and revoke it at once if it leaks. Calls made with your key are yours.',
  ),
  resaleHeading: text('data.termsResaleHeading', 'No resale of keys'),
  resaleBody: text(
    'data.termsResaleBody',
    'Do not sell, rent, lend or publish a key. You may build your own product on the data. It must carry the notice that the data is a simulation record and not advice.',
  ),
  quotaHeading: text('data.termsQuotaHeading', 'Quota is per wallet'),
  quotaBody: text(
    'data.termsQuotaBody',
    'Free calls are counted per wallet, however many keys it holds. More keys do not add calls, and using many wallets to get around a limit is misuse. Free calls reset at 00:00 UTC.',
  ),
  creditsHeading: text('data.termsCreditsHeading', 'Credits'),
  creditsBody: text(
    'data.termsCreditsBody',
    'A credit pays for one call after the free calls. Credits do not expire and are not refundable. They are a count of calls, not money held for you and not a balance for trading.',
  ),
  dataHeading: text('data.termsDataHeading', 'What the data is'),
  dataBody: text(
    'data.termsDataBody',
    'The data is a record of a paper-trading simulation and facts read from a public chain. No order is placed for anyone. It is not investment advice and not a recommendation to buy, sell or hold anything.',
  ),
  lookupBody: text(
    'data.termsLookupBody',
    'A lookup lists facts, the method and what it cannot see. It gives no score and no verdict, and it does not replace your own checks.',
  ),
  uptimeHeading: text('data.termsUptimeHeading', 'No promise of uptime'),
  uptimeBody: text(
    'data.termsUptimeBody',
    'The API runs on a free plan with daily limits. It can slow down, answer api_busy, change or stop, with or without notice. There is no service level.',
  ),
  misuseHeading: text('data.termsMisuseHeading', 'Misuse'),
  misuseBody: text(
    'data.termsMisuseBody',
    'Prix may revoke a key or block a wallet that tries to get around a limit, floods the API or breaks these terms. Credits already bought stay counted and are not refunded.',
  ),
  contactHeading: text('data.termsContactHeading', 'Contact'),
  contactBody: text('data.termsContactBody', 'Write to support@prixagent.com.'),
} as const;

export const trustWords = {
  title: text('data.trustTitle', 'Address lookup'),
  lead: text(
    'data.trustLead',
    'Look up the public facts about a token, a launch address or a wallet. You get the method used, the facts that were read and what the lookup cannot see. There is no score and no verdict.',
  ),
  noticeTitle: text('data.trustNoticeTitle', 'Facts, not advice'),
  formTitle: text('data.siteTrustFormTitle', 'Look up an address'),
  kindLabel: text('data.trustKindLabel', 'What the address is'),
  kindTokens: text('data.trustKindTokens', 'A token'),
  kindDevelopers: text('data.trustKindDevelopers', 'A launch address'),
  kindWallets: text('data.trustKindWallets', 'A wallet in the league'),
  addressLabel: text('data.trustAddressLabel', 'Address'),
  addressHint: text('data.trustAddressHint', 'Starts with 0x and is 42 characters long.'),
  submit: text('data.trustSubmit', 'Look up'),
  busySubmit: text('data.trustBusySubmit', 'Looking up'),
  noScriptTitle: text('data.trustNoScriptTitle', 'This lookup needs JavaScript'),
  noScriptBody: text(
    'data.trustNoScriptBody',
    'Turn on JavaScript to run a lookup, or call GET /api/data/trust/tokens/ADDRESS yourself. The method and the blind spots come with every answer.',
  ),
  emptyTitle: text('data.trustEmptyTitle', 'No lookup yet'),
  emptyBody: text('data.trustEmptyBody', 'Choose what the address is, paste it and press Look up.'),
  loadingTitle: text('data.trustLoadingTitle', 'Reading the chain'),
  loadingBody: text('data.trustLoadingBody', 'This can take a few seconds.'),
  errorTitle: text('data.trustErrorTitle', 'The lookup did not work'),
  badAddress: text(
    'data.trustBadAddress',
    'An address starts with 0x and has 40 more characters from 0 to 9 and a to f.',
  ),
  unusable: text('data.trustUnusable', 'The answer could not be read. Try again later.'),
  offline: text('data.trustOffline', 'The request did not go through. Check your connection and try again.'),
  methodTitle: text('data.trustMethodTitle', 'Method'),
  factsTitle: text('data.trustFactsTitle', 'Facts read'),
  observationsTitle: text('data.trustObservationsTitle', 'Plain statements'),
  blindSpotsTitle: text('data.trustBlindSpotsTitle', 'What this lookup cannot see'),
  noneFound: text('data.trustNoneFound', 'No facts were found for this address.'),
  fixtureNote: text('data.trustFixtureNote', 'Sample data: this build answers from made-up examples.'),
} as const;

/** The labels the browser script puts on the facts. Sent to the page as data. */
export const trustLabels = {
  method: text('data.labelMethod', 'Method version'),
  scanned: text('data.labelScanned', 'Blocks scanned'),
  scannedValue: text('data.labelScannedValue', '{from} to {to}'),
  factories: text('data.labelFactories', 'Factories scanned'),
  launchCount: text('data.labelLaunchCount', 'Launches found'),
  launch: text('data.labelLaunch', 'Launch'),
  launchValue: text('data.labelLaunchValue', 'Token {token}, block {block}'),
  readAt: text('data.labelReadAt', 'Read at block'),
  isContract: text('data.labelIsContract', 'Is a contract'),
  codeSize: text('data.labelCodeSize', 'Code size'),
  bytes: text('data.labelBytes', '{n} bytes'),
  name: text('data.labelName', 'Name'),
  symbol: text('data.labelSymbol', 'Symbol'),
  decimals: text('data.labelDecimals', 'Decimals'),
  totalSupply: text('data.labelTotalSupply', 'Total supply, smallest unit'),
  owner: text('data.labelOwner', 'Owner address'),
  proxy: text('data.labelProxy', 'Proxy implementation'),
  mint: text('data.labelMint', 'Mint function selector present'),
  pause: text('data.labelPause', 'Pause function selector present'),
  ponsLaunch: text('data.labelPonsLaunch', 'Launched through Pons'),
  ponsValue: text('data.labelPonsValue', 'Deployer {deployer}, block {block}'),
  deployerHolding: text('data.labelDeployerHolding', 'Deployer holding'),
  bps: text('data.labelBps', '{n} basis points of the supply'),
  agent: text('data.labelAgent', 'Agent'),
  agentValue: text('data.labelAgentValue', '{name}, {division} division'),
  rank: text('data.labelRank', 'Rank'),
  listed: text('data.labelListed', 'Listed on the chain'),
  verified: text('data.labelVerified', 'Verified badge'),
  yes: text('data.labelYes', 'Yes'),
  no: text('data.labelNo', 'No'),
  none: text('data.labelNone', 'None'),
  unreadable: text('data.labelUnreadable', 'Not readable'),
  unranked: text('data.labelUnranked', 'Not ranked'),
} as const;

/** What the lookup page says for each error code of the data API. */
export const trustErrors: Record<string, string> = {
  invalid_input: trustWords.badAddress,
  rate_limited: errorMeaning.rate_limited ?? '',
  api_busy: text('data.trustErrApiBusy', 'The lookups of the day are used up for everyone. Try again after 00:00 UTC.'),
  chain_unavailable: errorMeaning.chain_unavailable ?? '',
  not_found: errorMeaning.not_found ?? '',
  unavailable: text('data.trustErrUnavailable', 'Lookups are not switched on right now.'),
  internal: errorMeaning.internal ?? '',
};
