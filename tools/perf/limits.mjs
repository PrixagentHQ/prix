// The numbers every script in this folder checks against. Nothing here is a perf decision:
// each value is copied from the document named beside it. Change the document first.

import {
  FEED_STALE_AFTER_SECONDS,
  HOUSE_MAX_OUTPUT_TOKENS,
  HOUSE_NEURONS_PER_DAY,
  HOUSE_SUMMARY_NEURONS_PER_DAY,
  LEAGUE_PAGE_SIZE,
  MAX_AGENTS_OPEN,
  MAX_AGENTS_PRO,
  OPEN_DAILY_TICK_HOUR_UTC,
  OWN_MAX_OUTPUT_TOKENS,
  TICK_CREATE_WINDOW_MINUTES,
  TICK_FIRST_HOUR_UTC,
  TICK_LAST_HOUR_UTC,
  TICK_WINDOW_MINUTES,
} from '../../packages/contracts/src/constants.ts';

/** docs/SPEC.md section 7.5. */
export const WEB_BUDGETS = Object.freeze({
  /** Lighthouse category score, 0 to 100. A page fails below this. */
  minCategoryScore: 95,
  categories: Object.freeze(['performance', 'accessibility', 'best-practices', 'seo']),
  /** Largest contentful paint must be under this many milliseconds. */
  lcpMs: 1_800,
  /** Cumulative layout shift must be under this. */
  cls: 0.02,
  /** Compressed JavaScript on the landing page must be under this many bytes. 1 KB is 1,000 bytes. */
  landingJsBytes: 60_000,
});

/** docs/CONTRACTS.md section 2, the free-plan table, read from developers.cloudflare.com on 2026-10-06. */
export const FREE_PLAN = Object.freeze({
  workerRequestsPerDay: 100_000,
  cpuMsPerHttpRequest: 10,
  cpuMsPerCronTrigger: 10,
  subrequestsPerInvocation: 50,
  simultaneousConnections: 6,
  d1QueriesPerInvocation: 50,
  d1RowsReadPerDay: 5_000_000,
  d1RowsWrittenPerDay: 100_000,
  d1SizeBytes: 500_000_000,
  workersAiNeuronsPerDay: 10_000,
  /**
   * Worker size on the free plan: 3 MB after gzip (developers.cloudflare.com/workers/platform/limits/).
   * Read as 3,000,000 bytes, the stricter of 3 MB and 3 MiB. The paid plan allows 10 MB.
   */
  workerScriptGzipBytes: 3_000_000,
});

/**
 * docs/CONTRACTS.md section 2, `SchedulerLimits` as the Worker entry point sets them, with the
 * fields that section 15 (revision 3) adds. capacity.mjs hands this object to the scheduler.
 */
export const SCHEDULER_LIMITS = Object.freeze({
  maxDecisionsPerStep: 5,
  maxSkipsPerStep: 10,
  maxSummariesPerStep: 2,
  houseNeuronsPerDay: HOUSE_NEURONS_PER_DAY,
  houseNeuronsPerMillionInputTokens: 26_668,
  houseNeuronsPerMillionOutputTokens: 204_805,
  summaryNeuronsPerDay: HOUSE_SUMMARY_NEURONS_PER_DAY,
  modelTimeoutMs: 20_000,
  maxOutputTokens: HOUSE_MAX_OUTPUT_TOKENS,
  ownMaxOutputTokens: OWN_MAX_OUTPUT_TOKENS,
  feedStaleAfterSeconds: FEED_STALE_AFTER_SECONDS,
});

/** docs/CONTRACTS.md section 15, "Agents per division". */
export const DIVISION_CAPS = Object.freeze({ open: MAX_AGENTS_OPEN, pro: MAX_AGENTS_PRO });

/** docs/CONTRACTS.md sections 10 and 15, from packages/contracts/src/constants.ts. */
export const DAY_SHAPE = Object.freeze({
  tickFirstHourUtc: TICK_FIRST_HOUR_UTC,
  tickLastHourUtc: TICK_LAST_HOUR_UTC,
  ticksPerDay: TICK_LAST_HOUR_UTC - TICK_FIRST_HOUR_UTC + 1,
  openDailyTickHourUtc: OPEN_DAILY_TICK_HOUR_UTC,
  tickCreateWindowMinutes: TICK_CREATE_WINDOW_MINUTES,
  tickWindowMinutes: TICK_WINDOW_MINUTES,
  /** One Cron Trigger, every minute. */
  stepsPerDay: 24 * 60,
  leaguePageSize: LEAGUE_PAGE_SIZE,
});

/** docs/CONTRACTS.md section 15, "Caching": the API serves the public reads from a cache for this long. */
export const PUBLIC_CACHE_SECONDS = 30;

/**
 * docs/CONTRACTS.md section 13: the keyed RPC endpoint first, the public one as fallback, and
 * section 5: one batched read per endpoint tried. So a snapshot is at most two outbound requests.
 */
export const RPC_READS_PER_SNAPSHOT = 2;

/**
 * Measured on 2026-10-06 (docs/reviews/phase-1-house-model.md, docs/CONTRACTS.md section 15), house model
 * `@cf/meta/llama-3.3-70b-instruct-fp8-fast`: tokens of one call. A decision is about 970 input tokens for a
 * short strategy and 50 to 70 output tokens; a strategy of 2,000 characters adds about 500 input tokens.
 * A summary is about 320 input and 20 output tokens. Workers AI reports the exact cost in `usage.neurons`.
 */
export const HOUSE_CALL_TOKENS = Object.freeze({
  decisionShort: Object.freeze({ input: 970, output: 60 }),
  decisionLong: Object.freeze({ input: 1_470, output: 70 }),
  summary: Object.freeze({ input: 320, output: 20 }),
});
