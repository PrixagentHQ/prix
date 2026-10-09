/**
 * The plates of every species on the small grid, as avatar.ts stacks them, and the compact form
 * they are kept in (plates.data.ts). The plates are drawn from the shapes by plates-draw.ts when
 * `node apps/web/src/design/ascii/tools/plates.ts` writes the data file. The site never draws
 * them and does not even decode them into arrays: avatar.ts reads each value from the data
 * where it lies. A test (animal.test.ts) draws them again and fails when the file is out of date.
 *
 * Each species has 36 slots, in this order:
 *   back 6 and front 6, by `trait * 3 + lean` (leans of LEANS), at the coat COAT;
 *   eyes 4, by kind (EYES);
 *   markings 12, by `marking * 2 + (side > 0 ? 1 : 0)` (MARKINGS), empty where the species has none;
 *   accessories 8, by accessory (ACCESSORIES), empty where the species wears none.
 * A slot is the count of the cells it covers (two bytes, low first), then five bytes a cell: the
 * cell's index (two bytes, low first), its coverage, its ink on the dark ground and its ink on
 * the light ground, each in 255ths. The whole is base64.
 */
import type { Plate } from './paint.ts';

export const GRID_COLS = 20;
export const GRID_ROWS = 16;
export const CELLS = GRID_COLS * GRID_ROWS;

/**
 * The two grids that have plates: `small` (20 by 16, plates.data.ts) for a mark or avatar of 48
 * pixels and up, and `mark` (12 by 10, plates-mark.data.ts, framing.ts) under 48. Both use the
 * layout below; the mark's markings and accessories are empty slots.
 */
export type PlateSize = 'small' | 'mark';
/** The three leans a species is drawn in. A character's lean (-1 to 1) takes the nearest. */
export const LEANS = [-0.6, 0, 0.6] as const;
/** The coat every species plate is drawn in; a character's own coat scales it. */
export const COAT = 0.6;

export const SLOTS = { back: 0, front: 6, eyes: 12, markings: 16, accessories: 28, count: 36 } as const;
/** Bytes a cell takes in the data. */
export const CELL_BYTES = 5;

/** A plate as plates-draw.ts draws it: whole arrays, and the cells it covers at all. */
export interface DrawnPlate extends Plate {
  readonly cells: Uint16Array;
}

export interface DrawnSpecies {
  readonly back: readonly DrawnPlate[];
  readonly front: readonly DrawnPlate[];
  readonly eyes: readonly DrawnPlate[];
  readonly markings: readonly (DrawnPlate | undefined)[];
  readonly accessories: readonly (DrawnPlate | undefined)[];
}

/**
 * Where each slot lies in the data: `start[species * 36 + slot]` is the offset of its first
 * cell and `count[...]` the number of its cells (0 for an empty slot).
 */
export interface PlateIndex {
  readonly bytes: string;
  readonly start: Uint32Array;
  readonly count: Uint16Array;
}

function byte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value * 255)));
}

/** The plates of every species, in the order given, as the base64 of plates.data.ts. */
export function encodePlates(all: readonly DrawnSpecies[]): string {
  let binary = '';
  for (const plates of all) {
    const slots = [...plates.back, ...plates.front, ...plates.eyes, ...plates.markings, ...plates.accessories];
    for (const slot of slots) {
      const cells = slot ? [...slot.cells].filter((at) => byte(slot.alpha[at] as number) > 0) : [];
      binary += String.fromCharCode(cells.length & 255, cells.length >> 8);
      for (const at of cells) {
        const each = slot as DrawnPlate;
        binary += String.fromCharCode(
          at & 255,
          at >> 8,
          byte(each.alpha[at] as number),
          byte(each.glow[at] as number),
          byte(each.ink[at] as number),
        );
      }
    }
  }
  return btoa(binary);
}

/** The index of the data of `species` species: one pass over the counts, nothing copied. */
export function indexPlates(data: string, species: number): PlateIndex {
  // `atob` skips the line breaks of the data file.
  const bytes = atob(data);
  const slots = species * SLOTS.count;
  const start = new Uint32Array(slots);
  const count = new Uint16Array(slots);
  let read = 0;
  for (let slot = 0; slot < slots; slot += 1) {
    const cells = bytes.charCodeAt(read) | (bytes.charCodeAt(read + 1) << 8);
    start[slot] = read + 2;
    count[slot] = cells;
    read += 2 + cells * CELL_BYTES;
  }
  if (read !== bytes.length) throw new Error('plates.data.ts does not match the layout of plates.ts.');
  return { bytes, start, count };
}
