import {
  apiErrorCodeSchema,
  marketClosedReasonSchema,
  noDecisionCodeSchema,
  pausedReasonSchema,
  rowStatusSchema,
  skipCodeSchema,
  summaryStatusSchema,
  unrankedReasonSchema,
} from '@prix/contracts';
import { describe, expect, it } from 'vitest';
import { deck } from '../../apps/web/src/content/deck.ts';
import {
  formatPercentBps,
  formatTick,
  formatTimeUtc,
  formatUsdMicro,
  formatWeightBps,
} from '../../apps/web/src/content/format.ts';
import { text } from '../../apps/web/src/content/index.ts';
import {
  apiErrorText,
  marketClosedText,
  noDecisionText,
  pausedText,
  rowStatusText,
  skippedText,
  summaryStatusText,
  unrankedText,
} from '../../apps/web/src/content/states.ts';
import { readSources } from '../support/repo.ts';
import type { TextCall, Violation } from '../support/text-calls.ts';
import {
  checkDeck,
  checkTextCalls,
  findTextCalls,
  forbiddenWording,
  plainTextProblem,
  renamesText,
} from '../support/text-calls.ts';

/**
 * The content rules of docs/CONTRACTS.md section 8. `qa` owns the one test that reads every
 * `text(` call under apps/web/src.
 *
 * The last rule, "a key in use with no deck entry", applies at the gate. It runs when the
 * environment variable PRIX_GATE is 1, which is how the operator runs the suite before a gate.
 */

const AT_GATE = process.env.PRIX_GATE === '1';
const EXTENSIONS = ['.astro', '.ts', '.tsx', '.js', '.jsx', '.mjs'];
/** The definition of `text` and the direction studies, which are static and get deleted. */
const SKIPPED = (path: string): boolean => path === 'apps/web/src/content/index.ts' || path.includes('/design/studies');

const sources = readSources('apps/web/src', EXTENSIONS, SKIPPED);
const calls: TextCall[] = sources.flatMap((file) => findTextCalls(file.path, file.source));

function report(violations: Violation[]): string {
  return violations
    .map((violation) => `${violation.file}:${violation.line} [${violation.rule}] ${violation.detail}`)
    .join('\n');
}

describe('every text( call under apps/web/src', () => {
  it('finds the source files of the site and at least one call', () => {
    expect(sources.length).toBeGreaterThan(5);
    expect(calls.length).toBeGreaterThan(0);
  });

  it('has a key and a draft that are string literals', () => {
    const found = checkTextCalls(calls, { deck, gate: false }).filter(
      (item) => item.rule === 'key-literal' || item.rule === 'draft-literal',
    );
    expect(found, report(found)).toEqual([]);
  });

  it('uses a key inside the areas of the contract: an area, a dot and a name in camelCase', () => {
    const found = checkTextCalls(calls, { deck, gate: false }).filter((item) => item.rule === 'key-area');
    expect(found, report(found)).toEqual([]);
  });

  it('never gives one key two different drafts', () => {
    const found = checkTextCalls(calls, { deck, gate: false }).filter((item) => item.rule === 'draft-conflict');
    expect(found, report(found)).toEqual([]);
  });

  it('never has a slot in the deck string that the draft lacks', () => {
    const found = checkTextCalls(calls, { deck, gate: false }).filter((item) => item.rule === 'deck-slot');
    expect(found, report(found)).toEqual([]);
  });

  it('has drafts that are real, plain text: no placeholder, no markup, no line break', () => {
    const rules = ['draft-empty', 'draft-placeholder', 'draft-plain-text', 'draft-wording', 'plural-pair'];
    const found = checkTextCalls(calls, { deck, gate: false }).filter((item) => rules.includes(item.rule));
    expect(found, report(found)).toEqual([]);
  });

  it('never imports text under another name, which would hide its calls from this test', () => {
    const renamed = sources.filter((file) => renamesText(file.source)).map((file) => file.path);
    expect(renamed).toEqual([]);
  });

  it.runIf(AT_GATE)('at the gate: every key in use has its final string in the deck', () => {
    const found = checkTextCalls(calls, { deck, gate: true }).filter((item) => item.rule === 'deck-missing');
    expect(found, report(found)).toEqual([]);
  });
});

describe('the copy deck', () => {
  it('holds only valid keys with plain, final strings', () => {
    const found = checkDeck(deck);
    expect(found, report(found)).toEqual([]);
  });

  it('carries the disclaimer word for word', () => {
    expect(deck['common.disclaimer']).toBe(
      'Paper trading simulation. Not investment advice. No real orders are placed.',
    );
  });

  it('does not promise returns', () => {
    const promise =
      /\b(guaranteed?|risk[- ]free|sure profit|you will (?:earn|make|profit)|get rich|beat the market)\b/i;
    const found = Object.entries(deck).filter(([, value]) => promise.test(value));
    expect(found).toEqual([]);
  });
});

describe('text()', () => {
  it('returns the deck string for a key that has one, and the draft otherwise', () => {
    expect(text('common.disclaimer', 'A draft that the deck overrides.')).toBe(deck['common.disclaimer']);
    expect(text('league.keyThatNoDeckHasForTests', 'Only the draft exists.')).toBe('Only the draft exists.');
  });

  it('fills slots by name and leaves a slot without a value visible', () => {
    expect(text('league.keyThatNoDeckHasForTests', 'Day {day} of {total}', { day: 9, total: 28 })).toBe('Day 9 of 28');
    expect(text('league.keyThatNoDeckHasForTests', 'Day {day} of {total}', { day: 9 })).toBe('Day 9 of {total}');
  });

  it('does not read slot values from the prototype of the slots object', () => {
    expect(text('league.keyThatNoDeckHasForTests', 'Value {toString} and {constructor}', {})).toBe(
      'Value {toString} and {constructor}',
    );
  });
});

describe('a sentence for every code a page can show', () => {
  const families: [string, readonly string[], (code: never) => string][] = [
    ['NoDecisionCode', noDecisionCodeSchema.options, noDecisionText],
    ['SkipCode', skipCodeSchema.options, skippedText],
    ['MarketClosedReason', marketClosedReasonSchema.options, marketClosedText],
    ['UnrankedReason', unrankedReasonSchema.options, unrankedText],
    ['PausedReason', pausedReasonSchema.options, pausedText],
    ['SummaryStatus', summaryStatusSchema.options, summaryStatusText],
    ['RowStatus', rowStatusSchema.options, rowStatusText],
    ['ApiErrorCode', apiErrorCodeSchema.options, apiErrorText],
  ];

  it.each(families)('%s', (_family, codes, sentence) => {
    expect(codes.length).toBeGreaterThan(0);
    const seen = new Set<string>();
    for (const code of codes) {
      const value = sentence(code as never);
      expect(typeof value, code).toBe('string');
      expect(value.trim().length, code).toBeGreaterThan(0);
      expect(plainTextProblem(value), `${code}: ${value}`).toBeNull();
      expect(forbiddenWording(value), `${code}: ${value}`).toBeNull();
      // No sentence shows the code itself, and no two codes share a sentence.
      expect(value.includes('_'), `${code}: ${value}`).toBe(false);
      expect(seen.has(value), `${code} repeats the sentence of another code`).toBe(false);
      seen.add(value);
    }
  });
});

describe('formatting', () => {
  it('always gives a gain a plus sign and a loss a minus sign, so colour is never the only cue', () => {
    expect(formatPercentBps(684)).toBe('+6.84%');
    expect(formatPercentBps(-192)).toBe('−1.92%');
    expect(formatPercentBps(0)).toBe('0.00%');
    expect(formatPercentBps(5)).toBe('+0.05%');
    expect(formatPercentBps(-5)).toBe('−0.05%');
  });

  it('formats weights and amounts', () => {
    expect(formatWeightBps(2_100)).toBe('21.0%');
    expect(formatUsdMicro(10_684_000_000)).toBe('10,684.00');
  });

  it('says that a time is UTC', () => {
    expect(formatTimeUtc('2026-10-06T15:00:00.000Z')).toBe('15:00 UTC');
    expect(formatTick('2026-10-06T15:00Z')).toContain('UTC');
  });
});

describe('the scanner of this test', () => {
  const scan = (source: string) => findTextCalls('sample.astro', source);
  const rules = (source: string, sampleDeck: Record<string, string> = {}, gate = false) =>
    checkTextCalls(scan(source), { deck: sampleDeck, gate }).map((item) => item.rule);

  it('reads a call with its key, draft and line', () => {
    const found = scan(
      "---\nimport { text } from '../content/index.ts';\n---\n<h1>{text('league.title', 'League')}</h1>",
    );
    expect(found).toEqual([
      { file: 'sample.astro', line: 4, key: 'league.title', draft: 'League', source: "text('league.title', 'League'" },
    ]);
  });

  it('reads double quotes, escapes, slots and a call over several lines', () => {
    const found = scan(
      "const a = text(\n  \"league.dayOf\",\n  'It\\'s day {day} of {total}',\n  { day: 9, total: 28 },\n);",
    );
    expect(found.map((call) => [call.key, call.draft])).toEqual([['league.dayOf', "It's day {day} of {total}"]]);
  });

  it('accepts a correct call', () => {
    expect(rules("text('league.title', 'League')")).toEqual([]);
  });

  it('fails on a key that is not a string literal', () => {
    expect(rules("text(key, 'League')")).toEqual(['key-literal']);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the sample is source code with a template literal
    expect(rules("text(`league.${name}`, 'League')")).toEqual(['key-literal']);
    expect(rules("text('league.' + name, 'League')")).toContain('draft-literal');
  });

  it('fails on a draft that is not a string literal', () => {
    expect(rules("text('league.title', title)")).toEqual(['draft-literal']);
    expect(rules("text('league.title', 'Lea' + 'gue')")).toEqual(['draft-literal']);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the sample is source code with a template literal
    expect(rules("text('league.title', `Day ${day}`)")).toEqual(['draft-literal']);
    expect(rules("text('league.title')")).toEqual(['draft-literal']);
  });

  it('fails on a key outside the areas, or not in camelCase', () => {
    expect(rules("text('pricing.title', 'Pricing')")).toEqual(['key-area']);
    expect(rules("text('league.Title', 'League')")).toEqual(['key-area']);
    expect(rules("text('league.table.title', 'League')")).toEqual(['key-area']);
    expect(rules("text('league', 'League')")).toEqual(['key-area']);
    expect(rules("text('league.table_title', 'League')")).toEqual(['key-area']);
  });

  it('fails on one key with two different drafts, and not on the same draft twice', () => {
    expect(rules("text('league.title', 'League')\ntext('league.title', 'The league')")).toEqual(['draft-conflict']);
    expect(rules("text('league.title', 'League')\ntext('league.title', 'League')")).toEqual([]);
  });

  it('fails on a slot the deck string has and the draft lacks, and not the other way round', () => {
    expect(rules("text('league.dayOf', 'Day {day}')", { 'league.dayOf': 'Day {day} of {total}' })).toEqual([
      'deck-slot',
    ]);
    expect(rules("text('league.dayOf', 'Day {day} of {total}')", { 'league.dayOf': 'Day {day}' })).toEqual([]);
  });

  it('fails at the gate, and only at the gate, on a key in use with no deck entry', () => {
    expect(rules("text('league.title', 'League')", {}, false)).toEqual([]);
    expect(rules("text('league.title', 'League')", {}, true)).toEqual(['deck-missing']);
    expect(rules("text('league.title', 'League')", { 'league.title': 'League' }, true)).toEqual([]);
  });

  it('fails on markup, a line break, placeholder text and the two regulated words', () => {
    expect(rules("text('league.title', '<b>League</b>')")).toEqual(['draft-plain-text']);
    expect(rules("text('league.title', 'League\\ntable')")).toEqual(['draft-plain-text']);
    expect(rules("text('league.title', 'Lorem ipsum')")).toEqual(['draft-placeholder']);
    expect(rules("text('landing.lead', 'Prix is an exchange for AI trading agents')")).toEqual(['draft-wording']);
    expect(rules("text('agent.title', 'Fact sheet')")).toEqual(['draft-wording']);
  });

  it('wants both keys of a sentence that changes with a count', () => {
    expect(rules("text('league.agentsOne', '{count} agent')")).toEqual(['plural-pair']);
    expect(rules("text('league.agentsOne', '{count} agent')\ntext('league.agentsOther', '{count} agents')")).toEqual(
      [],
    );
  });

  it('does not take a fallback key that ends in Other for a plural', () => {
    expect(rules("text('agent.noDecisionOther', 'The agent returned no valid decision.')")).toEqual([]);
    expect(rules("text('league.agentsOther', '{count} agents')")).toEqual(['plural-pair']);
  });

  it('ignores the definition of text, methods named text, and comments', () => {
    expect(scan('export function text(key: string, draft: string): string {}')).toEqual([]);
    expect(scan('const body = await response.text();')).toEqual([]);
    expect(scan('const context = getContext(); subtext(a);')).toEqual([]);
    expect(scan("// text('league.title', 'League')")).toEqual([]);
    expect(scan(" * `text('league.title', 'League')`")).toEqual([]);
    expect(scan("<!-- {text('league.title', 'League')} -->")).toEqual([]);
    expect(scan("const a = 1; // text('league.title', 'League')")).toEqual([]);
  });

  it('notices text imported under another name', () => {
    expect(renamesText("import { text as t } from '../content/index.ts';")).toBe(true);
    expect(renamesText("import { text } from '../content/index.ts';")).toBe(false);
    expect(renamesText('/** The bytes of a text as 0x and hex. */')).toBe(false);
  });
});
