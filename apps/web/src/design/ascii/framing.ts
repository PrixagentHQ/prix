/**
 * The animal of a mark under 48 pixels: the head alone, filling its square (docs/DESIGN.md
 * section 7, R8).
 *
 * At 24 and 38 pixels a bust of 20 by 16 characters is a grey disc on grey shoulders, and every
 * species looks like every other. What tells a bull from an owl at that size is the outline of
 * the head: the horns, the ears, the beak, the shell, the mane. So the mark grid (MARK_GRID,
 * 12 by 10) draws only what makes that outline, and the eyes:
 *   - the shoulders and anything else that runs off the bottom of the frame are left out;
 *   - the agent's marking and its accessory are left out (they return from 48 pixels up);
 *   - the head is moved and scaled so that the plain head of its species (no lean, no trait)
 *     fills 85% of the square, centred. A longer horn or a leaning ear may reach the edge;
 *   - each eye is one clear cell, a hole on the dark ground and ink on the light one, placed on
 *     the cell nearest the eye of the drawing (and symmetric, the grid having an even width).
 * The frame is one per species, so two agents of one species are drawn at the same scale and
 * their leans and traits still show.
 */
import type { GridSpec, Layer } from './paint.ts';
import { layer } from './paint.ts';
import { circle } from './shapes.ts';
import { type Anchors, DRAW, type Drawing, type Eyes, INK, type Look, SPECIES, type Species } from './species.ts';

/**
 * The grid of a mark of 24 or 38 pixels (and an avatar of 40). A cell is a twelfth of the side
 * wide and a tenth high: 0.6 by 0.72 of the font size, so a capital fills its line and the rows
 * touch (ascii.css).
 */
export const MARK_GRID: GridSpec = { cols: 12, rows: 10, samples: 1, contrast: 0.7, printContrast: 0.6 };

/** How much of the height of the square the head fills, and at most how much of its width. */
export const MARK_FILL = 0.85;
const MARK_WIDE = 0.98;

/** A layer that reaches this far below the frame is the shoulders or a body: not drawn in a mark. */
const BODY_EDGE = 1.3;
/** A stroke this thin (a whisker) is drawn but not measured: it may run off the square. */
const HAIRLINE = 0.15;

export interface Frame {
  /** The centre of the head, in the frame of the drawing. */
  readonly cx: number;
  readonly cy: number;
  /** How much the head is enlarged. */
  readonly scale: number;
}

/** The layers of a drawing that make the outline of the head: everything but a body running off the frame. */
export function headLayers(layers: readonly Layer[]): Layer[] {
  return layers.filter((each) => each.shape.box[3] < BODY_EDGE);
}

/** Every layer moved so `frame`'s centre is the middle and enlarged by its scale. */
export function framed(layers: readonly Layer[], frame: Frame): Layer[] {
  const { cx, cy, scale } = frame;
  return layers.map((each) => {
    const shape = each.shape;
    const b = shape.box;
    const value = each.value;
    return {
      ...each,
      shape: {
        d: (x: number, y: number) => shape.d(x / scale + cx, y / scale + cy) * scale,
        box: [(b[0] - cx) * scale, (b[1] - cy) * scale, (b[2] - cx) * scale, (b[3] - cy) * scale] as const,
      },
      // The rim is a width in the frame of the drawing: it grows with the head.
      rim: each.rim * scale,
      value: typeof value === 'number' ? value : (x: number, y: number) => value(x / scale + cx, y / scale + cy),
    };
  });
}

const SAMPLES = 96;

/** The box of what the layers cover, found by sampling: the boxes of the shapes are loose for a turned ellipse. */
function coveredBox(layers: readonly Layer[], into: number[]): void {
  const step = 2.4 / SAMPLES;
  for (let row = 0; row < SAMPLES; row += 1) {
    const y = -1.2 + (row + 0.5) * step;
    for (let col = 0; col < SAMPLES; col += 1) {
      const x = -1.2 + (col + 0.5) * step;
      for (const each of layers) {
        const b = each.shape.box;
        if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
        if (each.shape.d(x, y) < 0) {
          if (x < (into[0] as number)) into[0] = x;
          if (y < (into[1] as number)) into[1] = y;
          if (x > (into[2] as number)) into[2] = x;
          if (y > (into[3] as number)) into[3] = y;
          break;
        }
      }
    }
  }
}

function plainLook(lean = 0, trait = false, eyes: Eyes = 'round'): Look {
  return { coat: 0.6, lean, trait, eyes, large: false };
}

function measure(species: Species): Frame {
  const box = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  const drawing: Drawing = DRAW[species](plainLook());
  const solid = headLayers([...drawing.back, ...drawing.front]).filter(
    (each) => each.shape.box[3] - each.shape.box[1] >= HAIRLINE,
  );
  coveredBox(solid, box);
  const [left, top, right, bottom] = box as [number, number, number, number];
  // 85% of the height, and up to the whole width: a wide head (the bull's horns) is not shrunk
  // to leave a margin at its sides that a tall one keeps above and below.
  const scale = Math.min(MARK_FILL / ((bottom - top) / 2), MARK_WIDE / ((right - left) / 2));
  return { cx: (left + right) / 2, cy: (top + bottom) / 2, scale };
}

const frames = new Map<Species, Frame>();

/** The frame of a species' head in a mark: measured once, from its plain drawing. */
export function speciesFrame(species: Species): Frame {
  let frame = frames.get(species);
  if (!frame) {
    frame = measure(species);
    frames.set(species, frame);
  }
  return frame;
}

/** The centre of the cell nearest `at` along an axis of `count` cells over the frame from -1 to 1. */
function snap(at: number, count: number): number {
  const cell = 2 / count;
  const index = Math.max(0, Math.min(count - 1, Math.floor((at + 1) / cell)));
  return -1 + (index + 0.5) * cell;
}

/** The species drawn in profile: one eye, where the drawing puts it. */
const PROFILE: ReadonlySet<Species> = new Set(['hawk']);

/** The eyes of a mark: one clear cell each, already in the frame of the mark. */
export function markEyes(anchors: Anchors, frame: Frame, profile = false, grid: GridSpec = MARK_GRID): Layer[] {
  const at = (x: number) => (x - frame.cx) * frame.scale;
  const y = snap((anchors.eyeY - frame.cy) * frame.scale, grid.rows);
  // A circle that covers the middle of its cell and no other cell's.
  const r = Math.min(2 / grid.cols, 2 / grid.rows) * 0.5;
  if (profile) return [layer(circle(snap(at(anchors.eyeX), grid.cols), y, r), INK.hole)];
  // A head drawn on the middle line has its eyes on two cells the same distance from it.
  const centred = Math.abs(frame.cx * frame.scale) < 1 / grid.cols;
  const right = snap(at(anchors.eyeX), grid.cols);
  const left = centred ? -right : snap(at(-anchors.eyeX), grid.cols);
  return [layer(circle(left, y, r), INK.hole), layer(circle(right, y, r), INK.hole)];
}

/** What a mark draws of a drawing, in the frame of the mark: the head behind, the head in front, the eyes. */
export function markParts(species: Species, drawing: Drawing): { back: Layer[]; front: Layer[]; eyes: Layer[] } {
  const frame = speciesFrame(species);
  return {
    back: framed(headLayers(drawing.back), frame),
    front: framed(headLayers(drawing.front), frame),
    eyes: markEyes(drawing.anchors, frame, PROFILE.has(species)),
  };
}

/** Every species' frame, for the specimen and the tests. */
export function allFrames(): Record<Species, Frame> {
  return Object.fromEntries(SPECIES.map((species) => [species, speciesFrame(species)])) as Record<Species, Frame>;
}
