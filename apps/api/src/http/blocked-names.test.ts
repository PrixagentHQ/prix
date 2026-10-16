import { agentNameSchema } from '@prix/contracts';
import { describe, expect, it } from 'vitest';
import { isBlockedName } from './blocked-names.ts';

// The board is the home page's first screen (D-147), so a name that reads as advice or a promise is
// refused there. Run: pnpm exec vitest run --config apps/api/src/http/vitest.config.ts

describe('isBlockedName: advice and promises', () => {
  it.each([
    'Buy Now',
    'BuyNow Fund',
    'buy-now',
    'Sell Now',
    'SellNow',
    'Sell.Now Bot',
    'Must Buy',
    'mustbuy tech',
    'All In',
    'All-In Tech',
    'AllIn Fund',
    'Allin Momentum',
    'To The Moon',
    'Tothemoon Index',
    'Rocket To The Moon',
    '10x',
    '10x Fund',
    'Fund 10X',
    '100x',
    'Alpha 100x',
    '1000x',
    'The 1000x Club',
  ])('refuses %j', (name) => {
    expect(isBlockedName(name)).toBe(true);
  });
});

describe('isBlockedName: ordinary names still pass', () => {
  it.each([
    'Lighthouse',
    'Momentum Five',
    'Profit Taker',
    'Allen Index',
    'Moonwalk',
    'Small Index',
    'Falling Knife',
    'Tall Index Fund',
    'Russell Nowcast',
    'Ballin Growth',
    'Top 100',
    'Fox 10',
    'Big Tech Equal',
  ])('allows %j', (name) => {
    expect(isBlockedName(name)).toBe(false);
  });
});

describe('isBlockedName: an order or a promise the reviewer found passing (2026-10-14)', () => {
  it.each([
    // (a) buy or sell with "now" anywhere
    'Buy NVDA Now',
    'Buy Tesla Now',
    'Sell Everything Now',
    'Now Buy Value',
    'Sell Growth Right Now',
    'BuyMetaNow',
    // (b) buy or sell next to a symbol of the universe or "everything"
    'Buy NVDA',
    'Sell TSLA',
    'NVDA Buy',
    'buy-googl',
    'BuyETH Fund',
    'Sell Everything',
    'Everything Buy',
    // (c) phrases
    'Strong Buy',
    'StrongSell',
    'Double Your Money',
    'DoubleYourMoney Fund',
    'Sure Profit',
    'Sure Win',
    'Sure-Win Index',
  ])('refuses %j', (name) => {
    expect(isBlockedName(name)).toBe(true);
  });
});

describe('isBlockedName: the product name with look-alike letters anywhere', () => {
  it.each(['Run By Pr1x', 'Team Pr1x', 'Example by PrIx', 'Pr1x Momentum', 'The PRlX Fund'])('refuses %j', (name) => {
    expect(isBlockedName(name)).toBe(true);
  });
});

describe('isBlockedName: ordinary names near those rules still pass', () => {
  it.each([
    'Buyback Index',
    'Sell In May',
    'Momentum Five',
    'Lighthouse',
    'Profit Taker',
    'Strong Dollar',
    'Nowcast Macro',
    'Tesla Watch',
    'Buy And Hold',
    'Buy The Dip',
    'Sell Side Signals',
    'Now Or Never',
    'Everything Index',
    'NVDA Tracker',
    'Strong Hands',
    'Double Down Value',
    'Sure Footed',
    'Win Streak',
    'Big Tech Equal',
    'Seller Notes',
    'Buyer Nowhere',
    'Coinbase Watch',
  ])('allows %j', (name) => {
    expect(isBlockedName(name)).toBe(false);
  });
});

describe('isBlockedName: what the second review found passing (2026-10-14)', () => {
  it.each([
    // (1) trading calls: a company's common name, "all", more order words, a target two words away
    'Buy Tesla',
    'Buy Apple',
    'Buy Nvidia',
    'Buy Bitcoin',
    'Buy Solana',
    'Buy Palantir',
    'Buy More NVDA',
    'Buy The NVDA Dip',
    'Buy Dip NVDA',
    'Long NVDA',
    'Short TSLA',
    'Dump TSLA',
    'Load Up NVDA',
    'Ape Into GME',
    'Buy All',
    'Sell All',
    'Buy Buy Buy',
    // (2) promises
    '50x Gains',
    '5x Fund',
    '2x Your Money',
    'Triple Your Money',
    'Up Only',
    'Zero Risk',
    'No Loss',
    'Never Lose',
    'Easy Money',
    'Safe Bet',
    'Sure Thing',
    'Millionaire Maker',
    'Profit Every Day',
    'Passive Income',
    // (3) Prix's own labels
    'Verified Agent',
    'Featured Agent',
    'Editors Pick',
    "Editor's Pick",
    'Recommended Portfolio',
    'Top Pick Today',
    'Pons Picks',
  ])('refuses %j', (name) => {
    expect(isBlockedName(name)).toBe(true);
  });

  it.each([
    'Buy And Hold',
    'Buy The Dip',
    'Sell In May',
    'Tesla Watch',
    'NVDA Tracker',
    'Sure Footed',
    'Win Streak',
    'Profit Taker',
    'Top 100',
    'Fox 10',
    'Momentum Five',
    'Lighthouse',
    'Long Short Equity',
    'Strategy Momentum',
  ])('allows %j', (name) => {
    expect(isBlockedName(name)).toBe(false);
  });
});

describe('names that pass for Prix are refused by the contract', () => {
  it.each(['Run by Prix', 'By Prix', 'Team Prix', 'Example by Prix'])('refuses %j', (name) => {
    expect(agentNameSchema.safeParse(name).success).toBe(false);
  });
});
