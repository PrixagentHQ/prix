/**
 * The vertical range of a SeriesChart (design/SeriesChart.astro) that keeps every name at the end
 * of a line whole.
 *
 * The primitive writes each line's name at its last point, nudges names that end close together
 * apart by `LABEL_GAP` percent of the plot, then lifts the whole stack when it runs off the bottom.
 * The names sit in a box that hides what overflows it, so a name nudged onto the bottom edge, or a
 * line that ends on the top edge, loses half its letters. This widens the range just enough, on
 * the side that needs it, that every name lands inside `EDGE` percent of both edges. Geometry only:
 * no value, rank or figure is changed, and the lines keep the order the API gave them.
 *
 * `top` is the value at the top edge and `bottom` the value at the bottom edge; `top` may be the
 * smaller (ranks, the better at the top).
 */

/** The primitive's nudge between two names: one line of 12 pixel text in a 15rem plot. */
const LABEL_GAP = 9;
/** Half a name's height and a little air, in percent of the 15rem plot. */
const EDGE = 5;

/** Where the primitive puts each name, in percent from the top, before its last clamp. */
export function labelPositions(ends: number[], top: number, bottom: number): number[] {
  const y = (value: number): number => ((value - top) / (bottom - top)) * 100;
  const placed = ends.map(y).sort((a, b) => a - b);
  for (let index = 1; index < placed.length; index += 1) {
    const above = placed[index - 1] ?? 0;
    if ((placed[index] ?? 0) - above < LABEL_GAP) placed[index] = above + LABEL_GAP;
  }
  const overflow = (placed.at(-1) ?? 0) - 100;
  return overflow > 0 ? placed.map((value) => value - overflow) : placed;
}

/**
 * The last value of each series that has one, oldest first per series. A series with no value
 * draws no name and is left out.
 */
export function lastValues(series: Array<{ values: Array<number | null> }>): number[] {
  return series
    .map((line) => [...line.values].reverse().find((value): value is number => value !== null))
    .filter((value): value is number => value !== undefined);
}

/** The range, widened where needed, so that every end name is whole inside the plot. */
export function fitEnds(ends: number[], top: number, bottom: number): { top: number; bottom: number } {
  let low = top;
  let high = bottom;
  for (let round = 0; round < 40; round += 1) {
    const placed = labelPositions(ends, low, high);
    const first = placed[0];
    const last = placed.at(-1);
    if (first === undefined || last === undefined) break;
    const span = high - low;
    let moved = false;
    if (first < EDGE) {
      low -= span * 0.04;
      moved = true;
    }
    if (last > 100 - EDGE) {
      high += span * 0.04;
      moved = true;
    }
    if (!moved) break;
  }
  return { top: low, bottom: high };
}
