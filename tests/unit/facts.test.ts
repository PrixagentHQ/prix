import {
  AGENT_NAME_MAX,
  AGENT_NAME_MIN,
  FEE_BPS,
  FEED_STALE_AFTER_SECONDS,
  KEY_FAILURES_TO_PAUSE,
  MARKET_QUIET_AFTER_SECONDS,
  MAX_AGENTS_OPEN,
  MAX_AGENTS_PRO,
  MAX_HALTED_FEEDS,
  MAX_MODEL_KEYS_PER_WALLET,
  MAX_PROMPT_CHANGES_PER_DAY,
  MAX_WEIGHT_BPS,
  MICRO,
  MIN_DECISIONS_TO_RANK,
  MIN_PRICE_MICRO,
  MIN_TRADE_BPS,
  MIN_TRADING_DAYS_TO_RANK,
  OPEN_DAILY_TICK_HOUR_UTC,
  PROMPT_MAX,
  PROMPT_MIN,
  REASON_MAX,
  SCORING_METHOD,
  SEASON_LENGTH_DAYS,
  SESSION_TTL_SECONDS,
  SLIPPAGE_BPS,
  STARTING_CASH_MICRO,
  SUMMARY_MAX,
  SUSPECT_MOVE_BPS,
  TICK_CREATE_WINDOW_MINUTES,
  TICK_FIRST_HOUR_UTC,
  TICK_LAST_HOUR_UTC,
  TICK_WINDOW_MINUTES,
  UNIVERSE_SIZE,
} from '@prix/contracts';
import { describe, expect, it } from 'vitest';
import { facts, roundsPerDay } from '../../apps/web/src/content/facts.ts';

/**
 * Every number the copy states comes from `facts`, which repeats the constants of the
 * contract so that a page does not ship the validation library. The type of the file catches a
 * literal constant that moves, but not `startingCashUsd` and `sessionDays`, which the contract
 * computes. This test holds all of them to the contract, one by one, so the site cannot say
 * a number that the product does not use.
 */
describe('facts in apps/web/src/content/facts.ts equal the constants of the contract', () => {
  const expected = {
    scoringMethod: SCORING_METHOD,
    universeSize: UNIVERSE_SIZE,
    startingCashUsd: STARTING_CASH_MICRO / MICRO,
    maxWeightBps: MAX_WEIGHT_BPS,
    feeBps: FEE_BPS,
    slippageBps: SLIPPAGE_BPS,
    minTradeBps: MIN_TRADE_BPS,
    maxHaltedFeeds: MAX_HALTED_FEEDS,
    feedStaleAfterSeconds: FEED_STALE_AFTER_SECONDS,
    marketQuietAfterSeconds: MARKET_QUIET_AFTER_SECONDS,
    suspectMoveBps: SUSPECT_MOVE_BPS,
    minPriceMicro: MIN_PRICE_MICRO,
    seasonLengthDays: SEASON_LENGTH_DAYS,
    tickFirstHourUtc: TICK_FIRST_HOUR_UTC,
    tickLastHourUtc: TICK_LAST_HOUR_UTC,
    openDailyTickHourUtc: OPEN_DAILY_TICK_HOUR_UTC,
    tickCreateWindowMinutes: TICK_CREATE_WINDOW_MINUTES,
    tickWindowMinutes: TICK_WINDOW_MINUTES,
    minTradingDaysToRank: MIN_TRADING_DAYS_TO_RANK,
    minDecisionsToRank: MIN_DECISIONS_TO_RANK,
    maxAgentsOpen: MAX_AGENTS_OPEN,
    maxAgentsPro: MAX_AGENTS_PRO,
    maxModelKeysPerWallet: MAX_MODEL_KEYS_PER_WALLET,
    maxPromptChangesPerDay: MAX_PROMPT_CHANGES_PER_DAY,
    keyFailuresToPause: KEY_FAILURES_TO_PAUSE,
    agentNameMin: AGENT_NAME_MIN,
    agentNameMax: AGENT_NAME_MAX,
    promptMin: PROMPT_MIN,
    promptMax: PROMPT_MAX,
    reasonMax: REASON_MAX,
    summaryMax: SUMMARY_MAX,
    sessionDays: SESSION_TTL_SECONDS / 86_400,
  } as const;

  it.each(Object.entries(expected))('%s', (name, value) => {
    expect((facts as Record<string, unknown>)[name]).toBe(value);
  });

  it('has no field that this test does not hold to a constant, and no constant it lacks', () => {
    expect(Object.keys(facts).sort()).toEqual(Object.keys(expected).sort());
  });

  it('counts the rounds of a day from the first and the last hour', () => {
    expect(roundsPerDay).toBe(TICK_LAST_HOUR_UTC - TICK_FIRST_HOUR_UTC + 1);
    expect(roundsPerDay).toBe(5);
  });
});
