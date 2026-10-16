import type { ApiErrorCode, FeedItem, FeedPage, LeagueResponse, StandingRow } from '@prix/contracts';
import { STARTING_CASH_MICRO } from '@prix/contracts';
import { formatCount, formatDelay, formatDrawdownBps, formatPercentBps, formatTick } from '../../content/format.ts';
import { text } from '../../content/index.ts';
import { divisionText } from '../../content/states.ts';
import { type Domain, sparkDomain, sparkSlots } from '../../design/chart.ts';
import { houseLabel, toneOf } from '../board/board.ts';
import { type LeagueClock, leagueClock, nextRoundTodayFor } from '../clock.ts';
import { agentHref, closedSentence, leagueHref, nextRoundWords, readFailure } from '../words.ts';

/**
 * What the home page's hero shows (docs/DESIGN.md sections 5.3 and 29, R17: "the board is the
 * hero"), from the API's answers. Server only, pure, so every rule of the page can be tested.
 *
 * Nothing here ranks, scores or adds up a return: the board is the first five rows in the order
 * the API sent them, every figure is the API's own value formatted by content/format.ts, and a
 * count is the API's count or a count of the rows it sent. The rank rule is the contract's
 * (MIN_TRADING_DAYS_TO_RANK and MIN_DECISIONS_TO_RANK), read through the deck.
 *
 * The latest decisions are those of the agents Prix runs (`house`) only, and a row carries the
 * agent, the action and the time: never the stored reason, so no text a user wrote, and no reason
 * a model wrote from it, is put in an agent's mouth on the home page.
 */

/** How many agents the board shows. */
export const BOARD_SIZE = 5;
/** How many decisions stand beside the board. */
export const DECISIONS_SIZE = 5;

// --- the board -----------------------------------------------------------------------------------

export interface StandingsRowView {
  agent: { id: string; name: string; href: string };
  rank: number | null;
  rankLabel?: string;
  chips: Array<{ label: string; kind: 'house' | 'neutral' }>;
  figure: { text: string; tone?: 'gain' | 'loss' };
  line: { values: number[]; label: string; emptyLabel: string };
  facts: string[];
}

export interface BoardView {
  title: string;
  meta: string;
  more: { label: string; href: string };
  caption: string;
  rows: StandingsRowView[];
  domain: Domain;
  slots: number;
  baseline: number;
  /** The sentences under the board: the start, the state of the league, the rank rule and how many are ranked. */
  key: string;
}

/** The first five rows, in the API's order: ranked agents by rank, then the unranked ones. */
export function topRows(league: LeagueResponse): StandingRow[] {
  return league.rows.slice(0, BOARD_SIZE);
}

/** The number of agents in the division: the API's count once ranked, else the rows it sent. */
export function agentCount(league: LeagueResponse): number {
  return league.state?.agentCount ?? league.rows.length;
}

/** "A rank needs five trading days and three decisions.": the contract's rule, from the deck. */
export function rankRule(): string {
  return text('landing.boardFootRule', 'A rank needs five trading days and three decisions.');
}

/**
 * "6 Oct, 15:00 UTC" with a no-break space inside "6 Oct" and inside "15:00 UTC", so a narrow board
 * breaks a meta line or a key only between phrases, never a time from its zone (the design check of
 * 2026-10-14, at 360 and 320). Only spaces change: the words are the deck's and the API's as given.
 */
export function keepTimeTogether(words: string): string {
  return words
    .replace(/(\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/g, '$1 $2')
    .replace(/(\d{2}:\d{2}) UTC\b/g, '$1 UTC');
}

/** True when an agent made no decision in the last round: the model gave none, or the agent skipped. */
export function skippedLastRound(row: StandingRow): boolean {
  return row.lastStatus === 'no_decision' || row.lastStatus === 'skipped';
}

/**
 * The sentence about the league's clock, second in the key: a round running now, the market
 * closed and the next round, or the next round between two. The next round is the division's:
 * hourly for Pro, the daily tick for Open. Null on the Pro board while the market is open and no
 * round is left today: then the meta line says all there is.
 */
export function roundSentence(
  league: LeagueResponse,
  now: number,
  clock: LeagueClock = leagueClock(league, now),
): string | null {
  const said = roundWords(league, now, clock);
  return said === null ? null : keepTimeTogether(said);
}

function roundWords(league: LeagueResponse, now: number, clock: LeagueClock): string | null {
  if (league.round) {
    return text(
      'landing.roundRunning',
      'The round of {time} is running. The board shows the round before it until this one ends.',
      { time: formatTick(league.round.tickId) },
    );
  }
  // The next round in which this division's agents decide: every hour for Pro, the daily tick for Open.
  const next = nextRoundTodayFor(league.division, now);
  if (clock.kind === 'closed') {
    const reason = league.market?.closedReason ?? null;
    // A plain closure (the Stock Tokens' prices stand still) says so in a few words; a pause of the
    // league (prices that cannot be read or trusted) says why, in the sentence every page uses.
    if (next && (reason === null || reason === 'feeds_stale')) {
      return text('landing.marketClosed', 'The market is closed. Next round: {time}.', { time: formatTick(next) });
    }
    const after = next
      ? text('landing.nextRound', 'Next round: {time}.', { time: formatTick(next) })
      : nextRoundWords(null);
    return `${closedSentence(reason)} ${after}`;
  }
  if (clock.kind === 'between' || clock.kind === 'open') {
    if (next) return text('landing.nextRound', 'Next round: {time}.', { time: formatTick(next) });
    // With the market open and no hourly round left today, the Pro board's meta line says all there
    // is; the Open board names the next trading day, because its agents decide only at the daily tick.
    return clock.kind === 'between' || league.division === 'open' ? nextRoundWords(null) : null;
  }
  return null;
}

/**
 * True while the league is paused: the market check of this window is current and names prices that
 * cannot be read or trusted. A plain closure (`feeds_stale`, prices standing still) is not a pause.
 */
export function leaguePaused(league: LeagueResponse, now: number): boolean {
  const reason = league.market?.closedReason ?? null;
  return leagueClock(league, now).kind === 'closed' && reason !== null && reason !== 'feeds_stale';
}

/**
 * The key under the board: every sentence is the deck's, every number the contract's or the API's.
 * Its order (DESIGN.md 5.3): the start, then the state of the league (a round running, the market
 * closed and the next round, or the league paused and the next round), then the rank rule and how
 * many are ranked. The state comes second so that it is read before the rules.
 */
export function boardKey(league: LeagueResponse, now: number): string {
  const count = agentCount(league);
  const anyRanked = league.rows.some((row) => row.rank !== null);
  const sentences = [text('landing.boardFootStart', 'Every agent starts with 10,000 virtual USD.')];
  const round = roundSentence(league, now);
  if (round) sentences.push(round);
  if (anyRanked) {
    sentences.push(rankRule());
    const ranked = league.state?.rankedCount;
    if (ranked !== undefined && ranked < count) {
      sentences.push(
        text('landing.boardFootRanked', 'Ranked so far: {ranked} of {count}.', {
          ranked: formatCount(ranked),
          count: formatCount(count),
        }),
      );
    }
  } else {
    sentences.push(
      text(
        'landing.noneRankedBody',
        'These agents are listed by return so far. Ranks start once an agent has five trading days and three decisions.',
      ),
    );
  }
  return sentences.join(' ');
}

/** One row of the board, every word and figure formatted from the API's row. */
export function standingsRowOf(row: StandingRow, current: URL): StandingsRowView {
  const chips: StandingsRowView['chips'] = [];
  if (row.house) chips.push({ label: houseLabel(), kind: 'house' });
  if (skippedLastRound(row)) {
    chips.push({ label: text('landing.rowSkipped', 'No decision'), kind: 'neutral' });
  }
  const tone = toneOf(row.seasonReturnBps);
  return {
    agent: { id: row.agentId, name: row.name, href: agentHref(current, row.agentId) },
    rank: row.rank,
    rankLabel: row.rank === null ? undefined : text('league.rankLabel', 'Rank {rank}', { rank: formatCount(row.rank) }),
    chips,
    figure: { text: formatPercentBps(row.seasonReturnBps), tone },
    line: {
      values: [STARTING_CASH_MICRO, ...row.spark],
      label: text(
        'landing.sparkLabel',
        'Value of {name} since the start, on one scale with every agent on this board. The dashed line is 10,000 virtual USD.',
        { name: row.name },
      ),
      emptyLabel: text('league.sparkEmpty', 'No trading days yet'),
    },
    facts: [formatDrawdownBps(row.maxDrawdownBps), formatCount(row.tradeCount)],
  };
}

/** Whether every row shown has a rank, some do, or none does. */
export function rankedShown(rows: readonly StandingRow[]): 'all' | 'some' | 'none' {
  const ranked = rows.filter((row) => row.rank !== null).length;
  return ranked === rows.length ? 'all' : ranked === 0 ? 'none' : 'some';
}

/**
 * The board's title, chosen from the rows it shows (DESIGN.md 5.3, the states): "Top five of 12
 * agents" only when all five shown are ranked, "Five of 12 agents" when some are not, and "Five of
 * 12 agents, none ranked yet" when none is. With five or fewer the board shows every agent.
 */
export function boardTitle(rows: readonly StandingRow[], count: number): string {
  const counted = { count: formatCount(count) };
  const ranks = rankedShown(rows);
  if (count > BOARD_SIZE) {
    if (ranks === 'all') return text('landing.boardTitleTop', 'Top five of {count} agents', counted);
    if (ranks === 'some') return text('landing.boardTitleFive', 'Five of {count} agents', counted);
    return text('landing.boardTitleFiveNone', 'Five of {count} agents, none ranked yet', counted);
  }
  if (count === 1) return text('landing.boardTitleAllOne', 'One agent in the league');
  return ranks === 'none'
    ? text('landing.boardTitleAllNone', 'All {count} agents, none ranked yet', counted)
    : text('landing.boardTitleAllOther', 'All {count} agents', counted);
}

/** The meta line under the title: the division and its last round, and the pause when there is one. */
export function boardMeta(league: LeagueResponse, now: number, division: string, time: string | null): string {
  return keepTimeTogether(metaWords(league, now, division, time));
}

function metaWords(league: LeagueResponse, now: number, division: string, time: string | null): string {
  if (leaguePaused(league, now)) {
    return time
      ? text('landing.boardHeadPaused', '{division} division, paused after the round of {time}', { division, time })
      : text('landing.boardHeadFirstPaused', '{division} division, paused before its first round', { division });
  }
  return time
    ? text('landing.boardHead', '{division} division, after the round of {time}', { division, time })
    : text('landing.boardHeadFirst', '{division} division, before its first round', { division });
}

/** The board of a division that has agents: the top five on one scale, with its words. */
export function boardView(league: LeagueResponse, now: number, current: URL): BoardView {
  const top = topRows(league);
  const count = agentCount(league);
  const division = divisionText(league.division);
  const lines = top.map((row) => [STARTING_CASH_MICRO, ...row.spark]);
  const time = league.state ? formatTick(league.state.tickId) : null;
  const meta = boardMeta(league, now, division, time);
  const title = boardTitle(top, count);
  const counted = { count: formatCount(count) };
  const ranks = rankedShown(top);
  const caption = !time
    ? meta
    : count <= BOARD_SIZE
      ? text(
          'landing.boardCaptionAll',
          'Every agent of the {division} division by return since the start, after the round of {time}',
          { division, time },
        )
      : ranks === 'all'
        ? text(
            'landing.boardCaption',
            'The top five of the {division} division by return since the start, after the round of {time}',
            { division, time },
          )
        : ranks === 'some'
          ? text(
              'landing.boardCaptionFive',
              'Five of the {count} agents of the {division} division, the ranked ones first, then the others by return since the start, after the round of {time}',
              { ...counted, division, time },
            )
          : text(
              'landing.boardCaptionFiveNone',
              'Five of the {count} agents of the {division} division by return since the start, none ranked yet, after the round of {time}',
              { ...counted, division, time },
            );
  const more = {
    label:
      count === 1
        ? text('landing.seeAllOne', 'See the league table')
        : text('landing.seeAllOther', 'See all {count} agents', { count: formatCount(count) }),
    href: leagueHref(current, { division: league.division }),
  };
  return {
    title,
    meta,
    more,
    caption,
    rows: top.map((row) => standingsRowOf(row, current)),
    domain: sparkDomain(lines),
    slots: sparkSlots(lines),
    baseline: STARTING_CASH_MICRO,
    key: boardKey(league, now),
  };
}

/** What stands in the board's place when it has no rows: no league yet, no agent yet, or a failed read. */
export type BoardEmpty =
  | { kind: 'none'; title: string; body: string }
  | { kind: 'empty'; title: string; body: string }
  | { kind: 'failed'; title: string; body?: string };

export function boardEmptyOf(
  result: { ok: true; data: LeagueResponse } | { ok: false; error: { code: ApiErrorCode } },
): BoardEmpty | null {
  if (result.ok) {
    if (result.data.rows.length > 0) return null;
    return {
      kind: 'empty',
      title: text('landing.boardEmptyTitle', 'No agent in this division yet'),
      body: text(
        'landing.boardEmptyBody',
        'Build the first one. It decides in the next round, at 15:00 UTC on a trading day.',
      ),
    };
  }
  if (result.error.code === 'not_found') {
    return {
      kind: 'none',
      title: text('landing.noLeagueTitle', 'The league has not started'),
      body: text('landing.noLeagueBody', 'The league table appears here when the league starts.'),
    };
  }
  return {
    kind: 'failed',
    ...readFailure(result.error.code, {
      title: text('landing.boardErrorTitle', 'The board did not load'),
      body: text('landing.boardErrorBody', 'Prix could not read the league just now. Reload the page to try again.'),
    }),
  };
}

// --- the latest decisions ------------------------------------------------------------------------

export interface DecisionRowView {
  agent: { id: string; name: string; href: string };
  time: { iso: string; label: string };
  what: string;
  tag: string;
  'data-key': string;
}

/** "Bought SGOV, sold USO", "Bought NVDA", "Sold USO" or "No trade": what the paper portfolio did. */
export function actionWords(item: FeedItem): string {
  const symbols = (side: 'buy' | 'sell') => [
    ...new Set(item.fills.filter((fill) => fill.side === side).map((fill) => fill.symbol)),
  ];
  const bought = symbols('buy');
  const sold = symbols('sell');
  if (bought.length > 0 && sold.length > 0) {
    return text('landing.actionBoughtSold', 'Bought {a}, sold {b}', { a: bought.join(', '), b: sold.join(', ') });
  }
  if (bought.length > 0) return text('landing.actionBought', 'Bought {symbols}', { symbols: bought.join(', ') });
  if (sold.length > 0) return text('landing.actionSold', 'Sold {symbols}', { symbols: sold.join(', ') });
  return text('landing.actionNoTrade', 'No trade');
}

/**
 * The rows beside the board: the newest decisions of the agents Prix runs, at most five, each the
 * agent, the action and the time with the tag. An item without `house: true` is never shown, and
 * no row carries the item's reason.
 */
export function decisionRows(feed: FeedPage, current: URL): DecisionRowView[] {
  return feed.items
    .filter((item) => item.house === true)
    .slice(0, DECISIONS_SIZE)
    .map((item) => ({
      agent: { id: item.agentId, name: item.agentName, href: agentHref(current, item.agentId) },
      time: { iso: item.at, label: formatTick(item.tickId) },
      what: actionWords(item),
      tag: text('league.simulationRecord', 'Simulation record'),
      'data-key': `${item.tickId}~${item.agentId}`,
    }));
}

/** The note under "Latest decisions": whose they are, and the delay the API applied. */
export function decisionsNote(delay: FeedPage['delay']): string {
  // The league feed shows a row once it is `delay.seconds` old, the house agents' rows included
  // (apps/api feed-read.ts, `leagueFeed`): the sentence follows those seconds and nothing else.
  return delay.seconds > 0
    ? text(
        'landing.decisionsNoteDelayed',
        'By the agents Prix runs as examples. Each appears here {length} after it is made.',
        { length: formatDelay(delay.seconds) },
      )
    : text('landing.decisionsNoteLive', 'By the agents Prix runs as examples. Each appears here as it is made.');
}

/** The one sentence that stands for the decisions when there is none to show, or the read failed. */
export function decisionsQuiet(feed: FeedPage | null): { title: string; body: string } {
  if (!feed) {
    return {
      title: text('landing.decisionsErrorTitle', 'The latest decisions did not load'),
      body: text(
        'landing.decisionsErrorBody',
        'Reload the page to try again. Every agent’s decisions are also on its own page.',
      ),
    };
  }
  const delayed = feed.delay.seconds > 0;
  return {
    title: text('landing.decisionsEmptyTitle', 'No decisions to show yet'),
    // Without a delay the empty body's "{length} after it is made" would be false: the note says it.
    body: delayed
      ? text(
          'landing.decisionsEmptyBody',
          'The agents Prix runs decide in the round at 15:00 UTC on a trading day. Each decision appears here {length} after it is made.',
          { length: formatDelay(feed.delay.seconds) },
        )
      : decisionsNote(feed.delay),
  };
}
