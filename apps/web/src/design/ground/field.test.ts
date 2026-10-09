// The field of characters behind the page head is smooth, deterministic, in one tone, densest at
// its core, nothing on every side, and printed as drawn today.
// Run: pnpm exec vitest run --root apps/web/src/design/ground --config <a config whose include is
// ['**/*.test.ts']>; the root config of the repository collects only tests/.
import { describe, expect, it } from 'vitest';
import { FIELD_MARKUP } from './field.data.ts';
import {
  CELL,
  columnFromRight,
  FIELD_CORE_FROM_RIGHT,
  FIELD_NOTHING_FROM_RIGHT,
  FIELD_OVERHANG,
  FIELD_RAMP,
  FIELD_ROWS,
  fieldMarkup,
  fieldRows,
  fieldValue,
} from './field.ts';

describe('the field of characters', () => {
  it('prints field.data.ts as field.ts draws it today (run tools/field.ts when this fails)', () => {
    expect(FIELD_MARKUP).toBe(fieldMarkup());
  });

  it('is the same on every call: no randomness, no seed', () => {
    expect(fieldMarkup()).toBe(fieldMarkup());
  });

  it('holds only the ramp and line breaks: one tone, no markup, nothing to escape', () => {
    expect(FIELD_MARKUP).toMatch(new RegExp(`^[${FIELD_RAMP.replace('-', '\\-')}\\n]*$`));
    expect(FIELD_MARKUP.split('\n')).toHaveLength(FIELD_ROWS);
  });

  it('is smooth: two cells side by side never differ by more than two steps of the ramp', () => {
    for (const cells of fieldRows()) {
      for (let column = 1; column < cells.length; column += 1) {
        const left = FIELD_RAMP.indexOf(cells[column - 1] ?? ' ');
        const right = FIELD_RAMP.indexOf(cells[column] ?? ' ');
        expect(Math.abs(left - right)).toBeLessThanOrEqual(2);
      }
    }
  });

  it('is densest at its core, 411.6 pixels left of the right edge, as ground.css assumes', () => {
    expect(FIELD_CORE_FROM_RIGHT).toBeCloseTo(411.6, 5);
    expect(fieldValue(FIELD_CORE_FROM_RIGHT - FIELD_OVERHANG, 70)).toBeGreaterThan(0.6);
  });

  it('is nothing from 830 pixels left of its right edge, and in its last column on the right', () => {
    for (const cells of fieldRows()) {
      cells.forEach((character, column) => {
        if (columnFromRight(column) + CELL.width / 2 >= FIELD_NOTHING_FROM_RIGHT) expect(character).toBe(' ');
      });
      expect(cells.at(-1)).toBe(' ');
      expect(cells.at(-2)).toBe(' ');
    }
  });

  it('is nothing in its last rows, so it ends before the head of a page ends', () => {
    const rows = fieldRows();
    for (const cells of rows.slice(-4)) expect(cells.every((character) => character === ' ')).toBe(true);
  });

  it('weighs little in a page: about 3 KB of markup', () => {
    expect(FIELD_MARKUP.length).toBeLessThan(3600);
  });
});
