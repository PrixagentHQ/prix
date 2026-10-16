import {
  ADVICE_WORDS,
  FEED_DELAY_SECONDS,
  MICRO,
  MIN_DECISIONS_TO_RANK,
  MIN_TRADING_DAYS_TO_RANK,
  OPEN_DAILY_TICK_HOUR_UTC,
  SOCIAL_FORBIDDEN_WORDS,
  STARTING_CASH_MICRO,
} from '@prix/contracts';
import { describe, expect, it } from 'vitest';
import { deck } from './deck.ts';
import { homeStrings } from './deck-home.ts';
import { grouped, hoursOf, inWords } from './facts.ts';

/**
 * The words of the new home page (direction B, 2026-10-14). Every sentence is read from the deck: a test
 * here pins a rule of the brief, not a wording, except for the two sentences the founder chose word for
 * word and the line every page that shows performance carries.
 */

const entries = Object.entries(homeStrings) as [string, string][];

const PROMISE =
  /\b(guaranteed?|risk[- ]free|sure profit|profits?|you will (?:earn|make|profit)|get rich|beat the market|returns? of up to|double your|passive income|earn(?:ings?)?|gains? for you)\b/i;
const MIDDLE_DOT = /[·•∙⋅]/;
const ARROW = /(?:[→←↑↓↗↘↙↖⇒⇢➔➜➝➞›»]|->|=>)/;
const PLACEHOLDER = /\b(?:lorem|ipsum|todo|tbd|placeholder|fixme|xxx+)\b|\{\{|\.\.\./i;
const FUND =
  /\b(etf|etfs|nav|subscribe\w*|invest(?:ing|ment|ments)?\s+in|managed portfolio|copy (?:this|their) trades?)\b/i;
const SHOUTING_LABEL = /\b[A-Z]{2,}(?:\s+[A-Z]{2,}){1,}\b/;

/** What a home string must never do, as one list of reasons, so the same rules check samples below. */
function problems(value: string): string[] {
  const found: string[] = [];
  if (PROMISE.test(value)) found.push('promises a return');
  if (ADVICE_WORDS.test(value)) found.push('uses a word of advice');
  if (SOCIAL_FORBIDDEN_WORDS.test(value)) found.push('uses a word of betting, of a winner or of a fund');
  if (FUND.test(value)) found.push('uses the language of a fund');
  if (MIDDLE_DOT.test(value)) found.push('joins a meta line with a middle dot');
  if (ARROW.test(value)) found.push('appends an arrow');
  if (PLACEHOLDER.test(value)) found.push('holds placeholder text');
  if (SHOUTING_LABEL.test(value.replace(/\bUSD\b|\bUTC\b|\bAI\b/g, ''))) found.push('is a capital-letter label');
  if (/[<>]/.test(value) || /\n/.test(value)) found.push('holds markup or a line break');
  return found;
}

const slotsOf = (value: string): string[] => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? '');

/** A deck string with its slots filled, as a page gets it. Not `text`, whose calls qa's scanner reads as a page's. */
const fill = (key: string, slots: Record<string, string | number>): string =>
  (deck[key] ?? '').replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(slots, name) ? String(slots[name]) : match,
  );

describe('the words of the home page', () => {
  it('are all in the landing area and all reach the deck', () => {
    expect(entries.length).toBeGreaterThan(30);
    for (const [key, value] of entries) {
      expect(key, key).toMatch(/^landing\.[a-z][A-Za-z0-9]*$/);
      expect(deck[key], key).toBe(value);
      expect(value.trim(), key).not.toBe('');
    }
  });

  it('promise no return, give no advice, and carry no middle-dot meta line, arrow or placeholder', () => {
    const found = entries.flatMap(([key, value]) => problems(value).map((problem) => `${key}: ${problem}`));
    expect(found).toEqual([]);
  });

  it('would be caught by those rules if they did', () => {
    expect(problems('Open division · round of 13 Oct, 15:00 UTC')).toContain('joins a meta line with a middle dot');
    expect(problems('See all 12 agents →')).toContain('appends an arrow');
    expect(problems('See all 12 agents ->')).toContain('appends an arrow');
    expect(problems('Build an agent and earn every day')).toContain('promises a return');
    expect(problems('A guaranteed return')).toContain('promises a return');
    expect(problems('You should buy NVDA')).toContain('uses a word of advice');
    expect(problems('The best agent this week')).toContain('uses a word of betting, of a winner or of a fund');
    expect(problems('TOP FIVE AGENTS')).toContain('is a capital-letter label');
    expect(problems('Open division, after the round of 13 Oct, 15:00 UTC')).toEqual([]);
  });

  it('say what Prix is in the two sentences the founder chose, with the start figure from the contract', () => {
    const start = grouped(STARTING_CASH_MICRO / MICRO);
    expect(start).toBe('10,000');
    expect(deck['landing.heroTitle']).toBe('AI agents trade paper money at real market prices, ranked in public.');
    expect(deck['landing.heroBody']).toBe(
      `Write a strategy in plain words. Your agent trades it with ${start} virtual USD on trading days, in public, and no real money moves.`,
    );
    // Since Prix Live opened to the public (D-168): one quiet line names the real-money side, in the
    // operator's words, and names neither a figure nor an outcome. Its second pass (W168-2): it says where
    // it applies, uses the Live pages' verb "follow", and the risk sentence stands right after the link.
    expect(deck['landing.heroLive']).toBe(
      'Where it is open, Prix Live can follow your agent with real money, in a Safe of your own.',
    );
    expect(deck['landing.heroLiveRisk']).toBe('You can lose that money.');
    for (const key of ['landing.heroLive', 'landing.heroLiveRisk']) {
      expect(deck[key], key).not.toMatch(/\d|%|\$/);
    }
    // The link never claims more than Prix Live does: it follows an agent, it does not trade a strategy.
    expect(deck['landing.heroLive']).not.toMatch(/\btrade\b|\bcan also\b/i);
    expect(deck['landing.heroLiveRisk']).toMatch(/\blose\b/);
    // True of both divisions: Open agents decide once a trading day, Pro agents every hour of the
    // window, so the first screen names no frequency.
    expect(deck['landing.heroBody']).not.toMatch(/\bonce\b|\bhour|\bdaily\b|each trading day|every/i);
    for (const key of ['landing.startLine', 'landing.sparkLabel', 'landing.boardFootStart']) {
      expect(deck[key], key).toContain(`${start} virtual USD`);
    }
  });

  it('name each action the way the rest of the site does', () => {
    expect(deck['landing.heroBuild']).toBe(deck['common.buildAgent']);
    expect(deck['landing.heroHow']).toBe(deck['nav.howItWorks']);
    expect(deck['landing.decisionsTitle']).toBe(deck['league.feedTitle']);
  });

  it('state the rank rule from the contract: trading days and decisions', () => {
    const days = inWords(MIN_TRADING_DAYS_TO_RANK);
    const decisions = inWords(MIN_DECISIONS_TO_RANK);
    expect(deck['landing.boardFootRule']).toBe(`A rank needs ${days} trading days and ${decisions} decisions.`);
    expect(deck['landing.noneRankedBody']).toContain(`${days} trading days and ${decisions} decisions`);
  });

  it('give the board a plain head line with slots, never a typed date or count', () => {
    expect(fill('landing.boardHead', { division: 'Open', time: '13 Oct, 15:00 UTC' })).toBe(
      'Open division, after the round of 13 Oct, 15:00 UTC',
    );
    expect(fill('landing.seeAllOther', { count: 12 })).toBe('See all 12 agents');
    expect(slotsOf(deck['landing.boardTitleTop'] ?? '')).toEqual(['count']);
    expect(slotsOf(deck['landing.boardFootRanked'] ?? '')).toEqual(['ranked', 'count']);
    for (const [key, value] of entries) {
      expect(value, key).not.toMatch(/\b\d{1,2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/);
      expect(value, key).not.toMatch(/\b\d+ agents?\b/);
    }
  });

  it('show only the agent, the action and the time of a decision: no reason, and the delay as a slot', () => {
    for (const [key, value] of entries) {
      expect(slotsOf(value), key).not.toContain('reason');
      expect(value.toLowerCase(), key).not.toContain('reason given');
    }
    expect(fill('landing.actionBought', { symbols: 'NVDA' })).toBe('Bought NVDA');
    expect(fill('landing.actionSold', { symbols: 'USO' })).toBe('Sold USO');
    expect(fill('landing.actionBoughtSold', { a: 'SGOV', b: 'USO' })).toBe('Bought SGOV, sold USO');
    expect(deck['landing.actionNoTrade']).toBe('No trade');
    expect(deck['landing.decisionsNoteDelayed']).toContain('agents Prix runs as examples');
    expect(slotsOf(deck['landing.decisionsNoteDelayed'] ?? '')).toEqual(['length']);
    expect(fill('landing.decisionsNoteDelayed', { length: hoursOf(FEED_DELAY_SECONDS) })).toBe(
      'By the agents Prix runs as examples. Each appears here 24 hours after it is made.',
    );
    expect(deck['landing.decisionsEmptyBody']).toContain(`${String(OPEN_DAILY_TICK_HOUR_UTC).padStart(2, '0')}:00 UTC`);
  });

  it('carry the disclaimer word for word', () => {
    expect(deck['landing.disclaimer']).toBe(
      'The league is a paper trading simulation, where no real orders are placed. In Prix Live, an owner’s agent trades real money in the owner’s own Safe. Not investment advice.',
    );
    expect(deck['landing.disclaimer']).toBe(deck['common.disclaimer']);
    // Prix is never the one who trades (W168-6).
    expect(deck['common.disclaimer']).not.toMatch(/Prix Live trades/);
  });

  it('name no token on the home page', () => {
    for (const [key, value] of entries) {
      expect(value, key).not.toMatch(/\$PRI[XZ]|\btoken\b|0x[0-9a-f]{6,}/i);
    }
  });
});
