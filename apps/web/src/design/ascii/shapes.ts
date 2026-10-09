/**
 * The vector shapes the animals are drawn with, as signed distance fields: a negative number
 * inside the shape, a positive one outside, roughly the distance to the edge. The frame is the
 * square from -1 to 1 on both axes, y pointing down, so (0, 0) is the middle of the picture.
 *
 * Every shape carries the box it fits in, so the rasteriser can skip it for a point far away.
 * The fields are approximate where an exact one costs more than it gives (the ellipse); the
 * rasteriser only needs the sign and a sensible distance near the edge.
 */

export type Field = (x: number, y: number) => number;
export type Box = readonly [left: number, top: number, right: number, bottom: number];

export interface Shape {
  readonly d: Field;
  readonly box: Box;
}

const EMPTY: Box = [0, 0, 0, 0];

/** The length of (a, b). Math.hypot is several times slower and the fields are read thousands of times. */
export function len(a: number, b: number): number {
  return Math.sqrt(a * a + b * b);
}

function grow(box: Box, by: number): Box {
  return [box[0] - by, box[1] - by, box[2] + by, box[3] + by];
}

export function circle(cx: number, cy: number, r: number): Shape {
  return { d: (x, y) => len(x - cx, y - cy) - r, box: [cx - r, cy - r, cx + r, cy + r] };
}

/** An ellipse turned by `turn` radians (clockwise on screen, since y points down). */
export function ellipse(cx: number, cy: number, rx: number, ry: number, turn = 0): Shape {
  const cos = Math.cos(turn);
  const sin = Math.sin(turn);
  const small = Math.min(rx, ry);
  const reach = Math.max(rx, ry);
  return {
    d: (x, y) => {
      const dx = x - cx;
      const dy = y - cy;
      const u = (dx * cos + dy * sin) / rx;
      const v = (-dx * sin + dy * cos) / ry;
      return (len(u, v) - 1) * small;
    },
    box: turn === 0 ? [cx - rx, cy - ry, cx + rx, cy + ry] : [cx - reach, cy - reach, cx + reach, cy + reach],
  };
}

/** A stroke from a to b whose radius runs from `ra` to `rb`. */
export function stroke(ax: number, ay: number, bx: number, by: number, ra: number, rb = ra): Shape {
  const ux = bx - ax;
  const uy = by - ay;
  const length2 = ux * ux + uy * uy || 1;
  const r = Math.max(ra, rb);
  return {
    d: (x, y) => {
      const px = x - ax;
      const py = y - ay;
      const h = Math.min(1, Math.max(0, (px * ux + py * uy) / length2));
      return len(px - ux * h, py - uy * h) - (ra + (rb - ra) * h);
    },
    box: [Math.min(ax, bx) - r, Math.min(ay, by) - r, Math.max(ax, bx) + r, Math.max(ay, by) + r],
  };
}

/** A stroke through several points, its radius tapering from the first radius to the last. */
export function path(points: readonly (readonly [number, number])[], from: number, to = from): Shape {
  const parts: Shape[] = [];
  const last = points.length - 1;
  for (let index = 0; index < last; index += 1) {
    const a = points[index] as readonly [number, number];
    const b = points[index + 1] as readonly [number, number];
    const ra = from + ((to - from) * index) / last;
    const rb = from + ((to - from) * (index + 1)) / last;
    parts.push(stroke(a[0], a[1], b[0], b[1], ra, rb));
  }
  return union(...parts);
}

/** Any polygon, convex or not (the exact field of Inigo Quilez). */
export function polygon(points: readonly (readonly [number, number])[]): Shape {
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  const count = points.length;
  return {
    d: (x, y) => {
      const first = points[0] as readonly [number, number];
      let best = (x - first[0]) ** 2 + (y - first[1]) ** 2;
      let sign = 1;
      for (let i = 0, j = count - 1; i < count; j = i, i += 1) {
        const vi = points[i] as readonly [number, number];
        const vj = points[j] as readonly [number, number];
        const ex = vj[0] - vi[0];
        const ey = vj[1] - vi[1];
        const wx = x - vi[0];
        const wy = y - vi[1];
        const h = Math.min(1, Math.max(0, (wx * ex + wy * ey) / (ex * ex + ey * ey || 1)));
        const bx = wx - ex * h;
        const by = wy - ey * h;
        best = Math.min(best, bx * bx + by * by);
        const c1 = y >= vi[1];
        const c2 = y < vj[1];
        const c3 = ex * wy > ey * wx;
        if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) sign = -sign;
      }
      return sign * Math.sqrt(best);
    },
    box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
  };
}

/** The same polygon reflected across the vertical middle of the frame. */
export function mirror(points: readonly (readonly [number, number])[]): [number, number][] {
  return points.map(([x, y]) => [-x, y]);
}

/** A disc whose radius swings between `inner` and `outer` `points` times around: a mane, a sun. */
export function star(cx: number, cy: number, inner: number, outer: number, points: number, phase = 0): Shape {
  return {
    d: (x, y) => {
      const dx = x - cx;
      const dy = y - cy;
      const angle = Math.atan2(dy, dx) * points + phase;
      const wave = Math.abs(((angle / Math.PI) % 2) + 2) % 2;
      const tooth = wave > 1 ? 2 - wave : wave;
      return (len(dx, dy) - (inner + (outer - inner) * tooth)) * 0.8;
    },
    box: [cx - outer, cy - outer, cx + outer, cy + outer],
  };
}

/** A band of width `width` along the edge of a shape. */
export function ring(shape: Shape, width: number): Shape {
  return { d: (x, y) => Math.abs(shape.d(x, y)) - width, box: grow(shape.box, width) };
}

export function union(...shapes: Shape[]): Shape {
  if (shapes.length === 1) return shapes[0] as Shape;
  const boxes = shapes.map((shape) => shape.box);
  return {
    d: (x, y) => {
      let best = Number.POSITIVE_INFINITY;
      for (const shape of shapes) {
        const b = shape.box;
        // A shape whose box is far away cannot be the nearest edge that matters inside.
        if (x < b[0] - 0.25 || x > b[2] + 0.25 || y < b[1] - 0.25 || y > b[3] + 0.25) {
          best = Math.min(best, 0.25);
          continue;
        }
        best = Math.min(best, shape.d(x, y));
      }
      return best;
    },
    box: shapes.length
      ? [
          Math.min(...boxes.map((b) => b[0])),
          Math.min(...boxes.map((b) => b[1])),
          Math.max(...boxes.map((b) => b[2])),
          Math.max(...boxes.map((b) => b[3])),
        ]
      : EMPTY,
  };
}

/** A union whose seams are rounded over a width of `k`: a muzzle grown out of a head. */
export function blend(a: Shape, b: Shape, k: number): Shape {
  return {
    d: (x, y) => {
      const da = a.d(x, y);
      const db = b.d(x, y);
      const h = Math.min(1, Math.max(0, 0.5 + (0.5 * (db - da)) / k));
      return db + (da - db) * h - k * h * (1 - h);
    },
    box: grow(union(a, b).box, k / 4),
  };
}

export function intersect(a: Shape, b: Shape): Shape {
  return {
    d: (x, y) => Math.max(a.d(x, y), b.d(x, y)),
    box: [
      Math.max(a.box[0], b.box[0]),
      Math.max(a.box[1], b.box[1]),
      Math.min(a.box[2], b.box[2]),
      Math.min(a.box[3], b.box[3]),
    ],
  };
}

export function subtract(a: Shape, b: Shape): Shape {
  return { d: (x, y) => Math.max(a.d(x, y), -b.d(x, y)), box: a.box };
}

/** Everything above the line y = `edge` (smaller y), as a shape to intersect with. */
export function above(edge: number): Shape {
  return { d: (_x, y) => y - edge, box: [-2, -2, 2, edge] };
}

/** Everything below the line y = `edge`. */
export function below(edge: number): Shape {
  return { d: (_x, y) => edge - y, box: [-2, edge, 2, 2] };
}

/** The shape pulled `by` toward its inside: a smaller copy with the same outline. */
export function inset(shape: Shape, by: number): Shape {
  return { d: (x, y) => shape.d(x, y) + by, box: shape.box };
}

/** The shape moved by (dx, dy). */
export function move(shape: Shape, dx: number, dy: number): Shape {
  const b = shape.box;
  return { d: (x, y) => shape.d(x - dx, y - dy), box: [b[0] + dx, b[1] + dy, b[2] + dx, b[3] + dy] };
}

/** The shape scaled by `s` about the point (cx, cy). */
export function scale(shape: Shape, s: number, cx = 0, cy = 0): Shape {
  const b = shape.box;
  return {
    d: (x, y) => shape.d(cx + (x - cx) / s, cy + (y - cy) / s) * s,
    box: [cx + (b[0] - cx) * s, cy + (b[1] - cy) * s, cx + (b[2] - cx) * s, cy + (b[3] - cy) * s],
  };
}
