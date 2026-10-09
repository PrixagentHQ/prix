/**
 * The ground of the page head: a field of characters (docs/DESIGN.md section 2.3).
 *
 * The same field as the X banner of 2026-10-08 (`.artifacts/x/build.html`): one character per
 * cell of a monospace grid, read off a smooth function over the ramp " .:-=+*#%@". It is densest
 * at its core and falls to nothing on every side. A slow ripple of two waves bends its contours,
 * so the field reads as the levels of one surface, never as a scatter. There is no randomness
 * and no seed: the field is the same on every page, every server and every load. One tone: the
 * banner's second, brighter tone for the core read as a drawing (revision 10).
 *
 * The function's distances are in CSS pixels from a frame 210 pixels right of the core (the top
 * right corner of the banner). The grid reaches FIELD_OVERHANG further right than that frame,
 * past the last character, so the field fades out on its right as well: the stylesheet sets the
 * core on the right edge of the content at every width, and where the window is wider than the
 * content the field never ends in a cut line.
 *
 * The site never runs this. Built in workerd, the field costs 0.86 ms, and about 13 ms in the
 * first request of a cold isolate, more than a request's whole budget. So it is built when the
 * code is written: `node apps/web/src/design/ground/tools/field.ts` writes the markup into
 * field.data.ts, which the layout prints as it is, and field.test.ts fails when that file is not
 * what this function draws today.
 */

/** The ramp of the banner, faintest first. A cell's value picks its character. */
export const FIELD_RAMP = ' .:-=+*#%@';

/** A cell: the face's advance at 12 pixels (0.6 em) by a line of 14. Keep in step with ground.css. */
export const CELL = { width: 7.2, height: 14 } as const;

/** The grid: 1008 by 476 pixels, the whole field from nothing on its left to nothing on its right. */
export const FIELD_COLUMNS = 140;
export const FIELD_ROWS = 34;

/** The densest point of the field, from the function's frame, in pixels. */
const CORE = { right: 210, down: 70 };
/** How far the field reaches from its core before it is nothing: across, and down. */
const REACH = { across: 500, down: 400 };

/** How far the grid reaches right of the function's frame: 28 cells, past the last character. */
export const FIELD_OVERHANG = 28 * CELL.width;
/**
 * From the grid's right edge, in pixels: the core, and the line from which the field is nothing
 * to the left. ground.css uses both (411.6px and 830px); keep it in step.
 */
export const FIELD_CORE_FROM_RIGHT = CORE.right + FIELD_OVERHANG;
export const FIELD_NOTHING_FROM_RIGHT = 830;

/**
 * The value of the field at a point, 0 (nothing) to just under 1, from its distance in pixels to
 * the function's frame: right of it, and below the top. The banner's function, set in pixels.
 */
export function fieldValue(fromRight: number, fromTop: number): number {
  const distance = Math.hypot((fromRight - CORE.right) / REACH.across, (fromTop - CORE.down) / REACH.down);
  const x = fromRight / 1500;
  const y = fromTop / 500;
  const ripple = 0.1 * Math.sin(x * 31 + y * 7) * Math.cos(y * 13 - x * 5);
  const value = 0.78 - distance * 0.95 + ripple;
  return Math.max(0, Math.min(0.999, value));
}

/** The character of a value. */
export function fieldCharacter(value: number): string {
  return FIELD_RAMP[Math.floor(value * FIELD_RAMP.length)] ?? ' ';
}

/** The distance of a column's centre from the grid's right edge, in pixels. */
export function columnFromRight(column: number): number {
  return (FIELD_COLUMNS - 1 - column + 0.5) * CELL.width;
}

/** The rows of the field as characters, left to right, the last column on the grid's right edge. */
export function fieldRows(): string[][] {
  const rows: string[][] = [];
  for (let row = 0; row < FIELD_ROWS; row += 1) {
    const cells: string[] = [];
    for (let column = 0; column < FIELD_COLUMNS; column += 1) {
      const fromTop = (row + 0.5) * CELL.height;
      cells.push(fieldCharacter(fieldValue(columnFromRight(column) - FIELD_OVERHANG, fromTop)));
    }
    rows.push(cells);
  }
  return rows;
}

/**
 * The markup of the field: one line per row inside the layout's `.ground`, set right-aligned.
 * Each row keeps its trailing blanks and loses its leading ones. Only the ramp's characters, so
 * nothing needs escaping.
 */
export function fieldMarkup(): string {
  return fieldRows()
    .map((cells) => cells.join('').trimStart())
    .join('\n');
}
