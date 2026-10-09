// The client of tools/bench-worker.ts. Run it against a workerd that has just started, so the
// first lines see a cold isolate. A request costs a few milliseconds of its own and that varies,
// so each steady-state figure is worked out from the difference with a request that draws
// nothing, over many requests that each draw 1,000 avatars (the median, then per 100).
//   node apps/web/src/design/ascii/tools/bench-client.mjs http://127.0.0.1:8602 [rounds]
const base = process.argv[2] ?? 'http://127.0.0.1:8602';
const rounds = Number(process.argv[3] ?? '40');

async function once(path) {
  const start = performance.now();
  const response = await fetch(base + path);
  const text = await response.text();
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return [performance.now() - start, text];
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// Cold: what the first requests of an isolate pay.
const empties = [];
for (let index = 0; index < 5; index += 1) empties.push((await once('/noop'))[0]);
const empty = median(empties.slice(1));
const [load, loaded] = await once('/load');
console.log(
  `cold: an empty request ${empty.toFixed(1)} ms; the one that loads avatar.ts (${loaded}) ${load.toFixed(1)} ms`,
);
for (let index = 0; index < 3; index += 1) {
  const [ms] = await once(`/board?n=100&s=cold${index}`);
  console.log(`cold: board ${index + 1} of 100 new avatars ${ms.toFixed(1)} ms a request`);
}

// Steady state.
let seed = 0;
// A new seed for every request, so no id was drawn before.
const fresh = () => {
  seed += 1;
  return seed;
};
const routes = {
  none: () => '/parts?n=0',
  character: () => `/parts?n=1000&part=character&s=${fresh()}`,
  stack: () => `/parts?n=1000&part=stack&s=${fresh()}`,
  'markup (bytes)': () => `/parts?n=1000&part=bytes&s=${fresh()}`,
  'whole avatar': () => `/parts?n=1000&s=${fresh()}`,
  'exact none': () => '/exact?n=0',
  'exact 100': () => `/exact?n=100&s=${fresh()}`,
};
for (const make of Object.values(routes)) for (let index = 0; index < 5; index += 1) await once(make());
const result = Object.fromEntries(Object.keys(routes).map((name) => [name, []]));
for (let round = 0; round < rounds; round += 1) {
  for (const [name, make] of Object.entries(routes)) result[name].push((await once(make()))[0]);
}
const none = median(result.none);
for (const name of ['character', 'stack', 'markup (bytes)', 'whole avatar']) {
  console.log(`steady: up to ${name}: ${((median(result[name]) - none) / 10).toFixed(2)} ms per 100 avatars`);
}
const exact = median(result['exact 100']) - median(result['exact none']);
console.log(`steady: drawn from the shapes, as before: ${exact.toFixed(2)} ms per 100 avatars`);
