/**
 * Geometry for the charts of the site: the sparkline, the static equity curve and the line chart.
 * Pure functions: numbers in, coordinates out. They draw what they are given and compute
 * no statistic. docs/DESIGN.md section 8 holds the rules.
 */

export type Domain = readonly [min: number, max: number];

/** The view box of a sparkline, three to one. The line keeps `pad` clear of the top and bottom. */
export const SPARK = { width: 120, height: 40, pad: 4 } as const;

/** The view box of the equity curve. `top` and `bottom` are the y of the highest and lowest value. */
export const CURVE = { width: 1000, height: 1000, top: 120, bottom: 800 } as const;

/** The view box of the line chart. The line keeps 14% of its range clear above and below. */
export const LINE = { width: 1000, height: 260 } as const;

const round = (value: number): number => Math.round(value * 100) / 100;

let areas = 0;

/**
 * A fresh id for the gradient under one line. Each Chart and Sparkline draws its own, so the
 * id only has to be unique on the page; a counter for the life of the process is.
 */
export function areaId(): string {
  areas = (areas + 1) % 1_000_000_000;
  return `area-${areas}`;
}

/**
 * The area under a sparkline, as the points of a polygon: the line, then down to the foot of
 * the view box at its last x and back along the foot to its first x.
 */
export function sparkArea(points: string): string {
  const pairs = points.split(' ').filter(Boolean);
  const first = pairs[0]?.split(',')[0];
  const last = pairs.at(-1)?.split(',')[0];
  if (pairs.length < 2 || first === undefined || last === undefined) return '';
  return `${points} ${last},${SPARK.height} ${first},${SPARK.height}`;
}

/** The area under the line chart: the path of `linePlot`, closed along the foot of the plot. */
export function lineArea(d: string): string {
  return d ? `${d}L${LINE.width} ${LINE.height}L0 ${LINE.height}Z` : '';
}

/**
 * The one vertical scale that every sparkline of a table shares, so that a flat line means
 * a quiet agent and not a rescaled one. Pass every row's values.
 */
export function sparkDomain(rows: readonly (readonly number[])[]): Domain {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    for (const value of row) {
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }
  return min <= max ? [min, max] : [0, 0];
}

/** The longest row: the number of slots every sparkline of the table is laid out on. */
export function sparkSlots(rows: readonly (readonly number[])[]): number {
  return rows.reduce((longest, row) => Math.max(longest, row.length), 0);
}

/** The y of one value on a sparkline. A domain with no range puts every value on the middle line. */
export function sparkY(value: number, domain: Domain): number {
  const [min, max] = domain;
  const span = max - min;
  const inner = SPARK.height - 2 * SPARK.pad;
  const clamped = Math.min(max, Math.max(min, value));
  return round(span > 0 ? SPARK.pad + ((max - clamped) / span) * inner : SPARK.height / 2);
}

/**
 * The points of a sparkline. With `slots` larger than the number of values the line ends at
 * the right edge and starts late, so an agent that joined late does not look stretched.
 * Returns an empty string for fewer than two values: one value is not a line.
 */
export function sparkPoints(values: readonly number[], domain: Domain, slots: number = values.length): string {
  if (values.length < 2) return '';
  const step = (SPARK.width - 6) / (Math.max(slots, values.length) - 1);
  return values
    .map((value, index) => {
      const x = SPARK.width - 3 - (values.length - 1 - index) * step;
      return `${round(x)},${sparkY(value, domain)}`;
    })
    .join(' ');
}

export interface CurveDay {
  /** The portfolio value at the end of the day. */
  value: number;
  /** True for a day the market was closed. The line is flat and the day is shaded. */
  closed?: boolean;
}

export interface CurveGeometry {
  /** The polyline: the starting value at the left edge, then one point at the end of each day. */
  points: string;
  /** The y of the starting value, where the dotted baseline runs. */
  startY: number;
  /** The x and y of the latest value. */
  end: { x: number; y: number };
  /** One shaded band per run of closed days. */
  bands: Array<{ x: number; width: number }>;
  /** The x and y of the end of day `index`, counted from 1. */
  at(index: number): { x: number; y: number };
}

/**
 * The equity curve. Each day is one segment of equal width; the line runs from the previous
 * close to this day's close. The scale always contains the starting value.
 */
export function curveGeometry(start: number, days: readonly CurveDay[]): CurveGeometry {
  const values = [start, ...days.map((day) => day.value)];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const step = days.length > 0 ? CURVE.width / days.length : CURVE.width;
  const y = (value: number): number =>
    span > 0 ? round(CURVE.top + ((max - value) / span) * (CURVE.bottom - CURVE.top)) : (CURVE.top + CURVE.bottom) / 2;
  const x = (index: number): number => round(index * step);

  const bands: Array<{ x: number; width: number }> = [];
  days.forEach((day, index) => {
    if (!day.closed) return;
    const last = bands[bands.length - 1];
    if (last && Math.abs(last.x + last.width - x(index)) < 0.01) last.width = round(last.width + step);
    else bands.push({ x: x(index), width: round(step) });
  });

  return {
    points: values.map((value, index) => `${x(index)},${y(value)}`).join(' '),
    startY: y(start),
    end: { x: x(days.length), y: y(values[values.length - 1] ?? start) },
    bands,
    at: (index) => ({ x: x(index), y: y(values[index] ?? start) }),
  };
}

export interface LinePlot {
  /** The path of the line in the view box of `LINE`. */
  d: string;
  /** The value at the bottom edge and at the top edge of the plot. */
  lo: number;
  hi: number;
  /** The values of the grid lines, lowest first. Round numbers, five at most. */
  ticks: number[];
  /** The y of a value, in percent of the height of the plot. */
  y(value: number): number;
}

const STEPS = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10_000, 20_000, 50_000];

/**
 * The line chart: one point per value, spread evenly over the width. `include` is a value the
 * scale must contain, such as the value a season starts with. The crosshair script places a
 * point with the same two numbers, `lo` and `hi`, so the server and the browser agree.
 */
export function linePlot(values: readonly number[], include?: number): LinePlot {
  const all = include === undefined ? [...values] : [...values, include];
  const min = all.length > 0 ? Math.min(...all) : 0;
  const max = all.length > 0 ? Math.max(...all) : 0;
  const pad = (max - min) * 0.14 || Math.max(Math.abs(max) * 0.005, 1);
  const lo = min - pad;
  const hi = max + pad;
  const step = STEPS.find((size) => (hi - lo) / size <= 5) ?? 100_000;
  const y = (value: number): number => round(((hi - value) / (hi - lo)) * 100);
  const ticks: number[] = [];
  for (let tick = Math.ceil(lo / step) * step; tick <= hi; tick += step) ticks.push(tick);
  const last = Math.max(1, values.length - 1);
  const d = values
    .map((value, index) => {
      const x = round((index / last) * LINE.width);
      return `${index === 0 ? 'M' : 'L'}${x} ${round((y(value) / 100) * LINE.height)}`;
    })
    .join('');
  return { d, lo, hi, ticks, y };
}

export interface AxisDate {
  /** The index of the point the date names, among the points the plot shows. */
  index: number;
  /** The x of that point in percent of the width of the plot: the x `linePlot` draws it at. */
  x: number;
  /** How the label hangs on its point: the first from its left edge, the last from its right, the rest centred. */
  anchor: 'start' | 'middle' | 'end';
}

/**
 * The points of a line chart that carry a date under the plot: both ends and up to three
 * between them, as evenly spread as the points allow. Each date is printed on its own point's
 * x, so the date the crosshair names always matches the axis under it.
 */
export function axisDates(count: number, labels = 5): AxisDate[] {
  if (count < 1) return [];
  if (count === 1) return [{ index: 0, x: 0, anchor: 'start' }];
  const last = count - 1;
  const wanted = Math.max(2, Math.min(labels, count));
  const picks = [...new Set(Array.from({ length: wanted }, (_, at) => Math.round((at / (wanted - 1)) * last)))];
  return picks.map((index) => ({
    index,
    x: round((index / last) * 100),
    anchor: index === 0 ? 'start' : index === last ? 'end' : 'middle',
  }));
}

/** Up to this many points, every point carries its date at every width. */
export const EVERY_DATE_UP_TO = 5;

/**
 * Whether date `at` of the `shown` dates of a plot of `count` points gives way under 560
 * pixels. With five points or fewer every date stays: a short war or a new rivalry names each
 * of its days. Above that, every other date between the ends gives way, so two dates never meet.
 */
export function givesWayWhenNarrow(count: number, at: number, shown: number): boolean {
  return count > EVERY_DATE_UP_TO && at % 2 === 1 && at < shown - 1;
}

/** U+2212, the minus sign of every figure on the site. */
const MINUS = '−';

/**
 * A return as the site writes it, worked out for display from a portfolio value and the value
 * the season started with: 10684 on 10000 is "+6.84%", 9808 is "−1.92%", and a value that
 * rounds to no change is "0.00%", with no sign and no tone. A half rounds away from zero and
 * thousands are grouped, as in content/format.ts. It decides nothing: the record's return is
 * the API's.
 */
export function returnFigure(value: number, start: number): { text: string; tone?: 'gain' | 'loss' } {
  if (!(start > 0) || !Number.isFinite(value)) return { text: '0.00%' };
  const raw = ((value - start) / start) * 10_000;
  // Hundredths of a percent. The small epsilon absorbs the float error of the division, so 0.5 rounds up.
  const size = Math.round(Math.abs(raw) + 1e-9);
  const whole = String(Math.floor(size / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = `${whole}.${String(size % 100).padStart(2, '0')}%`;
  if (size > 0 && raw > 0) return { text: `+${body}`, tone: 'gain' };
  if (size > 0 && raw < 0) return { text: `${MINUS}${body}`, tone: 'loss' };
  return { text: body };
}
