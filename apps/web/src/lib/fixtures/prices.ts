import type { MarketPricesResponse, MarketStatus, TokenSymbol } from '@prix/contracts';
import { usd } from './league.ts';

/**
 * The price strip, GET /api/market/prices (docs/CONTRACTS.md section 17.2): every symbol of the
 * universe at the latest round, in universe order, with the names packages/market gives them: the
 * twenty Stock Tokens in symbol order, then the crypto assets BTC and ETH (section 21), then BNB,
 * HYPE and SOL (section 23).
 *
 * The strip follows the market fixture: its round is the market's `lastTickId`, and a market
 * without a round, or a site without a season, answers a null round and no prices. The prices of
 * a round are the ones the agents of that fixture traded at, so a card and the strip agree.
 *
 * Every state shows a mix of gains and losses, one symbol without a change (SPCX: no daily price
 * of it is stored before the round's day) and one stale feed: the halted symbols of the market
 * fixture when it names some (market-halted: AMD and QQQ, market-crypto-halted: BTC), USO
 * otherwise, so the mark can be seen.
 *
 * The coins carry their own scale: BTC and ETH a price in five or six figures beside the stocks'
 * two or three, and each coin a daily change of a few percent. In the round of the first week they
 * have no change yet, as on the first trading day the league reads them (section 21, rule 5:
 * nothing is backfilled).
 */

/** Symbol, name, price in USD, change in basis points. In universe order. */
type Quote = readonly [symbol: TokenSymbol, name: string, price: number, changeBps: number | null];

/** The names of packages/market/src/universe.ts, in its order: Stock Tokens, then crypto assets. */
const NAMES: readonly (readonly [TokenSymbol, string])[] = [
  ['AAPL', 'Apple'],
  ['AMD', 'AMD'],
  ['AMZN', 'Amazon'],
  ['COIN', 'Coinbase'],
  ['CRCL', 'Circle Internet Group'],
  ['GME', 'GameStop'],
  ['GOOGL', 'Alphabet Class A'],
  ['INTC', 'Intel'],
  ['META', 'Meta Platforms'],
  ['MSFT', 'Microsoft'],
  ['MSTR', 'Strategy Inc.'],
  ['MU', 'Micron Technology'],
  ['NVDA', 'NVIDIA'],
  ['PLTR', 'Palantir Technologies'],
  ['QQQ', 'Invesco QQQ'],
  ['SGOV', 'iShares 0-3 Month Treasury Bond'],
  ['SPCX', 'Space Exploration Technologies Corp. Class A Common Stock'],
  ['SPY', 'SPDR S&P 500 ETF Trust'],
  ['TSLA', 'Tesla'],
  ['USO', 'United States Oil Fund'],
  ['BTC', 'Bitcoin'],
  ['ETH', 'Ethereum'],
  ['BNB', 'BNB'],
  ['HYPE', 'Hyperliquid'],
  ['SOL', 'Solana'],
];

/** Price in USD and change in basis points, by symbol. */
type Round = Readonly<Record<TokenSymbol, readonly [price: number, changeBps: number | null]>>;

/** The daily round of Tuesday 6 October, which the sample league is as of (league.ts). */
const SAMPLE_ROUND: Round = {
  AAPL: [247.85, 64],
  AMD: [214.6, 162],
  AMZN: [236.02, -38],
  COIN: [318.6, -247],
  CRCL: [172.66, 315],
  GME: [41.87, -121],
  GOOGL: [254.11, 27],
  INTC: [36.12, -89],
  META: [739.52, -14],
  MSFT: [512.3, 41],
  MSTR: [341.75, -318],
  MU: [168.59, 204],
  NVDA: [182.41, 118],
  PLTR: [186.4, -176],
  QQQ: [605.9, 33],
  SGOV: [100.42, 1],
  SPCX: [80.26, null],
  SPY: [671.25, 22],
  TSLA: [438.2, -95],
  USO: [71.3, -63],
  BTC: [121_345.67, 182],
  ETH: [4_486.12, -264],
  BNB: [1_182.4, 96],
  HYPE: [46.27, -412],
  SOL: [221.63, 327],
};

/** The daily round of Thursday 8 October, which the first week is as of (early.ts). */
const EARLY_ROUND: Round = {
  AAPL: [247.85, 35],
  AMD: [214.6, 106],
  AMZN: [236.02, -52],
  COIN: [318.6, -412],
  CRCL: [172.66, 61],
  GME: [41.87, -77],
  GOOGL: [254.11, 19],
  INTC: [36.12, -361],
  META: [739.52, 88],
  MSFT: [512.3, -21],
  MSTR: [341.75, -505],
  MU: [168.59, 143],
  NVDA: [184.03, 89],
  PLTR: [186.4, 197],
  QQQ: [604.33, 52],
  SGOV: [100.43, 1],
  SPCX: [80.26, null],
  SPY: [671.88, 52],
  TSLA: [438.2, -133],
  USO: [70.58, -101],
  BTC: [122_084.9, null],
  ETH: [4_431.58, null],
  BNB: [1_176.85, null],
  HYPE: [47.9, null],
  SOL: [218.14, null],
};

/** The prices of the first week's round in USD, by symbol: what the early agents hold is valued at them. */
export const EARLY_PRICES: Readonly<Record<TokenSymbol, number>> = Object.fromEntries(
  Object.entries(EARLY_ROUND).map(([symbol, [price]]) => [symbol, price]),
);

/** The stale feed of a market fixture that halts nothing. */
const STALE_DEFAULT: readonly TokenSymbol[] = ['USO'];

/** The answer before the first round, and on a site without a season. */
export const NO_PRICES: MarketPricesResponse = { tickId: null, takenAt: null, prices: [] };

/**
 * The strip at the market's latest round. `early` selects the round of the first week.
 * A market without a round answers no prices.
 */
export function marketPricesResponse(market: MarketStatus, early: boolean): MarketPricesResponse {
  const tickId = market.lastTickId;
  if (tickId === null) return NO_PRICES;
  const round = early ? EARLY_ROUND : SAMPLE_ROUND;
  const stale = new Set(market.halted.length > 0 ? market.halted : STALE_DEFAULT);
  const quotes: Quote[] = NAMES.map(([symbol, name]) => {
    const [price, changeBps] = round[symbol] ?? [0, null];
    return [symbol, name, price, changeBps];
  });
  return {
    tickId,
    // The snapshot is taken a couple of seconds into the round's hour.
    takenAt: `${tickId.slice(0, 16)}:02.118Z`,
    prices: quotes.map(([symbol, name, price, changeBps]) => ({
      symbol,
      name,
      priceMicro: usd(price),
      changeBps,
      fresh: !stale.has(symbol),
    })),
  };
}
