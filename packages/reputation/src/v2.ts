import type {
  AllTimeRecord,
  Confidence,
  ScoreBreakdown,
  ScoreMoments,
  ScoreRankInput,
  ScoringV2Engine,
  SeasonScoreCore,
  SeasonScoreInput,
} from '@prix/contracts';
import {
  CONFIDENCE_HIGH_DAYS,
  CONFIDENCE_MEDIUM_DAYS,
  MIN_ACTIVE_DAYS_CHAIN,
  MIN_DECISIONS_V2,
  MIN_EXPOSURE_DAYS_CHAIN,
  MIN_TRADING_DAYS_V2,
  SHRINK_DAYS,
  VOL_FLOOR_BPS,
} from '@prix/contracts';

/**
 * Scoring v2: a shrunk daily Sharpe-like ratio. docs/contracts/phase-2-reputation.md section 5.
 * It measures a short, simulated record. It is not proof of skill and not advice.
 *
 * Hand-computed example. Ten daily returns in bps: 100, -50, 200, 0, 150, -100, 50, 25, -25, 100.
 *   n = 10, sumBps = 450, sumSqBps = 98,750
 *   mean = 45 bps                                  -> meanMilliBps 45,000
 *   variance = (98,750 - 450^2 / 10) / 9 = 8,722.2222; vol = 93.3927 bps -> volMilliBps 93,393
 *   volEff = max(93.3927, 25) = 93.3927; ratio = 45 / 93.3927 = 0.48183 -> ratioMilli 482
 *   shrink = 10 / (10 + 20) = 0.33333              -> shrinkMilli 333
 *   score = 0.48183 * 0.33333 = 0.16061            -> scoreMilli 161
 */

const nz = (x: number): number => (x === 0 || Number.isNaN(x) ? 0 : x);
const milli = (x: number): number => nz(Math.round(x * 1000));

function dailyReturnsBps(startEquityMicro: number, daily: readonly { day: string; equityMicro: number }[]): number[] {
  const out: number[] = [];
  let before = startEquityMicro;
  for (const point of daily) {
    out.push(before > 0 ? nz(Math.round(((point.equityMicro - before) * 10_000) / before)) : 0);
    before = point.equityMicro;
  }
  return out;
}

function momentsOf(returnsBps: readonly number[]): ScoreMoments {
  let sumBps = 0;
  let sumSqBps = 0;
  for (const r of returnsBps) {
    sumBps += r;
    sumSqBps += r * r;
  }
  return { n: returnsBps.length, sumBps: nz(sumBps), sumSqBps };
}

function breakdownOf(m: ScoreMoments): ScoreBreakdown {
  const n = m.n;
  if (!(n > 0)) return { n: 0, meanMilliBps: 0, volMilliBps: 0, ratioMilli: 0, shrinkMilli: 0, scoreMilli: 0 };
  const mean = m.sumBps / n;
  const variance = n < 2 ? 0 : Math.max(0, (m.sumSqBps - (m.sumBps * m.sumBps) / n) / (n - 1));
  const vol = Math.sqrt(variance);
  const ratio = mean / Math.max(vol, VOL_FLOOR_BPS);
  const shrink = n / (n + SHRINK_DAYS);
  return {
    n,
    meanMilliBps: milli(mean),
    volMilliBps: milli(vol),
    ratioMilli: milli(ratio),
    shrinkMilli: milli(shrink),
    scoreMilli: milli(ratio * shrink),
  };
}

function confidenceOf(n: number, eligible: boolean): Confidence {
  if (!eligible) return 'insufficient';
  if (n < CONFIDENCE_MEDIUM_DAYS) return 'low';
  if (n < CONFIDENCE_HIGH_DAYS) return 'medium';
  return 'high';
}

function seasonScore(input: SeasonScoreInput): SeasonScoreCore {
  const chain = input.division === 'chain';
  const moments = momentsOf(input.returnsBps);
  const breakdown = breakdownOf(moments);
  const unrankedReason =
    input.tradingDays < (chain ? MIN_EXPOSURE_DAYS_CHAIN : MIN_TRADING_DAYS_V2)
      ? ('min_trading_days' as const)
      : input.decidedCount < (chain ? MIN_ACTIVE_DAYS_CHAIN : MIN_DECISIONS_V2)
        ? ('min_decisions' as const)
        : !input.activeOnScoredDay
          ? ('inactive' as const)
          : null;
  return { moments, breakdown, confidence: confidenceOf(moments.n, unrankedReason === null), unrankedReason };
}

const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function compare(a: ScoreRankInput, b: ScoreRankInput): number {
  return (
    b.scoreMilli - a.scoreMilli ||
    b.returnBps - a.returnBps ||
    a.maxDrawdownBps - b.maxDrawdownBps ||
    cmpStr(a.createdAt, b.createdAt) ||
    cmpStr(a.agentId, b.agentId)
  );
}

function rankAll(entries: readonly ScoreRankInput[]): { agentId: string; rank: number | null }[] {
  const ranked = entries.filter((e) => e.unrankedReason === null).sort(compare);
  const rest = entries.filter((e) => e.unrankedReason !== null).sort(compare);
  return [
    ...ranked.map((e, i): { agentId: string; rank: number | null } => ({ agentId: e.agentId, rank: i + 1 })),
    ...rest.map((e): { agentId: string; rank: number | null } => ({ agentId: e.agentId, rank: null })),
  ];
}

function allTime(
  seasons: readonly { method: 'v1' | 'v2'; returnBps: number; tradingDays: number; moments: ScoreMoments }[],
): AllTimeRecord {
  let product = 1;
  let tradingDays = 0;
  let scoredSeasons = 0;
  const pooled: ScoreMoments = { n: 0, sumBps: 0, sumSqBps: 0 };
  for (const s of seasons) {
    product *= (10_000 + s.returnBps) / 10_000;
    tradingDays += s.tradingDays;
    if (s.method === 'v2') {
      scoredSeasons += 1;
      pooled.n += s.moments.n;
      pooled.sumBps += s.moments.sumBps;
      pooled.sumSqBps += s.moments.sumSqBps;
    }
  }
  return {
    seasons: seasons.length,
    scoredSeasons,
    returnBps: nz(Math.round((product - 1) * 10_000)),
    tradingDays,
    breakdown: breakdownOf(pooled),
    confidence: confidenceOf(pooled.n, pooled.n >= MIN_TRADING_DAYS_V2),
  };
}

export const scoringV2: ScoringV2Engine = {
  dailyReturnsBps,
  momentsOf,
  breakdownOf,
  confidenceOf,
  seasonScore,
  compare,
  rankAll,
  allTime,
};
