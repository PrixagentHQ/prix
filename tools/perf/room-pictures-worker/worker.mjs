// The Worker that tools/perf/room-pictures.mjs starts in local workerd. It is never deployed.
//
// It holds the API's own entry (apps/api/src/index.ts) and the contract's picture check, and answers
// these local paths:
//
//   POST /__perf/clock   shows whether this runtime's clock moves while code runs
//   POST /__perf/sql     runs statements on the local D1 (the migrations)
//   POST /__perf/walk    times `roomPictureCheck` on the body: the first call, then the best of `runs`
//   POST /__perf/steps   times the check, SHA-256 and the body's read, each alone
//   POST /__perf/seed    stores what a writer needs before an upload: a session, a holding, a first message
//   POST /__perf/call    sends one request through the API's entry and times it
//
// What is real in /__perf/call: the entry, the app, the guard, the route, the stores on the local D1, the
// bytes on the local KV, WebCrypto. What is a stand-in: the four limiter bindings (they always allow) and
// the request, which is built here and never crossed a network.
//
// Time. workerd has no CPU clock a Worker can read. On this machine `performance.now()` advances while
// code runs (Cloudflare freezes it between I/O in production, not in local development), in steps of one
// millisecond. So a wall time is taken around the call, and the time the isolate spent waiting on D1, KV
// and the Cache API is taken apart from it: every binding call is wrapped, and the wait is the union of
// the spans in which at least one call was under way. Wall less that wait is the CPU estimate; the wall
// itself is its upper bound. The estimate still holds what is neither: the turns of the event loop for
// the body's stream and WebCrypto. And every span is read to a millisecond, so one request's figure is
// good to about two milliseconds either way; a mean of several is better than any one.

import { hashToken, newSessionToken } from '../../../apps/api/src/http/session.ts';
import api from '../../../apps/api/src/index.ts';
import { createD1Store } from '../../../apps/api/src/store/index.ts';
import { createRoomStore } from '../../../apps/api/src/store/room.ts';
import { createTokenStore } from '../../../apps/api/src/store/token.ts';
import { ROOM_ENABLED_VAR, SESSION_COOKIE } from '../../../packages/contracts/src/index.ts';
import {
  ROOM_PICTURE_RATE_BINDING,
  ROOM_PICTURES_ENABLED_VAR,
  ROOM_PICTURES_KV_BINDING,
} from '../../../packages/contracts/src/phase6-room-pictures.ts';
import { roomPictureCheck } from '../../../packages/contracts/src/room-picture.ts';

const ORIGIN = 'https://prix.test';
/** A token address for the local database only. It names nothing on any chain. */
const TOKEN = '0x00000000000000000000000000000000000000aa';

// --- the meter -------------------------------------------------------------------------------------------

/** What one timed call asked of its bindings. Module state on purpose: the entry keeps its wiring per env. */
const meter = {
  open: 0,
  openedAt: 0,
  waitMs: 0,
  d1Calls: 0,
  d1Statements: 0,
  rowsRead: 0,
  rowsWritten: 0,
  kvPuts: 0,
  kvGets: 0,
  kvDeletes: 0,
  cacheCalls: 0,
};
function resetMeter() {
  for (const key of Object.keys(meter)) meter[key] = 0;
}
/** Awaits a binding's promise and adds the span to the wait, counted once while several are under way. */
async function waited(start) {
  if (meter.open === 0) meter.openedAt = performance.now();
  meter.open += 1;
  try {
    return await start();
  } finally {
    meter.open -= 1;
    if (meter.open === 0) meter.waitMs += performance.now() - meter.openedAt;
  }
}
function countRows(results) {
  for (const result of results) {
    meter.rowsRead += result?.meta?.rows_read ?? 0;
    meter.rowsWritten += result?.meta?.rows_written ?? 0;
  }
}

/** The part of the D1 binding the stores use, with every call timed and its rows read from D1's own `meta`. */
function meteredD1(real) {
  class Statement {
    constructor(statement) {
      this.statement = statement;
    }
    bind(...values) {
      return new Statement(this.statement.bind(...values));
    }
    async all() {
      meter.d1Calls += 1;
      meter.d1Statements += 1;
      const result = await waited(() => this.statement.all());
      countRows([result]);
      return result;
    }
    async run() {
      meter.d1Calls += 1;
      meter.d1Statements += 1;
      const result = await waited(() => this.statement.run());
      countRows([result]);
      return result;
    }
    // D1's own `first` hands back no `meta`, so it is asked as `all` here: the same statement, the same rows.
    async first(column) {
      const row = (await this.all()).results[0];
      if (row === undefined) return null;
      return column === undefined ? row : (row[column] ?? null);
    }
    async raw(options) {
      meter.d1Calls += 1;
      meter.d1Statements += 1;
      return waited(() => this.statement.raw(options));
    }
  }
  return {
    prepare: (sql) => new Statement(real.prepare(sql)),
    async batch(statements) {
      meter.d1Calls += 1;
      meter.d1Statements += statements.length;
      const results = await waited(() => real.batch(statements.map((each) => each.statement)));
      countRows(results);
      return results;
    },
    exec() {
      throw new Error('perf: exec is not expected of a store');
    },
    withSession() {
      throw new Error('perf: no statement of the room may run in a D1 session (the contract, section 6)');
    },
  };
}

function meteredKv(real) {
  return {
    put(...args) {
      meter.kvPuts += 1;
      return waited(() => real.put(...args));
    },
    get(...args) {
      meter.kvGets += 1;
      return waited(() => real.get(...args));
    },
    delete(...args) {
      meter.kvDeletes += 1;
      return waited(() => real.delete(...args));
    },
  };
}

/** The Cache API of this location, its three calls timed as waits. Done once for the isolate. */
let cacheWrapped = false;
function wrapCache() {
  if (cacheWrapped || typeof caches === 'undefined') return;
  cacheWrapped = true;
  const cache = caches.default;
  for (const name of ['match', 'put', 'delete']) {
    const real = cache[name].bind(cache);
    try {
      cache[name] = (...args) => {
        meter.cacheCalls += 1;
        return waited(() => real(...args));
      };
    } catch {
      // A cache whose methods cannot be replaced is left as it is: its waits then count as CPU.
    }
  }
}

// --- the env the entry is given, once for the isolate -----------------------------------------------------

const allow = { limit: async () => ({ success: true }) };
let entryEnv = null;
function envOf(env) {
  if (entryEnv !== null) return entryEnv;
  entryEnv = {
    DB: meteredD1(env.DB),
    [ROOM_PICTURES_KV_BINDING]: meteredKv(env[ROOM_PICTURES_KV_BINDING]),
    SITE_ORIGIN: ORIGIN,
    ADMIN_ADDRESSES: '0x00000000000000000000000000000000000009a1',
    HOUSE_MODEL: '@cf/test/model',
    HOUSE_MODEL_INPUT_NEURONS: '1',
    HOUSE_MODEL_OUTPUT_NEURONS: '1',
    // Test values that guard nothing, as in apps/api/src/room-entry.d1.test.ts.
    KEY_ENCRYPTION_KEY: btoa('k'.repeat(32)),
    NONCE_SECRET: btoa('n'.repeat(32)),
    RATE_SIGN_IN: allow,
    RATE_WRITE: allow,
    RATE_READ: allow,
    [ROOM_PICTURE_RATE_BINDING]: allow,
    SOCIAL_ENABLED: 'true',
    [ROOM_ENABLED_VAR]: 'true',
    [ROOM_PICTURES_ENABLED_VAR]: 'true',
  };
  return entryEnv;
}

// --- the four paths ---------------------------------------------------------------------------------------

async function sql(request, env) {
  const { statements } = await request.json();
  for (const text of statements) await env.DB.prepare(text).run();
  return Response.json({ ok: true, statements: statements.length });
}

const WALKS_PER_RUN = 10;

async function walk(request) {
  const runs = Number(new URL(request.url).searchParams.get('runs') ?? '0');
  const file = new Uint8Array(await request.arrayBuffer());
  const from = performance.now();
  const answer = roomPictureCheck(file);
  const firstMs = performance.now() - from;
  // This runtime's clock moves in steps of a millisecond, so a later call is timed ten at a time: the best
  // of `runs` such tens, divided by ten, is read to a tenth of a millisecond.
  let bestMs = null;
  for (let run = 0; run < runs; run += 1) {
    const start = performance.now();
    for (let call = 0; call < WALKS_PER_RUN; call += 1) roomPictureCheck(file);
    const took = (performance.now() - start) / WALKS_PER_RUN;
    bestMs = bestMs === null ? took : Math.min(bestMs, took);
  }
  return Response.json({
    ok: answer.ok,
    problem: answer.ok ? null : answer.problem,
    facts: answer.ok
      ? {
          type: answer.type,
          width: answer.width,
          height: answer.height,
          frames: answer.frames,
          bytes: answer.bytes.length,
        }
      : null,
    sent: file.length,
    firstMs,
    bestMs,
    runs,
  });
}

/**
 * The three steps of an upload whose work grows with the file, each alone and with no binding in it: the
 * check, SHA-256 of the clean bytes, and the body read from a stream into one buffer. For each the first
 * call in this isolate, then the mean of STEP_CALLS more (ten together, so a tenth of a millisecond shows).
 */
const STEP_CALLS = 10;
async function steps(request) {
  const file = new Uint8Array(await request.arrayBuffer());
  const checked = roomPictureCheck(file);
  if (!checked.ok) return Response.json({ ok: false, problem: checked.problem });
  async function readBody() {
    const reader = new Request(ORIGIN, { method: 'POST', body: file }).body.getReader();
    const into = new Uint8Array(file.length);
    let at = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      into.set(value, at);
      at += value.length;
    }
    return at;
  }
  async function timed(step) {
    const from = performance.now();
    await step();
    const firstMs = performance.now() - from;
    const start = performance.now();
    for (let call = 0; call < STEP_CALLS; call += 1) await step();
    return { firstMs, meanMs: (performance.now() - start) / STEP_CALLS };
  }
  return Response.json({
    ok: true,
    sent: file.length,
    // The check ran once above, so only its later calls are read here; its first call is part 2's figure.
    walk: await timed(() => roomPictureCheck(file)),
    sha256: await timed(() => crypto.subtle.digest('SHA-256', checked.bytes)),
    bodyRead: await timed(readBody),
  });
}

/**
 * `wallets` writers who may upload now: gating on, each with a session, a holding of one whole token read
 * a moment ago, and a first message that has stood for two hours. Answers each wallet's session cookie.
 */
async function seed(request, env) {
  const { wallets } = await request.json();
  const now = Date.now();
  const tokens = createTokenStore(env.DB);
  const config = await tokens.getConfig();
  if (!config.enabled) {
    const saved = await tokens.putConfig(
      { enabled: true, tokenAddress: TOKEN, thresholdsPpm: config.thresholdsPpm, buyUrl: config.buyUrl },
      new Date(now).toISOString(),
      'perf',
    );
    if (saved.kind !== 'saved') throw new Error(`perf: the token configuration was not saved (${saved.kind})`);
  }
  const store = createD1Store(env.DB);
  const room = createRoomStore(env.DB);
  const cookies = [];
  for (let index = 0; index < wallets; index += 1) {
    const address = `0x${(0x7c300 + index).toString(16).padStart(40, '0')}`;
    const token = newSessionToken();
    await store.putSession({
      tokenHash: await hashToken(token),
      address,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 3_600_000).toISOString(),
    });
    await tokens.putHolders([
      {
        address,
        balance: '1000000000000000000',
        totalSupply: '1000000000000000000000000000',
        decimals: 18,
        tier: 0,
        maxAgents: 1,
        tokenAddress: TOKEN,
        checkedAt: new Date(now).toISOString(),
        riseTier: null,
        riseSince: null,
      },
    ]);
    await room.putMessage(address, 'a first line', new Date(now - 2 * 3_600_000).toISOString());
    cookies.push(`${SESSION_COOKIE}=${token}`);
  }
  return Response.json({ ok: true, cookies });
}

/** One request through the entry. The spec is the query's `spec` (JSON); the body is this request's body. */
async function call(request, env) {
  const spec = JSON.parse(new URL(request.url).searchParams.get('spec') ?? '{}');
  const body = spec.method === 'GET' ? null : new Uint8Array(await request.arrayBuffer());
  const headers = { ...spec.headers };
  if (body !== null) headers['Content-Length'] = String(body.length);
  const inner = new Request(`${ORIGIN}${spec.path}`, { method: spec.method, headers, body });
  const target = envOf(env);
  wrapCache();
  const handed = [];
  const context = { waitUntil: (promise) => void handed.push(promise), passThroughOnException: () => undefined };
  resetMeter();

  const from = performance.now();
  const response = await api.fetch(inner, target, context);
  const answer = new Uint8Array(await response.arrayBuffer());
  const answeredMs = performance.now() - from;
  await Promise.allSettled(handed);
  const wallMs = performance.now() - from;

  const taken = { ...meter };
  const type = response.headers.get('content-type') ?? '';
  return Response.json({
    status: response.status,
    type,
    bytes: answer.length,
    json: type.includes('json') ? JSON.parse(new TextDecoder().decode(answer)) : null,
    handedToWaitUntil: handed.length,
    answeredMs,
    wallMs,
    waitMs: taken.waitMs,
    cpuMs: wallMs - taken.waitMs,
    d1Calls: taken.d1Calls,
    d1Statements: taken.d1Statements,
    rowsRead: taken.rowsRead,
    rowsWritten: taken.rowsWritten,
    kvPuts: taken.kvPuts,
    kvGets: taken.kvGets,
    kvDeletes: taken.kvDeletes,
    cacheCalls: taken.cacheCalls,
  });
}

/** A busy loop of about `ms` milliseconds by the wall clock, to show whether this runtime's clock moves while code runs. */
function clock() {
  const from = performance.now();
  let spins = 0;
  let sum = 0;
  while (spins < 30_000_000) {
    sum += spins % 7;
    spins += 1;
  }
  return Response.json({ movedMs: performance.now() - from, spins, sum });
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    try {
      if (path === '/__perf/clock') return clock();
      if (path === '/__perf/sql') return await sql(request, env);
      if (path === '/__perf/walk') return await walk(request);
      if (path === '/__perf/steps') return await steps(request);
      if (path === '/__perf/seed') return await seed(request, env);
      if (path === '/__perf/call') return await call(request, env);
      return new Response('not found', { status: 404 });
    } catch (error) {
      return Response.json(
        { ok: false, message: error instanceof Error ? (error.stack ?? error.message) : String(error) },
        { status: 500 },
      );
    }
  },
};
