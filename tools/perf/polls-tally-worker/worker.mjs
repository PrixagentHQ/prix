// The Worker that tools/perf/polls-tally.mjs starts in local workerd. It is never deployed.
//
//   POST /__perf/sql    runs statements on the local D1 (the migrations, the seed)
//   POST /__perf/alarm  runs the API's own `Clock.alarm()` for SOCIAL_CRON once and answers what it asked for
//
// What is real in /__perf/alarm: the entry's Clock class and its alarm (apps/api/src/index.ts), runCron, the
// social step with every job the entry builds, the stores and the token service on the local D1, the poll tally
// with its per-run fetch meter. What is a stand-in: the chain (tools/perf/polls-fake-chain.mjs, the global
// `fetch` while the alarm runs), the Durable Object's storage (in memory, as apps/api/src/clock-fanout.d1.test.ts
// makes it), the CLOCK namespace (counting every call made on it), the clock (`Date` shifted to the scenario's
// moment while the alarm runs; the fake chain's latency, the head and the meter's AbortSignal.timeout keep the
// real clock), and the AI binding (it throws: no league agent exists, so no model is asked).
//
// Counted, as the contract books the invocation (docs/contracts/phase-6-holders-2.md section 8): every D1
// statement (a batch counts each statement), every fetch sent, every Durable Object call.

import { Clock } from '../../../apps/api/src/index.ts';
import { SOCIAL_CRON } from '../../../packages/contracts/src/index.ts';
import * as wire from '../../../packages/market/src/token-wire.ts';
import { resetTokenMemory } from '../../../packages/runtime/src/token/service.ts';
import { makeFakeChain } from '../polls-fake-chain.mjs';

const RealDate = Date;
const meter = { statements: 0, calls: 0, sql: [] };

function meteredD1(real) {
  class Statement {
    constructor(statement, sql) {
      this.statement = statement;
      this.sql = sql;
    }
    bind(...values) {
      return new Statement(this.statement.bind(...values), this.sql);
    }
    note() {
      meter.calls += 1;
      meter.statements += 1;
      meter.sql.push(this.sql.replace(/\s+/g, ' ').trim().slice(0, 60));
    }
    async all() {
      this.note();
      return this.statement.all();
    }
    async run() {
      this.note();
      return this.statement.run();
    }
    async first(column) {
      this.note();
      return this.statement.first(column);
    }
    async raw(options) {
      this.note();
      return this.statement.raw(options);
    }
  }
  return {
    prepare: (sql) => new Statement(real.prepare(sql), sql),
    async batch(statements) {
      meter.calls += 1;
      meter.statements += statements.length;
      for (const each of statements) meter.sql.push(`[batch] ${each.sql.replace(/\s+/g, ' ').trim().slice(0, 52)}`);
      return real.batch(statements.map((each) => each.statement));
    },
    exec() {
      throw new Error('perf: exec is not expected of the social step');
    },
    withSession() {
      throw new Error('perf: no D1 session in the social step');
    },
  };
}

/** A CLOCK namespace whose every call is counted; a stub's start() does nothing. */
function countedClock(calls) {
  return {
    idFromName: (name) => {
      calls.push(`idFromName ${name}`);
      return { name };
    },
    idFromString: (id) => {
      calls.push(`idFromString ${id}`);
      return { name: id };
    },
    newUniqueId: () => {
      calls.push('newUniqueId');
      return { name: 'unique' };
    },
    get: (id) => {
      calls.push(`get ${id.name}`);
      return {
        start: async (name) => {
          calls.push(`start ${name}`);
        },
      };
    },
    getByName: (name) => {
      calls.push(`getByName ${name}`);
      return { start: async () => undefined };
    },
  };
}

class MemoryStorage {
  constructor() {
    this.data = new Map();
    this.alarm = null;
  }
  async get(key) {
    return this.data.get(key);
  }
  async put(key, value) {
    this.data.set(key, value);
  }
  async getAlarm() {
    return this.alarm;
  }
  async setAlarm(at) {
    this.alarm = typeof at === 'number' ? at : at.getTime();
  }
  async deleteAlarm() {
    this.alarm = null;
  }
  async deleteAll() {
    this.data.clear();
  }
}

const TOKEN = '0xa74ac6e9f2f8493344923c23972d496364241044';
const aiStub = {
  run: async () => {
    throw new Error('no model in the perf run');
  },
};

async function alarm(body, env) {
  const offset = Date.parse(body.at) - RealDate.now();
  const shiftedNow = () => RealDate.now() + offset;
  const chain = makeFakeChain({
    wire,
    token: TOKEN,
    holds: BigInt(body.holds),
    supply: 10n ** 27n,
    head0: BigInt(body.head0),
    latencyMs: body.latencyMs,
    blocksPerSecond: body.blocksPerSecond,
    keylessStateBlocks: body.keylessStateBlocks,
    official: body.official,
    slowMs: body.slowMs ?? 1_400,
    publicnodeSlowCall: body.publicnodeSlowCall ?? null,
    realNow: () => RealDate.now(),
    chainSeconds: () => shiftedNow() / 1000,
  });
  const doCalls = [];
  // A new env object each time, so the entry builds its wiring again: the token configuration's cache is cold, as
  // it is at every social run in production.
  const entryEnv = {
    DB: meteredD1(env.DB),
    CLOCK: countedClock(doCalls),
    AI: aiStub,
    SITE_ORIGIN: 'https://prix.test',
    ADMIN_ADDRESSES: '0x00000000000000000000000000000000000009a1',
    HOUSE_OWNERS: '',
    HOUSE_MODEL: '@cf/test/model',
    HOUSE_MODEL_INPUT_NEURONS: '1',
    HOUSE_MODEL_OUTPUT_NEURONS: '1',
    // Test values that guard nothing, as in apps/api/src/room-entry.d1.test.ts.
    KEY_ENCRYPTION_KEY: btoa('k'.repeat(32)),
    NONCE_SECRET: btoa('n'.repeat(32)),
    SOCIAL_ENABLED: 'true',
    ROOM_ENABLED: 'true',
    POLLS_ENABLED: body.pollsEnabled,
    POLL_TALLY_JOB: body.pollTallyJob,
    HOLDERS_LOUNGE: 'off',
  };
  const storage = new MemoryStorage();
  storage.data.set('cron', SOCIAL_CRON);
  const state = { storage, id: { name: 'perf-clock' }, waitUntil: () => undefined };
  const clock = Object.create(Clock.prototype, { ctx: { value: state }, env: { value: entryEnv } });

  // The token service keeps its configuration in the isolate's memory for TOKEN_CONFIG_CACHE_SECONDS; the contract
  // books its read at every social run (POLL_TALLY_RUN_CONFIG_READS), so each alarm here starts with it cold.
  resetTokenMemory();
  meter.statements = 0;
  meter.calls = 0;
  meter.sql = [];
  const lines = [];
  const realLog = console.log;
  const realError = console.error;
  const keep = (args) => {
    const text = args.map(String).join(' ');
    try {
      const parsed = JSON.parse(text);
      // Event names and their non-address fields only; nothing of a wallet is kept.
      const { event, job, outcome, step, readMs, what, error } = parsed;
      lines.push({ event, job, outcome, step, readMs, what, error });
    } catch {
      lines.push({ text: text.slice(0, 120) });
    }
  };
  const realFetch = globalThis.fetch;
  class ShiftedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(shiftedNow());
      else super(...args);
    }
    static now() {
      return shiftedNow();
    }
  }
  const started = performance.now();
  globalThis.Date = ShiftedDate;
  globalThis.fetch = chain.fetch;
  console.log = (...args) => keep(args);
  console.error = (...args) => keep(args);
  let thrown = null;
  try {
    await clock.alarm();
  } catch (error) {
    thrown = String(error?.name ?? error);
  } finally {
    globalThis.Date = RealDate;
    globalThis.fetch = realFetch;
    console.log = realLog;
    console.error = realError;
  }
  const wallMs = performance.now() - started;
  return {
    thrown,
    wallMs,
    statements: meter.statements,
    d1Calls: meter.calls,
    sql: meter.sql,
    fetches: chain.sent.total,
    fetchesByHost: chain.sent.byHost,
    otherFetches: chain.sent.other,
    doCalls: doCalls.length,
    doCallList: doCalls,
    lines,
  };
}

async function sql(body, env) {
  const results = [];
  if (body.batch) {
    const out = await env.DB.batch(body.statements.map((s) => env.DB.prepare(s.sql).bind(...(s.params ?? []))));
    for (const r of out) results.push({ results: r.results ?? [], meta: r.meta ?? {} });
  } else {
    for (const s of body.statements) {
      const r = await env.DB.prepare(s.sql)
        .bind(...(s.params ?? []))
        .all();
      results.push({ results: r.results ?? [], meta: r.meta ?? {} });
    }
  }
  return { results };
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    try {
      const body = await request.json();
      if (path === '/__perf/sql') return Response.json(await sql(body, env));
      if (path === '/__perf/alarm') return Response.json(await alarm(body, env));
      return Response.json({ message: 'unknown path' }, { status: 404 });
    } catch (error) {
      return Response.json({ message: String(error?.stack ?? error) }, { status: 500 });
    }
  },
};
