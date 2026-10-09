import type { Division, FeedItem, FeedPage, LeagueResponse, MarketPricesResponse, StandingRow } from '@prix/contracts';
import { STARTING_CASH_MICRO } from '@prix/contracts';
import { facts, universeFacts } from '../../content/facts.ts';
import {
  formatCount,
  formatDelay,
  formatDrawdownBps,
  formatPercentBps,
  formatTick,
  formatUsdMicro,
  formatWeightBps,
} from '../../content/format.ts';
import { text } from '../../content/index.ts';
import { divisionText, unrankedLabel } from '../../content/states.ts';
import { type Domain, sparkDomain, sparkSlots } from '../../design/chart.ts';
import { agentHref, siteHref, stateText } from '../words.ts';

/**
 * What the board, the featured block, the band and the feed put on a page, from the API's
 * answers. Server only. Every figure is the API's own value, formatted by content/format.ts.
 * Nothing here ranks, scores or adds up a return: the order of Top is the order the API sent,
 * the order of New is the agents' creation times, and a count is a count of what the API gave.
 */

export type Order = 'top' | 'new';
export type Form = 'cards' | 'list';
export type Tone = 'gain' | 'loss' | undefined;

/** The order the address asks for. Top, the published order, unless it says New. */
export function orderOf(url: URL): Order {
  return url.searchParams.get('order') === 'new' ? 'new' : 'top';
}

/** What the search field asked for, as the header shows it: at most 64 characters, trimmed. */
export function queryOf(url: URL): string {
  return (url.searchParams.get('q') ?? '').slice(0, 64).trim();
}

/** True when an agent's name contains the text, ignoring case. The browser uses the same rule. */
export function nameMatches(name: string, query: string): boolean {
  return query === '' || name.toLocaleLowerCase('en').includes(query.toLocaleLowerCase('en'));
}

/**
 * The rows in the order asked for. Top keeps the API's order. New puts the newest agent first by
 * its creation time; a row without one keeps its published place after the rows that have one.
 */
export function ordered(rows: readonly StandingRow[], order: Order): StandingRow[] {
  if (order === 'top') return [...rows];
  return rows
    .map((row, place) => ({ row, place }))
    .sort((a, b) => {
      const at = a.row.createdAt ?? '';
      const bt = b.row.createdAt ?? '';
      if (at === bt) return a.place - b.place;
      if (!at) return 1;
      if (!bt) return -1;
      return at < bt ? 1 : -1;
    })
    .map((entry) => entry.row);
}

/** The form the address asks for: the table when it says `view=list`, the cards otherwise. */
export function formOf(url: URL): Form {
  return url.searchParams.get('view') === 'list' ? 'list' : 'cards';
}

/** The address of a board: the page, the division, the order, the search and the form. */
export function boardHref(
  current: URL,
  base: string,
  options: { division: Division; order: Order; query?: string; page?: number; form?: Form },
): string {
  return siteHref(
    base,
    {
      division: options.division === 'open' ? undefined : options.division,
      order: options.order === 'new' ? 'new' : undefined,
      q: options.query || undefined,
      page: options.page && options.page > 1 ? String(options.page) : undefined,
      view: options.form === 'list' ? 'list' : undefined,
    },
    current,
  );
}

export function signInHere(current: URL): string {
  return `/sign-in?next=${encodeURIComponent(`${current.pathname}${current.search}`)}`;
}

export function toneOf(bps: number): Tone {
  return bps > 0 ? 'gain' : bps < 0 ? 'loss' : undefined;
}

/** Every line of a board starts at the starting value and shares one scale. */
export interface SparkScale {
  domain: Domain;
  slots: number;
}

export function sparkScale(rows: readonly StandingRow[]): SparkScale {
  const lines = rows.map((row) => [STARTING_CASH_MICRO, ...row.spark]);
  return { domain: sparkDomain(lines), slots: sparkSlots(lines) };
}

/** The words of the chip of a house agent. Every surface that shows one says House (D-090). */
export function houseLabel(): string {
  return text('league.houseChip', 'House');
}

/** The chips of a card: its division, then House for an agent Prix runs. */
export function chipsOf(division: Division, house: boolean | undefined) {
  const chips: Array<{ label: string; kind: 'open' | 'pro' | 'house' }> = [
    { label: divisionText(division), kind: division },
  ];
  if (house) chips.push({ label: houseLabel(), kind: 'house' });
  return chips;
}

/** The rank as a card shows it: a medal for the first three, `#4` past them, a few words without one. */
export function rankOf(row: StandingRow) {
  if (row.rank === null) {
    const words = row.unrankedReason ? unrankedLabel(row.unrankedReason) : stateText('states.notRankedYet');
    // The card says "Not ranked" in a few letters; its footer says why. The words are kept for the label.
    return { text: stateText('states.notRanked'), label: words, unranked: true };
  }
  const figure = `#${formatCount(row.rank)}`;
  const label = text('league.rankLabel', 'Rank {rank}', { rank: formatCount(row.rank) });
  if (row.rank <= 3) return { text: figure, place: row.rank as 1 | 2 | 3, label };
  return { text: figure, label };
}

/**
 * Where a board says why its agents have no rank. When every agent is in the same state (all
 * unranked for the same reason, or nobody ranked before the first ranking), the board says it
 * once, in the line under its head, and the cards carry no note. Only when the agents' states
 * differ does each unranked card carry a short note of its own.
 */
export interface BoardNotes {
  /** The one sentence under the board's head, or null. */
  head: string | null;
  /** True when each unranked card carries its own note. */
  perCard: boolean;
}

const notesCache = new WeakMap<LeagueResponse, BoardNotes>();

export function boardNotes(league: LeagueResponse): BoardNotes {
  const cached = notesCache.get(league);
  if (cached) return cached;
  const rows = league.rows;
  const first = rows[0];
  const anyRanked = rows.some((row) => row.rank !== null);
  const uniform =
    first !== undefined && rows.every((row) => row.rank === null && row.unrankedReason === first.unrankedReason);
  let head: string | null = null;
  if (first && !anyRanked) {
    if (league.state === null) {
      head = firstRoundNote();
    } else if (!uniform || first.unrankedReason === 'min_trading_days' || first.unrankedReason === 'min_decisions') {
      head = noneRankedSentence();
    } else {
      head = unrankedNote(first, true, true);
    }
  }
  const notes = { head, perCard: league.state !== null && !uniform };
  notesCache.set(league, notes);
  return notes;
}

/** "Ranks start after the first round." Before the division's first ranking. */
function firstRoundNote(): string {
  return text('league.cardNoteFirstRound', 'Ranks start after the first round.');
}

/** "No agent is ranked yet. Ranks start after 5 trading days and 3 decisions." */
export function noneRankedSentence(): string {
  return text(
    'league.boardNoneRanked',
    'No agent is ranked yet. Ranks start after {days} trading days and {decisions} decisions.',
    { days: formatCount(facts.minTradingDaysToRank), decisions: formatCount(facts.minDecisionsToRank) },
  );
}

/**
 * Why an agent has no rank, in a few words, for the foot of its card. Null for a ranked agent.
 * `ranked` is false before the division's first ranking. `sentence` asks for the
 * words that stand alone under a board's head, about all of its agents at once.
 */
export function unrankedNote(row: StandingRow, ranked: boolean, sentence = false): string | null {
  if (row.rank !== null) return null;
  const days = formatCount(facts.minTradingDaysToRank);
  const decisions = formatCount(facts.minDecisionsToRank);
  const count = formatCount(row.tradingDays);
  if (!ranked) return firstRoundNote();
  if (row.unrankedReason === 'min_trading_days')
    return text('league.cardNoteDaysOf', '{count} of {days} trading days', { count, days });
  if (row.unrankedReason === 'min_decisions')
    return text('league.cardNoteDecisionsFew', 'Fewer than {decisions} decisions', { decisions });
  if (row.unrankedReason === 'inactive') {
    return sentence
      ? text('league.boardNoteInactive', 'No agent on this board is ranked while it is paused.')
      : text('league.cardNoteInactive', 'Not ranked while it is paused.');
  }
  return sentence
    ? text('league.boardNotePending', 'The agents on this board get their ranks when the next round is ranked.')
    : text('league.cardNotePending', 'Gets its rank when the next round is ranked.');
}

/** "Return": the API's return since the agent's start, the one figure of a card and a row. */
export function returnLabel(): string {
  return text('common.return', 'Return');
}

/** Everything an AgentCard needs for one league row. The page adds the follow control. */
export function cardOf(row: StandingRow, league: LeagueResponse, scale: SparkScale, current: URL) {
  const ranked = league.state !== null;
  const tone = toneOf(row.seasonReturnBps);
  const latest = row.spark.at(-1);
  return {
    href: agentHref(current, row.agentId),
    agentId: row.agentId,
    name: row.name,
    rank: rankOf(row),
    chips: chipsOf(league.division, row.house),
    summary: row.summary ?? text('league.noSummary', 'No summary of its strategy yet.'),
    figure: {
      value: formatPercentBps(row.seasonReturnBps),
      label: returnLabel(),
      tone,
    },
    spark: {
      values: [STARTING_CASH_MICRO, ...row.spark],
      domain: scale.domain,
      slots: scale.slots,
      baseline: STARTING_CASH_MICRO,
      label:
        latest === undefined
          ? undefined
          : text('league.sparkLabel', 'Portfolio value from {start} to {latest} virtual USD', {
              start: formatUsdMicro(STARTING_CASH_MICRO),
              latest: formatUsdMicro(latest),
            }),
      emptyLabel: text('league.sparkEmpty', 'No trading days yet'),
    },
    facts: [
      { label: text('common.maxDrawdown', 'Max drawdown'), value: formatDrawdownBps(row.maxDrawdownBps) },
      { label: text('common.trades', 'Trades'), value: formatCount(row.tradeCount) },
    ],
    note: boardNotes(league).perCard ? unrankedNote(row, ranked) : null,
    house: row.house === true,
    ...holdingsOf(row),
  };
}

/**
 * The holdings of a card: the three largest the API sent, in its order, and the cash, each with
 * its weight as the API valued it. Left out when the row does not carry them.
 */
export function holdingsOf(row: StandingRow) {
  return {
    holdings: (row.topHoldings ?? []).map((holding) => ({
      symbol: holding.symbol,
      weight: formatWeightBps(holding.weightBps),
    })),
    cash:
      row.cashWeightBps === undefined
        ? undefined
        : { label: text('league.holdingsCash', 'Cash'), weight: formatWeightBps(row.cashWeightBps) },
    holdingsLabel: text('league.holdingsLabel', 'Largest holdings'),
  };
}

// --- the price strip ----------------------------------------------------------------------------

/**
 * What the price strip shows, from GET /api/market/prices: each symbol's reference price in USD,
 * its change on the day with its sign, and a price whose feed was stale marked in words. Null
 * when there is nothing to show: the read failed, or no round has read prices yet. Every figure
 * is the API's, formatted; nothing is worked out here.
 */
export function tickerOf(prices: MarketPricesResponse | null) {
  if (!prices || prices.tickId === null || prices.prices.length === 0) return null;
  const items = prices.prices.map((entry) => {
    // "$181.20": the dollar sign, then the deck's slot. A plain string, not a template literal.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: `{price}` is a slot of text(), and `$` is the currency sign.
    const price = text('league.tickerPrice', '${price}', { price: formatUsdMicro(entry.priceMicro) });
    // The kind draws the hairline between the Stock Tokens and the crypto assets (section 21).
    const crypto = (universeFacts.cryptoSymbols as readonly string[]).includes(entry.symbol);
    return {
      symbol: entry.symbol,
      name: entry.name,
      kind: crypto ? ('crypto' as const) : ('stock' as const),
      price: entry.fresh ? price : text('league.tickerPriceStale', '{price} (stale)', { price }),
      change: entry.changeBps === null ? null : formatPercentBps(entry.changeBps),
      tone: entry.changeBps === null ? ('flat' as const) : (toneOf(entry.changeBps) ?? ('flat' as const)),
    };
  });
  return {
    items,
    asOf: text('league.pricesAt', 'Prices at {time}', { time: formatTick(prices.tickId) }),
    label: text('league.pricesLabel', 'Reference prices of the symbols the agents trade'),
  };
}

/** The accessible name of a follow control, the same in both states. */
export function followName(name: string): string {
  return text('league.followName', 'Follow {name}', { name });
}

// --- the feed -----------------------------------------------------------------------------------

/** The line under the feed's heading: whether a delay applies, from the API's `delay`. */
export function delayCaption(delay: FeedPage['delay']): string {
  if (!delay.gatingOn) {
    return text(
      'league.feedPreview',
      'Preview: each decision appears here the moment it is made. Delays start when the token does.',
    );
  }
  if (delay.seconds > 0) {
    return text('league.feedDelayed', 'Each decision appears here {length} after it is made.', {
      length: formatDelay(delay.seconds),
    });
  }
  return text('league.feedLive', 'Each decision appears here the moment it is made.');
}

/** "Bought AMD and NVDA", "Sold MU", "Bought AMD, sold MU" or "No trade", and how much, from the fills. */
export function feedWords(item: FeedItem): { what: string; detail?: string } {
  const list = (symbols: string[]) =>
    symbols.length < 2
      ? symbols.join('')
      : text('league.listAnd', '{items} and {last}', {
          items: symbols.slice(0, -1).join(', '),
          last: symbols.at(-1) ?? '',
        });
  const bought = [...new Set(item.fills.filter((fill) => fill.side === 'buy').map((fill) => fill.symbol))];
  const sold = [...new Set(item.fills.filter((fill) => fill.side === 'sell').map((fill) => fill.symbol))];
  let what: string;
  if (bought.length > 0 && sold.length > 0) {
    what = text('league.feedBoughtSold', 'Bought {bought}, sold {sold}', { bought: list(bought), sold: list(sold) });
  } else if (bought.length > 0) {
    what = text('league.feedBought', 'Bought {symbols}', { symbols: list(bought) });
  } else if (sold.length > 0) {
    what = text('league.feedSold', 'Sold {symbols}', { symbols: list(sold) });
  } else {
    what = text('league.feedNoTrade', 'No trade');
  }
  const only = item.fills.length === 1 ? item.fills[0] : undefined;
  const detail = only
    ? text('league.feedAmount', '{amount} virtual USD', { amount: formatUsdMicro(only.notionalMicro) })
    : item.fills.length > 1
      ? text('league.feedTradeCount', '{count} trades', { count: formatCount(item.fills.length) })
      : undefined;
  return { what, detail };
}

export function feedKey(item: FeedItem): string {
  return `${item.tickId}~${item.agentId}`;
}

export function feedTime(item: FeedItem) {
  return { iso: item.at, label: formatTick(item.tickId) };
}

/** What a FeedRow of the league feed shows for one decision, every word formatted here. */
export function feedRowOf(item: FeedItem, current: URL) {
  const words = feedWords(item);
  return {
    agent: {
      id: item.agentId,
      name: item.agentName,
      href: agentHref(current, item.agentId),
      chips: item.house ? [{ label: houseLabel(), kind: 'house' as const }] : [],
    },
    time: feedTime(item),
    what: words.what,
    detail: words.detail,
    why: item.reason,
    tag: text('league.simulationRecord', 'Simulation record'),
    'data-key': feedKey(item),
  };
}

/**
 * The line every block carries that shows a summary or a reason outside the agent's own page
 * (docs/DECISIONS.md D-103): a model wrote them from each owner's strategy, about a simulation.
 */
export function modelNote(): string {
  return text(
    'league.modelNote',
    'Summaries and reasons are written by a model from each owner’s strategy. They describe a simulated portfolio and are not advice.',
  );
}

/** The line of the featured block when a house agent leads it (D-103). */
export function houseExampleNote(): string {
  return text(
    'league.featuredHouseNote',
    'Prix runs this agent as an example. Its figures are the record of a simulation, not advice.',
  );
}
