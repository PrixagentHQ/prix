/**
 * The animal of an agent on the small grid (20 by 16), fast enough for a board drawn on a
 * Worker (docs/DESIGN.md section 7). This is the picture `AgentMark` and the 40 and 64 pixel
 * `AsciiAvatar` print.
 *
 * Drawing a character from its shapes costs about 0.22 ms; a board of a hundred would spend
 * twice a request's CPU on pictures. So the picture is cut into plates (plates.ts): each species,
 * its back and its front for each trait and three leans of the ears or horns; its four eyes;
 * each marking on each side; each accessory. The plates are drawn ahead, when the code is
 * written (plates.data.ts), and decoded once when this module loads.
 *
 * Per agent the work is choosing and stacking: the id picks its plates (animal.ts, `character`),
 * its coat scales the brightness of the species' plates, five plates are laid over each other
 * and one grid of characters is written as markup for both themes. The result is kept by id for
 * the life of the isolate.
 *
 * The lean is rounded to the nearest of three and the width of the head is not drawn: on a grid
 * this coarse each moves an edge by less than a cell. The 40 by 32 grid of an agent's large
 * avatar (`asciiAnimal(id, 'large')`) still draws every value exactly.
 */
import { type Character, character, EYES, GRIDS, SPECIES, type Species } from './animal.ts';
import { MARK_GRID } from './framing.ts';
import { blankPlate, finish, type GridSpec, type Plate, RAMP, type Raster } from './paint.ts';
import { PLATE_DATA } from './plates.data.ts';
import { CELL_BYTES, COAT, indexPlates, LEANS, type PlateIndex, type PlateSize, SLOTS } from './plates.ts';
import { MARK_PLATE_DATA } from './plates-mark.data.ts';
import { BARE_TONE } from './render.ts';
import { ACCESSORIES, MARKINGS } from './species.ts';

const GRID = GRIDS.small;

interface PlateSet {
  readonly grid: GridSpec;
  /** Where every plate lies in the data. Building it reads two bytes a plate; nothing is copied. */
  readonly index: PlateIndex;
  /** The plate a character is stacked on. Shared: read it before the next call. */
  readonly scratch: Plate;
}

function plateSet(grid: GridSpec, data: string): PlateSet {
  return { grid, index: indexPlates(data, SPECIES.length), scratch: blankPlate(grid.cols * grid.rows) };
}

/** The 20 by 16 plates (48 pixels and up) and the 12 by 10 plates of a mark under 48 (framing.ts). */
const SETS: Record<PlateSize, PlateSet> = {
  small: plateSet(GRID, PLATE_DATA),
  mark: plateSet(MARK_GRID, MARK_PLATE_DATA),
};
const INK = 1 / 255;

function nearestLean(lean: number): number {
  let best = 0;
  for (let index = 1; index < LEANS.length; index += 1) {
    if (Math.abs((LEANS[index] as number) - lean) < Math.abs((LEANS[best] as number) - lean)) best = index;
  }
  return best;
}

/**
 * Lays the plate in `slot` over what is on the scratch plate, its ink scaled by `scale` (never
 * past its coverage): per cell the plate, then what shows through it. Laying bottom to top gives
 * what `rasterise` gives laying top to bottom, and only the cells the plate covers are touched.
 * The values are read from the data where they lie (plates.ts gives the layout).
 */
function over(set: PlateSet, slot: number, scale: number): void {
  const { glow, ink, alpha } = set.scratch;
  const BYTES = set.index.bytes;
  const count = set.index.count[slot] as number;
  let read = set.index.start[slot] as number;
  for (let index = 0; index < count; index += 1, read += CELL_BYTES) {
    const at = BYTES.charCodeAt(read) | (BYTES.charCodeAt(read + 1) << 8);
    const a = BYTES.charCodeAt(read + 2) * INK;
    const through = 1 - a;
    let g = BYTES.charCodeAt(read + 3) * INK * scale;
    let k = BYTES.charCodeAt(read + 4) * INK * scale;
    if (g > a) g = a;
    if (k > a) k = a;
    glow[at] = g + through * (glow[at] as number);
    ink[at] = k + through * (ink[at] as number);
    alpha[at] = a + through * (alpha[at] as number);
  }
}

/**
 * The plates of a character stacked into one, on the small grid or the mark grid. It is a shared
 * scratch plate: read it before the next call. A mark has no marking and no accessory (framing.ts).
 */
export function stackCharacter(who: Character, size: PlateSize = 'small'): Plate {
  const set = SETS[size];
  const { scratch } = set;
  const first = SPECIES.indexOf(who.species) * SLOTS.count;
  const variant = (who.trait ? 3 : 0) + nearestLean(who.lean);
  const coat = who.coat / COAT;
  scratch.glow.fill(0);
  scratch.ink.fill(0);
  scratch.alpha.fill(0);
  // Bottom first: the back, the marking, the front, the eyes, the accessory (animal.ts, `compose`).
  over(set, first + SLOTS.back + variant, coat);
  const marking = size === 'small' ? MARKINGS.indexOf(who.marking) : 0;
  if (marking > 0) over(set, first + SLOTS.markings + marking * 2 + (who.side > 0 ? 1 : 0), 1);
  over(set, first + SLOTS.front + variant, coat);
  over(set, first + SLOTS.eyes + EYES.indexOf(who.eyes), 1);
  const accessory = size === 'small' ? ACCESSORIES.indexOf(who.accessory) : 0;
  if (accessory > 0) over(set, first + SLOTS.accessories + accessory, 1);
  return scratch;
}

/** The two prints of a character on the small grid, from the plates. */
export function printCharacter(who: Character): { glow: Raster; print: Raster } {
  return finish(stackCharacter(who), GRID);
}

/**
 * The step of the ramp and the tone of a cell, by its brightness in 4096ths: `stepOf` and
 * `toneOf` of paint.ts after the grid's contrast curve, looked up instead of computed, so a cell
 * costs one read and no power. A brightness within a 4096th of a cut may land one step from
 * where `finish` puts it; nothing a reader can see. Both grounds use the one curve (see
 * `markMarkup`), so the light ground prints a little lighter than the `print` of `finish`, whose
 * curve is steeper; its tones are a step darker to make up for it (ascii.css).
 */
const LEVELS = 4096;
const GLOW_LEVELS = new Uint8Array(LEVELS + 1);
for (let index = 0; index <= LEVELS; index += 1) {
  const mean = ((index + 0.5) / LEVELS) ** GRID.contrast;
  GLOW_LEVELS[index] = Math.min(9, Math.round(mean * 9.4)) * 8 + Math.min(4, Math.floor(mean * 5));
}

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();
const RAMP_BYTES = ENCODER.encode(RAMP);
const SPACE = 32;
const NEWLINE = 10;
const LT = 60;
const GT = 62;
const SLASH = 47;
const DASH = 45;
/** The element names `t-N` (a run of a tone), `d-N` (the dark ground only), `l-N` (the light ground only). */
const T = 116;
const D = 100;
const L = 108;
const ZERO = 48;
const GRID_OPEN = ENCODER.encode('<span class="ascii-grid">');
const GRID_CLOSE = ENCODER.encode('</span>');
// The longest mark: every cell a pair of its own (two elements of 12 bytes), and the wrapper.
const BUFFER = new Uint8Array(GRID.rows * (GRID.cols * 26 + 1) + 64);
// A byte of the ramp stands for itself in markup only while no character of the ramp is special in HTML.
if (/[&<>"']/.test(RAMP) || RAMP_BYTES.length !== RAMP.length) throw new Error('The ramp must be plain ASCII.');

function copy(bytes: Uint8Array, at: number): number {
  // By hand: a call to `set` costs more than these few bytes.
  let n = at;
  for (let index = 0; index < bytes.length; index += 1) BUFFER[n++] = bytes[index] as number;
  return n;
}

/** Writes `<KIND-TONE>` (or `</KIND-TONE>`) at `n`, byte by byte, and returns the new end. */
function tag(kind: number, tone: number, closing: boolean, at: number): number {
  let n = at;
  BUFFER[n++] = LT;
  if (closing) BUFFER[n++] = SLASH;
  BUFFER[n++] = kind;
  BUFFER[n++] = DASH;
  BUFFER[n++] = ZERO + tone;
  BUFFER[n++] = GT;
  return n;
}

/**
 * The markup of a mark: one grid of characters for both themes, inside `.ascii-grid`.
 *
 * Most cells print the same on both grounds: a dense character is bright ink on the dark ground
 * and dark ink on the light one, and only the colours of the five tones change with the theme
 * (ascii.css). A cell whose ink on paper differs from its light on the dark ground (an eye, its
 * shine, the penguin's hood and face) is written twice, `<d-N>` for the dark ground and `<l-N>`
 * for the light, and the theme shows one. Runs of one tone other than 2 are wrapped in `<t-N>`;
 * tone 2 is the colour of the block and needs no element.
 *
 * One grid instead of two prints halves the work and the bytes of a board. It is ASCII, so it is
 * written as bytes into one buffer and read out once, several times cheaper than joining strings.
 */
export function markMarkup(from: Plate): string {
  return DECODER.decode(BUFFER.subarray(0, markBytes(from)));
}

/** Writes the markup of a mark into the buffer and returns its length. Exported for the bench. */
export function markBytes(from: Plate): number {
  const { glow, ink, alpha } = from;
  const { cols, rows } = GRID;
  const out = BUFFER;
  let n = copy(GRID_OPEN, 0);
  for (let row = 0; row < rows; row += 1) {
    if (row > 0) out[n++] = NEWLINE;
    let tone = BARE_TONE;
    let pending = 0;
    for (let col = 0; col < cols; col += 1) {
      const at = row * cols + col;
      const covered = alpha[at] as number;
      if (covered < 0.05) {
        pending += 1;
        continue;
      }
      // The ink of the cell on the dark ground (light) and on the light ground (as on paper).
      const onDark = glow[at] as number;
      const onLight = ink[at] as number;
      const level = GLOW_LEVELS[onDark >= 1 ? LEVELS : (onDark * LEVELS) | 0] as number;
      let step = level >> 3;
      if (step === 0 && covered > 0.5 && onDark / covered > 0.12) step = 1;
      if (onDark === onLight) {
        if (step === 0) {
          pending += 1;
          continue;
        }
        const each = level & 7;
        if (each !== tone) {
          if (tone !== BARE_TONE) n = tag(T, tone, true, n);
          for (; pending > 0; pending -= 1) out[n++] = SPACE;
          if (each !== BARE_TONE) n = tag(T, each, false, n);
          tone = each;
        } else for (; pending > 0; pending -= 1) out[n++] = SPACE;
        out[n++] = RAMP_BYTES[step] as number;
        continue;
      }
      // A cell of two prints: close the run, then the dark ground's character and the light one's.
      if (tone !== BARE_TONE) n = tag(T, tone, true, n);
      tone = BARE_TONE;
      for (; pending > 0; pending -= 1) out[n++] = SPACE;
      const paper = GLOW_LEVELS[onLight >= 1 ? LEVELS : (onLight * LEVELS) | 0] as number;
      let inked = paper >> 3;
      if (inked === 0 && covered > 0.5 && onLight / covered > 0.12) inked = 1;
      n = tag(D, level & 7, false, n);
      out[n++] = RAMP_BYTES[step] as number;
      n = tag(D, level & 7, true, n);
      n = tag(L, paper & 7, false, n);
      out[n++] = RAMP_BYTES[inked] as number;
      n = tag(L, paper & 7, true, n);
    }
    if (tone !== BARE_TONE) n = tag(T, tone, true, n);
    // Spaces at the end of a row are left out: the block is left-aligned in a box of fixed size.
  }
  return copy(GRID_CLOSE, n);
}

/**
 * ---------- The mark grid (12 by 10, under 48 pixels) ----------
 *
 * At 24 and 38 pixels a character is two to three pixels wide: its shape cannot be seen, only
 * how much of its cell it inks. So on this grid the character follows how much of the cell the
 * head covers, and the tone follows how bright the head is there:
 *   - a cell the head covers fully is a dense character, `+ * # % @` from tone 0 to tone 4, all
 *     of them as tall as a capital, so the rows touch and the head is one solid shape;
 *   - a cell on the edge, covered in part, is `:` or `.`, which softens the outline;
 *   - a hole (an eye, a nostril; under 14% of full brightness) is left blank on both grounds,
 *     so each eye is a clear cell in the head, light on dark or dark on light.
 * The two grounds are written into one grid as on the small grid: a cell that differs is a
 * `d-N` and an `l-N` pair.
 */
const MARK_DENSE = '+*#%@';
const MARK_EDGE = 0.35;
const MARK_HALF = 0.6;
const MARK_HOLE = 0.14;
const MARK_LEVELS = new Uint8Array(LEVELS + 1);
const MARK_PRINT_LEVELS = new Uint8Array(LEVELS + 1);
for (let index = 0; index <= LEVELS; index += 1) {
  const value = (index + 0.5) / LEVELS;
  MARK_LEVELS[index] = Math.min(4, Math.floor(value ** MARK_GRID.contrast * 5));
  MARK_PRINT_LEVELS[index] = Math.min(4, Math.floor(value ** MARK_GRID.printContrast * 5));
}
const MARK_OPEN = ENCODER.encode('<span class="ascii-grid ascii-grid--mark">');
const MARK_DENSE_BYTES = ENCODER.encode(MARK_DENSE);
const DOT = 46;
const COLON = 58;

/**
 * One cell of the mark grid on one ground: the character's byte times 8 plus its tone; 0 for
 * blank. A hole (by its light, `lit`) is blank on both grounds: at this size an eye reads as a
 * clear cell in the head, whether the head is light on dark or dark on light.
 */
function markCell(covered: number, lit: number, inked: number, levels: Uint8Array): number {
  if (covered < 0.12 || lit / covered < MARK_HOLE) return 0;
  const bright = inked / covered;
  const tone = levels[bright >= 1 ? LEVELS : (bright * LEVELS) | 0] as number;
  const char = covered < MARK_EDGE ? DOT : covered < MARK_HALF ? COLON : (MARK_DENSE_BYTES[tone] as number);
  return char * 8 + tone;
}

/** Writes the markup of a mark on the mark grid into the buffer and returns its length. */
export function markGridBytes(from: Plate): number {
  const { glow, ink, alpha } = from;
  const { cols, rows } = MARK_GRID;
  const out = BUFFER;
  let n = copy(MARK_OPEN, 0);
  for (let row = 0; row < rows; row += 1) {
    if (row > 0) out[n++] = NEWLINE;
    let tone = BARE_TONE;
    let pending = 0;
    for (let col = 0; col < cols; col += 1) {
      const at = row * cols + col;
      const covered = alpha[at] as number;
      const lit = glow[at] as number;
      const dark = markCell(covered, lit, lit, MARK_LEVELS);
      const light = markCell(covered, lit, ink[at] as number, MARK_PRINT_LEVELS);
      if (dark === light) {
        if (dark === 0) {
          pending += 1;
          continue;
        }
        const each = dark & 7;
        if (each !== tone) {
          if (tone !== BARE_TONE) n = tag(T, tone, true, n);
          for (; pending > 0; pending -= 1) out[n++] = SPACE;
          if (each !== BARE_TONE) n = tag(T, each, false, n);
          tone = each;
        } else for (; pending > 0; pending -= 1) out[n++] = SPACE;
        out[n++] = dark >> 3;
        continue;
      }
      if (tone !== BARE_TONE) n = tag(T, tone, true, n);
      tone = BARE_TONE;
      for (; pending > 0; pending -= 1) out[n++] = SPACE;
      n = tag(D, dark & 7, false, n);
      out[n++] = dark === 0 ? SPACE : dark >> 3;
      n = tag(D, dark & 7, true, n);
      n = tag(L, light & 7, false, n);
      out[n++] = light === 0 ? SPACE : light >> 3;
      n = tag(L, light & 7, true, n);
    }
    if (tone !== BARE_TONE) n = tag(T, tone, true, n);
  }
  return copy(GRID_CLOSE, n);
}

export interface Avatar {
  readonly species: Species;
  /** The inside of a mark: `.ascii-grid` with the picture for both grounds (`markMarkup`). */
  readonly html: string;
}

const memo: Record<PlateSize, Map<string, Avatar>> = { small: new Map(), mark: new Map() };
/** A page shows a few hundred agents at most; past this the cache starts again. */
const KEEP = 2000;

/**
 * The animal of the agent with this id, as the inside of its mark. Kept by id. `small` is the
 * bust on the 20 by 16 grid (48 pixels and up); `mark` the head on the 12 by 10 grid (under 48).
 */
export function agentAvatar(id: string, size: PlateSize = 'small'): Avatar {
  const kept = memo[size];
  const known = kept.get(id);
  if (known) return known;
  const who = character(id);
  const stacked = stackCharacter(who, size);
  const html = size === 'mark' ? DECODER.decode(BUFFER.subarray(0, markGridBytes(stacked))) : markMarkup(stacked);
  const avatar = { species: who.species, html };
  if (kept.size >= KEEP) kept.clear();
  kept.set(id, avatar);
  return avatar;
}
