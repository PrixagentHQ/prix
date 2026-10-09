/**
 * The character of an agent: an animal drawn as shapes and printed as a grid of characters by
 * brightness, in the agent's hue (docs/DESIGN.md, the ASCII animals). `asciiAnimal(id)` is
 * pure: the same id gives the same animal on every page, in every season, on every server.
 *
 * From a hash of the id, in this order:
 *   1. the hue, one of eight. The draw is the one `agentMark` makes (mark.ts), so an agent's
 *      animal has the colour of its card's accent;
 *   2. the species, one of twelve;
 *   3. inside the species: the eyes, a marking, an accessory, the brightness of the coat, the
 *      lean of the ears or horns, a trait of the species (a lop ear, a fuller mane, longer
 *      horns, an extra tine) and the width of the head.
 * Two agents share a species one time in twelve and a species and a hue one time in 96; past
 * that the eyes, the marking and the accessory still set them apart.
 *
 * Two grids. `small` is 20 by 16 cells (a 40 or 64 pixel avatar), `large` 40 by 32 (an agent's
 * page). A cell is 0.6 by 0.75 of the font size, so both grids fill a square. The large grid
 * draws what the small one cannot hold: whiskers, feather marks, the plates of a shell, curls.
 */
import { type Layer, layer, type Raster, rasterise, type Tone } from './paint.ts';
import { above, circle, ellipse, intersect, path, polygon, ring, type Shape, stroke } from './shapes.ts';
import {
  ACCESSORIES,
  type Accessory,
  type Anchors,
  DRAW,
  type Drawing,
  EYES,
  type Eyes,
  INK,
  type Look,
  MARKINGS,
  type Marking,
  SPECIES,
  type Species,
} from './species.ts';

export type { Tone } from './paint.ts';
export type { Accessory, Eyes, Marking, Species };
export { ACCESSORIES, EYES, MARKINGS, SPECIES };

/** The eight hues, in the order of MARK_HUES in mark.ts. Same draw, same hue. */
export const ASCII_HUES = ['olive', 'teal', 'petrol', 'violet', 'rose', 'umber', 'slate', 'ochre'] as const;
export type AsciiHue = (typeof ASCII_HUES)[number];

export type GridSize = 'small' | 'large';

export const GRIDS = {
  small: { cols: 20, rows: 16, samples: 1, contrast: 0.8, printContrast: 0.55 },
  large: { cols: 40, rows: 32, samples: 1, contrast: 0.95, printContrast: 0.72 },
} as const;

export interface AsciiCell {
  readonly char: string;
  readonly tone: Tone;
}

export interface AsciiAnimal {
  readonly species: Species;
  readonly hue: AsciiHue;
  readonly eyes: Eyes;
  readonly marking: Marking;
  readonly accessory: Accessory;
  readonly size: GridSize;
  readonly cols: number;
  readonly rows: number;
  /** One string per row, `cols` characters each. */
  readonly lines: readonly string[];
  /** `rows` arrays of `cols` cells: the character and its tone, 0 (dim) to 4 (bright). For the dark ground. */
  readonly cells: readonly (readonly AsciiCell[])[];
  /** The same picture printed for the light ground: ink is dark there, so the density is inverted. */
  readonly print: { readonly lines: readonly string[]; readonly cells: readonly (readonly AsciiCell[])[] };
}

/** FNV-1a over the characters of the id: the seed of mark.ts. */
function seed(id: string): number {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** The generator of mark.ts (mulberry32). */
function generator(start: number): () => number {
  let state = start;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Character {
  readonly species: Species;
  readonly hue: AsciiHue;
  readonly eyes: Eyes;
  readonly marking: Marking;
  readonly accessory: Accessory;
  readonly coat: number;
  readonly lean: number;
  readonly trait: boolean;
  readonly width: number;
  /** Which side a one-sided marking (a patch) sits on: -1 left, 1 right. */
  readonly side: -1 | 1;
}

const WORN_BY_ALL: readonly Accessory[] = ACCESSORIES.filter((each) => each !== 'none');

/**
 * The markings and the accessories (besides none) each species can carry: the lists of its
 * drawing in species.ts, in their order, written out here so that choosing a character draws
 * nothing. The test of the animals checks the two agree.
 */
export const CHOICES: Readonly<Record<Species, { markings: readonly Marking[]; worn: readonly Accessory[] }>> = {
  bull: { markings: ['none', 'blaze', 'star', 'patch', 'spots'], worn: WORN_BY_ALL },
  bear: { markings: ['none', 'blaze', 'star', 'patch', 'spots'], worn: WORN_BY_ALL },
  owl: { markings: ['none'], worn: WORN_BY_ALL },
  fox: { markings: ['none', 'star', 'patch', 'spots'], worn: WORN_BY_ALL },
  wolf: { markings: ['none', 'star', 'patch'], worn: WORN_BY_ALL },
  hawk: { markings: ['none'], worn: ['cap', 'crown', 'scarf', 'beanie'] },
  lion: { markings: ['none', 'spots'], worn: ['crown', 'glasses', 'bowtie', 'scarf'] },
  tortoise: { markings: ['none'], worn: WORN_BY_ALL },
  cat: { markings: ['none', 'blaze', 'patch', 'stripes', 'spots'], worn: WORN_BY_ALL },
  hare: { markings: ['none', 'star', 'patch', 'spots'], worn: WORN_BY_ALL },
  stag: { markings: ['none', 'blaze', 'star', 'spots'], worn: WORN_BY_ALL },
  penguin: { markings: ['none'], worn: WORN_BY_ALL },
};

function choicesOf(species: Species): { markings: readonly Marking[]; worn: readonly Accessory[] } {
  return CHOICES[species];
}

/** Everything the id decides, before anything is drawn. */
export function character(id: string): Character {
  const next = generator(seed(id));
  const pick = <T>(list: readonly T[]): T => list[Math.min(list.length - 1, Math.floor(next() * list.length))] as T;
  const hue = pick(ASCII_HUES);
  const species = pick(SPECIES);
  const eyes = pick(EYES);
  const markingRoll = next();
  // Half of the agents wear something, so an accessory says something about the agent.
  const accessoryRoll = next();
  const coat = 0.52 + next() * 0.16;
  const lean = next() * 2 - 1;
  const trait = next() < 0.5;
  const width = 0.95 + next() * 0.1;
  const side = next() < 0.5 ? -1 : 1;
  const { markings, worn } = choicesOf(species);
  const marking = markings[Math.min(markings.length - 1, Math.floor(markingRoll * markings.length))] as Marking;
  const accessory =
    accessoryRoll < 0.5
      ? 'none'
      : (worn[Math.min(worn.length - 1, Math.floor((accessoryRoll - 0.5) * 2 * worn.length))] as Accessory);
  return { species, hue, eyes, marking, accessory, coat, lean, trait, width, side };
}

/** Thin strokes are thicker on the small grid, where a cell is twice as wide. */
function thick(large: boolean, size: number): number {
  return large ? size : size * 1.6;
}

export function eyeLayers(a: Anchors, kind: Eyes, large: boolean): Layer[] {
  const out: Layer[] = [];
  // On the small grid an eye must cover at least a cell, or it is lost.
  const r = large ? a.eyeR : Math.max(a.eyeR * 1.2, 0.085);
  for (const side of [-1, 1]) {
    const cx = side * a.eyeX;
    const cy = a.eyeY;
    switch (kind) {
      case 'round':
        out.push(layer(circle(cx, cy, r), INK.hole));
        out.push(layer(circle(cx - r * 0.3, cy - r * 0.32, r * 0.36), INK.shine));
        break;
      case 'almond':
        out.push(layer(ellipse(cx, cy, r * 1.3, r * 0.78, side * -0.32), INK.hole));
        out.push(layer(circle(cx - r * 0.35, cy - r * 0.2, r * 0.32), INK.shine));
        break;
      case 'sleepy':
        out.push(
          layer(intersect(circle(cx, cy, r * 1.1), { d: (_x, y) => cy - r * 0.1 - y, box: [-2, cy, 2, 2] }), INK.hole),
        );
        out.push(
          layer(stroke(cx - r * 1.2, cy - r * 0.05, cx + r * 1.2, cy - r * 0.05, thick(large, 0.022)), INK.horn),
        );
        break;
      case 'wide':
        out.push(layer(circle(cx, cy, r * 1.22), INK.hole));
        out.push(layer(circle(cx - r * 0.38, cy - r * 0.38, r * 0.42), INK.shine));
        if (large) out.push(layer(circle(cx + r * 0.42, cy + r * 0.4, r * 0.16), 0.8));
        break;
    }
  }
  return out;
}

export function markingLayers(drawing: Drawing, marking: Marking, side: number, large: boolean): Layer[] {
  const a = drawing.anchors;
  const clip = (shape: Shape): Shape => intersect(shape, drawing.head);
  switch (marking) {
    case 'none':
      return [];
    case 'blaze':
      return [layer(clip(stroke(0, a.top + 0.02, 0, a.eyeY + 0.22, 0.075, 0.045)), INK.light, 0.03, 0.75)];
    case 'star':
      return [layer(clip(polygon(starPoints(0, a.top + 0.17, 0.11, 0.05, 4))), INK.light)];
    case 'patch':
      return [layer(clip(ellipse(side * a.eyeX, a.eyeY + 0.01, a.eyeR * 2.6, a.eyeR * 2.3, 0.3)), INK.dark, 0.04, 0.8)];
    case 'spots': {
      const r = large ? 0.035 : 0.05;
      const x = -side * (a.eyeX + 0.06);
      const y = a.eyeY + 0.2;
      return [
        layer(clip(circle(x, y, r)), INK.dark),
        layer(clip(circle(x + 0.1 * -side, y + 0.04, r)), INK.dark),
        layer(clip(circle(x + 0.03 * -side, y + 0.12, r)), INK.dark),
      ];
    }
    case 'stripes': {
      const t = thick(large, 0.022);
      return [-0.1, 0, 0.1].map((x) =>
        layer(clip(stroke(x, a.top - 0.02, x * 0.6, a.top + (x === 0 ? 0.22 : 0.16), t * 1.3, t * 0.7)), INK.dark),
      );
    }
  }
}

/** The points of a star with `points` tips, alternating between the two radii. */
function starPoints(cx: number, cy: number, outer: number, inner: number, points: number): [number, number][] {
  const out: [number, number][] = [];
  for (let index = 0; index < points * 2; index += 1) {
    const angle = (index * Math.PI) / points - Math.PI / 2;
    const r = index % 2 === 0 ? outer : inner;
    out.push([cx + Math.cos(angle) * r, cy + Math.sin(angle) * r]);
  }
  return out;
}

export function accessoryLayers(a: Anchors, accessory: Accessory, large: boolean): Layer[] {
  const w = a.halfWidth;
  switch (accessory) {
    case 'none':
      return [];
    case 'cap': {
      const dome = intersect(ellipse(0, a.top + 0.1, w * 0.78, 0.3), above(a.top + 0.12));
      return [
        layer(dome, 0.44, 0.06, 0.6),
        layer(ellipse(w * 0.12, a.top + 0.12, w * 0.92, 0.07), 0.86, 0.03, 0.7),
        layer(circle(0, a.top - 0.17, 0.035), 0.9),
      ];
    }
    case 'beanie': {
      const dome = intersect(ellipse(0, a.top + 0.1, w * 0.82, 0.34), above(a.top + 0.12));
      const knit = large ? (x: number) => (Math.abs(Math.sin(x * 26)) > 0.5 ? 0.62 : 0.48) : 0.55;
      return [
        layer(dome, knit, 0.06, 0.6),
        layer(
          intersect(ellipse(0, a.top + 0.1, w * 0.84, 0.36), {
            d: (_x, y) => Math.abs(y - (a.top + 0.06)) - 0.06,
            box: [-2, a.top, 2, a.top + 0.12],
          }),
          0.85,
          0.02,
          0.8,
        ),
        layer(circle(0, a.top - 0.25, 0.08), 0.9, 0.04, 0.6),
      ];
    }
    case 'headphones': {
      const band = intersect(
        ring(ellipse(0, a.middle, w + 0.08, a.middle - a.top + 0.16), thick(large, 0.03)),
        above(a.middle),
      );
      return [
        layer(band, 0.92),
        layer(ellipse(-(w + 0.06), a.middle + 0.04, 0.1, 0.17), 0.58, 0.05, 0.6),
        layer(ellipse(w + 0.06, a.middle + 0.04, 0.1, 0.17), 0.58, 0.05, 0.6),
      ];
    }
    case 'glasses': {
      const r = Math.max(a.eyeR * 1.85, large ? 0.11 : 0.13);
      const t = thick(large, 0.022);
      return [
        layer(ring(circle(-a.eyeX, a.eyeY, r), t), INK.horn),
        layer(ring(circle(a.eyeX, a.eyeY, r), t), INK.horn),
        layer(
          path(
            [
              [-a.eyeX + r, a.eyeY - 0.01],
              [0, a.eyeY - 0.04],
              [a.eyeX - r, a.eyeY - 0.01],
            ],
            t,
          ),
          INK.horn,
        ),
      ];
    }
    case 'crown': {
      const base = a.top + 0.04;
      const half = Math.min(0.26, w * 0.5);
      const crown = polygon([
        [-half, base],
        [-half, base - 0.14],
        [-half * 0.85, base - 0.26],
        [-half * 0.5, base - 0.14],
        [0, base - 0.3],
        [half * 0.5, base - 0.14],
        [half * 0.85, base - 0.26],
        [half, base - 0.14],
        [half, base],
      ]);
      return [layer(crown, INK.horn, 0.04, 0.7), layer(stroke(-half, base - 0.03, half, base - 0.03, 0.02), 0.6)];
    }
    case 'bowtie': {
      const y = a.chin + 0.1;
      return [
        layer(
          polygon([
            [-0.22, y - 0.1],
            [0, y],
            [-0.22, y + 0.1],
          ]),
          0.84,
          0.04,
          0.65,
        ),
        layer(
          polygon([
            [0.22, y - 0.1],
            [0, y],
            [0.22, y + 0.1],
          ]),
          0.84,
          0.04,
          0.65,
        ),
        layer(ellipse(0, y, 0.05, 0.06), 0.56),
      ];
    }
    case 'scarf': {
      const y = a.chin + 0.08;
      const knit = large ? (x: number) => (Math.floor((x + 1) * 7) % 2 === 0 ? 0.88 : 0.66) : 0.82;
      return [
        // A band round the neck and one short end, knotted on the left of the picture.
        layer(
          polygon([
            [-w * 0.5, y],
            [-w * 0.24, y],
            [-w * 0.2, y + 0.26],
            [-w * 0.5, y + 0.24],
          ]),
          knit,
          0.04,
          0.7,
        ),
        layer(ellipse(0, y, w * 0.95, 0.12), knit, 0.04, 0.7),
        layer(circle(-w * 0.36, y + 0.02, 0.08), 0.6, 0.03, 0.7),
      ];
    }
  }
}

/** Every layer squeezed or widened by `width` about the middle line. */
function widen(layers: Layer[], width: number): Layer[] {
  return layers.map((each) => {
    const shape = each.shape;
    const b = shape.box;
    const value = each.value;
    return {
      ...each,
      shape: {
        d: (x: number, y: number) => shape.d(x / width, y) * Math.min(1, width),
        box: [b[0] * width, b[1], b[2] * width, b[3]],
      },
      value: typeof value === 'number' ? value : (x: number, y: number) => value(x / width, y),
    };
  });
}

/** The layers of a character, bottom first. */
export function compose(who: Character, large: boolean): Layer[] {
  const look: Look = { coat: who.coat, lean: who.lean, trait: who.trait, eyes: who.eyes, large };
  const drawing = DRAW[who.species](look);
  const layers = [
    ...drawing.back,
    ...markingLayers(drawing, who.marking, who.side, large),
    ...drawing.front,
    ...(drawing.eyes ?? eyeLayers(drawing.anchors, who.eyes, large)),
    ...accessoryLayers(drawing.anchors, who.accessory, large),
  ];
  return widen(layers, who.width);
}

export function toCells(raster: Raster): AsciiCell[][] {
  return raster.lines.map((line, row) =>
    Array.from(line, (char, col) => ({ char, tone: (raster.tones[row * raster.cols + col] ?? 0) as Tone })),
  );
}

const memo = new Map<string, AsciiAnimal>();

/** The animal of the agent with this id, on the small or the large grid. */
export function asciiAnimal(id: string, size: GridSize = 'small'): AsciiAnimal {
  const key = `${size}:${id}`;
  const known = memo.get(key);
  if (known) return known;
  const animal = drawCharacter(character(id), size);
  // A page shows at most a few hundred agents; the cache stays small and never grows past it.
  if (memo.size >= 600) memo.clear();
  memo.set(key, animal);
  return animal;
}

/** Draws a character that is already decided: what asciiAnimal does after the hash. */
export function drawCharacter(who: Character, size: GridSize): AsciiAnimal {
  const { glow: raster, print } = rasterise(compose(who, size === 'large'), GRIDS[size]);
  return {
    species: who.species,
    hue: who.hue,
    eyes: who.eyes,
    marking: who.marking,
    accessory: who.accessory,
    size,
    cols: raster.cols,
    rows: raster.rows,
    lines: raster.lines,
    cells: toCells(raster),
    print: { lines: print.lines, cells: toCells(print) },
  };
}
