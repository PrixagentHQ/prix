/**
 * The mascot of Prix: three candidates, each an animal of the agents' family drawn with more
 * care than a generated agent (fixed choices, extra strokes, a third grid for the token image),
 * in the hue of the blue of an action (`prix` in ascii.css).
 *
 * Three renderings of each:
 *   - characters on three grids: `small` (20 by 16, the lockup beside the word at 40 pixels),
 *     `large` (40 by 32) and `poster` (60 by 48, the token image at 512);
 *   - a favicon at 16 and 32 pixels, where characters cannot read: the same animal as flat
 *     pixels in three inks on a blue tile, a deliberate simplification (`favicon`).
 */
import { type AsciiAnimal, type Character, compose, toCells } from './animal.ts';
import { type Layer, layer, pixels, rasterise } from './paint.ts';
import { above, circle, ellipse, intersect, move, path, polygon, ring, scale, stroke, union } from './shapes.ts';

export const MASCOTS = ['bull', 'owl', 'fox'] as const;
export type Mascot = (typeof MASCOTS)[number];

export const MASCOT_GRIDS = {
  small: { cols: 20, rows: 16, samples: 3, contrast: 0.7, printContrast: 0.5 },
  large: { cols: 40, rows: 32, samples: 2, contrast: 0.8, printContrast: 0.6 },
  poster: { cols: 60, rows: 48, samples: 2, contrast: 0.82, printContrast: 0.8 },
} as const;
export type MascotGrid = keyof typeof MASCOT_GRIDS;

const BASE: Omit<Character, 'species'> = {
  hue: 'petrol',
  eyes: 'almond',
  marking: 'none',
  accessory: 'none',
  coat: 0.7,
  lean: 0,
  trait: false,
  width: 1,
  side: 1,
};

const CHOICES: Record<Mascot, Character> = {
  // Long horns swept up, a calm almond eye, the curls of the forehead.
  bull: { ...BASE, species: 'bull', trait: true, lean: 0.4 },
  // Wide eyes in bright discs: the one that watches the board.
  owl: { ...BASE, species: 'owl', eyes: 'wide', coat: 0.64, trait: true },
  // Tall ears and a white blaze down the muzzle.
  fox: { ...BASE, species: 'fox' },
};

/** What a mascot has that a generated agent does not. Drawn over the agent's own layers. */
function finish(name: Mascot, fine: boolean): Layer[] {
  const t = fine ? 0.016 : 0.026;
  switch (name) {
    case 'bull':
      return [
        // Light running along the top of each horn.
        layer(
          path(
            [
              [-0.42, -0.36],
              [-0.7, -0.44],
              [-0.86, -0.64],
              [-0.88, -0.82],
            ],
            t,
          ),
          1,
        ),
        layer(
          path(
            [
              [0.42, -0.36],
              [0.7, -0.44],
              [0.86, -0.64],
              [0.88, -0.82],
            ],
            t,
          ),
          1,
        ),
        // The brow over each eye, and a shadow down the middle of the face.
        layer(stroke(-0.36, -0.15, -0.16, -0.12, t * 1.2), 0.86),
        layer(stroke(0.36, -0.15, 0.16, -0.12, t * 1.2), 0.86),
        layer(stroke(0, -0.2, 0, 0.16, 0.05, 0.03), 0.48),
      ];
    case 'owl':
      return [
        // A rim of light round each disc.
        layer(intersect(ring(circle(-0.27, -0.1, 0.285), t * 0.8), above(0.05)), 0.95),
        layer(intersect(ring(circle(0.27, -0.1, 0.285), t * 0.8), above(0.05)), 0.95),
      ];
    case 'fox':
      return [
        // A rim of light down the bridge of the nose.
        layer(stroke(0, -0.12, 0, 0.4, t * 0.9), 0.9),
      ];
  }
}

/**
 * The mascot's layers. A logo is a head, not a bust: the shoulders are left out and the head is
 * drawn larger and lower, so it fills the square at 40 pixels.
 */
export function mascotLayers(name: Mascot, grid: MascotGrid): Layer[] {
  const fine = grid !== 'small';
  const all = [...compose(CHOICES[name], fine), ...finish(name, fine)];
  const head = name === 'owl' ? all : all.filter((each) => each.shape.box[1] < 0.6);
  const zoom = name === 'bull' ? 1.06 : 1.12;
  const drop = name === 'owl' ? 0.04 : 0.1;
  return head.map((each) => ({ ...each, shape: move(scale(each.shape, zoom), 0, drop) }));
}

/** The mascot printed in characters, in the shape of an agent's animal. */
/** A mascot in characters: an animal's grid, in the hue of Prix. */
export type MascotPicture = Omit<AsciiAnimal, 'hue'> & { readonly hue: 'prix' };

export function mascot(name: Mascot, grid: MascotGrid): MascotPicture {
  const who = CHOICES[name];
  const { glow, print } = rasterise(mascotLayers(name, grid), MASCOT_GRIDS[grid]);
  return {
    species: who.species,
    hue: 'prix',
    eyes: who.eyes,
    marking: who.marking,
    accessory: who.accessory,
    size: grid === 'small' ? 'small' : 'large',
    cols: glow.cols,
    rows: glow.rows,
    lines: glow.lines,
    cells: toCells(glow),
    print: { lines: print.lines, cells: toCells(print) },
  };
}

/** The flat drawing a favicon is made from: silhouette, the light parts, the eyes. */
function iconLayers(name: Mascot): Layer[] {
  const mid = 0.6;
  const light = 1;
  const hole = 0;
  switch (name) {
    case 'bull':
      return [
        layer(
          path(
            [
              [-0.3, -0.26],
              [-0.66, -0.36],
              [-0.88, -0.56],
              [-0.86, -0.86],
            ],
            0.15,
            0.07,
          ),
          light,
        ),
        layer(
          path(
            [
              [0.3, -0.26],
              [0.66, -0.36],
              [0.88, -0.56],
              [0.86, -0.86],
            ],
            0.15,
            0.07,
          ),
          light,
        ),
        layer(union(ellipse(0, -0.08, 0.6, 0.42), ellipse(0, 0.34, 0.42, 0.42)), mid),
        layer(ellipse(0, 0.5, 0.42, 0.3), light),
        layer(circle(-0.27, -0.04, 0.11), hole),
        layer(circle(0.27, -0.04, 0.11), hole),
        layer(circle(-0.15, 0.5, 0.08), hole),
        layer(circle(0.15, 0.5, 0.08), hole),
      ];
    case 'owl':
      return [
        layer(
          polygon([
            [-0.2, -0.5],
            [-0.62, -0.38],
            [-0.64, -0.92],
          ]),
          mid,
        ),
        layer(
          polygon([
            [0.2, -0.5],
            [0.62, -0.38],
            [0.64, -0.92],
          ]),
          mid,
        ),
        layer(ellipse(0, 0.14, 0.74, 0.84), mid),
        layer(union(circle(-0.3, -0.08, 0.32), circle(0.3, -0.08, 0.32)), light),
        layer(circle(-0.3, -0.08, 0.15), hole),
        layer(circle(0.3, -0.08, 0.15), hole),
        layer(
          polygon([
            [-0.1, 0.12],
            [0.1, 0.12],
            [0, 0.4],
          ]),
          mid,
        ),
      ];
    case 'fox':
      return [
        layer(
          polygon([
            [-0.08, -0.34],
            [-0.66, -0.1],
            [-0.6, -0.96],
          ]),
          mid,
        ),
        layer(
          polygon([
            [0.08, -0.34],
            [0.66, -0.1],
            [0.6, -0.96],
          ]),
          mid,
        ),
        layer(
          union(
            ellipse(0, -0.08, 0.56, 0.42),
            polygon([
              [-0.76, 0.14],
              [-0.44, -0.14],
              [0.44, -0.14],
              [0.76, 0.14],
              [0.1, 0.78],
              [-0.1, 0.78],
            ]),
          ),
          mid,
        ),
        layer(
          intersect(
            polygon([
              [-0.8, 0.14],
              [-0.2, 0.08],
              [0, 0.24],
              [0.2, 0.08],
              [0.8, 0.14],
              [0.12, 0.86],
              [-0.12, 0.86],
            ]),
            above(0.8),
          ),
          light,
        ),
        layer(ellipse(-0.24, -0.04, 0.13, 0.09, -0.3), hole),
        layer(ellipse(0.24, -0.04, 0.13, 0.09, 0.3), hole),
        layer(circle(0, 0.68, 0.1), hole),
      ];
  }
}

/** The inks of a favicon: 0 is the tile, 1 the coat, 2 the light parts. */
export type IconInk = 0 | 1 | 2;

/** The favicon as rows of inks, 16 or 32 pixels square. */
/**
 * At 16 pixels the drawing is placed by hand, pixel by pixel, so that each eye is a whole pixel
 * pair and nothing reads as a grille: `.` is the tile, `o` the coat, `#` the light parts.
 */
const ICON_16: Record<Mascot, readonly string[]> = {
  bull: [
    '................',
    '.#............#.',
    '.##..........##.',
    '..##........##..',
    '..###oooooo###..',
    '.ooo.oooooo.ooo.',
    '....oooooooo....',
    '....o.oooo.o....',
    '....oooooooo....',
    '....oooooooo....',
    '....########....',
    '...##########...',
    '...##.####.##...',
    '...##########...',
    '....########....',
    '................',
  ],
  owl: [
    '................',
    '..o..........o..',
    '..oo........oo..',
    '..oooooooooooo..',
    '.oo####oo####oo.',
    '.oo#..#oo#..#oo.',
    '.oo#..#oo#..#oo.',
    '.oo####oo####oo.',
    '.oooooo##oooooo.',
    '..oooooooooooo..',
    '..oooooooooooo..',
    '..oooooooooooo..',
    '...oooooooooo...',
    '....oooooooo....',
    '................',
    '................',
  ],
  fox: [
    '................',
    '.o............o.',
    '.oo..........oo.',
    '.ooo........ooo.',
    '.oooo......oooo.',
    '..oooo....oooo..',
    '..oooooooooooo..',
    '.ooo.oooooo.ooo.',
    '.oooooooooooooo.',
    '.##oooooooooo##.',
    '..####oooo####..',
    '...####oo####...',
    '....########....',
    '.....##oo##.....',
    '................',
    '................',
  ],
};

export function favicon(name: Mascot, size: 16 | 32): IconInk[][] {
  if (size === 16) {
    return ICON_16[name].map((line) => Array.from(line, (pixel) => (pixel === '#' ? 2 : pixel === 'o' ? 1 : 0)));
  }
  // At 32 the flat drawing is sampled, with two pixels of margin.
  const margin = 2;
  const inner = size - margin * 2;
  const grid = pixels(iconLayers(name), inner, 6);
  const out: IconInk[][] = [];
  for (let row = 0; row < size; row += 1) {
    const line: IconInk[] = [];
    for (let col = 0; col < size; col += 1) {
      const value = grid[row - margin]?.[col - margin] ?? -1;
      line.push(value < 0.25 ? 0 : value < 0.8 ? 1 : 2);
    }
    out.push(line);
  }
  return out;
}

/** The colours of a mascot favicon: the dark theme's `--blue-fill`, and two inks over it. */
export const ICON_COLOURS = { tile: '#2a66e0', coat: '#9bbefe', light: '#ffffff' } as const;

/** A favicon as SVG: a rounded blue tile and one rectangle per run of pixels of one ink. */
export function faviconSvg(name: Mascot, size: 16 | 32): string {
  const rows = favicon(name, size);
  const fill = [ICON_COLOURS.tile, ICON_COLOURS.coat, ICON_COLOURS.light];
  const rects: string[] = [];
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const ink = row[x] as IconInk;
      let end = x + 1;
      while (end < row.length && row[end] === ink) end += 1;
      if (ink !== 0) rects.push(`<rect x="${x}" y="${y}" width="${end - x}" height="1" fill="${fill[ink]}"/>`);
      x = end;
    }
  });
  const radius = size === 16 ? 3 : 6;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" shape-rendering="crispEdges"><title>Prix</title><rect width="${size}" height="${size}" rx="${radius}" fill="${ICON_COLOURS.tile}" shape-rendering="geometricPrecision"/>${rects.join('')}</svg>`;
}
