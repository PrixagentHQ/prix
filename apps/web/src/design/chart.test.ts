// The dates under a line chart sit under their own points, and the return under the crosshair
// is written as the site writes a return. Run: pnpm exec vitest run --root apps/web/src/design
import { describe, expect, it } from 'vitest';
import { axisDates, givesWayWhenNarrow, LINE, linePlot, returnFigure } from './chart.ts';

/** The x of every point of a `linePlot` path, in percent of the width of the plot. */
function pointXs(d: string): number[] {
  return [...d.matchAll(/[ML](-?[\d.]+) /g)].map((match) => (Number(match[1]) / LINE.width) * 100);
}

/** Where motion/crosshair.ts puts the crosshair for point `index` of a range that starts at `first`. */
function crosshairX(index: number, first: number, last: number): number {
  return last === first ? 100 : ((index - first) / (last - first)) * 100;
}

describe('axisDates', () => {
  it('puts each date on the x of the point it names', () => {
    for (let count = 2; count <= 60; count += 1) {
      const values = Array.from({ length: count }, (_, index) => 10_000 + ((index * 37) % 11) * 25);
      const xs = pointXs(linePlot(values, 10_000).d);
      expect(xs).toHaveLength(count);
      for (const date of axisDates(count)) {
        expect(date.x).toBeCloseTo(xs[date.index] ?? Number.NaN, 1);
        expect(date.x).toBeCloseTo(crosshairX(date.index, 0, count - 1), 1);
      }
    }
  });

  it('names both ends and at most five points, in order, without repeats', () => {
    for (let count = 2; count <= 60; count += 1) {
      const dates = axisDates(count);
      const indexes = dates.map((date) => date.index);
      expect(indexes[0]).toBe(0);
      expect(indexes.at(-1)).toBe(count - 1);
      expect(dates.length).toBe(Math.min(5, count));
      expect([...indexes].sort((a, b) => a - b)).toEqual(indexes);
      expect(new Set(indexes).size).toBe(indexes.length);
    }
  });

  it('holds the first date to the left edge and the last to the right', () => {
    const dates = axisDates(26);
    expect(dates[0]).toEqual({ index: 0, x: 0, anchor: 'start' });
    expect(dates.at(-1)).toEqual({ index: 25, x: 100, anchor: 'end' });
    expect(dates.slice(1, -1).every((date) => date.anchor === 'middle')).toBe(true);
  });

  it('places the week of six points where the critic measured the old labels wrong', () => {
    // Six points: the old labels sat at even fifths of the width, the points at 0, 20, 60, 80 and 100.
    expect(axisDates(6).map((date) => [date.index, date.x])).toEqual([
      [0, 0],
      [1, 20],
      [3, 60],
      [4, 80],
      [5, 100],
    ]);
  });
});

describe('givesWayWhenNarrow', () => {
  const kept = (count: number) =>
    axisDates(count)
      .filter((_, at, all) => !givesWayWhenNarrow(count, at, all.length))
      .map((date) => date.index);

  it('keeps every date of a plot of five points or fewer', () => {
    for (let count = 1; count <= 5; count += 1) expect(kept(count)).toEqual(axisDates(count).map((date) => date.index));
  });

  it('drops every other date between the ends above five points, never an end', () => {
    expect(kept(6)).toEqual([0, 3, 5]);
    for (let count = 6; count <= 60; count += 1) {
      const indexes = kept(count);
      expect(indexes[0]).toBe(0);
      expect(indexes.at(-1)).toBe(count - 1);
      expect(indexes).toHaveLength(3);
    }
  });
});

describe('returnFigure', () => {
  it('writes a signed return with two decimals and its tone', () => {
    expect(returnFigure(10_684, 10_000)).toEqual({ text: '+6.84%', tone: 'gain' });
    expect(returnFigure(9_808, 10_000)).toEqual({ text: '−1.92%', tone: 'loss' });
    expect(returnFigure(10_000, 10_000)).toEqual({ text: '0.00%' });
    expect(returnFigure(10_000.4, 10_000)).toEqual({ text: '0.00%' });
    expect(returnFigure(1_244_567, 10_000)).toEqual({ text: '+12,345.67%', tone: 'gain' });
  });

  it('rounds a half away from zero', () => {
    expect(returnFigure(10_000.5, 10_000)).toEqual({ text: '+0.01%', tone: 'gain' });
    expect(returnFigure(9_999.5, 10_000)).toEqual({ text: '−0.01%', tone: 'loss' });
  });

  it('says no change when there is no start to measure from', () => {
    expect(returnFigure(10_500, 0)).toEqual({ text: '0.00%' });
  });
});
