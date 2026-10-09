// Small helpers shared by the scripts in this folder. No dependencies.

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PERF_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(PERF_DIR, '..', '..');
export const WEB_DIR = resolve(REPO_ROOT, 'apps', 'web');
export const ARTIFACTS_DIR = resolve(REPO_ROOT, '.artifacts', 'perf');

/**
 * Parses `--name value`, `--name=value` and bare `--flag` arguments.
 * `spec` maps each option name to its default; a boolean default makes a flag.
 * Unknown options are an error, so a typo cannot silently run with defaults.
 */
export function parseArgs(argv, spec) {
  const options = { ...spec };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = toCamel(eq === -1 ? arg.slice(2) : arg.slice(2, eq));
    if (!Object.hasOwn(spec, name)) throw new UsageError(`Unknown option: ${arg}`);
    if (typeof spec[name] === 'boolean') {
      options[name] = eq === -1 ? true : arg.slice(eq + 1) !== 'false';
      continue;
    }
    const raw = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (raw === undefined) throw new UsageError(`Option ${arg} needs a value`);
    if (typeof spec[name] === 'number') {
      const value = Number(raw);
      if (!Number.isFinite(value)) throw new UsageError(`Option --${name} needs a number, got "${raw}"`);
      options[name] = value;
    } else {
      options[name] = raw;
    }
  }
  return { options, positional };
}

export class UsageError extends Error {}

function toCamel(name) {
  return name.replace(/-([a-z0-9])/g, (_, letter) => letter.toUpperCase());
}

/** 12345.6 -> "12,346". */
export function int(value) {
  return Math.round(value).toLocaleString('en-US');
}

/** Bytes as kilobytes with one decimal. 1 KB is 1,000 bytes. */
export function kb(bytes) {
  return `${(bytes / 1000).toFixed(1)} KB`;
}

/** Prints rows as aligned columns. The first row is the header. */
export function table(rows) {
  const widths = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, String(cell).length);
    });
  }
  const lines = rows.map((row) =>
    row
      .map((cell, i) => (i === 0 ? String(cell).padEnd(widths[i]) : String(cell).padStart(widths[i])))
      .join('  ')
      .trimEnd(),
  );
  lines.splice(1, 0, widths.map((width) => '-'.repeat(width)).join('  '));
  return lines.join('\n');
}

export async function writeArtifact(name, content) {
  const file = resolve(ARTIFACTS_DIR, name);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
  return file;
}

/** The Chromium that Playwright installed. Throws with the fix if it is missing. */
export async function chromiumPath() {
  const { chromium } = await import('@playwright/test');
  const path = chromium.executablePath();
  const { existsSync } = await import('node:fs');
  if (!existsSync(path)) {
    throw new Error(`Playwright's Chromium is not installed at ${path}. Run: pnpm exec playwright install chromium`);
  }
  return path;
}

/**
 * Imports a module from a package that another workspace member depends on.
 * `member` is a path from the repository root, such as "apps/api".
 * It follows the package's `exports` map and takes the ES module build, which is what a Worker bundles.
 */
export async function importFromMember(member, specifier) {
  const require = createRequire(resolve(REPO_ROOT, member, 'package.json'));
  const [name, ...rest] = specifier.startsWith('@') ? splitScoped(specifier) : specifier.split('/');
  const subpath = rest.length === 0 ? '.' : `./${rest.join('/')}`;
  const manifestPath = require.resolve(`${name}/package.json`);
  const manifest = require(manifestPath);
  const entry = manifest.exports?.[subpath];
  const file = typeof entry === 'string' ? entry : (entry?.import ?? entry?.default);
  if (!file) throw new Error(`${name} has no export "${subpath}"`);
  const url = new URL(file, `file:///${dirname(manifestPath).replace(/\\/g, '/')}/`);
  return { module: await import(url.href), version: manifest.version };
}

function splitScoped(specifier) {
  const [scope, name, ...rest] = specifier.split('/');
  return [`${scope}/${name}`, ...rest];
}

export async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

/** Runs a command and resolves with its exit code. Output goes to this process unless `quiet`. */
export function run(command, args, { cwd = REPO_ROOT, quiet = false } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, stdio: quiet ? 'ignore' : 'inherit', shell: false });
    child.on('error', reject);
    child.on('exit', (code) => resolveRun(code ?? 1));
  });
}

/** Path of the Astro command-line entry of apps/web, run with this Node. */
export function astroBin() {
  return resolve(WEB_DIR, 'node_modules', 'astro', 'bin', 'astro.mjs');
}

/**
 * Serves the build in apps/web/dist with `astro preview` and resolves once it answers.
 * Returns the base URL and a function that stops the server.
 */
export async function startPreview({ timeoutMs = 60_000 } = {}) {
  // PRIX_PERF_PORT pins the port, for a machine where only some ports are free to use.
  const port = Number(process.env.PRIX_PERF_PORT) || (await freePort());
  const child = spawn(process.execPath, [astroBin(), 'preview', '--port', String(port), '--host', '127.0.0.1'], {
    cwd: WEB_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  let exited = false;
  child.on('exit', () => {
    exited = true;
  });
  const stop = () =>
    new Promise((resolveStop) => {
      if (exited) return resolveStop();
      child.once('exit', () => resolveStop());
      killTree(child);
    });
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`astro preview exited before it answered.\n${output.slice(-2000)}`);
    try {
      const response = await fetch(baseUrl, { redirect: 'manual', signal: AbortSignal.timeout(2_000) });
      await response.arrayBuffer();
      return { baseUrl, stop };
    } catch {
      await sleep(300);
    }
  }
  await stop();
  throw new Error(`astro preview did not answer on ${baseUrl} within ${timeoutMs} ms.\n${output.slice(-2000)}`);
}

/** Stops a child and the processes it started. On Windows a plain kill leaves workerd running. */
export function killTree(child) {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
}

export function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/** Runs `main`, prints a usage error without a stack, and sets the exit code. */
export async function cli(main, usage) {
  try {
    const code = await main();
    process.exitCode = code ?? 0;
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`${error.message}\n\n${usage}`);
      process.exitCode = 2;
    } else {
      console.error(error instanceof Error ? (error.stack ?? error.message) : error);
      process.exitCode = 2;
    }
  }
}
