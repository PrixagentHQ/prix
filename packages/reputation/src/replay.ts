import type {
  AgentStats,
  MarketSnapshot,
  PortfolioState,
  ReplayEngine,
  ReplayInput,
  ReplayMismatch,
  ReplayReport,
  TokenSymbol,
} from '@prix/contracts';
import { utcDayOfTick } from '@prix/contracts';

/**
 * Replay of one agent's rows. Re-runs the stored targets through `sim.rebalance` and the rows
 * through `scoring.updateStats`, and compares. It never calls a model and never reads a prompt.
 * This package does not depend on the market package, so the two readers below copy
 * `toPriceMap` and `haltedSymbols` of packages/market/src/returns.ts.
 */

function priceMap(snapshot: MarketSnapshot): Record<TokenSymbol, number> {
  const map: Record<TokenSymbol, number> = {};
  for (const point of snapshot.prices) map[point.symbol] = point.priceMicro;
  return map;
}

function halted(snapshot: MarketSnapshot): TokenSymbol[] {
  return snapshot.prices.filter((point) => !point.fresh).map((point) => point.symbol);
}

/** A canonical text: keys sorted, zero holdings dropped from `holdings`. */
function canon(value: unknown, key?: string): string {
  if (Array.isArray(value)) return `[${value.map((v) => canon(v)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => !(key === 'holdings' && v === 0))
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([k, v]) => `${JSON.stringify(k)}:${canon(v, k)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

const same = (a: unknown, b: unknown): boolean => canon(a) === canon(b);

function replayAgent(input: ReplayInput): ReplayReport {
  const { sim, scoring } = input;
  let portfolio: PortfolioState = input.from?.portfolio ?? sim.newPortfolio();
  let stats: AgentStats = input.from?.stats ?? scoring.initialStats();
  let rows = 0;

  const stop = (tickId: string, field: ReplayMismatch['field']): ReplayReport => ({
    match: false,
    rows,
    firstMismatch: { tickId, field },
    portfolio,
    stats,
  });

  for (const row of input.rows) {
    const tick = input.ticks[row.tickId];
    if (!tick) return stop(row.tickId, 'equity');
    const prices = priceMap(tick.snapshot);
    let next: PortfolioState;
    try {
      if (row.status === 'decided') {
        const result = sim.rebalance({
          portfolio,
          prices,
          targetsBps: row.targetsBps ?? {},
          halted: halted(tick.snapshot),
        });
        if (!same(result.fills, row.fills)) return stop(row.tickId, 'fills');
        if (!same(result.portfolio, row.portfolio)) return stop(row.tickId, 'portfolio');
        if (result.equityAfterMicro !== row.equityMicro) return stop(row.tickId, 'equity');
        next = result.portfolio;
      } else {
        if (row.fills.length > 0) return stop(row.tickId, 'fills');
        if (!same(portfolio, row.portfolio)) return stop(row.tickId, 'portfolio');
        if (sim.valuePortfolio(portfolio, prices) !== row.equityMicro) return stop(row.tickId, 'equity');
        next = portfolio;
      }
    } catch {
      return stop(row.tickId, 'fills');
    }
    portfolio = next;
    stats = scoring.updateStats(stats, {
      day: utcDayOfTick(row.tickId),
      status: row.status,
      equityMicro: row.equityMicro,
      fillCount: row.fills.length,
    });
    rows += 1;
  }

  const lastRow = input.rows[input.rows.length - 1];
  if (lastRow && !same(stats, input.published)) return stop(lastRow.tickId, 'stats');
  return { match: true, rows, firstMismatch: null, portfolio, stats };
}

export const replay: ReplayEngine = { replayAgent };
