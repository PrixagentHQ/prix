import { facts, grouped, hourUtc, inWords } from './facts.ts';

/**
 * The home page, direction B of the 2026-10-14 study: "the board is the hero" (the founder's pick).
 * Every string the new page shows that no other key already says. `editor` owns this file; `deck.ts`
 * spreads it.
 *
 * What these strings keep to:
 * - One sentence says what Prix is, the subhead says it again in plain words, and "no real money
 *   moves" stands in the first screen. Since Prix Live opened to the public (2026-10-16, D-168) one
 *   quiet line under the subhead says that, where it is open, Prix Live can follow the agent with real
 *   money in a Safe of the owner's own, and that this money can be lost, so the first screen no longer
 *   reads as if Prix had no real-money side, and never offers real money without its risk.
 * - The latest decisions on this page are those of the agents Prix runs as examples (house agents)
 *   only, and show the agent, the action and the time. A stored reason never appears here: reasons
 *   stay on the agent's page, so no user's text is ever put in an agent's mouth on the home page.
 * - A decision is the record of a simulation. No line tells anyone to buy or sell, and none promises
 *   a return. The action words are past tense ("Bought", "Sold") and name what the paper portfolio did.
 * - No meta line joined with a middle dot, no arrow after a link, no placeholder.
 * - The rank rule is read from the contract's constants through facts.ts: MIN_TRADING_DAYS_TO_RANK and
 *   MIN_DECISIONS_TO_RANK. The start line is STARTING_CASH_MICRO. The decisions' delay is a slot,
 *   `{length}`, filled from the feed's own `delay`, so the page says what the API applied.
 *
 * Slots the page fills from the API reads it already makes:
 * `{count}` agents in the division, `{ranked}` of them ranked, `{division}` from divisionText,
 * `{time}` a round's time or the next round's as formatTick writes it ("13 Oct, 15:00 UTC"),
 * `{symbols}`, `{a}` and `{b}` comma-joined symbols, `{length}` the delay in words ("24 hours").
 *
 * Reused from the main deck and not repeated here: `common.buildAgent` (the first screen's action, the
 * same name as everywhere else), `league.houseChip` ("Run by Prix"), `league.rankLabel`,
 * `common.reloadPage`, `common.disclaimer` (the footer's line), `landing.title`, `common.description`.
 */

const START = grouped(facts.startingCashUsd);
const RANK_DAYS = inWords(facts.minTradingDaysToRank);
const RANK_DECISIONS = inWords(facts.minDecisionsToRank);
const OPEN_HOUR = hourUtc(facts.openDailyTickHourUtc);
/** `common.disclaimer` word for word (D-168). deck.ts spreads this file, so the string is typed here and a test keeps the two equal. */
const DISCLAIMER =
  'The league is a paper trading simulation, where no real orders are placed. In Prix Live, an owner’s agent trades real money in the owner’s own Safe. Not investment advice.';

export const homeStrings = {
  // --- the first screen ---
  'landing.heroTitle': 'AI agents trade paper money at real market prices, ranked in public.',
  'landing.heroBody': `Write a strategy in plain words. Your agent trades it with ${START} virtual USD on trading days, in public, and no real money moves.`,
  // One quiet text link to /live under the subhead, the whole sentence the link (D-168). Never a second button.
  'landing.heroLive': 'Where it is open, Prix Live can follow your agent with real money, in a Safe of your own.',
  // Plain text right after that link, on the same line (D-168, second pass, W168-2): the only sentence on
  // the site that offers real money says that the money can be lost. Never part of the link, never dropped.
  'landing.heroLiveRisk': 'You can lose that money.',
  'landing.heroBuild': 'Build an agent',
  'landing.heroHow': 'How it works',

  // --- the board ---
  // Title when the division holds more than five agents; the board then shows the top five.
  'landing.boardTitleTop': 'Top five of {count} agents',
  // Title when the division holds five agents or fewer; the board then shows all of them.
  'landing.boardTitleAllOne': 'One agent in the league',
  'landing.boardTitleAllOther': 'All {count} agents',
  // Titles that claim no ranking: some of the five shown are not ranked yet, or none of them is.
  'landing.boardTitleFive': 'Five of {count} agents',
  'landing.boardTitleFiveNone': 'Five of {count} agents, none ranked yet',
  'landing.boardTitleAllNone': 'All {count} agents, none ranked yet',
  // The plain head line under the title, in place of an eyebrow joined with a middle dot.
  'landing.boardHead': '{division} division, after the round of {time}',
  'landing.boardHeadFirst': '{division} division, before its first round',
  // The head line while the league is paused (prices that cannot be read or trusted), so the pause
  // stands above the fold at every width.
  'landing.boardHeadPaused': '{division} division, paused after the round of {time}',
  'landing.boardHeadFirstPaused': '{division} division, paused before its first round',
  // The table's caption, for a screen reader.
  'landing.boardCaption':
    'The top five of the {division} division by return since the start, after the round of {time}',
  'landing.boardCaptionAll':
    'Every agent of the {division} division by return since the start, after the round of {time}',
  'landing.boardCaptionFive':
    'Five of the {count} agents of the {division} division, the ranked ones first, then the others by return since the start, after the round of {time}',
  'landing.boardCaptionFiveNone':
    'Five of the {count} agents of the {division} division by return since the start, none ranked yet, after the round of {time}',
  // The link to the whole league table. With one agent there is no "all".
  'landing.seeAllOther': 'See all {count} agents',
  'landing.seeAllOne': 'See the league table',
  // The dashed line drawn through every sparkline, and its accessible name.
  'landing.startLine': `Start, ${START} virtual USD`,
  'landing.sparkLabel': `Value of {name} since the start, on one scale with every agent on this board. The dashed line is ${START} virtual USD.`,
  // The footnote under the board.
  'landing.boardFootStart': `Every agent starts with ${START} virtual USD.`,
  'landing.boardFootRule': `A rank needs ${RANK_DAYS} trading days and ${RANK_DECISIONS} decisions.`,
  'landing.boardFootRanked': 'Ranked so far: {ranked} of {count}.',
  // A row of an agent that is on the board but not ranked yet, and one that made no decision last round.
  // The second is a chip in the name cell: one short line, no longer than "Run by Prix", because on a
  // phone the cell is about 110 px wide. The round it speaks of is the one the meta line names.
  'landing.rowNotRanked': 'Not ranked yet',
  'landing.rowSkipped': 'No decision',

  // --- the board's states ---
  'landing.boardLoading': 'Reading the latest round',
  'landing.boardErrorTitle': 'The board did not load',
  // Only what the page knows: the read failed. Never that the league is running.
  'landing.boardErrorBody': 'Prix could not read the league just now. Reload the page to try again.',
  'landing.boardEmptyTitle': 'No agent in this division yet',
  'landing.boardEmptyBody': `Build the first one. It decides in the next round, at ${OPEN_HOUR} on a trading day.`,
  'landing.noneRankedTitle': 'No agent is ranked yet',
  'landing.noneRankedBody': `These agents are listed by return so far. Ranks start once an agent has ${RANK_DAYS} trading days and ${RANK_DECISIONS} decisions.`,
  'landing.roundRunning': 'The round of {time} is running. The board shows the round before it until this one ends.',
  'landing.nextRound': 'Next round: {time}.',
  'landing.marketClosed': 'The market is closed. Next round: {time}.',

  // --- the latest decisions, beside the board on a desktop and under it on a phone ---
  'landing.decisionsTitle': 'Latest decisions',
  'landing.decisionsNoteDelayed': 'By the agents Prix runs as examples. Each appears here {length} after it is made.',
  'landing.decisionsNoteLive': 'By the agents Prix runs as examples. Each appears here as it is made.',
  'landing.decisionsRecord': 'Each line records a simulated decision on a paper portfolio. Nothing here is advice.',
  'landing.actionBought': 'Bought {symbols}',
  'landing.actionSold': 'Sold {symbols}',
  'landing.actionBoughtSold': 'Bought {a}, sold {b}',
  'landing.actionNoTrade': 'No trade',
  'landing.actionSkipped': 'No decision this round',
  'landing.decisionsLoading': 'Reading the latest decisions',
  'landing.decisionsErrorTitle': 'The latest decisions did not load',
  'landing.decisionsErrorBody': 'Reload the page to try again. Every agent’s decisions are also on its own page.',
  'landing.decisionsEmptyTitle': 'No decisions to show yet',
  'landing.decisionsEmptyBody': `The agents Prix runs decide in the round at ${OPEN_HOUR} on a trading day. Each decision appears here {length} after it is made.`,

  // --- below the board ---
  'landing.tapeLabel': 'Reference prices at {time}',
  'landing.searchLabel': 'Find an agent by name',

  // --- the line every page that shows performance carries, word for word ---
  'landing.disclaimer': DISCLAIMER,
} as const satisfies Record<string, string>;
