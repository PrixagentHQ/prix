import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fromKey, REPORT_ANSWER_AFTER_MS, tooSoon } from './report.ts';

/**
 * The guard of the question's yes (the second confirming look at round 2, P2): two presses at one point
 * must not report where the yes comes to lie under the pointer. The page driver (check-pictures.mjs) holds
 * the behaviour in a browser; this pins the rule itself and where the script applies it.
 */

/** A click as a browser hands it over. */
const mouse = { detail: 1, pointerType: 'mouse' };
const second = { detail: 2, pointerType: 'mouse' };
const finger = { detail: 1, pointerType: 'touch' };
const pen = { detail: 1, pointerType: 'pen' };
/** A browser whose click is a plain mouse event says no pointer type at all. */
const plainMouse = { detail: 1 };
const key = { detail: 0, pointerType: '' };
const plainKey = { detail: 0 };

describe('a press on the yes of a report', () => {
  it('waits 700 ms after the question opened', () => {
    expect(REPORT_ANSWER_AFTER_MS).toBe(700);
  });

  it.each([
    ['a mouse', mouse],
    ['the second click of a double click', second],
    ['a finger', finger],
    ['a pen', pen],
    ['a mouse in a browser that names no pointer', plainMouse],
  ])('from %s is no answer until the question has stood', (_name, press) => {
    for (const after of [0, 21, 120, 300, 500, 699, 699.9]) expect(tooSoon(press, 1_000, 1_000 + after)).toBe(true);
    for (const after of [700, 701, 5_000]) expect(tooSoon(press, 1_000, 1_000 + after)).toBe(false);
  });

  it.each([
    ['a key', key],
    ['a key in a browser that names no pointer', plainKey],
  ])('from %s is an answer at once', (_name, press) => {
    for (const after of [0, 13, 699, 700]) expect(tooSoon(press, 1_000, 1_000 + after)).toBe(false);
  });

  it('is a key’s only when it carries no click count and names no pointer: both, never one', () => {
    expect(fromKey(key)).toBe(true);
    expect(fromKey(plainKey)).toBe(true);
    // No click count, and a pointer named: a pointer.
    for (const pointerType of ['mouse', 'touch', 'pen', 'other', null, 0]) {
      expect(fromKey({ detail: 0, pointerType })).toBe(false);
    }
    // A click count, and no pointer named: a pointer.
    for (const detail of [1, 2, 3, -1, Number.NaN]) {
      expect(fromKey({ detail, pointerType: '' })).toBe(false);
      expect(fromKey({ detail })).toBe(false);
    }
  });
});

describe('the script of a report', () => {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const report = readFileSync(`${here}report.ts`, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('keeps the time a question opened, and compares it before the yes is taken as an answer', () => {
    expect(report).toMatch(/since: performance\.now\(\)/);
    const at = report.search(/target\.closest\(`\[\$\{ROOM_PICTURE_DOM\.reportYes\}\]`\)/);
    expect(at).toBeGreaterThan(-1);
    const yes = report.slice(at);
    const guard = yes.indexOf('if (tooSoon(event, asked.since, performance.now())) return;');
    expect(guard).toBeGreaterThan(-1);
    // Before the question is let go of and before the one call.
    expect(guard).toBeLessThan(yes.indexOf('asked = null'));
    expect(guard).toBeLessThan(yes.indexOf('void send('));
  });

  it('runs no timer for it: the question does not close or answer by itself', () => {
    expect(report).not.toMatch(/\bset(?:Interval|Timeout)\b|\brequestAnimationFrame\b/);
    expect(report.match(/performance\.now\(\)/g)).toHaveLength(2);
  });
});
