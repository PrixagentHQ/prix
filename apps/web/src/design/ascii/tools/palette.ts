// Derives the five tones of each of the eight hues, for both themes, and prints them as the
// custom properties of ascii.css with their contrast on the surfaces an avatar stands on.
//   node apps/web/src/design/ascii/tools/palette.ts
// Each hue keeps the OKLCH hue angle of its mark ground (tokens.css, --hue-*): the animal has
// the colour of its card's accent. Tones step the lightness; chroma is cut to fit sRGB.

type Rgb = [number, number, number];

const HUES: Record<string, { h: number; c: number }> = {
  olive: { h: 124, c: 1 },
  teal: { h: 186, c: 1 },
  petrol: { h: 224, c: 1 },
  violet: { h: 302, c: 1 },
  rose: { h: 354, c: 1 },
  umber: { h: 48, c: 0.62 },
  slate: { h: 256, c: 0.3 },
  ochre: { h: 80, c: 0.95 },
  // The mascot of Prix alone: the hue of the blue of an action (--blue).
  prix: { h: 262, c: 1.25 },
};

// Tone 0 is the dimmest ink, tone 4 the strongest. On dark ink is light; on light it is dark.
const DARK = { l: [0.47, 0.58, 0.69, 0.8, 0.91], c: [0.05, 0.08, 0.11, 0.11, 0.075] };
const LIGHT = { l: [0.7, 0.6, 0.5, 0.41, 0.32], c: [0.07, 0.1, 0.12, 0.12, 0.1] };

function oklchToRgb(l: number, c: number, hDeg: number): Rgb {
  const h = (hDeg * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin: Rgb = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
  return lin.map((v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)) as Rgb;
}

function inGamut(rgb: Rgb): boolean {
  return rgb.every((v) => v >= -0.0005 && v <= 1.0005);
}

function fit(l: number, c: number, h: number): Rgb {
  let chroma = c;
  let rgb = oklchToRgb(l, chroma, h);
  while (!inGamut(rgb) && chroma > 0) {
    chroma -= 0.002;
    rgb = oklchToRgb(l, chroma, h);
  }
  return rgb.map((v) => Math.min(1, Math.max(0, v))) as Rgb;
}

function hex(rgb: Rgb): string {
  return `#${rgb
    .map((v) =>
      Math.round(v * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

function parse(value: string): Rgb {
  const n = Number.parseInt(value.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const la = luminance(parse(a));
  const lb = luminance(parse(b));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// The tile of an avatar is the wash over whatever it stands on; these are the extremes.
const SURFACES = {
  dark: { 'wash on ground': '#191a1c', 'wash on card': '#23262b', 'wash on chosen': '#2b2e35' },
  light: { 'wash on white': '#f4f4f5', 'wash on ground': '#e8eaed' },
};

for (const [theme, steps] of [
  ['dark', DARK],
  ['light', LIGHT],
] as const) {
  console.log(`/* ${theme} */`);
  for (const [name, { h, c }] of Object.entries(HUES)) {
    const tones = steps.l.map((l, index) => hex(fit(l, (steps.c[index] as number) * c, h)));
    const props = tones.map((value, index) => `--ascii-${name}-${index}: ${value};`).join(' ');
    const worst = Object.entries(SURFACES[theme]).map(
      ([where, ground]) => `${where} ${tones.map((t) => contrast(t, ground).toFixed(2)).join('/')}`,
    );
    console.log(`  ${props}
  /* ${worst.join('; ')} */`);
  }
}
