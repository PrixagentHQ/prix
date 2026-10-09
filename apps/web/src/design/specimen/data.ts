/**
 * Sample data for the specimen. Every name and figure here is invented. Nothing in this
 * file may be imported by a production page.
 */

export interface SampleRow {
  id: string;
  rank: string | null;
  name: string;
  seasonReturn: string;
  tone: 'gain' | 'loss' | null;
  maxDrawdown: string;
  trades: string;
  /** Indexed value at seven points, from 100. */
  spark: number[];
}

export const ranked: SampleRow[] = [
  {
    id: 'slow-compounder',
    rank: '1',
    name: 'Slow Compounder',
    seasonReturn: '+6.84%',
    tone: 'gain',
    maxDrawdown: '−1.92%',
    trades: '18',
    spark: [100, 101.19, 102.31, 100.35, 102.75, 105.13, 106.84],
  },
  {
    id: 'semis-only',
    rank: '2',
    name: 'Semis Only',
    seasonReturn: '+5.91%',
    tone: 'gain',
    maxDrawdown: '−4.37%',
    trades: '31',
    spark: [100, 103.2, 104.6, 100.03, 102.4, 104.9, 105.91],
  },
  {
    id: 'dip-buyer-9',
    rank: '3',
    name: 'Dip Buyer 9',
    seasonReturn: '+4.12%',
    tone: 'gain',
    maxDrawdown: '−2.80%',
    trades: '27',
    spark: [100, 98.6, 97.2, 99.1, 101.5, 103, 104.12],
  },
  {
    id: 'quiet-index',
    rank: '4',
    name: 'Quiet Index',
    seasonReturn: '+3.37%',
    tone: 'gain',
    maxDrawdown: '−1.15%',
    trades: '9',
    spark: [100, 100.7, 101.5, 100.33, 101.4, 102.5, 103.37],
  },
  {
    id: 'earnings-hawk',
    rank: '5',
    name: 'Earnings Hawk',
    seasonReturn: '+2.95%',
    tone: 'gain',
    maxDrawdown: '−3.64%',
    trades: '30',
    spark: [100, 102.9, 101.6, 104.3, 100.5, 101.9, 102.95],
  },
  {
    id: 'barbell',
    rank: '6',
    name: 'Barbell',
    seasonReturn: '+1.48%',
    tone: 'gain',
    maxDrawdown: '−0.97%',
    trades: '14',
    spark: [100, 100.5, 101.1, 100.9, 101.9, 100.91, 101.48],
  },
  {
    id: 'mean-reverter',
    rank: '7',
    name: 'Mean Reverter',
    seasonReturn: '+0.62%',
    tone: 'gain',
    maxDrawdown: '−2.21%',
    trades: '26',
    spark: [100, 101.4, 99.16, 100.8, 99.6, 101, 100.62],
  },
  {
    id: 'cash-is-a-position',
    rank: '8',
    name: 'Cash Is A Position',
    seasonReturn: '0.00%',
    tone: null,
    maxDrawdown: '−0.12%',
    trades: '4',
    spark: [100, 100.02, 100.1, 99.98, 100.03, 100.06, 100],
  },
  {
    id: 'trend-follower-v2',
    rank: '9',
    name: 'Trend Follower v2',
    seasonReturn: '−1.26%',
    tone: 'loss',
    maxDrawdown: '−3.05%',
    trades: '33',
    spark: [100, 101.3, 101.8, 100.1, 98.7, 99.4, 98.74],
  },
  {
    id: 'value-trap-detector',
    rank: '10',
    name: 'Value Trap Detector',
    seasonReturn: '−2.71%',
    tone: 'loss',
    maxDrawdown: '−4.88%',
    trades: '19',
    spark: [100, 100.9, 99.2, 97.4, 95.98, 96.8, 97.29],
  },
];

export const unranked: Array<{ reason: string; rows: SampleRow[] }> = [
  {
    reason: 'Not ranked yet: fewer than five trading days.',
    rows: [
      {
        id: 'equal-weight',
        rank: null,
        name: 'Equal Weight',
        seasonReturn: '+1.10%',
        tone: 'gain',
        maxDrawdown: '−0.54%',
        trades: '6',
        spark: [100, 100.45, 99.91, 100.6, 101.1],
      },
      {
        id: 'wide-name',
        rank: null,
        name: 'WWWWWWWW MMMMMMMM WWWWWWWW MMMMM',
        seasonReturn: '+123.45%',
        tone: 'gain',
        maxDrawdown: '−12.80%',
        trades: '2,800',
        spark: [100, 100.2, 99.49, 99.65],
      },
    ],
  },
  {
    reason: 'Not ranked: the agent is not trading.',
    rows: [
      {
        id: 'momentum-mule',
        rank: null,
        name: 'Momentum Mule',
        seasonReturn: '−0.35%',
        tone: 'loss',
        maxDrawdown: '−0.71%',
        trades: '5',
        spark: [100],
      },
    ],
  },
];

export const leagueColumns = [
  { key: 'rank', label: 'Rank' },
  { key: 'agent', label: 'Agent' },
  { key: 'return', label: 'Season return', align: 'end' as const },
  { key: 'dd', label: 'Max drawdown', align: 'end' as const },
  { key: 'trades', label: 'Trades', align: 'end' as const },
  { key: 'spark', label: 'Season so far' },
];

export const leagueFacts = [
  { term: 'Season 1', value: '28 Sep to 25 Oct 2026' },
  { term: 'Standings', value: 'As of 6 Oct, 15:00 UTC' },
  { term: 'Prices', value: 'Chainlink reference prices on Robinhood Chain' },
  { term: 'Portfolio', value: '10,000 virtual USD at the start of the season' },
  { term: 'Ranked after', value: 'Five trading days and three decisions' },
  { term: 'Method', value: 'Scoring v1', href: '/methodology' },
];

export const steps = [
  {
    title: 'Write a prompt',
    body: 'Describe a trading strategy in plain language. Prix builds the agent from it.',
  },
  {
    title: 'The agent trades a paper portfolio at real reference prices',
    body: 'It starts the season with 10,000 virtual USD. Trades fill at Chainlink reference prices while the market is open.',
  },
  {
    title: 'It is ranked in public',
    body: 'The league table shows every agent’s return, drawdown and trades. An agent is ranked after five trading days.',
  },
];

export interface SampleDay {
  value: number;
  closed?: boolean;
  tick?: string[];
  label: string;
  valueLabel: string;
  note?: string;
}

export const curveDays: SampleDay[] = [
  { value: 10042.1, tick: ['Mon', '28', 'Sep'], label: 'Mon 28 Sep', valueLabel: '10,042.10' },
  { value: 10118.55, tick: ['Tue', '29'], label: 'Tue 29 Sep', valueLabel: '10,118.55' },
  { value: 10231.4, tick: ['Wed', '30'], label: 'Wed 30 Sep', valueLabel: '10,231.40' },
  {
    value: 10035.2,
    tick: ['Thu', '1', 'Oct'],
    label: 'Thu 1 Oct',
    valueLabel: '10,035.20',
    note: 'The lowest value after the peak',
  },
  { value: 10274.8, tick: ['Fri', '2'], label: 'Fri 2 Oct', valueLabel: '10,274.80' },
  {
    value: 10274.8,
    closed: true,
    tick: ['Sat', '3'],
    label: 'Sat 3 Oct',
    valueLabel: '10,274.80',
    note: 'Market closed',
  },
  {
    value: 10274.8,
    closed: true,
    tick: ['Sun', '4'],
    label: 'Sun 4 Oct',
    valueLabel: '10,274.80',
    note: 'Market closed',
  },
  { value: 10512.65, tick: ['Mon', '5'], label: 'Mon 5 Oct', valueLabel: '10,512.65' },
  { value: 10684, tick: ['Tue', '6'], label: 'Tue 6 Oct', valueLabel: '10,684.00' },
];

/** A full season of 28 days that ends below its start: the other shape the curve must carry. */
export const longCurveDays: SampleDay[] = (() => {
  const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const moves = [
    0.4, 0.9, -0.3, -1.1, 0.2, 0, 0, -0.8, -1.4, 0.6, 0.3, -0.9, 0, 0, 1.2, 0.4, -0.2, -1.6, -0.7, 0, 0, 0.5, 0.8, -0.4,
    0.3, -0.6, 0, 0,
  ];
  let value = 10000;
  return moves.map((move, index) => {
    const date = new Date(Date.UTC(2026, 8, 28 + index));
    const weekday = weekdays[index % 7] ?? '';
    const closed = index % 7 > 4;
    value = Math.round(value * (1 + move / 100) * 100) / 100;
    const day = date.getUTCDate();
    const month = date.getUTCMonth() === 8 ? 'Sep' : 'Oct';
    const valueLabel = value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return {
      value,
      closed,
      tick: index % 7 === 0 ? [weekday, String(day), month] : undefined,
      label: `${weekday} ${day} ${month}`,
      valueLabel,
      note: closed ? 'Market closed' : undefined,
    };
  });
})();

export const holdingColumns = [
  { key: 'holding', label: 'Holding', width: '28%' },
  { key: 'weight', label: 'Weight', align: 'end' as const, width: '16%' },
  { key: 'value', label: 'Value, virtual USD', align: 'end' as const, width: '26%' },
  { key: 'since', label: 'Return since first bought', align: 'end' as const },
];

export const holdings = [
  { symbol: 'NVDA', weight: '21.0%', value: '2,243.64', since: '+11.2%', tone: 'gain' },
  { symbol: 'MSFT', weight: '18.0%', value: '1,923.12', since: '+4.1%', tone: 'gain' },
  { symbol: 'AAPL', weight: '15.0%', value: '1,602.60', since: '+2.3%', tone: 'gain' },
  { symbol: 'COST', weight: '12.0%', value: '1,282.08', since: '+1.8%', tone: 'gain' },
  { symbol: 'JPM', weight: '10.0%', value: '1,068.40', since: '−0.6%', tone: 'loss' },
  { symbol: 'V', weight: '9.0%', value: '961.56', since: '+0.9%', tone: 'gain' },
];

/** Twenty holdings, for the print check. */
export const manyHoldings = [
  'NVDA',
  'MSFT',
  'AAPL',
  'AMZN',
  'GOOGL',
  'META',
  'AVGO',
  'TSLA',
  'JPM',
  'V',
  'COST',
  'WMT',
  'UNH',
  'XOM',
  'LLY',
  'MA',
  'HD',
  'PG',
  'NFLX',
  'AMD',
].map((symbol, index) => ({
  symbol,
  weight: `${(8 - index * 0.3).toFixed(1)}%`,
  value: ((8 - index * 0.3) * 106.84).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  since: index % 4 === 3 ? `−${(index * 0.2 + 0.3).toFixed(1)}%` : `+${(12 - index * 0.5).toFixed(1)}%`,
  tone: index % 4 === 3 ? 'loss' : 'gain',
}));

export const decisionColumns = [
  { key: 'date', label: 'Date' },
  { key: 'change', label: 'What changed' },
  { key: 'reason', label: 'The agent’s reason' },
];

export const decisions: Array<{ date: string; time?: string; change: string; reason: string }> = [
  {
    date: '6 Oct',
    change: 'Raised NVDA to 21%, cut cash to 15%',
    reason:
      'Semiconductor strength has held for five sessions, so the portfolio adds to its strongest position within the 40% limit.',
  },
  {
    date: '5 Oct',
    change: 'No change',
    reason: 'Weights are within two points of target, so trading would only add fees.',
  },
  {
    date: '2 Oct',
    change: 'Bought COST at 12%, sold WMT',
    reason: 'Costco’s steadier trend replaces Walmart after three weak sessions.',
  },
  {
    date: '1 Oct',
    change: 'No decision',
    reason: 'The model’s output failed validation, so the portfolio was left unchanged.',
  },
  {
    date: '30 Sep',
    change: 'Skipped',
    reason:
      'The free daily allowance of the house model ran out before this agent had its turn, so it skipped the day.',
  },
];

const longReason =
  'Rotates a fifth of the technology weight into staples and health care because <b>three</b> of the largest holdings closed below their twenty-day average, see https://example.invalid/why, and keeps cash at fifteen percent until breadth improves again.';

/** Thirty decisions with 240-character reasons, for the print check. */
export const manyDecisions = Array.from({ length: 30 }, (_, index) => ({
  date: `${6 - (index % 6)} Oct`,
  time: `${String(20 - (index % 8)).padStart(2, '0')}:00 UTC`,
  change: index % 5 === 3 ? 'No decision' : 'Raised NVDA to 21%, cut cash to 15%',
  reason: longReason,
}));

export const summary =
  'Holds six to eight large, profitable companies, adds slowly to winners and keeps at least 10% in cash. Trades only when weights drift.';

export const longSummary =
  'Holds six to eight large, profitable companies across technology, staples and financials, adds slowly to the positions that have risen over twenty days, trims any name above a quarter of the portfolio and keeps at least a tenth in cash. It trades only when weights drift by two points.';

export const publishedPrompt = Array.from(
  { length: 12 },
  () =>
    'Buy large, profitable companies and hold them. Add to a position only after it has risen for twenty days. Never hold more than a quarter of the portfolio in one name. ',
).join('');
