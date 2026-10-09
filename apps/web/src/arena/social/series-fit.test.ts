import { describe, expect, it } from 'vitest';
import { fitEnds, labelPositions, lastValues } from './series-fit.ts';

const inside = (positions: number[]) => positions.every((value) => value >= 5 && value <= 95);

describe('fitEnds', () => {
  it('keeps a range whose names already sit inside the plot', () => {
    expect(fitEnds([10_050, 10_000], 10_100, 9_950)).toEqual({ top: 10_100, bottom: 9_950 });
  });

  it('widens the bottom when four names ending together are pushed onto the bottom edge', () => {
    const ends = [9_960, 9_961, 9_962, 9_963];
    expect(inside(labelPositions(ends, 10_100, 9_950))).toBe(false);
    const range = fitEnds(ends, 10_100, 9_950);
    expect(range.top).toBe(10_100);
    expect(range.bottom).toBeLessThan(9_950);
    expect(inside(labelPositions(ends, range.top, range.bottom))).toBe(true);
  });

  it('widens the top of a rank scale, the better rank at the top', () => {
    const range = fitEnds([3, 4], 2.6, 6.4);
    expect(inside(labelPositions([3, 4], range.top, range.bottom))).toBe(true);
    expect(range.top).toBeLessThanOrEqual(2.6);
  });

  it('changes nothing without a name', () => {
    expect(fitEnds([], 1, 2)).toEqual({ top: 1, bottom: 2 });
  });
});

describe('lastValues', () => {
  it('takes the last value of each line and skips a line without one', () => {
    expect(lastValues([{ values: [1, 2, null] }, { values: [null, null] }, { values: [5] }])).toEqual([2, 5]);
  });
});
