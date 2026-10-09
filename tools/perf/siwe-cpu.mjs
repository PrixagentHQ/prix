// How long does one Sign-In with Ethereum verification take, against the 10 ms CPU limit of a
// free-plan Worker request? docs/CONTRACTS.md section 2 names this as a risk for perf to measure.
//
//   node tools/perf/siwe-cpu.mjs [--runs 200] [--cold-runs 5]
//
// One verification is what POST /api/siwe/verify computes (docs/CONTRACTS.md section 11): parse the
// message, check its fields, hash it and recover the signer from the signature. Database calls are
// I/O and do not count as CPU time, so they are left out.
//
// This is an ESTIMATE FROM THIS MACHINE. A Worker runs the same JavaScript in V8, but on other
// hardware and with a cold isolate more often than a benchmark loop has. Treat the result as a
// ratio to the limit, not as the number production will show.
//
// Exit code: 0 when the average of the runs is under the limit, 1 when it is not, 2 on an error.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { cpus } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CHAIN_ID, SIWE_STATEMENT } from '../../packages/contracts/src/constants.ts';
import { cli, importFromMember, parseArgs, REPO_ROOT, table, writeArtifact } from './lib.mjs';
import { FREE_PLAN } from './limits.mjs';

const USAGE = 'Usage: node tools/perf/siwe-cpu.mjs [--runs 200] [--cold-runs 5]';

// A fixed test key, the first account of the well-known Hardhat mnemonic. It guards nothing.
const TEST_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const DOMAIN = 'prixagent.com';
const ORIGIN = 'https://prixagent.com';

async function loadViem() {
  // viem is a dependency of apps/api, which is the code that will run this in production.
  const [core, siwe, accounts] = await Promise.all([
    importFromMember('apps/api', 'viem'),
    importFromMember('apps/api', 'viem/siwe'),
    importFromMember('apps/api', 'viem/accounts'),
  ]);
  return { core: core.module, siwe: siwe.module, accounts: accounts.module, version: core.version };
}

async function makeFixture(viem) {
  const account = viem.accounts.privateKeyToAccount(TEST_PRIVATE_KEY);
  const message = viem.siwe.createSiweMessage({
    address: account.address,
    chainId: CHAIN_ID,
    domain: DOMAIN,
    uri: ORIGIN,
    version: '1',
    nonce: 'a3f9c2d17b6e4085a3f9c2d17b6e4085',
    statement: SIWE_STATEMENT,
    issuedAt: new Date(),
    expirationTime: new Date(Date.now() + 5 * 60_000),
  });
  const signature = await account.signMessage({ message });
  return { address: account.address, message, signature };
}

/** One verification: parse, check the fields, recover the signer. Returns true when it verifies. */
async function verifyOnce(viem, fixture) {
  const parsed = viem.siwe.parseSiweMessage(fixture.message);
  const fieldsOk = viem.siwe.validateSiweMessage({ message: parsed, domain: DOMAIN });
  const recovered = await viem.core.recoverMessageAddress({ message: fixture.message, signature: fixture.signature });
  return (
    fieldsOk &&
    parsed.uri === ORIGIN &&
    parsed.chainId === CHAIN_ID &&
    parsed.statement === SIWE_STATEMENT &&
    recovered.toLowerCase() === parsed.address.toLowerCase()
  );
}

/**
 * viem imports the curve code on first use. In a bundled Worker that import reads no file, so the
 * "preloaded" cold run evaluates the module before the clock starts and the plain one does not.
 * The truth for a Worker lies between the two: no file to read, but the module still has to run.
 */
async function preloadCurve() {
  const viemRequire = createRequire(createRequire(resolve(REPO_ROOT, 'apps/api/package.json')).resolve('viem'));
  const commonJsFile = viemRequire.resolve('@noble/curves/secp256k1');
  const esmFile = resolve(dirname(commonJsFile), 'esm', 'secp256k1.js');
  await import(pathToFileURL(existsSync(esmFile) ? esmFile : commonJsFile).href);
}

/** Child mode: time the very first verification in a fresh process and print it as JSON. */
async function coldChild(preloaded) {
  const viem = await loadViem();
  if (preloaded) await preloadCurve();
  // Signing is done with a precomputed signature here, so that the first elliptic-curve
  // operation of the process is the recovery itself, as it is in the Worker.
  const fixture = JSON.parse(process.env.PRIX_SIWE_FIXTURE);
  const cpuBefore = process.cpuUsage();
  const start = performance.now();
  const ok = await verifyOnce(viem, fixture);
  const wallMs = performance.now() - start;
  const cpu = process.cpuUsage(cpuBefore);
  console.log(JSON.stringify({ ok, wallMs, cpuMs: (cpu.user + cpu.system) / 1000 }));
}

function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))];
}

async function main() {
  const childMode = process.argv.find((arg) => arg.startsWith('--cold-child='));
  if (childMode) {
    await coldChild(childMode.endsWith('=preloaded'));
    return 0;
  }
  const { options } = parseArgs(process.argv.slice(2), { runs: 200, coldRuns: 5 });
  const runs = Math.max(1, Math.floor(options.runs));
  const coldRuns = Math.max(0, Math.floor(options.coldRuns));
  const limitMs = FREE_PLAN.cpuMsPerHttpRequest;

  const viem = await loadViem();
  const fixture = await makeFixture(viem);

  // Cold: the first verification of a fresh process, measured in separate processes.
  const coldRun = (mode) => {
    const walls = [];
    for (let i = 0; i < coldRuns; i += 1) {
      const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), `--cold-child=${mode}`], {
        env: { ...process.env, PRIX_SIWE_FIXTURE: JSON.stringify(fixture) },
        encoding: 'utf8',
      });
      if (child.status !== 0) throw new Error(`Cold run failed:\n${child.stderr}`);
      const result = JSON.parse(child.stdout.trim().split('\n').at(-1));
      if (!result.ok) throw new Error('Cold run: the signature did not verify. The measurement is void.');
      walls.push(result.wallMs);
    }
    return walls.sort((a, b) => a - b);
  };
  const coldWall = coldRun('plain');
  const coldPreloadedWall = coldRun('preloaded');

  // Warm: the average the brief asks for. Each run is timed on its own, and the whole loop is
  // also measured with the process CPU clock, which is what the Worker limit counts.
  const samples = [];
  const cpuBefore = process.cpuUsage();
  const loopStart = performance.now();
  for (let i = 0; i < runs; i += 1) {
    const start = performance.now();
    const ok = await verifyOnce(viem, fixture);
    samples.push(performance.now() - start);
    if (!ok) throw new Error('The signature did not verify. The measurement is void.');
  }
  const loopWallMs = performance.now() - loopStart;
  const cpu = process.cpuUsage(cpuBefore);
  const cpuAvgMs = (cpu.user + cpu.system) / 1000 / runs;
  const wallAvgMs = loopWallMs / runs;
  const sorted = [...samples].sort((a, b) => a - b);
  const median = (values) => (values.length > 0 ? values[Math.floor(values.length / 2)] : null);
  const coldMedian = median(coldWall);
  const coldPreloadedMedian = median(coldPreloadedWall);

  // The verdict uses the larger of the two averages, so a noisy CPU clock cannot flatter it.
  const averageMs = Math.max(cpuAvgMs, wallAvgMs);
  const pass = averageMs < limitMs;
  const ms = (value) => `${value.toFixed(3)} ms`;
  const ofLimit = (value) => `${((value / limitMs) * 100).toFixed(0)}% of the limit`;

  console.log('Sign-In with Ethereum verification, CPU cost. ESTIMATE FROM THIS MACHINE.');
  console.log(`Conditions: viem ${viem.version} (ES module build, from apps/api), Node ${process.version},`);
  console.log(`  ${cpus()[0]?.model.trim() ?? 'unknown CPU'}, ${process.platform} ${process.arch}, one thread.`);
  console.log('One run: parseSiweMessage + validateSiweMessage + recoverMessageAddress. No database, no network.');
  console.log('');
  const rows = [
    ['Measure', 'Value', `Against ${limitMs} ms`],
    [`Average of ${runs} runs, wall clock`, ms(wallAvgMs), ofLimit(wallAvgMs)],
    [`Average of ${runs} runs, process CPU clock`, ms(cpuAvgMs), ofLimit(cpuAvgMs)],
    ['Median run', ms(percentile(sorted, 50)), ofLimit(percentile(sorted, 50))],
    ['95th percentile run', ms(percentile(sorted, 95)), ofLimit(percentile(sorted, 95))],
    ['Slowest run', ms(sorted.at(-1)), ofLimit(sorted.at(-1))],
    ['First run of this loop', ms(samples[0]), ofLimit(samples[0])],
  ];
  if (coldMedian !== null) {
    rows.push([
      `First run in a fresh process, curve code already loaded, median of ${coldRuns}`,
      ms(coldPreloadedMedian),
      ofLimit(coldPreloadedMedian),
    ]);
    rows.push([
      `First run in a fresh process, loading the curve code, median of ${coldRuns}`,
      ms(coldMedian),
      ofLimit(coldMedian),
    ]);
  }
  console.log(table(rows));
  console.log('');
  console.log(
    `${pass ? 'PASS' : 'FAIL'}: the average is ${ms(averageMs)}, ${pass ? 'under' : 'not under'} the ${limitMs} ms CPU limit ` +
      `(${(limitMs / averageMs).toFixed(1)}x headroom).`,
  );
  if (coldPreloadedMedian !== null && coldPreloadedMedian >= limitMs) {
    console.log(
      `RISK: the first verification in a fresh process takes ${ms(Math.min(coldPreloadedMedian, coldMedian))} to ${ms(Math.max(coldPreloadedMedian, coldMedian))}, ` +
        'which is not under the limit. A Worker that has just started pays this on its first sign-in. ' +
        'Measure it on a deployed Worker before the gate.',
    );
  } else if (coldMedian !== null && coldMedian >= limitMs) {
    console.log(
      `RISK: the first verification in a fresh process takes ${ms(coldMedian)} when it also loads the curve code ` +
        `(${ms(coldPreloadedMedian)} without). Measure the first sign-in on a deployed Worker before the gate.`,
    );
  } else if (coldMedian !== null) {
    console.log(`The first verification in a fresh process, ${ms(coldMedian)}, is also under the limit.`);
  }
  console.log('The rest of the request (routing, JSON, the cookie, SHA-256 of the token) shares the same 10 ms.');

  await writeArtifact(
    'siwe-cpu.json',
    `${JSON.stringify(
      {
        estimate: true,
        measuredAt: new Date().toISOString(),
        conditions: {
          viem: viem.version,
          node: process.version,
          cpu: cpus()[0]?.model.trim(),
          platform: process.platform,
        },
        limitMs,
        runs,
        wallAvgMs,
        cpuAvgMs,
        medianMs: percentile(sorted, 50),
        p95Ms: percentile(sorted, 95),
        maxMs: sorted.at(-1),
        coldFirstRunMs: coldWall,
        coldFirstRunCurvePreloadedMs: coldPreloadedWall,
        pass,
      },
      null,
      2,
    )}\n`,
  );
  return pass ? 0 : 1;
}

await cli(main, USAGE);
