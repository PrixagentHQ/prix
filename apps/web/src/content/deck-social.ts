import type {
  ACTIVE_WARS_MAX,
  DNA_LAG_DAYS,
  DNA_METHOD,
  DNA_MIN_DAYS,
  DNA_MOMENTUM_LOOKBACK_DAYS,
  DNA_TURNOVER_PERIOD_DAYS,
  DNA_WINDOW_DAYS,
  FORK_LINK_WINDOW_SECONDS,
  FORKS_PER_PARENT_PER_DAY,
  MANAGER_EXIT_AFTER_MISSING_DAYS,
  MANAGER_MAX_AGENTS,
  MANAGER_MAX_WEIGHT_BPS,
  MANAGER_MIN_AGENTS,
  MANAGER_MIN_WEIGHT_BPS,
  RIVALRY_FORM_CLOSE_DAYS,
  RIVALRY_FORM_MIN_SWAPS,
  RIVALRY_KEEP_CLOSE_DAYS,
  RIVALRY_MAX_ACTIVE_PER_AGENT,
  RIVALRY_MAX_GAP,
  RIVALRY_MAX_GAP_SMALL,
  RIVALRY_SMALL_TABLE,
  RIVALRY_WINDOW_TAPE_DAYS,
  ROOM_KEEP,
  ROOM_MESSAGES_PER_WALLET_PER_DAY,
  ROOM_PAGE,
  ROOM_PICTURE_ANIMATED_MAX_SIDE,
  ROOM_PICTURE_MAX_BYTES,
  ROOM_PICTURE_MAX_FRAMES,
  ROOM_PICTURE_MAX_SIDE,
  ROOM_PICTURE_MIN_SIDE,
  ROOM_PICTURE_REPORTER_AGE_SECONDS,
  ROOM_PICTURE_TTL_SECONDS,
  ROOM_PICTURE_WRITER_AGE_SECONDS,
  ROOM_PICTURES_PER_WALLET_PER_DAY,
  ROOM_SECONDS_BETWEEN,
  ROOM_TEXT_MAX,
  ROOM_WRITE_MIN_TOKENS,
  TOKEN_CACHE_SECONDS,
  WAR_ENTRANTS_MAX,
  WAR_ENTRANTS_MIN,
  WAR_MAX_OUTPUT_TOKENS,
  WAR_TIMEOUT_MS,
  WAR_TRADING_DAYS_DEFAULT,
  WAR_TRADING_DAYS_MAX,
  WAR_TRADING_DAYS_MIN,
} from '@prix/contracts';
import { facts, grouped, inWords, links, minutesOf } from './facts.ts';

/**
 * The `social` copy area: every string of Phase 6, which is Strategy profiles (the measured profile
 * the code calls DNA), forks, model wars, rivalries and paper managers. `editor` owns this file;
 * `deck.ts` spreads it.
 *
 * Words this area keeps to:
 * - "strategy profile" for what the code calls DNA, because DNA reads as something inborn and fixed;
 * - "paper manager" every time, never a bare "manager" and never a word for a pooled product;
 * - "model war" for the experiment, and "one run under these conditions" for what it shows;
 * - a record, a profile and a rivalry are descriptions of what happened in a simulation;
 * - no "season": the league is one continuous league (D-109), and a figure is a "return";
 * - "Community chat" for the chat between users (Phase 6.3), which the code calls the room: no
 *   sentence a visitor reads says "room";
 * - "picture" for what a user adds to the Community chat (Phase 6.4) and "file" for what Prix stores of
 *   it: no sentence says "image", "upload" or "bytes", and none says that a picture is safe, verified or
 *   checked.
 *
 * Words this area never uses: `SOCIAL_FORBIDDEN_WORDS` and `ADVICE_WORDS` of the contract. A test in
 * tests/social/words.test.ts reads every string below against both lists, and tests/unit/content.test.ts
 * fails at the gate on a key in use with no string here. Every key below is read by a page.
 *
 * Where a string has a `{slot}`, the page fills it. A slot for a figure takes a string that
 * `format.ts` has already made.
 */

/** The numbers the copy states. Repeated from the contract, and the type below fails to compile when one changes. */
const socialFacts = {
  dnaMethod: 'dna-v1',
  dnaWindowDays: 40,
  dnaMinDays: 10,
  dnaLagDays: 2,
  dnaMomentumLookbackDays: 20,
  dnaTurnoverPeriodDays: 20,
  forkLinkWindowSeconds: 600,
  forksPerParentPerDay: 20,
  rivalryWindowDays: 10,
  rivalryFormCloseDays: 5,
  rivalryFormMinSwaps: 1,
  rivalryKeepCloseDays: 3,
  rivalrySmallTable: 20,
  rivalryGapSmall: 1,
  rivalryGap: 2,
  rivalryMaxActive: 2,
  warEntrantsMin: 2,
  warEntrantsMax: 4,
  warDaysMin: 5,
  warDaysMax: 20,
  warDaysDefault: 10,
  warMaxOutputTokens: 300,
  warTimeoutMs: 20_000,
  activeWarsMax: 1,
  managerMinAgents: 2,
  managerMaxAgents: 5,
  managerMinWeightBps: 500,
  managerMaxWeightBps: 4_000,
  managerExitAfterMissingDays: 3,
  roomTextMax: 280,
  roomPage: 50,
  roomSecondsBetween: 20,
  roomMessagesPerWalletPerDay: 30,
  roomKeep: 2_000,
  /** Whole $PRIX a wallet must hold to write (revision 7 of the contract: a holding, and no tier). */
  roomWriteMinTokens: 1,
  /** How old a stored read of a wallet’s balance may be before Prix reads the chain again. */
  tokenCacheSeconds: 900,
  // Pictures in the Community chat (Phase 6.4): the constants behind ROOM_PICTURE_LIMITS of the contract,
  // which holds every number a sentence of pictures states.
  pictureMaxBytes: 262_144,
  pictureMinSide: 16,
  pictureMaxSide: 2_048,
  pictureMaxFrames: 120,
  pictureAnimatedMaxSide: 512,
  picturesPerWalletPerDay: 3,
  pictureTtlSeconds: 604_800,
  pictureWriterAgeSeconds: 3_600,
  pictureReporterAgeSeconds: 86_400,
} as const;

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Holds<T extends true> = T;

/** Fails to compile when a literal constant of the contract no longer equals the fact above. */
export type SocialFactsMatchContract = [
  Holds<Same<typeof socialFacts.dnaMethod, typeof DNA_METHOD>>,
  Holds<Same<typeof socialFacts.dnaWindowDays, typeof DNA_WINDOW_DAYS>>,
  Holds<Same<typeof socialFacts.dnaMinDays, typeof DNA_MIN_DAYS>>,
  Holds<Same<typeof socialFacts.dnaLagDays, typeof DNA_LAG_DAYS>>,
  Holds<Same<typeof socialFacts.dnaMomentumLookbackDays, typeof DNA_MOMENTUM_LOOKBACK_DAYS>>,
  Holds<Same<typeof socialFacts.dnaTurnoverPeriodDays, typeof DNA_TURNOVER_PERIOD_DAYS>>,
  Holds<Same<typeof socialFacts.forkLinkWindowSeconds, typeof FORK_LINK_WINDOW_SECONDS>>,
  Holds<Same<typeof socialFacts.forksPerParentPerDay, typeof FORKS_PER_PARENT_PER_DAY>>,
  Holds<Same<typeof socialFacts.rivalryWindowDays, typeof RIVALRY_WINDOW_TAPE_DAYS>>,
  Holds<Same<typeof socialFacts.rivalryFormCloseDays, typeof RIVALRY_FORM_CLOSE_DAYS>>,
  Holds<Same<typeof socialFacts.rivalryFormMinSwaps, typeof RIVALRY_FORM_MIN_SWAPS>>,
  Holds<Same<typeof socialFacts.rivalryKeepCloseDays, typeof RIVALRY_KEEP_CLOSE_DAYS>>,
  Holds<Same<typeof socialFacts.rivalrySmallTable, typeof RIVALRY_SMALL_TABLE>>,
  Holds<Same<typeof socialFacts.rivalryGapSmall, typeof RIVALRY_MAX_GAP_SMALL>>,
  Holds<Same<typeof socialFacts.rivalryGap, typeof RIVALRY_MAX_GAP>>,
  Holds<Same<typeof socialFacts.rivalryMaxActive, typeof RIVALRY_MAX_ACTIVE_PER_AGENT>>,
  Holds<Same<typeof socialFacts.warEntrantsMin, typeof WAR_ENTRANTS_MIN>>,
  Holds<Same<typeof socialFacts.warEntrantsMax, typeof WAR_ENTRANTS_MAX>>,
  Holds<Same<typeof socialFacts.warDaysMin, typeof WAR_TRADING_DAYS_MIN>>,
  Holds<Same<typeof socialFacts.warDaysMax, typeof WAR_TRADING_DAYS_MAX>>,
  Holds<Same<typeof socialFacts.warDaysDefault, typeof WAR_TRADING_DAYS_DEFAULT>>,
  Holds<Same<typeof socialFacts.warMaxOutputTokens, typeof WAR_MAX_OUTPUT_TOKENS>>,
  Holds<Same<typeof socialFacts.warTimeoutMs, typeof WAR_TIMEOUT_MS>>,
  Holds<Same<typeof socialFacts.activeWarsMax, typeof ACTIVE_WARS_MAX>>,
  Holds<Same<typeof socialFacts.managerMinAgents, typeof MANAGER_MIN_AGENTS>>,
  Holds<Same<typeof socialFacts.managerMaxAgents, typeof MANAGER_MAX_AGENTS>>,
  Holds<Same<typeof socialFacts.managerMinWeightBps, typeof MANAGER_MIN_WEIGHT_BPS>>,
  Holds<Same<typeof socialFacts.managerMaxWeightBps, typeof MANAGER_MAX_WEIGHT_BPS>>,
  Holds<Same<typeof socialFacts.managerExitAfterMissingDays, typeof MANAGER_EXIT_AFTER_MISSING_DAYS>>,
  Holds<Same<typeof socialFacts.roomTextMax, typeof ROOM_TEXT_MAX>>,
  Holds<Same<typeof socialFacts.roomPage, typeof ROOM_PAGE>>,
  Holds<Same<typeof socialFacts.roomSecondsBetween, typeof ROOM_SECONDS_BETWEEN>>,
  Holds<Same<typeof socialFacts.roomMessagesPerWalletPerDay, typeof ROOM_MESSAGES_PER_WALLET_PER_DAY>>,
  Holds<Same<typeof socialFacts.roomKeep, typeof ROOM_KEEP>>,
  Holds<Same<typeof socialFacts.roomWriteMinTokens, typeof ROOM_WRITE_MIN_TOKENS>>,
  Holds<Same<typeof socialFacts.tokenCacheSeconds, typeof TOKEN_CACHE_SECONDS>>,
  Holds<Same<typeof socialFacts.pictureMaxBytes, typeof ROOM_PICTURE_MAX_BYTES>>,
  Holds<Same<typeof socialFacts.pictureMinSide, typeof ROOM_PICTURE_MIN_SIDE>>,
  Holds<Same<typeof socialFacts.pictureMaxSide, typeof ROOM_PICTURE_MAX_SIDE>>,
  Holds<Same<typeof socialFacts.pictureMaxFrames, typeof ROOM_PICTURE_MAX_FRAMES>>,
  Holds<Same<typeof socialFacts.pictureAnimatedMaxSide, typeof ROOM_PICTURE_ANIMATED_MAX_SIDE>>,
  Holds<Same<typeof socialFacts.picturesPerWalletPerDay, typeof ROOM_PICTURES_PER_WALLET_PER_DAY>>,
  Holds<Same<typeof socialFacts.pictureTtlSeconds, typeof ROOM_PICTURE_TTL_SECONDS>>,
  Holds<Same<typeof socialFacts.pictureWriterAgeSeconds, typeof ROOM_PICTURE_WRITER_AGE_SECONDS>>,
  Holds<Same<typeof socialFacts.pictureReporterAgeSeconds, typeof ROOM_PICTURE_REPORTER_AGE_SECONDS>>,
];

const START = grouped(facts.startingCashUsd);
const OPEN_HOUR = `${String(facts.openDailyTickHourUtc).padStart(2, '0')}:00 UTC`;
const LAG = inWords(socialFacts.dnaLagDays);
const LOOKBACK = String(socialFacts.dnaMomentumLookbackDays);
const PERIOD = String(socialFacts.dnaTurnoverPeriodDays);
const LINK_MINUTES = inWords(socialFacts.forkLinkWindowSeconds / 60);
const WAR_MIN = inWords(socialFacts.warEntrantsMin);
const WAR_MAX = inWords(socialFacts.warEntrantsMax);
const MGR_MIN = inWords(socialFacts.managerMinAgents);
const MGR_MAX = inWords(socialFacts.managerMaxAgents);
const MGR_EXIT = inWords(socialFacts.managerExitAfterMissingDays);
const CHAT_MAX = String(socialFacts.roomTextMax);
/** What a wallet must hold to write, by the ticker: "1 $PRIX". No sentence of the chat names a tier. */
const CHAT_MIN = `${grouped(socialFacts.roomWriteMinTokens)} $PRIX`;
/** How soon Prix reads a wallet’s holding again: "15 minutes". */
const CHAT_READ = minutesOf(socialFacts.tokenCacheSeconds);
/** What a writer does with a message the text rule refused. The same words under every such sentence. */
const CHAT_FIX = 'Take it out and send the message again.';
const CHAT_FIX_WORDS = 'Take those words out and send the message again.';

// The figures of pictures, derived as ROOM_PICTURE_LIMITS of the contract derives them. The test beside
// this file reads every sentence of pictures against that record: none states a figure it does not hold.
/** The largest file, as a file manager shows it: "256 KB". */
const PIC_SIZE = `${grouped(socialFacts.pictureMaxBytes / 1_024)} KB`;
const PIC_MIN = grouped(socialFacts.pictureMinSide);
const PIC_MAX = grouped(socialFacts.pictureMaxSide);
const PIC_FRAMES = grouped(socialFacts.pictureMaxFrames);
const PIC_ANIMATED = grouped(socialFacts.pictureAnimatedMaxSide);
const PIC_PER_DAY = String(socialFacts.picturesPerWalletPerDay);
/** How old a wallet’s first message is before the wallet adds a picture, and before it reports one. */
const PIC_WRITER_MINUTES = String(socialFacts.pictureWriterAgeSeconds / 60);
const PIC_REPORTER_HOURS = String(socialFacts.pictureReporterAgeSeconds / 3_600);
/** Under a refusal that came after the wallet’s turn was taken: the same words each time. */
const PIC_COUNTED = 'The try still counts as one of this wallet’s pictures for today.';

/** The sentence under every Phase 6 page that describes something of the simulation. */
const NOT_ADVICE = 'A paper trading simulation, not investment advice.';

export const socialStrings = {
  // --- shared -----------------------------------------------------------------------------------------

  'social.paperLine': 'Paper trading simulation. Nothing here is advice.',
  'social.divisionLabel': 'Division',
  'social.divisionOpen': 'Open',
  'social.divisionPro': 'Pro',
  'social.byOwner': 'By {owner}',
  'social.houseChip': 'House',
  'social.thisAgent': 'This agent',
  'social.backToAgent': 'Back to the agent',
  'social.agentNotPublic': 'an agent that is no longer public',
  'social.agentNotPublicTitle': 'No longer public',
  'social.notRanked': 'not ranked',
  'social.loadFailedTitle': 'Not loaded',
  'social.loadFailedBody': '{subject} could not be loaded. Reload the page to try again.',
  'social.unreadableTitle': '{what} not loaded',
  'social.unreadableBody': 'Reload the page to try again. If it keeps failing, come back in a few minutes.',
  'social.noScriptTitle': 'JavaScript is off',
  'social.noScriptBody': 'This page needs JavaScript. Turn it on and reload the page.',
  'social.chartKey': 'Lines',
  'social.chartStart': 'Start',
  'social.chartPointDetail': '{value} virtual USD on {day}',
  'social.showTable': 'Show the ranks as a table',
  'social.colAgent': 'Agent',
  'social.colAgents': 'Agents',
  'social.colDay': 'Day',
  'social.colState': 'State',
  'social.colReturn': 'Return',
  'social.colDrawdown': 'Max drawdown',
  'social.colTrades': 'Trades',
  'social.providerWorkersAi': 'Workers AI',
  'social.providerGroq': 'Groq',
  'social.rankConfidenceHigh': 'High confidence',
  'social.rankConfidenceMedium': 'Medium confidence',
  'social.rankConfidenceLow': 'Low confidence',
  'social.rankConfidenceInsufficient': 'Too few days to rate confidence',
  'social.rankConfidenceAllInsufficient': 'Too few days to rate confidence for any model yet.',

  // --- the official rank of the board (arena/words.ts) ----------------------------------------------

  'social.v2MinDays': 'This agent is not ranked yet because it has fewer than {days} trading days.',
  'social.v2EndedMinDays': 'This agent was not ranked: it had fewer than {days} trading days.',
  'social.v2MinDecisions': 'This agent is not ranked yet because it has made fewer than {decisions} decisions.',
  'social.v2EndedMinDecisions': 'This agent was not ranked: it made fewer than {decisions} decisions.',
  'social.v2Inactive': 'This agent is not ranked because it had no round on the scored day.',
  'social.v2EndedInactive': 'This agent was not ranked: it had no round on the last scored day.',
  'social.v2GroupMinDays': 'These agents are not ranked yet because they have fewer than {days} trading days.',
  'social.v2GroupMinDecisions':
    'These agents are not ranked yet because they have made fewer than {decisions} decisions.',
  'social.v2GroupInactive': 'These agents are not ranked because they had no round on the scored day.',
  'social.rankProgress': 'It has {days} of {minDays} trading days and {decisions} of {minDecisions} decisions.',
  'social.v2RankedFrom': 'Ranked from {days} trading days and {decisions} decisions.',
  'social.v2NotScoredYet': 'No day has been scored yet, so the agents are shown in order of return. {rankedFrom}',
  'social.officialRankAsOf': 'Official rank (scoring v2), as of {day}.',
  'social.figuresAsOf': 'Figures as of the {time} round on {day}.',

  // --- the strategy profile ---------------------------------------------------------------------------

  'social.dnaTitle': 'Strategy profile',
  'social.dnaAsOf': 'As of {day}, from the paper portfolio’s daily records.',
  'social.dnaForming': 'Not enough history yet: {n} of {min} days. Each measure shows a value from {min} days.',
  'social.dnaEmptyTitle': 'No profile yet',
  'social.dnaEmptyBody': `Prix measures it once a day, ${LAG} days behind. It shows here after the first measurement.`,
  'social.dnaNoValue': 'No value yet',
  'social.dnaBeyond': 'The value lies past the end of the scale.',
  'social.dnaMethodLink': 'How a strategy profile is measured',
  'social.dnaFooter':
    'Measured from {days} days of the paper portfolio, {start} to {end}, with method {method}. The window starts no earlier than the last change of strategy, on {since}. It describes what the agent did. It is not a score, a rank or a rating, and nothing is sorted by it.',
  'social.dnaNoteHistory': 'Not enough history yet: {n} of {min} days.',
  'social.dnaNoteOnlyCash': 'It held only cash on every day of the window.',
  'social.dnaNoteMarket': `Not measured yet: the league needs ${LOOKBACK} priced days of prices before the first day measured.`,
  'social.dnaNoteLonger': 'Longer than the window.',
  'social.dnaPositions': 'Effective positions',
  'social.dnaPositionsAbout': 'How many holdings its money was spread over, on an average day.',
  'social.dnaPositionsValue': '{n} positions',
  'social.dnaPositionsStart': '1',
  'social.dnaPositionsEnd': '20',
  'social.dnaCash': 'Cash share',
  'social.dnaCashAbout': 'The average share of the portfolio kept in cash. SGOV counts as a holding.',
  'social.dnaCashStart': 'None',
  'social.dnaCashEnd': 'All cash',
  'social.dnaTurnover': 'Net turnover',
  'social.dnaTurnoverAbout': `How much it traded every ${PERIOD} priced days, net of round trips within a day.`,
  'social.dnaTurnoverValue': `{share} per ${PERIOD} days`,
  'social.dnaTurnoverStart': '0%',
  'social.dnaTurnoverEnd': '200%',
  'social.dnaHoldingValue': 'Implied holding period: {days} priced days.',
  'social.dnaHoldingLonger': 'Implied holding period: longer than the window.',
  'social.dnaHoldingNone': 'Implied holding period: {note}',
  'social.dnaSwing': 'Daily swing',
  'social.dnaSwingAbout': 'How far its value moved from one priced day to the next, as a standard deviation.',
  'social.dnaSwingStart': '0%',
  'social.dnaSwingEnd': '5%',
  'social.dnaFall': 'Deepest fall',
  'social.dnaFallAbout': 'The largest fall of its value from a high point within the window.',
  'social.dnaFallStart': '0%',
  'social.dnaFallEnd': '−50%',
  'social.dnaMomentum': 'Momentum tilt',
  'social.dnaMomentumAbout': `Whether it held the symbols that had risen most or least over the previous ${LOOKBACK} priced days.`,
  'social.dnaMomentumStart': 'Held recent laggards',
  'social.dnaMomentumEnd': 'Held recent leaders',

  // --- forks on the agent page --------------------------------------------------------------------------

  'social.strategyTitle': 'This strategy',
  'social.notAFork': 'An original strategy: it is not a fork of another agent.',
  'social.forkThis': 'Fork this strategy',
  'social.forkNote':
    'A fork is a new agent of your own, linked to this one. It starts with no record and trades its own paper portfolio.',
  'social.forkOf': 'Fork of {parent} by {owner}.',
  'social.forkOfHidden': 'Fork of an agent that is no longer public.',
  'social.familyLink': 'its family',
  'social.forkFamilyOne': 'The only fork in {family}.',
  'social.forkFamilyOther': 'One of {count} forks in {family}.',
  'social.forkFamilyNoCount': 'See {family}.',
  'social.forkedOne': 'Forked once. See {family}.',
  'social.forkedOther': 'Forked {count} times. See {family}.',
  'social.agentRivalriesTitle': 'Rivalries',
  'social.agentRivalriesNote':
    'Agents close to this one in the table that changed places with it, from the daily record of official ranks.',
  'social.rivalryPair': '{a} and {b}',

  // --- the family page ----------------------------------------------------------------------------------

  'social.familyTitle': 'The family of {name}',
  'social.familyTitleHidden': 'A family of strategies',
  'social.familyEyebrow': 'Forks of a strategy',
  'social.familyDescription': `The first agent of a strategy and every public fork made from it, in the order they were made. ${NOT_ADVICE}`,
  'social.familyLead':
    'A fork is a new agent that starts from a public strategy and keeps a link to it. A family shows where strategies came from. It is not ranked, and it carries no figures.',
  'social.subjectFamily': 'This family',
  'social.familyHiddenTitle': 'Family not listed',
  'social.familyHiddenBody': 'The first agent of this family is no longer public, so the family is not listed here.',
  'social.familyCountOne': '1 public fork.',
  'social.familyCountOther': '{count} public forks.',
  'social.familyRootLine': 'The first agent, by {owner}. Made on {day}.',
  'social.familyRootHidden': 'The first agent of this family is no longer public.',
  'social.familyMemberLine': 'Fork of {parent}, by {owner}. Made on {day}.',
  'social.familyMemberLineNoParent': 'A fork, by {owner}. Made on {day}.',
  'social.familyEmptyTitle': 'No forks yet',
  'social.familyEmptyBody':
    'Nobody has forked this strategy yet. A fork is a new agent of your own that starts from it and keeps a link to it.',
  'social.familyPages': 'Pages of the family',

  // --- the fork builder ---------------------------------------------------------------------------------

  'social.forkTitle': 'Fork {name}',
  'social.forkTitleFallback': 'Fork an agent',
  'social.forkDescription':
    'Make a new paper-trading agent from a public one. A fork starts with no record of its own.',
  'social.forkIntro':
    'Start from a public agent and make it your own. A fork is a new agent with its own name, its own prompt and its own record.',
  'social.forkBack': 'Back to {name}',
  'social.forkWhat': 'The agent to fork',
  'social.forkSignInTitle': 'Sign in to fork {name}',
  'social.forkSignInBody':
    'A fork belongs to a wallet. Sign in to build it. The sign-in signature is the only thing Prix asks of your wallet.',
  'social.forkClosedTitle': 'The league is not taking new agents',
  'social.forkParentTitle': 'The agent you are forking',
  'social.forkSummaryTitle': 'What it does',
  'social.forkSummaryPending': 'The summary of this agent is not ready yet.',
  'social.forkSummaryFailed': 'This agent has no summary.',
  'social.forkDivisionNote':
    'Division: {division}. A fork joins the division of its parent, and the division cannot be changed later.',
  'social.forkNameHint': 'The name is public, and it cannot contain {parent}.',
  'social.forkPublishedLabel': 'Published by its owner. Make it yours.',
  'social.forkPrivateNote':
    'The owner keeps this prompt private. Write your own in the box. The summary and the strategy profile show what the agent does.',
  'social.forkPromptHint': '{min} to {max} characters. Say what the agent holds and when that changes.',
  'social.forkSameHint':
    'Change the prompt to build the fork. A fork cannot repeat the published prompt word for word.',
  'social.forkKeyHint':
    'This is a Pro agent, so your fork runs on one of your model keys. You can add or delete keys on your account page.',
  'social.forkKeyNone': 'A Pro fork needs a model key, and this wallet has none saved.',
  'social.forkPublishHint':
    'Your prompt stays private unless you publish it. Once it is published, anyone can read it on your agent’s page and copy it into a fork, and a copy stays in that fork even if you unpublish.',
  'social.forkNotes': `A fork starts with ${START} virtual USD and no record. Nothing of the parent’s results carries over.`,
  'social.forkSubmit': 'Build the fork',
  'social.forkBusy': 'Building the fork',
  'social.forkFailedTitle': 'The fork was not built',
  'social.forkNameContains': 'A fork cannot use the name of its parent, {parent}, inside its own. Choose another name.',
  'social.forkLinkTitle': 'Your agent was built, but it is not linked to {parent}',
  'social.forkLinkBody':
    'Your agent exists and trades as an ordinary agent. The link shows it as a fork of {parent} on both pages. {message}',
  'social.forkLinkAgain': 'Link to {parent}',
  'social.forkLinkBusy': 'Linking',
  'social.forkLinkLater': 'Go to your account',
  'social.forkLinkWindowClosed': `A fork can be linked for ${LINK_MINUTES} minutes after it is built, and that time has passed. Your agent keeps trading as an ordinary agent.`,
  'social.forkLinkRefused': 'Prix did not accept the link. Your agent keeps trading as an ordinary agent.',
  'social.forkLinkNameRefused':
    'The name of your agent contains the name of the agent it came from, so Prix did not link it. Its name cannot be changed.',
  'social.forkLinkPromptRefused':
    'The prompt of your agent is the published prompt word for word, so Prix did not link it.',
  'social.forkLinkCapped': 'This agent has reached its limit of forks for today. Try the link again in a few minutes.',

  // --- rivalries ----------------------------------------------------------------------------------------

  'social.rivalriesTitle': 'Rivalries',
  'social.rivalriesEyebrow': 'From the daily record of ranks',
  'social.rivalriesDescription': `Agents close to each other in the Prix table that changed places, from the daily record of official ranks. ${NOT_ADVICE}`,
  'social.rivalriesLead':
    'Agents that stood close in the table and changed places. Prix finds them once a day from the official ranks; nobody enters one and nothing is given for one.',
  'social.rivalryRule':
    'Two agents become a rivalry when they stand within one place of each other (two places once {small} or more agents are ranked) on at least {form} of the last {window} ranked days and change places at least once. It ends when they are close on fewer than {keep} of those days.',
  'social.rivalriesHeading': 'By division',
  'social.rivalriesCaption': 'Rivalries of the {division} division',
  'social.subjectRivalries': 'The list of rivalries',
  'social.rivalriesEmptyTitle': 'No rivalries yet',
  'social.rivalriesNoTape': 'No ranked day is recorded yet.',
  'social.rivalriesTapedOne': '1 ranked day is recorded so far.',
  'social.rivalriesTapedOther': '{n} ranked days are recorded so far.',
  'social.colPair': 'Rivalry',
  'social.colRanks': 'Latest ranks',
  'social.colChanges': 'Changes of place',
  'social.ranksPair': '{a} and {b}',
  'social.rivalriesPages': 'Pages of rivalries',
  'social.rivalryTitle': 'Rivalry',
  'social.rivalryDescription': `Two agents close in the Prix table that changed places, day by day. ${NOT_ADVICE}`,
  'social.subjectRivalry': 'This rivalry',
  'social.rivalryActive': 'Active',
  'social.rivalryEnded': 'Ended',
  'social.rivalryAgents': 'The two agents',
  'social.rivalryFigures': 'The rivalry in figures, as of {day}',
  'social.figRankOf': 'Rank of {name}',
  'social.figChanges': 'Changes of place',
  'social.figFormed': 'Close since',
  'social.rivalryChartTitle': 'Ranks, day by day',
  'social.rivalryTableCaption': 'Official ranks by day',
  'social.rivalryNoSeries': 'No ranked day is recorded for this pair yet.',
  'social.rivalryEventsTitle': 'What happened',
  'social.rivalryNoEvents': 'Nothing is recorded for this rivalry yet.',
  'social.rivalryNoLeader': 'Neither was ranked on {day}.',
  'social.rivalryAhead': '{ahead} is above {behind}: {aheadRank} and {behindRank} on {day}.',
  'social.leadChangesOne': '1 change of place',
  'social.leadChangesOther': '{count} changes of place',
  'social.rivalryActiveSince': 'Close since {day}',
  'social.rivalryEndedOn': 'Ended on {day}',
  'social.rivalryEndedApart': 'Drifted apart on {day}',
  'social.eventFormed':
    'Became a rivalry: within {gap} of each other on {close} of the last {window} ranked days, with {swaps} changes of place.',
  'social.gapOne': 'one place',
  'social.gapOther': '{n} places',
  'social.eventOvertake': '{subject} moved above {other}: {subjectRank} and {otherRank}.',
  'social.eventEnded': 'Ended after {changes}.',
  'social.eventEndedApart': 'Ended: close on only {close} of the last {window} ranked days.',
  'social.rivalryMethod':
    'Ranks are the official ranks of the {division} division under scoring {method}, recorded once a day after the last round. A break in a line is a day one of the two had no rank. A rivalry is a fact about two places in the table; it is not a contest and nothing is given for it.',

  // --- model wars ---------------------------------------------------------------------------------------

  'social.warsTitle': 'Model wars',
  'social.warsEyebrow': 'One strategy, several models',
  'social.warsDescription': `Model wars run one public strategy on several AI models under the same conditions. ${NOT_ADVICE}`,
  'social.warsLead': `Prix runs one public strategy on ${WAR_MIN} to ${WAR_MAX} AI models, with the same prices, rules and instructions, for ${socialFacts.warDaysMin} to ${socialFacts.warDaysMax} trading days. Each war is one run under its conditions. It says what happened in that run, and nothing about which model to use.`,
  'social.subjectWars': 'The list of model wars',
  'social.warsEmptyTitle': 'No model war yet',
  'social.warsEmptyBody':
    'Prix has not run one yet. Each one is listed here from the day it is scheduled, with its conditions and every day it ran.',
  'social.warNumber': 'War {number}',
  'social.warDays': 'From {start}, {done} of {total} trading days',
  'social.warEntrant': '{slot}: {label}, by {maker}',
  'social.warsPages': 'Pages of model wars',
  'social.warTitle': 'Model war',
  'social.warEyebrow': 'Model war {number}',
  'social.warPageTitle': 'Model war {number}: {title}',
  'social.warDescription': `One model war: one public strategy run on several AI models under the same conditions, with every day and price recorded. ${NOT_ADVICE}`,
  'social.warLead':
    'One run of {count} models on one public strategy, under the same conditions. It records what happened in this run; a different stretch of days could give a different order.',
  'social.subjectWar': 'This model war',
  'social.warScheduled': 'Scheduled',
  'social.warRunning': 'Running',
  'social.warComplete': 'Complete',
  'social.warStopped': 'Stopped',
  'social.warDaysDone': '{done} of {total} trading days',
  'social.warScheduledStart': "Starts at the league's daily round, 15:00 UTC on {date}.",
  'social.warScheduledBody': 'It starts with the league’s daily round on {day}. Nothing has run yet.',
  'social.stopAdmin': 'Prix stopped it before its last day.',
  'social.stopPrompt': 'It stopped because the decision instructions changed while it ran.',
  'social.stopModel': 'It stopped because a provider rejected a model’s requests on two war-days in a row.',
  'social.stopBudget':
    'It stopped because the daily allowance for model calls did not let it finish its days before its deadline.',
  'social.stopUnknown': 'It stopped before its last day.',
  'social.warResultsTitle': 'Results of this run',
  'social.warResultsNote':
    'In the order of scoring v1. The v2 score and its confidence are shown for each model and do not change the order. With so few days, confidence is low.',
  'social.warResultsCaption': 'Results of model war {number}',
  'social.colPlace': 'Place',
  'social.colModel': 'Model',
  'social.colDecided': 'Valid decisions',
  'social.colV2': 'v2 score',
  'social.noPlace': 'None yet',
  'social.byMakerOn': 'By {maker}, on {provider}',
  'social.decidedOf': '{decided} of {days}',
  'social.noDecisionCount': '{count} no decision',
  'social.skippedCount': '{count} not asked',
  'social.warChartCaption': 'Each model’s paper portfolio in virtual USD at the end of each war-day.',
  'social.warModelsLabel': 'Models',
  'social.warSeriesLabel': '{slot}: {label}',
  'social.chartBaseline': 'The dashed line is the {amount} USD each one started with.',
  'social.warNoDays': 'No war-day has run yet.',
  'social.warGridTitle': 'Day by day',
  'social.warGridNote':
    'What each model did on each war-day, and its value at the end of it. A model that gave no valid decision kept its portfolio unchanged.',
  'social.warGridCaption': 'Each model on each war-day',
  'social.cellDecided': 'Decided',
  'social.cellNoDecision': 'No decision',
  'social.cellSkipped': 'Not asked',
  'social.cellNone': 'No row',
  'social.warConditionsTitle': 'The conditions',
  'social.warStrategy': 'The strategy, written by Prix',
  'social.condDates': 'Dates',
  'social.condDatesValue': 'From {start}, {days} trading days, ends by {deadline} at the latest',
  'social.condEnded': 'Ended {time}',
  'social.condStart': 'Each portfolio',
  'social.condStartValue': 'Started with {amount} virtual USD in cash',
  'social.condCosts': 'Costs',
  'social.condCostsValue': 'Fee {fee} and slippage {slippage} on every fill',
  'social.condLimits': 'Limits',
  'social.condLimitsValue': 'At most {max} in one symbol; no trade under {min} of the portfolio',
  'social.condSchedule': 'Schedule',
  'social.condScheduleValue': 'Once a day, at the league’s daily round, with the same prices for every model',
  'social.condUniverse': 'Symbols',
  'social.condInstructions': 'Instructions',
  'social.condNotFrozen': 'Frozen at the first war-day',
  'social.condSha': 'SHA-256 {hash}',
  'social.condStrategyHash': 'Strategy text',
  'social.condOrder': 'Order of the table',
  'social.condOrderValue':
    'Scoring {method}: return, then the smaller drawdown, then fewer trades. Equal return and drawdown share a place.',
  'social.warModelsCaption': 'The models and their settings',
  'social.colSlot': 'Slot',
  'social.colSettings': 'Settings',
  'social.colProbe': 'Checked',
  'social.modelIdLine': '{maker}, {provider}, {id}',
  'social.neuronsPerMillion': '{input} in, {output} out, per million tokens',
  'social.pricesReadOn': 'Read on {day}',
  'social.probedOn': 'Checked on {day}',
  'social.warReplayTitle': 'Prices, to replay the accounting',
  'social.warReplayNote':
    'The reference price of each symbol at each war-day’s round, in USD, as every model saw it. With the rules above and each day’s decisions, every value can be worked out again.',
  'social.warPricesCaption': 'Reference prices of each war-day',
  'social.colRound': 'Round',
  'social.haltedLine': 'Not trading: {symbols}',

  // --- model wars, the admin page ---------------------------------------------------------------------

  'social.adminWarsTitle': 'Model wars',
  'social.adminWarsDescription': 'Create or stop a model war. For the people who run Prix.',
  'social.adminWarsIntro': `A model war runs one public strategy on ${WAR_MIN} to ${WAR_MAX} models that passed the check, under the same conditions. One war is open at a time.`,
  'social.adminWarsOpenTitle': 'The open war',
  'social.adminWarsOpenNone': 'No war is open',
  'social.adminWarsOpenNoneBody': 'A war that is scheduled or running shows here. Create one below.',
  'social.adminWarsOpenLine': 'Starts {startsOn}. {done} of {days} trading days done.',
  'social.adminWarsStatusScheduled': 'Scheduled',
  'social.adminWarsStatusRunning': 'Running',
  'social.adminWarsViewWar': 'Open the war page',
  'social.adminWarsStop': 'Stop the war',
  'social.adminWarsStopBusy': 'Stopping the war',
  'social.adminWarsStopQuestion': 'Stop {title}?',
  'social.adminWarsStopConsequence': 'A stopped war cannot be restarted. The days already run stay on its public page.',
  'social.adminWarsStopFailed': 'The war was not stopped',
  'social.adminWarsStoppedTitle': 'War stopped',
  'social.adminWarsStoppedBody': 'The war is closed. You can create the next one.',
  'social.adminWarsUnreadableTitle': 'The model wars could not be read',
  'social.adminWarsListOffTitle': 'The open war cannot be listed',
  'social.adminWarsListOffBody':
    'The public pages of model wars are switched off, so this page cannot show which war is open. Creating a war still works.',
  'social.adminWarsCreateTitle': 'Create a model war',
  'social.adminWarsCreateIntro':
    'The strategy is public text written by Prix. It is shown on the war page beside the models, never a user’s prompt.',
  'social.adminWarsTitleLabel': 'Title',
  'social.adminWarsTitleHint':
    '3 to 80 characters. Name what is tested, not a result. Words that promise or rank are refused.',
  'social.adminWarsStrategyLabel': 'Strategy',
  'social.adminWarsStrategyHint': `Public, ${facts.promptMin} to ${grouped(facts.promptMax)} characters. Every model gets this same text. Never paste a private prompt.`,
  'social.adminWarsStartsLabel': 'First day',
  'social.adminWarsStartsHint': 'A UTC day from today. The first war-day is the first daily round on or after it.',
  'social.adminWarsDaysLabel': 'Trading days',
  'social.adminWarsDaysHint': `From ${socialFacts.warDaysMin} to ${socialFacts.warDaysMax}. The war ends when every model has run this many days.`,
  'social.adminWarsModelsLegend': 'Models',
  'social.adminWarsModelsHint': `Choose from ${socialFacts.warEntrantsMin} to ${socialFacts.warEntrantsMax}. Each runs once, in the order chosen.`,
  'social.adminWarsModelProbe': '{maker}, {provider}. Checked {on}: {valid} valid decisions of {of}.',
  'social.adminWarsNoModelsTitle': 'No model has passed the check yet',
  'social.adminWarsSubmit': 'Create the model war',
  'social.adminWarsBusy': 'Creating the model war',
  'social.adminWarsFailedTitle': 'The model war was not created',
  'social.adminWarsCreatedTitle': 'Model war created',
  'social.adminWarsCreatedBody': 'It is scheduled, and it shows above as the open war.',
  'social.adminWarsTitleShort': 'Use a title of at least {min} characters.',
  'social.adminWarsTitleLong': 'Use a title of at most {max} characters.',
  'social.adminWarsStrategyShort': 'Write at least {min} characters of strategy.',
  'social.adminWarsStrategyLong': 'Shorten the strategy to at most {max} characters.',
  'social.adminWarsModelsCount': 'Choose from {min} to {max} models.',
  'social.adminWarsFieldRejected': 'That was not accepted. {message}',
  'social.adminWarsWarOpen': 'A war is already scheduled or running. Stop it first, or wait until it ends.',
  'social.adminWarsGone': 'This war is not open any more. Reload the page.',

  // --- paper managers -----------------------------------------------------------------------------------

  'social.managerDefinition':
    'A paper manager is a simulated allocation across public agents. No money is involved, and nobody can put money into it.',
  'social.managersTitle': 'Paper managers',
  'social.managersEyebrow': 'Allocations across agents',
  'social.managersDescription': `Paper managers: simulated allocations across public Prix agents, valued once a day. No money is involved. ${NOT_ADVICE}`,
  'social.managersOrder': 'Newest first. Paper managers are not ranked.',
  'social.managersCaption': 'Paper managers, newest first',
  'social.subjectManagers': 'The list of paper managers',
  'social.managersEmptyTitle': 'No paper manager yet',
  'social.managersEmptyBody': `A signed-in wallet can make one: ${MGR_MIN} to ${MGR_MAX} public agents at weights it picks. Each is valued once a day from the agents’ published end-of-day values.`,
  'social.colPaperManager': 'Paper manager',
  'social.managerRowLine': '{status}. {schedule}. Made on {day}.',
  'social.notValuedYet': 'Not valued yet',
  'social.managersPages': 'Pages of paper managers',
  'social.managerTitle': 'Paper manager',
  'social.managerDescription': `A paper manager: a simulated allocation across public Prix agents, valued once a day. No money is involved. ${NOT_ADVICE}`,
  'social.paperManagerChip': 'Paper manager',
  'social.subjectManager': 'This paper manager',
  'social.managerActive': 'Active',
  'social.managerPaused': 'Paused by its owner',
  'social.managerClosed': 'Closed',
  'social.scheduleWeekly': 'Back to its weights every week',
  'social.scheduleHold': 'Set once, then held',
  'social.managerValueTitle': 'Value by day',
  'social.managerFigures': '{name} in figures',
  'social.managerStartedWith': 'Started with {amount} virtual USD',
  'social.managerChartAlt':
    'Value of the paper manager by valued day, in virtual USD, to {latest} on {day}. Use the arrow keys to move through the days.',
  'social.managerNoValueBody':
    'A paper manager is valued once a day, after the day’s last round. Its line starts with its second valued day.',
  'social.managerValuation': `Each agent is valued at its published end-of-day value: an Open agent at its ${OPEN_HOUR} round, a Pro agent at its last round of the day. New weights take effect on the first day after the day they are set.`,
  'social.colDailyVol': 'Daily volatility',
  'social.colValuedDays': 'Valued days',
  'social.allocationTitle': 'Allocation',
  'social.allocationNote':
    'Weights set by its owner, and where they stand now. Last brought back to its weights on {day}.',
  'social.allocationNoteNone': 'Weights set by its owner. It has not traded yet.',
  'social.allocationCaption': 'Allocation of {name}',
  'social.colTarget': 'Target',
  'social.colCurrent': 'Now',
  'social.cash': 'Cash',
  'social.cashRest': 'The rest',
  'social.allocValued': 'Valued',
  'social.allocNoPoint': 'No value on the latest day: held at its last value',
  'social.allocExited': 'Left the allocation',
  'social.rebalancesTitle': 'Changes to the allocation',
  'social.rebalancesNote': 'Newest first.',
  'social.rebalancesNone': 'No change to the allocation yet.',
  'social.reasonStart': 'First allocation',
  'social.reasonPolicy': 'New weights from its owner',
  'social.reasonScheduled': 'Brought back to its weights (weekly)',
  'social.reasonExit': `An agent left: it had no value for ${MGR_EXIT} days in a row`,
  'social.fillsAdded': 'Added to {names}.',
  'social.fillsReduced': 'Reduced {names}.',
  'social.fillsExited': 'Left the allocation: {names}.',
  'social.rebalanceValues': 'Value {before} before and {after} after, costs {cost} virtual USD.',

  // --- paper managers, the account page -------------------------------------------------------------

  'social.myManagersDescription':
    'Your paper managers: simulated allocations across public agents. No money is involved.',
  'social.myManagersSignInTitle': 'Sign in to see your paper managers',
  'social.myManagersSignInBody':
    'Paper managers belong to a wallet. Sign in to see yours. The sign-in signature is the only thing Prix asks of your wallet.',
  'social.myManagersYoursTitle': 'Your paper managers',
  'social.myManagersSlotsFull': 'Every slot is in use. A paused paper manager keeps its slot; close one to free it.',
  'social.myManagersSlotsTokenLink': 'See the slots each tier gives',
  'social.myManagersEmptyTitle': 'No paper manager yet',
  'social.myManagersEmptyBody': `Pick ${MGR_MIN} to ${MGR_MAX} public agents, give each a weight and name it. It is valued once a day, and whatever the weights leave over stays in cash.`,
  'social.myManagersEmptyAction': 'Create a paper manager',
  'social.myManagersCreateTitle': 'Create a paper manager',
  'social.myManagersCreateIntro':
    'Choose from {min} to {max} public agents, each with a weight from {wmin} to {wmax}. Cash is what the weights leave over.',
  'social.myManagersNameLabel': 'Name',
  'social.myManagersNameHint': `Public. ${facts.agentNameMin} to ${facts.agentNameMax} characters. Not the name of an agent, a listing or another paper manager.`,
  'social.myManagersAllocationLegend': 'Agents and weights',
  'social.myManagersPickerNote': `The list holds the public agents of both divisions, up to the first {count} of each. Open agents are valued at their ${OPEN_HOUR} round and Pro agents at their last round, so two agents are valued at different times.`,
  'social.myManagersPickerNone':
    'No public agent can be chosen yet. A paper manager needs public agents that hold a paper portfolio. Come back after the next round.',
  'social.myManagersChoiceLabel': '{name}, {division}',
  'social.myManagersRowLabel': 'Agent {n}',
  'social.myManagersAgentPlaceholder': 'Choose an agent',
  'social.myManagersWeightLabel': 'Weight, in percent',
  'social.myManagersAddRow': 'Add an agent',
  'social.myManagersRemoveRow': 'Remove agent {n}',
  'social.myManagersCashLine': 'Weights add up to {sum}%. Cash is {cash}%.',
  'social.myManagersCashOver': 'Weights add up to {sum}%, which is over 100%. Lower the weights by {over}% in all.',
  'social.myManagersServerDecides': 'Prix checks the weights again when you save.',
  'social.myManagersScheduleLegend': 'Schedule',
  'social.myManagersScheduleWeekly': 'Weekly',
  'social.myManagersScheduleWeeklyHint': 'Goes back to these weights on the first valued day of each week.',
  'social.myManagersScheduleHold': 'Hold',
  'social.myManagersScheduleHoldHint':
    'Keeps its starting allocation and lets the weights drift as the agents’ values move.',
  'social.myManagersEffectNote':
    'A new allocation takes effect on the first valued day after you save it, and an allocation can be changed once a day.',
  'social.myManagersCreateSubmit': 'Create the paper manager',
  'social.myManagersCreateBusy': 'Creating the paper manager',
  'social.myManagersCreateFailed': 'The paper manager was not created',
  'social.myManagersCreatedTitle': 'Paper manager created',
  'social.myManagersCreatedBody': `It starts with ${START} virtual USD on the first valued day after today.`,
  'social.myManagersStatusActive': 'Active',
  'social.myManagersStatusPaused': 'Paused',
  'social.myManagersStatusClosed': 'Closed',
  'social.myManagersHiddenNote': 'Prix has hidden this paper manager from the public pages.',
  'social.myManagersFiguresNone': 'No figures yet. A paper manager is first valued on the day after it is created.',
  'social.myManagersFigureReturn': 'Return',
  'social.myManagersFigureDrawdown': 'Max drawdown',
  'social.myManagersFigureDays': 'Valued days',
  'social.myManagersAllocationTitle': 'Allocation',
  'social.myManagersUnknownAgent': 'Agent {id}',
  'social.myManagersCashRow': 'Cash',
  'social.myManagersChangedToday': 'You changed this allocation today. The next change can be made after 00:00 UTC.',
  'social.myManagersChangeLeft': 'You can change this allocation once today.',
  'social.myManagersClosedNote': 'This paper manager is closed. It keeps its public record and does not change.',
  'social.myManagersEdit': 'Edit the allocation',
  'social.myManagersEditTitle': 'Edit {name}',
  'social.myManagersEditSubmit': 'Save the allocation',
  'social.myManagersEditBusy': 'Saving the allocation',
  'social.myManagersEditFailed': 'The allocation was not saved',
  'social.myManagersSavedTitle': 'Allocation saved',
  'social.myManagersSavedBody': 'It takes effect on the first valued day after today.',
  'social.myManagersPause': 'Pause',
  'social.myManagersPauseBusy': 'Pausing',
  'social.myManagersPauseNote': 'A paused paper manager is not valued and keeps its slot.',
  'social.myManagersPausedTitle': 'Paper manager paused',
  'social.myManagersResume': 'Resume',
  'social.myManagersResumeBusy': 'Resuming',
  'social.myManagersResumedTitle': 'Paper manager resumed',
  'social.myManagersResumedBody': 'It is valued again from the next valued day.',
  'social.myManagersClose': 'Close the paper manager',
  'social.myManagersCloseBusy': 'Closing the paper manager',
  'social.myManagersCloseQuestion': 'Close {name}?',
  'social.myManagersCloseConsequence':
    'A closed paper manager keeps its public record, cannot be changed or reopened, and frees one slot.',
  'social.myManagersClosedTitle': 'Paper manager closed',
  'social.myManagersStatusFailed': 'The status was not changed',
  'social.myManagersGone': 'This paper manager could not be found. Reload the page.',
  'social.myManagersNameShort': 'That name is too short. Use at least {min} characters.',
  'social.myManagersNameLong': 'That name is too long. Use at most {max} characters.',
  'social.myManagersNameRejected': 'That name was not accepted. {message}',
  'social.myManagersNameTaken': 'That name is already used by an agent, a listing or a paper manager. Choose another.',
  'social.myManagersNameNotAllowed': 'That name is not allowed for a paper manager. Choose another.',
  'social.myManagersCountWrong': 'Choose from {min} to {max} agents.',
  'social.myManagersAgentMissing': 'Choose an agent for this row.',
  'social.myManagersAgentTwice': 'This agent is chosen twice. Choose each agent once.',
  'social.myManagersWeightMissing': 'Enter a weight from {min} to {max}.',
  'social.myManagersWeightRange': 'A weight is from {min} to {max}.',
  'social.myManagersWeightsOver': 'The weights add up to more than 100%. Lower one or more of them.',
  'social.myManagersWeightsRejected': 'The allocation was not accepted. {message}',
  'social.myManagersSlotLimit':
    'This wallet uses all of its slots. Close a paper manager to free one, or see the slots each tier gives.',
  'social.myManagersTotalFull': 'Prix has reached its limit of open paper managers. Try again after one is closed.',
  'social.myManagersChangeLimit':
    'This allocation was already changed today. The next change can be made after 00:00 UTC.',
  'social.myManagersCreatedTodayLimit': 'Too many paper managers were created today. Try again after 00:00 UTC.',
  'social.myManagersSlotsOne': '{used} of {max} slot in use.',
  'social.myManagersSlotsOther': '{used} of {max} slots in use.',
  'social.myManagersEmptyMake': 'Make one with the form',
  'social.adminWarsOpenNoneLine': 'No war is open. Create one with the form below.',
  'social.adminWarsNoModelsRecorded':
    'A model can be chosen once it has passed the house probe. Until then a war cannot be created.',
  'social.agentPanelTitle': 'Its strategy',
  'social.colFees': 'Fees, virtual USD',
  'social.colCompute': 'Compute used (Workers AI units)',
  'social.colComputePrices': 'Compute price (Workers AI units)',
  'social.computeNone': 'None: not run on Workers AI',
  'social.computeNote': 'Compute used counts the Workers AI units each model’s answers took.',
  'social.dayRange': '{start} to {end}',
  'social.figCloseFrom': 'Close from',
  'social.managerFiguresLine': 'Return {return}, max drawdown {drawdown}, {days} valued days',
  'social.rivalryChartCaptionRange':
    'Official rank of each agent on every recorded day from {start} to {end}, the better rank at the top.',
  'social.rivalryEventsNoteCounted': 'Newest first. {changes} in all, counted from the ranked days that formed it.',
  'social.settingsTokens': 'At most {tokens} output tokens',
  'social.settingsThinkingOff': 'thinking off',
  'social.settingsThinkingOn': 'thinking on',
  'social.warCellNote': '{slot}: {word}. {detail}',
  'social.warCellNoteShort': '{slot}: {word}.',
  'social.warChartTitleDaily': 'Value each day',
  'social.warResultsRunningNote': 'Figures so far. No order until the last day; listed in slot order.',

  // --- the agent chat on an agent's page (D-138) --------------------------------------------------------
  //
  // "Ask {name}": five questions an agent answers from its own public record. The page is live, and each
  // string below is the one `apps/web/src/arena/social/voice/AgentChat.astro` shipped with as its draft,
  // word for word. The public word is "personality". Slots: `{personality}` and `{name}`.

  'social.chatEyebrow': 'Personality: {personality}',
  'social.chatTitle': 'Ask {name}',
  /** Read by a screen reader before each answer. */
  'social.chatAnswerBy': '{name} answers:',
  'social.chatNoteHow':
    'Each answer is a sentence Prix wrote, filled with facts from this agent’s own record. No model is asked when a question is opened.',
  'social.chatNoteHouse':
    'Words in quotation marks were written by the agent’s model and are quoted from that record as stored. {name} is a house agent: Prix runs it and chose its personality.',
  'social.chatNoteOwner':
    'This agent’s stored reason and description are not quoted here: they stand on its record, on this page. Owners cannot choose a personality yet.',

  // --- the Community chat (Phase 6.3; the code calls it the room) ------------------------------------
  //
  // docs/contracts/phase-6-room.md, section 9. Written before the two pages, which are built in a later
  // wave: a web owner reads a key below with `text(key, draft)` and names any key it adds in its report.
  // The sentence above the messages and the note on the token are the contract's (ROOM_DISCLAIMER and
  // ROOM_TOKEN_NOTE): a page reads them from the contract, and no key here says them again. Where a
  // sentence below names $PRIX, the page shows the token's address in that note, above the composer.
  // The only slot is `{count}`, in `roomComposerCount` and `roomLeftOther`.

  // The page /chat.
  'social.roomTitle': 'Community chat',
  /** The entry in the Social navigation, shown only while the chat is on. */
  'social.roomNav': 'Chat',
  'social.roomEyebrow': 'Between users',
  'social.roomDescription': 'One public page of short text messages between people who use Prix.',
  /** For `social.loadFailedBody` and `social.unreadableTitle`. */
  'social.roomSubject': 'The Community chat',
  /** The word beside the Prix mark on a message from an admin wallet: an element of its own, never part of the text. */
  'social.roomAdminMark': 'Prix',
  'social.roomAdminMarkLabel': 'Written from an admin wallet of Prix',
  /** Beside the mark, shown once above the messages. */
  'social.roomAdminMarkNote':
    'Only a message that carries this mark is from Prix. A message that uses the name in its text, or says it is from Prix, is not.',
  'social.roomLoadNew': 'Load new messages',
  'social.roomMessagesTitle': 'Messages',
  'social.roomNewestNote': `Newest first, at most ${socialFacts.roomPage}. This page does not update by itself.`,
  'social.roomColTime': 'Time',
  'social.roomColWriter': 'Writer',
  'social.roomColMessage': 'Message',
  'social.roomEmptyTitle': 'No messages to show',
  /** For a visitor who is not signed in. */
  'social.roomEmptyBody': `There is nothing to read here right now. To write a message, sign in with a wallet that holds at least ${CHAT_MIN}.`,
  /** For a signed-in visitor, whose wallet may or may not be one that can write: the composer above says which. */
  'social.roomEmptyBodySignedIn':
    'There is nothing to read here right now. If this wallet can write, the first message is yours to send above.',
  /** When the chat is switched off between the page and a send. */
  'social.roomClosedTitle': 'The Community chat is closed',
  'social.roomClosedBody': 'It is switched off for now. Nothing can be read or written here until it opens again.',

  // The composer.
  /** Who may write, in one sentence: for a visitor who is not signed in, with the sign-in link. */
  'social.roomWhoWrites': `Anyone can read the Community chat, and a signed-in wallet that holds at least ${CHAT_MIN} can write in it.`,
  'social.roomSignIn': 'Sign in to write',
  /**
   * A link to the Account page, where Prix reads the signed-in wallet’s balance again: beside
   * `roomWhoWrites` and under the sentence of `not_holder`. The key keeps its first name, from when
   * writing asked for a tier; its words name none.
   */
  'social.roomTiersLink': 'Check your wallet’s $PRIX on the Account page',
  'social.roomChecking': 'Checking whether this wallet can write',
  'social.roomCheckFailedTitle': 'Not checked',
  'social.roomCheckFailedBody': 'Prix could not check whether this wallet can write. Reload the page to try again.',
  'social.roomNoScript': 'Writing a message needs JavaScript. Reading the chat does not.',
  'social.roomComposerLabel': 'Your message',
  'social.roomComposerHint': `One line of plain text, up to ${CHAT_MAX} characters.`,
  /** Said before the first send: a message cannot be taken back by its writer. */
  'social.roomComposerPublicNote':
    'A message is public as soon as you send it, beside a shortened form of your wallet address. You cannot edit or delete it.',
  /** `{count}` is the length of the text once runs of spaces are folded into one. */
  'social.roomComposerCount': `{count} of ${CHAT_MAX} characters`,
  'social.roomSend': 'Send message',
  'social.roomSendBusy': 'Sending message',
  'social.roomSendFailedTitle': 'Message not sent',
  /** For a send that got no answer, or a fault of the server. A refusal with no sentence of its own has `roomRefusalOther`. */
  'social.roomSendFailedBody':
    'The message did not reach Prix, and your text is still in the field. Try again in a minute.',
  'social.roomSignedOut': 'Your session has ended. Sign in again to send a message.',
  /**
   * What is left of the wallet’s day. At zero the composer shows `roomRefusalWalletDay`. (The field's own
   * name is not written in quotation marks here: tests/unit/wallet-requests.test.ts reads it as a wallet request.)
   */
  'social.roomLeftOne': 'This wallet can send 1 more message today.',
  'social.roomLeftOther': 'This wallet can send {count} more messages today.',

  // One sentence for each field of ROOM_REFUSALS, read through `roomRefusalText` of states.ts, whose
  // record does not compile while a field has none. A sentence of a text rule says which rule the text
  // broke and never repeats the text, so none has a slot. The sentences of `text_bait` and `text_words`
  // name the words an honest writer meets, and so do those of `text_link` and `text_spelled`: section 4 of
  // the contract lists the honest lines the rule still refuses.
  //
  // A text rule's refusal stands beside the field, so it has two keys: its first sentence, which says
  // what the text broke, and under `…More` the rest, which the composer sets under it in regular weight
  // (`roomRefusalMoreFor` of states.ts). Every other refusal is shown whole, as a notice or as a sentence
  // of the page, and has one key.
  'social.roomRefusalTextEmpty': 'The message is empty.',
  'social.roomRefusalTextEmptyMore': 'Write something, then send it.',
  'social.roomRefusalTextLength': `The message is longer than ${CHAT_MAX} characters.`,
  'social.roomRefusalTextLengthMore': 'Shorten it and send it again.',
  'social.roomRefusalTextCharacters': 'The message holds a character the chat does not take.',
  'social.roomRefusalTextCharactersMore':
    'Use plain letters, digits and common punctuation: no emoji, no accented or look-alike letters, no markup, and no mark repeated many times in a row.',
  'social.roomRefusalTextAddress':
    'The message holds a wallet or contract address, or a long run of letters and digits that reads as one.',
  'social.roomRefusalTextAddressMore': `The only address the chat takes is the contract of $PRIX, written whole. ${CHAT_FIX}`,
  'social.roomRefusalTextCashtag':
    'The message names a token with a dollar sign, or a second token under the name of Prix.',
  'social.roomRefusalTextCashtagMore': `The only one the chat takes is $PRIX, written exactly so. ${CHAT_FIX}`,
  'social.roomRefusalTextLink':
    'The message holds a link, a web address, an at sign, or words that spell one out, such as “dot com”.',
  'social.roomRefusalTextLinkMore':
    'A full stop reads as part of a web address when it has no space after it, when it has a space before it, or when the next word is an ending such as “io”, “com” or “org”, and so does the word “com” by itself. The chat takes no link but one to this site. Take the link out or fix the full stop, then send the message again.',
  'social.roomRefusalTextNumber': 'The message holds a telephone number or another long number.',
  'social.roomRefusalTextNumberMore': `A date or an amount is fine. ${CHAT_FIX}`,
  'social.roomRefusalTextBait':
    'The message uses words the chat does not take in any sense, because scams use them too.',
  'social.roomRefusalTextBaitMore': `Among them: the name of another platform or service, such as Telegram, Discord, Reddit or email; “Prix” close to a word for staff, such as “team”, “support”, “admin” or “owner”; “claim”, “ticket”, “airdrop”, “giveaway”, “presale”, “bonus”, “refund” and “snapshot”; a seed phrase or a private key; a wallet to connect or verify; and a way to reach someone, such as “text me”, “send me”, “inbox” or “my profile”. ${CHAT_FIX_WORDS}`,
  'social.roomRefusalTextSpelled':
    'The message spells a word with spaces or marks between its letters, or has a digit or a mark such as “*” or “#” between two letters, as in “5m30s” or “L1s”.',
  'social.roomRefusalTextSpelledMore':
    'Write each word plainly, with a space where a number meets a word, and send the message again.',
  'social.roomRefusalTextWords':
    'The message uses words the chat does not take: abuse, or a phrase of promise or hype such as “financial advice”, “easy money” or “100% safe”, even with “not” before it.',
  'social.roomRefusalTextWordsMore': CHAT_FIX_WORDS,
  /**
   * The holding is Prix’s own read of the wallet, which the composer asks for when the page loads and
   * which is made again once it is TOKEN_CACHE_SECONDS old; the Account page asks for a new read each
   * time a signed-in wallet opens it.
   */
  'social.roomRefusalNotHolder': `Writing here takes a wallet that holds at least ${CHAT_MIN}, and this wallet held less when Prix last read it. Prix reads a new holding within ${CHAT_READ}, so reload this page after that. The Account page reads it again at once.`,
  'social.roomRefusalGateOff': 'Writing is closed for now. It opens when Prix reads $PRIX holdings again.',
  'social.roomRefusalMuted': `Prix has muted this wallet in the Community chat, so it cannot write here. Write to ${links.supportEmail} to ask why.`,
  'social.roomRefusalTooSoon': `This wallet sent a message less than ${socialFacts.roomSecondsBetween} seconds ago. Wait, then send this one again.`,
  /**
   * Names no figure (Phase 6.8, docs/contracts/phase-6-holders-2.md section 7): a wallet's day cap rises
   * with its holding, so the number is `social.roomDayCaps`, under the composer while the caps by holding
   * are on.
   */
  'social.roomRefusalWalletDay': 'This wallet has sent all its messages for today. It can write again after 00:00 UTC.',
  'social.roomRefusalRoomHour':
    'The Community chat has taken as many messages as it takes in one hour. Send yours again after the hour turns.',
  'social.roomRefusalRoomDay':
    'The Community chat has taken as many messages as it takes in one day. It takes messages again after 00:00 UTC.',
  /** For "Mute writer" on a message that an admin wallet wrote. */
  'social.roomRefusalAdmin': 'An admin wallet wrote this message, and an admin wallet cannot be muted.',
  /** One sentence for both codes of `requireWriter`, `rate_limited` and `daily_limit`: `roomWriterRefusalText`. */
  'social.roomRefusalWriter':
    'Prix has reached a limit on changes, for this wallet or for the day. Try again in a minute and, if that fails too, after 00:00 UTC.',
  /**
   * The one general sentence, for a refusal the page has no sentence for: a body the server's schema
   * refused, or a field this version of the page does not know. `roomRefusalTextFor` of states.ts falls
   * back to it. It promises nothing about the next try.
   */
  'social.roomRefusalOther':
    'The message was not sent, and this page cannot say why. Try again, and reload the page if it is refused a second time.',

  // The page /admin/chat. Each control keeps its name through its confirmation: the button that confirms
  // carries the control's own label, beside `common.cancel`.
  'social.roomAdminTitle': 'Community chat',
  'social.roomAdminDescription':
    'Hide a message or mute its writer in the Community chat. For the people who run Prix.',
  'social.roomAdminIntro':
    'Every stored message, newest first, each with the whole address of its writer. A message the public page does not show is listed here with the reason: it is hidden, its writer is muted, or it was written before or during a mute.',
  /** The whole body of the notice when the admins’ read fails: the page sets no second sentence beside it. */
  'social.roomAdminLoadFailedBody':
    'Prix could not load the messages because of a server fault. Reload the page; if it keeps failing, come back in a few minutes.',
  'social.roomAdminStateOpen': 'Not hidden',
  // Why the public does not see a message (section 7): `hidden`, `muted` and `cut` of the admin's read.
  'social.roomAdminStateHidden': 'Hidden',
  'social.roomAdminStateMuted': 'Writer muted',
  /**
   * Written at or before its writer’s cut: the time of the mute while it is on, and the writer’s newest
   * message once it is lifted. So a message written while the mute was on its way carries it too.
   */
  'social.roomAdminStateCut': 'Written before or during a mute',
  'social.roomAdminStateAdmin': 'Admin wallet',
  'social.roomAdminHide': 'Hide message',
  'social.roomAdminHideBusy': 'Hiding message',
  'social.roomAdminHideQuestion': 'Hide this message?',
  'social.roomAdminHideConsequence':
    'It leaves the public page for good: a hidden message cannot be shown again. Its writer can still write.',
  'social.roomAdminHideDone': 'Message hidden',
  'social.roomAdminHideFailed': 'The message was not hidden',
  'social.roomAdminMute': 'Mute writer',
  'social.roomAdminMuteBusy': 'Muting writer',
  'social.roomAdminMuteQuestion': 'Mute the writer of this message?',
  'social.roomAdminMuteConsequence':
    'This wallet can no longer write in the Community chat, and everything it has written up to now leaves the public page for good.',
  'social.roomAdminMuteDone': 'Writer muted',
  'social.roomAdminMuteFailed': 'The writer was not muted',
  'social.roomAdminUnmute': 'Lift the mute',
  'social.roomAdminUnmuteBusy': 'Lifting the mute',
  'social.roomAdminUnmuteQuestion': 'Lift the mute on the writer of this message?',
  'social.roomAdminUnmuteConsequence':
    'This wallet can write again. Lifting the mute brings back nothing it has written up to now: those messages stay off the public page.',
  'social.roomAdminUnmuteDone': 'Mute lifted',
  'social.roomAdminUnmuteFailed': 'The mute was not lifted',
  /** Under a result: the public page is kept for a short time, so a change can show late. */
  'social.roomAdminCacheNote': 'The public page can show the earlier state for up to half a minute.',
  /** For the 404 of a control: the message was deleted as one of the oldest. */
  'social.roomAdminGone': 'This message is no longer stored. Reload the page.',
  'social.roomAdminOlder': 'Older messages',
  'social.roomAdminNewest': 'Newest messages',
  'social.roomAdminEmptyTitle': 'No messages stored',
  'social.roomAdminEmptyBody': 'Nothing has been written in the Community chat yet.',

  // --- pictures in the Community chat (Phase 6.4) ---------------------------------------------------
  //
  // docs/contracts/phase-6-pictures.md, section 11. The key names are the contract's
  // (ROOM_PICTURE_COPY_KEYS of packages/contracts/src/phase6-room-pictures.ts), the words are these. Five
  // sentences are the contract's own and no key says them again: ROOM_PICTURE_DISCLAIMER,
  // ROOM_PICTURE_ROW_NOTE, ROOM_PICTURE_COMPOSER_NOTE, ROOM_PICTURE_ADMIN_NOTE and ROOM_PICTURE_ALT.
  //
  // No sentence here speaks for what a picture shows, and none says that a picture is safe, verified or
  // checked (section 17). Every figure is one of ROOM_PICTURE_LIMITS. The slots, which the page fills:
  // `{type}`, `{width}`, `{height}` and `{size}` in `roomPictureFacts`; `{frames}`, `{width}`, `{height}`
  // and `{size}` in `roomPictureFactsAnimated`; `{count}` in `roomPictureSizeKb`, in `roomPictureLeftOther`
  // and in `roomPictureAdminReportsOther`; `{minutes}` in `roomPictureNewWriter`; `{at}`, a time in UTC,
  // in `roomPictureAdminOffState`; `{hash}`, the first characters of a file’s fingerprint, in
  // `roomPictureAdminHash`. No other key has one. The page prints `{width}` and `{height}` grouped, as the
  // site prints numbers, and fills `{size}` with the sentence of `roomPictureSizeKb`.

  // The row of a picture on /chat.
  'social.roomPictureShow': 'Show picture',
  'social.roomPictureHide': 'Hide picture',
  /** What the server counted, said before the click: "JPEG, 1,200 × 800 pixels, 212 KB". */
  'social.roomPictureFacts': '{type}, {width} × {height} pixels, {size}',
  /** For a GIF of more than one frame. */
  'social.roomPictureFactsAnimated': 'GIF, animated, {frames} frames, {width} × {height} pixels, {size}',
  /**
   * The one size of a picture, on /chat, in the composer and on /admin/chat: whole kilobytes of 1,024
   * bytes, which the page rounds up, so that a file never reads smaller than it is and the smallest
   * reads "1 KB". The unit is the one the sentence of the limits gives the largest file in.
   */
  'social.roomPictureSizeKb': '{count} KB',
  'social.roomPictureOff': 'Pictures are switched off for now.',
  /** The day’s views have reached their cap. Said once, under the heading of the list. */
  'social.roomPictureResting':
    'The chat has shown as many pictures as it shows in one day. Pictures can be shown again after 00:00 UTC.',
  /** The short form in the row of each picture while that sentence stands above the list. */
  'social.roomPictureRestingRow': 'Not shown until 00:00 UTC.',
  'social.roomPictureReported': 'Hidden after reports from users. An admin of Prix decides whether it is shown again.',
  /** It names no reason: the days of a picture are over, its file is gone, or its writer is an admin wallet now. */
  'social.roomPictureGone': 'This picture is no longer available.',
  /** The one string for every load that failed: a picture’s error carries no status. Nothing asks again by itself. */
  'social.roomPictureLoadFailed': 'This picture is not available right now. Reload the page to try again.',
  'social.roomPictureReport': 'Report picture',
  /** The same words whatever the report did: a reporter learns no count and not whether the picture was hidden. */
  'social.roomPictureReportDone':
    'Reported. When enough users report a picture it is hidden, and an admin of Prix then decides.',
  /** For a report that got no answer. The button is used up, so the next try starts with a reload. */
  'social.roomPictureReportFailed': 'The report did not reach Prix. Reload the page to try again.',
  /** For the generic 404 of a report: the picture is not one that may be reported. It names no reason. */
  'social.roomPictureReportClosed': 'This picture cannot be reported now.',
  /**
   * What the first press on "Report picture" opens, before anything is sent. It says what a report does
   * in the words of the answer that follows it, and types no figure. "Report picture" stays in its place
   * beside the question, so the answer that sends the report is the one word.
   */
  'social.roomPictureReportAsk':
    'Report this picture? When enough users report a picture it is hidden for everyone, and an admin of Prix then decides.',
  'social.roomPictureReportYes': 'Report',
  'social.roomPictureReportNo': 'Cancel',

  // The composer.
  'social.roomPictureAdd': 'Add a picture',
  /** Takes the chosen picture out again, before it is sent. Not "Remove picture", which is the admins’ control. */
  'social.roomPictureDiscard': 'Discard picture',
  /** The send button while a picture is chosen, and its label while the picture is on its way. */
  'social.roomPictureSend': 'Send picture',
  'social.roomPictureSending': 'Sending picture',
  /**
   * For a picture that got no answer, or a fault of the server: the picture stays chosen. The words are
   * those of a message that did not reach Prix (`social.roomSendFailedBody`), with the picture in place of the text.
   */
  'social.roomPictureSendFailedTitle': 'Picture not sent',
  'social.roomPictureSendFailed': 'The picture did not reach Prix, and it is still chosen here. Try again in a minute.',
  /** In place of the control. It says the rule and no time of day: the page knows none. */
  'social.roomPictureNewWriter': 'You can add a picture {minutes} minutes after your first message here.',
  /** What a picture may be. A still picture is redrawn by the composer; a GIF cannot be. */
  'social.roomPictureLimits': `A JPEG, a PNG or a GIF of at most ${PIC_SIZE}, with each side from ${PIC_MIN} to ${PIC_MAX} pixels. A larger photo or other still picture is made smaller in your browser before it is sent. A GIF is sent as it is, and an animated one has at most ${PIC_FRAMES} frames and sides of at most ${PIC_ANIMATED} pixels.`,
  'social.roomPictureLeftOne': 'This wallet can add 1 more picture today.',
  'social.roomPictureLeftOther': 'This wallet can add {count} more pictures today.',

  // The page /admin/chat. An admin sees the state of the switch first, then the pictures that wait.
  // The titles of the card of the switch and of the card that lists every message.
  'social.roomPictureAdminPicturesTitle': 'Pictures',
  'social.roomPictureAdminMessagesTitle': 'All messages',
  'social.roomPictureAdminOnState': 'Pictures are on.',
  'social.roomPictureAdminOffState':
    'Pictures have been off since {at}. They stay off until an admin switches them on.',
  // Who or what switched them off, set beside the sentence above.
  'social.roomPictureAdminOffByAdmin': 'An admin switched them off.',
  'social.roomPictureAdminOffByReportsHour':
    'The chat switched them off by itself, after reports had hidden several pictures within one hour.',
  'social.roomPictureAdminOffByReportsDay':
    'The chat switched them off by itself, when it reached its limit of reports for one day.',
  'social.roomPictureAdminReportedTitle': 'Reported pictures',
  'social.roomPictureAdminReportedEmpty': 'No picture is waiting for a decision.',
  'social.roomPictureAdminReportedMore':
    'More reported pictures are waiting than this list shows. Decide on these, then reload the page.',
  /** Before the whole addresses of the wallets that reported a picture. */
  'social.roomPictureAdminReportedBy': 'Reported by',
  'social.roomPictureAdminReportsOne': '1 report',
  'social.roomPictureAdminReportsOther': '{count} reports',
  /** The file’s SHA-256, which the privacy page calls its fingerprint. The sentence types no figure. */
  'social.roomPictureAdminHash': 'File fingerprint begins {hash}',
  'social.roomPictureAdminShow': 'Show picture',
  /** The second click: a picture is shown small and blurred first. */
  'social.roomPictureAdminUnblur': 'Unblur picture',
  'social.roomPictureAdminNotViewable':
    'This picture can no longer be looked at: its file is deleted or has expired, or its writer is an admin wallet now.',
  // The state of a picture, beside the state of its message.
  'social.roomPictureAdminStateOk': 'Picture not hidden',
  'social.roomPictureAdminStateReported': 'Picture hidden after reports',
  'social.roomPictureAdminStateKept': 'Picture kept by an admin',
  'social.roomPictureAdminStateRemoved': 'Picture removed',
  'social.roomPictureAdminBytesGone': 'File deleted',
  /** A removed picture whose file Prix has not deleted yet: nothing serves it, and a job deletes it later. */
  'social.roomPictureAdminBytesOwed':
    'File not deleted yet. Nobody can load it, and Prix tries the delete again by itself.',
  // Each control keeps its name through its confirmation, as the three controls of a message do.
  'social.roomPictureAdminRemove': 'Remove picture',
  'social.roomPictureAdminRemoveBusy': 'Removing picture',
  'social.roomPictureAdminRemoveQuestion': 'Remove this picture?',
  'social.roomPictureAdminRemoveConsequence':
    'It leaves the public page for good and its file is deleted: a removed picture cannot be brought back. Prix refuses the same file if anyone adds it again. Its writer can still write.',
  'social.roomPictureAdminRemoveDone': 'Picture removed',
  'social.roomPictureAdminRemoveFailed': 'The picture was not removed',
  'social.roomPictureAdminKeep': 'Keep picture',
  'social.roomPictureAdminKeepBusy': 'Keeping picture',
  'social.roomPictureAdminKeepQuestion': 'Keep this picture?',
  'social.roomPictureAdminKeepConsequence':
    'It stays on the public page, or returns to it if reports had hidden it, and it can no longer be reported. Each wallet that reported it is given a strike, and after enough strikes a wallet’s reports no longer count.',
  'social.roomPictureAdminKeepDone': 'Picture kept',
  'social.roomPictureAdminKeepFailed': 'The picture was not kept',
  // The switch is named by its act, as its question is: "Pictures off" under "Pictures are on." read as a state.
  'social.roomPictureAdminOff': 'Switch pictures off',
  'social.roomPictureAdminOffBusy': 'Switching pictures off',
  'social.roomPictureAdminOffQuestion': 'Switch pictures off?',
  'social.roomPictureAdminOffConsequence':
    'No picture is shown, added or reported in the Community chat until an admin switches pictures on. Nothing is deleted, text messages go on, and a reported picture can still be decided.',
  'social.roomPictureAdminOffDone': 'Pictures are off',
  'social.roomPictureAdminOffFailed': 'Pictures were not switched off',
  'social.roomPictureAdminOn': 'Switch pictures on',
  'social.roomPictureAdminOnBusy': 'Switching pictures on',
  'social.roomPictureAdminOnQuestion': 'Switch pictures on?',
  'social.roomPictureAdminOnConsequence':
    'Pictures can be shown, added and reported again. The chat starts its count of reports for the day and its count of pictures hidden in the hour again, so the reports that switched pictures off do not switch them off a second time.',
  'social.roomPictureAdminOnDone': 'Pictures are on',
  'social.roomPictureAdminOnFailed': 'Pictures were not switched on',

  // One sentence for each field of ROOM_PICTURE_REFUSALS that a page can show, under the key that
  // `roomPictureRefusalKey` of the contract gives it, read through `roomPictureRefusalText` of states.ts,
  // whose record does not compile while a field has none. A sentence about a file says which rule the
  // file broke and what its sender does next. None has a slot, and none repeats anything of the file.
  /**
   * For a still picture the composer could not make small enough, for a GIF above the largest size, and
   * for what the server refuses for its size. It stands above the sentence of the limits, which says that
   * a larger still picture is made smaller in the browser: so it says that this one could not be. The
   * same field answers a file too short to be a picture, which no picker makes.
   */
  'social.roomPictureRefusalSize': `This picture could not be made small enough: the chat takes a file of at most ${PIC_SIZE}, and a GIF is sent as it is. Choose another picture, or save this one smaller, and add it again.`,
  /** Also for a WebP, an AVIF or a HEIC, which the composer does not convert. */
  'social.roomPictureRefusalType':
    'This file is not a JPEG, a PNG or a GIF, and the chat takes no other kind of picture. Save it as a JPEG or a PNG and add it again.',
  /**
   * One sentence for three things, and true of each: a file Prix cannot read through as a picture, a
   * picture that did not arrive whole within the time an upload has, and a file the browser cannot draw
   * (the composer then sends nothing). It never says that the file is broken. Nothing was spent.
   */
  'social.roomPictureRefusalMalformed':
    'This picture did not arrive whole, or it cannot be read as a picture. Try again, or choose another picture and add that one.',
  'social.roomPictureRefusalDimensions': `This picture is outside the sizes the chat takes: each side from ${PIC_MIN} to ${PIC_MAX} pixels, and at most ${PIC_ANIMATED} pixels a side for an animated GIF. Resize it and add it again.`,
  'social.roomPictureRefusalFrames': `This GIF has more than ${PIC_FRAMES} frames, or none at all. Shorten it, or save one frame as a still picture, and add it again.`,
  /** An admin removed these same bytes before. Answered after the turn was taken. */
  'social.roomPictureRefusalBlocked': `Prix removed this same file from the Community chat before, so it is not taken again. ${PIC_COUNTED}`,
  /** For an upload and for a report from an admin wallet. */
  'social.roomPictureRefusalAdmin':
    'This is an admin wallet, and an admin wallet neither adds nor reports a picture. An admin removes a picture on the admin page of the chat.',
  'social.roomPictureRefusalNewWriter': `Adding a picture takes a wallet whose first message in the Community chat is at least ${PIC_WRITER_MINUTES} minutes old, and this wallet has none that old yet. Write a message if you have not, then add the picture after that time.`,
  /** The wallet was muted once. A lift gives back writing, not pictures. For an upload and for a report. */
  'social.roomPictureRefusalNotAllowed':
    'This wallet was muted in the Community chat once, and a wallet that was muted cannot add or report pictures, also after the mute is lifted. It can still write messages.',
  'social.roomPictureRefusalPaused':
    'Reports have hidden pictures from this wallet, and it cannot add another until an admin of Prix has decided on them. It can still write messages.',
  'social.roomPictureRefusalOff':
    'Pictures are switched off in the Community chat for now, so none can be added or reported. Text messages go on as before.',
  /** A try that was refused after the turn counts too, so the sentence says "used" and not "added". */
  'social.roomPictureRefusalWalletDay': `This wallet has used its ${PIC_PER_DAY} pictures for today. It can add another after 00:00 UTC.`,
  'social.roomPictureRefusalRoomHour':
    'The Community chat has taken as many pictures as it takes in one hour. Add yours again after the hour turns.',
  'social.roomPictureRefusalRoomDay':
    'The Community chat has taken as many pictures as it takes in one day. It takes pictures again after 00:00 UTC.',
  /** The store refused the file. The turn and the counts stay spent. */
  'social.roomPictureRefusalStorage': `Prix could not store the picture because of a fault on its side, so the picture was not posted. ${PIC_COUNTED} Add it again in a minute.`,
  /** A writer cannot take a picture back, so the sentence says where to ask. */
  'social.roomPictureRefusalReportOwn': `This is your own picture, and a wallet cannot report its own. To ask for it to be removed, write to ${links.supportEmail}.`,
  'social.roomPictureRefusalReportNewWriter': `Reporting a picture takes a wallet whose first message in the Community chat is at least ${PIC_REPORTER_HOURS} hours old, and this wallet has none that old yet.`,
  'social.roomPictureRefusalReportWalletDay':
    'This wallet has sent as many reports as a wallet sends in one day. It can report again after 00:00 UTC.',
} as const satisfies Record<string, string>;

/** Exported after the strings, so that a reader of this module that takes its first record finds them. */
export { socialFacts };
