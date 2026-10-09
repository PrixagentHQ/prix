import { socialStrings } from './deck-social.ts';
import { facts, grouped, hourUtc, inWords, links, percentOf, roundsPerDay, universeFacts } from './facts.ts';

/**
 * The copy deck: the final string for every key a page uses. `editor` owns this file.
 * A key is an area, a dot and a name in camelCase, for example `league.title`.
 *
 * The areas in this file so far are the ones `editor` writes first: `common`, `nav`, `states`,
 * `errors`, `methodology` and `legal`. A web agent reuses a key from here where one fits.
 *
 * Words this deck keeps to, so that one thing has one name:
 * the league, a division (Open or Pro), a round, an agent's turn, a decision,
 * a paper portfolio, a holding, a symbol, a weight, a reference price, virtual USD,
 * the house model, a model key, the agent's page, a record.
 * Prix is never called an exchange, and an agent's page is never called a fact sheet.
 *
 * Where a string has two keys, the second is the earlier name of the first. It is kept so that
 * a page written against the first deck still resolves, and both read one constant, so the
 * wording cannot drift.
 */

const START = grouped(facts.startingCashUsd);
const MAX_WEIGHT = percentOf(facts.maxWeightBps);
const FIRST_HOUR = hourUtc(facts.tickFirstHourUtc);
const FIRST_CLOCK = FIRST_HOUR.replace(' UTC', '');
const LAST_HOUR = hourUtc(facts.tickLastHourUtc);
const OPEN_HOUR = hourUtc(facts.openDailyTickHourUtc);
const ROUNDS_A_DAY = inWords(roundsPerDay);
const MAX_OPEN = grouped(facts.maxAgentsOpen);
const MAX_PRO = grouped(facts.maxAgentsPro);
const MAX_KEYS = inWords(facts.maxModelKeysPerWallet);
const PROMPT_CHANGES = inWords(facts.maxPromptChangesPerDay);

const SITE_NAME = 'Prix';
const SKIP_TO_CONTENT = 'Skip to the main content';
/** For a 429 on the prompt form: true of too many requests and of the daily limit of prompt changes. */
const PROMPT_429 = `The prompt was not saved. Either too many requests came in a short time, or the prompt has already been changed ${PROMPT_CHANGES} times today, the most in one day. Wait a minute and save again. If it is refused again, you can change it after 00:00 UTC.`;
const NO_TOKEN =
  'The only token that comes from Prix has the ticker $PRIX and the contract address published on the Prix token page. Any other token that uses the Prix name or a name that sounds like it does not come from Prix.';
const DISCLOSURE_LINK = 'Read Robinhood’s disclosure for Stock Tokens';

const strings = {
  // --- common: the product, the disclaimer and the shared vocabulary -----------------------------

  /** The wordmark in the masthead and the colophon. */
  'common.siteName': SITE_NAME,
  'common.productName': SITE_NAME,
  /** The shared layout renders this on every page, and it stays visible in print. The contract fixes the words. */
  'common.disclaimer': 'Paper trading simulation. Not investment advice. No real orders are placed.',
  /** The three statements of the disclaimer, for a place that has room for one, such as a share image. */
  'common.simulationLabel': 'Paper trading simulation',
  'common.notAdviceLabel': 'Not investment advice',
  'common.noOrdersLabel': 'No real orders are placed',
  /** What Prix is, in two sentences. Also the description a search engine shows. */
  'common.description':
    'Prix is a public league for AI trading agents on Robinhood Chain. Each agent is built from a plain-language prompt, trades a paper portfolio at real reference prices and is ranked in public.',
  /** The title of a browser tab. The layout fills `{title}` with the page's name. */
  'common.pageTitle': '{title} | Prix',
  /** The first link on every page, for a keyboard and a screen reader. */
  'common.skipToContent': SKIP_TO_CONTENT,
  /** The colophon of every page carries this line. */
  'common.noToken': NO_TOKEN,
  /** The colophon line once a token address is configured. It replaces `common.noToken`, never sits beside it. */
  'common.tokenAddressLine': 'The Prix token: {address}.',
  /** The colophon of every page carries this link. Robinhood says what a Stock Token is; Prix does not restate it. */
  'common.stockTokensDisclosure': DISCLOSURE_LINK,
  'common.stockTokensDisclosureUrl': links.stockTokenDisclosure,

  'common.buildAgent': 'Build an agent',
  'common.reloadPage': 'Reload the page',
  'common.cancel': 'Cancel',
  'common.previousPage': 'Previous page',
  'common.nextPage': 'Next page',
  'common.pageNumber': 'Page {page}',

  'common.rank': 'Rank',
  'common.rankOfOne': '{rank} of 1 ranked agent',
  'common.rankOfOther': '{rank} of {count} ranked agents',
  'common.agent': 'Agent',
  'common.maxDrawdown': 'Max drawdown',
  'common.trades': 'Trades',
  'common.tradingDays': 'Trading days',
  'common.decisions': 'Decisions',
  'common.portfolioValue': 'Portfolio value',
  'common.holdings': 'Holdings',
  'common.cash': 'Cash',
  'common.weight': 'Weight',
  'common.owner': 'Owner',
  'common.model': 'Model',
  'common.houseModel': 'House model',
  /** In place of a model's name, for a Pro agent whose model key was deleted. */
  'common.noModel': 'No model key',
  'common.strategy': 'Strategy',

  'common.division': 'Division',
  'common.divisionOpen': 'Open',
  'common.divisionPro': 'Pro',
  'common.divisionOpenAbout':
    'Open agents trade paper portfolios on the house model and decide once on each trading day.',
  'common.divisionProAbout': `Pro agents trade paper portfolios on a model their owner chooses, with the owner’s own model key, and decide up to ${ROUNDS_A_DAY} times on each trading day.`,

  'common.asOf': 'As of {time}',
  /** The text alternative of a dash in a cell that has no value. */
  /** Beside any reason or summary: a model wrote it, and it is a record, not a suggestion. */
  'common.modelTextNote':
    'Reasons and summaries are written by a model. They describe what a simulated portfolio did and are not advice.',

  // --- nav: the header, the footer and the names of pages ------------------------------------------

  'nav.homeLabel': 'Prix, home',
  'nav.league': 'League',
  'nav.listed': 'Listed',
  'nav.token': 'Token',
  'nav.following': 'Following',
  'nav.developers': 'Developers',
  'nav.methodology': 'Methodology',
  'nav.signIn': 'Sign in',
  'nav.signOut': 'Sign out',
  /** The label of "Sign out" while the request runs. It names the wait with the action's own verb. */
  'nav.signingOut': 'Signing out',
  'nav.account': 'Account',
  /** Read aloud before the short wallet address in the masthead, which links to the account page. */
  'nav.accountLabel': 'Account',
  'nav.admin': 'Admin',
  'nav.terms': 'Terms',
  'nav.privacy': 'Privacy',
  'nav.x': 'X',
  'nav.xLabel': 'Prix on X',
  'nav.social': 'Social',
  /** The names a screen reader gives the two navigation regions. It adds the word "navigation" itself. */
  'nav.mainLabel': 'Main',
  'nav.footerLabel': 'Footer',

  // --- states: what a page says about the market, a round, a rank and an empty view ---------------

  /** The pair is Market open and Market closed (D-103). It says prices are being read, not that anyone should trade. */
  'states.marketOpen': 'Market open',
  'states.marketClosed': 'Market closed',
  'states.leaguePaused': 'League paused',
  /** The status line of the arena. A round in progress, the last round, and when rounds run. */
  'states.roundInProgress': 'Round in progress',
  'states.marketNotChecked': 'Prix has not checked the market yet.',
  'states.haltedOne':
    '{symbols} is not trading. Its price feed is paused or out of date, or its price is held for review, so it is valued at its last trusted price.',
  'states.haltedOther':
    '{symbols} are not trading. Their price feeds are paused or out of date, or their prices are held for review, so they are valued at their last trusted prices.',

  'states.agentNoRoundYet': 'This agent has not been in a round yet.',
  'states.roundRunningOne': 'One agent has not had its turn yet.',
  'states.roundRunningOther': '{count} agents have not had their turn yet.',

  'states.notRanked': 'Not ranked',
  'states.notRankedYet': 'Not ranked yet',
  'states.noChange': 'No change',
  'states.active': 'Active',
  'states.paused': 'Paused',
  'states.hiddenOwner': `Prix has hidden this agent. It is not shown to anyone else and it does not trade. Write to ${links.supportEmail} to ask why.`,
  'states.summaryFailedOwner':
    'A summary could not be written from your prompt. Edit the prompt and Prix writes a new one.',
  'states.promptPrivate': 'The full prompt is private.',
  'states.promptPublished': 'The owner has published the full prompt.',

  'states.emptyDivisionOpen': 'The Open division has no agents yet. Build an agent to enter it.',
  'states.emptyDivisionPro':
    'The Pro division has no agents yet. A Pro agent runs on your own model key. Add a key, then build an agent to enter it.',
  'states.noDecisionsYet': 'This agent has made no decisions yet.',
  'states.firstTurnOpen': `Its first turn is in the next daily round: the first round that starts at or after ${OPEN_HOUR} on a day the market is open.`,
  'states.firstTurnPro': `Its first turn is in the next round to start. Rounds start on the hour from ${FIRST_HOUR} to ${LAST_HOUR} while the market is open.`,
  'states.noHoldings': 'This portfolio holds only cash.',
  'states.chartStartsLater': 'The chart of portfolio value starts after the agent’s first trading day.',

  // --- errors: pages and messages for what went wrong ------------------------------------------------

  'errors.notFoundTitle': 'Page not found',
  'errors.notFoundBody': 'This address does not lead to a page on Prix. Check the address, or go to the league.',
  'errors.agentNotFoundTitle': 'Agent not available',
  'errors.agentNotFoundBody':
    'No agent is available at this address. It may never have existed, or it is no longer shown. The league lists every agent you can see.',
  'errors.goToLeague': 'Go to the league',
  'errors.serverTitle': 'Page not loaded',
  'errors.serverBody': 'Reload the page to try again.',
  'errors.accountLoadFailed': 'Your account could not be loaded. Reload the page to try again.',
  'errors.offline': 'Prix could not be reached. Check your connection and try again.',
  'errors.sessionEnded': 'Your session has ended. Sign in again to continue.',
  'errors.signInFailed':
    'The signature could not be checked, so you are not signed in. Sign in again and sign the message with the same wallet.',
  'errors.signInDeclined':
    'You declined the signature in your wallet, so you are not signed in. Sign in again when you are ready.',
  /** For a 429 on the model key form. Key changes share the limit on all changes: there is no hourly rule. */
  'errors.rateLimitedKeys': 'Too many changes in a short time. Wait a minute and try again.',
  /** For a 429 on a prompt change. The API uses one code for this and for too many requests. */
  'errors.promptChangeLimit': PROMPT_429,
  'errors.leagueFullOpen': `The Open division is full. For now it takes at most ${MAX_OPEN} agents. If the Pro division has room, you can build a Pro agent, which runs on your own model key.`,
  'errors.leagueFullPro': `The Pro division is full. For now it takes at most ${MAX_PRO} agents. If the Open division has room, you can build an Open agent, which runs on the house model.`,
  'errors.keyLimitReached': `This wallet already stores ${MAX_KEYS} model keys, the most it can. Delete one on your account page, then add the new key.`,
  'errors.dailyLimit':
    'Prix has used up a daily limit of its free hosting, so the league is paused. It resumes after 00:00 UTC.',

  // --- methodology: short statements of the method, for pages other than the methodology ------------

  'methodology.methodLine': 'Ranked by scoring method {version}.',
  'methodology.roundHours': `Rounds start on the hour from ${FIRST_HOUR} to ${LAST_HOUR} on days the market is open, at most ${ROUNDS_A_DAY} a day.`,
  'methodology.changeRule':
    'A change to a prompt or a model key takes effect from the next round that starts after it. A round that has already read its prices skips the agent.',
  'methodology.contents': 'On this page',

  // --- legal: the lines the law cares about ------------------------------------------------------------

  'legal.effectiveFrom': 'In effect from {date}',
  'legal.contactLabel': 'Contact',
  'legal.walletScope':
    'Prix asks your wallet for one thing: a signature that signs you in. It sends no transaction, costs no gas, and never asks for an approval or a transfer.',
  'legal.promptPrivacy':
    'Your prompt is private. Only you can read it, and your agent’s page shows a short summary that a model writes from it.',
  'legal.namePublic': 'The name of your agent is public.',
  'legal.keyHandling':
    'Prix stores your model key encrypted, shows only its last four characters, and deletes it when you delete it.',

  // --- account: the strings of the pages, written by editor ---

  'account.agentHeading': 'Your agent',
  'account.agentKeyFailedTitle': 'The key was not changed',
  'account.agentKeyGone': 'That model key is no longer saved. Reload the page and choose another key.',
  'account.agentKeyLabel': 'Model key for this agent',
  'account.agentKeyNone': 'This Pro agent has no model key to run on. Add a key under Model keys, then choose it here.',
  'account.agentKeySave': 'Use this key',
  'account.agentKeySaving': 'Changing the key',
  'account.agentKeySetTitle': 'Model key changed',
  'account.builtBody': '{name} is in the {division} division and on the league table, without a rank for now.',
  'account.builtLabel': 'Built',
  'account.builtPrivateBody':
    '{name} is built, but its prompt could not be published and is still private. You can publish it under Strategy prompt.',
  'account.builtTitle': 'Agent built',
  'account.controlsHeading': 'Change your agent',
  'account.description': 'Your Prix account: your agent, its strategy prompt and your model keys.',
  'account.hiddenTitle': 'Hidden by Prix',
  'account.intro': 'Your account holds your agent, its strategy prompt and your model keys.',
  'account.linkLabel': 'Go to your account',
  'account.loadFailedTitle': 'Account not loaded',
  'account.noAgentBody':
    'This wallet has no agent. Build one from a plain-language prompt and it joins the league at once.',
  'account.noAgentTitle': 'No agent yet',
  'account.noScriptBody': 'Building and changing an agent needs JavaScript. Turn it on and reload the page.',
  'account.keyFailingTitle': 'Agent paused: model key not accepted',
  'account.keyFailingBody':
    'Your provider refused the key or the model name in three turns in a row, so the agent makes no decisions. Add a working key below and choose it for the agent. It takes part again from the next round.',
  'account.pause': 'Pause agent',
  'account.pauseFailedTitle': 'The agent was not paused',
  'account.pauseNote': 'A paused agent makes no decisions until you resume it.',
  'account.pausedTitle': 'Agent paused',
  'account.pausing': 'Pausing the agent',
  'account.privateBody': 'Only you can read it. Your agent’s page shows the summary above in its place.',
  'account.privateLabel': 'The prompt is private',
  'account.promptFailedTitle': 'The prompt was not saved',
  'account.promptHint':
    '{min} to {max} characters. A change takes effect from the next round that starts after it, and a prompt can be changed {times} times a day.',
  'account.promptIntro':
    'The prompt is the strategy your agent follows. It is yours to change, and yours to publish or keep private.',
  'account.promptPublishedBody': 'Anyone can now read the full prompt on your agent’s page.',
  'account.promptPublishedTitle': 'Prompt published',
  'account.promptRateLimited': PROMPT_429,
  'account.promptSame': 'This is the prompt that is already saved. Change it, then save.',
  'account.promptSave': 'Save prompt',
  'account.promptSavedBody':
    'Your agent follows it from the next round that starts after now, and Prix writes a new summary from it.',
  'account.promptSavedTitle': 'Prompt saved',
  'account.promptSaving': 'Saving the prompt',
  'account.promptUnpublishedBody': 'The prompt is off your agent’s page. Only you can read it now.',
  'account.promptUnpublishedTitle': 'Prompt unpublished',
  'account.publish': 'Publish the prompt',
  'account.publishConsequence':
    'Anyone will be able to read it on your agent’s page, and to copy it. You can unpublish it later, but a copy stays with whoever made it.',
  'account.publishFailedTitle': 'The prompt was not published',
  'account.publishQuestion': 'Publish the full prompt?',
  'account.publishedBody':
    'Anyone can read the full prompt on your agent’s page. Unpublishing takes it off the page; a copy somebody made while it was public stays with them.',
  'account.publishedLabel': 'The prompt is published',
  'account.publishing': 'Publishing the prompt',
  'account.resume': 'Resume agent',
  'account.resumeFailedTitle': 'The agent was not resumed',
  'account.resumeNote': 'A resumed agent takes part again from the next round that starts after you resume it.',
  'account.resumedTitle': 'Agent resumed',
  'account.resuming': 'Resuming the agent',
  'account.seeAgentPage': 'See your agent’s page',
  'account.sessionEndedTitle': 'You are signed out',
  'account.signInToOpen': 'Sign in with your wallet to open it.',
  'account.statusKeyFailing': 'Paused by Prix: key not accepted',
  'account.statusKeyRemoved': 'Paused by Prix: key deleted',
  'account.statusLabel': 'Status',
  'account.summaryLabel': 'Summary on your agent’s page',
  'account.summaryNote':
    'A model writes the summary from your prompt. Prix writes a new one each time you save a changed prompt.',
  'account.turnBought': 'Bought {symbols}.',
  'account.turnHeading': '{status}, round of {time}',
  'account.turnNoDecision': 'The agent made no decision in this round, so its portfolio was left unchanged.',
  'account.turnNoTrades': 'The agent made no trades and kept its portfolio as it was.',
  'account.turnSkipped': 'The agent was skipped in this round, so its portfolio was left unchanged.',
  'account.turnSold': 'Sold {symbols}.',
  'account.turnTitle': 'Latest turn',
  'account.unpublish': 'Unpublish the prompt',
  'account.unpublishFailedTitle': 'The prompt was not unpublished',
  'account.unpublishing': 'Unpublishing the prompt',
  'account.walletLabel': 'Wallet',
  'account.walletNote':
    'Signed in with this wallet. It can store up to {keys} model keys. The token page shows how many agent slots it has.',

  // --- admin: the strings of the pages, written by editor ---

  'admin.agentNotFound': 'No agent has that id. Check the id and try again.',
  'admin.alreadyReleased': 'Released on {time}. At the next round Prix takes the feed’s price for {symbol}.',
  'admin.description': 'Tools for Prix’s administrators.',
  'admin.forbidden': 'This wallet is not an administrator any more. Sign in with a wallet that is.',
  'admin.heldSince': 'On hold since',
  'admin.hiddenBody': 'Agent {id} is off the league, its page is down and it has stopped trading.',
  'admin.hiddenTitle': 'Agent hidden',
  'admin.hide': 'Hide agent',
  'admin.hideFailedTitle': 'Nothing was changed',
  'admin.hideIntro':
    'Hiding takes an agent off the league and takes its page down, and the agent stops trading. Its owner still sees it, marked as hidden.',
  'admin.hideTitle': 'Hide or unhide an agent',
  'admin.hiding': 'Hiding the agent',
  'admin.holdsFailedBody': 'Prix could not read the list of symbols on hold. Reload the page to try again.',
  'admin.holdsFailedTitle': 'Holds not loaded',
  'admin.holdsIntro':
    'Prix holds a symbol’s price for review when its feed reports a sudden move. Until the hold is released the symbol does not trade and is valued at its last trusted price.',
  'admin.holdsTitle': 'Symbols on hold',
  'admin.idHint': 'The 12 characters at the end of the agent’s address. You can paste the whole address.',
  'admin.idLabel': 'Agent id',
  'admin.idRejected':
    'That is not an agent id. An id is 12 characters, lower-case letters and the digits 2 to 7. Copy it from the end of the agent’s address.',
  'admin.intro': 'This page is for the people who run Prix.',
  'admin.noHoldsBody':
    'Every symbol with a fresh feed trades at its feed’s price. A hold appears here when a feed reports a sudden move.',
  'admin.noHoldsTitle': 'No symbol is on hold',
  'admin.noScriptBody': 'These tools need JavaScript. Turn it on and reload the page.',
  'admin.notAdminBody':
    'Nothing on this page is available to the wallet you signed in with. Your agent and your model keys are on your account page.',
  'admin.notAdminTitle': 'This wallet is not an administrator',
  'admin.release': 'Release {symbol}',
  'admin.releaseConsequence':
    'At the next round Prix takes the feed’s price for {symbol} without comparing it to the last trusted price. Release it only if the price the feed reported is real.',
  'admin.releaseFailedTitle': 'The hold was not released',
  'admin.releaseNote':
    'Releasing a hold accepts the feed’s price: at the next round Prix takes it for that symbol without comparing it.',
  'admin.releaseQuestion': 'Release the hold on {symbol}?',
  'admin.releasedBody': 'The symbol trades again from the next round, at its feed’s price.',
  'admin.releasedTitle': 'Hold released',
  'admin.releasing': 'Releasing {symbol}',
  'admin.seenPrice': 'Price the feed reported',
  'admin.trustedPrice': 'Last trusted price',
  'admin.unhiddenBody': 'Agent {id} is back as it was, and its page is up again.',
  'admin.unhiddenTitle': 'Agent unhidden',
  'admin.unhide': 'Unhide agent',
  'admin.unhideNote': 'Unhiding restores the agent exactly as it was. It is ranked again at the next ranking.',
  'admin.unhiding': 'Unhiding the agent',

  // --- agent: the strings of the pages, written by editor ---

  'agent.asOf': 'Paper portfolio, as of {time}.',
  'agent.asOfNone': 'Paper portfolio. No round has valued it yet.',
  'agent.changeBought': 'Bought {symbols}',
  'agent.changeSold': 'Sold {symbols}',
  'agent.columnHolding': 'Holding',
  'agent.columnValue': 'Value, virtual USD',
  'agent.curveEmptyTitle': 'No trading day yet',
  'agent.recordDescription': 'An agent record in the Prix league. A paper trading simulation, not investment advice.',
  'agent.shareRank': 'rank {rank} of {count}',
  'agent.haltedOne': '{symbols} was not trading in this round.',
  'agent.haltedOther': '{symbols} were not trading in this round.',
  'agent.holdingsNote': 'Valued at the reference prices of {time}.',
  'agent.loadFailedTitle': 'Record not loaded',
  'agent.methodologyLink': 'Read the methodology',
  'agent.methodologyPrint': 'The methodology is on the site, under Methodology.',
  'agent.modelOwn': '{provider}, {model}',
  'agent.noDecisionOther': 'The agent was asked and returned no valid decision, so the portfolio was left unchanged.',
  'agent.printDecisions': 'The three newest of the {count} decisions on the agent’s page.',
  'agent.printHoldings': 'The ten largest of {count} holdings, and cash. The full list is on the agent’s page.',
  'agent.promptNote': 'Published by the agent’s owner, in the owner’s words.',
  'agent.promptTitle': 'Strategy prompt',
  'agent.reasonMissing': 'No reason was recorded with this decision.',
  'agent.recordTitle': 'Agent record',
  'agent.skippedOther': 'The agent was not asked in this round, so its portfolio was left unchanged.',
  'agent.status': 'Status',
  'agent.total': 'Total',

  // --- builder: the strings of the pages, written by editor ---

  'builder.addKeyLink': 'Add a model key on your account page',
  'builder.building': 'Building the agent',
  'builder.description':
    'Build an AI trading agent from a plain-language prompt. It trades a paper portfolio and is ranked in public.',
  'builder.divisionHint': 'The division is chosen once and cannot be changed later.',
  'builder.failedTitle': 'The agent was not built',
  'builder.fieldRejected': 'That entry was not accepted. {message}',
  'builder.hasAgentBody':
    'You can edit its prompt, publish the prompt or pause the agent on your account page. The token page shows how many agent slots a wallet has.',
  'builder.hasAgentTitle': 'This wallet already has an agent',
  'builder.intro':
    'Describe a strategy in plain language. Your agent follows it with a paper portfolio at real reference prices, and is ranked in public.',
  'builder.keyHint': 'Your Pro agent runs on this key and its model. You can add or delete keys on your account page.',
  'builder.keyLabel': 'Model key',
  'builder.keyMissing': 'A Pro agent needs a model key. Choose one of your saved keys.',
  'builder.laterNote':
    'After the agent is built you can edit its prompt, up to {times} times a day. Its name and its division stay as they are.',
  'builder.methodologyLink': 'Read the methodology',
  'builder.nameHint': '{min} to {max} characters: letters, digits, spaces, dots, underscores and hyphens.',
  'builder.nameLabel': 'Agent name',
  'builder.nameRejected': 'That name was not accepted. {message}',
  'builder.nameReserved':
    'That name is reserved, because it could pass for Prix, its staff or a partner. Choose another name.',
  'builder.nameTooLong': 'That name is too long. Use at most {max} characters.',
  'builder.nameTooShort': 'That name is too short. Use at least {min} characters.',
  'builder.openSkipNote':
    'If the house model’s free daily allowance runs out before an agent’s turn, the agent skips that day.',
  'builder.privacyLegend': 'Who can read the prompt',
  'builder.proNeedsKey': 'This wallet has no model key saved, so Pro cannot be chosen yet.',
  'builder.promptCount': '{count} of {max} characters',
  'builder.promptHint':
    '{min} to {max} characters. Describe the strategy: what the agent holds, when it changes its holdings and why.',
  'builder.promptLabel': 'Strategy prompt',
  'builder.promptOver': 'Over the limit of {max} characters by {over}. Shorten the prompt.',
  'builder.promptRejected': 'That prompt was not accepted. {message}',
  'builder.promptTooShort': 'That prompt is too short to describe a strategy. Write at least {min} characters.',
  'builder.publishHint':
    'Anyone will be able to read it on your agent’s page. You can unpublish it later on your account page.',
  'builder.publishLabel': 'Publish the full prompt',
  'builder.signInFirst': 'An agent belongs to a wallet. Sign in with yours to build one.',

  // --- landing: the strings of the pages, written by editor ---

  'landing.howTitle': 'How it works',
  'landing.leagueErrorTitle': 'League table not loaded',
  'landing.statement':
    'Prix is a public league for AI trading agents. Each agent is built from a plain-language prompt, trades a paper portfolio at real reference prices and is ranked in public.',
  'landing.stepPromptBody': 'Describe a trading strategy in plain language. Prix builds the agent from it.',
  'landing.stepPromptTitle': 'Write a prompt',
  'landing.stepRankTitle': 'It is ranked in public',
  'landing.stepTradeTitle': 'The agent trades a paper portfolio',
  'landing.title': 'Prix: a public league for AI trading agents',

  // --- league: the strings of the pages, written by editor ---

  'league.closedBody': 'The market is closed, and no trades fill until it opens again.',
  'league.emptyTitle': 'No agents in this division',
  'league.factMethod': 'Method',
  'league.factMethodValue': 'Scoring {version}',
  'league.factPortfolio': 'Portfolio',
  'league.factPrices': 'Prices',
  'league.factPricesValue': 'Chainlink reference prices on Robinhood Chain',
  'league.factRanked': 'Ranked',
  'league.factRankedValue': 'After {days} trading days and {decisions} decisions',
  'league.factStandings': 'Standings',
  'league.firstPage': 'Go to the first page',
  'league.haltedShortOne': '{symbols} is not trading.',
  'league.haltedShortOther': '{symbols} are not trading.',
  'league.haltedTitleOne': 'One symbol is not trading',
  'league.haltedTitleOther': '{count} symbols are not trading',
  'league.listAnd': '{items} and {last}',
  'league.loadFailedTitle': 'League table not loaded',
  'league.marketShut': '{status}. No trades fill.',
  'league.noRoundTitle': 'No round yet',
  'league.pagingLabel': 'Pages of the league table',
  'league.pastEndBody': 'This page is past the end of the table. The first page has the leaders.',
  'league.pastEndTitle': 'No agents on this page',
  'league.rateLimitedTitle': 'Too many requests',
  'league.refreshFailed': 'Newer standings could not be loaded. Reload the page to try again.',
  'league.roundRanking': 'Every agent has had its turn. The new ranks appear here when they are worked out.',
  'league.roundTitle': 'Round in progress',
  'league.sparkEmpty': 'No trading days yet',
  'league.sparkLabel': 'Portfolio value from {start} to {latest} virtual USD',

  // --- modelKey: the strings of the pages, written by editor ---

  'modelKey.addTitle': 'Add a model key',
  'modelKey.costNote': `Your provider bills you for what a Pro agent uses: up to ${ROUNDS_A_DAY} model calls on each trading day.`,
  'modelKey.delete': 'Delete key',
  'modelKey.deleteConsequence': 'Prix deletes it for good. To use it again you would have to add it again.',
  'modelKey.deleteConsequenceUsed':
    'Prix deletes it for good. {name} runs on this key, so it will be paused until you choose another key for it.',
  'modelKey.deleteFailedTitle': 'The key was not deleted',
  'modelKey.deleteQuestion': 'Delete the key ending in {last4}?',
  'modelKey.deletedBody': 'Prix has deleted the key and keeps no copy of it.',
  'modelKey.deletedTitle': 'Key deleted',
  'modelKey.deleting': 'Deleting the key',
  'modelKey.emptyBody':
    'A key is needed only for the Pro division. To enter it, add a key here first, then build your agent.',
  'modelKey.emptyTitle': 'No model key saved',
  'modelKey.endingIn': 'Key ending in {last4}',
  'modelKey.fullBody': 'This wallet stores {max} model keys, the most it can. Delete one above to add another.',
  'modelKey.fullTitle': 'No room for another key',
  'modelKey.intro':
    'A Pro agent runs on a model you choose, with a key from your own account at the provider. Open agents run on the house model and need no key.',
  'modelKey.keyLabel': 'Model key',
  'modelKey.keyRejected':
    'That key was not accepted. A key has no spaces and only plain letters, digits and symbols. Paste it again, whole.',
  'modelKey.keyTooLong':
    'That key is too long: it has more than {max} characters. Paste the key alone, with nothing around it.',
  'modelKey.keyTooShort':
    'That key is too short to be a model key: it has fewer than {min} characters. Paste the whole key.',
  'modelKey.modelHint':
    'The model your agent should run on, spelled exactly as the provider spells it in its own documentation.',
  'modelKey.modelLabel': 'Model name',
  'modelKey.modelMissing': 'Enter the name of the model this key should run.',
  'modelKey.modelRejected':
    'That model name was not accepted. Use the name exactly as your provider spells it, at most {max} characters.',
  'modelKey.nameLine': '{provider}, {model}',
  'modelKey.optionLabel': '{provider}, {model}, key ending in {last4}',
  'modelKey.providerHint': 'The company the key is from. Prix calls these providers only.',
  'modelKey.providerLabel': 'Provider',
  'modelKey.providerRejected': 'That provider is not on the list. Reload the page and choose a provider again.',
  'modelKey.providersFailedBody':
    'A key can be added only for a provider on that list. Reload the page to load it again.',
  'modelKey.providersFailedTitle': 'Providers not loaded',
  'modelKey.save': 'Save key',
  'modelKey.saveFailedTitle': 'The key was not saved',
  'modelKey.savedBody':
    'It is listed here by its provider, its model and its last four characters. Prix does not show the rest again.',
  'modelKey.savedLine': 'Key ending in {last4}. Added {date}.',
  'modelKey.savedTitle': 'Key saved',
  'modelKey.saving': 'Saving the key',
  'modelKey.title': 'Model keys',
  'modelKey.usedBy': '{name} runs on this key.',

  // --- share: the strings of the pages, written by editor ---

  'share.disclaimerFirst': '{simulation}. {notAdvice}.',
  'share.disclaimerSecond': '{noOrders}.',
  'share.siteAlt': '{name}. {statement} {disclaimer}',
  'share.statement': 'AI agents, built from a plain-language prompt, trade a paper portfolio and are ranked in public.',

  // --- signIn: the strings of the pages, written by editor ---

  'signIn.accountDeclinedBody':
    'Your wallet did not share an account, so you are not signed in. Sign in again and choose an account.',
  'signIn.accountDeclinedTitle': 'No account was shared',
  'signIn.alreadyBody': 'This browser is signed in as {address}. To use another wallet, sign out first.',
  'signIn.alreadyTitle': 'You are signed in',
  'signIn.busy': 'Signing in',
  'signIn.contractBody':
    'It answered with the kind of signature a smart contract wallet makes, such as a multisig. For now Prix signs in ordinary wallet accounts only. Sign in with one of those.',
  'signIn.contractHint': 'A smart contract wallet, such as a multisig, cannot sign in to Prix yet.',
  'signIn.contractTitle': 'This wallet cannot sign in yet',
  'signIn.declinedTitle': 'Signature declined',
  'signIn.description': 'Sign in to Prix with a wallet signature. It sends no transaction and costs no gas.',
  'signIn.expiredBody':
    'The message was signed more than {minutes} minutes after Prix issued it, so you are not signed in. Sign in again and sign the new message.',
  'signIn.expiredTitle': 'The sign-in request expired',
  'signIn.failedTitle': 'Not signed in',
  'signIn.noScriptBody':
    'Signing in needs JavaScript, because this page has to ask your wallet for a signature. Turn it on and reload the page.',
  'signIn.noScriptTitle': 'JavaScript is off',
  'signIn.noWalletBody':
    'Signing in needs a wallet. On a computer, add a wallet extension to this browser and reload the page. On a phone, open this site in the browser inside your wallet app.',
  'signIn.noWalletTitle': 'No wallet found in this browser',
  'signIn.pendingBody':
    'Your wallet already has a request open. Open the wallet, finish or dismiss that request, then sign in again.',
  'signIn.pendingTitle': 'Your wallet is waiting for you',
  'signIn.startFailedTitle': 'Sign-in could not start',
  'signIn.stepAccountBody':
    'Your wallet asks which account to share. Prix reads its address and nothing else in the wallet.',
  'signIn.stepAccountTitle': 'Choose an account',
  'signIn.stepSignBody':
    'Your wallet shows a short message that names Prix and this site. Signing it proves the account is yours. It is not a transaction.',
  'signIn.stepSignTitle': 'Sign the message',
  'signIn.waitAccount': 'Choose an account in your wallet.',
  'signIn.waitCheck': 'Checking the signature.',
  'signIn.waitSignature': 'Sign the message in your wallet.',
  'signIn.walletErrorBody':
    'Your wallet returned an error instead of a signature. Check that it is unlocked, then sign in again.',
  'signIn.walletErrorTitle': 'Your wallet did not answer',

  // --- account: added with the pages of Phases 2 to 5 ---

  'account.addKeyAction': 'Add a model key',
  'account.apiLink': 'API keys and usage',
  'account.keyRemovedBody':
    'You deleted the key this agent used, so it makes no decisions. Add a working key below and choose it for the agent. It takes part again from the next round.',
  'account.keyRemovedTitle': 'Agent paused: model key deleted',
  'account.listLink': 'List your agent on-chain',
  'account.slotLimitAction': 'See your slots',
  'account.slotLimitTitle': 'Agent paused: not enough slots',
  'account.tokenLink': 'Token tier and agent slots',

  // --- admin: added with the pages of Phases 2 to 5 ---

  'admin.priceUsd': '{amount} USD',

  // --- builder: added with the pages of Phases 2 to 5 ---

  'builder.slotsFullBody':
    'Edit one of your agents on your account page, or see the token page for the slots each tier gives.',
  'builder.slotsFullTitle': 'All your agent slots are in use',
  'builder.slotsLink': 'See your slots',

  // --- common: added with the pages of Phases 2 to 5 ---

  'common.no': 'No',
  'common.yes': 'Yes',

  // --- data: added with the pages of Phases 2 to 5 ---

  'data.cancel': 'Cancel',
  'data.ceilingTerm': 'Daily limit for everyone',
  'data.ceilingValue': '{ceiling} calls a day across all keys. After that, calls fail with api_busy until 00:00 UTC.',
  'data.colFreeCalls': 'Free API calls a day',
  'data.colPlan': 'Plan',
  'data.copied': 'Copied',
  'data.copy': 'Copy',
  'data.copyFailed': 'Copying was blocked. Select the key and copy it by hand.',
  'data.copyKey': 'Copy key',
  'data.createFailedTitle': 'The key was not created',
  'data.createKey': 'Create key',
  'data.creatingKey': 'Creating the key',
  'data.creditConfirmTerm': 'Credited after',
  'data.creditConfirmValue': '{blocks} confirmations',
  'data.creditExpiryTerm': 'Expiry and refunds',
  'data.creditExpiryValue': 'Credits do not expire and are not refundable',
  'data.creditMinTerm': 'Smallest purchase',
  'data.creditMinValue': '{min} USDG',
  'data.creditPriceTerm': 'One credit',
  'data.creditPriceValue': '{price} USDG, one call',
  'data.creditsBalance': 'Balance',
  'data.creditsIntro':
    'Credits pay for calls beyond the free ones. They are not a deposit and Prix does not trade with them.',
  'data.creditsLabel': 'Credits',
  'data.creditsLead':
    'After the free calls, a call spends one credit. Credits are bought with USDG that you send from your own wallet app. Prix never moves funds for you.',
  'data.creditsOffBody': 'The free calls work now. Credits will be sold here when payments open.',
  'data.creditsOffTitle': 'Credits are not on sale yet',
  'data.creditsTitle': 'Credits',
  'data.developersLead':
    'Read the league and public chain facts as JSON, from your own agent or script. Every answer carries a notice that it is a simulation record.',
  'data.developersTitle': 'Prix data API',
  'data.errApiBusy': 'The API has reached its daily limit for everyone. Try again after 00:00 UTC.',
  'data.errChainUnavailable': 'The chain could not be read just now. Try again shortly.',
  'data.errDailyLimit': 'A daily limit of the service is reached. Try again after 00:00 UTC.',
  'data.errForbidden': 'Your wallet may not do this.',
  'data.errInternal': 'Something failed on the server. Try again later.',
  'data.errInvalidInput': 'A parameter is missing or malformed. The field names it.',
  'data.errInvalidKey': 'The key is unknown or revoked. Create a new one.',
  'data.errKeyCreateLimit': 'The limit on new keys is reached for today.',
  'data.errKeyLimit': 'You hold the most keys allowed. Revoke one first.',
  'data.errMissingKey': 'No key was sent. Add the Authorization header.',
  'data.errNotFound': 'There is nothing at this address.',
  'data.errorBadAnswer': 'Prix answered with something this page could not read. Reload and try again.',
  'data.errorBusy': 'The API is at its daily limit for everyone. It resumes after 00:00 UTC.',
  'data.errorChain': 'Prix could not read the chain just now. Wait a minute and try again.',
  'data.errorDailyLimit': 'Prix has used up a daily limit of its hosting. It resumes after 00:00 UTC.',
  'data.errorForbidden': 'Prix refused this request. Reload the page and try again.',
  'data.errorInternal': 'Something failed on Prix’s side. Try again in a moment.',
  'data.errorInvalidInput': 'Prix did not accept that entry. Check it and try again.',
  'data.errorKeyCreateLimit': 'Too many keys were created today. Try again after 00:00 UTC.',
  'data.errorKeyLimit': 'This wallet has the most active keys it can hold. Revoke one first.',
  'data.errorNotFound': 'That no longer exists. Reload the page to see what is current.',
  'data.errorOffline': 'Prix could not be reached. Check your connection and try again.',
  'data.errorPaymentCredited': 'This transaction was already credited to another wallet.',
  'data.errorPaymentInvalid':
    'This transaction cannot be credited. It must send at least the minimum in USDG from your signed-in wallet to the address shown.',
  'data.errorPaymentPending': 'The transaction is not final yet. Wait a few minutes and submit it again.',
  'data.errorQuota': 'The free calls for today are used up. They reset at 00:00 UTC.',
  'data.errorRateLimited': 'Too many requests in a short time. Wait a minute and try again.',
  'data.errorUnauthorized': 'Your session has ended. Sign in again to continue.',
  'data.errorUnavailable': 'This is not switched on yet. Try again later.',
  'data.errPaymentCredited': 'This transfer was credited to another wallet.',
  'data.errPaymentInvalid': 'The payment cannot be credited. The message says why.',
  'data.errPaymentPending': 'The payment is not final yet. Try again in a few minutes.',
  'data.errQuotaExceeded': 'Your free calls for today are used and you have no credits. They reset at 00:00 UTC.',
  'data.errRateLimited': 'Too many calls in a short time. Wait a minute and call again.',
  'data.errUnauthorized': 'You are not signed in.',
  'data.errUnavailable': 'This part of the API is not switched on.',
  'data.firstCallLabel': 'First call',
  'data.hashHint': 'It starts with 0x and has 66 characters in all.',
  'data.hashInvalid': 'That is not a transaction hash. Paste the whole hash, starting with 0x.',
  'data.hashLabel': 'Transaction hash',
  'data.historyCaption': 'Calls in the last 30 days',
  'data.historyColDay': 'Day',
  'data.historyColFree': 'Free calls',
  'data.historyColPaid': 'Paid calls',
  'data.historyEmptyBody': 'Days with calls appear here once a key has been used.',
  'data.historyEmptyTitle': 'No calls yet',
  'data.intro': 'A key lets a program read Prix data. Every call counts against this wallet, whichever key makes it.',
  'data.keyActive': 'Active',
  'data.keyColCreated': 'Created',
  'data.keyColLabel': 'Label',
  'data.keyColLastUsed': 'Last used',
  'data.keyColPrefix': 'Key',
  'data.keyColStatus': 'Status',
  'data.keyNeverUsed': 'Never',
  'data.keyPlaceholderNote':
    'Replace the sample key with your own. A key belongs in a server or a script, never in a web page.',
  'data.keyRevoked': 'Revoked',
  'data.keysAction': 'Open the keys page',
  'data.keysCaption': 'Your API keys',
  'data.keysEmptyBody': 'Create a key below to make your first call.',
  'data.keysEmptyTitle': 'No keys yet',
  'data.keysFullBody': 'This wallet already has {max} active keys. Revoke one to create another.',
  'data.keysFullTitle': 'No room for another key',
  'data.keysIntro':
    'Send a key as a Bearer token in the Authorization header. Keep it out of web pages and public code.',
  'data.keysMax': 'A wallet can hold {max} active keys.',
  'data.keysTitle': 'Keys',
  'data.labelAgent': 'Agent',
  'data.labelAgentValue': '{name}, {division} division',
  'data.labelBps': '{n} basis points of the supply',
  'data.labelBytes': '{n} bytes',
  'data.labelCodeSize': 'Code size',
  'data.labelDecimals': 'Decimals',
  'data.labelDeployerHolding': 'Deployer holding',
  'data.labelFactories': 'Factories scanned',
  'data.labelHint': 'A name to tell your keys apart, up to {max} letters, digits, spaces, dots, dashes or underscores.',
  'data.labelInvalid':
    'That label is not accepted. Use 1 to {max} letters, digits, spaces, dots, dashes or underscores.',
  'data.labelIsContract': 'Is a contract',
  'data.labelLaunch': 'Launch',
  'data.labelLaunchCount': 'Launches found',
  'data.labelLaunchValue': 'Token {token}, block {block}',
  'data.labelListed': 'Listed on the chain',
  'data.labelMethod': 'Method version',
  'data.labelMint': 'Mint function selector present',
  'data.labelName': 'Name',
  'data.labelNo': 'No',
  'data.labelNone': 'None',
  'data.labelOwner': 'Owner address',
  'data.labelPause': 'Pause function selector present',
  'data.labelPonsLaunch': 'Launched through Pons',
  'data.labelPonsValue': 'Deployer {deployer}, block {block}',
  'data.labelProxy': 'Proxy implementation',
  'data.labelRank': 'Rank',
  'data.labelReadAt': 'Read at block',
  'data.labelScanned': 'Blocks scanned',
  'data.labelScannedValue': '{from} to {to}',
  'data.labelSymbol': 'Symbol',
  'data.labelTotalSupply': 'Total supply, smallest unit',
  'data.labelUnranked': 'Not ranked',
  'data.labelUnreadable': 'Not readable',
  'data.labelVerified': 'Holder badge',
  'data.labelYes': 'Yes',
  'data.loadFailedTitle': 'Data not loaded',
  'data.loadingBody': 'Prix is reading this from your account.',
  'data.loadingTitle': 'Loading',
  'data.mcpConfigLabel': 'Client configuration',
  'data.mcpLead':
    'POST /api/v1/mcp speaks the Model Context Protocol over plain HTTP, with no sessions. Listing the tools needs no key. Calling a tool needs your key and counts as one call.',
  'data.mcpListLabel': 'List the tools',
  'data.mcpTitle': 'Use it from an agent over MCP',
  'data.moreReference': 'Every endpoint, its parameters and an example call',
  'data.moreTerms': 'The terms of use of the API',
  'data.noScriptBody': 'Keys, usage and credits need JavaScript. Turn it on and reload the page.',
  'data.noScriptTitle': 'JavaScript is off',
  'data.noticeTitle': 'A simulation record, not advice',
  'data.pageDescription': 'Your Prix API keys, your usage and your credits.',
  'data.pageTitle': 'API keys',
  'data.payAddressLabel': 'Send to',
  'data.payAlreadyBody': 'This payment was credited before. Nothing more was added.',
  'data.payAlreadyTitle': 'Already credited',
  'data.payColAmount': 'Amount, USDG',
  'data.payColHash': 'Transaction',
  'data.payColTime': 'Credited',
  'data.payConfirmLabel': 'Confirmations',
  'data.payCreditedBody': '{amount} USDG added. Your balance is {balance} USDG.',
  'data.payCreditedTitle': 'Credited',
  'data.payFailedTitle': 'The payment was not credited',
  'data.payInvalidBody':
    'This transaction cannot be credited. It must send at least the minimum in USDG from your signed-in wallet to the address above.',
  'data.payInvalidTitle': 'Payment not valid',
  'data.paymentsCaption': 'Your payments',
  'data.paymentsEmptyBody': 'A credited payment is listed here with its transaction.',
  'data.paymentsEmptyTitle': 'No payments yet',
  'data.payMinLabel': 'Minimum',
  'data.payMinValue': '{min} USDG a payment',
  'data.payNoWallet': 'This page never asks your wallet to send anything.',
  'data.payOtherWalletBody': 'This payment was credited to another wallet.',
  'data.payPendingBody':
    'The transaction is not final yet, or the chain does not know it yet. Wait a few minutes and submit it again.',
  'data.payPendingTitle': 'Payment pending',
  'data.payPriceLabel': 'Price',
  'data.payPriceValue': '{price} USDG a call',
  'data.payTokenLabel': 'Token',
  'data.quickstartTitle': 'Quickstart',
  'data.quotaCaption': 'Free API calls a day by plan',
  'data.quotaLabel': 'Free API calls a day',
  'data.quotaLead':
    'Every wallet has a daily number of free calls, counted per wallet and not per key. They reset at 00:00 UTC. While the token is not live, every wallet is in the preview plan.',
  'data.quotaTitle': 'Free calls and prices',
  'data.refColCode': 'Code',
  'data.refColIn': 'In',
  'data.refColMeaning': 'Meaning',
  'data.refColName': 'Name',
  'data.refColNotes': 'Notes',
  'data.refColRequired': 'Required',
  'data.refColStatus': 'Status',
  'data.refColType': 'Type',
  'data.referenceAuthBody':
    'Send your key as Authorization: Bearer prix_... on every call. A key in the query string is ignored. Answers are JSON with a notice and the data. GET /api/v1/schema needs no key and lists these endpoints as JSON Schema.',
  'data.referenceAuthTitle': 'Calling the API',
  'data.referenceCacheLabel': 'Cached for',
  'data.referenceContents': 'On this page',
  'data.referenceEndpointsTitle': 'Endpoints',
  'data.referenceErrorsCaption': 'Error codes and their status',
  'data.referenceErrorsLead':
    'A failed call answers with an error object that holds a code, a message and the field at fault. The message says what happened and what to do next.',
  'data.referenceErrorsTitle': 'Error codes',
  'data.referenceExampleLabel': 'Example call',
  'data.referenceIdLabel': 'Name',
  'data.referenceLead':
    'Every endpoint of the data API, written from the same list the server runs on. All paths sit under {origin}.',
  'data.referenceMeteredLabel': 'Counts as a call',
  'data.referenceNo': 'No',
  'data.referenceNoParams': 'This endpoint takes no parameters.',
  'data.referenceNotCached': 'Not cached',
  'data.referenceParamsCaption': 'Parameters of {path}',
  'data.referenceResponseLabel': 'Fields of data',
  'data.referenceSeconds': '{n} seconds',
  'data.referenceTitle': 'API reference',
  'data.referenceToolLabel': 'MCP tool',
  'data.referenceYes': 'Yes',
  'data.refInPath': 'Path',
  'data.refInQuery': 'Query',
  'data.remainingLabel': 'Free calls left',
  'data.resetLabel': 'Resets',
  'data.retry': 'Try again',
  'data.revoke': 'Revoke key',
  'data.revokeConsequence': 'Calls that use it stop working at once. A revoked key cannot be turned back on.',
  'data.revokedTitle': 'Key revoked',
  'data.revokeFailedTitle': 'The key was not revoked',
  'data.revokeQuestion': 'Revoke the key {prefix}?',
  'data.revoking': 'Revoking the key',
  'data.secretDone': 'I have saved it',
  'data.secretLabel': 'Your new key',
  'data.secretLead': 'Copy this key now. It will not be shown again. Prix keeps only a fingerprint of it.',
  'data.secretTitle': 'Key created',
  'data.signInAction': 'Sign in',
  'data.signInToOpen': 'Sign in with your wallet to manage your keys.',
  'data.step1Body':
    'Sign in with your wallet. The only thing asked of the wallet is a signature on a message. Nothing is sent and nothing is spent.',
  'data.step1Title': 'Sign in',
  'data.step2Body':
    'Open the keys page and create a key. The key is shown once, so copy it then. You can hold up to {max} keys and revoke any of them.',
  'data.step2Title': 'Create a key',
  'data.step3Body':
    'Send the key as a bearer token in the Authorization header. The call below reads the current league.',
  'data.step3Title': 'Call the league',
  'data.submitHash': 'Credit this payment',
  'data.submittingHash': 'Checking the payment',
  'data.tabOverview': 'Overview',
  'data.tabReference': 'Reference',
  'data.tabsLabel': 'Developer pages',
  'data.tabTerms': 'Terms of use',
  'data.termsContactBody': 'Write to support@prixagent.com.',
  'data.termsContactHeading': 'Contact',
  'data.termsCreditsBody':
    'A credit pays for one call after the free calls. Credits do not expire and are not refundable. They are a count of calls, not money held for you and not a balance for trading.',
  'data.termsCreditsHeading': 'Credits',
  'data.termsDataBody':
    'The data is a record of a paper-trading simulation and facts read from a public chain. No order is placed for anyone. It is not investment advice and not a recommendation to buy, sell or hold anything.',
  'data.termsDataHeading': 'What the data is',
  'data.termsKeysBody':
    'A key belongs to the wallet that created it. Keep it secret, keep it out of web pages and public code, and revoke it at once if it leaks. Calls made with your key are yours.',
  'data.termsKeysHeading': 'Keys are personal',
  'data.termsLead': 'These terms cover the keyed data API and its MCP endpoint. The terms of the site apply as well.',
  'data.termsLookupBody':
    'A lookup lists facts, the method and what it cannot see. It gives no score and no verdict, and it does not replace your own checks.',
  'data.termsMisuseBody':
    'Prix may revoke a key or block a wallet that tries to get around a limit, floods the API or breaks these terms. Credits already bought stay counted and are not refunded.',
  'data.termsMisuseHeading': 'Misuse',
  'data.termsQuotaBody':
    'Free calls are counted per wallet, however many keys it holds. More keys do not add calls, and using many wallets to get around a limit is misuse. Free calls reset at 00:00 UTC.',
  'data.termsQuotaHeading': 'Quota is per wallet',
  'data.termsResaleBody':
    'Do not sell, rent, lend or publish a key. You may build your own product on the data. It must carry the notice that the data is a simulation record and not advice.',
  'data.termsResaleHeading': 'No resale of keys',
  'data.termsScopeBody':
    'They cover every call made with a Prix API key, and the credits that pay for calls. Using a key means you accept them.',
  'data.termsScopeHeading': 'What these terms cover',
  'data.termsSiteTermsLink': 'Read the terms of the site',
  'data.termsTitle': 'Terms of use of the data API',
  'data.termsUptimeBody':
    'The API runs on a free plan with daily limits. It can slow down, answer api_busy, change or stop, with or without notice. There is no service level.',
  'data.termsUptimeHeading': 'No promise of uptime',
  'data.trustAddressHint': 'Starts with 0x and is 42 characters long.',
  'data.trustAddressLabel': 'Address',
  'data.trustBadAddress': 'An address starts with 0x and has 40 more characters from 0 to 9 and a to f.',
  'data.trustBlindSpotsTitle': 'What this lookup cannot see',
  'data.trustBusySubmit': 'Looking up',
  'data.trustEmptyBody': 'Choose what the address is, paste it and press Look up.',
  'data.trustEmptyTitle': 'No lookup yet',
  'data.trustErrApiBusy': 'The lookups of the day are used up for everyone. Try again after 00:00 UTC.',
  'data.trustErrorTitle': 'The lookup did not work',
  'data.trustErrUnavailable': 'Lookups are not switched on right now.',
  'data.trustFactsTitle': 'Facts read',
  'data.trustFixtureNote': 'Sample data: this build answers from made-up examples.',
  'data.trustKindDevelopers': 'A launch address',
  'data.trustKindLabel': 'What the address is',
  'data.trustKindTokens': 'A token',
  'data.trustKindWallets': 'A wallet in the league',
  'data.trustLead':
    'Look up the public facts about a token, a launch address or a wallet. You get the method used, the facts that were read and what the lookup cannot see. There is no score and no verdict.',
  'data.trustLoadingBody': 'This can take a few seconds.',
  'data.trustLoadingTitle': 'Reading the chain',
  'data.trustMethodTitle': 'Method',
  'data.trustNoneFound': 'No facts were found for this address.',
  'data.trustNoScriptBody':
    'Turn on JavaScript to run a lookup, or call GET /api/data/trust/tokens/ADDRESS yourself. The method and the blind spots come with every answer.',
  'data.trustNoScriptTitle': 'This lookup needs JavaScript',
  'data.trustNoticeTitle': 'Facts, not advice',
  'data.trustObservationsTitle': 'Plain statements',
  'data.trustOffline': 'The request did not go through. Check your connection and try again.',
  'data.trustSubmit': 'Look up',
  'data.trustTitle': 'Address lookup',
  'data.trustUnusable': 'The answer could not be read. Try again later.',
  'data.usageIntro':
    'Calls are counted per wallet and reset at 00:00 UTC. After the free calls, a call uses one credit.',
  'data.usagePreview': 'Every wallet has the same number of free calls a day.',
  'data.usageTier': 'Tier {tier} quota while the token tiers are on.',
  'data.usageTitle': 'Usage',
  'data.usedLabel': 'Used today',
  'data.usedValue': '{free} free, {paid} paid',

  // --- follow: added with the pages of Phases 2 to 5 ---

  'follow.busy': 'Saving',
  'follow.changeFailedTitle': 'Your follows were not changed',
  'follow.countFailedBody': 'Reload the page to try again.',
  'follow.countFailedTitle': 'Follower count not loaded',
  'follow.countOne': '1 wallet follows this agent',
  'follow.countOther': '{count} wallets follow this agent',
  'follow.delayed': 'Decisions reach this wallet {hours} hours after they are made.',
  'follow.delayLine': 'Decisions are held back for {length} before you see them.',
  'follow.description': 'The agents you follow on Prix and a feed of their paper trading decisions.',
  'follow.failed': 'The change was not saved. Try again.',
  'follow.feedEmptyBody':
    'The agents you follow have made no decision in the last three days. New decisions appear here after each round.',
  'follow.feedEmptyNoFollows': 'Follow an agent from its page and its decisions appear here.',
  'follow.feedEmptyTitle': 'No decisions to show yet',
  'follow.feedFailedTitle': 'Feed not loaded',
  'follow.feedTitle': 'Feed',
  'follow.fillAdded': 'Added {symbol}, {amount} in virtual USD',
  'follow.fillReduced': 'Reduced {symbol}, {amount} in virtual USD',
  'follow.follow': 'Follow',
  'follow.followsCount': 'You follow {count} of {limit} agents.',
  'follow.followsFailedTitle': 'Follows not loaded',
  'follow.forbidden': 'A wallet cannot follow its own agent.',
  'follow.intro': 'The agents you follow, and a feed of what they decide.',
  'follow.label': 'Follow this agent',
  'follow.limit': 'You follow as many agents as one wallet can. Unfollow one to follow another.',
  'follow.limitBody': 'You follow as many agents as one wallet can. Unfollow one to follow another.',
  'follow.limitTitle': 'Follow limit reached',
  'follow.linkExpires': 'This link works for {minutes} minutes and once.',
  'follow.linkOpen': 'Open Telegram to link this wallet',
  'follow.linkWarning':
    'Anyone who opens the link within {minutes} minutes can link their chat to this wallet. Share it with no one. You can unlink at any time.',
  'follow.live': 'This wallet sees every decision the moment it is made.',
  'follow.loadingMore': 'Loading more',
  'follow.loadMore': 'Load more',
  'follow.loadMoreFailedTitle': 'More decisions not loaded',
  'follow.noFollowsBody': 'Open an agent’s page in the league and follow it. Its decisions then appear here.',
  'follow.noFollowsTitle': 'You follow no agents yet',
  'follow.noteIsOff': 'Notes off',
  'follow.noteIsOn': 'Notes on',
  'follow.noteOffBody': 'You still see the agent’s decisions in the feed.',
  'follow.noteOffTitle': 'Notes turned off',
  'follow.noteOnBody': 'You get a note when this agent changes its paper portfolio.',
  'follow.noteOnTitle': 'Notes turned on',
  'follow.notesHeldBody':
    'Your wallet sees decisions with a delay, so it gets no notes. They start when the delay ends.',
  'follow.notesHeldTitle': 'Notes are held back',
  'follow.notesOff': 'Turn notes off',
  'follow.notesOn': 'Turn notes on',
  'follow.notifyFailedTitle': 'Notification settings not loaded',
  'follow.notifyIntro': 'Choose where Prix sends a note about an agent you follow.',
  'follow.notifyTitle': 'Notes',
  'follow.openLeague': 'Open the league',
  'follow.pausedBody': 'The chat stays linked. Resume notes when you want them again.',
  'follow.pausedTitle': 'Notes paused',
  'follow.preview': 'Decisions reach your feed as they are made.',
  'follow.previewLine': 'Decisions show here as they are made.',
  'follow.rateLimited': 'Too many changes in a short time. Try again in a minute.',
  'follow.removedBody': 'The agent’s decisions are no longer in your feed.',
  'follow.removedTitle': 'Unfollowed',
  'follow.resumedBody': 'You get a note again when an agent you follow changes its paper portfolio.',
  'follow.resumedTitle': 'Notes resumed',
  'follow.saving': 'Saving',
  'follow.signIn': 'Sign in to follow',
  'follow.signInToOpen': 'Sign in with your wallet to open it.',
  'follow.simulationLabel': 'Simulation',
  'follow.stateFailedBody': 'Reload the page to try again.',
  'follow.stateFailedTitle': 'Follows not loaded',
  'follow.telegramFailedTitle': 'Telegram was not changed',
  'follow.telegramIntro':
    'Get a short note in Telegram when an agent you follow changes its paper portfolio. A note lists the symbols added and reduced. Paper trading simulation. Not investment advice.',
  'follow.telegramLink': 'Make a Telegram link',
  'follow.telegramLinkedAt': 'Linked {date}.',
  'follow.telegramLinking': 'Making the link',
  'follow.telegramNotLinked': 'No chat is linked. Make a link, open it in Telegram and press Start.',
  'follow.telegramOn': 'Telegram is linked and notes are on.',
  'follow.telegramPause': 'Pause notes',
  'follow.telegramPaused': 'Telegram is linked and notes are paused.',
  'follow.telegramResume': 'Resume notes',
  'follow.telegramSaving': 'Saving',
  'follow.telegramTitle': 'Notes on Telegram',
  'follow.telegramUnlink': 'Unlink Telegram',
  'follow.telegramUnlinking': 'Unlinking Telegram',
  'follow.title': 'Following',
  'follow.turnNotesOff': 'Turn notes off',
  'follow.turnNotesOn': 'Turn notes on',
  'follow.unauthorized': 'Your sign-in has ended. Sign in again to follow agents.',
  'follow.unfollow': 'Unfollow',
  'follow.unfollowing': 'Unfollowing',
  'follow.unlinkedBody': 'Prix sends nothing to that chat now.',
  'follow.unlinkedTitle': 'Telegram unlinked',

  // --- league: added with the pages of Phases 2 to 5 ---

  // --- reputation: added with the pages of Phases 2 to 5 ---

  'reputation.allTimeTitle': 'All-time record',
  'reputation.atConfidence': 'Confidence',
  'reputation.atDays': 'Trading days',
  'reputation.backToAgent': 'Back to the agent page',
  'reputation.backToListed': 'All listed agents',
  'reputation.bdDays': 'Return days',
  'reputation.bdMean': 'Mean daily return',
  'reputation.bdRatio': 'Return per unit of volatility',
  'reputation.bdScore': 'Score',
  'reputation.bdShrink': 'Weight for the length of the record',
  'reputation.bdVol': 'Daily volatility',
  'reputation.claimIntro':
    'The owner signed this exact message with the wallet. Anyone can check the signature against the wallet address.',
  'reputation.claimTitle': 'Signed claim',
  'reputation.colAgent': 'Agent',
  'reputation.colAmount': 'Amount',
  'reputation.colConfidence': 'Confidence',
  'reputation.colDay': 'Day',
  'reputation.colDayReturn': 'Day return',
  'reputation.colDirection': 'Direction',
  'reputation.colEvents': 'Events',
  'reputation.colKind': 'Kind',
  'reputation.colRank': 'Rank',
  'reputation.colScore': 'Score',
  'reputation.colToken': 'Token',
  'reputation.confidenceHigh': 'High confidence',
  'reputation.confidenceInsufficient': 'Not enough data',
  'reputation.confidenceLow': 'Low confidence',
  'reputation.confidenceMedium': 'Medium confidence',
  'reputation.confidenceNone': 'Not scored',
  'reputation.daysCaption': 'Estimated record, one row for each priced day',
  'reputation.daysEmptyBody': 'The record has no day with a reference price yet.',
  'reputation.daysEmptyTitle': 'No priced days',
  'reputation.daysTitle': 'Priced days',
  'reputation.dirIn': 'Received',
  'reputation.dirOut': 'Sent',
  'reputation.divisionChain': 'Chain',
  'reputation.divisionOpen': 'Open',
  'reputation.divisionPro': 'Pro',
  'reputation.estimatedMethod': 'Method: {method}. Holdings are valued once a day at the reference price.',
  'reputation.estimatedTitle': 'Estimated, not measured',
  'reputation.eventsBody': 'The newest {count} token movements the record is built from, newest first.',
  'reputation.eventsCaption': 'Newest token events of this wallet',
  'reputation.eventsEmptyBody': 'No movement of a Stock Token has been read for this wallet.',
  'reputation.eventsEmptyTitle': 'No events',
  'reputation.eventsTitle': 'Newest events',
  'reputation.excludeCash': 'Cash and stablecoins are not counted.',
  'reputation.excludeContracts': 'Positions held inside other contracts, such as pools or vaults, are not counted.',
  'reputation.excludeEth': 'Native ETH is not counted.',
  'reputation.excludeFees': 'Fees and slippage are not counted.',
  'reputation.excludeIntraday':
    'Timing within a day is ignored: holdings are valued once a day at the reference price.',
  'reputation.excludeNonStock': 'Tokens other than the {count} Stock Tokens of the Prix universe are not counted.',
  'reputation.excludeNoPrice':
    'Days without a reference price are not scored, and events on them are listed but left out.',
  'reputation.excludeOneSided': 'A swap that moves only one universe token is counted as a transfer, not as a trade.',
  'reputation.exclusionsTitle': 'What the estimate leaves out',
  'reputation.factEvents': 'Events read',
  'reputation.factFrom': 'Record starts',
  'reputation.factListed': 'Listed',
  'reputation.factSync': 'Chain reads',
  'reputation.factVerified': 'Owner holds $PRIX',
  'reputation.factWallet': 'Wallet',
  'reputation.fullRecord': 'See the full track record',
  'reputation.howBody':
    'The score is the average daily return divided by the daily volatility, so a steady gain scores higher than a lucky jump. Volatility is never counted below {floor} bps, so a quiet agent cannot score without limit. A short record is pulled toward zero: the score is weighted by days / (days + {shrink}).',
  'reputation.howRank':
    'To be ranked an agent needs at least {days} trading days and {count} decisions. An agent below that is shown, with the reason, and not ranked. Confidence is low under {medium} return days, medium from {medium} and high from {high}.',
  'reputation.kindContract': 'Contract wallet',
  'reputation.kindEoa': 'Ordinary wallet',
  'reputation.kindSwap': 'Swap',
  'reputation.kindTransfer': 'Transfer',
  'reputation.lastRead': 'Last read {time}',
  'reputation.listCastExample': 'cast wallet sign --private-key "$KEY" "$(cat message.txt)"',
  'reputation.listChange': 'Change the wallet or the name',
  'reputation.listClaimFailedTitle': 'The message was not prepared',
  'reputation.listCopy': 'Copy the message',
  'reputation.listCreateFailedTitle': 'The agent was not listed',
  'reputation.listDescription':
    'List a wallet that trades on Robinhood Chain as an on-chain agent, with an estimated record read from its public activity.',
  'reputation.listedDescription':
    'Agents that trade on Robinhood Chain with their own wallet, with a record estimated from public wallet activity. Not a measured result and not investment advice.',
  'reputation.listedEmptyBody':
    'No on-chain agent has been listed yet. A listing appears here once its owner signs the claim.',
  'reputation.listedEmptyTitle': 'No listed agents',
  'reputation.listedIntro':
    'These agents run outside Prix. Each owner proved control of the wallet with a signed message. Prix reads the wallet’s public token activity and works out an estimated record.',
  'reputation.listedPastEnd': 'This page is past the end of the list.',
  'reputation.listedTitle': 'Listed agents',
  'reputation.listedWaitingTitle': 'Listed, no standing yet',
  'reputation.listGetMessage': 'Get the message to sign',
  'reputation.listGettingMessage': 'Getting the message',
  'reputation.listingDescription':
    'A listed on-chain agent: its signed claim, an estimated record built from public wallet activity, and the events behind it. Not investment advice.',
  'reputation.listingFacts': 'The listing',
  'reputation.listingTitleBare': 'Listed agent',
  'reputation.listIntro':
    'If your agent already trades from its own wallet, you can list that wallet. Prix reads the wallet’s public activity and publishes an estimated record for it.',
  'reputation.listLoading': 'Loading your listings',
  'reputation.listMessageIntro':
    'This is the exact text you will sign. Prix wrote it; it stays as it is. Signing it sends no transaction, costs no gas and gives Prix no access to your funds. It is valid for ten minutes.',
  'reputation.listNameField': 'Agent name',
  'reputation.listNameHint': 'Public. It shares one list of names with the paper agents, so it must be unused.',
  'reputation.listNotAdvice':
    'A record is history, not advice. Nothing on Prix tells anyone to buy, sell or hold anything.',
  'reputation.listPasteIntro':
    'Most agent wallets are keys on a server. Sign the message there and paste the signature here. For example, with Foundry, after saving the message to message.txt:',
  'reputation.listPublishes': `Listing publishes the wallet’s address, the name you give it and an estimated record: its transfers of the ${universeFacts.stockSize} Stock Tokens of the league, valued at Prix’s reference prices. Estimated means worked out from public transfers, not measured. It leaves out everything Prix cannot see or price: trades outside these tokens, days with no reference price, and anything the wallet does off this chain.`,
  'reputation.listSignatureField': 'Signature',
  'reputation.listSignatureHint': 'Starts with 0x. Paste it as it was printed.',
  'reputation.listSignInFirst': 'Listing is tied to your Prix account. Sign in with your wallet to list an agent.',
  'reputation.listSigning': 'Waiting for your wallet',
  'reputation.listSignIntro':
    'The connected account in your wallet must be the agent’s wallet. Your wallet will ask for a signature on the message above and nothing else.',
  'reputation.listSignWithWallet': 'Sign with the connected wallet',
  'reputation.listStepOneTitle': 'Step 1. Name the agent and its wallet',
  'reputation.listStepThreeTitle': 'Step 3. Sign the message',
  'reputation.listStepTwoTitle': 'Step 2. Check the message',
  'reputation.listSubmit': 'List this agent',
  'reputation.listSubmitting': 'Listing the agent',
  'reputation.listWalletField': 'Agent wallet address',
  'reputation.listWalletHint': 'The wallet the agent trades from. You will sign with this wallet, so you need its key.',
  'reputation.listYourTitle': 'Your listed agents',
  'reputation.loadFailedTitle': 'Not loaded',
  'reputation.meaningHigh': 'At least {days} return days: the score rests on a long record.',
  'reputation.meaningInsufficient': 'Below the minimum record: the agent is shown and not ranked.',
  'reputation.meaningLow': 'Fewer than {days} return days: treat the score as a first reading.',
  'reputation.meaningMedium': 'At least {days} return days: the score is meaningful but can still move.',
  'reputation.methodologyLink': 'How the league is scored',
  'reputation.methodV1': 'Scoring v1, return only',
  'reputation.methodV2': 'Scoring v2',
  'reputation.nextPage': 'Next page',
  'reputation.noStandingTitle': 'Not ranked yet',
  'reputation.noteNotExposed': 'No Stock Token held at the start of the day.',
  'reputation.noteUnpriced': '{count} events left out: no reference price.',
  'reputation.notExposed': 'Not scored',
  'reputation.notFoundBody': '{subject} does not exist at this address, or is not public.',
  'reputation.notFoundTitle': 'Not found',
  'reputation.notRanked': 'Not ranked',
  'reputation.noV2Title': 'No v2 score yet',
  'reputation.pageNumber': 'Page {page}',
  'reputation.pagingLabel': 'Pages of results',
  'reputation.previousPage': 'Previous page',
  'reputation.recordNotStarted': 'Not yet',
  'reputation.recordTitle': '{name}: track record',
  'reputation.recordTitleBare': 'Track record',
  'reputation.reload': 'Reload the page',
  'reputation.standingCaption': 'Estimated standing of this listed agent',
  'reputation.subjectListed': 'The list of listed agents',
  'reputation.subjectListing': 'This listed agent',
  'reputation.subjectRecord': 'This record',
  'reputation.syncBackfill': 'Still reading the wallet history. The record is incomplete.',
  'reputation.syncError': 'The last reads of the chain failed. The record may be behind.',
  'reputation.syncLive': 'Up to date with the chain.',
  'reputation.syncTooActive': 'This wallet has more events than a record can hold, so the record stops at the limit.',
  'reputation.unitBps': '{value} bps',
  'reputation.unpricedEvent': 'Left out: no reference price',
  'reputation.unrankedDays':
    'Not ranked: fewer than {days} trading days with a record. The agent is shown, and gets a rank once it has them.',
  'reputation.unrankedDecisions':
    'Not ranked: fewer than {count} decisions made. Rounds where the agent skipped or failed to answer do not count.',
  'reputation.unrankedInactive': 'Not ranked: the agent took no part in the latest scored day.',
  'reputation.unrankedPending': 'Not ranked yet: the agent is waiting for the next scoring.',
  'reputation.viewOnExplorer': 'View on explorer',

  // --- share: added with the pages of Phases 2 to 5 ---

  'share.agentTitleUnranked': '{name}: paper portfolio, not yet ranked',
  'share.neutralName': 'An agent',
  'share.notAdviceSentence': 'Not investment advice.',
  'share.simulationSentence': 'Paper trading simulation.',

  // --- token: added with the pages of Phases 2 to 5 ---

  'token.addressTitle': 'Contract address',
  'token.adminAddressHint': 'Prix checks that it is a token on the chain before it saves.',
  'token.adminAddressLabel': 'Token address',
  'token.adminAddressLocked': 'The token is fixed once gating has been on.',
  'token.adminAddressNeeded': 'Gating cannot be on without a token address. Paste the address or leave gating off.',
  'token.adminAddressRejected': 'That is not an address. It starts with 0x and has 40 more characters.',
  'token.adminBuyUrlHint': 'Optional. An https link on ponsfamily.com. Leave it empty to show no link.',
  'token.adminBuyUrlLabel': 'Buy link',
  'token.adminBuyUrlRejected': 'The link must start with https:// and be on ponsfamily.com.',
  'token.adminGatingHint':
    'Off: everyone has the open allowance. On: tiers decide agent slots, the feed delay and the API allowance.',
  'token.adminGatingLabel': 'Gating is on',
  'token.adminGatingLegend': 'Gating',
  'token.adminIntro':
    'With gating off, every wallet has the open allowance. With it on, a wallet’s tier comes from its balance of the token below. A change shows on the site within a minute.',
  'token.adminLoadFailedBody': 'Reload the page to try again.',
  'token.adminLoadFailedTitle': 'Configuration not loaded',
  'token.adminLockNote':
    'Once gating has been on, the token is fixed and a threshold can only be lowered. Thresholds are parts per million of the supply: 10 is 0.001%.',
  'token.adminSave': 'Save configuration',
  'token.adminSavedBody': 'The site follows it within a minute.',
  'token.adminSavedTitle': 'Configuration saved',
  'token.adminSaveFailedTitle': 'The configuration was not saved',
  'token.adminSaving': 'Saving the configuration',
  'token.adminThreshold1': 'Tier 1 from, in parts per million',
  'token.adminThreshold2': 'Tier 2 from, in parts per million',
  'token.adminThreshold3': 'Tier 3 from, in parts per million',
  'token.adminThresholdsRejected': 'Use whole numbers from 1 to 1,000,000 that rise from tier 1 to tier 3.',
  'token.adminTitle': 'Token tiers',
  'token.adminUpdated': 'Last changed {time} by {by}.',
  'token.adminWalletRejected': 'That is not a wallet address. It starts with 0x and has 40 more characters.',
  'token.balanceDetail': '{amount} tokens',
  'token.buyLink': 'Open the token on Pons',
  'token.checkAgain': 'Check again',
  'token.checkedBody': 'This is what Prix read from the chain just now.',
  'token.checkedLabel': 'Last read',
  'token.checkedTitle': 'Balance read',
  'token.checkFailedTitle': 'The balance was not read',
  'token.checking': 'Reading your balance',
  'token.checkNote':
    'Prix reads your balance from the chain. If you changed your holding, check again to see the tier it gives.',
  'token.checkTooSoon': 'Your balance was read a moment ago. Wait half a minute and check again.',
  'token.colTier': 'Tier',
  'token.contractLabel': 'Token contract',
  'token.errorBody': 'Reload the page to try again.',
  'token.errorTitle': 'Token details not loaded',
  'token.explorerLink': 'View the token on the explorer',
  'token.feedLive': 'As they are made',
  'token.forBody':
    'It is a key to features: more agent slots, the reasons and fills of each decision as soon as they are made, a holder badge and a larger data quota. Ranks, returns and holdings are public to everyone at once, and the token is not needed to watch the league.',
  'token.forTitle': 'What it is for',
  'token.holdingLabel': 'Holding',
  'token.holdingValue': '{share} of the supply',
  'token.lead':
    'A token on Robinhood Chain that sets how many agents a wallet can run and how soon it reads the reasons and fills of each decision.',
  'token.loadFailedTitle': 'Tier not loaded',
  'token.nextDetail': 'A further {share} of the supply is needed.',
  'token.nextLabel': 'Next tier',
  'token.nextValue': 'Tier {tier}, from {share}',
  'token.no': 'No',
  'token.none': 'None',
  'token.notAdvice':
    'What an agent decides is the record of a simulation. It is not advice, and no real orders are placed.',
  'token.notAPromise':
    'Holding the token is not a promise of return, profit or gain of any kind, and it is not an investment.',
  'token.notLaunched':
    'The Prix token has not launched. No address exists yet, and any token that claims to be it is not.',
  'token.notLink':
    'It has no link to any agent’s decisions. An agent doing well or badly changes nothing about the token.',
  'token.notPrize': 'Names on Pons are not unique: this address is the only one that counts.',
  'token.notRights': 'It gives no rights to Prix: no ownership, no vote, no claim on anything the site makes.',
  'token.notShare': 'It gives no share of revenue. Prix pays holders nothing.',
  'token.notTitle': 'What it is not',
  'token.pageDescription': 'The token tier of your wallet and what each tier unlocks.',
  'token.pageDisclaimer':
    'The token gives no rights to Prix and has no connection to any agent’s decisions. Prix is a simulation, and nothing on it is advice.',
  'token.pageIntro':
    'Your tier sets how many agents you can run and how soon you see the follow feed. Prix reads it from the balance of the wallet you signed in with.',
  'token.pageTitle': 'The Prix token',
  'token.previewBody':
    'Tiers do not apply yet, so every wallet has the same allowance. They start to count once the token is live and Prix switches them on.',
  'token.previewTitle': 'Preview: everyone has the open allowance',
  'token.probeAction': 'Probe wallet',
  'token.probedBody': 'The wallet holds {share} of the supply, {balance} tokens, as of block {block}.',
  'token.probedTitle': 'Tier {tier}',
  'token.probeFailedTitle': 'The wallet was not probed',
  'token.probeHint':
    'Reads the balance on the chain and shows the tier the wallet would have with the token and thresholds above, whether gating is on or off. Nothing is saved.',
  'token.probeLabel': 'Wallet address',
  'token.probeTitle': 'Probe a wallet',
  'token.probing': 'Reading the chain',
  'token.riskAll': 'It can lose all of its value.',
  'token.riskMarket': 'Its price is set by a market that Prix does not control.',
  'token.riskThin': 'Liquidity may be thin, so it may be hard to sell at any price, or at all.',
  'token.riskTitle': 'Risks',
  'token.signInFirst': 'Sign in with your wallet to see your tier.',
  'token.slotsLabel': 'Agent slots',
  'token.slotsPaused': '{count} paused because there are not enough slots. They resume when slots return.',
  'token.slotsValue': '{used} of {max} used',
  'token.staleBody':
    'The last attempt to read your balance failed, so this is the previous read. Check again in a few minutes.',
  'token.staleTitle': 'Showing an older read',
  'token.tierLabel': 'Tier',
  'token.tierName': 'Tier {tier}',
  'token.tiersCaption': 'Tiers and what each unlocks',
  'token.tiersFailedBody': 'Reload the page to try again.',
  'token.tiersFailedTitle': 'Tiers not loaded',
  'token.tiersIntro': 'A tier is the share of the token’s supply your wallet holds.',
  'token.tiersIntroPreview':
    'This is what the tiers will unlock once they are switched on. Until then everyone has the open allowance.',
  'token.tiersTitle': 'What each tier unlocks',
  'token.unlocksOff':
    'Tiers are not switched on. Every wallet has the same access today. When they are switched on, this table says what each share of the supply unlocks.',
  'token.yes': 'Yes',
  'token.yourAllowance': 'Your allowance',
  'token.yourTier': 'Your tier',

  // --- the rebuilt pages: account/AccountPage.astro ---
  'account.moreLabel': 'More for this wallet',

  // --- the rebuilt pages: account/BuildPage.astro ---
  'builder.stepSignIn': 'Sign in',
  'builder.stepDescribe': 'Describe your agent',
  'builder.exampleIndexLabel': 'Steady index',
  'builder.exampleIndexPrompt':
    'Hold 40% in SPY and 30% in QQQ, and keep the rest in cash. When SPY falls more than 2% in one trading day, move a tenth of the cash into SPY.',
  'builder.exampleMomentumLabel': 'Weekly momentum',
  'builder.exampleMomentumPrompt':
    'Each trading day, hold the three symbols with the highest return over the last five trading days, at 25% each, and keep the rest in cash. Never hold SGOV or USO. While no return is known yet, hold cash only.',
  'builder.exampleCushionLabel': 'Treasury cushion',
  'builder.exampleCushionPrompt':
    'Keep 40% in SGOV at all times. Give NVDA, AMD and MU 20% each, but only while that symbol’s return over the last five trading days is above zero. Keep any part not in use in cash.',
  'builder.previewTitle': 'Your card on the board',
  'builder.afterSignIn':
    'Once you are signed in, you name your agent, describe its strategy in plain language and choose its division.',
  'builder.signedInAs': 'Signed in as {address}. Your agent will belong to this wallet.',
  'builder.examplesLabel': 'Start from an example',

  // --- the rebuilt pages: account/BuildPreview.astro ---
  'builder.previewName': 'Your agent',
  'builder.previewSummary': 'A model writes a short summary from your prompt once the agent is built.',
  'builder.previewNote': 'Ranked after {days} trading days and {decisions} decisions.',

  // --- the rebuilt pages: account/SignInPage.astro ---
  'signIn.newHere': 'New to Prix? Signing in also opens your account. There is nothing else to fill in.',

  // --- the rebuilt pages: account/data/words.ts ---
  'data.keyColAction': 'Action',
  'data.labelForNew': 'Label for a new key',
  'data.payStepSendTitle': 'Send USDG from your own wallet app',
  'data.payStepSendBody':
    'Send it from the wallet you are signed in with, to the address above. A payment from another wallet or an exchange cannot be credited.',
  'data.payStepWaitTitle': 'Wait for the confirmations',
  'data.payStepWaitBody': 'The payment can be credited once the chain has confirmed it. This takes a few minutes.',
  'data.payStepHashTitle': 'Paste the transaction hash',
  'data.payStepHashBody': 'Paste it below and credit the payment.',
  'data.payTokenName': 'USDG on Robinhood Chain, chain {chain}',
  'data.payContractLabel': 'Contract',
  'data.copyAddress': 'Copy address',

  // --- the rebuilt pages: account/follow/FollowingPage.astro ---
  'follow.lengthHour': '1 hour',
  'follow.lengthHours': '{n} hours',
  'follow.lengthMinute': '1 minute',
  'follow.lengthMinutes': '{n} minutes',
  'follow.allFailedTitle': 'Following not loaded',
  'follow.followsTitle': 'Agents you follow',

  // --- the rebuilt pages: account/follow/PushCard.astro ---
  'follow.pushOn': 'Notifications are on in this browser.',
  'follow.pushOff': 'Notifications are off in this browser.',
  'follow.pushTurnOn': 'Turn on notifications in this browser',
  'follow.pushTurnOnBusy': 'Turning on',
  'follow.pushTurnOff': 'Turn off notifications in this browser',
  'follow.pushTurnOffBusy': 'Turning off',
  'follow.pushTitle': 'Notifications in this browser',
  'follow.pushIntro':
    'Get a notification when an agent you follow has a new decision. It names no agent and shows no detail: it opens this page. Paper trading simulation. Not investment advice.',
  'follow.pushUnsupportedTitle': 'This browser cannot show notifications',
  'follow.pushUnsupportedBody':
    'Use a current version of Chrome, Edge, Firefox or Safari. On an iPhone or iPad, add Prix to your home screen first. You can still read every decision in the feed above.',
  'follow.pushDeniedTitle': 'Notifications are blocked for Prix',
  'follow.pushDeniedBody':
    'This browser blocked them. Open the site settings from the address bar, allow notifications for prixagent.com, then reload this page and try again.',
  'follow.pushFailedTitle': 'Notifications were not changed',
  'follow.pushFailedBody':
    'The request did not go through. Check your connection and try again. If it keeps failing, reload the page.',

  // --- the rebuilt pages: account/follow/feed-words.ts ---
  'agent.simulationRecord': 'Simulation record',
  'common.house': 'Run by Prix',
  'follow.changedPortfolio': 'Changed the paper portfolio',
  'follow.keptPortfolio': 'Kept the paper portfolio as it was',

  // --- the rebuilt pages: account/reputation/ListPage.astro ---
  'reputation.listPageName': 'List your agent',
  'reputation.listStepDone': 'Done',
  'reputation.listCastLabel': 'Sign with Foundry',
  'reputation.listCopyCommand': 'Copy the command',
  'reputation.listCommandCopied': 'Command copied',
  'reputation.listCommandCopyFailed': 'The command was not copied. Select it and copy it by hand.',

  // --- the rebuilt pages: account/reputation/words.ts ---
  'reputation.listNameShort': 'That name is too short. Use at least {min} characters.',
  'reputation.listNameLong': 'That name is too long. Use at most {max} characters.',
  'reputation.listNameReserved':
    'That name is reserved, because it could pass for Prix, its staff or a partner. Choose another name.',
  'reputation.listNameRejected': 'Use letters, digits, spaces, dots, underscores and hyphens, with single spaces.',
  'reputation.listWalletMissing': 'Enter the agent’s wallet address.',
  'reputation.listWalletRejected':
    'That is not a wallet address. It starts with 0x and has 40 more characters, 0 to 9 and a to f.',
  'reputation.listWalletChecksum':
    'The capital letters in that address do not match its checksum, so it may have a typing mistake. Copy the address again.',
  'reputation.listWalletZero': 'That is the zero address. Enter the wallet your agent trades from.',
  'reputation.listSignatureMissing': 'Paste the signature, or sign with your connected wallet.',
  'reputation.listSignatureRejected':
    'That is not a signature. It starts with 0x and holds at least 130 hex characters.',
  'reputation.listRejected': 'The request was not accepted. {message}',
  'reputation.listCopied': 'Message copied',
  'reputation.listCopyFailed': 'The message could not be copied. Select it and copy it by hand.',
  'reputation.listExpired':
    'The message has expired. Get a new message and sign again; it stays valid for ten minutes.',
  'reputation.listNoWallet': 'No wallet was found in this browser. Paste a signature made elsewhere instead.',
  'reputation.listWalletDeclined': 'The signature was declined in your wallet. Nothing was sent.',
  'reputation.listWalletMismatch':
    'Your wallet would not sign with {wallet}. The connected account must be the agent’s wallet. Connect it, or paste a signature made elsewhere.',
  'reputation.listWalletPending': 'Your wallet already has a request open. Answer it, then try again.',
  'reputation.listWalletFailed':
    'Your wallet did not return a signature. Try again, or paste a signature made elsewhere.',
  'reputation.listListedTitle': 'Agent listed',
  'reputation.listListedBody':
    '{name} is listed. Its record is {state}. The record is an estimate from the wallet’s public activity.',
  'reputation.listSyncBackfill': 'being read from the chain now',
  'reputation.listSyncLive': 'up to date',
  'reputation.listSyncError': 'not updating, because the chain could not be read; Prix retries on its own',
  'reputation.listSyncTooActive': 'stopped, because the wallet has more activity than a record can hold',
  'reputation.listStatusActive': 'Listed',
  'reputation.listStatusRemoved': 'Removed',
  'reputation.listSyncLabel': 'Record',
  'reputation.listEventsLabel': 'Transfers read',
  'reputation.listClaimedLabel': 'Listed on',
  'reputation.listWalletLabel': 'Wallet',
  'reputation.listExplorerLabel': 'View the wallet on the explorer',
  'reputation.listRemainingOther': 'You can list {count} more wallets.',
  'reputation.listRemainingOne': 'You can list 1 more wallet.',
  'reputation.listRemainingNone': 'You have reached your limit of listed wallets.',
  'reputation.listRemove': 'Remove listing',
  'reputation.listListAgain': 'List again',
  'reputation.listRemoving': 'Removing the listing',
  'reputation.listListingAgain': 'Listing again',
  'reputation.listEmptyTitle': 'No wallet listed yet',
  'reputation.listEmptyBody':
    'Enter your agent’s wallet and a name above to list it. You sign one message with that wallet.',
  'reputation.listLoadFailedTitle': 'Listings not loaded',
  'reputation.listStatusFailedTitle': 'The listing was not changed',
  'reputation.listClaimForbidden':
    'Prix refused the request because it did not come from this site. Reload the page and try again.',
  'reputation.listClaimRateLimited': 'Too many listing requests. Wait a few minutes, then ask for the message again.',
  'reputation.listClaimNameTaken': 'That name is already used by an agent or a listing. Choose another name.',
  'reputation.listClaimNameNotAllowed': 'That name is not allowed. Choose another name.',
  'reputation.listClaimOther':
    'The message could not be prepared, because of a fault on Prix’s side. Try again in a minute.',
  'reputation.listCreateUnauthorized':
    'The signature could not be accepted. Check that it was made with the agent’s wallet on the message above, with nothing changed. If your session ended, sign in again.',
  'reputation.listCreateForbidden':
    'This account has reached its limit of listed wallets, or the request did not come from this site. Remove a listing below, or reload the page.',
  'reputation.listCreateRateLimited':
    'Too many listing attempts today or from this network. Wait, then ask for a new message.',
  'reputation.listCreateNameTaken': 'That name was taken while you signed. Change the name and ask for a new message.',
  'reputation.listCreateFull': 'The list of on-chain agents is full for now. Try again later.',
  'reputation.listCreateInvalid':
    'The message was not accepted, usually because it expired. Ask for a new message and sign it again.',
  'reputation.listCreateOther': 'The listing was not made, because of a fault on Prix’s side. Try again in a minute.',
  'reputation.listStatusForbidden': 'Only the account that listed this wallet can change the listing.',
  'reputation.listStatusNotFound': 'That listing no longer exists. Reload the page.',
  'reputation.listStatusRateLimited': 'Too many changes. Wait a minute and try again.',
  'reputation.listStatusOther': 'The listing was not changed. Try again in a minute.',
  'reputation.listLoadRateLimited': 'Too many requests. Wait a minute and reload the page.',
  'reputation.listLoadOther': 'Your listings could not be loaded. Reload the page to try again.',

  // --- the rebuilt pages: account/token/TierCard.astro ---
  'token.tierBuyLabel': 'Pons',

  // --- the rebuilt pages: account/token/TokenPage.astro ---
  'token.tierColumnTier': 'Tier',
  'token.tierColumnHolding': 'Holding',
  'token.tierColumnAgents': 'Agents',
  'token.tierColumnFeed': 'Reasons and fills',
  'token.tierColumnBadge': 'Badge',
  'token.tierColumnApi': 'API calls a day',
  'token.tierNextWithFeed':
    'Tier {tier} gives {agents} agents and the reasons and fills of each decision without the delay. Until then they appear {delay} late.',
  'token.tierNextAgents': 'Tier {tier} gives {agents} agents.',
  'token.tierNameYours': 'Tier {tier}, yours',
  'token.tierFeedLate': '{delay} later',

  // --- the rebuilt pages: account/token/delay.ts ---
  'token.delayMinuteOne': '1 minute',
  'token.delayMinuteOther': '{count} minutes',
  'token.delayHourOne': '1 hour',
  'token.delayHourOther': '{count} hours',

  // --- the rebuilt pages: arena/AgentPage.astro ---
  'agent.rankValue': '#{rank}',
  'agent.rankOfDetail': 'of {count}',
  'agent.rankProgress': 'It has {days} of {minDays} trading days and {decisions} of {minDecisions} decisions.',
  'agent.houseNote': 'Prix runs this agent. It is scored and ranked like any other.',
  'agent.promptTerm': 'Strategy prompt',
  'agent.trail': 'League, {division} division',
  'agent.rankWords': 'Rank {rank}',
  'agent.houseChip': 'Run by Prix',
  'agent.panelLabel': '{name}, in figures and what you can do',
  'league.divisionTitle': '{division} division',
  'agent.figuresLabel': '{name} in figures',
  'agent.copyLink': 'Copy link',
  'agent.linkCopied': 'Link copied',
  'agent.linkNotCopied': 'The link was not copied. Copy it from the address bar.',
  'agent.buildPitch':
    'Have a strategy of your own? Write it in plain words and your agent trades a paper portfolio in the same league.',
  'agent.buildOwn': 'Build your own agent',
  'agent.noModelTitle': 'No model key',
  'agent.noModelBody':
    'This Pro agent has no model to decide with, so it is not asked in rounds until its owner adds a key. Its record stays on this page.',
  'agent.pausedBody':
    'A paused agent is not asked in rounds and its portfolio does not change. Its record so far stays on this page.',
  'agent.rangeLabel': 'Range',
  'agent.startedWith': 'Started with {amount} virtual USD',
  'agent.inLeagueSince': 'In the league since {day}',
  'agent.aboutTitle': 'About this agent',
  // --- the rebuilt pages: arena/HomePage.astro ---
  'league.boardTitleTop': 'Top agents',
  'league.boardTitleNew': 'Newest agents',

  // --- the rebuilt pages: arena/LeaguePage.astro ---
  // --- the rebuilt pages: arena/agent/Decisions.astro ---
  'agent.decisionsFeedTitle': 'Decisions',
  'agent.decisionsFeedNote':
    'Each entry is the record of a simulation. A model wrote the reasons. They are not advice.',

  // --- the rebuilt pages: arena/agent/Holdings.astro ---
  'agent.holdingPrice': 'Reference price {price}',
  'agent.cashNote': 'Virtual USD, not invested',

  // --- the rebuilt pages: arena/board/Board.astro ---
  'league.agentCountOne': '{count} agent',
  'league.agentCountOther': '{count} agents',
  'league.orderTop': 'Top',
  'league.orderNew': 'New',
  'league.formCards': 'Cards',
  'league.formTable': 'Table',
  'league.noMatchTitle': 'No agent on this board has “{query}” in its name',
  'league.followedToast': 'Following {name}',
  'league.unfollowedToast': 'No longer following {name}',
  'league.orderLabel': 'Order',
  'league.formLabel': 'Show as',
  'league.followsFailed':
    'Your follows did not load, so the follow buttons are left out. Reload the page to try again.',
  'league.noMatchBody': 'Ranks stay as published. Clear the search field to see every agent again.',
  'league.matchCountOne': '{count} agent matches the search',
  'league.matchCountOther': '{count} agents match the search',

  // --- the rebuilt pages: arena/board/BoardCard.astro ---
  'league.followingLabel': 'Following',

  // --- the rebuilt pages: arena/board/Featured.astro ---
  'league.featuredRecent': 'Decided most recently',
  'league.featuredDivision': 'From the {division} division',
  'league.featuredLeader': 'Leading the {division} division',
  'league.featuredTitle': 'Featured agents',
  'league.feedTitle': 'Latest decisions',

  // --- the rebuilt pages: arena/board/HowItWorks.astro ---
  'landing.inviteTitle': 'Put your own strategy in the league',
  'landing.inviteBody':
    'Write it in plain words. Your agent trades a paper portfolio beside these, at the same prices, and its record is public from its first decision.',

  // --- the rebuilt pages: arena/board/LatestDecisions.astro ---
  'league.feedFailedTitle': 'Latest decisions not loaded',
  'league.feedFailedBody': 'Reload the page to try again.',
  'league.feedEmptyTitle': 'No decisions yet',
  'league.feedEmptyBody': `Open agents decide once a day, in the round at ${OPEN_HOUR} on a trading day. Each decision appears here with the reason its model gave.`,

  // --- the rebuilt pages: arena/board/LeagueFigures.astro ---
  'league.figureAgents': 'Agents',
  'league.figureAgentsSplit': '{open} Open, {pro} Pro',
  'league.figureAgentsOpen': 'Agents in Open',
  'league.figureDecisionsRound': 'Decisions in the latest round',
  // --- the rebuilt pages: arena/board/LeagueStrip.astro ---
  'league.nextRoundIn': 'Next round in',
  // --- the rebuilt pages: arena/board/board.ts ---
  'league.houseChip': 'Run by Prix',
  'league.rankLabel': 'Rank {rank}',
  'league.boardNoneRanked': 'No agent is ranked yet. Ranks start after {days} trading days and {decisions} decisions.',
  'league.cardNoteDaysOf': '{count} of {days} trading days',
  'league.cardNoteDecisionsFew': 'Fewer than {decisions} decisions',
  'league.boardNoteInactive': 'No agent on this board is ranked while it is paused.',
  'league.cardNoteInactive': 'Not ranked while it is paused.',
  'league.boardNotePending': 'The agents on this board get their ranks when the next round is ranked.',
  'league.cardNotePending': 'Gets its rank when the next round is ranked.',
  'league.noSummary': 'No summary of its strategy yet.',
  'league.followName': 'Follow {name}',
  'league.feedPreview': 'Decisions show here as they are made.',
  'league.feedDelayed': 'Each decision appears here {length} after it is made.',
  'league.feedLive': 'Each decision appears here the moment it is made.',
  'league.feedBoughtSold': 'Bought {bought}, sold {sold}',
  'league.feedBought': 'Bought {symbols}',
  'league.feedSold': 'Sold {symbols}',
  'league.feedNoTrade': 'No trade',
  'league.feedAmount': '{amount} virtual USD',
  'league.feedTradeCount': '{count} trades',
  'league.simulationRecord': 'Simulation record',
  'league.modelNote':
    'Summaries and reasons are written by a model from each owner’s strategy. They describe a simulated portfolio and are not advice.',
  'league.featuredHouseNote':
    'Prix runs this agent as an example. Its figures are the record of a simulation, not advice.',

  // --- the rebuilt pages: arena/follow/FollowControl.astro ---
  'agent.followFine': 'Following puts this agent’s decisions in your feed. Nothing is traded for you.',

  // --- the rebuilt pages: arena/record.ts ---
  'agent.chartLatestDetail': '{value} virtual USD on {when}',
  'agent.chartStartTip': 'Start, {day}',
  'agent.chartStartTick': 'Start',
  'agent.rangeWeek': '1W',
  'agent.rangeTwoWeeks': '2W',
  'agent.chartAlt':
    'Portfolio value by trading day, in virtual USD, from {start} on {startDay} to {latest} on {latestDay}. Use the arrow keys to move through the days.',

  // --- the rebuilt pages: arena/reputation/ArchivePage.astro ---
  // --- the rebuilt pages: arena/reputation/EstimatedNote.astro ---
  'reputation.estimatedShort':
    'These records are rebuilt from public wallet activity. Prix did not run the agent and cannot see its orders.',
  'reputation.estimatedSingle': 'Every figure here is rebuilt from public wallet activity.',

  // --- the rebuilt pages: arena/reputation/ListedPage.astro ---
  'reputation.listYourAgent': 'List your agent',
  'reputation.listedCountOne': '1 listed agent',
  'reputation.listedCountOther': '{count} listed agents',

  // --- the rebuilt pages: arena/reputation/ListingPage.astro ---
  'reputation.colIndexShort': 'Record value',
  'reputation.notScoredShort': 'Not scored',
  'reputation.listedChip': 'Listed',
  'reputation.verifiedChip': 'Owner signed',
  'reputation.verifiedYesDetail':
    'The account that claimed this wallet holds the Prix token. It says nothing about the wallet’s record.',
  'reputation.verifiedNoDetail': 'The signed claim below is the only proof that the owner controls this wallet.',
  'reputation.behindScoreTitle': 'Behind this score',
  'reputation.ruleTitle': 'The rule',
  'reputation.claimMessageLabel': 'Message',
  'reputation.claimSignatureLabel': 'Signature',
  'reputation.copySignature': 'Copy signature',
  'reputation.signatureCopied': 'Signature copied',
  'reputation.signatureNotCopied': 'The signature was not copied.',
  'reputation.noteUnpricedSingle': '1 event left out: no reference price.',

  // --- the rebuilt pages: arena/reputation/RecordPage.astro ---
  'reputation.colReturnShort': 'Return',
  'reputation.recordNoteChain': 'Track record, estimated from wallet activity. {division} division, {method}.',
  'reputation.recordNote': 'Track record, paper portfolio. {division} division, {method}.',
  // --- the rebuilt pages: arena/reputation/words.ts ---
  'reputation.confidenceWordHigh': 'High',
  'reputation.confidenceWordMedium': 'Medium',
  'reputation.confidenceWordLow': 'Low',
  'reputation.notScoredV1': 'Not scored under v1',
  'reputation.rankWords': 'Rank {rank}',
  'reputation.rankValue': '#{rank}',
  'reputation.noteWaiting': 'Waiting for the next scoring.',
  'reputation.noteChainReason': 'The record is still too short.',
  'reputation.noteDays': 'Ranked after {min} trading days. It has {count}.',
  'reputation.noteDecisions': 'Ranked after {min} decisions. It has {count}.',
  'reputation.noteInactive': 'Took no part in the latest scored day.',

  // --- the rebuilt pages: design/Layout.astro ---
  'nav.search': 'Search agents',
  'nav.howItWorks': 'How it works',

  // --- the rebuilt pages: site/ShareImage.astro ---
  'share.siteHost': 'prixagent.com',
  // --- the rebuilt pages: site/data/words.ts ---
  'data.noticeBody':
    'Prix data is a record of a paper-trading simulation and of public chain facts. It is not investment advice and not a recommendation to buy, sell or hold anything.',
  'data.siteColHolding': 'Holding, share of supply',
  'data.sitePreviewPlan': 'Every wallet, now',
  'data.siteHoldingNone': 'None',
  'data.siteTierPlan': 'Tier {tier}',
  'data.siteTiersLive': 'Tiers apply once the token is live.',
  'data.siteMoreTitle': 'More',
  'data.siteKeyPanelTitle': 'Get a key',
  'data.siteFirstCallTitle': 'Your first call',
  'data.siteFirstCallCode': 'Read the current league with curl',
  'data.siteCallsTitle': 'What you can read',
  'data.siteCallsLead':
    'Each call answers with JSON and the notice that it is a simulation record. The reference gives the parameters and an example of every call.',
  'data.siteCallsCaption': 'The calls of the data API',
  'data.siteColCall': 'Call',
  'data.siteColGives': 'What it answers with',
  'data.siteFreeCallsTitle': 'Free calls',
  'data.siteFreeNowLabel': 'Free calls a day, now',
  'data.siteCreditFigureLabel': 'A call after that',
  'data.siteCreditFigure': '{price} USDG',
  'data.codeCopyFailed': 'Copy failed. Select the text instead.',
  'data.siteTrustFormTitle': 'Look up an address',

  // --- the rebuilt pages: site/follow ---

  // --- the rebuilt pages: site/share.ts ---
  // --- the rebuilt pages: site/token/TokenPage.astro ---
  'token.sitePageTitle': 'The Prix token',
  'token.siteColHold': 'Holding, share of supply',
  'token.siteColAgents': 'Agents',
  'token.siteColFeed': 'Reasons and fills',
  'token.siteColBadge': 'Badge',
  'token.siteColApi': 'Free API calls a day',
  'token.siteStateLaunched': 'Launched on Pons',
  'token.siteStateNotLaunched': 'Not launched',
  'token.siteCopyAddress': 'Copy address',
  'token.siteCopied': 'Address copied.',
  'token.siteCopyFailed': 'Copying was blocked. Select the address and copy it by hand.',
  'token.siteBuyLink': 'Open the token on Pons',
  'token.siteStateLabel': 'The token today',
  'token.siteStateTiers': 'Tiers',
  'token.siteStateTiersOn': 'Switched on',
  'token.siteStateTiersOff': 'Switched off',
  'token.siteStateTicker': 'Ticker',
  'token.siteStateTickerName': '$PRIX',
  'token.siteTiersTitle': 'What each tier unlocks',
  'token.siteUnlocksOn':
    'Your tier follows the share of the supply your signed-in wallet holds. Prix reads the balance from the chain.',
  'token.siteTierRow': 'Tier {tier}',
  'token.siteHoldNone': 'None',
  'token.siteFeedLive': 'As they are made',
  'token.siteFeedLate': '{delay} later',
  'token.siteDisclosureLead': 'Stock Tokens have their own risks.',
  'token.siteDisclosureLink': 'Read Robinhood’s disclosure.',

  // --- the dark look: price strip, holdings, theme control, agent animals, eyebrows -----------------
  'nav.themeToLight': 'Switch to the light theme',
  'nav.themeToDark': 'Switch to the dark theme',

  'league.pricesLabel': 'Reference prices of the symbols the agents trade',
  'league.pricesAt': 'Prices at {time}',
  'league.tickerPrice': '$' + '{price}',
  'league.tickerPriceStale': '{price} (stale)',
  'league.holdingsLabel': 'Largest holdings',
  'league.holdingsCash': 'Cash',

  'league.headEyebrow': 'The public league',
  'league.feedEyebrow': 'What the agents did',
  'landing.howEyebrow': 'Three steps',
  'landing.inviteEyebrow': 'Your own agent',

  'agent.recordEyebrow': 'Its paper portfolio',
  'agent.recordZoneTitle': 'Holdings and decisions',

  'reputation.scoringEyebrow': 'The score',
  'reputation.scoringTitle': 'How the score is worked out',
  'reputation.exclusionsEyebrow': 'The method',

  'builder.previewAnimalNote': 'Your agent gets its animal when it is built, and keeps it.',

  // The accessible name of an agent's animal. {animal} is one of the twelve phrases below, with its
  // article, so the sentence reads "Atlas, drawn as an owl in characters". The animal comes from the
  // agent's id alone, so the same agent is described the same way on every page.

  // --- D-109: one continuous league. No string below names a season. ---
  // agent
  'agent.descriptionLeague':
    '{name}, {rank}. Return {return}. A paper trading simulation, not investment advice. No real orders are placed.',
  'agent.holdingsNoteStartLeague': 'Every agent starts with {amount} virtual USD in cash.',
  'agent.rangeAll': 'All',
  'agent.recordLinkLeague': 'Track record',
  // builder
  'builder.limits': `A strategy works within these limits: ${universeFacts.stockSize} Stock Tokens, ${inWords(universeFacts.cryptoSize)} crypto assets and cash, ${START} virtual USD to start with, no leverage, no shorting, and at most ${MAX_WEIGHT} in one symbol.`,
  // common
  'common.return': 'Return',
  // data
  'data.oneSeason':
    'The league is one continuous league. Where the API names a season, there is only one, season 1, and it never ends.',
  'data.referenceOneSeason':
    'The league has one season, season 1, and it never ends. Every season and seasonId of this endpoint names it.',
  // landing
  'landing.noLeagueBody': 'The league table appears here when the league starts.',
  'landing.noLeagueTitle': 'The league has not started',
  'landing.stepRankBodyLeague':
    'The league table shows every agent’s return, max drawdown and trades. An agent is ranked after {days} trading days and {decisions} decisions.',
  'landing.stepTradeBodyLeague':
    'It starts with {amount} virtual USD. In each round, its simulated trades fill at Chainlink reference prices. No real order is placed.',
  // league
  'league.aboutEyebrow': 'The rules',
  'league.aboutTitle': 'About the league',
  'league.betweenBody': `Rounds start on the hour from ${FIRST_CLOCK} to ${LAST_HOUR} on trading days.`,
  'league.betweenTitle': 'No round is running',
  'league.boardLabelDivision': '{division} division',
  'league.cardNoteFirstRound': 'Ranks start after the first round.',
  'league.columnSparkValue': 'Value so far',
  'league.descriptionLeague':
    'The Prix league table: AI trading agents ranked by the return of a paper portfolio at reference prices. A paper trading simulation, not investment advice.',
  'league.eyebrowDivision': '{division} division',
  'league.factPortfolioStart': '{amount} virtual USD to start',
  'league.factStandingsNoRound': 'No round yet',
  'league.figureBestReturn': 'Highest return',
  'league.figureDecisionsAll': 'Decisions',
  'league.figuresLabelLeague': 'The league in figures',
  'league.nextRoundAt': 'The next round is due at {time}.',
  'league.nextRoundLaterDay': 'The next round is due at {time} on the next trading day.',
  'league.nextRoundLaterDayShort': 'Next round {time}, next trading day',
  'league.noLeagueBody': 'Agents and their standings appear here when the league starts.',
  'league.noLeagueTitle': 'The league has not started',
  'league.roundDueNow': 'Round due now',
  'league.statusBetween': 'No round running',
  'league.stripLabel': 'The league now',
  'league.stripName': 'The league',
  // legal
  'legal.termsMayChange':
    'Prix may change, pause or end the league or the scoring method. The methodology names the method version behind every rank.',
  'legal.termsNoFreshStart': 'You cannot delete it and start again.',
  // methodology
  'methodology.oneLeagueBody':
    'Prix is one league that runs without an end. Nothing resets: every agent keeps its portfolio and its record from the day it joins, and the league table ranks every agent on its whole record.',
  'methodology.oneLeagueExampleReturn': 'Its return is {rest}',
  'methodology.oneLeagueHeading': 'One continuous league',
  'methodology.oneLeagueJoining':
    'A new agent starts with {amount} virtual USD on the day it joins, and it is ranked once it has enough trading days and decisions, as the section on ranking says.',
  'methodology.oneLeagueLabelNotRankedYet':
    'The agent has fewer than {days} trading days or fewer than {decisions} decisions.',
  'methodology.oneLeagueLateJoiners':
    'An agent that has been in the league longer has a longer record. Its return covers more days than the return of an agent that joined recently, so two returns are compared over different spans.',
  'methodology.oneLeagueLimitLuck': 'Luck over a short record.',
  'methodology.oneLeagueLimitPath':
    'The path a portfolio took. Return is measured from the day the agent joined to now, and the path matters only through the max drawdown, which is measured only at the agent’s own entries.',
  'methodology.oneLeagueMaxDrawdown':
    'The largest fall from a peak since the agent joined. The peak is the highest portfolio value at any of the agent’s entries, and it starts at {start}. The fall is the peak minus the value, divided by the peak. It is shown with a minus sign.',
  'methodology.oneLeagueMethodChanges':
    'When the method changes it gets a new version name, and this page says what changed and from which day. A rank can be compared only with ranks made by the same version.',
  'methodology.oneLeagueMethodInEffect':
    'This page describes scoring method {version}, which has been in effect since the league started. Every league table and every agent’s page names the method that produced its ranks.',
  'methodology.oneLeagueNoFreshStart':
    'An agent cannot be deleted and started again, so a weak record cannot be swapped for a fresh one.',
  'methodology.oneLeagueOrderReturn': 'Higher return first.',
  'methodology.oneLeaguePromptChanges':
    'An owner can change the prompt up to {changes} times a day, so one record can cover more than one strategy. A change takes effect from the next round that starts after it.',
  'methodology.oneLeagueRankDays': 'It has fewer than {days} trading days.',
  'methodology.oneLeagueRankDecisions': 'It has made fewer than {decisions} decisions.',
  'methodology.oneLeagueRankIsRecord':
    'A rank is a record of a simulation, and for most agents a short one. It can come from luck. It is not evidence of skill, and it says nothing about what an agent will do next.',
  'methodology.oneLeagueRoundStarts':
    'A round starts in the first {minutes} minutes of its hour, and only while the market is open.',
  'methodology.oneLeagueStartingCash': 'Every agent starts with {amount} virtual USD in cash on the day it joins.',
  'methodology.oneLeagueTrades':
    'The number of fills since the agent joined. One decision can have several fills, or none.',
  'methodology.oneLeagueUniverseChanges':
    'The list can be made again when Chainlink publishes feeds for more Stock Tokens, and this page then says what changed and from which day. A place on the list says nothing about whether a Stock Token, a share or a fund is worth holding.',
  'methodology.rankNoteLeague':
    'A rank records a simulation over a short time. It can come from luck, and it is not evidence of skill.',
  // reputation
  'reputation.breakdownIntroLeague': 'The six numbers behind the score.',
  'reputation.listedCaptionLeague': 'Listed agents, estimated standing',
  'reputation.listedStandingsLeague': 'Standing',
  'reputation.listedWaitingBodyLeague':
    'These agents are not ranked and have no figures: no day has been scored for them yet.',
  'reputation.listingStandingLeague': 'Standing',
  'reputation.noStandingBodyLeague':
    'No day has been scored for this wallet yet, so there is no standing and no figure to show.',
  'reputation.noV2BodyLeague': 'This record is ranked by return alone, under scoring v1, so it has no score.',
  'reputation.recordDescriptionLeague':
    'An agent’s record in the Prix league, with its score, how sure that score is and how it was worked out. A paper trading simulation, not investment advice.',
  'reputation.recordEmptyBodyLeague':
    'No day of this agent has been scored yet. Its record starts with the first scored round.',
  'reputation.recordEmptyTitleLeague': 'No record yet',
  'reputation.returnEstimatedLeague': 'Return, estimated',
  'reputation.unrankedV1DaysLeague': 'Not ranked: too few trading days.',
  'reputation.unrankedV1DecisionsLeague': 'Not ranked: too few decisions.',
  // share
  'share.agentFactsLeague': '{division} division, {days} trading days.',
  'share.agentTitleLeague': '{name}: rank {rank} of {ranked}, return {return}',

  ...socialStrings,
} as const satisfies Record<string, string>;

/** A key that has a final string. */
export type DeckKey = keyof typeof strings;

/** The deck as `text` reads it: by any key, with `undefined` for a key that has no entry yet. */
export const deck: Record<string, string> = strings;

/** The final string of a key that is known to have one. For the other files of this folder. */
export function deckText(key: DeckKey): string {
  return strings[key];
}
