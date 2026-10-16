// The operator's check that zod runs jitless wherever this package is loaded (DC-T3, TPL2-SEC-1).
//
// zod 4 probes `new Function('')` the first time a `z.object` (or `z.strictObject`) is built, unless
// `jitless` is set (zod 4.6.5, v4/core/util.js `allowsEval`, read in v4/core/schemas.js through
// `const fastEnabled = jit && allowsEval.value`). Under the site's Content-Security-Policy that probe raises
// a `script-src` securitypolicyviolation, so src/zod.ts calls `config({ jitless: true })` at its top level
// and re-exports `z`, and every other module takes `z` from it. The package's `"sideEffects"` names
// zod.ts alone, so the site's bundler keeps that call even where it binds an importer's `z` straight to
// zod's own, and still drops the parts of zod nobody uses (T3-PERF-1). This check holds both halves:
//
// 1. The scan: zod.ts has exactly that shape and package.json's `"sideEffects"` is exactly
//    `["./src/zod.ts"]` (a `false` there lets a bundler drop the setting; a `true` keeps all of zod); and
//    no module of packages/contracts/src but zod.ts imports 'zod' (or a 'zod/...' subpath) at run time, by
//    a static import or export, a side-effect import, a dynamic import or a require. An `import type` or
//    `export type` from 'zod' is erased before anything runs and is allowed. This file is left out of the
//    scan: its control probe below imports zod straight, on purpose.
// 2. The probes, each in a fresh Node process (a module is evaluated once per process, and zod caches the
//    probe's answer): the global `Function` is replaced by a counting proxy before anything is imported,
//    then the target is imported and one more `z.strictObject` is built and parsed. Each prints zod's
//    `jitless` before and after the import and how many times `Function` was called or constructed.
//    - the package's index (`@prix/contracts`): jitless true after, 0 calls;
//    - one subpath module that builds objects (`@prix/contracts/market`): jitless true after, 0 calls;
//    - the control, zod alone with no setting: jitless not true, at least 1 call, which shows that the
//      proxy does see the probe, so the two zeros above mean something.
//
// One line a case; exit 1 on any surprise.
// Usage: node --experimental-strip-types --no-warnings packages/contracts/src/zod.check.mts

/**
 * Node's own process, file reader and child processes, reached without Node's types (the package has none),
 * as room-picture.check.mts does.
 */
interface Spawned {
  status: number | null;
  stdout: string | null;
  stderr: string | null;
}
interface NodeBuiltins {
  'node:fs': {
    readdirSync(path: URL): string[];
    readFileSync(path: URL, encoding: 'utf8'): string;
  };
  'node:child_process': {
    spawnSync(command: string, args: string[], options: { encoding: 'utf8' }): Spawned;
  };
}
const runtime = (
  globalThis as unknown as {
    process?: {
      argv: string[];
      execArgv: string[];
      execPath: string;
      exit(code: number): never;
      stdout: { write(text: string): boolean };
      getBuiltinModule?<K extends keyof NodeBuiltins>(name: K): NodeBuiltins[K] | undefined;
    };
  }
).process;
const fs = runtime?.getBuiltinModule?.('node:fs');
const childProcess = runtime?.getBuiltinModule?.('node:child_process');
const SELF_NAME = 'zod.check.mts';
const script = runtime?.argv[1];
if (runtime === undefined || fs === undefined || childProcess === undefined || script === undefined) {
  throw new Error('Run this script with Node 22.3 or later.');
}
// Only when this file is the program that was started: it starts itself again for each probe.
if (!script.replace(/\\/g, '/').endsWith(`/src/${SELF_NAME}`)) {
  const usage = `node --experimental-strip-types --no-warnings packages/contracts/src/${SELF_NAME}`;
  throw new Error(`Run this file as the program: ${usage}`);
}
// Narrowed copies, so that the functions below see them defined.
const PROC = runtime;
const FS = fs;
const CHILD = childProcess;
const SELF = script;
const SRC = new URL('./', import.meta.url);

type ProbeResult = { before: boolean | null; after: boolean | null; functionCalls: number; parsed: boolean };

if (PROC.argv[2] === 'probe') {
  await runProbe(PROC.argv[3] ?? '');
} else {
  main();
}

/** Runs in the child process: counts `Function` calls around one import, then prints one JSON line. */
async function runProbe(target: string): Promise<void> {
  const RealFunction = globalThis.Function;
  let functionCalls = 0;
  globalThis.Function = new Proxy(RealFunction, {
    apply(fn, thisArg, args) {
      functionCalls += 1;
      return Reflect.apply(fn, thisArg, args);
    },
    construct(fn, args, newTarget) {
      functionCalls += 1;
      return Reflect.construct(fn, args, newTarget === globalThis.Function ? fn : newTarget);
    },
  });
  // The same zod instance as the package's: this file sits in packages/contracts/src and resolves zod
  // through the package's own node_modules, as src/zod.ts does.
  const zod = await import('zod');
  const before = zod.z.config().jitless ?? null;
  if (target !== 'control') await import(target);
  const shape = zod.z.strictObject({ id: zod.z.string(), n: zod.z.number() });
  const parsed = shape.safeParse({ id: 'x', n: 1 }).success;
  const after = zod.z.config().jitless ?? null;
  globalThis.Function = RealFunction;
  const result: ProbeResult = { before, after, functionCalls, parsed };
  PROC.stdout.write(`${JSON.stringify(result)}\n`);
}

function main(): void {
  let failures = 0;
  const line = (ok: boolean, text: string): void => {
    if (!ok) failures += 1;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${text}`);
  };

  // --- 1. The scan -------------------------------------------------------------------------------
  const specifier = String.raw`(['"])zod(?:\/[^'"]*)?\1`;
  // `import x from 'zod'`, `import { z } from 'zod'`, `export { z } from 'zod'`, `export * from 'zod'`,
  // and their `type` forms, which group 2 marks. `[^;]*?` keeps a match inside one statement.
  const fromSpecifier = specifier.replace('\\1', '\\3');
  const fromRe = new RegExp(String.raw`\b(import|export)(\s+type\b)?[^;]*?\bfrom\s*${fromSpecifier}`, 'g');
  const bareRe = new RegExp(String.raw`\bimport\s*${specifier}`, 'g');
  const dynamicRe = new RegExp(String.raw`\b(?:import|require)\s*\(\s*${specifier}\s*\)`, 'g');

  /** Every run-time import of zod in a text, as the matched statements. */
  const runtimeZodImports = (text: string): string[] => {
    const found: string[] = [];
    for (const m of text.matchAll(fromRe)) if (m[2] === undefined) found.push(m[0]);
    for (const m of text.matchAll(bareRe)) found.push(m[0]);
    for (const m of text.matchAll(dynamicRe)) found.push(m[0]);
    return found;
  };

  // The scanner's own cases, so that a regex that matches nothing cannot pass the scan.
  const q = "'";
  const zodLit = `${q}zod${q}`;
  const scannerCases: [string, number][] = [
    [`import { z } from ${zodLit};`, 1],
    [`import { z } from "zod";`, 1],
    [`import * as zz from ${q}zod/v4${q};`, 1],
    [`import {\n  z,\n  type ZodType,\n} from ${zodLit};`, 1],
    [`import ${zodLit};`, 1],
    [`const m = await import(${zodLit});`, 1],
    [`const m = require( ${zodLit} );`, 1],
    [`export { z } from ${zodLit};`, 1],
    [`export * from ${zodLit};`, 1],
    [`import type { ZodType } from ${zodLit};`, 0],
    [`export type { ZodType } from ${zodLit};`, 0],
    [`import type { A } from './a.ts';\nimport { z } from ${zodLit};`, 1],
    [`import { z } from './zod.ts';`, 0],
    [`import { x } from ${q}zodiac${q};`, 0],
    [`// zod is imported by zod.ts only`, 0],
  ];
  for (const [text, expected] of scannerCases) {
    const got = runtimeZodImports(text).length;
    line(got === expected, `scanner case ${JSON.stringify(text)}: ${got} run-time import(s), expected ${expected}`);
  }

  const modules = FS.readdirSync(SRC)
    .filter((name: string) => /\.(?:ts|mts)$/.test(name) && !name.endsWith('.d.ts'))
    .sort();
  const zodTs = FS.readFileSync(new URL('zod.ts', SRC), 'utf8');
  const zodTsImports = runtimeZodImports(zodTs);
  line(zodTsImports.length === 2, `zod.ts has 2 run-time statements from zod (${zodTsImports.length})`);
  line(/^import \{ config \} from 'zod';$/m.test(zodTs), "zod.ts imports config from 'zod'");
  line(/^config\(\{ jitless: true \}\);$/m.test(zodTs), 'zod.ts calls config({ jitless: true }) at its top level');
  line(/^export \{ z \} from 'zod';$/m.test(zodTs), "zod.ts re-exports z from 'zod'");
  const zodTsExports = zodTs.match(/^export\b.*$/gm) ?? [];
  line(zodTsExports.length === 1, `zod.ts has one export statement (${zodTsExports.length})`);
  // With `"sideEffects": false` the site's bundler drops zod.ts's call; with `true`, or no field, it keeps
  // every part of zod (zod.ts says why). Exactly this one file, by the path a bundler matches.
  const pkg = JSON.parse(FS.readFileSync(new URL('../package.json', SRC), 'utf8')) as { sideEffects?: unknown };
  const sideEffects = JSON.stringify(pkg.sideEffects);
  line(sideEffects === '["./src/zod.ts"]', `package.json sideEffects is ${sideEffects}, expected ["./src/zod.ts"]`);
  let scanned = 0;
  let routed = 0;
  for (const name of modules) {
    if (name === 'zod.ts' || name === SELF_NAME) continue;
    scanned += 1;
    const text = FS.readFileSync(new URL(name, SRC), 'utf8');
    const direct = runtimeZodImports(text);
    const told = direct.length === 0 ? 'no direct import of zod' : `imports zod directly: ${direct.join(' | ')}`;
    line(direct.length === 0, `${name}: ${told}`);
    if (/\bfrom\s*['"]\.\/zod\.ts['"]/.test(text)) routed += 1;
  }
  line(scanned > 0 && routed > 0, `${scanned} modules scanned, ${routed} take z from ./zod.ts`);

  // --- 2. The probes -----------------------------------------------------------------------------
  const probe = (target: string): ProbeResult | null => {
    const run = CHILD.spawnSync(PROC.execPath, [...PROC.execArgv, SELF, 'probe', target], { encoding: 'utf8' });
    const out = run.stdout ?? '';
    if (run.status !== 0) {
      console.log(`     probe ${target} exited ${run.status}: ${(run.stderr ?? '').trim()}`);
      return null;
    }
    const last = out.trim().split('\n').pop() ?? '';
    try {
      return JSON.parse(last) as ProbeResult;
    } catch {
      console.log(`     probe ${target} printed ${JSON.stringify(out)}`);
      return null;
    }
  };

  for (const target of ['@prix/contracts', '@prix/contracts/market']) {
    const r = probe(target);
    if (r === null) {
      line(false, `${target}: the probe ran`);
      continue;
    }
    line(r.before !== true, `${target}: jitless before the import is ${String(r.before)} (not yet set)`);
    line(r.after === true, `${target}: z.config().jitless after the import is ${String(r.after)}`);
    line(r.functionCalls === 0, `${target}: Function called ${r.functionCalls} time(s) while its schemas were built`);
    line(r.parsed, `${target}: a z.strictObject built after the import parses`);
  }

  const control = probe('control');
  if (control === null) {
    line(false, 'control: the probe ran');
  } else {
    line(control.after !== true, `control (zod alone): jitless is ${String(control.after)}`);
    const calls = control.functionCalls;
    line(calls >= 1, `control (zod alone): Function called ${calls} time(s), so the proxy sees the probe`);
    line(control.parsed, 'control (zod alone): a z.strictObject parses');
  }

  console.log(failures === 0 ? 'ALL OK' : `${failures} FAILED`);
  PROC.exit(failures === 0 ? 0 : 1);
}
