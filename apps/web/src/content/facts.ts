import type {
  AGENT_NAME_MAX,
  AGENT_NAME_MIN,
  ARBITRUM_CHAIN_ID,
  ARBITRUM_SEQUENCER_GRACE_SECONDS,
  CHAIN_ID,
  CRYPTO_FEED_STALE_AFTER_SECONDS,
  CRYPTO_FEED_STALE_AFTER_SECONDS_BY_SYMBOL,
  CRYPTO_UNIVERSE_SIZE,
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
  SLIPPAGE_BPS,
  STOCK_UNIVERSE_SIZE,
  SUMMARY_MAX,
  SUSPECT_MOVE_BPS,
  TICK_CREATE_WINDOW_MINUTES,
  TICK_FIRST_HOUR_UTC,
  TICK_LAST_HOUR_UTC,
  TICK_WINDOW_MINUTES,
} from '@prix/contracts';

/**
 * Every product number the copy states, in one place. `editor` owns this file.
 *
 * The values repeat constants of `packages/contracts`. They are repeated, not imported, so
 * that a page which shows a sentence does not ship the validation library to the browser.
 * The type at the end of this file fails to compile when a literal constant changes, and
 * `startingCashUsd` and `sessionDays`, which the contract computes, are left for a test.
 * The copy deck, the state sentences and the long-form pages build their numbers from here,
 * so the words cannot drift from each other.
 */
export const facts = {
  scoringMethod: 'v1',
  /** Every symbol of the universe: the Stock Tokens and the crypto assets (sections 21 and 23). */
  universeSize: 25,
  /** STARTING_CASH_MICRO, in whole virtual USD. */
  startingCashUsd: 10_000,
  maxWeightBps: 4_000,
  feeBps: 10,
  slippageBps: 10,
  minTradeBps: 50,
  maxHaltedFeeds: 2,
  /** 25 hours: the feeds' 24 hour heartbeat and one hour of margin. */
  feedStaleAfterSeconds: 90_000,
  /** Three hours with no update from any Stock Token feed closes the market. Crypto feeds never count. */
  marketQuietAfterSeconds: 10_800,
  suspectMoveBps: 3_000,
  minPriceMicro: 10_000,
  seasonLengthDays: 28,
  tickFirstHourUtc: 15,
  tickLastHourUtc: 19,
  openDailyTickHourUtc: 15,
  tickCreateWindowMinutes: 10,
  tickWindowMinutes: 50,
  minTradingDaysToRank: 5,
  minDecisionsToRank: 3,
  maxAgentsOpen: 200,
  maxAgentsPro: 50,
  maxModelKeysPerWallet: 3,
  maxPromptChangesPerDay: 3,
  keyFailuresToPause: 3,
  agentNameMin: 3,
  agentNameMax: 32,
  promptMin: 20,
  promptMax: 2_000,
  reasonMax: 240,
  summaryMax: 280,
  /** SESSION_TTL_SECONDS, in days. */
  sessionDays: 7,
} as const;

/** How many rounds a day can have: one for each hour from the first to the last. */
export const roundsPerDay = facts.tickLastHourUtc - facts.tickFirstHourUtc + 1;

/**
 * How the universe splits by kind (docs/CONTRACTS.md sections 21 and 23). Kept apart from `facts` so
 * that the test which holds every field of `facts` to a constant does not change; the type at the end
 * of this file holds these to the contract.
 */
export const universeFacts = {
  stockSize: 20,
  /** BTC and ETH with their Chainlink feeds on Robinhood Chain; BNB, HYPE and SOL with theirs on Arbitrum One. */
  cryptoSize: 5,
  /** In universe order: BTC and ETH (section 21), then BNB, HYPE and SOL (section 23). */
  cryptoSymbols: ['BTC', 'ETH', 'BNB', 'HYPE', 'SOL'],
} as const;

/**
 * The chains Prix reads prices from (docs/CONTRACTS.md section 23). Robinhood Chain carries every Stock
 * Token, BTC and ETH, and decides whether the market is open. Arbitrum One is read for the prices of
 * BNB, HYPE and SOL only: their Chainlink feeds exist on no other chain Prix reads. The type at the end
 * of this file holds the chain IDs and the grace period to the contract.
 */
export const chainFacts = {
  main: { name: 'Robinhood Chain', chainId: 4663 },
  second: {
    name: 'Arbitrum One',
    chainId: 42161,
    /** The symbols whose feeds are read there, in universe order. */
    symbols: ['BNB', 'HYPE', 'SOL'],
    /**
     * After Arbitrum's sequencer comes back up, its prices are not trusted until it has been up this
     * long: ARBITRUM_SEQUENCER_GRACE_SECONDS, Chainlink's own grace period for L2 sequencer feeds.
     */
    sequencerGraceSeconds: 3_600,
  },
} as const;

/**
 * What the Chainlink feeds of the crypto assets do (docs/CONTRACTS.md sections 21 and 23, read on chain
 * on 2026-10-09 from Chainlink's feed lists for Robinhood Chain and Arbitrum One). Unlike the Stock
 * Token feeds they publish every day of the week, around the clock. The type at the end of this file
 * checks both staleness fields.
 */
export const cryptoFeedFacts = {
  /** A feed publishes a new price when the price has moved this much since the last one. */
  deviationBpsBySymbol: { BTC: 50, ETH: 50, BNB: 10, HYPE: 50, SOL: 10 },
  /** The largest value of `deviationBpsBySymbol`. */
  deviationBps: 50,
  /** A feed publishes at least this often, every day of the week. */
  heartbeatHours: 24,
  /** The Standard Proxy of each feed, on the chain that `chainFacts` names for it. */
  feeds: {
    BTC: '0xa2c5184bF03d373Dc9dE4876eb4Bce595B460251',
    ETH: '0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9',
    BNB: '0x6970460aabF80C5BE983C6b74e5D06dEDCA95D4A',
    HYPE: '0xf9ce4fE2F0EcE0362cb416844AE179a49591D567',
    SOL: '0x24ceA4b8ce57cdA5058b924B9B9987992450590c',
  },
  readOn: '2026-10-09',
  /** BTC and ETH: 25 hours, as for a Stock Token feed. CRYPTO_FEED_STALE_AFTER_SECONDS. */
  staleAfterSeconds: 90_000,
  /**
   * The staleness of each crypto feed: CRYPTO_FEED_STALE_AFTER_SECONDS_BY_SYMBOL. A feed older than its
   * value halts its own symbol for the round and nothing else.
   */
  staleAfterSecondsBySymbol: { BNB: 21_600, BTC: 90_000, ETH: 90_000, HYPE: 43_200, SOL: 7_200 },
  /**
   * BTC and ETH: the longest gap between two prices of each feed over its last 240 updates, measured on
   * chain on 2026-10-09 (docs/reviews/crypto-design-2026-10-09.md).
   */
  longestGapSeconds: { ETH: 86_427, BTC: 83_817 },
  gapsMeasuredOn: '2026-10-09',
  gapsSampleUpdates: 240,
  /**
   * BNB, HYPE and SOL: the longest gap between two prices of each feed over 15 days on Arbitrum One,
   * measured on 2026-10-09 (docs/DECISIONS.md D-127, docs/CONTRACTS.md section 23).
   */
  arbitrumLongestGapSeconds: { BNB: 9_816, HYPE: 22_601, SOL: 4_023 },
  arbitrumGapsMeasuredOn: '2026-10-09',
  arbitrumGapsSampleDays: 15,
} as const;

/**
 * What the Chainlink feeds of the Stock Tokens do, and two tolerances of the market rules.
 * These are not constants of `packages/contracts`, so nothing checks them at compile time.
 * Their sources: packages/market/RESEARCH.md sections 4 and 5, and docs/CONTRACTS.md
 * sections 5 and 15. When a feed's settings change, these change with them.
 */
export const feedFacts = {
  /** A feed publishes a new price when the price has moved this much since the last one. */
  deviationBps: 50,
  /** While its market is open, a feed publishes at least this often. */
  heartbeatHours: 24,
  /** The feeds publish from Sunday to Friday, between these hours of New York time. */
  weekOpensNewYork: 'Sunday 20:00',
  weekClosesNewYork: 'Friday 20:00',
  /** A node whose latest block is older than this has not answered for the present. */
  nodeLagSeconds: 300,
  /** A feed whose update time is further ahead of the clock than this is invalid. */
  futureToleranceSeconds: 300,
} as const;

/** Addresses the copy points to. A page takes them from the deck or from a `Doc` link block. */
export const links = {
  /**
   * Robinhood's own disclosure for Stock Tokens: the site of their issuer, Robinhood Assets
   * (Jersey) Limited, which holds the product description, the risks, the restricted
   * jurisdictions and the prospectus. The Stock Tokens page of the Robinhood Chain
   * documentation sends its readers here for all of them. Opened and read on 2026-10-06.
   */
  stockTokenDisclosure: 'https://docs.robinhood.com/rhj',
  /**
   * FOREHEAD, a browser game of Prix's founder. It is served from its own Worker, not from
   * this site, and the footer links it in the same tab. Added on 2026-10-14 (D-146).
   */
  forehead: 'https://forehead.prixagent.com',
  supportEmail: 'support@prixagent.com',
  supportMailto: 'mailto:support@prixagent.com',
} as const;

/**
 * FOREHEAD's own two thresholds for its cosmetics, in whole $PRIX. They are the game's, not Prix's:
 * Prix's tiers are a share of the supply, set elsewhere, and never named beside these. Read on
 * 2026-10-14 from GET https://forehead.prixagent.com/api/token/status, which answered
 * `"tiers":{"holder":"10000","whale":"1000000"}` for the token at 0xa74aC6E9f2F8493344923c23972D496364241044
 * on chain 4663. Nothing checks them at compile time: when the game changes them, they change here.
 * The token page shows them through `grouped`, in the slot `{amount}` of `token.foreheadUnlockLower`
 * and `token.foreheadUnlockHigher`.
 */
export const foreheadFacts = {
  /** From this many whole $PRIX: four more outfit colours and a gold outline on the name tag. */
  lowerTokens: 10_000,
  /** From this many whole $PRIX: also three hats and a frame for the kill-cam photo. */
  higherTokens: 1_000_000,
  readFrom: 'https://forehead.prixagent.com/api/token/status',
  readOn: '2026-10-14',
} as const;

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

/** 5 becomes "five". Numbers above ten stay figures: 28 becomes "28". */
export function inWords(value: number): string {
  return WORDS[value] ?? String(value);
}

/** Basis points as a percentage with no more decimals than it needs: 10 becomes "0.1%", 4000 becomes "40%". */
export function percentOf(bps: number): string {
  return `${Number((bps / 100).toFixed(2))}%`;
}

/** 10000 becomes "10,000". */
export function grouped(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** A UTC hour as a time: 15 becomes "15:00 UTC". */
export function hourUtc(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00 UTC`;
}

/** Seconds as whole hours in words or figures: 10800 becomes "three hours", 90000 becomes "25 hours". */
export function hoursOf(seconds: number): string {
  const hours = seconds / 3_600;
  return `${inWords(hours)} ${hours === 1 ? 'hour' : 'hours'}`;
}

/** Seconds as whole minutes in words or figures: 300 becomes "five minutes". */
export function minutesOf(seconds: number): string {
  const minutes = seconds / 60;
  return `${inWords(minutes)} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Holds<T extends true> = T;

/** Fails to compile when a literal constant of the contract no longer equals the fact above. */
export type FactsMatchContract = [
  Holds<Same<typeof facts.scoringMethod, typeof SCORING_METHOD>>,
  // UNIVERSE_SIZE is a sum, so its type is `number`; tests/unit/facts.test.ts holds `universeSize` to it.
  Holds<Same<typeof universeFacts.stockSize, typeof STOCK_UNIVERSE_SIZE>>,
  Holds<Same<typeof universeFacts.cryptoSize, typeof CRYPTO_UNIVERSE_SIZE>>,
  Holds<Same<typeof facts.maxWeightBps, typeof MAX_WEIGHT_BPS>>,
  Holds<Same<typeof facts.feeBps, typeof FEE_BPS>>,
  Holds<Same<typeof facts.slippageBps, typeof SLIPPAGE_BPS>>,
  Holds<Same<typeof facts.minTradeBps, typeof MIN_TRADE_BPS>>,
  Holds<Same<typeof facts.maxHaltedFeeds, typeof MAX_HALTED_FEEDS>>,
  Holds<Same<typeof facts.feedStaleAfterSeconds, typeof FEED_STALE_AFTER_SECONDS>>,
  Holds<Same<typeof cryptoFeedFacts.staleAfterSeconds, typeof CRYPTO_FEED_STALE_AFTER_SECONDS>>,
  Holds<Same<typeof cryptoFeedFacts.staleAfterSecondsBySymbol, typeof CRYPTO_FEED_STALE_AFTER_SECONDS_BY_SYMBOL>>,
  Holds<Same<typeof chainFacts.main.chainId, typeof CHAIN_ID>>,
  Holds<Same<typeof chainFacts.second.chainId, typeof ARBITRUM_CHAIN_ID>>,
  Holds<Same<typeof chainFacts.second.sequencerGraceSeconds, typeof ARBITRUM_SEQUENCER_GRACE_SECONDS>>,
  Holds<Same<typeof facts.marketQuietAfterSeconds, typeof MARKET_QUIET_AFTER_SECONDS>>,
  Holds<Same<typeof facts.suspectMoveBps, typeof SUSPECT_MOVE_BPS>>,
  Holds<Same<typeof facts.minPriceMicro, typeof MIN_PRICE_MICRO>>,
  Holds<Same<typeof facts.seasonLengthDays, typeof SEASON_LENGTH_DAYS>>,
  Holds<Same<typeof facts.tickFirstHourUtc, typeof TICK_FIRST_HOUR_UTC>>,
  Holds<Same<typeof facts.tickLastHourUtc, typeof TICK_LAST_HOUR_UTC>>,
  Holds<Same<typeof facts.openDailyTickHourUtc, typeof OPEN_DAILY_TICK_HOUR_UTC>>,
  Holds<Same<typeof facts.tickCreateWindowMinutes, typeof TICK_CREATE_WINDOW_MINUTES>>,
  Holds<Same<typeof facts.tickWindowMinutes, typeof TICK_WINDOW_MINUTES>>,
  Holds<Same<typeof facts.minTradingDaysToRank, typeof MIN_TRADING_DAYS_TO_RANK>>,
  Holds<Same<typeof facts.minDecisionsToRank, typeof MIN_DECISIONS_TO_RANK>>,
  Holds<Same<typeof facts.maxAgentsOpen, typeof MAX_AGENTS_OPEN>>,
  Holds<Same<typeof facts.maxAgentsPro, typeof MAX_AGENTS_PRO>>,
  Holds<Same<typeof facts.maxModelKeysPerWallet, typeof MAX_MODEL_KEYS_PER_WALLET>>,
  Holds<Same<typeof facts.maxPromptChangesPerDay, typeof MAX_PROMPT_CHANGES_PER_DAY>>,
  Holds<Same<typeof facts.keyFailuresToPause, typeof KEY_FAILURES_TO_PAUSE>>,
  Holds<Same<typeof facts.agentNameMin, typeof AGENT_NAME_MIN>>,
  Holds<Same<typeof facts.agentNameMax, typeof AGENT_NAME_MAX>>,
  Holds<Same<typeof facts.promptMin, typeof PROMPT_MIN>>,
  Holds<Same<typeof facts.promptMax, typeof PROMPT_MAX>>,
  Holds<Same<typeof facts.reasonMax, typeof REASON_MAX>>,
  Holds<Same<typeof facts.summaryMax, typeof SUMMARY_MAX>>,
];
