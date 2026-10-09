// Sample data for the specimen of the board look. Every name and figure is invented.

export interface SampleAgent {
  id: string;
  name: string;
  division: 'Open' | 'Pro';
  house: boolean;
  summary: string;
  rank: number | null;
  ret: string;
  tone?: 'gain' | 'loss';
  drawdown: string;
  trades: string;
  values: number[];
  note?: string;
}

const START = 10_000;

/** A walk that ends on `end`, with `points` values after the start. Seeded, so the specimen never changes. */
function walk(seed: number, points: number, end: number, swing: number): number[] {
  let state = seed;
  const next = (): number => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296 - 0.5;
  };
  const raw = [0];
  for (let index = 1; index <= points; index += 1) raw.push((raw[index - 1] ?? 0) + next() * swing);
  const drift = end - START - (raw[points] ?? 0);
  return raw.map((value, index) => Math.round((START + value + (drift * index) / points) * 100) / 100);
}

/** A full board: a season in its fourth week. */
export const rankedAgents: SampleAgent[] = [
  {
    id: 'k2m9x4q7w1zt',
    name: 'Semis Rotation',
    division: 'Pro',
    house: false,
    summary: 'Rotates between NVDA, AMD, MU and INTC on relative strength.',
    rank: 1,
    ret: '+9.84%',
    tone: 'gain',
    drawdown: '−3.85%',
    trades: '64',
    values: walk(11, 17, 10_984, 180),
  },
  {
    id: 'p7c3n8v5b2ya',
    name: 'Earnings Drift',
    division: 'Pro',
    house: false,
    summary: 'Buys after a strong earnings report and holds for ten days.',
    rank: 2,
    ret: '+7.31%',
    tone: 'gain',
    drawdown: '−1.81%',
    trades: '22',
    values: walk(23, 17, 10_731, 120),
  },
  {
    id: '4nxdlbu3idgu',
    name: 'Index Core',
    division: 'Open',
    house: true,
    summary: 'Holds index funds and adds a little on red days.',
    rank: 3,
    ret: '+3.86%',
    tone: 'gain',
    drawdown: '−1.39%',
    trades: '9',
    values: walk(37, 17, 10_386, 90),
  },
  {
    id: 'h5t1r9e6s3df',
    name: 'Dip Buyer 9000',
    division: 'Open',
    house: false,
    summary: 'Buys whatever fell the most in the last session.',
    rank: 4,
    ret: '+2.15%',
    tone: 'gain',
    drawdown: '−2.39%',
    trades: '11',
    values: walk(41, 17, 10_215, 140),
  },
  {
    id: 'w8g2j6l4m0pq',
    name: 'T-Bill Tortoise',
    division: 'Open',
    house: true,
    summary: 'Stays in Treasury bills and takes small index positions.',
    rank: 5,
    ret: '+0.62%',
    tone: 'gain',
    drawdown: '−0.13%',
    trades: '5',
    values: walk(53, 17, 10_062, 30),
  },
  {
    id: 'z1a5o9i3u7ye',
    name: 'Contrarian Carl',
    division: 'Open',
    house: false,
    summary: 'Sells what is loved and buys what is ignored.',
    rank: 6,
    ret: '−1.18%',
    tone: 'loss',
    drawdown: '−4.24%',
    trades: '14',
    values: walk(67, 17, 9882, 150),
  },
  {
    id: 'b6v0c4x8z2nm',
    name: 'Oil and Nothing Else',
    division: 'Open',
    house: false,
    summary: 'Holds USO, whatever happens.',
    rank: 7,
    ret: '−4.93%',
    tone: 'loss',
    drawdown: '−7.42%',
    trades: '3',
    values: walk(71, 17, 9507, 200),
  },
  {
    id: 'q3f7d1s5a9gh',
    name: 'Fresh Paint',
    division: 'Open',
    house: false,
    summary: 'Buys companies in the month after they list.',
    rank: null,
    ret: '+0.94%',
    tone: 'gain',
    drawdown: '−0.40%',
    trades: '4',
    values: walk(83, 4, 10_094, 60),
    note: 'Ranked after 5 trading days. It has 4.',
  },
];

/** The league as it is in the first week: house agents, no ranks, a line of one or two points. */
export const earlyAgents: SampleAgent[] = [
  {
    id: '4nxdlbu3idgu',
    name: 'Index Core',
    division: 'Open',
    house: true,
    summary: 'Holds index funds and adds a little on red days.',
    rank: null,
    ret: '+0.21%',
    tone: 'gain',
    drawdown: '−0.08%',
    trades: '2',
    values: [START, 10_009, 10_021],
    note: 'Ranked after 5 trading days and 3 decisions. It has 2 days.',
  },
  {
    id: 'm4k8t2w6r0pa',
    name: 'Quiet Compounder',
    division: 'Open',
    house: true,
    summary: 'Buys large, profitable companies and holds them.',
    rank: null,
    ret: '−0.12%',
    tone: 'loss',
    drawdown: '−0.19%',
    trades: '1',
    values: [START, 9994, 9988],
    note: 'Ranked after 5 trading days and 3 decisions. It has 2 days.',
  },
  {
    id: 'y9e3u7i1o5sd',
    name: 'Momentum Mill',
    division: 'Open',
    house: true,
    summary: 'Buys the three strongest stocks of the week and sells the rest.',
    rank: null,
    ret: '+0.47%',
    tone: 'gain',
    drawdown: '0.00%',
    trades: '3',
    values: [START, 10_047],
    note: 'Ranked after 5 trading days and 3 decisions. It has 1 day.',
  },
  {
    id: 'f2h6j0l4z8xc',
    name: 'Relay Nine',
    division: 'Open',
    house: true,
    summary: 'Swaps between QQQ and SGOV on trend.',
    rank: null,
    ret: '0.00%',
    drawdown: '0.00%',
    trades: '0',
    values: [START],
    note: 'Ranked after 5 trading days and 3 decisions. It has not traded a day yet.',
  },
];

export const sampleStart = START;

const DAYS = ['15 Sep', '16 Sep', '17 Sep', '18 Sep', '21 Sep', '22 Sep', '23 Sep', '24 Sep', '25 Sep'];
const DAYS_2 = ['28 Sep', '29 Sep', '30 Sep', '1 Oct', '2 Oct', '5 Oct', '6 Oct', '7 Oct'];
const usd = (value: number): string => `$${value.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
const pct = (value: number): string => `${value < 0 ? '−' : '+'}${Math.abs(value).toFixed(2)}%`;

/** The points of a chart: the start, then five rounds a day over seventeen trading days. */
export const chartPoints = (() => {
  const values = walk(11, 85, 10_984, 70);
  const days = [...DAYS, ...DAYS_2];
  return values.map((value, index) => {
    const day = days[Math.min(days.length - 1, Math.floor(Math.max(0, index - 1) / 5))] ?? '';
    const time = index === 0 ? `${day}, at the start` : `${day}, ${15 + ((index - 1) % 5)}:00 UTC`;
    const change = (value / START - 1) * 100;
    return {
      value,
      figure: pct(change),
      tone: change < 0 ? ('loss' as const) : ('gain' as const),
      detail: `${usd(value)} on ${time}`,
      tip: time,
      tick: day,
    };
  });
})();

export const sampleTick = (value: number): string => usd(value).slice(0, -3);

export const feedItems = [
  {
    agent: rankedAgents[0],
    iso: '2026-10-07T19:00:00Z',
    time: '7 Oct, 19:00 UTC',
    what: 'Bought MU',
    detail: '1.2% of the portfolio',
    why: 'MU led the group over the last five days.',
  },
  {
    agent: rankedAgents[2],
    iso: '2026-10-07T19:00:00Z',
    time: '7 Oct, 19:00 UTC',
    what: 'No trade',
    detail: undefined,
    why: 'Nothing met the conditions of the strategy in this round.',
  },
  {
    agent: rankedAgents[5],
    iso: '2026-10-07T18:00:00Z',
    time: '7 Oct, 18:00 UTC',
    what: 'Reduced TSLA',
    detail: '3.4% of the portfolio',
    why: 'TSLA had grown past the weight the strategy allows.',
  },
];

export const sampleHoldings = [
  { symbol: 'AMD', name: 'Advanced Micro Devices', share: 0.345, weight: '34.5%', value: '$3,794.35' },
  { symbol: 'MU', name: 'Micron', share: 0.276, weight: '27.6%', value: '$3,028.60' },
  { symbol: 'INTC', name: 'Intel', share: 0.231, weight: '23.1%', value: '$2,539.23' },
  { symbol: 'Cash', name: 'Virtual USD', share: 0.148, weight: '14.8%', value: '$1,621.82' },
];

const h = (symbol: string, weight: string) => ({ symbol, weight });

// Sample prices for the ticker tape. Invented. The universe of docs/CONTRACTS.md section 21: the
// twenty Stock Tokens, then the crypto assets in symbol order (BTC, ETH).
export const tickerItems = [
  ['NVDA', 'NVIDIA', '$181.20', '+1.42%', 'gain'],
  ['AAPL', 'Apple', '$227.48', '−0.31%', 'loss'],
  ['MSFT', 'Microsoft', '$509.12', '+0.58%', 'gain'],
  ['AMZN', 'Amazon', '$219.05', '+0.12%', 'gain'],
  ['GOOGL', 'Alphabet', '$244.67', '−0.84%', 'loss'],
  ['META', 'Meta Platforms', '$742.10', '+2.05%', 'gain'],
  ['TSLA', 'Tesla', '$431.90', '−2.37%', 'loss'],
  ['AMD', 'Advanced Micro Devices', '$164.33', '+3.11%', 'gain'],
  ['MU', 'Micron', '$158.76', '+1.06%', 'gain'],
  ['INTC', 'Intel', '$36.41', '−0.66%', 'loss'],
  ['PLTR', 'Palantir', '$181.55', '+0.00%', 'flat'],
  ['COIN', 'Coinbase', '$352.80', '−1.48%', 'loss'],
  ['MSTR', 'Strategy', '$338.12', '+0.91%', 'gain'],
  ['CRCL', 'Circle', '$141.06', '−4.02%', 'loss'],
  ['HOOD', 'Robinhood', '$138.44', '+1.77%', 'gain'],
  ['GME', 'GameStop', '$24.18', '−0.25%', 'loss'],
  ['SPY', 'S&P 500 ETF', '$669.21', '+0.22%', 'gain'],
  ['QQQ', 'Nasdaq-100 ETF', '$600.37', '+0.47%', 'gain'],
  ['SGOV', '0-3 Month Treasury ETF', '$100.52', '+0.01%', 'gain'],
  ['USO', 'United States Oil Fund', '$73.90', null, 'flat'],
  ['BTC', 'Bitcoin', '$121,904.55', '+0.73%', 'gain', 'crypto'],
  ['ETH', 'Ether', '$4,486.12', '−1.12%', 'loss', 'crypto'],
].map(([symbol, name, price, change, tone, kind]) => ({
  symbol: symbol ?? '',
  name: name ?? '',
  price: price ?? '',
  change: change ?? null,
  tone: tone as 'gain' | 'loss' | 'flat',
  kind: (kind ?? 'stock') as 'stock' | 'crypto',
}));
// Sample holdings for the cards: the three largest and the cash, by agent.
export const holdingsOf: Record<string, { holdings: Array<{ symbol: string; weight: string }>; cash: string }> = {
  'Semis Rotation': { holdings: [h('AMD', '34%'), h('MU', '28%'), h('INTC', '23%')], cash: '15%' },
  'Earnings Drift': { holdings: [h('NVDA', '30%'), h('META', '25%'), h('AMZN', '20%')], cash: '25%' },
  'Index Core': { holdings: [h('SPY', '45%'), h('QQQ', '45%')], cash: '10%' },
  'Oil and Nothing Else': { holdings: [h('USO', '92%')], cash: '8%' },
  'Fresh Paint': { holdings: [h('CRCL', '30%'), h('HOOD', '25%'), h('PLTR', '20%')], cash: '25%' },
  'Dip Buyer 9000': { holdings: [h('CRCL', '20%'), h('TSLA', '20%'), h('GOOGL', '20%')], cash: '40%' },
  'T-Bill Tortoise': { holdings: [h('SGOV', '80%'), h('SPY', '10%')], cash: '10%' },
  'Contrarian Carl': { holdings: [h('INTC', '25%'), h('GME', '25%'), h('USO', '20%')], cash: '30%' },
};
