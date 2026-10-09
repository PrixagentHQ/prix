/**
 * The twelve animals, each drawn as vector shapes: the shoulders, the head, the ears or horns,
 * the muzzle and the markings that make the species. Eyes, the agent's own marking and its
 * accessory are added on top by animal.ts at the anchors each drawing gives.
 *
 * Brightness is ink: 1 is the brightest character, 0 is a hole. A dark feature (a nose, an
 * eye) is a hole in the fur and a light one (a muzzle, a horn) is dense ink, so a drawing reads
 * in both themes: on the dark ground ink glows, on the light ground it prints.
 *
 * The frame runs from -1 to 1 on both axes, y down. Each drawing leaves about 0.05 clear at the
 * edges so that no animal is cut by the box.
 */
import { type Layer, layer } from './paint.ts';
import {
  above,
  blend,
  circle,
  ellipse,
  intersect,
  len,
  mirror,
  path,
  polygon,
  type Shape,
  star,
  stroke,
  union,
} from './shapes.ts';

export const SPECIES = [
  'bull',
  'bear',
  'owl',
  'fox',
  'wolf',
  'hawk',
  'lion',
  'tortoise',
  'cat',
  'hare',
  'stag',
  'penguin',
] as const;
export type Species = (typeof SPECIES)[number];

/** What varies inside a species. Drawn from the id by animal.ts. */
export interface Look {
  /** The brightness of the coat, 0.5 to 0.7. */
  readonly coat: number;
  /** -1 to 1: how far the ears or horns lean out. */
  readonly lean: number;
  /** A second, smaller choice inside the species: a lop ear, a longer horn, a fuller mane. */
  readonly trait: boolean;
  /** The eyes of the agent; the owl, the cat and the hawk draw their own from it. */
  readonly eyes: Eyes;
  /** True on the large grid: fine strokes (whiskers, feather marks) are drawn thinner and more of them. */
  readonly large: boolean;
}

/** Where the face is, for the eyes, the marking and the accessory. */
export interface Anchors {
  readonly eyeX: number;
  readonly eyeY: number;
  readonly eyeR: number;
  /** The top of the skull on the middle line, where a hat sits. */
  readonly top: number;
  /** Half the width of the head at the height of the eyes. */
  readonly halfWidth: number;
  /** The bottom of the chin, where a tie or a scarf sits. */
  readonly chin: number;
  /** The y of the middle of the head, where a band of headphones is centred. */
  readonly middle: number;
}

export interface Drawing {
  /** Shoulders, ears, horns and the head: what the marking is painted over. */
  readonly back: Layer[];
  /** The head, for clipping the marking. */
  readonly head: Shape;
  /** The muzzle, the nose and everything that sits over a marking. */
  readonly front: Layer[];
  /** The eyes, when the species draws its own (the owl, the cat). */
  readonly eyes?: Layer[];
  readonly anchors: Anchors;
  /** Markings that make sense on this animal. */
  readonly markings: readonly Marking[];
  /** Accessories that sit right on this animal; all of them when left out. */
  readonly accessories?: readonly Accessory[];
}

export const EYES = ['round', 'almond', 'sleepy', 'wide'] as const;
export type Eyes = (typeof EYES)[number];

export const MARKINGS = ['none', 'blaze', 'star', 'patch', 'spots', 'stripes'] as const;
export type Marking = (typeof MARKINGS)[number];

export const ACCESSORIES = ['none', 'cap', 'headphones', 'glasses', 'crown', 'bowtie', 'scarf', 'beanie'] as const;
export type Accessory = (typeof ACCESSORIES)[number];

/** Ink levels shared by every drawing. */
export const INK = { hole: 0.02, dark: 0.24, body: 0.34, light: 0.9, horn: 0.96, shine: 1 } as const;

type Point = readonly [number, number];

/** The points turned by `angle` radians about `pivot`. */
function turn(points: readonly Point[], pivot: Point, angle: number): Point[] {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return points.map(([x, y]) => {
    const dx = x - pivot[0];
    const dy = y - pivot[1];
    return [pivot[0] + dx * cos - dy * sin, pivot[1] + dx * sin + dy * cos];
  });
}

/** Shrinks a polygon toward its centre: the inside of an ear. */
function shrink(points: readonly Point[], by: number, drop = 0): Point[] {
  const cx = points.reduce((sum, [x]) => sum + x, 0) / points.length;
  const cy = points.reduce((sum, [, y]) => sum + y, 0) / points.length;
  return points.map(([x, y]) => [cx + (x - cx) * by, cy + (y - cy) * by + drop]);
}

/** A pair of shapes, left and right, from the left one's points. */
function pair(left: readonly Point[]): [Shape, Shape] {
  return [polygon(left), polygon(mirror(left))];
}

/** Thin strokes are thicker on the small grid, where a cell is twice as wide. */
function hair(look: Look, large: number): number {
  return look.large ? large : large * 1.7;
}

const shoulders = (look: Look, top = 0.72, width = 0.86): Layer =>
  layer(ellipse(0, top + 0.5, width, 0.55), INK.body + (look.coat - 0.6) * 0.3, 0.16, 0.55);

function bull(look: Look): Drawing {
  const horn = look.trait ? 0.12 : 0;
  const reach = 0.06 * look.lean;
  const leftHorn = path(
    [
      [-0.36, -0.3],
      [-0.66 - reach, -0.36],
      [-0.86 - reach, -0.5 - horn / 2],
      [-0.86 - reach, -0.72 - horn],
    ],
    0.12,
    0.035,
  );
  const rightHorn = path(
    [
      [0.36, -0.3],
      [0.66 + reach, -0.36],
      [0.86 + reach, -0.5 - horn / 2],
      [0.86 + reach, -0.72 - horn],
    ],
    0.12,
    0.035,
  );
  const ear = (side: number) => ellipse(side * 0.62, -0.1, 0.21, 0.09, side * 0.35);
  const innerEar = (side: number) => ellipse(side * 0.64, -0.09, 0.13, 0.045, side * 0.35);
  const head = blend(ellipse(0, -0.1, 0.5, 0.38), ellipse(0, 0.3, 0.36, 0.36), 0.18);
  const curls = look.large
    ? [
        layer(circle(-0.09, -0.36, 0.07), 0.85, 0.05, 0.5),
        layer(circle(0.06, -0.38, 0.07), 0.85, 0.05, 0.5),
        layer(circle(-0.01, -0.29, 0.06), 0.8, 0.05, 0.5),
      ]
    : [layer(ellipse(0, -0.35, 0.16, 0.09), 0.82, 0.05, 0.6)];
  return {
    back: [
      shoulders(look),
      layer(leftHorn, INK.horn, 0.05, 0.7),
      layer(rightHorn, INK.horn, 0.05, 0.7),
      layer(ear(-1), look.coat, 0.06, 0.6),
      layer(ear(1), look.coat, 0.06, 0.6),
      layer(innerEar(-1), INK.dark),
      layer(innerEar(1), INK.dark),
      layer(head, look.coat, 0.14, 0.55),
    ],
    head,
    front: [
      ...curls,
      layer(ellipse(0, 0.44, 0.33, 0.22), INK.light, 0.06, 0.7),
      layer(ellipse(-0.12, 0.45, 0.065, 0.05, -0.4), INK.hole),
      layer(ellipse(0.12, 0.45, 0.065, 0.05, 0.4), INK.hole),
      layer(stroke(-0.13, 0.57, 0.13, 0.57, hair(look, 0.018)), INK.dark),
    ],
    anchors: { eyeX: 0.25, eyeY: -0.03, eyeR: 0.075, top: -0.46, halfWidth: 0.5, chin: 0.66, middle: -0.1 },
    markings: ['none', 'blaze', 'star', 'patch', 'spots'],
  };
}

function bear(look: Look): Drawing {
  const out = 0.04 * look.lean;
  const head = ellipse(0, 0.05, 0.6, 0.54);
  return {
    back: [
      shoulders(look, 0.74, 0.9),
      layer(circle(-0.45 - out, -0.42, 0.19), look.coat, 0.07, 0.55),
      layer(circle(0.45 + out, -0.42, 0.19), look.coat, 0.07, 0.55),
      layer(circle(-0.45 - out, -0.41, 0.1), INK.dark),
      layer(circle(0.45 + out, -0.41, 0.1), INK.dark),
      layer(head, look.coat, 0.15, 0.55),
    ],
    head,
    front: [
      layer(ellipse(0, 0.3, 0.28, 0.21), INK.light, 0.07, 0.7),
      layer(ellipse(0, 0.2, 0.12, 0.075), INK.hole),
      layer(circle(-0.035, 0.18, 0.025), 0.75),
      layer(stroke(0, 0.26, 0, 0.34, hair(look, 0.016)), INK.dark),
      layer(
        path(
          [
            [-0.1, 0.36],
            [-0.05, 0.38],
            [0, 0.34],
            [0.05, 0.38],
            [0.1, 0.36],
          ],
          hair(look, 0.016),
        ),
        INK.dark,
      ),
    ],
    anchors: { eyeX: 0.22, eyeY: -0.04, eyeR: 0.065, top: -0.48, halfWidth: 0.6, chin: 0.58, middle: 0.0 },
    markings: ['none', 'blaze', 'star', 'patch', 'spots'],
  };
}

function owl(look: Look): Drawing {
  const tilt = 0.08 * look.lean;
  const [leftTuft, rightTuft] = pair(
    turn(
      [
        [-0.16, -0.5],
        [-0.52, -0.42],
        [-0.56, -0.9],
      ],
      [-0.34, -0.46],
      -tilt,
    ),
  );
  const body = ellipse(0, 0.14, 0.66, 0.8);
  const discs = union(circle(-0.27, -0.1, 0.28), circle(0.27, -0.1, 0.28));
  const eye = (side: number): Layer[] => {
    const cx = side * 0.27;
    const cy = -0.1;
    const r = look.eyes === 'wide' ? 0.155 : look.eyes === 'almond' ? 0.12 : 0.135;
    const out = [
      layer(circle(cx, cy, r), INK.horn, 0.03, 0.6),
      layer(circle(cx, cy, r * 0.58), INK.hole),
      layer(circle(cx - r * 0.22, cy - r * 0.24, r * 0.2), INK.shine),
    ];
    // A sleepy owl: the upper lid comes down over half the eye.
    if (look.eyes === 'sleepy')
      out.push(layer(intersect(circle(cx, cy, r * 1.05), above(cy - r * 0.05)), 0.82, 0.03, 0.7));
    return out;
  };
  const chevrons: Layer[] = [];
  const marks = look.large
    ? [
        [-0.24, 0.5],
        [0, 0.5],
        [0.24, 0.5],
        [-0.12, 0.66],
        [0.12, 0.66],
        [-0.24, 0.82],
        [0, 0.82],
        [0.24, 0.82],
      ]
    : [
        [-0.18, 0.52],
        [0.18, 0.52],
        [0, 0.7],
      ];
  for (const [x, y] of marks as [number, number][]) {
    chevrons.push(
      layer(
        path(
          [
            [x - 0.07, y - 0.04],
            [x, y + 0.03],
            [x + 0.07, y - 0.04],
          ],
          hair(look, 0.02),
        ),
        INK.dark,
      ),
    );
  }
  return {
    back: [
      layer(leftTuft, look.coat, 0.05, 0.6),
      layer(rightTuft, look.coat, 0.05, 0.6),
      layer(body, look.coat, 0.14, 0.5),
      layer(ellipse(-0.6, 0.42, 0.16, 0.44, 0.15), look.coat * 0.75, 0.08, 0.6),
      layer(ellipse(0.6, 0.42, 0.16, 0.44, -0.15), look.coat * 0.75, 0.08, 0.6),
    ],
    head: body,
    front: [
      layer(
        polygon([
          [-0.42, -0.42],
          [0, -0.24],
          [0.42, -0.42],
          [0, -0.33],
        ]),
        INK.dark,
      ),
      layer(intersect(body, above(0.3)), look.coat, 0.14, 0.5),
      layer(discs, 0.82, 0.08, 0.45),
      layer(
        polygon([
          [-0.07, 0.04],
          [0.07, 0.04],
          [0, 0.27],
        ]),
        INK.horn,
        0.02,
        0.7,
      ),
      ...chevrons,
      layer(
        polygon([
          [-0.2, 0.92],
          [-0.1, 0.8],
          [0, 0.92],
        ]),
        0.8,
      ),
      layer(
        polygon([
          [0, 0.92],
          [0.1, 0.8],
          [0.2, 0.92],
        ]),
        0.8,
      ),
    ],
    eyes: [...eye(-1), ...eye(1)],
    anchors: { eyeX: 0.27, eyeY: -0.1, eyeR: 0.13, top: -0.56, halfWidth: 0.6, chin: 0.36, middle: -0.12 },
    markings: ['none'],
  };
}

function fox(look: Look): Drawing {
  const tilt = 0.1 * look.lean;
  const earLeft: Point[] = turn(
    [
      [-0.1, -0.36],
      [-0.58, -0.14],
      [-0.56, -0.92],
    ],
    [-0.34, -0.25],
    -tilt,
  );
  const [leftEar, rightEar] = pair(earLeft);
  const [leftInner, rightInner] = pair(shrink(earLeft, 0.55, 0.06));
  const head = union(
    ellipse(0, -0.08, 0.5, 0.38),
    polygon([
      [-0.66, 0.14],
      [-0.4, -0.12],
      [0.4, -0.12],
      [0.66, 0.14],
      [0.08, 0.6],
      [-0.08, 0.6],
    ]),
  );
  const cheeks = intersect(
    head,
    polygon([
      [-0.7, 0.14],
      [-0.2, 0.1],
      [0, 0.22],
      [0.2, 0.1],
      [0.7, 0.14],
      [0.1, 0.7],
      [-0.1, 0.7],
    ]),
  );
  return {
    back: [
      shoulders(look, 0.74, 0.78),
      layer(
        polygon([
          [-0.3, 0.6],
          [0.3, 0.6],
          [0.4, 0.98],
          [-0.4, 0.98],
        ]),
        INK.light,
        0.08,
        0.7,
      ),
      layer(leftEar, look.coat, 0.06, 0.55),
      layer(rightEar, look.coat, 0.06, 0.55),
      layer(leftInner, INK.dark),
      layer(rightInner, INK.dark),
      layer(head, look.coat, 0.12, 0.55),
    ],
    head,
    front: [
      layer(cheeks, INK.light, 0.05, 0.75),
      layer(ellipse(0, 0.53, 0.08, 0.06), INK.hole),
      layer(stroke(0, 0.0, 0, 0.42, 0.05, 0.035), look.coat + 0.12, 0.02, 0.8),
    ],
    anchors: { eyeX: 0.21, eyeY: -0.03, eyeR: 0.07, top: -0.46, halfWidth: 0.5, chin: 0.62, middle: -0.1 },
    markings: ['none', 'star', 'patch', 'spots'],
  };
}

function wolf(look: Look): Drawing {
  const tilt = 0.08 * look.lean;
  const earLeft: Point[] = turn(
    [
      [-0.14, -0.42],
      [-0.52, -0.28],
      [-0.44, -0.9],
    ],
    [-0.34, -0.4],
    -tilt,
  );
  const [leftEar, rightEar] = pair(earLeft);
  const [leftInner, rightInner] = pair(shrink(earLeft, 0.5, 0.07));
  const ruff: Point[] = [
    [-0.4, -0.2],
    [-0.74, 0.0],
    [-0.62, 0.1],
    [-0.8, 0.26],
    [-0.6, 0.32],
    [-0.66, 0.5],
    [-0.3, 0.5],
  ];
  const head = union(ellipse(0, -0.06, 0.48, 0.44), polygon(ruff), polygon(mirror(ruff)), ellipse(0, 0.34, 0.22, 0.3));
  return {
    back: [
      shoulders(look, 0.74, 0.86),
      layer(leftEar, look.coat, 0.06, 0.55),
      layer(rightEar, look.coat, 0.06, 0.55),
      layer(leftInner, INK.dark),
      layer(rightInner, INK.dark),
      layer(head, look.coat, 0.12, 0.55),
    ],
    head,
    front: [
      layer(intersect(head, ellipse(0, -0.42, 0.34, 0.22)), look.coat * 0.72, 0.06, 0.8),
      layer(
        union(ellipse(0, 0.38, 0.19, 0.26), ellipse(-0.27, 0.24, 0.17, 0.1, -0.3), ellipse(0.27, 0.24, 0.17, 0.1, 0.3)),
        INK.light,
        0.05,
        0.75,
      ),
      layer(ellipse(-0.2, -0.17, 0.08, 0.04, -0.2), INK.light),
      layer(ellipse(0.2, -0.17, 0.08, 0.04, 0.2), INK.light),
      layer(ellipse(0, 0.58, 0.09, 0.065), INK.hole),
      layer(stroke(0, 0.62, 0, 0.66, hair(look, 0.016)), INK.dark),
    ],
    anchors: { eyeX: 0.2, eyeY: -0.04, eyeR: 0.065, top: -0.48, halfWidth: 0.5, chin: 0.66, middle: -0.1 },
    markings: ['none', 'star', 'patch'],
  };
}

function hawk(look: Look): Drawing {
  // The one profile of the set: a hooked beak is the hawk, and it only reads from the side.
  const head = union(
    ellipse(-0.1, -0.2, 0.5, 0.42),
    polygon([
      [-0.56, -0.12],
      [-0.64, 0.56],
      [-0.5, 0.44],
      [-0.44, 0.68],
      [-0.3, 0.5],
      [-0.2, 0.72],
      [-0.06, 0.5],
      [0.06, 0.64],
      [0.16, 0.3],
      [0.3, 0.02],
    ]),
  );
  const beak = polygon([
    [0.22, -0.4],
    [0.46, -0.38],
    [0.66, -0.29],
    [0.79, -0.12],
    [0.8, 0.06],
    [0.72, 0.17],
    [0.69, 0.04],
    [0.6, -0.03],
    [0.32, 0.0],
    [0.2, -0.1],
  ]);
  const feathers: Layer[] = [];
  const marks = look.large
    ? [
        [-0.7, 0.78],
        [-0.4, 0.84],
        [-0.1, 0.84],
        [0.2, 0.8],
        [-0.55, 0.96],
        [-0.25, 0.98],
        [0.05, 0.98],
      ]
    : [
        [-0.55, 0.84],
        [-0.15, 0.86],
      ];
  for (const [x, y] of marks as [number, number][]) {
    feathers.push(
      layer(
        path(
          [
            [x - 0.09, y - 0.05],
            [x, y + 0.03],
            [x + 0.09, y - 0.05],
          ],
          hair(look, 0.02),
        ),
        INK.dark,
      ),
    );
  }
  const eye = 0.075;
  return {
    back: [
      layer(ellipse(-0.2, 1.02, 0.9, 0.5), INK.body + 0.06, 0.14, 0.6),
      ...feathers,
      layer(head, look.coat + 0.26, 0.1, 0.6),
    ],
    head,
    front: [
      layer(
        polygon([
          [-0.16, -0.44],
          [0.26, -0.38],
          [0.24, -0.29],
          [-0.08, -0.31],
        ]),
        look.coat + 0.08,
        0.03,
        0.75,
      ),
      layer(beak, 0.74, 0.05, 0.6),
      layer(ellipse(0.27, -0.2, 0.08, 0.17), 0.9),
      layer(
        path(
          [
            [0.27, -0.04],
            [0.5, -0.06],
            [0.66, -0.01],
          ],
          hair(look, 0.016),
        ),
        INK.dark,
      ),
      layer(ellipse(0.42, -0.22, 0.04, 0.025), INK.hole),
    ],
    eyes: [
      layer(circle(0.07, -0.22, look.large ? eye : 0.09), INK.hole),
      layer(circle(0.045, -0.25, look.large ? eye * 0.38 : 0.035), INK.shine),
    ],
    anchors: { eyeX: 0.07, eyeY: -0.22, eyeR: eye, top: -0.6, halfWidth: 0.48, chin: 0.5, middle: -0.2 },
    markings: ['none'],
    accessories: ['none', 'cap', 'crown', 'scarf', 'beanie'],
  };
}

function lion(look: Look): Drawing {
  const full = look.trait ? 0.06 : 0;
  const mane = star(0, 0.04, 0.78 + full, 0.92 + full, 11, look.lean);
  const maneValue = look.large
    ? (x: number, y: number) => 0.56 + 0.16 * Math.sin(Math.atan2(y - 0.04, x) * 17 + len(x, y) * 6)
    : 0.58;
  const head = ellipse(0, 0.1, 0.44, 0.47);
  return {
    back: [
      shoulders(look, 0.8, 0.9),
      layer(mane, maneValue, 0.12, 0.55),
      layer(circle(-0.36, -0.32, 0.12), look.coat + 0.08, 0.04, 0.6),
      layer(circle(0.36, -0.32, 0.12), look.coat + 0.08, 0.04, 0.6),
      layer(circle(-0.36, -0.31, 0.06), INK.dark),
      layer(circle(0.36, -0.31, 0.06), INK.dark),
      layer(head, look.coat + 0.1, 0.1, 0.55),
    ],
    head,
    front: [
      layer(ellipse(0, 0.04, 0.1, 0.17), look.coat + 0.22),
      layer(ellipse(-0.1, 0.33, 0.14, 0.11), INK.light, 0.04, 0.75),
      layer(ellipse(0.1, 0.33, 0.14, 0.11), INK.light, 0.04, 0.75),
      layer(ellipse(0, 0.45, 0.1, 0.07), INK.light),
      layer(
        polygon([
          [-0.11, 0.17],
          [0.11, 0.17],
          [0, 0.28],
        ]),
        INK.dark + 0.06,
      ),
    ],
    anchors: { eyeX: 0.18, eyeY: -0.02, eyeR: 0.065, top: -0.3, halfWidth: 0.44, chin: 0.55, middle: 0.02 },
    markings: ['none', 'spots'],
    accessories: ['none', 'crown', 'glasses', 'bowtie', 'scarf'],
  };
}

function tortoise(look: Look): Drawing {
  const shell = intersect(ellipse(0, 0.1, 0.9, 0.72), above(0.42));
  const seeds: Point[] = [
    [0, -0.32],
    [-0.42, -0.2],
    [0.42, -0.2],
    [-0.22, 0.12],
    [0.22, 0.12],
    [-0.66, 0.16],
    [0.66, 0.16],
    [0, -0.66],
  ];
  const grout = look.large ? 0.035 : 0.06;
  const plates = (x: number, y: number): number => {
    if (y > 0.3) return 0.78;
    let first = 9;
    let second = 9;
    for (const [sx, sy] of seeds) {
      const d = len(x - sx, (y - sy) * 1.15);
      if (d < first) {
        second = first;
        first = d;
      } else if (d < second) second = d;
    }
    return second - first < grout ? INK.dark : look.coat + 0.04 - first * 0.18;
  };
  const head = ellipse(0, 0.44, 0.27, 0.24);
  return {
    back: [
      layer(ellipse(-0.56, 0.66, 0.18, 0.2), look.coat, 0.06, 0.6),
      layer(ellipse(0.56, 0.66, 0.18, 0.2), look.coat, 0.06, 0.6),
      layer(shell, plates, 0.1, 0.55),
      layer(ellipse(0, 0.3, 0.2, 0.14), look.coat - 0.08),
      layer(head, look.coat + 0.14, 0.07, 0.6),
    ],
    head,
    front: [
      layer(
        path(
          [
            [-0.09, 0.53],
            [0, 0.57],
            [0.09, 0.53],
          ],
          hair(look, 0.016),
        ),
        INK.dark,
      ),
      ...(look.large
        ? [-0.62, -0.56, -0.5, 0.5, 0.56, 0.62].map((x) => layer(stroke(x, 0.78, x, 0.84, 0.018), INK.dark))
        : []),
    ],
    anchors: { eyeX: 0.12, eyeY: 0.39, eyeR: 0.05, top: 0.21, halfWidth: 0.27, chin: 0.67, middle: 0.42 },
    markings: ['none'],
  };
}

function cat(look: Look): Drawing {
  const tilt = 0.1 * look.lean;
  const earLeft: Point[] = turn(
    [
      [-0.14, -0.36],
      [-0.6, -0.16],
      [-0.5, -0.76],
    ],
    [-0.4, -0.3],
    -tilt,
  );
  const [leftEar, rightEar] = pair(earLeft);
  const [leftInner, rightInner] = pair(shrink(earLeft, 0.5, 0.05));
  const head = union(ellipse(0, 0.04, 0.58, 0.46), ellipse(-0.36, 0.22, 0.26, 0.2), ellipse(0.36, 0.22, 0.26, 0.2));
  const whisker = hair(look, 0.014);
  const whiskers = look.large
    ? [
        [0.22, 0.24, 0.8, 0.14],
        [0.22, 0.28, 0.84, 0.28],
        [0.22, 0.32, 0.78, 0.42],
      ]
    : [
        [0.22, 0.24, 0.84, 0.16],
        [0.22, 0.3, 0.84, 0.38],
      ];
  const eye = (side: number): Layer[] => {
    const cx = side * 0.22;
    const cy = 0.0;
    const r = look.eyes === 'wide' ? 0.13 : 0.115;
    const tall = look.eyes === 'round' || look.eyes === 'wide' ? 0.9 : 0.74;
    const out = [
      layer(ellipse(cx, cy, r, r * tall, side * -0.22), 0.88, 0.03, 0.55),
      layer(ellipse(cx, cy, r * (look.eyes === 'wide' ? 0.42 : 0.24), r * 0.72), INK.hole),
      layer(circle(cx - r * 0.42, cy - r * 0.3, r * 0.16), INK.shine),
    ];
    if (look.eyes === 'sleepy')
      out.push(layer(intersect(ellipse(cx, cy, r * 1.1, r, side * -0.22), above(cy)), look.coat, 0.02, 0.8));
    return out;
  };
  return {
    back: [
      shoulders(look, 0.68, 0.82),
      layer(leftEar, look.coat, 0.06, 0.55),
      layer(rightEar, look.coat, 0.06, 0.55),
      layer(leftInner, INK.dark),
      layer(rightInner, INK.dark),
      layer(head, look.coat, 0.13, 0.55),
    ],
    head,
    front: [
      layer(ellipse(-0.085, 0.27, 0.12, 0.09), INK.light, 0.03, 0.75),
      layer(ellipse(0.085, 0.27, 0.12, 0.09), INK.light, 0.03, 0.75),
      layer(ellipse(0, 0.37, 0.08, 0.05), 0.72),
      layer(
        polygon([
          [-0.065, 0.14],
          [0.065, 0.14],
          [0, 0.21],
        ]),
        INK.dark + 0.08,
      ),
      ...whiskers.flatMap(([ax, ay, bx, by]) => [
        layer(stroke(ax as number, ay as number, bx as number, by as number, whisker), 0.94),
        layer(stroke(-(ax as number), ay as number, -(bx as number), by as number, whisker), 0.94),
      ]),
    ],
    eyes: [...eye(-1), ...eye(1)],
    anchors: { eyeX: 0.22, eyeY: 0.0, eyeR: 0.1, top: -0.4, halfWidth: 0.58, chin: 0.48, middle: -0.02 },
    markings: ['none', 'blaze', 'patch', 'stripes', 'spots'],
  };
}

function hare(look: Look): Drawing {
  const tilt = 0.08 * look.lean;
  const left = ellipse(-0.2, -0.52, 0.13, 0.42, -0.14 - tilt);
  const leftInner = ellipse(-0.2, -0.5, 0.06, 0.32, -0.14 - tilt);
  const right = look.trait ? ellipse(0.46, -0.2, 0.38, 0.15, 0.62) : ellipse(0.2, -0.52, 0.13, 0.42, 0.14 + tilt);
  const rightInner = look.trait ? ellipse(0.48, -0.19, 0.27, 0.07, 0.62) : ellipse(0.2, -0.5, 0.06, 0.32, 0.14 + tilt);
  const head = union(ellipse(0, 0.2, 0.46, 0.42), ellipse(-0.28, 0.38, 0.22, 0.18), ellipse(0.28, 0.38, 0.22, 0.18));
  return {
    back: [
      shoulders(look, 0.8, 0.8),
      layer(left, look.coat, 0.06, 0.55),
      layer(right, look.coat, 0.06, 0.55),
      layer(leftInner, INK.dark + 0.04),
      layer(rightInner, INK.dark + 0.04),
      layer(head, look.coat, 0.12, 0.55),
    ],
    head,
    front: [
      layer(ellipse(-0.08, 0.38, 0.11, 0.08), INK.light, 0.03, 0.75),
      layer(ellipse(0.08, 0.38, 0.11, 0.08), INK.light, 0.03, 0.75),
      layer(ellipse(0, 0.3, 0.055, 0.04), INK.dark + 0.08),
      layer(
        polygon([
          [-0.045, 0.45],
          [0.045, 0.45],
          [0.04, 0.53],
          [-0.04, 0.53],
        ]),
        INK.light,
      ),
    ],
    anchors: { eyeX: 0.22, eyeY: 0.12, eyeR: 0.075, top: -0.18, halfWidth: 0.46, chin: 0.6, middle: 0.16 },
    markings: ['none', 'star', 'patch', 'spots'],
  };
}

function stag(look: Look): Drawing {
  const spread = 0.06 * look.lean;
  const antler = (side: number): Shape => {
    const s = (points: Point[]): Point[] => points.map(([x, y]) => [side * (x - (x < -0.3 ? spread : 0)), y]);
    const tines = [
      path(
        s([
          [-0.16, -0.36],
          [-0.32, -0.56],
          [-0.46, -0.76],
          [-0.5, -0.96],
        ]),
        0.05,
        0.025,
      ),
      path(
        s([
          [-0.27, -0.5],
          [-0.12, -0.7],
          [-0.12, -0.82],
        ]),
        0.03,
        0.02,
      ),
      path(
        s([
          [-0.42, -0.7],
          [-0.66, -0.76],
          [-0.78, -0.92],
        ]),
        0.03,
        0.02,
      ),
    ];
    if (look.trait)
      tines.push(
        path(
          s([
            [-0.34, -0.58],
            [-0.58, -0.54],
            [-0.72, -0.6],
          ]),
          0.028,
          0.018,
        ),
      );
    return union(...tines);
  };
  const ear = (side: number) => ellipse(side * 0.5, -0.16, 0.24, 0.1, side * -0.45);
  const innerEar = (side: number) => ellipse(side * 0.52, -0.15, 0.16, 0.05, side * -0.45);
  const head = blend(ellipse(0, -0.06, 0.36, 0.36), ellipse(0, 0.38, 0.2, 0.28), 0.2);
  return {
    back: [
      shoulders(look, 0.76, 0.76),
      layer(antler(1), INK.horn, 0.03, 0.7),
      layer(antler(-1), INK.horn, 0.03, 0.7),
      layer(ear(-1), look.coat, 0.05, 0.6),
      layer(ear(1), look.coat, 0.05, 0.6),
      layer(innerEar(-1), INK.dark),
      layer(innerEar(1), INK.dark),
      layer(head, look.coat, 0.12, 0.55),
    ],
    head,
    front: [layer(ellipse(0, 0.5, 0.17, 0.16), INK.light, 0.04, 0.75), layer(ellipse(0, 0.54, 0.1, 0.065), INK.hole)],
    anchors: { eyeX: 0.21, eyeY: -0.02, eyeR: 0.068, top: -0.4, halfWidth: 0.36, chin: 0.66, middle: -0.06 },
    markings: ['none', 'blaze', 'star', 'spots'],
  };
}

function penguin(look: Look): Drawing {
  // A bust: the dark hood, the white heart of the face, the beak, a white chest between dark shoulders.
  const coat = INK.body + 0.04 + (look.coat - 0.6) * 0.4;
  const head = ellipse(0, -0.16, 0.56, 0.52);
  const face = union(circle(-0.18, -0.07, 0.235), circle(0.18, -0.07, 0.235), ellipse(0, 0.08, 0.36, 0.26));
  return {
    back: [
      layer(ellipse(0, 1.04, 0.9, 0.52), coat, 0.12, 0.6, 0.72),
      layer(ellipse(0, 1.02, 0.44, 0.42), INK.light, 0.06, 0.7, 0.16),
      layer(head, coat, 0.12, 0.6, 0.8),
    ],
    head,
    front: [
      layer(face, INK.light, 0.04, 0.72, 0.16),
      layer(ellipse(-0.47, 0.02, 0.07, 0.15, 0.35), 0.8, 0, 0.62, 0.4),
      layer(ellipse(0.47, 0.02, 0.07, 0.15, -0.35), 0.8, 0, 0.62, 0.4),
      layer(
        polygon([
          [-0.11, 0.03],
          [0.11, 0.03],
          [0.02, 0.22],
          [-0.02, 0.22],
        ]),
        0.6,
        0.03,
        0.7,
        0.6,
      ),
    ],
    anchors: { eyeX: 0.17, eyeY: -0.1, eyeR: 0.075, top: -0.66, halfWidth: 0.55, chin: 0.42, middle: -0.16 },
    markings: ['none'],
  };
}

export const DRAW: Record<Species, (look: Look) => Drawing> = {
  bull,
  bear,
  owl,
  fox,
  wolf,
  hawk,
  lion,
  tortoise,
  cat,
  hare,
  stag,
  penguin,
};
