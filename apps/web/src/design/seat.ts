/**
 * The mark of Prix, "Seat" (docs/DECISIONS.md D-111): a square with one round seat cut into its
 * top-left corner, first place in every table and the one agent that holds it. The square is the
 * ink of the ground it stands on; the seat is the action blue of that ground.
 *
 * One drawing in three cuts. The master is drawn on a grid of 32 and scales freely. The two
 * small cuts are snapped to the pixel grid of a 32 and a 16 pixel favicon, where the master's
 * ring would fall between pixels.
 *
 * PrixMark.astro, ShareImage.astro and mark-export.mjs (favicon.svg, the favicon PNGs, the token
 * image) all read the paths from here, so the mark has one source.
 */

export interface SeatCut {
  /** The view box of the cut, square, from 0. */
  grid: number;
  /** The square's ink area: the drawn square, from `edge` to `grid - edge` on both axes. */
  edge: number;
  /** The square with the ring cut out of its corner. */
  square: string;
  /** The round seat. */
  seat: string;
}

/** The master drawing, on a grid of 32. Its ink is the square from 3 to 29. */
export const SEAT: SeatCut = {
  grid: 32,
  edge: 3,
  square: 'M15.815 3H29V29H3V15.815A9.1 9.1 0 1 0 15.815 3Z',
  seat: 'M17 10A7 7 0 1 1 3 10A7 7 0 1 1 17 10Z',
};

/** Snapped for 32 pixels: the ring is a whole 2 pixels wide. */
export const SEAT_32: SeatCut = {
  grid: 32,
  edge: 3,
  square: 'M15.657 3H29V29H3V15.657A9 9 0 1 0 15.657 3Z',
  seat: 'M17 10A7 7 0 1 1 3 10A7 7 0 1 1 17 10Z',
};

/** Snapped for 16 pixels: the square from 1 to 15, the ring 1.5 pixels wide. */
export const SEAT_16: SeatCut = {
  grid: 16,
  edge: 1,
  square: 'M8.071 1H15V15H1V8.071A5 5 0 1 0 8.071 1Z',
  seat: 'M8 4.5A3.5 3.5 0 1 1 1 4.5A3.5 3.5 0 1 1 8 4.5Z',
};

/** The view box that holds only the drawn square of a cut, for a mark set beside a word. */
export function seatBox(cut: SeatCut): string {
  const side = cut.grid - 2 * cut.edge;
  return `${cut.edge} ${cut.edge} ${side} ${side}`;
}

/** The inks of the mark on each ground: the site's own --ink and --blue (tokens.css). */
export const SEAT_INKS = {
  light: { square: '#23272d', seat: '#1452f0', ground: '#f2f4f7' },
  dark: { square: '#f3f4f6', seat: '#4c8dff', ground: '#0a0b0d' },
} as const;
