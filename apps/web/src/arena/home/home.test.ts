// The home page's hero (docs/DESIGN.md sections 5.3 and 29, R17): the board, its key and states,
// and the latest decisions beside it. Run: pnpm exec vitest run --config apps/web/src/arena/vitest.config.ts
import type { FeedItem, FeedPage, LeagueResponse, StandingRow } from '@prix/contracts';
import { MIN_DECISIONS_TO_RANK, MIN_TRADING_DAYS_TO_RANK, STARTING_CASH_MICRO } from '@prix/contracts';
import { describe, expect, it } from 'vitest';
import { inWords } from '../../content/facts.ts';
import { closedSentence } from '../words.ts';
import {
  actionWords,
  BOARD_SIZE,
  boardEmptyOf,
  boardKey,
  boardView,
  DECISIONS_SIZE,
  decisionRows,
  decisionsNote,
  decisionsQuiet,
  keepTimeTogether,
  leaguePaused,
  rankRule,
  roundSentence,
} from './home.ts';

// Sample data for this check only: made-up agents, ids, returns and times.
// The no-break space that keeps "15:00 UTC" and "13 Oct" on one line.
const NB = ' ';
const HERE = new URL('https://prixagent.com/');
const AT = '2026-10-13T15:00Z';
// 16:30 UTC on a Tuesday: inside the window of rounds, after the check of this window.
const NOW = Date.parse('2026-10-13T16:30:00.000Z');

function row(index: number, rank: number | null, extra: Partial<StandingRow> = {}): StandingRow {
  return {
    rank,
    unrankedReason: rank === null ? 'min_trading_days' : null,
    agentId: `agent${String(index).padStart(7, '0')}`,
    name: `Sample Agent ${index}`,
    seasonReturnBps: 100 - index * 40,
    maxDrawdownBps: 15 * index,
    tradeCount: index,
    tradingDays: 6,
    equityMicro: STARTING_CASH_MICRO,
    spark: [STARTING_CASH_MICRO + index, STARTING_CASH_MICRO - index],
    lastStatus: 'decided',
    house: false,
    ...extra,
  };
}

function league(rows: StandingRow[], extra: Partial<LeagueResponse> = {}): LeagueResponse {
  const ranked = rows.filter((entry) => entry.rank !== null).length;
  return {
    season: { id: 'season00001', number: 1, startsAt: '2026-10-05T00:00:00.000Z', endsAt: '2026-11-02T00:00:00.000Z' },
    division: 'open',
    seasonEnded: false,
    market: { open: true, closedReason: null, checkedAt: '2026-10-13T15:00:02.000Z', lastTickId: AT, halted: [] },
    state: {
      seasonId: 'season00001',
      division: 'open',
      tickId: AT,
      computedAt: '2026-10-13T15:04:00.000Z',
      method: 'v1',
      rankedCount: ranked,
      agentCount: rows.length,
    },
    rows,
    page: 1,
    hasMore: false,
    round: null,
    ...extra,
  };
}

function item(index: number, house: boolean | undefined, sides: Array<'buy' | 'sell'>): FeedItem {
  return {
    agentId: `agent${String(index).padStart(7, '0')}`,
    agentName: `Sample Agent ${index}`,
    division: 'open',
    tickId: AT,
    at: '2026-10-13T15:03:00.000Z',
    reason: `A REASON THE MODEL WROTE ${index}, buy NVDA now`,
    fills: sides.map((side, place) => ({
      symbol: side === 'buy' ? (['SGOV', 'NVDA'][place % 2] ?? 'SGOV') : 'USO',
      side,
      unitsMicro: 1_000_000,
      priceMicro: 100_000_000,
      notionalMicro: 100_000_000,
      feeMicro: 0,
      slippageMicro: 0,
    })),
    halted: [],
    equityMicro: STARTING_CASH_MICRO,
    costMicro: 0,
    simulated: true,
    ...(house === undefined ? {} : { house }),
  };
}

const feed = (items: FeedItem[], delay = { seconds: 86_400, gatingOn: true }): FeedPage => ({
  items,
  nextCursor: null,
  delay,
});

describe('the rank rule under the board', () => {
  it('names both numbers of the contract: trading days and decisions', () => {
    expect(rankRule()).toBe(
      `A rank needs ${inWords(MIN_TRADING_DAYS_TO_RANK)} trading days and ${inWords(MIN_DECISIONS_TO_RANK)} decisions.`,
    );
    const key = boardKey(league([row(1, 1), row(2, 2)]), NOW);
    expect(key).toContain('five trading days and three decisions');
  });

  it('says how many are ranked when some are not, and never the rule twice when none is', () => {
    const some = boardKey(league([row(1, 1), row(2, null), row(3, null)]), NOW);
    expect(some).toContain('Ranked so far: 1 of 3.');
    const none = boardKey(league([row(1, null), row(2, null)]), NOW);
    expect(none).toContain('These agents are listed by return so far.');
    expect(none).not.toContain('A rank needs');
  });
});

describe('the board', () => {
  it('shows the first five rows in the order the API sent, ranks and unranked as given', () => {
    // The API's order, on purpose not the order of the returns.
    const rows = [row(4, 1), row(1, 2), row(9, 3), row(2, 4), row(3, null), row(5, null), row(6, null)];
    const view = boardView(league(rows), NOW, HERE);
    expect(view.rows).toHaveLength(BOARD_SIZE);
    expect(view.rows.map((entry) => entry.agent.name)).toEqual(rows.slice(0, 5).map((entry) => entry.name));
    expect(view.rows.map((entry) => entry.rank)).toEqual([1, 2, 3, 4, null]);
    expect(view.rows[4]?.rankLabel).toBeUndefined();
  });

  it('gives every gain and loss its sign, and every line the start value first on one scale', () => {
    const view = boardView(league([row(1, 1), row(5, 2)]), NOW, HERE);
    expect(view.rows[0]?.figure).toEqual({ text: '+0.60%', tone: 'gain' });
    expect(view.rows[1]?.figure.text).toBe('−1.00%');
    expect(view.rows[1]?.figure.tone).toBe('loss');
    for (const entry of view.rows) expect(entry.line.values[0]).toBe(STARTING_CASH_MICRO);
    expect(view.baseline).toBe(STARTING_CASH_MICRO);
  });

  it('says its title, meta line and link without a middle dot or an arrow', () => {
    const rows = Array.from({ length: 12 }, (_, index) => row(index + 1, index + 1));
    const view = boardView(league(rows), NOW, HERE);
    expect(view.title).toBe('Top five of 12 agents');
    expect(view.meta).toBe(`Open division, after the round of 13${NB}Oct, 15:00${NB}UTC`);
    expect(view.more).toEqual({ label: 'See all 12 agents', href: '/league' });
    for (const words of [view.title, view.meta, view.more.label, view.key]) {
      expect(words).not.toMatch(/[·•∙⋅→]|->/);
    }
  });

  it('marks the house agents and an agent that made no decision in the last round', () => {
    const rows = [
      row(1, 1, { house: true }),
      row(2, 2, { lastStatus: 'skipped' }),
      row(3, 3, { lastStatus: 'no_decision' }),
    ];
    const view = boardView(league(rows), NOW, HERE);
    expect(view.rows[0]?.chips).toEqual([{ label: 'Run by Prix', kind: 'house' }]);
    expect(view.rows[1]?.chips).toEqual([{ label: 'No decision', kind: 'neutral' }]);
    expect(view.rows[2]?.chips).toEqual([{ label: 'No decision', kind: 'neutral' }]);
    expect(view.title).toBe('All 3 agents');
  });

  it('keeps the state of an agent that made no decision a short chip, no longer than the house chip', () => {
    // On a phone the chip stands in a name cell of about 110 px at 320: a long label wrapped into a
    // two-line box (the design check of 2026-10-14). The round it speaks of is the meta line's.
    const view = boardView(league([row(1, 1, { house: true, lastStatus: 'skipped' })]), NOW, HERE);
    const [house, skipped] = view.rows[0]?.chips ?? [];
    expect(house?.kind).toBe('house');
    expect(skipped?.label.length).toBeLessThanOrEqual(house?.label.length ?? 0);
  });

  it('never parts a time from its zone, or a day from its month, in the meta line and the key', () => {
    const closed = league([row(1, 1), row(2, null)], {
      market: {
        open: false,
        closedReason: 'feeds_stale',
        checkedAt: '2026-10-13T15:00:02.000Z',
        lastTickId: AT,
        halted: [],
      },
    });
    const view = boardView(closed, NOW, HERE);
    const night = boardKey(league([row(1, 1)]), Date.parse('2026-10-13T22:00:00.000Z'));
    for (const words of [view.meta, view.key, night]) {
      expect(words, words).toMatch(/\d\d:\d\d\u00a0UTC/);
      expect(words, words).not.toMatch(/\d\d:\d\d UTC|\d (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/);
    }
    expect(keepTimeTogether('after the round of 6 Oct, 15:00 UTC')).toBe(`after the round of 6${NB}Oct, 15:00${NB}UTC`);
  });

  it('claims a "top five" only when all five rows are ranked (DESIGN 5.3, the states)', () => {
    const many = (ranks: Array<number | null>) => ranks.map((rank, index) => row(index + 1, rank));
    const allRanked = boardView(league(many([1, 2, 3, 4, 5, 6, null])), NOW, HERE);
    expect(allRanked.title).toBe('Top five of 7 agents');
    const mixed = boardView(league(many([1, 2, null, null, null, null, null, null])), NOW, HERE);
    expect(mixed.title).toBe('Five of 8 agents');
    expect(mixed.caption).not.toMatch(/top five/i);
    const none = boardView(league(many([null, null, null, null, null, null, null, null, null])), NOW, HERE);
    expect(none.title).toBe('Five of 9 agents, none ranked yet');
    expect(none.caption).not.toMatch(/top five/i);
    expect(none.caption).toContain('none ranked yet');
    // Five or fewer: every agent is shown, and the title says so; with none ranked it says that too.
    expect(boardView(league(many([null, null, null])), NOW, HERE).title).toBe('All 3 agents, none ranked yet');
    expect(boardView(league(many([1, null, null])), NOW, HERE).title).toBe('All 3 agents');
  });

  it('names a division before its first round', () => {
    const view = boardView(league([row(1, null)], { state: null }), NOW, HERE);
    expect(view.meta).toBe('Open division, before its first round');
    expect(view.title).toBe('One agent in the league');
    expect(view.more.label).toBe('See the league table');
  });
});

describe('the states of the board', () => {
  it('has a designed state for no agent, no league and a failed read', () => {
    expect(boardEmptyOf({ ok: true, data: league([row(1, 1)]) })).toBeNull();
    expect(boardEmptyOf({ ok: true, data: league([]) })?.kind).toBe('empty');
    expect(boardEmptyOf({ ok: false, error: { code: 'not_found' } })).toMatchObject({
      kind: 'none',
      title: 'The league has not started',
    });
    // A failed read says only what the page knows: it could not read the league. It never claims
    // the league is running, because the read that would tell it just failed.
    expect(boardEmptyOf({ ok: false, error: { code: 'internal' } })).toEqual({
      kind: 'failed',
      title: 'The board did not load',
      body: 'Prix could not read the league just now. Reload the page to try again.',
    });
    expect(JSON.stringify(boardEmptyOf({ ok: false, error: { code: 'internal' } }))).not.toMatch(/running/i);
    expect(boardEmptyOf({ ok: false, error: { code: 'daily_limit' } })?.kind).toBe('failed');
  });

  it('says a round is running, the market is closed, or when the next round is', () => {
    // The Pro board: its agents decide every hour of the window.
    const pro = (rows: StandingRow[], extra: Partial<LeagueResponse> = {}) =>
      league(rows, { division: 'pro', ...extra });
    const running = pro([row(1, 1)], { round: { tickId: '2026-10-13T16:00Z', pending: 3 } });
    expect(roundSentence(running, NOW)).toBe(
      `The round of 13${NB}Oct, 16:00${NB}UTC is running. The board shows the round before it until this one ends.`,
    );
    const closed = pro([row(1, 1)], {
      market: {
        open: false,
        closedReason: 'feeds_stale',
        checkedAt: '2026-10-13T15:00:02.000Z',
        lastTickId: AT,
        halted: [],
      },
    });
    expect(roundSentence(closed, NOW)).toBe(`The market is closed. Next round: 13${NB}Oct, 17:00${NB}UTC.`);
    // A pause of the league is not a closed market: it says why, and still when the next round is.
    const paused = pro([row(1, 1)], {
      market: {
        open: false,
        closedReason: 'rpc_unavailable',
        checkedAt: '2026-10-13T15:00:02.000Z',
        lastTickId: AT,
        halted: [],
      },
    });
    expect(roundSentence(paused, NOW)).toMatch(/^The league is paused because .+ Next round: 13 Oct, 17:00 UTC\.$/);
    expect(roundSentence(pro([row(1, 1)]), NOW)).toBe(`Next round: 13${NB}Oct, 17:00${NB}UTC.`);
    // At night no round is left today: the next trading day's first round, without a date it cannot know.
    const night = Date.parse('2026-10-13T22:00:00.000Z');
    expect(roundSentence(pro([row(1, 1)]), night)).toBe(
      `The next round is due at 15:00${NB}UTC on the next trading day.`,
    );
    expect(boardKey(running, NOW)).toContain('is running');
  });

  it('gives each division its own next round at 16:30 UTC on a weekday: Open decides only at the daily tick', () => {
    // Open agents decide only at the daily tick of OPEN_DAILY_TICK_HOUR_UTC (packages/runtime
    // scheduler.ts; apps/api routes-public.ts). Once its hour has passed today, the Open board's next
    // round is on the next trading day; the Pro board keeps the hourly round.
    const later = `The next round is due at 15:00${NB}UTC on the next trading day.`;
    const division = (name: 'open' | 'pro', extra: Partial<LeagueResponse> = {}) => {
      const base = league([row(1, 1)], extra);
      return { ...base, division: name, state: base.state ? { ...base.state, division: name } : null };
    };
    expect(roundSentence(division('pro'), NOW)).toBe(`Next round: 13${NB}Oct, 17:00${NB}UTC.`);
    expect(roundSentence(division('open'), NOW)).toBe(later);
    expect(boardKey(division('open'), NOW)).toContain(later);
    expect(boardKey(division('open'), NOW)).not.toContain('17:00');
    // The closed market says the same of each division.
    const shut = {
      market: {
        open: false,
        closedReason: 'feeds_stale' as const,
        checkedAt: '2026-10-13T15:00:02.000Z',
        lastTickId: AT,
        halted: [],
      },
    };
    expect(roundSentence(division('pro', shut), NOW)).toBe(
      `The market is closed. Next round: 13${NB}Oct, 17:00${NB}UTC.`,
    );
    const openShut = roundSentence(division('open', shut), NOW) ?? '';
    // With no round of its own left today, the closure is said in the sentence every page uses for it.
    expect(openShut).toBe(`${closedSentence('feeds_stale')} ${later}`);
    expect(openShut).not.toContain('17:00');
    // A pause of the league, the same.
    const paused = { market: { ...shut.market, closedReason: 'rpc_unavailable' as const } };
    expect(roundSentence(division('open', paused), NOW)).toMatch(
      /^The league is paused because .+ on the next trading day\.$/,
    );
    // Before the daily tick's hour on a weekday, the Open board's next round is today's daily tick.
    const morning = Date.parse('2026-10-13T09:30:00.000Z');
    expect(roundSentence(division('open'), morning)).toBe(`Next round: 13${NB}Oct, 15:00${NB}UTC.`);
    expect(roundSentence(division('pro'), morning)).toBe(`Next round: 13${NB}Oct, 15:00${NB}UTC.`);
    // On a Saturday no round is due today in either division.
    const saturday = Date.parse('2026-10-17T09:30:00.000Z');
    expect(roundSentence(division('open'), saturday)).toBe(later);
  });

  it('puts the state of the league second in the key, after the start and before the rank rule', () => {
    const start = 'Every agent starts with 10,000 virtual USD.';
    const market = (closedReason: 'feeds_stale' | 'rpc_unavailable') => ({
      open: false,
      closedReason,
      checkedAt: '2026-10-13T15:00:02.000Z',
      lastTickId: AT,
      halted: [],
    });
    const cases = [
      league([row(1, 1), row(2, null)], { round: { tickId: '2026-10-13T16:00Z', pending: 3 } }),
      league([row(1, 1), row(2, null)], { market: market('feeds_stale') }),
      league([row(1, 1), row(2, null)], { market: market('rpc_unavailable') }),
      league([row(1, null), row(2, null)], { market: market('rpc_unavailable') }),
    ];
    for (const entry of cases) {
      const key = boardKey(entry, NOW);
      const state = roundSentence(entry, NOW) ?? '';
      expect(state).not.toBe('');
      expect(key.startsWith(`${start} ${state} `), key).toBe(true);
    }
    // The rank rule and the count of the ranked follow the state.
    const paused = boardKey(cases[2] as LeagueResponse, NOW);
    expect(paused.indexOf('paused')).toBeLessThan(paused.indexOf('A rank needs'));
    expect(paused.indexOf('A rank needs')).toBeLessThan(paused.indexOf('Ranked so far'));
  });

  it('says a pause in the meta line under the title, so it stands above the fold at every width', () => {
    const paused = league([row(1, 1)], {
      market: {
        open: false,
        closedReason: 'rpc_unavailable',
        checkedAt: '2026-10-13T15:00:02.000Z',
        lastTickId: AT,
        halted: [],
      },
    });
    expect(leaguePaused(paused, NOW)).toBe(true);
    expect(boardView(paused, NOW, HERE).meta).toBe(
      `Open division, paused after the round of 13${NB}Oct, 15:00${NB}UTC`,
    );
    // A plain closure (prices standing still) and an open market keep the meta line of any round.
    const closed = league([row(1, 1)], {
      market: { ...(paused.market as NonNullable<LeagueResponse['market']>), closedReason: 'feeds_stale' },
    });
    expect(leaguePaused(closed, NOW)).toBe(false);
    expect(boardView(closed, NOW, HERE).meta).toBe(`Open division, after the round of 13${NB}Oct, 15:00${NB}UTC`);
    expect(leaguePaused(league([row(1, 1)]), NOW)).toBe(false);
    // Before the first round, paused.
    expect(boardView({ ...paused, state: null }, NOW, HERE).meta).toBe('Open division, paused before its first round');
  });
});

describe('the latest decisions', () => {
  it('shows only the agents Prix runs, at most five', () => {
    const items = [
      item(1, true, ['buy']),
      item(2, false, ['buy']),
      item(3, undefined, ['sell']),
      ...Array.from({ length: 7 }, (_, index) => item(10 + index, true, [])),
    ];
    const rows = decisionRows(feed(items), HERE);
    expect(rows).toHaveLength(DECISIONS_SIZE);
    expect(rows.map((entry) => entry.agent.name)).not.toContain('Sample Agent 2');
    expect(rows.map((entry) => entry.agent.name)).not.toContain('Sample Agent 3');
    expect(rows[0]?.agent.name).toBe('Sample Agent 1');
  });

  it('shows none of the decisions of a user agent that leads the board', () => {
    // A user's agent at rank 1, a house agent behind it; the feed's newest items are the user's.
    const board = boardView(league([row(1, 1, { house: false }), row(2, 2, { house: true })]), NOW, HERE);
    expect(board.rows[0]?.agent.name).toBe('Sample Agent 1');
    const rows = decisionRows(
      feed([item(1, false, ['buy']), item(1, false, ['sell']), item(2, true, ['buy']), item(1, undefined, [])]),
      HERE,
    );
    expect(rows.map((entry) => entry.agent.name)).toEqual(['Sample Agent 2']);
    expect(rows.map((entry) => entry.agent.id)).not.toContain(board.rows[0]?.agent.id);
  });

  it('carries the agent, the action and the time, never the stored reason', () => {
    const rows = decisionRows(feed([item(1, true, ['buy', 'sell']), item(2, true, [])]), HERE);
    for (const entry of rows) {
      expect(Object.keys(entry).sort()).toEqual(['agent', 'data-key', 'tag', 'time', 'what']);
      expect(JSON.stringify(entry)).not.toContain('REASON');
    }
    expect(rows[0]?.what).toBe('Bought SGOV, sold USO');
    expect(rows[1]?.what).toBe('No trade');
    expect(rows[0]?.time.label).toBe('13 Oct, 15:00 UTC');
    expect(rows[0]?.tag).toBe('Simulation record');
  });

  it('words each action from the fills', () => {
    expect(actionWords(item(1, true, ['buy']))).toBe('Bought SGOV');
    expect(actionWords(item(1, true, ['buy', 'buy']))).toBe('Bought SGOV, NVDA');
    expect(actionWords(item(1, true, ['sell']))).toBe('Sold USO');
  });

  it('says the delay the API applied, and a designed sentence when there is nothing to show', () => {
    expect(decisionsNote({ seconds: 86_400, gatingOn: true })).toBe(
      'By the agents Prix runs as examples. Each appears here 24 hours after it is made.',
    );
    expect(decisionsNote({ seconds: 0, gatingOn: false })).toBe(
      'By the agents Prix runs as examples. Each appears here as it is made.',
    );
    expect(decisionsQuiet(null).title).toBe('The latest decisions did not load');
    expect(decisionsQuiet(feed([])).body).toContain('24 hours after it is made');
    expect(decisionsQuiet(feed([], { seconds: 0, gatingOn: false })).body).not.toContain('minute');
  });

  it('words the delay from the seconds the league feed cut by, nothing else', () => {
    // The league feed shows a row only once it is `delay.seconds` old (apps/api feed-read.ts,
    // visibleCutoff), every row and the house agents' alike: the sentence follows those seconds.
    expect(decisionsNote({ seconds: 86_400, gatingOn: false })).toContain('24 hours after it is made');
    expect(decisionsQuiet(feed([], { seconds: 86_400, gatingOn: false })).body).toContain('24 hours after it is made');
    expect(decisionsNote({ seconds: 0, gatingOn: true })).toContain('as it is made');
  });
});
