// Stage 2 of the crypto assets (docs/CONTRACTS.md section 23): what packages/runtime must do with
// SOL, BNB and HYPE, checked on the real code. Local only, never deployed, no network.
//
//   node packages/runtime/scripts/stage2-check.mjs
//
// It checks the holds (unread Arbitrum points, the anchor of a first appearance, a hold after a
// weekend, MAX_HALTED_FEEDS), the decision prompt's symbol groups, and estimates the input tokens
// the three coins add to a house decision against HOUSE_NEURONS_PER_DAY. Exit code 1 on any failure.

import { ensureUniverse25, MARKET_SYMBOLS, marketUniverse, UNIVERSE } from './universe25.mjs';

const added = ensureUniverse25();
const contracts = await import('@prix/contracts');
const { applyHolds, CRYPTO_SYMBOLS } = await import('../src/holds.ts');
const { decisionSystemMessage, describeSymbols, assembleDecisionMessages } = await import('../src/prompts.ts');
const { haltedSymbols, toPriceMap } = await import('@prix/market');
const { sim } = await import('../../sim/src/index.ts');

const {
  MICRO,
  STARTING_CASH_MICRO,
  HOUSE_NEURONS_PER_DAY,
  MAX_AGENTS_OPEN,
  CRYPTO_FEED_STALE_AFTER_SECONDS_BY_SYMBOL,
} = contracts;

let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === '' ? '' : `: ${detail}`}`);
}

console.log(
  `universe: ${UNIVERSE.length} symbols; packages/market lists ${MARKET_SYMBOLS.length}` +
    (added.length > 0 ? `; added in memory for this run: ${added.join(', ')}` : ''),
);

// --- the crypto set of the holds -----------------------------------------------------------------

const contractCrypto = Object.keys(CRYPTO_FEED_STALE_AFTER_SECONDS_BY_SYMBOL).sort();
check(
  'CRYPTO_SYMBOLS of holds.ts covers every crypto symbol of the contract',
  contractCrypto.every((symbol) => CRYPTO_SYMBOLS.has(symbol)),
  [...CRYPTO_SYMBOLS].sort().join(', '),
);
check(
  'the universe lists BTC, ETH, then BNB, HYPE, SOL after the 20 Stock Tokens',
  UNIVERSE.slice(20)
    .map((token) => token.symbol)
    .join(',') === 'BTC,ETH,BNB,HYPE,SOL',
);

// --- a market at 25 symbols ----------------------------------------------------------------------

const FRIDAY = '2026-10-09';
const MONDAY = '2026-10-12';
const PRICE = { BTC: 62_000, ETH: 2_400, BNB: 610, HYPE: 38, SOL: 150 };
const usdOf = (symbol, k) => PRICE[symbol] ?? 50 + k * 37;
const ARBITRUM = ['BNB', 'HYPE', 'SOL'];

function point(symbol, usd, fresh = true, takenAt = `${MONDAY}T15:00:30.000Z`) {
  return { symbol, priceMicro: Math.round(usd * MICRO), updatedAt: takenAt, ageSeconds: 60, fresh };
}

function snapshot(prices, takenAt = `${MONDAY}T15:00:30.000Z`) {
  return {
    takenAt,
    chainId: 4663,
    blockNumber: 1_000,
    open: true,
    closedReason: null,
    prices,
    otherChains: [{ chainId: 42161, blockNumber: 0, endpoint: null, confirmedBy: null, problem: 'rpc_unavailable' }],
  };
}

function market(overrides = {}) {
  return snapshot(
    UNIVERSE.map((token, k) => {
      const override = overrides[token.symbol];
      if (override === 'unread') return { ...point(token.symbol, 0, false), priceMicro: 0 };
      return point(token.symbol, override ?? usdOf(token.symbol, k));
    }),
  );
}

function tick(id, prices) {
  return {
    id,
    seasonId: 'saaaaaaaaaaab',
    daily: true,
    snapshot: snapshot(prices, `${id.slice(0, 13)}:00:30.000Z`),
    status: 'complete',
    createdAt: `${id.slice(0, 13)}:00:30.000Z`,
    completedAt: `${id.slice(0, 13)}:05:00.000Z`,
  };
}

const FRIDAY_TICK = `${FRIDAY}T19:00Z`;
const MONDAY_TICK = `${MONDAY}T15:00Z`;
const NOW = `${MONDAY}T15:00:31.000Z`;
const latestFull = tick(
  FRIDAY_TICK,
  UNIVERSE.map((token, k) => point(token.symbol, usdOf(token.symbol, k))),
);
const trustedAll = Object.fromEntries(
  UNIVERSE.map((token, k) => [token.symbol, { priceMicro: usdOf(token.symbol, k) * MICRO, tickId: FRIDAY_TICK }]),
);
const established = new Set(UNIVERSE.map((token) => token.symbol));
const history = {
  trusted: trustedAll,
  latest: latestFull,
  previousTradingDay: FRIDAY,
  establishedSymbols: established,
};

const pointOf = (snap, symbol) => snap.prices.find((entry) => entry.symbol === symbol);

// 1. SOL, BNB and HYPE unread, with trusted prices: they take them, are not fresh, no hold, open.
{
  const held = applyHolds(market({ BNB: 'unread', HYPE: 'unread', SOL: 'unread' }), history, [], MONDAY_TICK, NOW);
  const taken = ARBITRUM.every((symbol) => {
    const p = pointOf(held.snapshot, symbol);
    return p !== undefined && p.fresh === false && p.priceMicro === trustedAll[symbol].priceMicro;
  });
  check('unread Arbitrum points take their trusted price and are not fresh', taken);
  check('unread Arbitrum points begin no hold', held.newHolds.length === 0, `${held.newHolds.length} holds`);
  check(
    'unread Arbitrum points leave the market open',
    held.snapshot.open && held.snapshot.closedReason === null,
    String(held.snapshot.closedReason),
  );
  check(
    'the three are halted for trading, nothing else',
    haltedSymbols(held.snapshot).sort().join(',') === 'BNB,HYPE,SOL',
    haltedSymbols(held.snapshot).join(','),
  );
  check(
    'otherChains passes through applyHolds unchanged',
    held.snapshot.otherChains?.[0]?.problem === 'rpc_unavailable',
  );
}

// 2. No trusted price and no latest point: the point is left out; valuing a holder of nothing works.
{
  const latest22 = tick(
    FRIDAY_TICK,
    UNIVERSE.filter((token) => !ARBITRUM.includes(token.symbol)).map((token, k) =>
      point(token.symbol, usdOf(token.symbol, k)),
    ),
  );
  const trusted22 = Object.fromEntries(Object.entries(trustedAll).filter(([symbol]) => !ARBITRUM.includes(symbol)));
  const held = applyHolds(
    market({ BNB: 'unread', HYPE: 'unread', SOL: 'unread' }),
    {
      trusted: trusted22,
      latest: latest22,
      previousTradingDay: FRIDAY,
      establishedSymbols: new Set(Object.keys(trusted22)),
    },
    [],
    MONDAY_TICK,
    NOW,
  );
  check(
    'an unread point with no trusted and no latest price is left out',
    ARBITRUM.every((symbol) => pointOf(held.snapshot, symbol) === undefined) && held.snapshot.prices.length === 22,
    `${held.snapshot.prices.length} points`,
  );
  check('the market stays open', held.snapshot.open);
  let value = null;
  try {
    value = sim.valuePortfolio({ cashMicro: STARTING_CASH_MICRO, holdings: {} }, toPriceMap(held.snapshot));
  } catch (error) {
    value = error;
  }
  check('valuing a holder of nothing does not throw', value === STARTING_CASH_MICRO, String(value));
}

// 3. An Arbitrum outage longer than TRUSTED_PRICE_LOOKBACK_TICKS: no trusted SOL, the latest tick
//    carries SOL (itself carried, not fresh). A holder of SOL is still valued at that price.
{
  const carried = latestFull.snapshot.prices.map((entry) =>
    ARBITRUM.includes(entry.symbol) ? { ...entry, fresh: false } : entry,
  );
  const latest = { ...latestFull, snapshot: { ...latestFull.snapshot, prices: carried } };
  const trusted = Object.fromEntries(Object.entries(trustedAll).filter(([symbol]) => !ARBITRUM.includes(symbol)));
  const held = applyHolds(
    market({ BNB: 'unread', HYPE: 'unread', SOL: 'unread' }),
    { trusted, latest, previousTradingDay: FRIDAY, establishedSymbols: established },
    [],
    MONDAY_TICK,
    NOW,
  );
  const sol = pointOf(held.snapshot, 'SOL');
  check(
    'after an outage past the lookback, SOL takes its price in the latest tick',
    sol?.priceMicro === 150 * MICRO && sol.fresh === false,
    JSON.stringify(sol),
  );
  check('and begins no hold', held.newHolds.length === 0, `${held.newHolds.length} holds`);
  let value = null;
  try {
    value = sim.valuePortfolio({ cashMicro: 0, holdings: { SOL: 10 * MICRO } }, toPriceMap(held.snapshot));
  } catch (error) {
    value = error;
  }
  check('a holder of 10 SOL is valued at 1,500 USD', value === 1_500 * MICRO, String(value));
}

// 4. A 31% HYPE move after a weekend starts a hold; a coin's hold never closes the market.
{
  const held = applyHolds(market({ HYPE: 38 * 1.31 }), history, [], MONDAY_TICK, NOW);
  const hype = pointOf(held.snapshot, 'HYPE');
  check(
    'a 31% HYPE move after a weekend starts a hold at the trusted price',
    held.newHolds.length === 1 && held.newHolds[0].symbol === 'HYPE' && hype.priceMicro === 38 * MICRO && !hype.fresh,
    held.newHolds.map((hold) => hold.symbol).join(','),
  );
  check('the market stays open', held.snapshot.open);
  const allCoins = applyHolds(
    market({ BTC: 99_000, ETH: 4_000, BNB: 'unread', HYPE: 60, SOL: 300, AAPL: 1, AMD: 1 }),
    history,
    [],
    MONDAY_TICK,
    NOW,
  );
  check(
    'five coins halted plus two Stock Tokens held: still open (MAX_HALTED_FEEDS counts Stock Tokens only)',
    allCoins.snapshot.open && haltedSymbols(allCoins.snapshot).length === 7,
    `${haltedSymbols(allCoins.snapshot).length} halted, ${allCoins.snapshot.closedReason}`,
  );
  const threeStocks = applyHolds(market({ AAPL: 1, AMD: 1, AMZN: 1 }), history, [], MONDAY_TICK, NOW);
  check('three Stock Tokens held close the market', threeStocks.snapshot.closedReason === 'held_for_review');
}

// 5. A first appearance (rule 11): the latest tick has 22 symbols, the three coins are read.
{
  const latest22 = tick(
    FRIDAY_TICK,
    UNIVERSE.filter((token) => !ARBITRUM.includes(token.symbol)).map((token, k) =>
      point(token.symbol, usdOf(token.symbol, k)),
    ),
  );
  const trusted22 = Object.fromEntries(Object.entries(trustedAll).filter(([symbol]) => !ARBITRUM.includes(symbol)));
  const est22 = new Set(Object.keys(trusted22));
  const first = applyHolds(
    market(),
    { trusted: trusted22, latest: latest22, previousTradingDay: FRIDAY, establishedSymbols: est22 },
    [],
    MONDAY_TICK,
    NOW,
  );
  check(
    'a first appearance enters priced and not fresh, with no hold',
    ARBITRUM.every((symbol) => pointOf(first.snapshot, symbol)?.fresh === false) && first.newHolds.length === 0,
  );
  check('the market stays open', first.snapshot.open);
  // The next tick: no trusted price yet, the latest tick (the anchor) carries them, not established.
  const anchorTick = tick(MONDAY_TICK, first.snapshot.prices);
  const nextNow = `${MONDAY}T16:00:31.000Z`;
  const next = applyHolds(
    market({ SOL: 150 * 1.1, HYPE: 38 * 1.35 }),
    { trusted: trusted22, latest: anchorTick, previousTradingDay: FRIDAY, establishedSymbols: est22 },
    [],
    `${MONDAY}T16:00Z`,
    nextNow,
  );
  check(
    'next tick: a 10% move from the anchor trades, a 35% move from it is held',
    pointOf(next.snapshot, 'SOL')?.fresh === true &&
      pointOf(next.snapshot, 'BNB')?.fresh === true &&
      next.newHolds.map((hold) => hold.symbol).join(',') === 'HYPE',
    next.newHolds.map((hold) => hold.symbol).join(','),
  );
}

// 6. A released hold on a coin that is unread in this snapshot: the release waits for a read.
{
  const release = {
    symbol: 'SOL',
    priceMicro: 150 * MICRO,
    seenPriceMicro: 220 * MICRO,
    sinceTickId: FRIDAY_TICK,
    releasedAt: `${MONDAY}T10:00:00.000Z`,
    createdAt: `${FRIDAY}T19:00:31.000Z`,
  };
  const unread = applyHolds(market({ SOL: 'unread' }), history, [release], MONDAY_TICK, NOW);
  check(
    'a release is not used up by a tick where its coin is unread',
    !unread.released.includes('SOL') && pointOf(unread.snapshot, 'SOL')?.fresh === false,
    `released: ${unread.released.join(',')}`,
  );
  const read = applyHolds(market({ SOL: 220 }), history, [release], MONDAY_TICK, NOW);
  check(
    'a release is used up by a tick that reads its coin, at the feed price',
    read.released.includes('SOL') && pointOf(read.snapshot, 'SOL')?.priceMicro === 220 * MICRO,
  );
}

// --- the prompt ----------------------------------------------------------------------------------

const symbolLine = describeSymbols(UNIVERSE);
check(
  'the symbol line groups 20 Stock Tokens and 5 coins',
  /^Stock Tokens: [^;]+; crypto: BTC Bitcoin, ETH Ethereum, BNB, HYPE Hyperliquid, SOL Solana$/.test(symbolLine) &&
    symbolLine.split('; ')[0].split(', ').length === 20,
  symbolLine.split('; ')[1],
);
const system25 = decisionSystemMessage(UNIVERSE);
check(
  'the system message keeps the per-symbol null-return sentence',
  system25.includes(
    'A return is null where that symbol has fewer earlier trading days in the league; for each symbol, work with the returns it has.',
  ),
);

// --- tokens --------------------------------------------------------------------------------------

/**
 * A count of Llama 3 pre-tokens: the split of its tokenizer before byte-pair merges (the tiktoken
 * pattern of Llama 3). Every pre-token is at least one token, and an English word or a group of up to
 * three digits is most often exactly one, so this is close to the real count and below it. No
 * tokenizer is installed (adding one is a dependency); the house probe measures the real numbers.
 */
const PRE_TOKEN =
  /(?:'[sS]|'[tT]|'[rR][eE]|'[vV][eE]|'[mM]|'[lL][lL]|'[dD])|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}{1,3}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/gu;
const tokens = (text) => text.match(PRE_TOKEN)?.length ?? 0;
const messageTokens = (messages) => messages.reduce((sum, message) => sum + tokens(message.content), 0);

function decisionMessages(universe, coinReturns, held) {
  const takenAt = `${MONDAY}T15:00:30.000Z`;
  const prices = universe.map((token, k) => point(token.symbol, usdOf(token.symbol, k) + 0.37, true, takenAt));
  const returns = universe.map((token, k) => {
    const coin = ARBITRUM.includes(token.symbol);
    const none = coin && coinReturns === 'none';
    return {
      symbol: token.symbol,
      day1Bps: none ? null : ((k * 53) % 400) - 211,
      day5Bps: none || (coin && coinReturns === 'day1') ? null : ((k * 131) % 1200) - 617,
      day20Bps: none || (coin && coinReturns !== 'full') ? null : ((k * 271) % 3000) - 1513,
    };
  });
  const holdings = {};
  if (held)
    for (const symbol of ['NVDA', ...ARBITRUM])
      if (universe.some((t) => t.symbol === symbol)) holdings[symbol] = 3 * MICRO;
  return [
    { role: 'system', content: decisionSystemMessage(universe) },
    assembleDecisionMessages({
      now: takenAt,
      prices,
      returns,
      halted: [],
      portfolio: { cashMicro: 5_000 * MICRO, holdings },
      equityMicro: STARTING_CASH_MICRO,
      strategy: 'Hold the five strongest names of the last month at 18 percent each and keep the rest in cash.',
    })[1],
  ];
}

const universe22 = UNIVERSE.filter((token) => !ARBITRUM.includes(token.symbol));
const base = messageTokens(decisionMessages(universe22, 'full', false));
const INPUT_NEURONS_PER_MILLION = 26_668; // HOUSE_MODEL_INPUT_NEURONS as deployed (docs/CONTRACTS.md section 2)
console.log(
  `\ninput pre-tokens of one decision at 22 symbols: ${base} (system ${tokens(decisionSystemMessage(universe22))})`,
);
for (const [label, coinReturns, held] of [
  ['coins with no return yet', 'none', false],
  ['coins with a 1-day return', 'day1', false],
  ['coins with every return', 'full', false],
  ['coins with every return, three held', 'full', true],
]) {
  const total = messageTokens(decisionMessages(UNIVERSE, coinReturns, held));
  const baseHeld = held ? messageTokens(decisionMessages(universe22, 'full', true)) : base;
  const added = total - baseHeld;
  const neurons = (added * INPUT_NEURONS_PER_MILLION) / 1_000_000;
  console.log(
    `  25 symbols, ${label}: ${total} (+${added} pre-tokens, +${neurons.toFixed(2)} neurons a decision, ` +
      `+${(neurons * MAX_AGENTS_OPEN).toFixed(0)} a day at ${MAX_AGENTS_OPEN} Open agents)`,
  );
}
console.log(
  `  system message: +${tokens(system25) - tokens(decisionSystemMessage(universe22))} pre-tokens; ` +
    `characters ${decisionSystemMessage(universe22).length} -> ${system25.length}`,
);
console.log(`  HOUSE_NEURONS_PER_DAY: ${HOUSE_NEURONS_PER_DAY}`);

console.log(`\nmarket universe before this run: ${marketUniverse().length} symbols`);
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exitCode = failures === 0 ? 0 : 1;
