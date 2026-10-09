import type { WarStanding, WarStandingInput, WarStandingsEngine } from '@prix/contracts';
import { MIN_TRADING_DAYS_V2, STARTING_CASH_MICRO } from '@prix/contracts';
import { scoringV2 } from './v2.ts';

/**
 * Model War standings: one paper run of one strategy by several models under the same conditions.
 * docs/contracts/phase-6-social.md section 5.3. It describes one run. It does not say which model is
 * better, and nothing in it is a forecast or advice.
 *
 * Order (scoring v1): season return, higher first; then max drawdown, lower first; then fewer trades;
 * then slot A to D. Two entrants with equal return and equal drawdown share a rank (the next rank skips,
 * so 1, 1, 3), whatever their trade counts. Ranks exist only once the war is complete: while it runs
 * every rank is null and the rows keep slot order, so the table is not a live leaderboard.
 *
 * The v2 breakdown (a shrunk daily Sharpe-like ratio over the war's days) and its confidence are shown
 * beside the figures. They never order the table, and the confidence is `insufficient` below
 * MIN_TRADING_DAYS_V2 days.
 *
 * What it excludes: it reads only the stored entrant and its rows. Costs are the fees and slippage the
 * paper engine charged; neurons are what the provider reported or the estimate stored with the row; the
 * accounting is replayable from the rows.
 */

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function standingOf(input: WarStandingInput): WarStanding {
  const { entrant, rows } = input;
  let decided = 0;
  let noDecision = 0;
  let skipped = 0;
  let costMicro = 0;
  let neurons = 0;
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.status === 'decided') decided += 1;
    else if (row.status === 'no_decision') noDecision += 1;
    else skipped += 1;
    if (row.code !== null) counts.set(row.code, (counts.get(row.code) ?? 0) + 1);
    costMicro += row.costMicro;
    if (typeof row.neurons === 'number' && Number.isFinite(row.neurons)) neurons += row.neurons;
  }
  const codes: Record<string, number> = {};
  for (const code of [...counts.keys()].sort(cmp)) codes[code] = counts.get(code) as number;

  const daily = entrant.stats.daily;
  const returns = scoringV2.dailyReturnsBps(STARTING_CASH_MICRO, daily);
  const v2 = scoringV2.breakdownOf(scoringV2.momentsOf(returns));
  return {
    slot: entrant.slot,
    modelId: entrant.modelId,
    provider: entrant.provider,
    label: entrant.label,
    maker: entrant.maker,
    rank: null,
    returnBps: entrant.stats.seasonReturnBps,
    maxDrawdownBps: entrant.stats.maxDrawdownBps,
    tradeCount: entrant.stats.tradeCount,
    days: entrant.days,
    decided,
    noDecision,
    skipped,
    codes,
    costMicro,
    neurons,
    v2,
    confidence: scoringV2.confidenceOf(v2.n, v2.n >= MIN_TRADING_DAYS_V2),
    daily: daily.map((p) => ({ day: p.day, equityMicro: p.equityMicro })),
  };
}

function standings(entrants: readonly WarStandingInput[], complete: boolean): WarStanding[] {
  const list = entrants.map(standingOf);
  if (!complete) return list.sort((a, b) => cmp(a.slot, b.slot));
  list.sort(
    (a, b) =>
      b.returnBps - a.returnBps ||
      a.maxDrawdownBps - b.maxDrawdownBps ||
      a.tradeCount - b.tradeCount ||
      cmp(a.slot, b.slot),
  );
  let rank = 0;
  list.forEach((s, i) => {
    const before = list[i - 1];
    if (!before || before.returnBps !== s.returnBps || before.maxDrawdownBps !== s.maxDrawdownBps) rank = i + 1;
    s.rank = rank;
  });
  return list;
}

export const warStandings: WarStandingsEngine = { standings };
