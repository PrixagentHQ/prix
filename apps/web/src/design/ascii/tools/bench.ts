// Times the parts of drawing an animal in Node, for a quick look while drawing. The number that
// counts is measured in workerd: tools/bench-worker.ts.
//   node apps/web/src/design/ascii/tools/bench.ts
export {};

const loadStart = performance.now();
const { agentAvatar, printCharacter } = await import('../avatar.ts');
const loaded = performance.now() - loadStart;
const { character, compose, GRIDS, asciiAnimal } = await import('../animal.ts');
const { rasterise } = await import('../paint.ts');

console.log(`avatar.ts loaded (Node strips the types of every module first): ${loaded.toFixed(1)} ms`);
const ids = Array.from({ length: 400 }, (_, index) => `bench${index.toString(36).padStart(7, '0')}`);
const time = (label: string, run: (id: string) => unknown, list = ids) => {
  const start = performance.now();
  for (const id of list) run(id);
  console.log(`${label}: ${((performance.now() - start) / list.length).toFixed(4)} ms`);
};
time('character', (id) => character(id));
time('from the shapes, small grid', (id) => rasterise(compose(character(id), false), GRIDS.small));
time('from the shapes, large grid', (id) => rasterise(compose(character(id), true), GRIDS.large));
time('from the plates, agentAvatar, new ids', (id) => agentAvatar(id));
time('from the plates, agentAvatar, cached', (id) => agentAvatar(id));

// How far the plates are from drawing each animal from its shapes: cells whose character differs.
let differ = 0;
for (const id of ids) {
  const exact = asciiAnimal(id, 'small').lines.join('');
  const fast = printCharacter(character(id)).glow.lines.join('');
  for (let index = 0; index < exact.length; index += 1) if (exact[index] !== fast[index]) differ += 1;
}
console.log(`cells that differ from the drawing from shapes: ${(differ / ids.length).toFixed(1)} of 320 per animal`);
const sizes = ids.map((id) => agentAvatar(id).html.length);
console.log(`markup of one avatar: ${Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length)} bytes on average`);
