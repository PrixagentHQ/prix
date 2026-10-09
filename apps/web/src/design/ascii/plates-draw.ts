/**
 * Draws the plates of plates.ts from the shapes of each species. Only the tool that writes
 * plates.data.ts and plates-mark.data.ts, and the tests, import this; the site decodes the data
 * instead.
 */
import { accessoryLayers, EYES, eyeLayers, GRIDS, markingLayers, SPECIES, type Species } from './animal.ts';
import { MARK_GRID, markParts } from './framing.ts';
import { type GridSpec, type Layer, plate } from './paint.ts';
import { COAT, type DrawnPlate, type DrawnSpecies, encodePlates, LEANS, type PlateSize } from './plates.ts';
import { ACCESSORIES, DRAW, type Drawing, type Eyes, MARKINGS } from './species.ts';

function draw(layers: readonly Layer[], grid: GridSpec): DrawnPlate {
  const drawn = plate(layers, grid);
  const cells: number[] = [];
  for (let at = 0; at < grid.cols * grid.rows; at += 1) if ((drawn.alpha[at] as number) > 0) cells.push(at);
  return { ...drawn, cells: Uint16Array.from(cells) };
}

function look(lean: number, trait: boolean, eyes: Eyes) {
  return { coat: COAT, lean, trait, eyes, large: false };
}

/** Every plate of one species on the small grid. */
export function drawSpecies(species: Species): DrawnSpecies {
  const grid = GRIDS.small;
  const drawingOf = DRAW[species];
  const back: DrawnPlate[] = [];
  const front: DrawnPlate[] = [];
  for (const trait of [false, true]) {
    for (const lean of LEANS) {
      const drawing = drawingOf(look(lean, trait, 'round'));
      back.push(draw(drawing.back, grid));
      front.push(draw(drawing.front, grid));
    }
  }
  const plain: Drawing = drawingOf(look(0, false, 'round'));
  // A species that draws its own eyes draws them the same for every lean and trait.
  const eyes = EYES.map((kind) =>
    draw(plain.eyes ? (drawingOf(look(0, false, kind)).eyes ?? []) : eyeLayers(plain.anchors, kind, false), grid),
  );
  const markings: (DrawnPlate | undefined)[] = [];
  for (const marking of MARKINGS) {
    for (const side of [-1, 1]) {
      markings.push(
        marking === 'none' || !plain.markings.includes(marking)
          ? undefined
          : draw(markingLayers(plain, marking, side, false), grid),
      );
    }
  }
  const worn = plain.accessories ?? ACCESSORIES;
  const accessories = ACCESSORIES.map((accessory) =>
    accessory === 'none' || !worn.includes(accessory)
      ? undefined
      : draw(accessoryLayers(plain.anchors, accessory, false), grid),
  );
  return { back, front, eyes, markings, accessories };
}

/**
 * Every plate of one species on the mark grid (framing.ts): the head without the shoulders, in
 * each trait and lean, and its eyes. A mark carries no marking and no accessory, so those slots
 * are empty, and the four kinds of eye are the same clear cell.
 */
export function drawMarkSpecies(species: Species): DrawnSpecies {
  const drawingOf = DRAW[species];
  const back: DrawnPlate[] = [];
  const front: DrawnPlate[] = [];
  for (const trait of [false, true]) {
    for (const lean of LEANS) {
      const parts = markParts(species, drawingOf(look(lean, trait, 'round')));
      back.push(draw(parts.back, MARK_GRID));
      front.push(draw(parts.front, MARK_GRID));
    }
  }
  const eye = draw(markParts(species, drawingOf(look(0, false, 'round'))).eyes, MARK_GRID);
  return {
    back,
    front,
    eyes: EYES.map(() => eye),
    markings: MARKINGS.flatMap(() => [undefined, undefined]),
    accessories: ACCESSORIES.map(() => undefined),
  };
}

/** The base64 that plates.data.ts (small) or plates-mark.data.ts (mark) holds, drawn now. */
export function drawPlateData(size: PlateSize = 'small'): string {
  return encodePlates(SPECIES.map((species) => (size === 'mark' ? drawMarkSpecies(species) : drawSpecies(species))));
}
