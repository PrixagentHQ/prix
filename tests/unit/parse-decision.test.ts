import type { DecisionParse, NoDecisionCode } from '@prix/contracts';
import { noDecisionCodeSchema, parseDecisionOutput, REASON_MAX } from '@prix/contracts';
import { describe, expect, it } from 'vitest';
import { createRng } from '../support/prng.ts';

/**
 * `parseDecisionOutput` is the one place that decides whether model output is a decision
 * (docs/CONTRACTS.md section 6). Anything it refuses is "no decision": nothing is repaired,
 * guessed or clamped.
 */

const SYMBOLS = ['AAPL', 'MSFT', 'NVDA', 'TSLA'];

const parse = (raw: string): DecisionParse => parseDecisionOutput(raw, SYMBOLS);
const json = (value: unknown): string => JSON.stringify(value);

function expectCode(raw: string, code: NoDecisionCode): void {
  const result = parse(raw);
  expect(result.ok, `expected ${code} for ${raw.slice(0, 80)}`).toBe(false);
  if (!result.ok) {
    expect(result.code).toBe(code);
    expect(typeof result.detail).toBe('string');
  }
}

function expectOk(raw: string): { targetsBps: Record<string, number>; reason: string } {
  const result = parse(raw);
  if (!result.ok) throw new Error(`expected a decision, got ${result.code}: ${result.detail}`);
  return result;
}

describe('parseDecisionOutput: a valid answer', () => {
  it('returns the targets in basis points and the reason', () => {
    expect(parse('{"targets": {"NVDA": 21, "MSFT": 18}, "reason": "Adds to the strongest position."}')).toEqual({
      ok: true,
      targetsBps: { NVDA: 2_100, MSFT: 1_800 },
      reason: 'Adds to the strongest position.',
    });
  });

  it('ignores whitespace around the JSON', () => {
    expect(expectOk('\n\t  {"targets":{"AAPL":5},"reason":"Small position."}  \r\n').targetsBps).toEqual({ AAPL: 500 });
  });

  it('accepts no targets at all: everything goes to cash', () => {
    expect(expectOk(json({ targets: {}, reason: 'Moves to cash.' })).targetsBps).toEqual({});
  });

  it('drops a zero weight from the result', () => {
    expect(expectOk(json({ targets: { NVDA: 0, MSFT: 10 }, reason: 'Sells one name.' })).targetsBps).toEqual({
      MSFT: 1_000,
    });
  });

  it('accepts up to two decimal places', () => {
    expect(
      expectOk(json({ targets: { NVDA: 21.25, MSFT: 0.01, AAPL: 33.3 }, reason: 'Fine weights.' })).targetsBps,
    ).toEqual({
      NVDA: 2_125,
      MSFT: 1,
      AAPL: 3_330,
    });
  });

  it('accepts exactly 40 for one name and exactly 100 in total', () => {
    expect(expectOk(json({ targets: { NVDA: 40, MSFT: 40, AAPL: 20 }, reason: 'Fully invested.' })).targetsBps).toEqual(
      {
        NVDA: 4_000,
        MSFT: 4_000,
        AAPL: 2_000,
      },
    );
  });

  it('adds weights exactly: decimals that sum to 100 are not over 100', () => {
    const result = expectOk(json({ targets: { NVDA: 33.34, MSFT: 33.33, AAPL: 33.33 }, reason: 'Three equal parts.' }));
    expect(Object.values(result.targetsBps).reduce((sum, bps) => sum + bps, 0)).toBe(10_000);
  });
});

describe('parseDecisionOutput: rule 1, the whole text must be JSON', () => {
  const good = '{"targets":{"NVDA":10},"reason":"Buys a little."}';

  it.each([
    ['an empty answer', ''],
    ['whitespace only', '   \n'],
    ['prose', 'I would buy NVDA.'],
    ['a code fence', `\`\`\`json\n${good}\n\`\`\``],
    ['prose before the JSON', `Here is my decision: ${good}`],
    ['prose after the JSON', `${good}\nLet me know if you need anything else.`],
    ['two objects', `${good}${good}`],
    ['single quotes', "{'targets':{'NVDA':10},'reason':'Buys a little.'}"],
    ['a trailing comma', '{"targets":{"NVDA":10,},"reason":"Buys a little."}'],
    ['a comment', `// decision\n${good}`],
    ['truncated JSON', good.slice(0, -5)],
    ['reasoning tags', `<think>NVDA looks strong.</think>${good}`],
  ])('refuses %s as invalid_json', (_name, raw) => {
    expectCode(raw, 'invalid_json');
  });
});

describe('parseDecisionOutput: rule 2, exactly "targets" and "reason"', () => {
  it.each([
    ['null', 'null'],
    ['a number', '42'],
    ['a string', '"buy NVDA"'],
    ['an array', '[{"targets":{},"reason":"x"}]'],
    ['an empty object', '{}'],
    ['no reason', json({ targets: { NVDA: 10 } })],
    ['no targets', json({ reason: 'Nothing to do.' })],
    ['an extra field', json({ targets: { NVDA: 10 }, reason: 'Buys.', confidence: 0.9 })],
    ['targets as an array', json({ targets: [{ symbol: 'NVDA', weight: 10 }], reason: 'Buys.' })],
    ['targets as null', json({ targets: null, reason: 'Buys.' })],
    ['a weight as a string', json({ targets: { NVDA: '10' }, reason: 'Buys.' })],
    ['a weight as null', json({ targets: { NVDA: null }, reason: 'Buys.' })],
    ['a nested weight', json({ targets: { NVDA: { weight: 10 } }, reason: 'Buys.' })],
    ['a reason that is not a string', json({ targets: { NVDA: 10 }, reason: 7 })],
    ['a reason that is null', json({ targets: { NVDA: 10 }, reason: null })],
  ])('refuses %s as schema_mismatch', (_name, raw) => {
    expectCode(raw, 'schema_mismatch');
  });

  it('checks the shape before the symbols', () => {
    expectCode(json({ targets: { XXXX: 10 } }), 'schema_mismatch');
  });
});

describe('parseDecisionOutput: rule 3, every key is a symbol of the universe', () => {
  it.each([
    ['a symbol outside the universe', 'GME'],
    ['a lower-case symbol', 'nvda'],
    ['a symbol with a space', 'NVDA '],
    ['cash', 'CASH'],
    ['an empty key', ''],
    ['__proto__', '__proto__'],
    ['constructor', 'constructor'],
    ['toString', 'toString'],
  ])('refuses %s as unknown_symbol', (_name, key) => {
    expectCode(`{"targets":{${JSON.stringify(key)}:10},"reason":"Buys."}`, 'unknown_symbol');
  });

  it('does not touch the prototype of objects when a key is __proto__', () => {
    const result = parse('{"targets":{"__proto__":{"polluted":1}},"reason":"Buys."}');
    expect(result.ok).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('uses the symbols it is given, not a list of its own', () => {
    const raw = json({ targets: { NVDA: 10 }, reason: 'Buys.' });
    expect(parseDecisionOutput(raw, ['NVDA']).ok).toBe(true);
    expect(parseDecisionOutput(raw, ['MSFT']).ok).toBe(false);
    expect(parseDecisionOutput(raw, []).ok).toBe(false);
  });

  it('does not put a long unknown key into the detail', () => {
    const result = parse(`{"targets":{"${'A'.repeat(5_000)}":10},"reason":"Buys."}`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail.length).toBeLessThan(200);
  });
});

describe('parseDecisionOutput: rule 4, a weight is from 0 to 100 with two decimals at most', () => {
  it.each([
    ['a negative weight', -1],
    ['a weight just below zero', -0.01],
    ['a weight just above 100', 100.01],
    ['a weight of 400, which is leverage', 400],
    ['three decimal places', 21.005],
    ['many decimal places', 33.333333],
  ])('refuses %s as weight_out_of_range', (_name, weight) => {
    expectCode(json({ targets: { NVDA: weight }, reason: 'Buys.' }), 'weight_out_of_range');
  });

  it('refuses a weight that is not a finite number', () => {
    // JSON has no Infinity, but 1e999 parses to it.
    const result = parse('{"targets":{"NVDA":1e999},"reason":"Buys."}');
    expect(result.ok).toBe(false);
  });

  it('never returns a target above 40%: a valid weight above 40 is cut to 40, the rest stays in cash', () => {
    for (const weight of [40.01, 40.5, 41, 50, 99.99, 100]) {
      expect(expectOk(json({ targets: { NVDA: weight }, reason: 'Buys.' })).targetsBps).toEqual({ NVDA: 4_000 });
    }
  });

  it('cuts 50 and 50 to 40 and 40', () => {
    expect(expectOk(json({ targets: { NVDA: 50, MSFT: 50 }, reason: 'Two names.' })).targetsBps).toEqual({
      NVDA: 4_000,
      MSFT: 4_000,
    });
  });

  it('cuts 100 in one symbol to 40', () => {
    expect(expectOk(json({ targets: { NVDA: 100 }, reason: 'All in.' })).targetsBps).toEqual({ NVDA: 4_000 });
  });

  it('leaves a weight of 40 or less as it was written', () => {
    expect(expectOk(json({ targets: { NVDA: 40, MSFT: 39.99 }, reason: 'Two names.' })).targetsBps).toEqual({
      NVDA: 4_000,
      MSFT: 3_999,
    });
  });

  it('refuses 100.01 whatever else is in the answer', () => {
    expectCode(json({ targets: { NVDA: 100.01 }, reason: 'Buys.' }), 'weight_out_of_range');
    expectCode(json({ targets: { NVDA: 10, MSFT: 100.01 }, reason: 'Buys.' }), 'weight_out_of_range');
  });
});

describe('parseDecisionOutput: rule 5, the weights as written add up to 100 at most', () => {
  it('refuses 60 and 60: the sum is taken before the cap, so a model cannot hide an over-allocation', () => {
    expectCode(json({ targets: { NVDA: 60, MSFT: 60 }, reason: 'Two names.' }), 'weights_exceed_100');
  });

  it('accepts 100 in total even when single weights are cut', () => {
    const ok = expectOk(json({ targets: { NVDA: 50, MSFT: 50 }, reason: 'Two names.' }));
    expect(Object.values(ok.targetsBps).reduce((a, b) => a + b, 0)).toBe(8_000);
  });

  it('refuses 100.01 in total as weights_exceed_100, not scaled down', () => {
    expectCode(json({ targets: { NVDA: 40, MSFT: 40, AAPL: 20.01 }, reason: 'Too much.' }), 'weights_exceed_100');
  });

  it('refuses four names at 40', () => {
    expectCode(
      json({ targets: { NVDA: 40, MSFT: 40, AAPL: 40, TSLA: 40 }, reason: 'Too much.' }),
      'weights_exceed_100',
    );
  });

  it('checks the total before the reason', () => {
    expectCode(json({ targets: { NVDA: 40, MSFT: 40, AAPL: 40 }, reason: '' }), 'weights_exceed_100');
  });
});

describe('parseDecisionOutput: rule 6, the reason', () => {
  const withReason = (reason: string) => json({ targets: { NVDA: 10 }, reason });

  it('collapses whitespace and trims', () => {
    expect(expectOk(withReason('  Adds\n\tto   NVDA.\r\n ')).reason).toBe('Adds to NVDA.');
  });

  it('removes control characters', () => {
    const reason = expectOk(withReason('Adds\u0000 to\u0007\u001b NVDA\u007f.')).reason;
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the test looks for control characters
    expect(reason).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(reason).toContain('Adds');
    expect(reason).toContain('NVDA');
  });

  it.each([
    ['an empty reason', ''],
    ['a reason of spaces', '    '],
    ['a reason of line breaks', '\n\n\t'],
    ['a reason of control characters', '\u0000\u0001\u007f'],
  ])('refuses %s as reason_invalid', (_name, reason) => {
    expectCode(withReason(reason), 'reason_invalid');
  });

  it('keeps a reason of exactly REASON_MAX characters', () => {
    const reason = 'a'.repeat(REASON_MAX);
    expect(expectOk(withReason(reason)).reason).toBe(reason);
  });

  it('cuts a longer reason to REASON_MAX characters and ends it with an ellipsis', () => {
    const reason = expectOk(withReason(`${'word '.repeat(200)}end`)).reason;
    expect(reason.length).toBeLessThanOrEqual(REASON_MAX);
    expect(reason.endsWith('…')).toBe(true);
    expect(reason.startsWith('word word')).toBe(true);
  });

  it('keeps markup as plain text: it is escaped where it is shown, not here', () => {
    expect(expectOk(withReason('<b>Adds</b> to NVDA.')).reason).toBe('<b>Adds</b> to NVDA.');
  });
});

describe('parseDecisionOutput: the order of the rules', () => {
  it('reports the JSON before anything else', () => {
    expectCode('{"targets":{"XXXX":99},"reason":""', 'invalid_json');
  });

  it('reports the shape before symbols, weights and the reason', () => {
    expectCode(json({ targets: { XXXX: 99 }, reason: '', extra: true }), 'schema_mismatch');
  });

  it('reports an unknown symbol before the total and the reason', () => {
    expectCode(json({ targets: { NVDA: 40, MSFT: 40, AAPL: 40, XXXX: 1 }, reason: '' }), 'unknown_symbol');
  });

  it('reports a weight out of range before the total and the reason', () => {
    expectCode(json({ targets: { NVDA: 40, MSFT: 40, AAPL: 100.01 }, reason: '' }), 'weight_out_of_range');
  });

  it('checks every key for rule 3 before rule 4 for any key: the code is unknown_symbol whatever the order', () => {
    expectCode('{"targets":{"NVDA":99,"XXXX":1},"reason":"Buys."}', 'unknown_symbol');
    expectCode('{"targets":{"XXXX":1,"NVDA":99},"reason":"Buys."}', 'unknown_symbol');
    expectCode('{"targets":{"NVDA":-5,"XXXX":1},"reason":"Buys."}', 'unknown_symbol');
    expectCode('{"targets":{"XXXX":1,"NVDA":100.01,"MSFT":-1},"reason":"Buys."}', 'unknown_symbol');
  });
});

describe('parseDecisionOutput: never a crash, never a bad decision', () => {
  it('returns a result for any text, and every accepted result obeys the limits', () => {
    const rng = createRng(401);
    const atoms: unknown[] = [null, true, 0, -1, 40, 40.01, 12.5, 1e21, '', 'x', 'NVDA', [], {}, { NVDA: 10 }, [1, 2]];
    const keys = ['targets', 'reason', 'NVDA', 'MSFT', 'AAPL', 'TSLA', 'XXXX', '__proto__', 'extra'];
    const randomValue = (depth: number): unknown => {
      if (depth > 2 || rng.chance(0.4)) return rng.pick(atoms);
      const out: Record<string, unknown> = {};
      for (let i = 0, count = rng.int(0, 4); i < count; i += 1) {
        Object.defineProperty(out, rng.pick(keys), {
          value: randomValue(depth + 1),
          enumerable: true,
          configurable: true,
        });
      }
      return out;
    };
    const randomDecision = (): unknown => {
      const targets: Record<string, number> = {};
      for (const symbol of rng.shuffle(SYMBOLS).slice(0, rng.int(0, 4))) {
        targets[symbol] = rng.pick([0, 5, 10.5, 25, 33.33, 40, 40.01, -1, 21.005, rng.int(0, 45)]);
      }
      return { targets, reason: rng.pick(['Buys.', '', '  ', 'a'.repeat(500), 'Line\nbreak.']) };
    };

    let accepted = 0;
    for (let index = 0; index < 5_000; index += 1) {
      const value = rng.chance(0.6) ? randomDecision() : randomValue(0);
      let raw = JSON.stringify(value) ?? 'undefined';
      if (rng.chance(0.1)) raw = raw.slice(0, rng.int(0, raw.length));
      if (rng.chance(0.05)) raw = `\`\`\`json\n${raw}\n\`\`\``;

      let result: DecisionParse;
      try {
        result = parse(raw);
      } catch (error) {
        throw new Error(`case ${index} threw for ${raw}: ${(error as Error).message}`);
      }
      if (!result.ok) {
        expect(noDecisionCodeSchema.safeParse(result.code).success).toBe(true);
        continue;
      }
      accepted += 1;
      let total = 0;
      for (const [symbol, bps] of Object.entries(result.targetsBps)) {
        expect(SYMBOLS).toContain(symbol);
        expect(Number.isInteger(bps)).toBe(true);
        expect(bps).toBeGreaterThan(0);
        expect(bps).toBeLessThanOrEqual(4_000);
        total += bps;
      }
      expect(total).toBeLessThanOrEqual(10_000);
      expect(result.reason.length).toBeGreaterThan(0);
      expect(result.reason.length).toBeLessThanOrEqual(REASON_MAX);
      // biome-ignore lint/suspicious/noControlCharactersInRegex: the test looks for control characters
      expect(result.reason).not.toMatch(/[\u0000-\u001f\u007f]/);
    }
    // The generator must produce both kinds, or the test proves nothing.
    expect(accepted).toBeGreaterThan(50);
    expect(accepted).toBeLessThan(4_950);
  });

  it('does not mutate the list of symbols', () => {
    const symbols = Object.freeze(['NVDA', 'MSFT']);
    expect(() => parseDecisionOutput(json({ targets: { NVDA: 10 }, reason: 'Buys.' }), symbols)).not.toThrow();
    expect(symbols).toEqual(['NVDA', 'MSFT']);
  });
});
