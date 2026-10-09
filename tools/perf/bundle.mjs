// Two checks:
//   1. The size of the API Worker bundle against the free plan's limit of 3 MB after gzip. It runs
//      `wrangler deploy --dry-run --outdir`, which bundles exactly what a deploy uploads and uploads
//      nothing, then gzips every file of the output. Skip it with --skip-worker.
//   2. The compressed JavaScript of the landing page, below. Skip it with --skip-site.
//
// Fails when the compressed JavaScript that the landing page loads is 60 KB or more
// (docs/SPEC.md section 7.5: "under 60 KB of compressed JavaScript on the landing page").
//
//   node tools/perf/bundle.mjs [--no-build] [--path /] [--url http://host] [--html file] [--dist dir]
//
// What it does:
//   1. Builds apps/web (skip with --no-build).
//   2. Gets the HTML of the landing page: a prerendered file in the build if there is one,
//      otherwise the page as `astro preview` serves the build. --url reads it from a server that
//      is already running, --html from a file.
//   3. Finds every script the HTML loads: script tags, module preloads, island components and
//      inline scripts, then follows the static imports of each file through the build.
//   4. Compresses each file with gzip, sums, and compares with the budget.
//
// Counted: everything the browser fetches without a user action. Code behind a dynamic import()
// is listed apart as "on demand" and not counted, because the build cannot tell whether the page
// calls it while loading. If the two together are over the budget the script says so: check it.
// 1 KB is 1,000 bytes. gzip at zlib's default level is the measure; Brotli is shown for reference.
//
// Exit code: 0 under the budget, 1 at or over it or when a script cannot be measured, 2 on an error.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { posix, resolve } from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import {
  ARTIFACTS_DIR,
  astroBin,
  cli,
  kb,
  parseArgs,
  REPO_ROOT,
  run,
  startPreview,
  table,
  UsageError,
  WEB_DIR,
  writeArtifact,
} from './lib.mjs';
import { FREE_PLAN, WEB_BUDGETS } from './limits.mjs';

const USAGE =
  'Usage: node tools/perf/bundle.mjs [--no-build] [--path /] [--url http://host] [--html file] [--dist dir] [--skip-worker] [--skip-site]';

const TAG = (name) => new RegExp(`<${name}\\b((?:"[^"]*"|'[^']*'|[^>"'])*)>`, 'gi');
const SCRIPT = /<script\b((?:"[^"]*"|'[^']*'|[^>"'])*)>([\s\S]*?)<\/script\s*>/gi;
const ATTRIBUTE = /([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
// Script types that are data, not code the browser runs.
const DATA_TYPES = /json|importmap|speculationrules|text\/plain|template/i;
const STATIC_IMPORT = /(?:\bimport|\bfrom)\s*["']([^"']+)["']/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

function attributes(source) {
  const result = {};
  for (const match of source.matchAll(ATTRIBUTE)) {
    result[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return result;
}

function decodeEntities(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Every script reference in the HTML, in document order. */
export function findScripts(html) {
  const external = [];
  const inline = [];
  for (const match of html.matchAll(SCRIPT)) {
    const attrs = attributes(match[1]);
    if (attrs.type && DATA_TYPES.test(attrs.type)) continue;
    if (attrs.src) external.push({ url: attrs.src, how: 'script tag' });
    else if (match[2].trim() !== '') inline.push(match[2]);
  }
  for (const match of html.matchAll(TAG('link'))) {
    const attrs = attributes(match[1]);
    const rel = (attrs.rel ?? '').toLowerCase();
    if (!attrs.href) continue;
    if (rel.split(/\s+/).includes('modulepreload')) external.push({ url: attrs.href, how: 'module preload' });
    else if (rel.split(/\s+/).includes('preload') && attrs.as === 'script')
      external.push({ url: attrs.href, how: 'preload' });
  }
  for (const match of html.matchAll(TAG('astro-island'))) {
    const attrs = attributes(match[1]);
    for (const name of ['component-url', 'renderer-url', 'before-hydration-url']) {
      if (attrs[name]) external.push({ url: attrs[name], how: 'island' });
    }
  }
  return { external, inline };
}

function importsOf(code) {
  const dynamic = new Set([...code.matchAll(DYNAMIC_IMPORT)].map((match) => match[1]));
  const fixed = new Set();
  for (const match of code.matchAll(STATIC_IMPORT)) {
    if (/\.(m?js)(\?.*)?$/.test(match[1]) && /^[./]/.test(match[1])) fixed.add(match[1]);
  }
  return { fixed: [...fixed], dynamic: [...dynamic].filter((specifier) => /^[./]/.test(specifier)) };
}

/** "/_astro/a.js?v=1" or "./b.js" relative to another file -> a path inside the build, or null. */
function toBuildPath(url, fromPath) {
  if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(url) || /^(data|blob):/i.test(url)) return null;
  const clean = url.split('#')[0].split('?')[0];
  const absolute = clean.startsWith('/') ? clean : posix.join(posix.dirname(fromPath), clean);
  return posix.normalize(absolute).replace(/^\/+/, '');
}

function sizes(buffer) {
  return { raw: buffer.length, gzip: gzipSync(buffer).length, brotli: brotliCompressSync(buffer).length };
}

async function measure({ html, distDir, pagePath }) {
  const { external, inline } = findScripts(html);
  const counted = new Map();
  const onDemand = new Map();
  const unmeasured = [];
  const inlineEntries = inline.map((code, index) => ({
    file: `(inline script ${index + 1})`,
    how: 'inline',
    ...sizes(Buffer.from(code)),
  }));

  const queue = [];
  const enqueue = (url, fromPath, how, target) => {
    const path = toBuildPath(url, fromPath);
    if (path === null) {
      if (target === counted)
        unmeasured.push({ url, how, why: 'served from another origin, so it is not in the build' });
      return;
    }
    if (counted.has(path) || (target === onDemand && onDemand.has(path))) return;
    queue.push({ path, how, target, url });
  };
  for (const entry of external) enqueue(entry.url, pagePath, entry.how, counted);
  for (const code of inline) {
    const found = importsOf(code);
    for (const specifier of found.fixed) enqueue(specifier, pagePath, 'import in an inline script', counted);
    for (const specifier of found.dynamic) enqueue(specifier, pagePath, 'on demand', onDemand);
  }

  while (queue.length > 0) {
    const { path, how, target, url } = queue.shift();
    if (counted.has(path) || (target === onDemand && onDemand.has(path))) continue;
    const file = resolve(distDir, path);
    if (!existsSync(file)) {
      if (target === counted) unmeasured.push({ url, how, why: `no file ${path} in the build` });
      continue;
    }
    const buffer = await readFile(file);
    target.set(path, { file: path, how, ...sizes(buffer) });
    // A file that is fetched for sure moves out of the on-demand list.
    if (target === counted) onDemand.delete(path);
    const found = importsOf(buffer.toString('utf8'));
    const fromPath = `/${path}`;
    for (const specifier of found.fixed) {
      enqueue(specifier, fromPath, target === counted ? 'static import' : 'on demand', target);
    }
    for (const specifier of found.dynamic) enqueue(specifier, fromPath, 'on demand', onDemand);
  }
  for (const path of counted.keys()) onDemand.delete(path);

  return { counted: [...inlineEntries, ...counted.values()], onDemand: [...onDemand.values()], unmeasured };
}

function total(entries, key) {
  return entries.reduce((sum, entry) => sum + entry[key], 0);
}

async function landingHtml(options, distDir) {
  if (options.html !== '') {
    return { html: await readFile(resolve(options.html), 'utf8'), source: `file ${options.html}` };
  }
  if (options.url !== '') {
    const url = new URL(options.path, options.url).href;
    const response = await fetch(url, { headers: { accept: 'text/html' } });
    if (response.status !== 200) throw new Error(`${url} answered ${response.status}, not 200.`);
    return { html: await response.text(), source: url };
  }
  const prerendered = resolve(distDir, options.path.replace(/^\/+/, ''), 'index.html');
  if (existsSync(prerendered))
    return { html: await readFile(prerendered, 'utf8'), source: 'prerendered file in the build' };
  const preview = await startPreview();
  try {
    const url = new URL(options.path, preview.baseUrl).href;
    const response = await fetch(url, { headers: { accept: 'text/html' } });
    if (response.status !== 200)
      throw new Error(`The preview of the build answered ${response.status} for ${options.path}, not 200.`);
    return { html: await response.text(), source: `astro preview of the build, ${options.path}` };
  } finally {
    await preview.stop();
  }
}

async function listFiles(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await listFiles(path)));
    else found.push(path);
  }
  return found;
}

/** Runs the Wrangler that the workspace installed, in apps/api, and returns what it printed. */
function wranglerDryRun(outDir) {
  const bin = resolve(REPO_ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [bin, 'deploy', '--dry-run', '--outdir', outDir], {
      cwd: resolve(REPO_ROOT, 'apps', 'api'),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' },
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    const timer = setTimeout(() => child.kill(), 180_000);
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolveRun({ code: code ?? 1, output });
    });
  });
}

/** The API Worker bundle against the free plan's size limit. Returns the report and whether it passes. */
async function workerBundle() {
  const limit = FREE_PLAN.workerScriptGzipBytes;
  const outDir = resolve(ARTIFACTS_DIR, 'api-bundle');
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const { code, output } = await wranglerDryRun(outDir);
  if (code !== 0) throw new Error(`wrangler deploy --dry-run failed in apps/api:\n${output.slice(-1500)}`);
  const files = [];
  for (const path of await listFiles(outDir)) {
    if (!/\.(m?js|wasm|json|txt|html|bin)$/.test(path) || /\.map$/.test(path)) continue;
    const body = await readFile(path);
    files.push({
      file: path.slice(outDir.length + 1).replaceAll('\\', '/'),
      raw: (await stat(path)).size,
      gzip: gzipSync(body, { level: 9 }).length,
    });
  }
  const gzipTotal = total(files, 'gzip');
  const printed = output.match(/Total Upload:[^\n]*/)?.[0] ?? null;
  console.log(
    `API Worker bundle (apps/api, wrangler deploy --dry-run). Budget: under ${kb(limit)} after gzip (free plan).`,
  );
  console.log(`Conditions: gzip level 9 of each output file; 1 KB is 1,000 bytes; Node ${process.version}.`);
  if (printed) console.log(`  Wrangler itself says: ${printed}`);
  console.log(
    table([
      ['File', 'Raw', 'gzip'],
      ...files.map((f) => [f.file, kb(f.raw), kb(f.gzip)]),
      ['Total', kb(total(files, 'raw')), kb(gzipTotal)],
    ]),
  );
  const pass = gzipTotal < limit && files.length > 0;
  console.log(
    `${pass ? 'PASS' : 'FAIL'}: API Worker is ${kb(gzipTotal)} after gzip, ${gzipTotal < limit ? 'under' : 'not under'} the ${kb(limit)} limit (${((gzipTotal / limit) * 100).toFixed(1)}% used).`,
  );
  console.log('');
  return {
    pass,
    report: { limitBytes: limit, gzipBytes: gzipTotal, rawBytes: total(files, 'raw'), wranglerSays: printed, files },
  };
}

async function main() {
  const { options } = parseArgs(process.argv.slice(2), {
    noBuild: false,
    path: '/',
    url: '',
    html: '',
    dist: '',
    skipWorker: false,
    skipSite: false,
  });
  let workerPass = true;
  if (!options.skipWorker) {
    const worker = await workerBundle();
    workerPass = worker.pass;
    await writeArtifact(
      'bundle-worker.json',
      `${JSON.stringify({ measuredAt: new Date().toISOString(), ...worker.report, pass: worker.pass }, null, 2)}\n`,
    );
  }
  if (options.skipSite) return workerPass ? 0 : 1;
  if (!options.path.startsWith('/')) throw new UsageError('--path must start with /');
  const distDir = options.dist === '' ? resolve(WEB_DIR, 'dist', 'client') : resolve(options.dist);
  const budget = WEB_BUDGETS.landingJsBytes;

  if (!options.noBuild && options.dist === '') {
    console.log('Building apps/web ...');
    const code = await run(process.execPath, [astroBin(), 'build'], { cwd: WEB_DIR, quiet: true });
    if (code !== 0) throw new Error('The build of apps/web failed. Run: pnpm --filter @prix/web run build');
  }
  if (!existsSync(distDir)) throw new Error(`No build at ${distDir}. Run without --no-build.`);

  const { html, source } = await landingHtml(options, distDir);
  const result = await measure({ html, distDir, pagePath: options.path });
  const gzipTotal = total(result.counted, 'gzip');
  const onDemandGzip = total(result.onDemand, 'gzip');

  console.log(`Compressed JavaScript on the landing page (${options.path}). Budget: under ${kb(budget)}.`);
  console.log(`Conditions: HTML from ${source}; files from ${distDir.replace(REPO_ROOT, '.')};`);
  console.log(`  gzip at zlib's default level, each file on its own; 1 KB is 1,000 bytes; Node ${process.version}.`);
  console.log('');
  const row = (entry) => [entry.file, entry.how, kb(entry.raw), kb(entry.gzip), kb(entry.brotli)];
  if (result.counted.length === 0) {
    console.log('The page loads no JavaScript.');
  } else {
    console.log(
      table([
        ['Loaded with the page', 'Found as', 'Raw', 'gzip', 'Brotli'],
        ...result.counted.map(row),
        ['Total', '', kb(total(result.counted, 'raw')), kb(gzipTotal), kb(total(result.counted, 'brotli'))],
      ]),
    );
  }
  if (result.onDemand.length > 0) {
    console.log('');
    console.log(
      table([
        ['On demand, not counted', 'Found as', 'Raw', 'gzip', 'Brotli'],
        ...result.onDemand.map(row),
        ['Total', '', kb(total(result.onDemand, 'raw')), kb(onDemandGzip), kb(total(result.onDemand, 'brotli'))],
      ]),
    );
  }
  for (const entry of result.unmeasured) {
    console.log(`NOT MEASURED: ${entry.url} (${entry.how}): ${entry.why}.`);
  }
  console.log('');

  const underBudget = gzipTotal < budget;
  const pass = underBudget && result.unmeasured.length === 0;
  console.log(
    `${pass ? 'PASS' : 'FAIL'}: ${kb(gzipTotal)} of compressed JavaScript, ${underBudget ? 'under' : 'not under'} the ${kb(budget)} budget` +
      `${result.unmeasured.length > 0 ? `; ${result.unmeasured.length} script(s) could not be measured` : ''}.`,
  );
  if (underBudget && gzipTotal + onDemandGzip >= budget) {
    console.log(
      `CHECK: with the on-demand code the total is ${kb(gzipTotal + onDemandGzip)}. If the page imports any of it while loading, it is over the budget.`,
    );
  }

  await writeArtifact(
    'bundle.json',
    `${JSON.stringify({ measuredAt: new Date().toISOString(), path: options.path, source, budgetBytes: budget, gzipBytes: gzipTotal, onDemandGzipBytes: onDemandGzip, pass, ...result }, null, 2)}\n`,
  );
  return pass && workerPass ? 0 : 1;
}

await cli(main, USAGE);
