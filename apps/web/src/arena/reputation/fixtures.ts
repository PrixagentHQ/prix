import type {
  AgentTrackRecord,
  ListingDay,
  ListingDetail,
  ListingPublic,
  ScoreBreakdown,
  ScoringDivision,
  SeasonArchiveEntry,
  SeasonResultRow,
} from '@prix/contracts';
import { CHAIN_EXCLUSIONS, CHAIN_METHOD, explorerAddressUrl, explorerTxUrl } from '@prix/contracts';

/**
 * SAMPLE DATA. Used only when the site is built with PRIX_FIXTURES=1; a production build drops it.
 * `?fixture=` picks a state: `empty` (nothing yet), `error` (the API is down), `notfound` (404).
 * Without it every read answers with the full sample below, which has a v1 season, a v2 season,
 * an unranked row for each of the three reasons and a chain division.
 */

export type FixtureAnswer =
  | { kind: 'data'; data: unknown }
  | { kind: 'error'; status: number; code: 'not_found' | 'internal'; message: string };

const S1 = 'aaaaaaaaaaaa';
const S2 = 'bbbbbbbbbbbb';
const WALLET = `0x${'7a3f'.repeat(10)}`;
const OTHER_WALLET = `0x${'c91e'.repeat(10)}`;
const SEASON_1 = { id: S1, number: 1, startsAt: '2026-08-04T00:00:00.000Z', endsAt: '2026-09-01T00:00:00.000Z' };
const SEASON_2 = { id: S2, number: 2, startsAt: '2026-09-08T00:00:00.000Z', endsAt: '2026-11-03T00:00:00.000Z' };

const ENTRIES: SeasonArchiveEntry[] = [
  {
    season: SEASON_2,
    method: 'v2',
    lengthDays: 56,
    frozenAt: null,
    rankedCount: { open: 3, pro: 1, chain: 1 },
    agentCount: { open: 7, pro: 2, chain: 2 },
  },
  {
    season: SEASON_1,
    method: 'v1',
    lengthDays: 28,
    frozenAt: '2026-09-01T01:00:00.000Z',
    rankedCount: { open: 2, pro: 0, chain: 0 },
    agentCount: { open: 3, pro: 0, chain: 0 },
  },
];

const BREAKDOWN: ScoreBreakdown = {
  n: 34,
  meanMilliBps: 21_400,
  volMilliBps: 96_300,
  ratioMilli: 222,
  shrinkMilli: 630,
  scoreMilli: 140,
};

/** Three return days: the weight is 3 / (3 + 20), about 13%, and the score is the ratio times it. */
const SHORT_BREAKDOWN: ScoreBreakdown = { ...BREAKDOWN, n: 3, shrinkMilli: 130, scoreMilli: 29 };

function row(over: Partial<SeasonResultRow> & Pick<SeasonResultRow, 'agentId' | 'name'>): SeasonResultRow {
  return {
    rank: null,
    unrankedReason: null,
    division: 'open',
    method: 'v2',
    returnBps: 0,
    maxDrawdownBps: 0,
    tradingDays: 0,
    decidedCount: 0,
    scoreMilli: 0,
    confidence: 'insufficient',
    scoredDay: '2026-10-05',
    ...over,
  };
}

const V2_OPEN: SeasonResultRow[] = [
  row({
    rank: 1,
    agentId: 'ccccccccccc2',
    name: 'Harbor Light',
    returnBps: 684,
    maxDrawdownBps: 192,
    tradingDays: 21,
    decidedCount: 20,
    scoreMilli: 412,
    confidence: 'medium',
  }),
  row({
    rank: 2,
    agentId: 'ddddddddddd2',
    name: 'Slow Tide',
    returnBps: 310,
    maxDrawdownBps: 140,
    tradingDays: 21,
    decidedCount: 21,
    scoreMilli: 205,
    confidence: 'medium',
  }),
  row({
    rank: 3,
    agentId: 'eeeeeeeeeee2',
    name: 'Coin Flip',
    returnBps: -192,
    maxDrawdownBps: 480,
    tradingDays: 19,
    decidedCount: 12,
    scoreMilli: -86,
    confidence: 'low',
  }),
  row({
    unrankedReason: 'min_trading_days',
    agentId: 'fffffffffff2',
    name: 'Late Starter',
    returnBps: 45,
    maxDrawdownBps: 20,
    tradingDays: 4,
    decidedCount: 4,
    scoreMilli: 30,
    confidence: 'insufficient',
  }),
  row({
    unrankedReason: 'min_decisions',
    agentId: 'ggggggggggg2',
    name: 'Quiet Hands',
    returnBps: 0,
    maxDrawdownBps: 0,
    tradingDays: 21,
    decidedCount: 2,
    scoreMilli: 0,
    confidence: 'insufficient',
  }),
  row({
    unrankedReason: 'inactive',
    agentId: 'hhhhhhhhhhh2',
    name: 'Gone Fishing',
    returnBps: -60,
    maxDrawdownBps: 130,
    tradingDays: 14,
    decidedCount: 9,
    scoreMilli: -12,
    confidence: 'insufficient',
    scoredDay: '2026-09-29',
  }),
  row({
    agentId: 'iiiiiiiiiii2',
    name: 'Just Qualified',
    returnBps: 12,
    maxDrawdownBps: 40,
    tradingDays: 10,
    decidedCount: 6,
    scoreMilli: 9,
    confidence: 'insufficient',
  }),
];

const V1_OPEN: SeasonResultRow[] = [
  row({
    rank: 1,
    agentId: 'ccccccccccc2',
    name: 'Harbor Light',
    method: 'v1',
    returnBps: 520,
    maxDrawdownBps: 210,
    tradingDays: 20,
    decidedCount: 20,
    scoreMilli: null,
    confidence: null,
    scoredDay: null,
  }),
  row({
    rank: 2,
    agentId: 'ddddddddddd2',
    name: 'Slow Tide',
    method: 'v1',
    returnBps: 140,
    maxDrawdownBps: 90,
    tradingDays: 20,
    decidedCount: 19,
    scoreMilli: null,
    confidence: null,
    scoredDay: null,
  }),
  row({
    unrankedReason: 'min_trading_days',
    agentId: 'fffffffffff2',
    name: 'Late Starter',
    method: 'v1',
    returnBps: 8,
    maxDrawdownBps: 5,
    tradingDays: 3,
    decidedCount: 3,
    scoreMilli: null,
    confidence: null,
    scoredDay: null,
  }),
];

const V2_PRO: SeasonResultRow[] = [
  row({
    rank: 1,
    agentId: 'jjjjjjjjjjj2',
    name: 'Deep Value',
    division: 'pro',
    returnBps: 402,
    maxDrawdownBps: 260,
    tradingDays: 21,
    decidedCount: 40,
    scoreMilli: 180,
    confidence: 'medium',
  }),
  row({
    unrankedReason: 'min_decisions',
    agentId: 'kkkkkkkkkkk2',
    name: 'Patient Money',
    division: 'pro',
    tradingDays: 21,
    decidedCount: 3,
  }),
];

const LISTING_A = 'lllllllllll2';
const LISTING_B = 'mmmmmmmmmmm2';
const CHAIN_ROWS: SeasonResultRow[] = [
  row({
    rank: 1,
    agentId: LISTING_A,
    name: 'Onchain Orca',
    division: 'chain',
    returnBps: 255,
    maxDrawdownBps: 300,
    tradingDays: 17,
    decidedCount: 9,
    scoreMilli: 95,
    confidence: 'low',
  }),
  row({
    unrankedReason: 'min_trading_days',
    agentId: LISTING_B,
    name: 'Wallet Wanderer',
    division: 'chain',
    returnBps: 20,
    maxDrawdownBps: 15,
    tradingDays: 3,
    decidedCount: 2,
    scoreMilli: 10,
  }),
];

const RESULTS: Record<string, Record<ScoringDivision, SeasonResultRow[]>> = {
  [S2]: { open: V2_OPEN, pro: V2_PRO, chain: CHAIN_ROWS },
  [S1]: { open: V1_OPEN, pro: [], chain: [] },
};

const TRACK: AgentTrackRecord = {
  agentId: 'ccccccccccc2',
  name: 'Harbor Light',
  division: 'open',
  method: 'v2',
  seasons: [
    {
      season: SEASON_2,
      method: 'v2',
      frozen: false,
      rank: 1,
      unrankedReason: null,
      returnBps: 684,
      maxDrawdownBps: 192,
      tradingDays: 21,
      decidedCount: 20,
      breakdown: BREAKDOWN,
      confidence: 'medium',
    },
    {
      season: SEASON_1,
      method: 'v1',
      frozen: true,
      rank: 1,
      unrankedReason: null,
      returnBps: 520,
      maxDrawdownBps: 210,
      tradingDays: 20,
      decidedCount: 20,
      breakdown: null,
      confidence: null,
    },
  ],
  allTime: {
    seasons: 2,
    scoredSeasons: 1,
    returnBps: 1_241,
    tradingDays: 41,
    breakdown: BREAKDOWN,
    confidence: 'medium',
  },
};

const UNRANKED_TRACK: AgentTrackRecord = {
  agentId: 'fffffffffff2',
  name: 'Late Starter',
  division: 'open',
  method: 'v2',
  seasons: [
    {
      season: SEASON_2,
      method: 'v2',
      frozen: false,
      rank: null,
      unrankedReason: 'min_trading_days',
      returnBps: 45,
      maxDrawdownBps: 20,
      tradingDays: 4,
      decidedCount: 4,
      breakdown: SHORT_BREAKDOWN,
      confidence: 'insufficient',
    },
  ],
  allTime: {
    seasons: 1,
    scoredSeasons: 1,
    returnBps: 45,
    tradingDays: 4,
    breakdown: SHORT_BREAKDOWN,
    confidence: 'insufficient',
  },
};

function listing(id: string, name: string, wallet: string, standing: SeasonResultRow | null): ListingPublic {
  return {
    id,
    name,
    wallet,
    explorerUrl: explorerAddressUrl(wallet),
    verified: false,
    claimedAt: '2026-09-20T10:00:00.000Z',
    syncState: 'live',
    syncedAt: '2026-10-06T06:00:00.000Z',
    eventCount: 4,
    estimated: true,
    recordMethod: CHAIN_METHOD,
    scoringMethod: 'v2',
    exclusions: [...CHAIN_EXCLUSIONS],
    recordFrom: '2026-09-18',
    standing,
  };
}

const LISTINGS: ListingPublic[] = [
  listing(LISTING_A, 'Onchain Orca', WALLET, CHAIN_ROWS[0] ?? null),
  listing(LISTING_B, 'Wallet Wanderer', OTHER_WALLET, CHAIN_ROWS[1] ?? null),
  // Claimed, its wallet still being read: no event, no priced day, no standing.
  {
    ...listing('nnnnnnnnnnn2', 'Fresh Claim', `0x${'1b2c'.repeat(10)}`, null),
    syncState: 'backfill',
    eventCount: 0,
    recordFrom: null,
  },
];

const HASH = (n: number): string => `0x${n.toString(16).padStart(64, 'a')}`;

const DAYS: ListingDay[] = [
  {
    day: '2026-10-01',
    returnBps: 80,
    exposed: true,
    indexMicro: 10_080_000_000,
    valueMicro: 10_080_000_000,
    eventCount: 1,
    unpricedEventCount: 0,
  },
  {
    day: '2026-10-02',
    returnBps: -35,
    exposed: true,
    indexMicro: 10_044_700_000,
    valueMicro: 10_044_700_000,
    eventCount: 0,
    unpricedEventCount: 0,
  },
  {
    day: '2026-10-03',
    returnBps: 0,
    exposed: false,
    indexMicro: 10_044_700_000,
    valueMicro: 0,
    eventCount: 1,
    unpricedEventCount: 1,
  },
  {
    day: '2026-10-05',
    returnBps: 210,
    exposed: true,
    indexMicro: 10_255_600_000,
    valueMicro: 10_255_600_000,
    eventCount: 2,
    unpricedEventCount: 0,
  },
];

function detail(base: ListingPublic): ListingDetail {
  // A listing without a scored day has no record yet, so it has no priced day and no event either.
  const fresh = base.standing === null;
  return {
    ...base,
    claimMessage: `Prix listing claim for ${base.wallet}\nThis signs a message only. It sends no transaction and costs no gas.`,
    claimSignature: `0x${'ab12'.repeat(32)}1b`,
    signatureKind: 'eoa',
    days: fresh ? [] : DAYS,
    events: fresh
      ? []
      : [
          {
            day: '2026-10-05',
            block: 4_120_330,
            txHash: HASH(4),
            explorerUrl: explorerTxUrl(HASH(4)),
            symbol: 'NVDA',
            direction: 'in',
            amount: '1.5',
            kind: 'swap',
            priced: true,
          },
          {
            day: '2026-10-05',
            block: 4_120_100,
            txHash: HASH(3),
            explorerUrl: explorerTxUrl(HASH(3)),
            symbol: 'TSLA',
            direction: 'out',
            amount: '0.25',
            kind: 'swap',
            priced: true,
          },
          {
            day: '2026-10-03',
            block: 4_090_001,
            txHash: HASH(2),
            explorerUrl: explorerTxUrl(HASH(2)),
            symbol: 'AAPL',
            direction: 'in',
            amount: '2',
            kind: 'transfer',
            priced: false,
          },
        ],
    track: null,
  };
}

const MISSING = (message: string): FixtureAnswer => ({ kind: 'error', status: 404, code: 'not_found', message });

/** The answer to a GET `path` under /api/reputation. `name` is the page's `?fixture=` value. */
export function answer(name: string | null, kind: string, path: string): FixtureAnswer {
  if (name === 'error')
    return { kind: 'error', status: 500, code: 'internal', message: 'The sample API is switched off.' };
  if (name === 'notfound') return MISSING('Nothing found.');
  const empty = name === 'empty';
  const url = new URL(path, 'https://sample.invalid');
  const parts = url.pathname.split('/');
  switch (kind) {
    case 'archive':
      return { kind: 'data', data: { seasons: empty ? [] : ENTRIES } };
    case 'results': {
      const id = parts[4] ?? '';
      const entry = ENTRIES.find((candidate) => candidate.season.id === id);
      const sets = RESULTS[id];
      if (!entry || !sets) return MISSING('No season was found.');
      const division = (url.searchParams.get('division') ?? 'open') as ScoringDivision;
      return {
        kind: 'data',
        data: {
          entry,
          division,
          rows: empty ? [] : (sets[division] ?? []),
          page: Number(url.searchParams.get('page') ?? '1'),
          hasMore: false,
          estimated: division === 'chain',
        },
      };
    }
    case 'record': {
      const id = parts[4] ?? '';
      if (id === UNRANKED_TRACK.agentId) return { kind: 'data', data: { record: UNRANKED_TRACK } };
      if (id === 'zzzzzzzzzzz2') return MISSING('No agent was found.');
      if (empty)
        return {
          kind: 'data',
          data: {
            record: {
              ...TRACK,
              seasons: [],
              allTime: {
                ...TRACK.allTime,
                seasons: 0,
                scoredSeasons: 0,
                returnBps: 0,
                tradingDays: 0,
                confidence: 'insufficient',
              },
            },
          },
        };
      return { kind: 'data', data: { record: { ...TRACK, agentId: id } } };
    }
    case 'listings':
      return { kind: 'data', data: { listings: empty ? [] : LISTINGS, page: 1, hasMore: false } };
    default: {
      const found = LISTINGS.find((candidate) => candidate.id === parts[4]);
      return found ? { kind: 'data', data: { listing: detail(found) } } : MISSING('No listed agent was found.');
    }
  }
}
