// Fixed sets of sizes that primitives.css reads as classes. A value a page passes as a CSS
// length ("7rem", "120px", "16%") maps to the nearest member of its set, so no primitive
// writes a style attribute (the site's Content-Security-Policy blocks them).

/** Converts "7rem", "112px" or "7" to rem, or a percentage string to its number. */
function toNumber(value: string, unit: 'rem' | '%'): number | undefined {
  const match = /^\s*(\d*\.?\d+)\s*(rem|em|px|%)?\s*$/.exec(value);
  if (!match) return undefined;
  const n = Number(match[1]);
  const given = match[2] ?? unit;
  if (unit === '%') return given === '%' ? n : undefined;
  if (given === 'px') return n / 16;
  if (given === '%') return undefined;
  return n;
}

function nearest(value: string | undefined, unit: 'rem' | '%', set: readonly number[]): number | undefined {
  if (!value) return undefined;
  const n = toNumber(value, unit);
  if (n === undefined) return undefined;
  return set.reduce((best, step) => (Math.abs(step - n) < Math.abs(best - n) ? step : best));
}

const slug = (n: number) => String(n).replace('.', '-');

export const LABEL_WIDTHS = [5.5, 7, 8.5, 10, 12] as const;
export const NOTICE_HEIGHTS = [8, 12, 16, 20, 24, 32] as const;
export const TABLE_MINS = [28, 32, 36, 40, 48, 56] as const;
export const COLUMN_WIDTHS = [8, 10, 12, 15, 16, 20, 25, 30, 35, 40, 50] as const;

export const labelWidthClass = (v?: string) => {
  const n = nearest(v, 'rem', LABEL_WIDTHS);
  return n === undefined || n === 5.5 ? undefined : `facts--label-${slug(n)}`;
};
export const noticeHeightClass = (v?: string) => {
  const n = nearest(v, 'rem', NOTICE_HEIGHTS);
  return n === undefined ? undefined : `notice--h-${slug(n)}`;
};
export const tableMinClass = (v?: string) => {
  const n = nearest(v, 'rem', TABLE_MINS);
  return n === undefined ? undefined : `table--min-${slug(n)}`;
};
export const columnWidthClass = (v?: string) => {
  const n = nearest(v, '%', COLUMN_WIDTHS);
  return n === undefined ? undefined : `w-${n}`;
};
