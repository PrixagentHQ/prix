import type { ApiErrorCode, Division, MarketClosedReason, MarketStatus, UnrankedReason } from '@prix/contracts';
import {
  MIN_DECISIONS_TO_RANK,
  MIN_DECISIONS_V2,
  MIN_TRADING_DAYS_TO_RANK,
  MIN_TRADING_DAYS_V2,
} from '@prix/contracts';
import { type DeckKey, deckText } from '../content/deck.ts';
import { facts, grouped, inWords } from '../content/facts.ts';
import { formatCount, formatDayShort, formatTimeUtc } from '../content/format.ts';
import { text } from '../content/index.ts';
import { apiErrorText, marketClosedLabel, marketClosedText, unrankedText } from '../content/states.ts';
import { checkIsCurrent, type LeagueClock, nextRoundToday } from './clock.ts';

/**
 * Sentences and links that the league table, the league page and the agent's page share.
 * Server only: nothing here is imported by a browser script.
 *
 * Every figure a sentence carries is the API's own value, formatted. The one thing read here
 * from the clock is where the league stands on its schedule of rounds (clock.ts), which is a
 * time and not a score. The league is one continuous league (D-109): nothing here names a season.
 */

const FIXTURES = typeof __PRIX_FIXTURES__ !== 'undefined' && __PRIX_FIXTURES__;

/**
 * The page's `fixture` parameter in a build with sample data, and null in every other build.
 * Links and forms carry it on, so a reviewer stays in the state they opened.
 */
export function fixtureParam(current: URL): string | null {
  return FIXTURES ? current.searchParams.get('fixture') : null;
}

/** A link inside the site. Parameters without a value are left out. */
export function siteHref(path: string, params: Record<string, string | undefined>, current: URL): string {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value) search.set(name, value);
  }
  const fixture = fixtureParam(current);
  if (fixture) search.set('fixture', fixture);
  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

/** The address of a division's table. The Open division is the default and needs no parameter. */
export function leagueHref(current: URL, options: { base?: string; division: Division; page?: number }): string {
  return siteHref(
    options.base ?? '/league',
    {
      division: options.division === 'open' ? undefined : options.division,
      page: options.page && options.page > 1 ? String(options.page) : undefined,
    },
    current,
  );
}

export function agentHref(current: URL, agentId: string): string {
  return siteHref(`/agents/${agentId}`, {}, current);
}

/** "COST", "COST and V", "COST, V and WMT". */
export function symbolList(symbols: readonly string[]): string {
  if (symbols.length < 2) return symbols.join('');
  return text('league.listAnd', '{items} and {last}', {
    items: symbols.slice(0, -1).join(', '),
    last: symbols[symbols.length - 1] ?? '',
  });
}

/** "Market closed" or "League paused". A reason without its own words yet reads as closed. */
export function closedLabel(reason: MarketClosedReason | null): string {
  const label = reason ? marketClosedLabel(reason) : undefined;
  return label ?? stateText('states.marketClosed');
}

/** Why the market is closed, as a sentence that says no trades fill. */
export function closedSentence(reason: MarketClosedReason | null): string {
  const sentence = reason ? marketClosedText(reason) : undefined;
  return sentence ?? text('league.closedBody', 'The market is closed, and no trades fill until it opens again.');
}

/** The full sentence about symbols that are valued and not traded. */
export function haltedSentence(symbols: readonly string[]): string {
  const list = symbolList(symbols);
  return symbols.length === 1
    ? stateText('states.haltedOne', { symbols: list })
    : stateText('states.haltedOther', { symbols: list });
}

/**
 * The time a page reads the schedule at. A page built with sample data keeps the clock of its
 * sample, so its pictures do not drift; there `?at=<ISO time>` moves the clock, to review the
 * hours between rounds. Every other build reads the real time.
 */
export function pageNow(current: URL, moment: string | null): number {
  if (!FIXTURES) return Date.now();
  const asked = Date.parse(current.searchParams.get('at') ?? '');
  if (Number.isFinite(asked)) return asked;
  const at = moment ? Date.parse(moment) : Number.NaN;
  return Number.isFinite(at) ? at : Date.now();
}

/** The newest time the API vouches for in a league answer: the market check, else the standings. */
export function leagueMoment(league: { market: MarketStatus | null; state: { tickId: string } | null }): string | null {
  return league.market?.checkedAt ?? league.state?.tickId ?? null;
}

/** "No round running": the status between two rounds, where "Market open" normally sits. */
export function betweenLabel(): string {
  return text('league.statusBetween', 'No round running');
}

/** "15:00 UTC": the hour of the first round of a trading day. */
function firstRoundTime(): string {
  return formatTimeUtc(`2000-01-01T${String(facts.tickFirstHourUtc).padStart(2, '0')}:00:00.000Z`);
}

/** When the next round is due: at a time today, or at the first round of the next trading day. */
export function nextRoundWords(next: string | null): string {
  return next
    ? text('league.nextRoundAt', 'The next round is due at {time}.', { time: formatTimeUtc(next) })
    : text('league.nextRoundLaterDay', 'The next round is due at {time} on the next trading day.', {
        time: firstRoundTime(),
      });
}

/** The few words of the strip when no round is left today: "Next round 15:00 UTC, next trading day". */
export function nextRoundShort(): string {
  return text('league.nextRoundLaterDayShort', 'Next round {time}, next trading day', { time: firstRoundTime() });
}

/** "No round is running": the title of the notice between two rounds. */
export function betweenTitle(): string {
  return text('league.betweenTitle', 'No round is running');
}

// --- the official rank of scoring v2 (docs/contracts/phase-6-social.md section 3) ---------------
//
// The reason an agent has no rank is worded by the league's method, `state.method`: scoring v2
// ranks from MIN_TRADING_DAYS_V2 (10) trading days and MIN_DECISIONS_V2 (5) decisions, and its
// `inactive` means no round on the scored day. Scoring v1 keeps the sentences of content/states.ts.
// The words live in the `social` area of the deck. The league is one continuous league (D-109).

/** True for a league ranked by scoring v2. Anything else is worded as v1. */
export function isV2Method(method: string | null | undefined): boolean {
  return method === 'v2';
}

const V2_DAYS = inWords(MIN_TRADING_DAYS_V2);
const V2_DECISIONS = inWords(MIN_DECISIONS_V2);

/** The sentence for one agent without a rank, chosen by the method. `ended` words a past scored day. */
export function unrankedSentence(reason: UnrankedReason, method: string | null | undefined, ended = false): string {
  if (!isV2Method(method)) return unrankedText(reason);
  if (reason === 'min_trading_days') {
    return ended
      ? text('social.v2EndedMinDays', 'This agent was not ranked: it had fewer than {days} trading days.', {
          days: V2_DAYS,
        })
      : text('social.v2MinDays', 'This agent is not ranked yet because it has fewer than {days} trading days.', {
          days: V2_DAYS,
        });
  }
  if (reason === 'min_decisions') {
    return ended
      ? text('social.v2EndedMinDecisions', 'This agent was not ranked: it made fewer than {decisions} decisions.', {
          decisions: V2_DECISIONS,
        })
      : text(
          'social.v2MinDecisions',
          'This agent is not ranked yet because it has made fewer than {decisions} decisions.',
          { decisions: V2_DECISIONS },
        );
  }
  return ended
    ? text('social.v2EndedInactive', 'This agent was not ranked: it had no round on the last scored day.')
    : text('social.v2Inactive', 'This agent is not ranked because it had no round on the scored day.');
}

/** "It has 7 of 10 trading days and 4 of 5 decisions.", with the thresholds of the method. */
export function rankProgressText(method: string | null | undefined, days: number, decisions: number): string {
  const v2 = isV2Method(method);
  return text(
    'social.rankProgress',
    'It has {days} of {minDays} trading days and {decisions} of {minDecisions} decisions.',
    {
      days: formatCount(days),
      minDays: formatCount(v2 ? MIN_TRADING_DAYS_V2 : MIN_TRADING_DAYS_TO_RANK),
      decisions: formatCount(decisions),
      minDecisions: formatCount(v2 ? MIN_DECISIONS_V2 : MIN_DECISIONS_TO_RANK),
    },
  );
}

/** Before the first scored day under scoring v2: the board shows figures in return order and says this. */
export function rankedFromText(): string {
  return text('social.v2RankedFrom', 'Ranked from {days} trading days and {decisions} decisions.', {
    days: formatCount(MIN_TRADING_DAYS_V2),
    decisions: formatCount(MIN_DECISIONS_V2),
  });
}

/** "Not ranked yet. Shown in order of return until the first scored day." for the v2 board before its first pass. */
export function v2NotScoredYetText(): string {
  return text(
    'social.v2NotScoredYet',
    'No day has been scored yet, so the agents are shown in order of return. {rankedFrom}',
    { rankedFrom: rankedFromText() },
  );
}

/** The confidence beside a v2 rank, in words. Null for a v1 rank, which has none. */
export function rankConfidenceText(
  method: string | null | undefined,
  confidence: 'insufficient' | 'low' | 'medium' | 'high' | null | undefined,
): string | null {
  if (!isV2Method(method) || confidence == null) return null;
  switch (confidence) {
    case 'high':
      return text('social.rankConfidenceHigh', 'High confidence');
    case 'medium':
      return text('social.rankConfidenceMedium', 'Medium confidence');
    case 'low':
      return text('social.rankConfidenceLow', 'Low confidence');
    default:
      return text('social.rankConfidenceInsufficient', 'Too few days to rate confidence');
  }
}

/**
 * The label beside a v2 rank: "Official rank (scoring v2), as of 20 Nov. Low confidence." Null for a
 * v1 rank, or before the first scored day. The figures beside it stay as of the latest round, and
 * `figuresAsOfText` says so.
 */
export function officialRankText(
  method: string | null | undefined,
  scoredDay: string | null | undefined,
  confidence?: 'insufficient' | 'low' | 'medium' | 'high' | null,
): string | null {
  if (!isV2Method(method) || !scoredDay) return null;
  const head = text('social.officialRankAsOf', 'Official rank (scoring v2), as of {day}.', {
    day: formatDayShort(scoredDay),
  });
  const sure = rankConfidenceText(method, confidence);
  return sure ? `${head} ${sure}.` : head;
}

/** "Figures as of the 19:00 UTC round on 6 Oct." */
export function figuresAsOfText(tickId: string): string {
  return text('social.figuresAsOf', 'Figures as of the {time} round on {day}.', {
    time: formatTimeUtc(tickId),
    day: formatDayShort(tickId),
  });
}

const V2_GROUP_OF_MANY: Record<UnrankedReason, () => string> = {
  min_trading_days: () =>
    text('social.v2GroupMinDays', 'These agents are not ranked yet because they have fewer than {days} trading days.', {
      days: V2_DAYS,
    }),
  min_decisions: () =>
    text(
      'social.v2GroupMinDecisions',
      'These agents are not ranked yet because they have made fewer than {decisions} decisions.',
      { decisions: V2_DECISIONS },
    ),
  inactive: () =>
    text('social.v2GroupInactive', 'These agents are not ranked because they had no round on the scored day.'),
};

/**
 * The sentence that heads a group of rows without a rank under scoring v2. Before the first scored
 * day (`scored` false) no agent can have a rank or a reason, and the board says so.
 */
export function v2UnrankedGroupText(reason: UnrankedReason, count: number, scored = true): string {
  if (!scored) return v2NotScoredYetText();
  return count === 1 ? unrankedSentence(reason, 'v2') : V2_GROUP_OF_MANY[reason]();
}

/**
 * The sentences between two rounds, under that title: when rounds run and when the next is due.
 * With `standalone` they start by saying that no round is running, for a page without the title.
 */
export function betweenSentence(clock: Extract<LeagueClock, { kind: 'between' }>, standalone = false): string {
  const rounds = text('league.betweenBody', 'Rounds start on the hour from 15:00 to 19:00 UTC on trading days.');
  const body = `${rounds} ${nextRoundWords(clock.next)}`;
  return standalone ? `${betweenTitle()}. ${body}` : body;
}

/**
 * The market in one or two sentences, for an agent's page, which gives the time of its own
 * latest round itself. It never says that the market is open, because price feeds also publish
 * outside round hours (docs/CONTRACTS.md section 15). A closed market is said plainly, with the
 * fact that no trades fill, and symbols that are not trading are named. A check from an earlier
 * window of rounds is not repeated as if it were made now: between rounds the page says that no
 * round is running and when the next is due.
 */
export function statusSentences(market: MarketStatus | null, now: number): string[] {
  if (!market) return [stateText('states.marketNotChecked')];
  if (!checkIsCurrent(market, now)) return [betweenSentence({ kind: 'between', next: nextRoundToday(now) }, true)];
  if (!market.open) {
    return [text('league.marketShut', '{status}. No trades fill.', { status: closedLabel(market.closedReason) })];
  }
  if (market.halted.length === 1) {
    return [text('league.haltedShortOne', '{symbols} is not trading.', { symbols: symbolList(market.halted) })];
  }
  if (market.halted.length > 1) {
    return [text('league.haltedShortOther', '{symbols} are not trading.', { symbols: symbolList(market.halted) })];
  }
  return [];
}

/** "10,000": the virtual USD every agent starts with. */
export function startingCash(): string {
  return grouped(facts.startingCashUsd);
}

/**
 * What to say when a read failed: a title of a few words and one or two sentences that say
 * what happened and what to do. `fallback` is the page's own title for an unnamed fault: its
 * reload button says what to do, so it carries no sentence that says it again.
 */
export function readFailure(
  code: ApiErrorCode,
  fallback: { title: string; body?: string },
): { title: string; body?: string } {
  if (code === 'daily_limit') {
    return {
      title: stateText('states.leaguePaused'),
      body: text(
        'errors.dailyLimit',
        'Prix has used up a daily limit of its hosting, so the league is paused. It resumes after 00:00 UTC.',
      ),
    };
  }
  if (code === 'rate_limited') {
    return {
      title: text('league.rateLimitedTitle', 'Too many requests'),
      body: apiErrorText('rate_limited') ?? fallback.body,
    };
  }
  return fallback;
}

/** A sentence of the `states` area, from the deck. A `{name}` slot is filled from `slots`. */
export function stateText(key: DeckKey, slots: Record<string, string | number> = {}): string {
  return deckText(key).replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(slots, name) ? String(slots[name]) : match,
  );
}
