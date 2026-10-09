/**
 * Paints a stack of shapes into a grid of characters, the way a portrait is printed in type.
 *
 * Each layer is a shape and a brightness from 0 (no ink) to 1 (full ink). Layers are stacked
 * like paper cut-outs: at a point, the topmost layer that covers it decides the brightness. A
 * layer may darken toward its own edge (`rim`), which is what gives a head its volume and draws
 * a fine line around a muzzle or an eye at no cost. One light falls on every picture from the
 * upper left, a little, so a set of agents looks lit by the same lamp.
 *
 * Every cell is sampled at `samples` by `samples` points. The mean brightness picks the
 * character, from the space through `. : - = + * # % @`, and the tone (0 to 4), which the page
 * turns into the agent's hue from dim to bright. A cell no layer touches stays a space.
 */
import type { Shape } from './shapes.ts';

export type Value = number | ((x: number, y: number) => number);

export interface Layer {
  readonly shape: Shape;
  readonly value: Value;
  /** The width of the band along the edge that darkens toward it; 0 for a flat cut-out. */
  readonly rim: number;
  /** How much of the brightness is left at the very edge, from 0 to 1. */
  readonly floor: number;
  /** The ink on the light ground when it is not the brightness: a hole prints dense, a shine prints blank. */
  readonly print: number | undefined;
}

/**
 * A layer. On the light ground ink is dark, so the two kinds of feature that carry a face swap
 * there: a hole (an eye, a nostril; brightness under 0.1) prints as dense ink, and a shine
 * (brightness 1, the light in an eye) prints as blank paper. Everything else prints as it glows,
 * unless `ink` says otherwise: an animal whose colours are its identity (the penguin's dark
 * hood and white face) gives its ink on paper outright.
 */
export function layer(shape: Shape, value: Value, rim = 0, floor = 0.62, ink?: number): Layer {
  const print = ink ?? (typeof value !== 'number' ? undefined : value < 0.1 ? 0.92 : value >= 1 ? 0 : undefined);
  return { shape, value, rim, floor, print };
}

/** The characters from no ink to full ink. Ten steps; one character is one cell. */
export const RAMP = ' .:-=+*#%@';

export type Tone = 0 | 1 | 2 | 3 | 4;

export interface Raster {
  readonly cols: number;
  readonly rows: number;
  /** One string per row, `cols` characters long, each a character of RAMP. */
  readonly lines: readonly string[];
  /** The tone of each cell, row after row. A space has tone 0. */
  readonly tones: Uint8Array;
}

export interface GridSpec {
  readonly cols: number;
  readonly rows: number;
  readonly samples: number;
  /** A curve on the brightness before it becomes a character: above 1 deepens the shadows. */
  readonly contrast: number;
  /** The same curve for the print on the light ground, where thin ink reads fainter than thin light. */
  readonly printContrast: number;
}

function valueAt(value: Value, x: number, y: number): number {
  return typeof value === 'number' ? value : value(x, y);
}

/** The brightness of the topmost layer at one point, or -1 where no layer covers it. */
function sample(layers: readonly Layer[], x: number, y: number): number {
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    const top = layers[index] as Layer;
    const b = top.shape.box;
    if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
    const d = top.shape.d(x, y);
    if (d >= 0) continue;
    return shade(top, d, x, y);
  }
  return -1;
}

/** The step of RAMP of one cell from its mean ink, after the contrast curve. */
function stepOf(mean: number): number {
  return Math.min(9, Math.round(mean * 9.4));
}

/** The tone of one cell from its mean ink, after the contrast curve. */
function toneOf(mean: number): number {
  return Math.min(4, Math.floor(mean * 5));
}

/** The brightness of a layer at a point inside it, `d` being the field there. */
function shade(top: Layer, d: number, x: number, y: number): number {
  let bright = valueAt(top.value, x, y);
  if (top.rim > 0 && -d < top.rim) {
    const t = d >= 0 ? 0 : -d / top.rim;
    bright *= top.floor + (1 - top.floor) * t * t * (3 - 2 * t);
  }
  // The lamp: up and to the left.
  bright *= 1.04 - 0.07 * x - 0.1 * y;
  return bright < 0 ? 0 : bright > 1 ? 1 : bright;
}

/**
 * Two prints of the same picture. `glow` is for the dark ground: ink is light, so the brightest
 * part of the animal is the densest character. `print` is for the light ground: ink is dark, as
 * on paper; the same density, except that an eye prints dark with a blank shine (see `layer`).
 * Outside the animal both are blank.
 *
 * Each sample point reads the field of a shape once and turns its distance into coverage over
 * the width of the sample, so an edge that crosses a cell gives the cell part of its ink. The
 * layers are composited front to back and a point stops at the first opaque one: a 20 by 16
 * grid at one point a cell costs a few hundred field reads, which a server can afford for a
 * whole board.
 */
export function rasterise(layers: readonly Layer[], grid: GridSpec): { glow: Raster; print: Raster } {
  const { cols, rows, samples, contrast, printContrast } = grid;
  const glowLines: string[] = [];
  const printLines: string[] = [];
  const glowTones = new Uint8Array(cols * rows);
  const printTones = new Uint8Array(cols * rows);
  const cellW = 2 / cols;
  const cellH = 2 / rows;
  const count = samples * samples;
  // Coverage runs from full to none over this width, about the size of one sample.
  const width = (cellW + cellH) / 2 / samples;
  const reach = width / 2;
  // Each layer's box, grown by the reach of coverage, in flat arrays; top layer first.
  const total = layers.length;
  const order: Layer[] = [];
  const left = new Float64Array(total);
  const right = new Float64Array(total);
  const tops = new Float64Array(total);
  const bottoms = new Float64Array(total);
  for (let index = 0; index < total; index += 1) {
    const each = layers[total - 1 - index] as Layer;
    order.push(each);
    left[index] = each.shape.box[0] - reach;
    tops[index] = each.shape.box[1] - reach;
    right[index] = each.shape.box[2] + reach;
    bottoms[index] = each.shape.box[3] + reach;
  }
  const candidates = new Int32Array(total);
  for (let row = 0; row < rows; row += 1) {
    let glowLine = '';
    let printLine = '';
    // The layers that reach this row at all.
    const rowTop = -1 + row * cellH;
    const rowBottom = rowTop + cellH;
    let found = 0;
    for (let index = 0; index < total; index += 1) {
      if ((bottoms[index] as number) >= rowTop && (tops[index] as number) <= rowBottom) {
        candidates[found] = index;
        found += 1;
      }
    }
    for (let col = 0; col < cols; col += 1) {
      let light = 0;
      let dark = 0;
      let covered = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        const y = -1 + (row + (sy + 0.5) / samples) * cellH;
        for (let sx = 0; sx < samples; sx += 1) {
          const x = -1 + (col + (sx + 0.5) / samples) * cellW;
          let glow = 0;
          let ink = 0;
          let alpha = 0;
          for (let at = 0; at < found && alpha < 0.995; at += 1) {
            const index = candidates[at] as number;
            if (x < (left[index] as number) || x > (right[index] as number)) continue;
            if (y < (tops[index] as number) || y > (bottoms[index] as number)) continue;
            const top = order[index] as Layer;
            const d = top.shape.d(x, y);
            let cover = 0.5 - d / width;
            if (cover <= 0) continue;
            if (cover > 1) cover = 1;
            const bright = shade(top, d, x, y);
            const weight = (1 - alpha) * cover;
            glow += weight * bright;
            ink += weight * (top.print ?? bright);
            alpha += weight;
          }
          light += glow;
          dark += ink;
          covered += alpha;
        }
      }
      if (covered < 0.05 * count) {
        glowLine += ' ';
        printLine += ' ';
        continue;
      }
      const index = row * cols + col;
      const glowMean = contrast === 1 ? light / count : (light / count) ** contrast;
      let step = stepOf(glowMean);
      // A cell the picture covers by more than half is never blank unless it is meant to be dark.
      if (step === 0 && covered * 2 > count && light / covered > 0.12) step = 1;
      glowLine += RAMP[step];
      glowTones[index] = step === 0 ? 0 : toneOf(glowMean);
      const printMean = printContrast === 1 ? dark / count : (dark / count) ** printContrast;
      step = stepOf(printMean);
      if (step === 0 && covered * 2 > count && dark / covered > 0.12) step = 1;
      printLine += RAMP[step];
      printTones[index] = step === 0 ? 0 : toneOf(printMean);
    }
    glowLines.push(glowLine);
    printLines.push(printLine);
  }
  return {
    glow: { cols, rows, lines: glowLines, tones: glowTones },
    print: { cols, rows, lines: printLines, tones: printTones },
  };
}

/**
 * The picture as square pixels instead of characters: the mean brightness of each pixel, or -1
 * where the picture covers less than half of it. For a favicon, where characters cannot read.
 */
export function pixels(layers: readonly Layer[], size: number, samples = 4): number[][] {
  const out: number[][] = [];
  const step = 2 / size;
  const count = samples * samples;
  for (let row = 0; row < size; row += 1) {
    const line: number[] = [];
    for (let col = 0; col < size; col += 1) {
      let sum = 0;
      let covered = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const x = -1 + (col + (sx + 0.5) / samples) * step;
          const bright = sample(layers, x, -1 + (row + (sy + 0.5) / samples) * step);
          if (bright >= 0) {
            sum += bright;
            covered += 1;
          }
        }
      }
      line.push(covered * 2 < count ? -1 : sum / covered);
    }
    out.push(line);
  }
  return out;
}

/**
 * A picture before it becomes characters: per cell, the ink of the dark ground (`glow`), the ink
 * of the light ground (`ink`) and how much of the cell is covered (`alpha`), each already
 * multiplied by its coverage. Plates are laid over each other (avatar.ts, `lay`) as the
 * layers inside `rasterise` are, so a picture can be cut into plates that are drawn once (a
 * species, an accessory) and stacked per agent. Exact for a grid of one sample a cell, which is
 * every grid of an agent.
 */
export interface Plate {
  readonly glow: Float64Array;
  readonly ink: Float64Array;
  readonly alpha: Float64Array;
}

/** An empty plate of `size` cells. */
export function blankPlate(size: number): Plate {
  return { glow: new Float64Array(size), ink: new Float64Array(size), alpha: new Float64Array(size) };
}

/** Paints layers, bottom first, into a plate of the grid. The grid must have one sample a cell. */
export function plate(layers: readonly Layer[], grid: GridSpec): Plate {
  const { cols, rows, samples } = grid;
  if (samples !== 1) throw new Error('A plate is drawn at one sample a cell.');
  const { glow, ink, alpha } = blankPlate(cols * rows);
  const cellW = 2 / cols;
  const cellH = 2 / rows;
  const width = (cellW + cellH) / 2;
  const reach = width / 2;
  // Top layer first: a cell stops taking ink once it is covered, as in `rasterise`.
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    const top = layers[index] as Layer;
    const box = top.shape.box;
    const left = box[0] - reach;
    const right = box[2] + reach;
    const upper = box[1] - reach;
    const lower = box[3] + reach;
    // Only the cells whose centre the layer can reach.
    const firstCol = Math.max(0, Math.floor((left + 1) / cellW - 0.5));
    const lastCol = Math.min(cols - 1, Math.ceil((right + 1) / cellW - 0.5));
    const firstRow = Math.max(0, Math.floor((upper + 1) / cellH - 0.5));
    const lastRow = Math.min(rows - 1, Math.ceil((lower + 1) / cellH - 0.5));
    for (let row = firstRow; row <= lastRow; row += 1) {
      const y = -1 + (row + 0.5) * cellH;
      if (y < upper || y > lower) continue;
      for (let col = firstCol; col <= lastCol; col += 1) {
        const at = row * cols + col;
        const covered = alpha[at] as number;
        if (covered >= 0.995) continue;
        const x = -1 + (col + 0.5) * cellW;
        if (x < left || x > right) continue;
        const d = top.shape.d(x, y);
        let cover = 0.5 - d / width;
        if (cover <= 0) continue;
        if (cover > 1) cover = 1;
        const bright = shade(top, d, x, y);
        const weight = (1 - covered) * cover;
        glow[at] = (glow[at] as number) + weight * bright;
        ink[at] = (ink[at] as number) + weight * (top.print ?? bright);
        alpha[at] = covered + weight;
      }
    }
  }
  return { glow, ink, alpha };
}

/** A plate as the two prints of characters, by the rules `rasterise` applies to each cell. */
export function finish(from: Plate, grid: GridSpec): { glow: Raster; print: Raster } {
  const { cols, rows, contrast, printContrast } = grid;
  const glowLines: string[] = [];
  const printLines: string[] = [];
  const glowTones = new Uint8Array(cols * rows);
  const printTones = new Uint8Array(cols * rows);
  for (let row = 0; row < rows; row += 1) {
    let glowLine = '';
    let printLine = '';
    for (let col = 0; col < cols; col += 1) {
      const index = row * cols + col;
      const covered = from.alpha[index] as number;
      if (covered < 0.05) {
        glowLine += ' ';
        printLine += ' ';
        continue;
      }
      const light = from.glow[index] as number;
      const dark = from.ink[index] as number;
      const glowMean = contrast === 1 ? light : light ** contrast;
      let step = stepOf(glowMean);
      if (step === 0 && covered * 2 > 1 && light / covered > 0.12) step = 1;
      glowLine += RAMP[step];
      glowTones[index] = step === 0 ? 0 : toneOf(glowMean);
      const printMean = printContrast === 1 ? dark : dark ** printContrast;
      step = stepOf(printMean);
      if (step === 0 && covered * 2 > 1 && dark / covered > 0.12) step = 1;
      printLine += RAMP[step];
      printTones[index] = step === 0 ? 0 : toneOf(printMean);
    }
    glowLines.push(glowLine);
    printLines.push(printLine);
  }
  return {
    glow: { cols, rows, lines: glowLines, tones: glowTones },
    print: { cols, rows, lines: printLines, tones: printTones },
  };
}
