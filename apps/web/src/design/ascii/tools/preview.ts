// Prints animals to the terminal, for drawing them. Nothing on the site imports it.
//   node apps/web/src/design/ascii/tools/preview.ts [small|large] [species or id ...]
import { type Character, character, compose, GRIDS, type GridSize, SPECIES } from '../animal.ts';
import { rasterise } from '../paint.ts';

const args = process.argv.slice(2);
const size = (args[0] === 'large' || args[0] === 'small' ? args.shift() : 'small') as GridSize;
const names = args.length ? args : [...SPECIES];
const base = character('preview');
const blocks: string[][] = [];
for (const name of names) {
  const who: Character = (SPECIES as readonly string[]).includes(name)
    ? {
        ...base,
        species: name as Character['species'],
        eyes: 'round',
        marking: 'none',
        accessory: 'none',
        width: 1,
        coat: 0.6,
        lean: 0,
        trait: false,
      }
    : character(name);
  const raster =
    (process.env.PRINT ? 'print' : 'glow') === 'print'
      ? rasterise(compose(who, size === 'large'), GRIDS[size]).print
      : rasterise(compose(who, size === 'large'), GRIDS[size]).glow;
  blocks.push([
    `${who.species} ${who.eyes} ${who.marking} ${who.accessory}`.slice(0, raster.cols).padEnd(raster.cols),
    ...raster.lines,
  ]);
}
const per = size === 'large' ? 3 : 5;
for (let index = 0; index < blocks.length; index += per) {
  const group = blocks.slice(index, index + per);
  const height = Math.max(...group.map((block) => block.length));
  for (let row = 0; row < height; row += 1) console.log(group.map((block) => block[row] ?? '').join(' | '));
  console.log('');
}
