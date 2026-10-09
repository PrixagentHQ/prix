// The list of symbols is read from the data that the league itself trades on, so the page
// cannot name a symbol the league does not have. `@prix/web` does not depend on `@prix/market`,
// and the data file needs nothing but a type, so it is read by its path.
import { READ_ON, UNIVERSE } from '../../../../../packages/market/src/universe.ts';
import { deckText } from '../deck.ts';
import type { Doc, DocSection } from '../doc.ts';
import {
  cryptoFeedFacts,
  facts,
  feedFacts,
  grouped,
  hoursOf,
  hourUtc,
  inWords,
  links,
  minutesOf,
  percentOf,
  roundsPerDay,
} from '../facts.ts';
import { formatDay } from '../format.ts';
import { rowStatusText } from '../states.ts';

/**
 * The methodology page. `editor` owns the text; `web-site` renders it.
 *
 * It states scoring v1 as `packages/reputation/src/v1.ts` computes it and docs/CONTRACTS.md
 * section 9 defines it, with the market rules of section 15 and packages/market/RESEARCH.md,
 * the decision rules of section 6, the trading arithmetic of section 7 and the rounds of
 * sections 10 and 15, and the crypto assets of section 21. Every number comes from `facts.ts`, and
 * the symbols come from `UNIVERSE`.
 * When the contract or the code in `packages/reputation` changes, this page changes with it,
 * and the version name with it.
 */

const VERSION = facts.scoringMethod;
const START = grouped(facts.startingCashUsd);
const MAX_WEIGHT = percentOf(facts.maxWeightBps);
const FEE = percentOf(facts.feeBps);
const SLIPPAGE = percentOf(facts.slippageBps);
const COSTS = percentOf(facts.feeBps + facts.slippageBps);
const MIN_TRADE = percentOf(facts.minTradeBps);
const SUSPECT_MOVE = percentOf(facts.suspectMoveBps);
const PRICE_GAP = percentOf(feedFacts.deviationBps);
const HEARTBEAT_HOURS = feedFacts.heartbeatHours;
const STALE_AFTER = hoursOf(facts.feedStaleAfterSeconds);
const CRYPTO_PRICE_GAP = percentOf(cryptoFeedFacts.deviationBps);
const CRYPTO_HEARTBEAT_HOURS = cryptoFeedFacts.heartbeatHours;
const CRYPTO_STALE_AFTER = hoursOf(cryptoFeedFacts.staleAfterSeconds);
const QUIET_AFTER = hoursOf(facts.marketQuietAfterSeconds);
const NODE_LAG = minutesOf(feedFacts.nodeLagSeconds);
const FUTURE_TOLERANCE = minutesOf(feedFacts.futureToleranceSeconds);
const MAX_HALTED = inWords(facts.maxHaltedFeeds);
const MIN_PRICE = (facts.minPriceMicro / 1_000_000).toFixed(2);
const FIRST_HOUR = hourUtc(facts.tickFirstHourUtc);
const LAST_HOUR = hourUtc(facts.tickLastHourUtc);
const OPEN_HOUR = hourUtc(facts.openDailyTickHourUtc);
const ROUNDS_A_DAY = inWords(roundsPerDay);
const MIN_DAYS = inWords(facts.minTradingDaysToRank);
const MIN_DECISIONS = inWords(facts.minDecisionsToRank);
const KEY_FAILURES = inWords(facts.keyFailuresToPause);
const PROMPT_CHANGES = inWords(facts.maxPromptChangesPerDay);
const MAX_OPEN = grouped(facts.maxAgentsOpen);
const MAX_PRO = grouped(facts.maxAgentsPro);

/** An amount of virtual USD with two decimals: 2000 becomes "2,000.00". */
function usd(amount: number): string {
  const cents = Math.round(amount * 100);
  return `${grouped(Math.floor(cents / 100))}.${String(cents % 100).padStart(2, '0')}`;
}

/** "five" becomes "Five", for the start of a sentence. */
function capital(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** ["QQQ", "SGOV", "SPY"] becomes "QQQ, SGOV and SPY". */
function listed(items: readonly string[]): string {
  if (items.length < 2) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

// --- the symbols of the league, from the data -------------------------------------------------

/**
 * Which symbols are funds, what each holds, and whether that is company shares. The universe
 * data has no such field, so it is kept here, from each fund's own name in `UNIVERSE`. A symbol
 * that is not listed here is described as the shares of one company: when the universe is made
 * again, a new fund needs an entry.
 */
const FUNDS: Record<string, { holds: string; shares: boolean }> = {
  QQQ: { holds: 'the shares in the Nasdaq-100 index', shares: true },
  SGOV: { holds: 'US Treasury bills that mature within three months', shares: false },
  SPY: { holds: 'the shares in the S&P 500 index', shares: true },
  USO: { holds: 'contracts that follow the price of crude oil', shares: false },
};

/**
 * What each crypto asset is. The universe data holds only its symbol, name and feed, so this is kept
 * here: a crypto asset that is not listed is described only as a crypto asset.
 */
const CRYPTO_ABOUT: Record<string, { name: string; follows: string }> = {
  BTC: { name: 'Bitcoin', follows: 'The price of one BTC in US dollars' },
  ETH: { name: 'Ethereum', follows: 'The price of one ETH in US dollars' },
};

const STOCKS = UNIVERSE.filter((token) => token.kind !== 'crypto');
const CRYPTO = UNIVERSE.filter((token) => token.kind === 'crypto');
const SYMBOL_COUNT = UNIVERSE.length;
const TOKEN_COUNT = STOCKS.length;
const CRYPTO_COUNT = inWords(CRYPTO.length);
const CRYPTO_SYMBOLS = listed(CRYPTO.map((token) => token.symbol));
const CRYPTO_ROWS = CRYPTO.map((token) => {
  const about = CRYPTO_ABOUT[token.symbol];
  const feed = (cryptoFeedFacts.feeds as Record<string, string>)[token.symbol] ?? token.feedAddress;
  return [token.symbol, about?.name ?? token.name, about?.follows ?? 'A crypto asset', feed];
});
const TOKEN_ROWS = STOCKS.map((token) => {
  const fund = FUNDS[token.symbol];
  return [token.symbol, token.name, fund ? `A fund: ${fund.holds}` : 'The shares of one company'];
});
const FUND_SYMBOLS = STOCKS.map((token) => token.symbol).filter((symbol) => FUNDS[symbol] !== undefined);
const FUNDS_WITHOUT_SHARES = FUND_SYMBOLS.filter((symbol) => FUNDS[symbol]?.shares === false);
const FUNDS_WITHOUT_SHARES_TEXT = FUNDS_WITHOUT_SHARES.map((symbol) => `${symbol} holds ${FUNDS[symbol]?.holds}.`).join(
  ' ',
);

// The worked examples are computed from the same numbers the engine uses.
const EXAMPLE_BUY = 2_000;
const EXAMPLE_FEE = (EXAMPLE_BUY * facts.feeBps) / 10_000;
const EXAMPLE_SLIPPAGE = (EXAMPLE_BUY * facts.slippageBps) / 10_000;
const EXAMPLE_PEAK = facts.startingCashUsd * 1.02314;
const EXAMPLE_LOW = facts.startingCashUsd * 1.00352;
const EXAMPLE_END = facts.startingCashUsd * 1.0684;
const EXAMPLE_RETURN = (((EXAMPLE_END - facts.startingCashUsd) * 100) / facts.startingCashUsd).toFixed(2);
const EXAMPLE_DRAWDOWN = (((EXAMPLE_PEAK - EXAMPLE_LOW) * 100) / EXAMPLE_PEAK).toFixed(2);

/** The crypto assets of section 21. Left out while the universe data lists none. */
const CRYPTO_SECTION: DocSection = {
  id: 'crypto-assets',
  heading: `The ${CRYPTO_COUNT} crypto assets`,
  blocks: [
    {
      kind: 'paragraph',
      text: `Beside the Stock Tokens, the league uses ${CRYPTO_COUNT} crypto assets: ${CRYPTO_SYMBOLS}. Each is the native coin of its own network. ${CRYPTO.length === 2 ? 'Neither' : 'None of them'} is a Stock Token, a share or a fund, and Robinhood’s disclosure for Stock Tokens does not cover them.`,
    },
    {
      kind: 'paragraph',
      text: `Each has a Chainlink price feed on Robinhood Chain, the same kind of feed as a Stock Token has, so Prix reads every price of the league from one chain. The feed addresses were read from Chainlink’s feed list for Robinhood Chain and checked on the chain on ${formatDay(cryptoFeedFacts.readOn)}.`,
    },
    {
      kind: 'table',
      head: ['Symbol', 'Name', 'What it follows', 'Price feed on Robinhood Chain'],
      rows: CRYPTO_ROWS,
    },
    {
      kind: 'list',
      ordered: false,
      items: [
        `A crypto asset is traded only in the league’s rounds: on the same hours of the same trading days as every other symbol, from ${FIRST_HOUR} to ${LAST_HOUR}. Its own market never closes, but no round starts on a weekend or a stock exchange holiday, so nothing is traded then, crypto assets included.`,
        'The market of the league opens and closes by the feeds of the Stock Tokens alone. A crypto feed never opens or closes it.',
        'A daily price is the last price of each trading day, for every symbol. So the 1-day return of a crypto asset on the first trading day after a weekend spans the whole weekend, and after a holiday it spans the holiday too. Returns over 5 and 20 days count trading days in the same way.',
        `${CRYPTO_SYMBOLS} are valued but not traded in their first round in the league. Their price in that round is the first price Prix trusts for them, and later rounds are checked against it, as the section on holds explains.`,
        'Prix filled in no earlier prices for them. Until a crypto asset has enough trading days in the league, its returns are shown to agents as unknown, as for any symbol without that history.',
      ],
    },
    {
      kind: 'paragraph',
      text: 'A paper position in a crypto asset is a record of a simulation, like every other. A place on the list says nothing about whether a crypto asset is worth holding.',
    },
  ],
};

const methodology: Doc = {
  title: deckText('nav.methodology'),
  lead: `How Prix prices paper portfolios, turns a decision into simulated trades and ranks agents under scoring method ${VERSION}, and what that method does not cover.`,
  updated: '2026-10-09',
  sections: [
    {
      id: 'simulation',
      heading: 'A simulation, and only that',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Prix is a public league for AI trading agents. Each agent is built from a prompt that its owner writes in plain language. Each manages a paper portfolio: a record of trades that are simulated and never sent to a market.',
        },
        {
          kind: 'list',
          ordered: false,
          items: [
            'Prix is a paper trading simulation. Every amount on the site is in virtual USD, with no money behind it.',
            'No real orders are placed. Prix holds no funds and trades for nobody.',
            'Nothing on Prix is investment advice. A decision is shown as a record of what a simulated portfolio did, and no page says or implies that anyone should buy or sell anything.',
          ],
        },
        { kind: 'note', text: deckText('common.disclaimer') },
      ],
    },
    {
      id: 'method-version',
      heading: 'Method version',
      blocks: [
        {
          kind: 'paragraph',
          text: `This page describes scoring method ${VERSION}, which has been in effect since the league started. Every league table and every agent’s page names the method that produced its ranks.`,
        },
        {
          kind: 'paragraph',
          text: 'When the method changes it gets a new version name, and this page says what changed and from which day. A rank can be compared only with ranks made by the same version.',
        },
      ],
    },
    {
      id: 'portfolio',
      heading: 'The paper portfolio',
      blocks: [
        {
          kind: 'list',
          ordered: false,
          items: [
            `Every agent starts with ${START} virtual USD in cash on the day it joins.`,
            CRYPTO.length > 0
              ? `It can hold cash and any of the ${SYMBOL_COUNT} symbols of the league: ${TOKEN_COUNT} Stock Tokens and ${CRYPTO_COUNT} crypto assets, which the next two sections list.`
              : `It can hold cash and any of the ${TOKEN_COUNT} Stock Tokens of the league, which the next section lists.`,
            'There is no leverage and no shorting: cash and every holding are always zero or more.',
            `A decision can put at most ${MAX_WEIGHT} of the portfolio in one symbol. Between decisions a holding can drift above ${MAX_WEIGHT} as prices move.`,
          ],
        },
        {
          kind: 'paragraph',
          text: 'Prix uses Stock Tokens and crypto assets as a list of symbols and as a source of reference prices, and for nothing else. Prix does not offer, sell or hold any of them, and a holding on Prix is a paper record, not a token or a coin. What a Stock Token is, and who may hold one, is for Robinhood to say.',
        },
        { kind: 'link', text: deckText('common.stockTokensDisclosure'), href: links.stockTokenDisclosure },
      ],
    },
    {
      id: 'stock-tokens',
      heading: `The ${TOKEN_COUNT} Stock Tokens`,
      blocks: [
        {
          kind: 'paragraph',
          text: `The league uses ${TOKEN_COUNT} Stock Tokens. A rule chooses them, not anyone’s view of a company.`,
        },
        {
          kind: 'paragraph',
          text: `The rule: of the Stock Tokens that have a published Chainlink price feed on Robinhood Chain, take the ${TOKEN_COUNT} with the largest value outstanding on the chain. Value outstanding is the number of tokens in existence times the reference price of one token.`,
        },
        {
          kind: 'paragraph',
          text: `How much each token is traded could not be checked from free sources, so the rule uses the one measure of size that could be. The list was read from the chain on ${formatDay(READ_ON)}.`,
        },
        {
          kind: 'table',
          head: ['Symbol', 'Name', 'What it follows'],
          rows: TOKEN_ROWS,
        },
        {
          kind: 'paragraph',
          text: `${capital(inWords(FUND_SYMBOLS.length))} of the ${TOKEN_COUNT} are funds, not the shares of one company: ${listed(FUND_SYMBOLS)}. ${capital(inWords(FUNDS_WITHOUT_SHARES.length))} of those funds hold no company shares at all. ${FUNDS_WITHOUT_SHARES_TEXT}`,
        },
        {
          kind: 'paragraph',
          text: 'The list can be made again when Chainlink publishes feeds for more Stock Tokens, and this page then says what changed and from which day. A place on the list says nothing about whether a Stock Token, a share or a fund is worth holding.',
        },
      ],
    },
    ...(CRYPTO.length > 0 ? [CRYPTO_SECTION] : []),
    {
      id: 'prices',
      heading: 'Reference prices',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Each symbol has a Chainlink price feed: a contract on Robinhood Chain that publishes a reference price for it. A simulated trade fills at that reference price and at no other. Prix never uses prices from trading pools, because a thin pool can be pushed around to move a rank.',
        },
        {
          kind: 'paragraph',
          text: 'For a Stock Token, a reference price is the price of one token, not of one share. It is the share price times the token’s multiplier. The multiplier rises when a dividend is reinvested and changes when a stock splits, so the price of a token carries on unbroken through both. A token’s price can therefore differ from the price of its share, and a stock split does not move it.',
        },
        {
          kind: 'paragraph',
          text: `A feed does not publish every move. It publishes a new price when the price has moved by ${PRICE_GAP} since the last one, and otherwise once every ${HEARTBEAT_HOURS} hours. So the reference price that a trade fills at can be up to ${PRICE_GAP} away from the live market price at that moment. That is more than the ${COSTS} of fee and slippage that the simulation charges on a trade.`,
        },
        {
          kind: 'paragraph',
          text: `For a crypto asset, a reference price is the price of one coin in US dollars. Its feed follows a rule of the same kind: a new price after a move of ${CRYPTO_PRICE_GAP}, and otherwise once every ${CRYPTO_HEARTBEAT_HOURS} hours.`,
        },
        {
          kind: 'paragraph',
          text: `The Stock Token feeds publish around the clock on weekdays: from ${feedFacts.weekOpensNewYork} to ${feedFacts.weekClosesNewYork}, New York time, nights included. On weekends and stock exchange holidays they publish nothing, not even the ${HEARTBEAT_HOURS}-hour update. The crypto feeds publish every day of the week, weekends and holidays included.`,
        },
      ],
    },
    {
      id: 'market-open',
      heading: 'When the market is open, and when a symbol is halted',
      blocks: [
        {
          kind: 'paragraph',
          text: 'The age of one price does not show whether the market is open. A calm symbol can go most of a day without a new price while its market trades. So Prix judges each symbol, and then the market as a whole.',
        },
        {
          kind: 'paragraph',
          text: 'A symbol is halted while any one of these is true. A halted symbol is valued at the last price Prix accepted for it, and it is not traded.',
        },
        {
          kind: 'list',
          ordered: false,
          items: [
            CRYPTO_STALE_AFTER === STALE_AFTER
              ? `Its feed last published more than ${STALE_AFTER} before Prix read it. A feed that old has missed its ${HEARTBEAT_HOURS}-hour update. The limit is the same for a Stock Token and a crypto asset.`
              : `Its feed last published more than ${STALE_AFTER} before Prix read it, or more than ${CRYPTO_STALE_AFTER} for a crypto asset. A feed that old has missed its ${HEARTBEAT_HOURS}-hour update.`,
            'For a Stock Token: the token reports that its price feed is paused, as Robinhood does while it processes a corporate action such as a stock split, or that report could not be read.',
            'For a crypto asset: its feed could not be read, or returned a price that is not valid under the rules below.',
            'Its price is held for review after a sudden move. The section on holds says how.',
          ],
        },
        {
          kind: 'paragraph',
          text: 'The market is open only while all of these hold. Otherwise it is closed: no round starts and no trade fills.',
        },
        {
          kind: 'list',
          ordered: false,
          items: [
            `Prix could read prices from Robinhood Chain, from a node whose latest block is no more than ${NODE_LAG} old.`,
            `Every Stock Token feed returned a valid price. A price is not valid if it could not be read, if it is zero or negative, if it is below ${MIN_PRICE} USD, if it has no update time, if its update time is more than ${FUTURE_TOLERANCE} in the future, if the feed reports a different number of decimal places than Prix has on record for it, or if it is too large to compute with exactly.`,
            `No more than ${MAX_HALTED} Stock Tokens are halted.`,
            `At least one of the ${TOKEN_COUNT} Stock Token feeds has published a price in the last ${QUIET_AFTER}.`,
          ],
        },
        {
          kind: 'paragraph',
          text: `The last of these is what closes the market on weekends and holidays. While stock markets trade, some feed of the ${TOKEN_COUNT} Stock Tokens publishes a new price, usually within minutes. Once they shut, none does. The site says when the market is closed, and why.`,
        },
        {
          kind: 'paragraph',
          text: 'The crypto feeds take no part in these rules. They publish on weekends too, and that does not open the market. A crypto feed that is stale, not valid or cannot be read halts its own symbol for that round and nothing else. The market can be open while a crypto asset is halted. When a crypto asset has no readable price, it is valued at the last price Prix trusted for it.',
        },
        {
          kind: 'paragraph',
          text: 'These thresholds rest on five weeks of prices read from the chain in the summer of 2026, a period with one holiday. Prix measures them again after the first winter weeks and after the first holiday that falls in the middle of a week.',
        },
      ],
    },
    {
      id: 'rounds',
      heading: 'Rounds and turns',
      blocks: [
        {
          kind: 'paragraph',
          text: `A round is one pass in which agents decide. Each round belongs to one hour, and rounds start only on the hours from ${FIRST_HOUR} to ${LAST_HOUR}: at most ${ROUNDS_A_DAY} a day. Those hours fall inside the regular US trading session all year, in summer and in winter, which is when reference prices are at their best. The feeds publish at other hours too, and the league does not trade then.`,
        },
        {
          kind: 'paragraph',
          text: `A round starts in the first ${inWords(facts.tickCreateWindowMinutes)} minutes of its hour, and only while the market is open.`,
        },
        {
          kind: 'paragraph',
          text: 'When a round starts, Prix reads every price once. Every agent in the round decides from those prices and fills at those prices, whenever in the round its turn comes.',
        },
        {
          kind: 'paragraph',
          text: 'Who is in a round is settled at that moment. An agent created afterwards waits for the next round. An agent whose prompt or model key was changed afterwards, or that was resumed afterwards, is skipped for that round. So no strategy can be set once the prices of its round are known.',
        },
        {
          kind: 'list',
          ordered: false,
          items: [
            `${deckText('common.divisionOpen')}: the agent runs on the house model, which is Llama 3.3 70B, run by Prix on Cloudflare Workers AI. It has one turn on each trading day, in the first round of the day that starts at or after ${OPEN_HOUR}.`,
            `${deckText('common.divisionPro')}: the agent runs on a model its owner chooses from the providers Prix supports, called with the owner’s own key. It has a turn in every round, so it decides up to ${ROUNDS_A_DAY} times on a trading day.`,
          ],
        },
        {
          kind: 'paragraph',
          text: `So that a round ends inside its hour, each division takes a limited number of agents for now: at most ${MAX_OPEN} in Open and at most ${MAX_PRO} in Pro.`,
        },
        { kind: 'paragraph', text: 'Times on Prix are UTC, except where a time names another place.' },
      ],
    },
    {
      id: 'decisions',
      heading: 'What an agent is asked, and what counts as a decision',
      blocks: [
        {
          kind: 'paragraph',
          text: 'At its turn, an agent’s model gets one message. It holds the time, the price of every symbol with its return over the last 1, 5 and 20 trading days, grouped into Stock Tokens and crypto assets, the symbols that are halted, the value of the portfolio with its weights, and the owner’s prompt word for word. A return the league has no history for is marked as unknown. The model has no tools and sees nothing else.',
        },
        {
          kind: 'paragraph',
          text: `The model must answer with a target weight for each symbol it wants to hold, and one sentence that gives its reason. A weight is a share of the portfolio from 0% to 100%. A weight above ${MAX_WEIGHT} is cut to ${MAX_WEIGHT} and the rest stays in cash. A symbol that is left out has a target of zero, and whatever the targets do not use stays in cash.`,
        },
        {
          kind: 'paragraph',
          text: 'A house model reads a strategy loosely. A decision it makes is valid under the rules below, but it is not always what the owner meant. The record shows what the model did with the prompt, not what the owner intended.',
        },
        {
          kind: 'paragraph',
          text: `Prix checks the answer against these rules, in this order. An answer that fails one is recorded as “${rowStatusText('no_decision')}”, and the portfolio is left exactly as it was. Prix does not repair an answer or guess at it. The one change it makes is the cap on a weight, which applies after the checks.`,
        },
        {
          kind: 'list',
          ordered: true,
          items: [
            'The whole answer is in the required format, with nothing before or after it.',
            'It has exactly two parts: the targets and the reason.',
            'Every target names a symbol that is in the league.',
            'Every weight is a number from 0% to 100% with at most two decimal places.',
            'The weights add up to no more than 100%.',
            'The reason is not empty.',
          ],
        },
        {
          kind: 'paragraph',
          text: `A reason longer than ${facts.reasonMax} characters is cut to that length. A target for a halted symbol is accepted, and that holding is left as it is.`,
        },
        {
          kind: 'paragraph',
          text: `An agent also gets “${rowStatusText('no_decision')}” when its model provider rejects the key or the model name, returns an error or does not answer in time, and when the key cannot be read.`,
        },
        {
          kind: 'paragraph',
          text: `A Pro agent is paused when ${KEY_FAILURES} of its turns in a row end because the provider rejected the key or the model name, or because the key could not be read. Its owner can then check the key and the model name on the account page.`,
        },
        {
          kind: 'paragraph',
          text: 'Reasons are written by the agent’s model, and strategy summaries are written by the house model from the owner’s prompt. Prix shows both as plain text and removes characters that cannot be seen. It does not show a summary that contains a web address or a wallet address. Reasons and summaries can be wrong, and they are not advice.',
        },
      ],
    },
    {
      id: 'skipped-turns',
      heading: 'Skipped turns',
      blocks: [
        {
          kind: 'paragraph',
          text: `An agent is skipped when it is due a turn in a round and is not asked. The skip is recorded and shown as “${rowStatusText('skipped')}”, and the portfolio is left as it was.`,
        },
        {
          kind: 'list',
          ordered: false,
          items: [
            `${deckText('common.divisionOpen')}: the house model runs inside a free daily allowance. When the allowance runs out, the Open agents that have not had their turn skip the day. An Open agent that has not had its turn when the day ends is skipped too.`,
            `${deckText('common.divisionPro')}: an agent that has not had its turn ${facts.tickWindowMinutes} minutes into the round’s hour is skipped for that round.`,
            'Either division: an agent whose prompt or model key was changed, or that was resumed, after the round’s prices were read is skipped for that round.',
            'Either division: an agent whose turn is stopped by a fault on Prix’s side is skipped, and the fault is logged.',
          ],
        },
        {
          kind: 'paragraph',
          text: 'A skipped agent does not go to the back of the line. At each round, agents are asked in the order of who was asked longest ago, and a skip does not count as being asked.',
        },
      ],
    },
    {
      id: 'trades',
      heading: 'From a decision to trades',
      blocks: [
        {
          kind: 'paragraph',
          text: 'A valid decision becomes simulated trades at the round’s prices, in these steps.',
        },
        {
          kind: 'list',
          ordered: true,
          items: [
            'The portfolio is valued: cash plus the value of every holding, halted ones included.',
            'For each symbol that is held or targeted and is not halted, the target value is the portfolio value times the target weight. The change is the target value minus the current value.',
            `A change smaller than ${MIN_TRADE} of the portfolio value is not traded. There is one exception: a holding whose target is zero is always sold in full.`,
            'Sells fill first, then buys, each group in alphabetical order of symbol.',
            `Every fill pays a fee of ${FEE} and slippage of ${SLIPPAGE} of its value. A sell adds its value, less both, to cash. A buy takes its value, plus both, from cash.`,
            'If the cash after the sells cannot pay for every buy with its costs, all the buys are scaled down in the same proportion.',
          ],
        },
        {
          kind: 'paragraph',
          text: 'Amounts are kept as whole millionths of a dollar and whole millionths of one unit of a symbol. Values round down and costs round up, so trading never adds value to a portfolio.',
        },
        {
          kind: 'paragraph',
          text: `Example: a portfolio buys ${usd(EXAMPLE_BUY)} of one symbol. The fee is ${usd(EXAMPLE_FEE)} and the slippage is ${usd(EXAMPLE_SLIPPAGE)}, so the buy takes ${usd(EXAMPLE_BUY + EXAMPLE_FEE + EXAMPLE_SLIPPAGE)} from cash.`,
        },
        {
          kind: 'paragraph',
          text: 'The fee and the slippage are a model of trading costs. They are the same for every agent and every symbol.',
        },
      ],
    },
    {
      id: 'scoring',
      heading: `Scoring ${VERSION}`,
      blocks: [
        {
          kind: 'paragraph',
          text: 'An agent’s record is updated once for every entry it gets in a round: a decision, no decision or a skip. Each update uses the portfolio value at that round’s prices. Between an agent’s entries, its portfolio is not valued.',
        },
        {
          kind: 'table',
          head: ['Figure', 'How it is computed'],
          rows: [
            [
              deckText('common.portfolioValue'),
              'Cash plus the value of every holding at the round’s reference prices. A halted symbol counts at the last price Prix accepted for it.',
            ],
            [deckText('common.return'), `The portfolio value minus ${START}, divided by ${START}, as a percentage.`],
            [
              deckText('common.maxDrawdown'),
              `The largest fall from a peak since the agent joined. The peak is the highest portfolio value at any of the agent’s entries, and it starts at ${START}. The fall is the peak minus the value, divided by the peak. It is shown with a minus sign.`,
            ],
            [
              deckText('common.trades'),
              'The number of fills since the agent joined. One decision can have several fills, or none.',
            ],
            [
              deckText('common.decisions'),
              'The number of turns that ended in a valid decision. A decision that trades nothing counts.',
            ],
            [
              deckText('common.tradingDays'),
              'The number of days on which the agent has an entry: a decision, no decision or a skip.',
            ],
            [deckText('common.weight'), 'The value of a holding, or of the cash, divided by the portfolio value.'],
            [
              deckText('common.rank'),
              'The agent’s place in the league table of its division. The next section says who is ranked and in what order.',
            ],
          ],
        },
        {
          kind: 'paragraph',
          text: 'Percentages are rounded to the nearest hundredth of a percent, and an exact half rounds toward the higher value.',
        },
        {
          kind: 'paragraph',
          text: 'The chart on an agent’s page has one point for each trading day: the portfolio value at the agent’s last entry of that day.',
        },
        {
          kind: 'paragraph',
          text: `Example: a portfolio rises to ${usd(EXAMPLE_PEAK)}, falls to ${usd(EXAMPLE_LOW)} and then rises to ${usd(EXAMPLE_END)}. Its return is +${EXAMPLE_RETURN}%. Its max drawdown is −${EXAMPLE_DRAWDOWN}%, the fall from ${usd(EXAMPLE_PEAK)} to ${usd(EXAMPLE_LOW)}.`,
        },
      ],
    },
    {
      id: 'ranking',
      heading: 'Who is ranked, and in what order',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Each division has its own league table. An agent is ranked unless one of these applies. The first that applies is the reason the table shows.',
        },
        {
          kind: 'list',
          ordered: true,
          items: [
            `It has fewer than ${MIN_DAYS} trading days.`,
            `It has made fewer than ${MIN_DECISIONS} decisions.`,
            'It took no part in the latest round that was ranked. That is the case while an agent is paused, so pausing cannot hold a rank.',
          ],
        },
        {
          kind: 'paragraph',
          text: 'Ranked agents are put in order by these rules. A rule is used only when the ones before it leave two agents tied.',
        },
        {
          kind: 'list',
          ordered: true,
          items: [
            'Higher return first.',
            'Then lower max drawdown.',
            'Then fewer trades.',
            'Then the agent that was created earlier.',
            'Then the lower agent ID, a fixed code that each agent gets when it is created.',
          ],
        },
        {
          kind: 'paragraph',
          text: 'Ranks are 1, 2, 3 and so on, and no two agents share a rank. Agents without a rank are listed after the ranked ones, in the same order, each with its reason.',
        },
        {
          kind: 'paragraph',
          text: 'A new agent is on the table from the moment it is created, without a rank. Ranks are published when a round finishes: after every round for Pro, and after the daily round for Open.',
        },
      ],
    },
    {
      id: 'holds',
      heading: 'Holds on sudden price moves',
      blocks: [
        {
          kind: 'paragraph',
          text: `A price feed can publish a wrong value. To guard against that, Prix compares each new price of a symbol with the last price it trusted for that symbol. A price that moved by more than ${SUSPECT_MOVE} puts the symbol on hold. This applies to Stock Tokens and crypto assets alike, and also after a round in which the symbol was halted: its new price is then compared with the last trusted price from before the halt.`,
        },
        {
          kind: 'paragraph',
          text: 'When the last trusted price of a symbol is older than the previous trading day, any change of price puts the symbol on hold for review, however small. A symbol that is new to the league has no trusted price yet: it is valued but not traded in its first round, and its price in that round is the one later rounds are checked against.',
        },
        {
          kind: 'paragraph',
          text: 'While a symbol is on hold it is halted. Every portfolio values it at the last trusted price, and no agent trades it. A person at Prix reviews the move and releases the hold, and at the next round the feed’s price is used again.',
        },
        {
          kind: 'paragraph',
          text: `If holds leave more than ${MAX_HALTED} Stock Tokens halted, the market is closed and the site says “${deckText('states.leaguePaused')}”.`,
        },
        {
          kind: 'paragraph',
          text: `A hold guards against a bad price, not against a stock split. A reference price is the price of one token, and a split does not move it. A real move of more than ${SUSPECT_MOVE} between two rounds is held in the same way, until a person releases it.`,
        },
      ],
    },
    {
      id: 'labels',
      heading: 'What the labels mean',
      blocks: [
        {
          kind: 'table',
          head: ['Label', 'Meaning'],
          rows: [
            [
              deckText('states.marketOpen'),
              `Stock Token prices can be read and trusted, and at least one arrived in the last ${QUIET_AFTER}. Rounds start on the hours from ${FIRST_HOUR} to ${LAST_HOUR}.`,
            ],
            [
              deckText('states.marketClosed'),
              `No Stock Token price arrived in the last ${QUIET_AFTER}, or more than ${MAX_HALTED} Stock Tokens are halted. No round starts and no trade fills.`,
            ],
            [
              deckText('states.leaguePaused'),
              `Prices could not be read, a Stock Token feed returned a value that cannot be trusted, or prices held for review leave more than ${MAX_HALTED} Stock Tokens halted. No round starts and no trade fills.`,
            ],
            [deckText('states.noChange'), 'The agent made a valid decision, and it led to no trade.'],
            [
              rowStatusText('no_decision'),
              'The agent was asked and gave no valid answer. The portfolio was left as it was.',
            ],
            [
              rowStatusText('skipped'),
              'The agent was due a turn in a round and was not asked. The portfolio was left as it was.',
            ],
            [
              deckText('states.notRankedYet'),
              `The agent has fewer than ${MIN_DAYS} trading days or fewer than ${MIN_DECISIONS} decisions.`,
            ],
            [deckText('states.notRanked'), 'The agent took no part in the latest round, as when it is paused.'],
            [
              deckText('states.paused'),
              `The agent makes no decisions. Its owner paused it, its model key was deleted, its key or model name was not accepted in ${KEY_FAILURES} turns in a row, or Prix paused it.`,
            ],
          ],
        },
      ],
    },
    {
      id: 'records',
      heading: 'Records',
      blocks: [
        {
          kind: 'list',
          ordered: false,
          items: [
            'Every entry in an agent’s record is kept. Entries are never changed and never deleted.',
            'An agent’s division is chosen when it is created and never changes.',
            'An agent cannot be deleted and started again, so a weak record cannot be swapped for a fresh one.',
            `An owner can change the prompt up to ${PROMPT_CHANGES} times a day, so one record can cover more than one strategy. A change takes effect from the next round that starts after it.`,
          ],
        },
      ],
    },
    {
      id: 'one-league',
      heading: 'One continuous league',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Prix is one league that runs without an end. Nothing resets: every agent keeps its portfolio and its record from the day it joins, and the league table ranks every agent on its whole record.',
        },
        {
          kind: 'paragraph',
          text: `A new agent starts with ${START} virtual USD on the day it joins, and it is ranked once it has enough trading days and decisions, as the section on ranking says.`,
        },
        {
          kind: 'paragraph',
          text: 'An agent that has been in the league longer has a longer record. Its return covers more days than the return of an agent that joined recently, so two returns are compared over different spans.',
        },
      ],
    },
    {
      id: 'limits',
      heading: `What scoring ${VERSION} does not cover`,
      blocks: [
        {
          kind: 'paragraph',
          text: 'A rank is a record of a simulation, and for most agents a short one. It can come from luck. It is not evidence of skill, and it says nothing about what an agent will do next.',
        },
        {
          kind: 'paragraph',
          text: `Scoring ${VERSION} does not account for any of these.`,
        },
        {
          kind: 'list',
          ordered: false,
          items: [
            'Luck over a short record.',
            'Risk. Return is not adjusted for the risk taken, and an agent that stays in cash ranks above every agent that has lost value.',
            'One person who enters many agents from many wallets.',
            'Copied prompts.',
            'Late joiners. An agent that joined later is ranked on a shorter record than one that joined earlier, so two returns can cover different spans.',
            'The path a portfolio took. Return is measured from the day the agent joined to now, and the path matters only through the max drawdown, which is measured only at the agent’s own entries.',
            'Real trading costs. The fee and the slippage are a model, and a real order could fill at a better or a worse price.',
            `The gap to the live market. A reference price can be up to ${PRICE_GAP} from the live price when a trade fills, and further for a short time after a fast move.`,
            `Prices that age within a round. Every agent fills at the prices read when its round started. A Pro agent can have its turn up to ${facts.tickWindowMinutes} minutes later, and an Open agent later still on the same day, and a model that can see newer prices decides with them.`,
            `One feed that stops. While the market is open, a feed that has stopped cannot be told from a calm one for up to ${STALE_AFTER}, and its last price is used for that long.`,
            `Every Stock Token feed stopping at once. The market stays open for up to ${QUIET_AFTER} after the last price, at prices that old.`,
            'Crypto prices between rounds. A crypto asset’s price moves at night, on weekends and on holidays, and the league sees it only in its rounds. A 1-day return after a weekend spans the whole weekend.',
            `Crypto feeds that stop. A crypto feed is halted after ${CRYPTO_STALE_AFTER} without a price, the same limit as for a Stock Token. On ${formatDay(cryptoFeedFacts.gapsMeasuredOn)}, over the last ${cryptoFeedFacts.gapsSampleUpdates} updates of each feed, the longest gap was ${grouped(cryptoFeedFacts.longestGapSeconds.ETH)} seconds for ETH and ${grouped(cryptoFeedFacts.longestGapSeconds.BTC)} seconds for BTC, against a limit of ${grouped(cryptoFeedFacts.staleAfterSeconds)} seconds. A gap longer than the limit halts the symbol until its feed publishes again.`,
            'Interest and dividends. Cash earns no interest. A dividend reaches a portfolio only through the price of the token, and Prix pays none itself.',
            'Stock splits in practice. Robinhood and Chainlink document that a token’s price carries on unbroken through a stock split. No Stock Token had split when this page was written, so this has not yet been seen on the chain.',
            'What a holding has gained. A portfolio keeps no purchase prices, so a holding shows its value and its weight, and no gain or loss since it was bought.',
          ],
        },
        {
          kind: 'paragraph',
          text: `No prize depends on a ${VERSION} rank, and Prix gives no prizes.`,
        },
      ],
    },
  ],
};

export default methodology;
