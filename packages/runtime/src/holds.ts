import type {
  IsoTime,
  MarketSnapshot,
  PricePoint,
  SymbolHold,
  Tick,
  TickId,
  TokenSymbol,
  TrustedPrices,
  UtcDay,
} from '@prix/contracts';
import { BPS, CHAIN_ID, MAX_HALTED_FEEDS, MIN_PRICE_MICRO, SUSPECT_MOVE_BPS, utcDayOfTick } from '@prix/contracts';
import { UNIVERSE } from '@prix/market';

/**
 * Holds: the guard against a bad feed value. docs/CONTRACTS.md section 5, as changed by
 * sections 15 and 20. Pure: no clock, no store, no network.
 */

/** The snapshot of a market that could not be read at all. */
export function unavailableSnapshot(takenAt: IsoTime): MarketSnapshot {
  return {
    takenAt,
    chainId: CHAIN_ID,
    blockNumber: 0,
    open: false,
    closedReason: 'rpc_unavailable',
    prices: [],
  };
}

/** The crypto assets of the universe (section 21). Every other symbol counts as a Stock Token. */
const CRYPTO_SYMBOLS: ReadonlySet<TokenSymbol> = new Set(
  UNIVERSE.filter((token) => token.kind === 'crypto').map((token) => token.symbol),
);

/**
 * Gives every halted point without a readable price a price it can be valued at (section 21, rule
 * 3). The market emits such a point for a crypto feed it could not read: not fresh, with no usable
 * price (below MIN_PRICE_MICRO, as zero).
 * Valuing a portfolio that holds the symbol would throw, so before the tick is stored the point
 * takes the symbol's last trusted price, or failing that its price in the latest tick, and stays
 * not fresh: valued, not traded. With neither, no stored tick has ever priced the symbol, so no
 * portfolio can hold it, and the point is left out: nobody can hold or target it in this tick.
 */
function priceUnreadPoints(
  prices: readonly PricePoint[],
  trusted: TrustedPrices,
  previous: ReadonlyMap<TokenSymbol, PricePoint>,
): PricePoint[] {
  const out: PricePoint[] = [];
  for (const point of prices) {
    // A fresh point always has a price; one below the minimum is a bad value for the comparison.
    if (point.fresh || point.priceMicro >= MIN_PRICE_MICRO) {
      out.push(point);
      continue;
    }
    const before = previous.get(point.symbol)?.priceMicro;
    const known = trusted[point.symbol]?.priceMicro ?? (before !== undefined && before > 0 ? before : undefined);
    if (known !== undefined) out.push({ ...point, priceMicro: known, fresh: false });
  }
  return out;
}

/** True when the price moved by more than SUSPECT_MOVE_BPS. BigInt, because the products can be large. */
function isSuspectMove(before: number, after: number): boolean {
  if (!(before > 0)) return false;
  const move = BigInt(Math.abs(Math.trunc(after) - Math.trunc(before)));
  return move * BigInt(BPS) > BigInt(SUSPECT_MOVE_BPS) * BigInt(Math.trunc(before));
}

export interface HeldSnapshot {
  /** The snapshot as it is stored: held symbols at their trusted price and not fresh. */
  snapshot: MarketSnapshot;
  /** Holds that begin with this snapshot. */
  newHolds: SymbolHold[];
  /**
   * Symbols whose hold an admin has released. This snapshot carries the feed's price for them,
   * taken without a comparison. The scheduler deletes their rows once the tick exists.
   */
  released: TokenSymbol[];
}

/** What the stored ticks say about the past, for the comparison. The scheduler reads it. */
export interface PriceHistory {
  /** `Store.getLastTrustedPrices(tickId)`: the last fresh point of each symbol in the lookback. */
  trusted: TrustedPrices;
  /** The newest tick, whatever its day. Null before the first tick of a league. */
  latest: Tick | null;
  /**
   * The newest UTC day before the tick's own that has a tick: ticks exist only on trading days, so
   * this is the previous trading day. Null when no tick is from an earlier day.
   */
  previousTradingDay: UtcDay | null;
  /**
   * The symbols the stored daily prices carried before the previous trading day: the symbols that
   * were in the league before it. A symbol with no trusted price that is not in this set entered
   * the league since, and its first price is its anchor. Undefined when it was not read: every
   * symbol then counts as established, the stricter reading.
   */
  establishedSymbols?: ReadonlySet<TokenSymbol> | undefined;
}

/**
 * Applies the holds to a snapshot the market returned.
 *
 * - A held symbol keeps its trusted price and is marked not fresh, in every snapshot, open or
 *   closed. It counts as halted: valued, and not traded.
 * - A released hold no longer holds anything. Its symbol takes the feed's price in this snapshot
 *   and is not compared, because the trusted price may still be the old one and the comparison
 *   would only begin the same hold again.
 * - In a snapshot the market returned open, every other point, fresh or not, is compared with the
 *   last trusted price of its symbol (`Store.getLastTrustedPrices`), not with the latest tick, so
 *   a symbol that was paused or stale for a round is still compared. A move of more than
 *   SUSPECT_MOVE_BPS begins a hold that keeps the last trusted price.
 * - A symbol whose last trusted price is older than the previous trading day begins a hold for
 *   review whenever its price is not that trusted price, however small the move. So does a
 *   symbol with no trusted price in the lookback while the latest tick carries it: the hold keeps
 *   its price in the latest tick.
 * - A symbol with no trusted price that the latest tick does not carry (BTC and ETH in their first
 *   round after the deploy) enters priced but not fresh: valued, not traded, and it begins no
 *   hold. Its price is the anchor: in the next round, while it is not in
 *   `history.establishedSymbols`, it is compared with that anchor by SUSPECT_MOVE_BPS, and trades
 *   if it passes. Only at the first tick of a league, with no latest tick, is a point taken as it
 *   is with nothing to compare with.
 * - Before any of this, a point without a readable price (an unread crypto feed) takes its last
 *   trusted price, or its price in the latest tick, and is not fresh; with neither it is left out
 *   (`priceUnreadPoints`). It is then compared like any other point, so it begins no hold.
 * - If more than MAX_HALTED_FEEDS Stock Token symbols are then halted, the market is closed with
 *   `held_for_review`. A crypto symbol never counts: its hold halts that symbol alone (section 21). Only a snapshot the market returned open can get that reason; one the
 *   market closed keeps the market's own reason.
 */
export function applyHolds(
  market: MarketSnapshot,
  history: PriceHistory,
  holds: readonly SymbolHold[],
  tickId: TickId,
  now: IsoTime,
  cryptoSymbols: ReadonlySet<TokenSymbol> = CRYPTO_SYMBOLS,
): HeldSnapshot {
  const { trusted, latest, previousTradingDay, establishedSymbols } = history;
  const active = new Map<TokenSymbol, SymbolHold>();
  const released: TokenSymbol[] = [];
  for (const hold of holds) {
    if (hold.releasedAt === null) active.set(hold.symbol, hold);
    else released.push(hold.symbol);
  }
  if (market.prices.length === 0) return { snapshot: market, newHolds: [], released };

  const skipComparison = new Set(released);
  const previous = new Map((latest?.snapshot.prices ?? []).map((point) => [point.symbol, point]));
  const newHolds: SymbolHold[] = [];

  /** The price a hold of this point keeps, or null when the point is taken as it is. */
  const keptPrice = (point: PricePoint): number | null => {
    const last = trusted[point.symbol];
    if (last === undefined) {
      const before = previous.get(point.symbol);
      if (before === undefined) return null;
      // A new symbol's first price, valued and not traded in the latest tick, is its anchor.
      if (establishedSymbols !== undefined && !establishedSymbols.has(point.symbol)) {
        return isSuspectMove(before.priceMicro, point.priceMicro) ? before.priceMicro : null;
      }
      return before.priceMicro !== point.priceMicro ? before.priceMicro : null;
    }
    if (previousTradingDay !== null && utcDayOfTick(last.tickId) < previousTradingDay) {
      return last.priceMicro !== point.priceMicro ? last.priceMicro : null;
    }
    return isSuspectMove(last.priceMicro, point.priceMicro) ? last.priceMicro : null;
  };

  // A closed snapshot is never stored as a tick, so only an open one needs a price for every point.
  const priced = market.open ? priceUnreadPoints(market.prices, trusted, previous) : market.prices;
  const prices: PricePoint[] = priced.map((point) => {
    const hold = active.get(point.symbol);
    if (hold !== undefined) return { ...point, priceMicro: hold.priceMicro, fresh: false };
    if (!market.open || skipComparison.has(point.symbol)) return point;

    // A symbol with no trusted price that the latest tick does not carry enters priced but not
    // fresh: its price becomes the anchor of the comparison before anyone can trade at it.
    if (latest !== null && trusted[point.symbol] === undefined && !previous.has(point.symbol)) {
      return point.fresh ? { ...point, fresh: false } : point;
    }
    const kept = keptPrice(point);
    if (kept === null) return point;
    newHolds.push({
      symbol: point.symbol,
      priceMicro: kept,
      seenPriceMicro: point.priceMicro,
      sinceTickId: tickId,
      releasedAt: null,
      createdAt: now,
    });
    return { ...point, priceMicro: kept, fresh: false };
  });

  const halted = prices.filter((point) => !point.fresh && !cryptoSymbols.has(point.symbol)).length;
  if (market.open && halted > MAX_HALTED_FEEDS) {
    return { snapshot: { ...market, open: false, closedReason: 'held_for_review', prices }, newHolds, released };
  }
  return { snapshot: { ...market, prices }, newHolds, released };
}
