// The client of ground/tools/bench-worker.ts. Run it against a workerd that has just started, so
// the first request that asks for the field sees a cold isolate. Each steady figure is the median
// difference with an empty request, over many requests that each repeat the work n times.
//   node apps/web/src/design/ground/tools/bench-client.mjs http://127.0.0.1:8912 [rounds]
const base = process.argv[2] ?? 'http://127.0.0.1:8912';
const rounds = Number(process.argv[3] ?? '30');

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

const empties = [];
for (let index = 0; index < 7; index += 1) empties.push((await once('/noop'))[0]);
const empty = median(empties.slice(2));
const [first, body] = await once('/first');
const length = body.length;
console.log(
  `cold: an empty request ${empty.toFixed(2)} ms; the first request that prints the field (${length} characters of markup) ${first.toFixed(2)} ms, ${(first - empty).toFixed(2)} ms more`,
);

async function per(path, n) {
  const differences = [];
  for (let round = 0; round < rounds; round += 1) {
    const [noop] = await once('/noop');
    const [work] = await once(`${path}?n=${n}`);
    differences.push(work - noop);
  }
  return median(differences) / n;
}

const build = await per('/build', 200);
const kept = await per('/kept', 100000);
console.log(`one build of the field: ${build.toFixed(4)} ms (median over ${rounds} rounds of 200)`);
console.log(`printing the field in a page after the first request: ${(kept * 1000).toFixed(4)} µs`);
