/**
 * The local stack: the whole product on this machine, with no Cloudflare login.
 * infra/stack/README.md is the manual.
 *
 *   pnpm stack [--port 8791] [--fresh] [--admin 0x...] [--house 0x...] [--scheduled] [--no-build]
 *   pnpm stack --stop        stops a stack left running by a script that was killed
 *
 * Processes: two `wrangler dev` sessions (prix-api, prix-web; the site's `API` service binding
 * reaches the API through the local dev registry) and a small front server on --port. The front
 * stands in for the zone: it sends /api/* to the API and everything else to the site, exactly
 * as the route `prixagent.com/api/*` does in production.
 *
 * Everything the stack writes is under .artifacts/stack/, which is gitignored.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const STACK_DIR = join(ROOT, '.artifacts', 'stack');
const STATE_DIR = join(STACK_DIR, 'state');
const API_DIR = join(STACK_DIR, 'api');
const WEB_DIR = join(STACK_DIR, 'web');
const SECRETS_FILE = join(STACK_DIR, 'secrets.json');
const PID_FILE = join(STACK_DIR, 'stack.pid.json');
const SEED_FILE = join(STACK_DIR, 'seed.json');
const WRANGLER = join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const DAY_MS = 24 * 60 * 60 * 1000;

const USAGE = `Usage: pnpm stack [options]
  --port <n>      Port of the site and the API. Default 8791. The API uses n+1, the site n+2,
                  and the two inspectors n+3 and n+4.
  --fresh         Start from an empty database. Without it the state of the last run is kept.
  --admin <addr>  Sets ADMIN_ADDRESSES (comma-separated wallet addresses) for a test wallet.
  --house <addr>  Sets HOUSE_OWNERS (comma-separated wallet addresses): the wallets whose agents
                  are house agents. "node infra/seed/house-agents.mjs --wallets" prints the value.
  --scheduled     Exposes the cron handler: POST /__scheduled on the stack's port.
  --no-build      Skip the site build and use the last one.
  --stop          Stop a stack that a killed script left behind.`;

const opts = (() => {
  try {
    return parseArgs({
      options: {
        port: { type: 'string', default: '8791' },
        fresh: { type: 'boolean', default: false },
        admin: { type: 'string', default: '' },
        house: { type: 'string', default: '' },
        scheduled: { type: 'boolean', default: false },
        'no-build': { type: 'boolean', default: false },
        stop: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
    }).values;
  } catch (e) {
    console.error(`${e.message}\n\n${USAGE}`);
    process.exit(2);
  }
})();

if (opts.help) {
  console.log(USAGE);
  process.exit(0);
}

function killTree(pid) {
  if (!pid || pid === process.pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        process.kill(pid, 'SIGKILL');
      }
    }
  } catch {
    // already gone
  }
}

if (opts.stop) {
  if (existsSync(PID_FILE)) {
    for (const pid of JSON.parse(readFileSync(PID_FILE, 'utf8')).pids) killTree(pid);
    rmSync(PID_FILE, { force: true });
    console.log('stack stopped');
  } else console.log('no stack recorded');
  process.exit(0);
}

const port = Number(opts.port);
if (!Number.isInteger(port) || port < 1024 || port > 65530) {
  console.error(`--port must be a number from 1024 to 65530.\n\n${USAGE}`);
  process.exit(2);
}
const apiPort = port + 1;
const webPort = port + 2;
const origin = `http://localhost:${port}`;
const admin = opts.admin.trim();
const house = opts.house.trim();
for (const [flag, value] of [
  ['--admin', admin],
  ['--house', house],
]) {
  if (value !== '' && !value.split(',').every((a) => /^0x[0-9a-fA-F]{40}$/.test(a.trim()))) {
    console.error(`${flag} takes one or more wallet addresses: 0x and 40 hex characters, comma-separated.`);
    process.exit(2);
  }
}

const children = [];
const front = [];
let stopping = false;

function shutdown(code) {
  if (stopping) return;
  stopping = true;
  for (const s of front) s.close();
  for (const c of children) killTree(c.pid);
  rmSync(PID_FILE, { force: true });
  setTimeout(() => process.exit(code), 300).unref();
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) process.on(sig, () => shutdown(0));

function run(label, args, cwd = ROOT) {
  const r = spawnSync(process.execPath, args, {
    cwd,
    encoding: 'utf8',
    timeout: 300_000,
    env: { ...process.env, CI: '1', NO_COLOR: '1' },
  });
  if (r.status !== 0) {
    console.error(`${label} failed (exit ${r.status}).\n${r.stdout ?? ''}\n${r.stderr ?? ''}`);
    shutdown(1);
    throw new Error(`${label} failed`);
  }
  return r.stdout;
}

function start(label, args, cwd) {
  const child = spawn(process.execPath, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1', NO_COLOR: '1' },
    windowsHide: true,
  });
  const logFile = join(STACK_DIR, `${label}.log`);
  writeFileSync(logFile, '');
  const sink = (d) => {
    try {
      writeFileSync(logFile, d, { flag: 'a' });
    } catch {
      // ignore
    }
  };
  child.stdout.on('data', sink);
  child.stderr.on('data', sink);
  child.on('exit', (c) => {
    if (!stopping) {
      console.error(`${label} exited (code ${c}). See ${logFile}`);
      shutdown(1);
    }
  });
  children.push(child);
  return child;
}

function secrets() {
  // Generated once, kept in a gitignored file, never printed.
  if (existsSync(SECRETS_FILE)) {
    const s = JSON.parse(readFileSync(SECRETS_FILE, 'utf8'));
    if (s.KEY_ENCRYPTION_KEY && s.NONCE_SECRET) return s;
  }
  const s = {
    KEY_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    NONCE_SECRET: randomBytes(32).toString('base64'),
  };
  writeFileSync(SECRETS_FILE, JSON.stringify(s), { mode: 0o600 });
  return s;
}

async function get(path) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(8000) });
    await r.arrayBuffer();
    return r.status;
  } catch {
    return 0;
  }
}

function buildSite() {
  console.error('building the site ...');
  const env = { ...process.env, PRIX_FIXTURES: '' };
  const pnpmJs = process.env.npm_execpath;
  const r =
    pnpmJs && /\.c?js$/.test(pnpmJs)
      ? spawnSync(process.execPath, [pnpmJs, '--filter', '@prix/web', 'run', 'build'], {
          cwd: ROOT,
          encoding: 'utf8',
          env,
          timeout: 600_000,
        })
      : spawnSync('pnpm', ['--filter', '@prix/web', 'run', 'build'], {
          cwd: ROOT,
          encoding: 'utf8',
          shell: true,
          env,
          timeout: 600_000,
        });
  if (r.status !== 0) {
    console.error(`site build failed\n${r.stdout}\n${r.stderr}`);
    shutdown(1);
    throw new Error('build failed');
  }
}

async function main() {
  mkdirSync(STACK_DIR, { recursive: true });
  // A stack left behind by a killed script goes first, so its ports and files are free.
  if (existsSync(PID_FILE)) {
    for (const pid of JSON.parse(readFileSync(PID_FILE, 'utf8')).pids) killTree(pid);
    rmSync(PID_FILE, { force: true });
  }
  if (opts.fresh) {
    rmSync(STATE_DIR, { recursive: true, force: true });
    rmSync(SEED_FILE, { force: true });
  }
  for (const d of [STATE_DIR, API_DIR, WEB_DIR]) mkdirSync(d, { recursive: true });

  // 1. The site, a real build.
  const builtConfig = join(ROOT, 'apps/web/dist/server/wrangler.json');
  if (!opts['no-build'] || !existsSync(builtConfig)) buildSite();

  // 2. The two Worker configurations, derived from the real ones. Only what must differ locally
  // differs: no routes (there is no zone), the local origin, absolute paths.
  const sec = secrets();
  const apiConfig = JSON.parse(
    readFileSync(join(ROOT, 'apps/api/wrangler.jsonc'), 'utf8').replace(/^\s*\/\/.*$/gm, ''),
  );
  apiConfig.main = join(ROOT, 'apps/api/src/index.ts');
  apiConfig.routes = undefined;
  apiConfig.secrets = undefined;
  apiConfig.observability = undefined;
  apiConfig.$schema = undefined;
  apiConfig.vars = { ...apiConfig.vars, SITE_ORIGIN: origin, ADMIN_ADDRESSES: admin, HOUSE_OWNERS: house };
  apiConfig.d1_databases[0].migrations_dir = join(ROOT, 'infra/migrations');
  if (!opts.scheduled) apiConfig.triggers = undefined; // nothing runs by itself unless asked
  const apiCfg = join(API_DIR, 'wrangler.json');
  writeFileSync(apiCfg, JSON.stringify(apiConfig, null, 2));
  writeFileSync(
    join(API_DIR, '.dev.vars'),
    `KEY_ENCRYPTION_KEY=${sec.KEY_ENCRYPTION_KEY}\nNONCE_SECRET=${sec.NONCE_SECRET}\n`,
    { mode: 0o600 },
  );

  const built = JSON.parse(readFileSync(builtConfig, 'utf8'));
  const builtDir = dirname(builtConfig);
  built.main = join(builtDir, built.main);
  built.assets = { ...built.assets, directory: resolve(builtDir, built.assets.directory) };
  built.routes = [];
  built.observability = undefined;
  const webCfg = join(WEB_DIR, 'wrangler.json');
  writeFileSync(webCfg, JSON.stringify(built, null, 2));

  // 3. The database: the migrations, then season 1.
  const persist = ['--persist-to', STATE_DIR];
  console.error('applying migrations ...');
  run('migrations', [WRANGLER, 'd1', 'migrations', 'apply', 'DB', '--local', '-c', apiCfg, ...persist], API_DIR);
  let seed = existsSync(SEED_FILE) ? JSON.parse(readFileSync(SEED_FILE, 'utf8')).start : null;
  if (!seed) {
    const d = new Date();
    const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const sinceMonday = (new Date(midnight).getUTCDay() + 6) % 7;
    seed = new Date(midnight - sinceMonday * DAY_MS).toISOString().slice(0, 10);
  }
  console.error(`seeding season 1 (starts ${seed}) ...`);
  run('seed', [join(ROOT, 'infra/seed/season.ts'), '--start', seed, '--config', apiCfg, ...persist]);
  writeFileSync(SEED_FILE, JSON.stringify({ start: seed }));

  // 4. The Workers. The API first: the site's service binding looks it up when a request comes.
  const common = ['--ip', '127.0.0.1', ...persist];
  start(
    'api',
    [
      WRANGLER,
      'dev',
      '-c',
      apiCfg,
      '--port',
      String(apiPort),
      '--inspector-port',
      String(port + 3),
      ...(opts.scheduled ? ['--test-scheduled'] : []),
      ...common,
    ],
    API_DIR,
  );
  start(
    'web',
    [WRANGLER, 'dev', '-c', webCfg, '--port', String(webPort), '--inspector-port', String(port + 4), ...common],
    WEB_DIR,
  );
  writeFileSync(PID_FILE, JSON.stringify({ pids: [process.pid, ...children.map((c) => c.pid)] }));

  // 5. The front: /api/* to the API, everything else to the site.
  const handler = (req, res) => {
    let path = req.url ?? '/';
    let target = webPort;
    if (path === '/__scheduled' || path.startsWith('/__scheduled?')) {
      if (!opts.scheduled || req.method !== 'POST') {
        res.writeHead(opts.scheduled ? 405 : 404).end();
        return;
      }
      path = `/cdn-cgi/handler/scheduled${path.slice('/__scheduled'.length)}`;
      target = apiPort;
    } else if (path === '/api' || path.startsWith('/api/') || path.startsWith('/api?')) {
      target = apiPort;
    }
    const up = http.request(
      { host: '127.0.0.1', port: target, method: req.method, path, headers: req.headers },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      },
    );
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('The stack is not ready.');
    });
    req.pipe(up);
  };
  for (const host of ['127.0.0.1', '::1']) {
    const s = http.createServer(handler);
    s.on('error', (e) => {
      if (host === '127.0.0.1') {
        console.error(`port ${port} is not available: ${e.message}`);
        shutdown(1);
      }
    });
    s.listen(port, host);
    front.push(s);
  }

  // 6. Ready when the landing page and /api/market both answer.
  const deadline = Date.now() + 240_000;
  for (;;) {
    if (stopping) return;
    if ((await get('/')) === 200 && (await get('/api/market')) === 200) break;
    if (Date.now() > deadline) {
      console.error(`the stack did not become ready in time. Logs: ${STACK_DIR}`);
      shutdown(1);
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log(`stack ready on http://localhost:${port}`);
}

main().catch((e) => {
  if (!stopping) {
    console.error(e.message);
    shutdown(1);
  }
});
