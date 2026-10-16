import { readFileSync } from 'node:fs';
import {
  ADVICE_WORDS,
  MAX_WEIGHT_BPS,
  PROMPT_MAX,
  PROMPT_MIN,
  promptSchema,
  SOCIAL_FORBIDDEN_WORDS,
  TOKEN_DEFAULT_THRESHOLDS_PPM,
} from '@prix/contracts';
import { describe, expect, it } from 'vitest';
import { UNIVERSE } from '../../../../packages/market/src/universe.ts';
import { DECISION_SYSTEM_MESSAGE } from '../../../../packages/runtime/src/prompts.ts';
import { checkDeck, forbiddenWording, plainTextProblem, socialWording } from '../../../../tests/support/text-calls.ts';
import { deck } from './deck.ts';
import { homeStrings } from './deck-home.ts';
import { socialStrings } from './deck-social.ts';
import {
  BUILD_TEMPLATE_IDS,
  buildTemplateKeys,
  type DecisionFact,
  HOLDER_TEMPLATE_FACTS,
  HOLDER_TEMPLATE_IDS,
  templateStrings,
} from './deck-templates.ts';
import { grouped, inWords } from './facts.ts';

/**
 * The strategy templates of the Build page (D-155). Every string is read from the deck: a test here pins a
 * rule of the brief, not a wording, except the one sentence the brief gives word for word.
 */

const entries = Object.entries(templateStrings) as [string, string][];
const templates = BUILD_TEMPLATE_IDS.map((id) => {
  const keys = buildTemplateKeys(id);
  return {
    id,
    keys,
    title: deck[keys.title] ?? '',
    line: deck[keys.line] ?? '',
    prompt: deck[keys.prompt] ?? '',
  };
});

const TITLE_MAX = 28;
const LINE_MAX = 90;
const MAX_WEIGHT_PERCENT = MAX_WEIGHT_BPS / 100;

const PROMISE =
  /\b(guaranteed?|risk[- ]free|safe|sure|certain\w*|profits?|profitable|earn\w*|gains?|yield\w*|income|returns? of|you will|get rich|beat the market|double|outperform\w*|upside|winners?|top|leading|proven|reliable)\b/i;
const FORECAST =
  /\b(forecast\w*|predict\w*|expect\w*|outlook|will (?:rise|fall|go|climb|drop)|target\w*|price\w*|cheap|undervalued|overvalued)\b/i;
const FUND = /\b(etf|etfs|nav|subscribe\w*|invest\w*|managed|fund|portfolio manager|copy (?:this|their) trades?)\b/i;
const READER = /\b(you|your|yours|we|our|us|i)\b/i;
/**
 * A count in words. "one" followed by "to" or "of" names one item of a set ("moves one to cash", "one of
 * them") and is a pronoun, not a count; "one name", "one day" and "one at a time" still count.
 */
const NUMBER_WORD =
  /\b(zero|one(?!\s+(?:to|of)\b)|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|hundred|thousand|million|half|quarter|third|percent|per cent)\b/i;
/** An amount of money. `$PRIX` is the token's ticker, not an amount, and the holder lines name it. */
const MONEY = /\$(?!PRIX\b)|[€£¥]|\b(usd|usdg|dollars?|cents?)\b/i;
const MIDDLE_DOT = /[·•∙⋅]/;
const ARROW = /(?:[→←↑↓↗↘↙↖⇒⇢➔➜➝➞›»]|->|=>)/;
const PERSON = /\b(buffett|musk|huang|cook|zuckerberg|nadella|pichai|jassy|saylor|cathie|wood|burry|dalio|ackman)\b/i;
/** The symbols of the universe a template may name (packages/market/src/universe.ts). */
const SYMBOLS = new Set([
  'AAPL',
  'AMD',
  'AMZN',
  'COIN',
  'CRCL',
  'GME',
  'GOOGL',
  'INTC',
  'META',
  'MSFT',
  'MSTR',
  'MU',
  'NVDA',
  'PLTR',
  'QQQ',
  'SGOV',
  'SPCX',
  'SPY',
  'TSLA',
  'USO',
  'BTC',
  'ETH',
  'BNB',
  'HYPE',
  'SOL',
]);

/** The asset names a title may write with a capital, as the universe names them. */
const NAMES = new Set(['Bitcoin', 'Ethereum']);

/** What any template string must never do, as one list of reasons, so the same rules check samples below. */
function wordingProblems(value: string): string[] {
  const found: string[] = [];
  if (ADVICE_WORDS.test(value)) found.push('uses a word of advice');
  if (SOCIAL_FORBIDDEN_WORDS.test(value)) found.push('uses a word of betting, of a winner or of a fund');
  if (PROMISE.test(value)) found.push('promises or praises a result');
  if (FORECAST.test(value)) found.push('forecasts or names a price');
  if (FUND.test(value)) found.push('uses the language of a fund');
  if (MONEY.test(value)) found.push('names an amount of money');
  if (PERSON.test(value)) found.push('names a person');
  if (MIDDLE_DOT.test(value)) found.push('joins a meta line with a middle dot');
  if (ARROW.test(value)) found.push('appends an arrow');
  const plain = plainTextProblem(value);
  if (plain) found.push(plain);
  const gate = forbiddenWording(value) ?? socialWording(value);
  if (gate) found.push(gate);
  return found;
}

/** A title or a line: says what the template does, never how well, and carries no figure of any kind. */
function figureProblems(value: string): string[] {
  const found: string[] = [];
  if (/\d/.test(value)) found.push('carries a digit');
  if (/%/.test(value)) found.push('carries a percent sign');
  if (NUMBER_WORD.test(value)) found.push('carries a number in words');
  if (/\b(rank\w*|return\w*|performance|performed|record)\b/i.test(value)) found.push('speaks of a result');
  return found;
}

/** A prompt's figures: weights and thresholds in percent, each within the cap of one holding. */
function promptFigureProblems(value: string): string[] {
  const found: string[] = [];
  const percents = [...value.matchAll(/(\d+(?:\.\d+)?)\s*%/g)].map((match) => Number(match[1]));
  for (const percent of percents) {
    if (percent > MAX_WEIGHT_PERCENT) found.push(`holds ${percent}%, above the cap of one holding`);
  }
  // Every digit belongs to a percent: no amount, no date, no count of money.
  const bare = value.replace(/\d+(?:\.\d+)?\s*%/g, '');
  if (/\d/.test(bare)) found.push('carries a figure that is not a weight or a threshold in percent');
  for (const word of value.match(/\b[A-Z]{2,5}\b/g) ?? []) {
    if (!SYMBOLS.has(word)) found.push(`names ${word}, which is not a symbol of the universe`);
  }
  return found;
}

describe('the strategy templates of the Build page', () => {
  it('are in the builder area, all reach the deck, and no other part of the deck has the same key', () => {
    expect(entries.length).toBeGreaterThan(BUILD_TEMPLATE_IDS.length * 3);
    const deckSource = readFileSync(new URL('./deck.ts', import.meta.url), 'utf8');
    const others = { ...homeStrings, ...socialStrings };
    for (const [key, value] of entries) {
      expect(key, key).toMatch(/^builder\.[a-z][A-Za-z0-9]*$/);
      expect(deck[key], key).toBe(value);
      expect(Object.hasOwn(others, key), key).toBe(false);
      expect(deckSource.includes(`'${key}'`), key).toBe(false);
    }
  });

  it('pass the copy gate’s own check of the deck', () => {
    const found = checkDeck(templateStrings).map((violation) => `${violation.rule}: ${violation.detail}`);
    expect(found).toEqual([]);
  });

  it('are eight, each with a title, a line and a prompt, and no two alike', () => {
    expect(templates).toHaveLength(8);
    for (const field of ['title', 'line', 'prompt'] as const) {
      const values = templates.map((template) => template[field]);
      for (const [index, value] of values.entries()) expect(value, `${templates[index]?.id} ${field}`).not.toBe('');
      expect(new Set(values).size, field).toBe(values.length);
    }
  });

  it('keep each title under 28 characters and each line under 90, in sentence case', () => {
    for (const { id, title, line } of templates) {
      expect(title.length, `${id}: ${title}`).toBeLessThan(TITLE_MAX);
      expect(line.length, `${id}: ${line}`).toBeLessThan(LINE_MAX);
      expect(title, id).toMatch(/^[A-Z]/);
      // Sentence case: after the first word, a capital starts only a symbol of the universe or a name.
      const capitals = title
        .split(/\s+/)
        .slice(1)
        .filter((word) => /^[A-Z]/.test(word));
      for (const word of capitals) expect(SYMBOLS.has(word) || NAMES.has(word), `${id}: ${word}`).toBe(true);
      expect(line, id).toMatch(/\.$/);
      expect(title, id).not.toMatch(/\.$/);
    }
  });

  it('say what each template does, never how well: no figure of any kind in a title or a line', () => {
    const found = templates.flatMap(({ id, title, line }) => [
      ...figureProblems(title).map((problem) => `${id} title: ${problem}`),
      ...figureProblems(line).map((problem) => `${id} line: ${problem}`),
    ]);
    expect(found).toEqual([]);
  });

  it('promise nothing, forecast nothing and give no advice, in any string', () => {
    const found = entries.flatMap(([key, value]) => wordingProblems(value).map((problem) => `${key}: ${problem}`));
    expect(found).toEqual([]);
  });

  it('never address the reader in a template: a title, a line and a prompt are about the agent', () => {
    const found = templates.flatMap(({ id, keys }) =>
      Object.values(keys)
        .filter((key) => READER.test(deck[key] ?? ''))
        .map((key) => `${id}: ${key}`),
    );
    expect(found).toEqual([]);
    expect(READER.test('Your money in big tech.')).toBe(true);
  });

  it('give every prompt as a text promptSchema accepts, exactly as the page puts it into the field', () => {
    for (const { id, prompt } of templates) {
      const parsed = promptSchema.safeParse(prompt);
      expect(parsed.success, `${id}: ${parsed.success ? '' : parsed.error.message}`).toBe(true);
      expect(prompt.length, id).toBeGreaterThanOrEqual(PROMPT_MIN);
      expect(prompt.length, id).toBeLessThanOrEqual(PROMPT_MAX);
      expect(prompt, id).toBe(prompt.trim());
      expect(prompt, id).not.toMatch(/\{\w+\}/);
    }
  });

  it('keep the figures of a prompt to weights and thresholds, within the cap, on symbols of the universe', () => {
    const found = templates.flatMap(({ id, prompt }) =>
      promptFigureProblems(prompt).map((problem) => `${id} prompt: ${problem}`),
    );
    expect(found).toEqual([]);
  });

  it('say once, in the brief’s words, that a template is a starting text and not advice', () => {
    expect(deck['builder.templatesNote']).toBe('A template is a starting text, not advice.');
    expect(deck['builder.templatesTitle']).toBe('Start from a template');
    const saying = entries.filter(([, value]) => /starting text, not advice/.test(value));
    expect(saying.map(([key]) => key)).toEqual(['builder.templatesNote']);
  });

  it('name the template through one slot, and keep the two answers of the question apart', () => {
    for (const key of [
      'builder.templateUse',
      'builder.templateAdded',
      'builder.templateReplaceBody',
      'builder.templateReplaceBodySignedOut',
      'builder.templateKept',
      'builder.templateNotKept',
    ]) {
      const slots = [...(deck[key] ?? '').matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
      expect(slots, key).toEqual(['title']);
    }
    for (const { id } of templates) {
      for (const key of Object.values(buildTemplateKeys(id))) expect(deck[key] ?? '', key).not.toMatch(/\{/);
    }
    expect(deck['builder.templateReplaceConfirm']).not.toBe(deck['builder.templateReplaceCancel']);
  });

  it('give a reader who has not signed in the operator’s own words, which send nothing anywhere (T-1)', () => {
    expect(deck['builder.templatesHintSignedOut']).toBe(
      'Choosing one keeps its text for the strategy prompt, ready after you sign in. You can change every word before you build the agent.',
    );
    expect(deck['builder.templateKept']).toBe('{title} is ready for the strategy prompt.');
    expect(deck['builder.templateNotKept']).toBe(
      '{title} could not be kept in this browser. Sign in, then choose it again.',
    );
    expect(deck['builder.templatesHintSignedOut']).not.toBe(deck['builder.templatesHint']);
    expect(deck['builder.templateKept']).not.toBe(deck['builder.templateNotKept']);
    // The signed-out words promise no outcome of signing in and name no figure.
    for (const key of [
      'builder.templatesHintSignedOut',
      'builder.templateKept',
      'builder.templateKeptSignIn',
      'builder.templateNotKept',
    ]) {
      const value = (deck[key] ?? '').replace('{title}', 'Template');
      expect(value, key).not.toMatch(/\d/);
      expect(
        figureProblems(value).filter((problem) => problem !== 'carries a number in words'),
        key,
      ).toEqual([]);
    }
  });

  it('say the sign-in step once, in the link beside the kept status and not in the status too (DC3-2)', () => {
    expect(deck['builder.templateKeptSignIn']).toBe('Sign in to continue');
    // The link's words are a slot-free label: no full stop, no arrow, no slot.
    expect(deck['builder.templateKeptSignIn']).not.toMatch(/[.{}→›»]/);
    // The status no longer carries the step the link carries, so the two never read "… Sign in to continue. Sign in".
    expect(deck['builder.templateKept']).not.toMatch(/sign in/i);
  });

  it('ask a reader who has not signed in about the kept text, since no strategy prompt is on that page (DC-T5)', () => {
    expect(deck['builder.templateReplaceBodySignedOut']).toBe(
      'The text kept for your strategy prompt is text you wrote. The template {title} takes its place, and your text is not kept.',
    );
    expect(deck['builder.templateReplaceBodySignedOut']).not.toBe(deck['builder.templateReplaceBody']);
    // The signed-out body never says that a strategy prompt is on the page.
    expect(deck['builder.templateReplaceBodySignedOut']).not.toMatch(/strategy prompt holds/);
    const value = (deck['builder.templateReplaceBodySignedOut'] ?? '').replace('{title}', 'Template');
    expect(value).not.toMatch(/\d/);
  });

  it('carry the operator’s settled wording for the reworded titles and lines (T-4, TPL-1, TPL-2, TPL2-WORDS-1)', () => {
    // TPL2-WORDS-1: a line says what the text tells the agent, never what the agent will certainly do.
    expect(deck['builder.templateIndexCoreLine']).toBe(
      'Holds SPY and QQQ as a core and keeps cash above a set part of the portfolio.',
    );
    expect(deck['builder.templateTreasuryTitle']).toBe('Mostly SGOV and cash');
    expect(deck['builder.templateTreasuryLine']).toBe(
      'Keeps most of the portfolio in SGOV and cash, with a small part in SPY.',
    );
    expect(deck['builder.templateCryptoProxiesLine']).toBe(
      'Holds COIN, MSTR and CRCL in equal parts, and moves any that drop sharply to cash.',
    );
    for (const key of ['builder.templateIndexCoreLine', 'builder.templateCryptoProxiesLine']) {
      expect(deck[key], key).not.toMatch(/\b(never|always|will|certainly)\b/i);
    }
    expect(deck['builder.templateDownDaysTitle']).toBe('Adding on down days, capped');
    // The operator's word (templates-4): an instruction to the agent, not a certainty about it.
    expect(deck['builder.templateDownDaysLine']).toBe(
      'Holds a core of SPY and adds to it after a down day, up to a set cap.',
    );
    expect(deck['builder.templateDownDaysLine']).not.toMatch(/\b(never|always|will|certainly)\b/i);
    expect(deck['builder.templateMomentumLine']).toBe(
      'Holds the symbols that rose most over recent trading days, each under a cap.',
    );
  });

  it('would be caught by those rules if they did', () => {
    expect(wordingProblems('Buy NVDA when it dips.')).toContain('uses a word of advice');
    expect(wordingProblems('The best tech basket.')).toContain('uses a word of betting, of a winner or of a fund');
    expect(wordingProblems('Earns a steady income.')).toContain('promises or praises a result');
    expect(wordingProblems('A guaranteed return.')).toContain('promises or praises a result');
    expect(wordingProblems('Hold NVDA until its price target.')).toContain('forecasts or names a price');
    expect(wordingProblems('Chips are expected to rise.')).toContain('forecasts or names a price');
    expect(wordingProblems('A small fund of chip stocks.')).toContain('uses the language of a fund');
    expect(wordingProblems('Hold $500 of SPY.')).toContain('names an amount of money');
    expect(wordingProblems('Hold what Buffett holds.')).toContain('names a person');
    expect(wordingProblems('Big tech · equal parts')).toContain('joins a meta line with a middle dot');
    expect(figureProblems('Up 12% this month')).toContain('carries a digit');
    expect(figureProblems('Six names in equal parts.')).toContain('carries a number in words');
    expect(figureProblems('Holds one name at a time.')).toContain('carries a number in words');
    expect(figureProblems('Moves one at a time to cash.')).toContain('carries a number in words');
    expect(figureProblems('Moves one to cash after a drop.')).toEqual([]);
    expect(figureProblems('Moves one of them to cash.')).toEqual([]);
    expect(figureProblems('Ranked first this week.')).toContain('speaks of a result');
    expect(promptFigureProblems('Hold NVDA at 60%.')).toContain('holds 60%, above the cap of one holding');
    expect(promptFigureProblems('Hold SPY until 2027.')).toContain(
      'carries a figure that is not a weight or a threshold in percent',
    );
    const unknown = 'names ARKK, which is not a symbol of the universe';
    expect(promptFigureProblems('Hold ARKK at 20%.')).toContain(unknown);
    expect(promptSchema.safeParse('Hold SPY\u0007 at 20% and keep the rest in cash.').success).toBe(false);
    expect(promptSchema.safeParse('Hold SPY.').success).toBe(false);
  });
});

/**
 * The holder templates (D-161): a second set of eight, shown only to a signed-in wallet at tier 1 or above.
 * They keep every rule of the first set, and read only what the decision call gives the agent.
 */
const holders = HOLDER_TEMPLATE_IDS.map((id) => {
  const keys = buildTemplateKeys(id);
  return {
    id,
    keys,
    title: deck[keys.title] ?? '',
    line: deck[keys.line] ?? '',
    prompt: deck[keys.prompt] ?? '',
  };
});

/** The words a prompt uses for each fact of the decision call, so that a prompt and its list of facts agree. */
const FACT_WORDS: Record<DecisionFact, RegExp> = {
  return1d: /\blast trading day\b/,
  return5d: /\blast five\b/,
  return20d: /\blast twenty\b/,
  holdingsPercent: /\b(?:away from|moved away)\b/,
  cashPercent: /\bcash (?:above|below|at)\b/,
  halted: /\bhalted\b/,
};

/**
 * What the decision call does not give the agent (packages/runtime/src/prompts.ts): no volatility, no moving
 * average, no history of prices or of the portfolio, no earlier decision, no news. A prompt that leans on one
 * would ask the model to invent it.
 */
const NOT_GIVEN =
  /\b(volatil\w*|swings?|moving average|average price|standard deviation|deviation|drawdowns?|peaks?|highs?|lows?|high of|low of|volume|rsi|macd|earnings|news|sentiment|months?|weeks?|years?|yesterday|bought|entry|cost basis|previous (?:round|decision)|last round|earlier round|its own record|profit\w*|loss\w*)\b/i;

/**
 * The most a prompt can ask to hold at once, in percent, read by hand from its rules: the largest sum of
 * weights any branch of them gives. The test below holds each under 100, so that no rule asks for more than
 * the portfolio, and the figures of the prompt itself are held to the cap of one holding above.
 */
const WORST_CASE_PERCENT: Record<(typeof HOLDER_TEMPLATE_IDS)[number], number> = {
  GroupRotation: 40 + 20,
  IndexTrend: 35 + 25,
  DualMomentum: 40,
  CryptoTrend: 15 * 3,
  Pullbacks: 15 * 2 + 30,
  StrengthTilt: 12 * 6,
  BandedMix: 30 + 15 + 30 + 8 + 5,
  ChipsBrake: 15 * 4,
};

describe('the holder templates of the Build page (D-161)', () => {
  it('are eight, apart from the first set in every id, title, line and prompt', () => {
    expect(holders).toHaveLength(8);
    for (const id of HOLDER_TEMPLATE_IDS)
      expect((BUILD_TEMPLATE_IDS as readonly string[]).includes(id), id).toBe(false);
    for (const field of ['title', 'line', 'prompt'] as const) {
      const values = [...templates, ...holders].map((template) => template[field]);
      for (const { id, ...template } of holders) expect(template[field], `${id} ${field}`).not.toBe('');
      expect(new Set(values).size, field).toBe(values.length);
    }
    for (const { keys } of holders) {
      for (const key of Object.values(keys)) expect(Object.hasOwn(templateStrings, key), key).toBe(true);
    }
  });

  it('keep each title under 28 characters and each line under 90, in sentence case', () => {
    for (const { id, title, line } of holders) {
      expect(title.length, `${id}: ${title}`).toBeLessThan(TITLE_MAX);
      expect(line.length, `${id}: ${line}`).toBeLessThan(LINE_MAX);
      expect(title, id).toMatch(/^[A-Z]/);
      const capitals = title
        .split(/\s+/)
        .slice(1)
        .filter((word) => /^[A-Z]/.test(word));
      for (const word of capitals) expect(SYMBOLS.has(word) || NAMES.has(word), `${id}: ${word}`).toBe(true);
      expect(line, id).toMatch(/\.$/);
      expect(title, id).not.toMatch(/\.$/);
    }
  });

  it('carry no figure in a title or a line, neither a digit nor a number in words', () => {
    const found = holders.flatMap(({ id, title, line }) => [
      ...figureProblems(title).map((problem) => `${id} title: ${problem}`),
      ...figureProblems(line).map((problem) => `${id} line: ${problem}`),
    ]);
    expect(found).toEqual([]);
  });

  it('promise nothing, forecast nothing, give no advice and never address the reader', () => {
    const found = holders.flatMap(({ id, title, line, prompt }) =>
      [title, line, prompt].flatMap((value) => wordingProblems(value).map((problem) => `${id}: ${problem}`)),
    );
    expect(found).toEqual([]);
    for (const { id, title, line, prompt } of holders) {
      for (const value of [title, line, prompt]) expect(READER.test(value), `${id}: ${value}`).toBe(false);
    }
  });

  it('pass the copy gate’s own check of the deck', () => {
    const own = Object.fromEntries(holders.flatMap(({ keys }) => Object.values(keys).map((key) => [key, deck[key]])));
    expect(checkDeck(own).map((violation) => `${violation.rule}: ${violation.detail}`)).toEqual([]);
  });

  it('give every prompt as a text promptSchema accepts, exactly as the page puts it into the field', () => {
    for (const { id, prompt } of holders) {
      const parsed = promptSchema.safeParse(prompt);
      expect(parsed.success, `${id}: ${parsed.success ? '' : parsed.error.message}`).toBe(true);
      expect(prompt.length, id).toBeGreaterThanOrEqual(PROMPT_MIN);
      expect(prompt.length, id).toBeLessThanOrEqual(PROMPT_MAX);
      expect(prompt, id).toBe(prompt.trim());
      expect(prompt, id).not.toMatch(/\{\w+\}/);
    }
  });

  it('name only symbols of the league’s universe, each weight within the cap of one holding', () => {
    const universe = new Set(UNIVERSE.map((token) => token.symbol));
    // The first set's list is the universe too, so that both sets are held to the same symbols.
    expect([...SYMBOLS].sort()).toEqual([...universe].sort());
    const found = holders.flatMap(({ id, prompt }) =>
      promptFigureProblems(prompt).map((problem) => `${id} prompt: ${problem}`),
    );
    expect(found).toEqual([]);
    for (const { id, prompt } of holders) {
      for (const word of prompt.match(/\b[A-Z]{2,5}\b/g) ?? []) expect(universe.has(word), `${id}: ${word}`).toBe(true);
    }
  });

  it('never ask, in any branch of their rules, for more than the whole portfolio', () => {
    for (const { id } of holders) expect(WORST_CASE_PERCENT[id], id).toBeLessThanOrEqual(100);
  });

  it('read only facts the decision call gives the agent, and name each fact they read', () => {
    // The decision call gives, per symbol, returns over 1, 5 and 20 trading days that may be null; the
    // portfolio's parts in cash and in each symbol; and the halted symbols. If this text changes, so may the rule.
    expect(DECISION_SYSTEM_MESSAGE).toContain('percent return over the last 1 trading day, over 5, over 20');
    expect(DECISION_SYSTEM_MESSAGE).toContain('A return is null');
    expect(DECISION_SYSTEM_MESSAGE).toContain('the percent of it in cash and in each symbol');
    expect(DECISION_SYSTEM_MESSAGE).toContain('"halted"');
    const universe = new Set(UNIVERSE.map((token) => token.symbol));
    for (const { id, prompt } of holders) {
      expect(prompt, id).not.toMatch(NOT_GIVEN);
      // Every span of days is one the call gives: the last trading day, the last five or the last twenty.
      for (const match of prompt.matchAll(/\blast (\w+)/g)) {
        expect(['trading', 'five', 'twenty'], `${id}: last ${match[1]}`).toContain(match[1]);
      }
      const facts = HOLDER_TEMPLATE_FACTS[id];
      expect(facts.length, id).toBeGreaterThan(0);
      const named = new Set(facts.map((entry) => entry.fact));
      for (const [fact, words] of Object.entries(FACT_WORDS) as [DecisionFact, RegExp][]) {
        expect(words.test(prompt), `${id}: ${fact}`).toBe(named.has(fact));
      }
      for (const { fact, symbols } of facts) {
        for (const symbol of symbols) {
          expect(universe.has(symbol), `${id} ${fact}: ${symbol}`).toBe(true);
          expect(prompt.includes(symbol), `${id} ${fact}: ${symbol}`).toBe(true);
        }
      }
      // A prompt that reads a return says what to do while it is null, since a new symbol has none.
      if (named.has('return1d') || named.has('return5d') || named.has('return20d')) {
        expect(prompt, id).toMatch(/\bnull\b|\bno return\b/);
      }
    }
  });

  it('show a reader under tier 1 the operator’s own line, which names no holder template', () => {
    const locked = deck['builder.templatesHolderLocked'] ?? '';
    expect(locked).toBe('Eight more templates for wallets holding 10,000 $PRIX.');
    // Its count is the set's own, and its figure is tier 1 of the default thresholds over the supply.
    const count = inWords(HOLDER_TEMPLATE_IDS.length);
    expect(locked.startsWith(`${count.charAt(0).toUpperCase()}${count.slice(1)} more templates`)).toBe(true);
    const SUPPLY_TOKENS = 1_000_000_000;
    const tierOneTokens = (TOKEN_DEFAULT_THRESHOLDS_PPM[0] * SUPPLY_TOKENS) / 1_000_000;
    expect(locked).toContain(`${grouped(tierOneTokens)} $PRIX`);
    expect(deck['builder.templatesHolderHint']).toContain(`${grouped(tierOneTokens)} $PRIX`);
    for (const key of ['builder.templatesHolderLocked', 'builder.templatesHolderLockedLink']) {
      const value = deck[key] ?? '';
      for (const { id, title, prompt } of holders) {
        expect(value.includes(title), `${key}: ${id}`).toBe(false);
        expect(value.includes(prompt), `${key}: ${id}`).toBe(false);
      }
    }
    expect(deck['builder.templatesHolderLockedLink']).not.toMatch(/[.{}→›»]/);
  });

  it('never say that a holder template is better, or that holding $PRIX improves an agent', () => {
    const PRAISE = /\b(premium|advanced|pro|exclusive|smarter|better|stronger|edge|alpha|vip|elite|superior)\b/i;
    for (const key of [
      'builder.templatesHolderTitle',
      'builder.templatesHolderHint',
      'builder.templatesHolderLocked',
      'builder.templatesHolderLockedLink',
      ...holders.flatMap(({ keys }) => [keys.title, keys.line]),
    ]) {
      const value = deck[key] ?? '';
      expect(value, key).not.toBe('');
      expect(PRAISE.test(value), `${key}: ${value}`).toBe(false);
      expect(wordingProblems(value), key).toEqual([]);
    }
    expect(deck['builder.templatesHolderHint']).toMatch(/limits are the same for every agent/);
    // The ticker is named, never an amount of money.
    expect(MONEY.test('Eight more templates for wallets holding 10,000 $PRIX.')).toBe(false);
    expect(MONEY.test('Hold $500 of SPY.')).toBe(true);
  });

  it('would be caught by the rules of the decision call if they leaned on what it does not give', () => {
    expect(NOT_GIVEN.test('Hold the symbols with the lowest volatility.')).toBe(true);
    expect(NOT_GIVEN.test('Hold SPY while it is above its moving average.')).toBe(true);
    expect(NOT_GIVEN.test('Hold NVDA until it falls 10% from its peak.')).toBe(true);
    expect(NOT_GIVEN.test('Keep what was bought in the previous round.')).toBe(true);
    expect(NOT_GIVEN.test('Hold the four that rose most this month.')).toBe(true);
    expect(NOT_GIVEN.test('Hold the two with the lowest return over the last five trading days.')).toBe(false);
  });
});
