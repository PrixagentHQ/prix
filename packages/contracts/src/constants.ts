/**
 * Product constants. Each one is a product decision: changing a value changes
 * the product, so only the operator edits this file. docs/CONTRACTS.md explains them.
 */

export const CHAIN_ID = 4663;

/** One USD is 1,000,000 micro-USD. One share is 1,000,000 micro-shares. */
export const MICRO = 1_000_000;
/** One hundred percent is 10,000 basis points. */
export const BPS = 10_000;

/** Every agent starts each season with 10,000 virtual USD. */
export const STARTING_CASH_MICRO = 10_000 * MICRO;
/** At most 40% of the portfolio in one name. */
export const MAX_WEIGHT_BPS = 4_000;
/** Fee charged on the notional of every fill. */
export const FEE_BPS = 10;
/** Slippage charged on the notional of every fill. */
export const SLIPPAGE_BPS = 10;
/** A change smaller than this share of the portfolio is not traded. */
export const MIN_TRADE_BPS = 50;

/**
 * A feed answer below one cent is treated as invalid. It also keeps the arithmetic safe:
 * with prices of at least one cent and a portfolio below 90 million USD, every micro-share
 * count stays a safe integer.
 */
export const MIN_PRICE_MICRO = 10_000;

/** The league trades this many Stock Tokens. */
export const STOCK_UNIVERSE_SIZE = 20;
/** And this many crypto assets (section 21: ETH and BTC, with their feeds on Robinhood Chain). */
export const CRYPTO_UNIVERSE_SIZE = 2;
/** Every symbol of the universe, plus cash. */
export const UNIVERSE_SIZE = STOCK_UNIVERSE_SIZE + CRYPTO_UNIVERSE_SIZE;
/**
 * The market is open while at most this many Stock Token feeds are stale. A stale symbol is halted
 * for the tick. A crypto symbol never counts here: a crypto feed that is stale, invalid or unread
 * halts its own symbol and never closes the market (section 21).
 */
export const MAX_HALTED_FEEDS = 2;

/**
 * The Stock Token feeds publish on a 0.5% move or on a 24 hour heartbeat. A feed older than the
 * heartbeat plus one hour has missed a heartbeat in an open market, and its symbol is halted.
 */
export const FEED_STALE_AFTER_SECONDS = 90_000;
/**
 * The crypto feeds of section 21 publish on a 0.5% move or on a 24 hour heartbeat too, every day of
 * the week. Its own constant, so it can tighten once their real gaps are measured.
 */
export const CRYPTO_FEED_STALE_AFTER_SECONDS = 90_000;
/**
 * The market is closed when no Stock Token feed has published for this long. Measured on the chain:
 * on trading days the newest update is at most about two hours old, and during a closure it is at
 * least about thirteen hours old. Crypto feeds publish around the clock, so they never count here.
 */
export const MARKET_QUIET_AFTER_SECONDS = 10_800;
/**
 * A price that moved more than this since the last tick is held for review instead of used.
 * It guards against a bad feed value. A stock split does not move these prices: a feed gives
 * the share price times the token's multiplier.
 */
export const SUSPECT_MOVE_BPS = 3_000;

export const SEASON_LENGTH_DAYS = 28;
/**
 * Ticks are created only for UTC hours in this range. The feeds publish around the clock on
 * weekdays, but 15:00 to 19:00 UTC is the part of the regular US session that holds all
 * year, summer and winter, and reference prices are at their best in the regular session.
 */
export const TICK_FIRST_HOUR_UTC = 15;
export const TICK_LAST_HOUR_UTC = 19;
/** Open-division agents decide at the first tick at or after this UTC hour on each trading day. */
export const OPEN_DAILY_TICK_HOUR_UTC = 15;
/** A tick is created only in the first minutes of its hour. */
export const TICK_CREATE_WINDOW_MINUTES = 10;
/** Agents that a Pro tick has not reached after this many minutes are skipped. */
export const TICK_WINDOW_MINUTES = 50;

/** The house model stops for the day when the counted neurons reach this. The free allocation is 10,000. */
export const HOUSE_NEURONS_PER_DAY = 9_000;

/** Of that, the most that strategy summaries may use in a day. Decisions come first. */
export const HOUSE_SUMMARY_NEURONS_PER_DAY = 500;
/** Output tokens allowed for the house model. */
export const HOUSE_MAX_OUTPUT_TOKENS = 300;
/** Output tokens allowed for an owner's model, which may spend some of them reasoning. */
export const OWN_MAX_OUTPUT_TOKENS = 2_000;

/**
 * How many agents a division takes in Phase 1. Sized so that a daily round ends inside its
 * hour: 50 Pro and 200 Open agents at five model calls a minute take 50 minutes.
 */
export const MAX_AGENTS_OPEN = 200;
export const MAX_AGENTS_PRO = 50;
/** A Pro agent is paused after this many rows in a row in which its key or model was refused. */
export const KEY_FAILURES_TO_PAUSE = 3;

export const SCORING_METHOD = 'v1';
/** Rows on one page of a league table. */
export const LEAGUE_PAGE_SIZE = 100;
/** The last page a league can have while a division holds at most MAX_AGENTS_OPEN agents. */
export const LEAGUE_MAX_PAGE = 2;
export const MIN_TRADING_DAYS_TO_RANK = 5;
export const MIN_DECISIONS_TO_RANK = 3;

export const AGENT_NAME_MIN = 3;
export const AGENT_NAME_MAX = 32;
export const PROMPT_MIN = 20;
export const PROMPT_MAX = 2_000;
/** A prompt is also capped in UTF-8 bytes, because a model is billed by tokens, not characters. */
export const PROMPT_MAX_BYTES = 4_000;
/** A strategy may be changed this many times in one UTC day. */
export const MAX_PROMPT_CHANGES_PER_DAY = 3;
export const MAX_MODEL_KEYS_PER_WALLET = 3;
/** A request body larger than this is refused before it is parsed. */
export const MAX_BODY_BYTES = 16_384;

/**
 * The most rows the HTTP API may write to the database in one UTC day, all wallets together.
 * The free plan allows 100,000 a day for everything; the scheduler needs most of them, and it
 * is not subject to this budget. When it is spent, sign-in and edits answer `daily_limit`
 * until 00:00 UTC and the league goes on.
 */
export const API_WRITE_ROWS_PER_DAY = 40_000;
/** The most state-changing requests one wallet may make in one UTC day. */
export const WALLET_WRITES_PER_DAY = 60;
export const REASON_MAX = 240;
export const SUMMARY_MAX = 280;
export const MODEL_NAME_MAX = 80;
export const API_KEY_MIN = 16;
export const API_KEY_MAX = 300;

export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
export const NONCE_TTL_SECONDS = 5 * 60;
/** The `__Host-` prefix makes a browser refuse the cookie unless it is Secure, has Path=/ and names no Domain. */
export const SESSION_COOKIE = '__Host-prix_session';

/** Agent names that nobody may take, compared in lower case. */
export const RESERVED_AGENT_NAMES: readonly string[] = [
  'prix',
  'prix official',
  'official',
  'admin',
  'administrator',
  'moderator',
  'support',
  'system',
  'house',
  'house model',
  'robinhood',
  'chainlink',
  'pons',
  'king',
];

/**
 * The sentence a wallet shows when someone signs in. The server puts it in the nonce
 * response and checks the signed message against it word for word.
 */
export const SIWE_STATEMENT =
  'Sign in to Prix. This proves you own this wallet. It sends no transaction and costs no gas.';
