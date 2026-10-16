/**
 * Where the crawler may be drawn: a map of the page in cells of 12 pixels (docs/DESIGN.md section
 * 30). Pure: it is made from boxes, so the tests can build one without a page.
 *
 *   wall  never drawn over and never crossed: a figure, a control, a form, a picture, a chart,
 *         the tape, anything fixed or sticky, a dialog, a toast;
 *   loud  the words of an h1 or an h2: never stood on, tapped or read from, and crossed only
 *         where no other way is near (a step over one costs twelve on free ground);
 *   soft  other words without a figure: crossed while walking (a step costs three), never stood
 *         on, tapped or read from;
 *   free  everything else: backgrounds, paddings, the gaps between blocks, the margins, the field.
 *
 * A box marks every cell it touches, so the map is never smaller than what it maps. The distance
 * of every cell to the nearest wall is kept, for finding a route wide enough for the whole body.
 */
import { type Glyph, glyphSize, type Vec } from './model.ts';

/** A cell of the map, in pixels: fine enough for a crawler of 160 to 260 pixels, coarse enough to build fast. */
export const CELL = 12;
export const FREE = 0;
export const SOFT = 1;
export const LOUD = 2;
export const WALL = 3;
/** What a step over each kind of ground costs a route, against 1 on free ground. */
const COST = [1, 3, 12, 1];

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SpaceInput {
  /** The part of the page the map covers. Outside it everything is a wall. */
  area: Box;
  /** The window: the crawler stands, taps and reads only wholly inside it. */
  view: Box;
  walls: Box[];
  soft: Box[];
  /** The words of an h1 or an h2. */
  loud?: Box[];
}

const FAR = 1e12;

/** The squared distance transform of one line (Felzenszwalb and Huttenlocher, 2012). */
function line(f: Float64Array, n: number, out: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -FAR;
  z[1] = FAR;
  for (let q = 1; q < n; q += 1) {
    const fq = (f[q] as number) + q * q;
    let r = v[k] as number;
    let s = (fq - ((f[r] as number) + r * r)) / (2 * q - 2 * r);
    while (s <= (z[k] as number)) {
      k -= 1;
      r = v[k] as number;
      s = (fq - ((f[r] as number) + r * r)) / (2 * q - 2 * r);
    }
    k += 1;
    v[k] = q;
    z[k] = s;
    z[k + 1] = FAR;
  }
  k = 0;
  for (let q = 0; q < n; q += 1) {
    while ((z[k + 1] as number) < q) k += 1;
    const r = v[k] as number;
    out[q] = (q - r) * (q - r) + (f[r] as number);
  }
}

export class Space {
  readonly x0: number;
  readonly y0: number;
  readonly cols: number;
  readonly rows: number;
  readonly kind: Uint8Array;
  /** For each cell, the distance in pixels from its centre to the centre of the nearest wall cell. */
  readonly room: Float32Array;
  readonly view: Box;
  private search?: { cost: Float32Array; score: Float32Array; back: Int32Array; heap: Int32Array };

  constructor(input: SpaceInput) {
    const { area } = input;
    this.x0 = Math.floor(area.x / CELL) * CELL;
    this.y0 = Math.floor(area.y / CELL) * CELL;
    this.cols = Math.max(1, Math.ceil((area.x + area.w - this.x0) / CELL));
    this.rows = Math.max(1, Math.ceil((area.y + area.h - this.y0) / CELL));
    this.view = input.view;
    this.kind = new Uint8Array(this.cols * this.rows);
    for (const box of input.soft) this.mark(box, SOFT);
    for (const box of input.loud ?? []) this.mark(box, LOUD);
    for (const box of input.walls) this.mark(box, WALL);
    this.room = this.distances();
  }

  private mark(box: Box, kind: number): void {
    const c0 = Math.max(0, Math.floor((box.x - this.x0) / CELL));
    const c1 = Math.min(this.cols - 1, Math.ceil((box.x + box.w - this.x0) / CELL) - 1);
    const r0 = Math.max(0, Math.floor((box.y - this.y0) / CELL));
    const r1 = Math.min(this.rows - 1, Math.ceil((box.y + box.h - this.y0) / CELL) - 1);
    for (let r = r0; r <= r1; r += 1) {
      for (let c = c0; c <= c1; c += 1) {
        const i = r * this.cols + c;
        if ((this.kind[i] as number) < kind) this.kind[i] = kind;
      }
    }
  }

  private distances(): Float32Array {
    const { cols, rows } = this;
    const n = Math.max(cols, rows);
    const f = new Float64Array(n);
    const out = new Float64Array(n);
    const v = new Int32Array(n);
    const z = new Float64Array(n + 1);
    const grid = new Float64Array(cols * rows);
    for (let i = 0; i < grid.length; i += 1) grid[i] = this.kind[i] === WALL ? 0 : FAR;
    for (let c = 0; c < cols; c += 1) {
      for (let r = 0; r < rows; r += 1) f[r] = grid[r * cols + c] as number;
      line(f, rows, out, v, z);
      for (let r = 0; r < rows; r += 1) grid[r * cols + c] = out[r] as number;
    }
    const room = new Float32Array(cols * rows);
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) f[c] = grid[r * cols + c] as number;
      line(f, cols, out, v, z);
      for (let c = 0; c < cols; c += 1) room[r * cols + c] = Math.sqrt(out[c] as number) * CELL;
    }
    return room;
  }

  /** The cell of a point, or -1 outside the map. */
  cell(x: number, y: number): number {
    const c = Math.floor((x - this.x0) / CELL);
    const r = Math.floor((y - this.y0) / CELL);
    return c < 0 || r < 0 || c >= this.cols || r >= this.rows ? -1 : r * this.cols + c;
  }

  /** What lies at a point: outside the map, a wall. */
  at(x: number, y: number): number {
    const i = this.cell(x, y);
    return i < 0 ? WALL : (this.kind[i] as number);
  }

  /** The room around a point: the distance to the nearest wall, less the cells' own size. */
  roomAt(x: number, y: number): number {
    const i = this.cell(x, y);
    return i < 0 ? 0 : (this.room[i] as number) - CELL * Math.SQRT2;
  }

  /** Whether a box meets a wall, or, when `standing`, a word or a wall. */
  meets(box: Box, standing: boolean): boolean {
    const limit = standing ? SOFT : WALL;
    const c0 = Math.floor((box.x - this.x0) / CELL);
    const c1 = Math.ceil((box.x + box.w - this.x0) / CELL) - 1;
    const r0 = Math.floor((box.y - this.y0) / CELL);
    const r1 = Math.ceil((box.y + box.h - this.y0) / CELL) - 1;
    if (c0 < 0 || r0 < 0 || c1 >= this.cols || r1 >= this.rows) return true;
    for (let r = r0; r <= r1; r += 1) {
      for (let c = c0; c <= c1; c += 1) {
        if ((this.kind[r * this.cols + c] as number) >= limit) return true;
      }
    }
    return false;
  }

  /** Whether a pose's glyphs all lie clear: off every wall, and when standing, off every word and inside the window. */
  fits(pose: Glyph[], standing: boolean): boolean {
    const v = this.view;
    for (const g of pose) {
      const box = glyphBox(g);
      if (this.meets(box, standing)) return false;
      if (standing && (box.x < v.x || box.y < v.y || box.x + box.w > v.x + v.w || box.y + box.h > v.y + v.h)) {
        return false;
      }
    }
    return true;
  }

  /**
   * A route from one point to another for a body that needs `need` pixels of room on every
   * side: the cells' centres, straightened where the way between them is clear, ending on `to`.
   * When `to` cannot be reached within the budget it ends at the reached point nearest to it.
   * A body that stands, or is to stand, where it has less room than `need` may walk with the room
   * of that place, never less, so a tight place is never a trap. Null when the start is off the map.
   */
  route(from: Vec, to: Vec, need: number, budget = 40000): Vec[] | null {
    const start = this.cell(from.x, from.y);
    const goal = this.cell(to.x, to.y);
    if (start < 0 || goal < 0) return null;
    // It may walk with the room its start or its end has, when less than `need`: it stands at both.
    const floor = Math.min(
      need,
      (this.room[start] as number) - CELL * Math.SQRT2,
      (this.room[goal] as number) - CELL * Math.SQRT2,
    );
    const open = (i: number) => (this.room[i] as number) - CELL * Math.SQRT2 >= floor;
    const { cols } = this;
    const n = this.kind.length;
    const gc = goal % cols;
    const gr = Math.floor(goal / cols);
    const h = (i: number) => {
      const dx = Math.abs((i % cols) - gc);
      const dy = Math.abs(Math.floor(i / cols) - gr);
      return dx + dy + (Math.SQRT2 - 2) * Math.min(dx, dy);
    };
    // One set of buffers per map, reused by every route: no garbage while it follows.
    this.search ??= {
      cost: new Float32Array(n),
      score: new Float32Array(n),
      back: new Int32Array(n),
      heap: new Int32Array(n * 2),
    };
    const { cost, score, back, heap } = this.search;
    cost.fill(Number.POSITIVE_INFINITY);
    back.fill(-1);
    let size = 0;
    const push = (i: number) => {
      if (size >= heap.length) return;
      let k = size;
      size += 1;
      while (k > 0) {
        const up = (k - 1) >> 1;
        const j = heap[up] as number;
        if ((score[j] as number) <= (score[i] as number)) break;
        heap[k] = j;
        k = up;
      }
      heap[k] = i;
    };
    const pop = (): number => {
      const top = heap[0] as number;
      size -= 1;
      const last = heap[size] as number;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1;
        if (l >= size) break;
        const r = l + 1;
        const m = r < size && (score[heap[r] as number] as number) < (score[heap[l] as number] as number) ? r : l;
        if ((score[heap[m] as number] as number) >= (score[last] as number)) break;
        heap[k] = heap[m] as number;
        k = m;
      }
      heap[k] = last;
      return top;
    };
    cost[start] = 0;
    score[start] = h(start);
    push(start);
    let best = start;
    let done = false;
    for (let spent = 0; size > 0 && spent < budget; spent += 1) {
      const i = pop();
      if (h(i) < h(best)) best = i;
      if (i === goal) {
        done = true;
        break;
      }
      const c = i % cols;
      const g = cost[i] as number;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (!dx && !dy) continue;
          const nc = c + dx;
          const j = i + dy * cols + dx;
          if (nc < 0 || nc >= cols || j < 0 || j >= n || !open(j)) continue;
          if (dx && dy && (!open(i + dx) || !open(i + dy * cols))) continue;
          const next = g + (dx && dy ? Math.SQRT2 : 1) * (COST[this.kind[j] as number] ?? 1);
          if (next >= (cost[j] as number)) continue;
          cost[j] = next;
          back[j] = i;
          score[j] = next + h(j);
          push(j);
        }
      }
    }
    const end = done ? goal : best;
    const cells: number[] = [];
    for (let i = end; i >= 0; i = back[i] as number) cells.unshift(i);
    const centre = (i: number): Vec => ({
      x: this.x0 + ((i % cols) + 0.5) * CELL,
      y: this.y0 + (Math.floor(i / cols) + 0.5) * CELL,
    });
    const points = cells.map(centre);
    points[points.length - 1] = done ? { x: to.x, y: to.y } : (points[points.length - 1] as Vec);
    // Straighten: keep a point only where the way from the last kept one to the next is not clear.
    const kept: Vec[] = [];
    let anchor = from;
    for (let k = 1; k < points.length; k += 1) {
      if (!this.clearWay(anchor, points[k] as Vec, need)) {
        const previous = points[k - 1] as Vec;
        kept.push(previous);
        anchor = previous;
      }
    }
    kept.push(points[points.length - 1] as Vec);
    return kept;
  }

  /**
   * Whether a body that needs `need` pixels of room can walk straight from a to b. A straight way
   * never cuts across the words of an h1 or an h2 that the route went round.
   */
  clearWay(a: Vec, b: Vec, need: number): boolean {
    const steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (CELL / 2));
    const loud = this.at(a.x, a.y) === LOUD || this.at(b.x, b.y) === LOUD;
    for (let k = 0; k <= steps; k += 1) {
      const t = steps === 0 ? 1 : k / steps;
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      if (this.roomAt(x, y) < need || (!loud && this.at(x, y) === LOUD)) return false;
    }
    return true;
  }
}

/** The box of a glyph of `size` pixels: the cell of the face, centred on the glyph. */
export function glyphBox(g: Vec & { size?: number }, size = g.size ?? 13): Box {
  const { w, h } = glyphSize(size);
  return { x: g.x - w / 2, y: g.y - h / 2, w, h };
}

/** The room a body of this reach needs around its centre: its farthest glyph and that glyph's box. */
export function roomNeeded(reach: number, font: number): number {
  const { w, h } = glyphSize(font);
  return reach + Math.hypot(w, h) / 2;
}
