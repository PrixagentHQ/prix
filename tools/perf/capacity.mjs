// Do the division caps of revision 3 fit the Cloudflare free plan? Measured, not modelled.
//
//   node tools/perf/capacity.mjs [--open 200] [--pro 50] [--page-views 10000]
//        [--sign-ins <agents>] [--prompt-changes <10% of agents>] [--strategy short|long]
//        [--agent-page-share 0.3] [--cache-hit-rate 0] [--cpu-runs 40] [--quick] [--skip-scenarios]
//
// What runs is the product's own code: the D1 store of apps/api/src/store on a local D1 database
// (workerd, the same SQLite and the same row counters as Cloudflare), the scheduler of
// packages/runtime, the engine, the scoring and the public routes of the API. The script fills a
// league to the caps of docs/CONTRACTS.md section 15, replays one UTC trading day one Cron
// Trigger at a time, and reads what D1 reports for every statement.
//
// MEASURED: D1 statements, rows read and rows written of every scheduler step and of every public
// read; the neurons the scheduler counted; how many steps and minutes each round took.
// ASSUMED: how much traffic a day has (the options above), and three characters to a token.
// ESTIMATED: CPU time, from this machine. Cloudflare's own number needs a deploy.
// STAND-INS: the chain and the models. Their answers are made up to be expensive; see
// capacity-world.mjs.
//
// Exit code: 0 when the league fits every daily limit, every round ends inside its hour with every
// agent reached, and every step stays inside the limits of one invocation. 1 when one of those
// does not hold. 2 on a usage error or a crash.

import { cpus } from 'node:os';
import { createWorld, loadProduct, schedulerDeps, seedWorld } from './capacity-world.mjs';
import { cli, int, parseArgs, table, UsageError, writeArtifact } from './lib.mjs';
import {
  DAY_SHAPE,
  DIVISION_CAPS,
  FREE_PLAN,
  HOUSE_CALL_TOKENS,
  PUBLIC_CACHE_SECONDS,
  RPC_READS_PER_SNAPSHOT,
  SCHEDULER_LIMITS,
} from './limits.mjs';
import { applyMigrations, createMeteredD1, D1Error, startLocalD1 } from './local-d1.mjs';

const USAGE =
  'Usage: node tools/perf/capacity.mjs [--open N] [--pro N] [--page-views N] [--sign-ins N] [--prompt-changes N]\n' +
  '       [--strategy short|long] [--agent-page-share 0..1] [--cache-hit-rate 0..1] [--cpu-runs N] [--quick] [--skip-scenarios]';

const SITE_ORIGIN = 'https://prixagent.com';
/** A step that asks models and writes no row, this many times in a row, means the scheduler is stuck. */
const STUCK_AFTER_STEPS = 6;

// --- what the scheduler said ------------------------------------------------------------------------

/** Collects the scheduler's log lines: which ticks it made and finished, and the rows it wrote. */
function createLedger() {
  const ledger = {
    now: null,
    events: new Map(),
    ticks: new Map(),
    tick(id) {
      let tick = ledger.ticks.get(id);
      if (tick === undefined) {
        tick = { id, daily: null, createdAt: null, completedAt: null, steps: 0, rows: new Map() };
        ledger.ticks.set(id, tick);
      }
      return tick;
    },
    log(event, data = {}) {
      if (event === 'row_written') {
        const rows = ledger.tick(data.tickId).rows;
        const key = `${data.division} ${data.status}${data.code ? ` ${data.code}` : ''}`;
        rows.set(key, (rows.get(key) ?? 0) + 1);
        return;
      }
      const detail = [data.error, data.code, data.reason].filter((value) => typeof value === 'string' && value !== '');
      const name = detail.length === 0 ? event : `${event} (${detail.join(', ')})`;
      ledger.events.set(name, (ledger.events.get(name) ?? 0) + 1);
      if (event === 'tick_created') {
        const tick = ledger.tick(data.tickId);
        tick.daily = data.daily === true;
        tick.createdAt ??= ledger.now;
      }
      if (event === 'tick_completed') ledger.tick(data.tickId).completedAt = ledger.now;
    },
  };
  return ledger;
}

function rowsOf(tick, key) {
  return tick.rows.get(key) ?? 0;
}

function otherRows(tick) {
  return [...tick.rows].filter(([key]) => key !== 'pro decided' && key !== 'open decided');
}

// --- one step -----------------------------------------------------------------------------------------

function kindOf(step) {
  if (step.action === 'idle') return step.modelCalls > 0 ? 'Idle, writing summaries' : 'Idle';
  if (step.action === 'tick_created') return 'Tick created';
  if (step.action === 'market_closed') return 'Market found closed';
  if (step.action === 'tick_completed') return 'Ranking and completion';
  if (step.modelCalls > 0 && step.skipped > 0) return 'Decisions and skips';
  if (step.modelCalls > 0) return 'Decisions';
  if (step.skipped > 0) return 'Skips, no model call';
  return 'Ranking';
}

/** Keeps, for every kind of step, how many there were, the most each cost, and the heaviest one to replay. */
function createKinds() {
  const kinds = new Map();
  return {
    kinds,
    add(step, sample) {
      let kind = kinds.get(step.kind);
      if (kind === undefined) {
        kind = {
          name: step.kind,
          steps: 0,
          statements: 0,
          outbound: 0,
          modelCallsAtOnce: 0,
          rowsRead: 0,
          rowsWritten: 0,
        };
        kinds.set(step.kind, kind);
      }
      kind.steps += 1;
      kind.outbound = Math.max(kind.outbound, step.outbound);
      kind.modelCallsAtOnce = Math.max(kind.modelCallsAtOnce, step.modelCallsAtOnce);
      kind.rowsRead = Math.max(kind.rowsRead, step.rowsRead);
      kind.rowsWritten = Math.max(kind.rowsWritten, step.rowsWritten);
      if (step.statements > kind.statements || kind.sample === undefined) {
        kind.statements = Math.max(kind.statements, step.statements);
        kind.sample = sample;
      }
    },
  };
}

/** Runs one scheduler step at `now` and returns what it did and what it cost. */
async function runStep(ctx, now) {
  const { product, world, deps, meter, ledger } = ctx;
  ledger.now = now;
  meter.reset();
  world.usage.step = { calls: 0, mostAtOnce: 0 };
  const marketBefore = world.market.calls;
  const recording = new Map();
  meter.onExecute = (sent, batch, results) => {
    const key = JSON.stringify([batch, sent]);
    const list = recording.get(key);
    if (list === undefined) recording.set(key, [results]);
    else list.push(results);
  };
  const report = await product.runSchedulerStep(deps, now);
  meter.onExecute = null;
  const d1 = meter.take();
  const marketCalls = world.market.calls - marketBefore;
  const step = {
    at: now.toISOString(),
    action: report.action,
    tickId: report.tickId,
    decided: report.decided,
    noDecision: report.noDecision,
    skipped: report.skipped,
    rows: report.decided + report.noDecision + report.skipped,
    pending: report.pending,
    summaries: report.summaries,
    d1Calls: d1.calls,
    statements: d1.statements,
    rowsRead: d1.rowsRead,
    rowsWritten: d1.rowsWritten,
    modelCalls: world.usage.step.calls,
    modelCallsAtOnce: world.usage.step.mostAtOnce,
    marketCalls,
    outbound: d1.statements + world.usage.step.calls + marketCalls * RPC_READS_PER_SNAPSHOT,
  };
  step.kind = kindOf(step);
  if (report.tickId !== null) ledger.tick(report.tickId).steps += 1;
  ctx.kinds.add(step, { now, recording, jump: world.market.jump, byStatement: d1.byStatement });
  return step;
}

function timeOf(day, minute) {
  // Two seconds past the minute: a Cron Trigger never fires exactly on it.
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + minute * 60_000 + 2_000);
}

function tickIdOf(now) {
  return `${now.toISOString().slice(0, 13)}:00Z`;
}

function newTotals() {
  return { stepsRun: 0, stepsCounted: 0, statements: 0, rowsRead: 0, rowsWritten: 0, modelCalls: 0 };
}

function addStep(totals, step) {
  totals.statements += step.statements;
  totals.rowsRead += step.rowsRead;
  totals.rowsWritten += step.rowsWritten;
  totals.modelCalls += step.modelCalls;
}

/** True when a tick's hour has begun at `now` and the scheduler may still create it. */
function tickMayBeCreated(ctx, now) {
  const hour = now.getUTCHours();
  if (hour < DAY_SHAPE.tickFirstHourUtc || hour > DAY_SHAPE.tickLastHourUtc) return false;
  if (now.getUTCMinutes() >= DAY_SHAPE.tickCreateWindowMinutes) return false;
  return !ctx.ledger.ticks.has(tickIdOf(now));
}

/**
 * One UTC day, one step a minute, 1,440 steps. With `quick`, an idle minute is not run once three
 * idle steps in a row cost exactly the same and no tick can begin: it is counted at that cost.
 */
async function runDay(ctx, day, quick) {
  const totals = newTotals();
  let stuck = null;
  let idle = null;
  let sameIdle = 0;
  let rowless = 0;
  for (let minute = 0; minute < DAY_SHAPE.stepsPerDay; minute += 1) {
    const now = timeOf(day, minute);
    if (quick && sameIdle >= 3 && !tickMayBeCreated(ctx, now)) {
      addStep(totals, idle);
      totals.stepsCounted += 1;
      continue;
    }
    const step = await runStep(ctx, now);
    addStep(totals, step);
    totals.stepsRun += 1;
    if (step.kind === 'Idle') {
      const same =
        idle !== null &&
        idle.statements === step.statements &&
        idle.rowsRead === step.rowsRead &&
        idle.rowsWritten === step.rowsWritten;
      sameIdle = same ? sameIdle + 1 : 1;
      idle = step;
    } else {
      sameIdle = 0;
      idle = null;
    }
    rowless = step.action === 'batch' && step.rows === 0 && step.pending > 0 ? rowless + 1 : 0;
    if (rowless >= STUCK_AFTER_STEPS) {
      stuck = { at: step.at, tickId: step.tickId, pending: step.pending, modelCalls: step.modelCalls };
      break;
    }
  }
  return { day, totals, stuck };
}

// --- the scenarios that go wrong on purpose -----------------------------------------------------------

/** Runs steps from `minute` on until the tick `tickId` is complete, at most `most` of them. */
async function runUntilComplete(ctx, day, minute, tickId, most) {
  const totals = newTotals();
  let rowless = 0;
  for (let i = 0; i < most; i += 1) {
    const step = await runStep(ctx, timeOf(day, minute + i));
    addStep(totals, step);
    totals.stepsRun += 1;
    if (ctx.ledger.ticks.get(tickId)?.completedAt) return { totals, completed: true };
    rowless = step.action === 'batch' && step.rows === 0 && step.pending > 0 ? rowless + 1 : 0;
    if (rowless >= STUCK_AFTER_STEPS) break;
  }
  return { totals, completed: false };
}

function describeRows(tick) {
  if (tick === undefined || tick.rows.size === 0) return 'no rows';
  return [...tick.rows].map(([key, count]) => `${count} ${key}`).join(', ');
}

async function runScenarios(ctx) {
  const { world, store } = ctx;
  const first = DAY_SHAPE.tickFirstHourUtc * 60;
  const scenarios = [];

  // 1. The round is found late: the Pro window is over, so Pro agents are skipped, ten a step.
  {
    const day = world.days[1];
    const tickId = `${day}T${String(DAY_SHAPE.tickFirstHourUtc).padStart(2, '0')}:00Z`;
    await runStep(ctx, timeOf(day, first));
    const run = await runUntilComplete(ctx, day, first + DAY_SHAPE.tickWindowMinutes, tickId, 90);
    scenarios.push({
      name: `Steps resume ${DAY_SHAPE.tickWindowMinutes} minutes after the daily tick was created`,
      steps: run.totals.stepsRun + 1,
      outcome: `${describeRows(ctx.ledger.ticks.get(tickId))}; round ${run.completed ? 'completed' : 'NOT completed'}`,
    });
  }

  // 2. The house model's day is used up before the round: every Open agent is skipped.
  {
    const day = world.days[2];
    const tickId = `${day}T${String(DAY_SHAPE.tickFirstHourUtc).padStart(2, '0')}:00Z`;
    await store.addAiNeurons(day, SCHEDULER_LIMITS.houseNeuronsPerDay);
    const run = await runUntilComplete(ctx, day, first, tickId, 90);
    scenarios.push({
      name: 'The house-model allocation is used up before the daily tick',
      steps: run.totals.stepsRun,
      outcome: `${describeRows(ctx.ledger.ticks.get(tickId))}; round ${run.completed ? 'completed' : 'NOT completed'}`,
    });
  }

  // 3. Every feed jumps by half at once: twenty new holds in the step that would create the tick.
  {
    const day = world.days[3];
    world.market.jump = 1.5;
    const step = await runStep(ctx, timeOf(day, first));
    world.market.jump = 1;
    scenarios.push({
      name: 'Every price moves by half between two ticks',
      steps: 1,
      outcome: `the step answered "${step.action}" with ${step.statements} D1 statements`,
    });
  }
  return scenarios;
}

// --- the public reads ---------------------------------------------------------------------------------

/** Sends the anonymous GET requests of a page view through the real routes and meters each one. */
async function measureReads(ctx, now) {
  const { product, world, store, meter } = ctx;
  const openAgent = world.agents.find((entry) => entry.agent.division === 'open')?.agent ?? null;
  const proAgent = world.agents.find((entry) => entry.agent.division === 'pro')?.agent ?? null;
  const requests = [
    { name: 'GET /api/league?division=open', path: '/api/league?division=open', page: 'league' },
    { name: 'GET /api/league?division=open&page=2', path: '/api/league?division=open&page=2', page: 'league' },
    { name: 'GET /api/league?division=pro', path: '/api/league?division=pro', page: 'league' },
    { name: 'GET /api/market', path: '/api/market', page: null },
    { name: 'GET /api/seasons', path: '/api/seasons', page: null },
    { name: 'GET /api/providers', path: '/api/providers', page: null },
    { name: 'GET /api/siwe/nonce', path: '/api/siwe/nonce', page: null },
  ];
  if (openAgent)
    requests.push({ name: 'GET /api/agents/:id, Open', path: `/api/agents/${openAgent.id}`, page: 'agent' });
  if (proAgent) requests.push({ name: 'GET /api/agents/:id, Pro', path: `/api/agents/${proAgent.id}`, page: 'agent' });

  let app = null;
  let problem = product.httpError;
  if (product.createApp !== null) {
    try {
      app = product.createApp({
        store,
        sim: product.sim,
        scoring: product.scoring,
        sealer: { keyVersion: 1, seal: async () => ({ ciphertext: '', iv: '', keyVersion: 1 }) },
        rateLimiter: { allow: async () => true },
        config: {
          siteOrigin: SITE_ORIGIN,
          adminAddresses: [],
          houseModel: 'house:bench',
          nonceSecret: Buffer.alloc(32, 7).toString('base64'),
        },
        now: () => now,
      });
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error);
    }
  }

  const reads = [];
  if (app !== null) {
    for (const request of requests) {
      meter.reset();
      let status = 0;
      let bytes = 0;
      try {
        const response = await app.fetch(
          new Request(`${SITE_ORIGIN}${request.path}`, { headers: { 'cf-connecting-ip': '203.0.113.7' } }),
        );
        status = response.status;
        bytes = (await response.arrayBuffer()).byteLength;
      } catch {
        status = 0;
      }
      reads.push({ ...request, status, bytes, source: 'route', ...takeCost(meter) });
    }
  }

  // A route that did not answer 200 is measured from the store calls docs/CONTRACTS.md section 4
  // names for it, so that a page view still has a cost. The table says which is which.
  const nowIso = now.toISOString();
  const fallbacks = {
    league: async (division, page) => {
      const season = await store.getActiveSeason(nowIso);
      await Promise.all([
        store.getMarketStatus(),
        store.getLeagueState(season.id, division),
        store.listStandings(season.id, division, DAY_SHAPE.leaguePageSize + 1, (page - 1) * DAY_SHAPE.leaguePageSize),
        store.listProcessingTicks(),
      ]);
    },
    agent: async (agent) => {
      const season = await store.getActiveSeason(nowIso);
      const record = await store.getPortfolio(agent.id, season.id);
      await Promise.all([
        store.getAgent(agent.id),
        store.getLeagueState(season.id, agent.division),
        store.listDecisions(agent.id, season.id, 30),
        agent.modelKeyId === null ? null : store.getModelKey(agent.modelKeyId, agent.owner),
        record?.lastTickId ? store.getTick(record.lastTickId) : null,
      ]);
    },
  };
  const measured = (page) => reads.filter((read) => read.page === page && read.status === 200);
  if (measured('league').length === 0) {
    for (const [division, page] of [
      ['open', 1],
      ['open', 2],
      ['pro', 1],
    ]) {
      meter.reset();
      await fallbacks.league(division, page);
      reads.push({
        name: `League, ${division}, page ${page}`,
        page: 'league',
        status: 200,
        bytes: 0,
        source: 'store',
        ...takeCost(meter),
      });
    }
  }
  if (measured('agent').length === 0) {
    for (const agent of [openAgent, proAgent]) {
      if (agent === null) continue;
      meter.reset();
      await fallbacks.agent(agent);
      reads.push({
        name: `Agent, ${agent.division}`,
        page: 'agent',
        status: 200,
        bytes: 0,
        source: 'store',
        ...takeCost(meter),
      });
    }
  }
  meter.reset();

  const worst = (page) =>
    measured(page).reduce((most, read) => (most === null || read.rowsRead > most.rowsRead ? read : most), null);
  return { reads, problem, league: worst('league'), agent: worst('agent') };
}

function takeCost(meter) {
  const taken = meter.take();
  return { statements: taken.statements, rowsRead: taken.rowsRead, rowsWritten: taken.rowsWritten };
}

// --- the caps -------------------------------------------------------------------------------------------

/** Asks the store for one agent more than a full division holds. The contract's answer is `league_full`. */
async function probeCaps(ctx, options) {
  const { world, store, meter } = ctx;
  const probes = [];
  for (const division of ['open', 'pro']) {
    if (options[division] < DIVISION_CAPS[division]) {
      probes.push({ division, asked: false, result: 'not asked: the division is not full in this run', ok: true });
      continue;
    }
    const extra = world.extraAgent(division);
    let result;
    try {
      result = await store.createAgent(
        extra.agent,
        world.season.id,
        extra.portfolio,
        extra.stats,
        DIVISION_CAPS[division],
      );
    } catch (error) {
      result = `threw ${error instanceof Error ? error.name : 'an error'}`;
    }
    // Above the cap on purpose, the extra agent is expected to get in.
    const ok = options[division] > DIVISION_CAPS[division] ? true : result === 'league_full';
    probes.push({ division, asked: true, result, ok });
  }
  meter.reset();
  return probes;
}

// --- CPU ------------------------------------------------------------------------------------------------

/**
 * Runs one recorded step again, many times, with every D1 answer served from memory. What is
 * left is the step's own computing: the scheduler, the store's checks and JSON, the engine and
 * the scoring. That is what a Worker's CPU limit counts; waiting for D1 or a model is not.
 */
async function replayCpu(ctx, sample, runs) {
  const { product, world } = ctx;
  let missed = 0;
  const once = async () => {
    const queues = new Map([...sample.recording].map(([key, list]) => [key, [...list]]));
    const { db } = createMeteredD1(async (statements, batch) => {
      const queue = queues.get(JSON.stringify([batch, statements]));
      if (queue === undefined) {
        missed += 1;
        throw new D1Error('replay: this call was not part of the recorded step');
      }
      return queue.length > 1 ? queue.shift() : queue[0];
    });
    const deps = schedulerDeps(product, world, product.createD1Store(db), () => {});
    await product.runSchedulerStep(deps, sample.now);
  };
  const jump = world.market.jump;
  world.market.jump = sample.jump;
  try {
    for (let i = 0; i < 5; i += 1) await once();
    missed = 0;
    const walls = [];
    const cpuBefore = process.cpuUsage();
    for (let i = 0; i < runs; i += 1) {
      const start = performance.now();
      await once();
      walls.push(performance.now() - start);
    }
    const cpu = process.cpuUsage(cpuBefore);
    walls.sort((a, b) => a - b);
    return {
      runs,
      cpuAvgMs: (cpu.user + cpu.system) / 1000 / runs,
      wallAvgMs: walls.reduce((sum, value) => sum + value, 0) / runs,
      wallMedianMs: walls[Math.floor(runs / 2)],
      wallMaxMs: walls.at(-1),
      diverged: missed > 0,
    };
  } finally {
    world.market.jump = jump;
  }
}

// --- the report -----------------------------------------------------------------------------------------

function percent(used, limit) {
  return limit === 0 ? '-' : `${((used / limit) * 100).toFixed(1)}%`;
}

function clock(date) {
  return date === null ? '-' : date.toISOString().slice(11, 16);
}

function neuronsFor(inputTokens, outputTokens) {
  return (
    (inputTokens * SCHEDULER_LIMITS.houseNeuronsPerMillionInputTokens +
      outputTokens * SCHEDULER_LIMITS.houseNeuronsPerMillionOutputTokens) /
    1_000_000
  );
}

function one(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

async function main() {
  const { options } = parseArgs(process.argv.slice(2), {
    open: DIVISION_CAPS.open,
    pro: DIVISION_CAPS.pro,
    pageViews: 10_000,
    signIns: -1,
    promptChanges: -1,
    strategy: 'short',
    agentPageShare: 0.3,
    cacheHitRate: 0,
    cpuRuns: 40,
    quick: false,
    skipScenarios: false,
  });
  for (const name of ['open', 'pro', 'pageViews', 'cpuRuns']) {
    if (options[name] < 0 || !Number.isInteger(options[name])) {
      throw new UsageError(`--${name} must be a whole number, zero or more`);
    }
  }
  if (options.strategy !== 'short' && options.strategy !== 'long')
    throw new UsageError('--strategy must be short or long');
  for (const name of ['agentPageShare', 'cacheHitRate']) {
    if (options[name] < 0 || options[name] > 1) throw new UsageError(`--${name} must be between 0 and 1`);
  }
  if (options.open + options.pro === 0) throw new UsageError('Give at least one agent.');
  const agentCount = options.open + options.pro;
  options.signIns = options.signIns < 0 ? agentCount : Math.floor(options.signIns);
  options.promptChanges = Math.min(
    agentCount,
    options.promptChanges < 0 ? Math.ceil(agentCount * 0.1) : Math.floor(options.promptChanges),
  );

  const startedAt = performance.now();
  const product = await loadProduct();
  const world = createWorld(product, options);
  const d1 = await startLocalD1();
  try {
    const migrations = await applyMigrations(d1.execute);
    const { db, meter } = createMeteredD1(d1.execute);
    const store = product.createD1Store(db);
    const ledger = createLedger();
    const ctx = {
      product,
      world,
      store,
      meter,
      ledger,
      kinds: createKinds(),
      deps: schedulerDeps(product, world, store, ledger.log),
    };

    process.stderr.write(`Seeding ${options.open} Open and ${options.pro} Pro agents ...\n`);
    const costs = await seedWorld({ product, world, store, execute: d1.execute, meter, options });
    const sizeBefore = meter.sizeAfter;

    process.stderr.write(`Replaying ${world.measuredDay}, one step a minute ...\n`);
    const day = await runDay(ctx, world.measuredDay, options.quick);
    const sizeAfter = meter.sizeAfter;
    meter.reset();
    const neuronsCounted = await store.getAiNeurons(world.measuredDay);
    const usage = structuredClone({
      house: world.usage.house,
      own: world.usage.own,
      decisionChars: world.usage.decisionChars,
      summaryChars: world.usage.summaryChars,
    });
    const dayTicks = [...ledger.ticks.values()].filter((tick) => tick.id.startsWith(world.measuredDay));
    const dayEvents = new Map(ledger.events);

    process.stderr.write('Measuring the public reads ...\n');
    const reads = await measureReads(ctx, timeOf(world.measuredDay, 20 * 60 + 30));

    let scenarios = [];
    if (!options.skipScenarios && day.stuck === null) {
      process.stderr.write('Running the scenarios that go wrong on purpose ...\n');
      scenarios = await runScenarios(ctx);
    }
    const caps = await probeCaps(ctx, options);

    process.stderr.write('Estimating CPU time by replaying the heaviest step of each kind ...\n');
    const kinds = [...ctx.kinds.kinds.values()];
    for (const kind of kinds) {
      kind.cpu = options.cpuRuns > 0 ? await replayCpu(ctx, kind.sample, options.cpuRuns) : null;
    }

    // --- the day against the daily limits -------------------------------------------------------

    const uncachedViews = options.pageViews * (1 - options.cacheHitRate);
    const readsPerView =
      reads.league === null || reads.agent === null
        ? null
        : (1 - options.agentPageShare) * reads.league.rowsRead + options.agentPageShare * reads.agent.rowsRead;
    const trafficRead =
      (readsPerView === null ? 0 : uncachedViews * readsPerView) +
      options.signIns * (costs.signIn.rowsRead + costs.signedInRead.rowsRead) +
      options.promptChanges * (costs.promptChange.rowsRead + costs.signedInRead.rowsRead);
    const trafficWritten =
      options.signIns * costs.signIn.rowsWritten + options.promptChanges * costs.promptChange.rowsWritten;
    const rowsRead = day.totals.rowsRead + trafficRead;
    const rowsWritten = day.totals.rowsWritten + trafficWritten;
    // The Cron Trigger and the API call behind a page are both counted as requests, to stay on the safe side.
    const requests = DAY_SHAPE.stepsPerDay + options.pageViews * 2 + options.signIns * 3 + options.promptChanges * 2;
    const decisionShort = neuronsFor(HOUSE_CALL_TOKENS.decisionShort.input, HOUSE_CALL_TOKENS.decisionShort.output);
    const decisionLong = neuronsFor(HOUSE_CALL_TOKENS.decisionLong.input, HOUSE_CALL_TOKENS.decisionLong.output);
    const summaryNeurons = neuronsFor(HOUSE_CALL_TOKENS.summary.input, HOUSE_CALL_TOKENS.summary.output);
    const neuronBudget = SCHEDULER_LIMITS.houseNeuronsPerDay;
    const summaryBudget = SCHEDULER_LIMITS.summaryNeuronsPerDay;
    const openByShort = Math.floor(neuronBudget / decisionShort);
    const openByLong = Math.floor(neuronBudget / decisionLong);
    const summariesPerDay = Math.floor(summaryBudget / summaryNeurons);
    const neuronsLongAtCap = options.open * decisionLong;
    const neuronsShortAtCap = options.open * decisionShort;
    const summaryNeuronsUsed = options.promptChanges * summaryNeurons;

    const daily = [
      { name: 'D1 rows written', used: rowsWritten, limit: FREE_PLAN.d1RowsWrittenPerDay },
      { name: 'D1 rows read', used: rowsRead, limit: FREE_PLAN.d1RowsReadPerDay, unmeasured: readsPerView === null },
      {
        // The store counts decisions and summaries in one number until K1 lands, so the limit is the sum.
        name: `Neurons, decisions and summaries as the scheduler counted them (${options.strategy} strategies)`,
        used: neuronsCounted,
        limit: neuronBudget + summaryBudget,
      },
      {
        name: `Neurons, ${options.open} Open decisions at 2,000-character strategies (${one(decisionLong)} each, computed)`,
        used: neuronsLongAtCap,
        limit: neuronBudget,
      },
      {
        name: `Neurons, ${options.promptChanges} summaries (${one(summaryNeurons)} each, computed)`,
        used: summaryNeuronsUsed,
        limit: summaryBudget,
      },
      { name: 'Worker requests', used: requests, limit: FREE_PLAN.workerRequestsPerDay },
    ];
    for (const row of daily) row.ok = row.used <= row.limit && row.unmeasured !== true;
    const dailyOk = daily.every((row) => row.ok);

    // --- the rounds -----------------------------------------------------------------------------

    const rounds = dayTicks.map((tick) => {
      const hourEnd = new Date(Date.parse(`${tick.id.slice(0, 13)}:00:00.000Z`) + 3_600_000);
      const minutes =
        tick.createdAt === null || tick.completedAt === null
          ? null
          : Math.round((tick.completedAt - tick.createdAt) / 60_000) + 1;
      const proDecided = rowsOf(tick, 'pro decided');
      const openDecided = rowsOf(tick, 'open decided');
      const others = otherRows(tick);
      const everyone =
        proDecided === options.pro && openDecided === (tick.daily ? options.open : 0) && others.length === 0;
      const insideHour = tick.completedAt !== null && tick.completedAt < hourEnd;
      return { tick, minutes, proDecided, openDecided, others, everyone, insideHour, ok: everyone && insideHour };
    });
    const dailyRound = rounds.find((round) => round.tick.daily === true) ?? null;
    const roundsOk =
      day.stuck === null &&
      rounds.length === DAY_SHAPE.ticksPerDay &&
      rounds.every((round) => round.ok) &&
      (options.open === 0 || dailyRound !== null);

    // --- the steps ------------------------------------------------------------------------------

    for (const kind of kinds) {
      kind.cpuMs = kind.cpu === null || kind.cpu.diverged ? null : Math.max(kind.cpu.cpuAvgMs, kind.cpu.wallAvgMs);
      kind.limitsOk =
        kind.statements <= FREE_PLAN.d1QueriesPerInvocation &&
        kind.outbound <= FREE_PLAN.subrequestsPerInvocation &&
        kind.modelCallsAtOnce < FREE_PLAN.simultaneousConnections;
      kind.cpuOk = kind.cpuMs === null ? null : kind.cpuMs < FREE_PLAN.cpuMsPerCronTrigger;
    }
    const stepsOk = kinds.every((kind) => kind.limitsOk);
    const cpuKinds = kinds.filter((kind) => kind.cpuMs !== null);
    const cpuOk = cpuKinds.every((kind) => kind.cpuOk);
    const cpuWorst = cpuKinds.reduce((most, kind) => (most === null || kind.cpuMs > most.cpuMs ? kind : most), null);
    const readsOk = reads.reads.every((read) => read.statements <= FREE_PLAN.d1QueriesPerInvocation);
    const anonymousWrites = reads.reads.filter((read) => read.source === 'route' && read.rowsWritten > 0);
    const capsOk = caps.every((probe) => probe.ok);

    // --- print ----------------------------------------------------------------------------------

    console.log('Capacity of one trading day on the Cloudflare free plan. MEASURED on a local D1, not modelled.');
    console.log(
      `What ran: the D1 store of apps/api/src/store (migrations ${migrations.join(', ')}), the scheduler of packages/runtime,`,
    );
    console.log(
      '  the engine, the scoring and the public routes of the API, on D1 in workerd as Wrangler runs it locally.',
    );
    console.log(
      `Scenario: ${int(options.open)} Open and ${int(options.pro)} Pro agents (caps: ${DIVISION_CAPS.open} and ${DIVISION_CAPS.pro}), ` +
        `day ${world.recordDays.length + 1} of the season (${world.measuredDay}), market open for all ${DAY_SHAPE.ticksPerDay} ticks ` +
        `(${DAY_SHAPE.tickFirstHourUtc}:00 to ${DAY_SHAPE.tickLastHourUtc}:00 UTC).`,
    );
    console.log(
      `Conditions: every agent active with ${world.recordDays.length} trading days of record, every prompt ${int(world.prompt.length)} characters, every decision trades,`,
    );
    console.log(
      `  the table reverses at every ranking, 20 earlier days of prices, ${int(options.promptChanges)} summaries to write, ${int(options.signIns)} expired sign-ins to delete.`,
    );
    console.log(
      `ASSUMED traffic: ${int(options.pageViews)} page views (${(options.agentPageShare * 100).toFixed(0)}% on an agent page, ` +
        `${(options.cacheHitRate * 100).toFixed(0)}% answered from the ${PUBLIC_CACHE_SECONDS}-second cache), ${int(options.signIns)} sign-ins, ${int(options.promptChanges)} prompt changes.`,
    );
    console.log(
      `Steps: ${int(day.totals.stepsRun)} run${day.totals.stepsCounted > 0 ? `, ${int(day.totals.stepsCounted)} idle minutes counted at the cost of the idle step before them (--quick)` : ''}. ` +
        `Node ${process.version}, ${cpus()[0]?.model.trim() ?? 'unknown CPU'}.`,
    );
    console.log('');

    if (day.stuck !== null) {
      console.log(
        `STOPPED at ${day.stuck.at}: ${STUCK_AFTER_STEPS} steps in a row of tick ${day.stuck.tickId} wrote no row while ${day.stuck.pending} agents waited.`,
      );
      console.log('What the scheduler logged:');
      for (const [name, count] of dayEvents) console.log(`  ${count} x ${name}`);
      console.log('The day could not be measured. The numbers below cover only the steps before the stop.');
      console.log('');
    }

    console.log(
      table([
        ['Per day', 'Used', 'Limit', 'Share', 'Verdict'],
        ...daily.map((row) => [
          row.name,
          int(row.used),
          int(row.limit),
          percent(row.used, row.limit),
          row.unmeasured ? 'NOT MEASURED' : row.ok ? 'ok' : 'OVER',
        ]),
      ]),
    );
    console.log(
      `  Rows written: scheduler ${int(day.totals.rowsWritten)} (measured), traffic ${int(trafficWritten)}. ` +
        `Rows read: scheduler ${int(day.totals.rowsRead)} (measured), traffic ${int(trafficRead)}` +
        `${readsPerView === null ? '' : ` at ${int(readsPerView)} rows a page view`}.`,
    );
    console.log(
      `  Neurons: ${int(usage.house.decisions)} decisions and ${int(usage.house.summaries)} summaries. The stand-in model reports the MEASURED tokens of the house model ` +
        `(${options.strategy === 'long' ? HOUSE_CALL_TOKENS.decisionLong.input : HOUSE_CALL_TOKENS.decisionShort.input} in, ${options.strategy === 'long' ? HOUSE_CALL_TOKENS.decisionLong.output : HOUSE_CALL_TOKENS.decisionShort.output} out a decision) and the exact neurons, as usage.neurons does.`,
    );
    console.log(
      `  Database: ${(sizeBefore / 1e6).toFixed(2)} MB before the day, ${((sizeAfter - sizeBefore) / 1e6).toFixed(2)} MB added by it. ` +
        `${
          sizeAfter > sizeBefore
            ? `At that rate ${int(FREE_PLAN.d1SizeBytes / 1e6)} MB lasts ${int((FREE_PLAN.d1SizeBytes - sizeBefore) / (sizeAfter - sizeBefore))} trading days.`
            : ''
        }`,
    );
    console.log('');

    console.log(
      'The neuron budget (house model @cf/meta/llama-3.3-70b-instruct-fp8-fast, MEASURED prices and tokens, computed here)',
    );
    console.log(
      `  A decision: ${one(decisionShort)} neurons for a short strategy (${HOUSE_CALL_TOKENS.decisionShort.input} in, ${HOUSE_CALL_TOKENS.decisionShort.output} out), ` +
        `${one(decisionLong)} for a 2,000-character strategy (${HOUSE_CALL_TOKENS.decisionLong.input} in, ${HOUSE_CALL_TOKENS.decisionLong.output} out). A summary: ${one(summaryNeurons)}.`,
    );
    console.log(
      `  Open agents a day inside ${int(neuronBudget)} neurons (one decision each, the division decides once a day): ${int(openByShort)} with short strategies, ${int(openByLong)} with the longest. ` +
        `The cap is ${options.open}: short strategies use ${int(neuronsShortAtCap)} (${percent(neuronsShortAtCap, neuronBudget)}), the longest use ${int(neuronsLongAtCap)} (${percent(neuronsLongAtCap, neuronBudget)}).`,
    );
    console.log(
      `  Summaries: ${int(summariesPerDay)} a day inside ${int(summaryBudget)} neurons; ${int(options.promptChanges)} are assumed (${percent(summaryNeuronsUsed, summaryBudget)}).`,
    );
    console.log('');

    console.log('Rounds of the day, at one step a minute');
    console.log(
      table([
        [
          'Tick',
          'Kind',
          'Created',
          'Completed',
          'Steps',
          'Minutes',
          'Pro decided',
          'Open decided',
          'Other rows',
          'Verdict',
        ],
        ...rounds.map((round) => [
          round.tick.id,
          round.tick.daily ? 'daily' : 'hourly',
          clock(round.tick.createdAt),
          clock(round.tick.completedAt),
          round.tick.steps,
          round.minutes ?? '-',
          `${round.proDecided} / ${options.pro}`,
          round.tick.daily ? `${round.openDecided} / ${options.open}` : '-',
          round.others.length === 0 ? '0' : round.others.map(([key, count]) => `${count} ${key}`).join(', '),
          round.ok ? 'ok' : round.insideHour ? 'NOT EVERYONE' : 'LATE',
        ]),
      ]),
    );
    if (rounds.length !== DAY_SHAPE.ticksPerDay) {
      console.log(`  ${rounds.length} of ${DAY_SHAPE.ticksPerDay} ticks were created.`);
    }
    if (dailyRound !== null && dailyRound.minutes !== null) {
      const spare = 60 - dailyRound.minutes;
      console.log(
        `  The daily round takes ${dailyRound.minutes} minutes. Created in minute 0 it ends with ${spare} minutes of its hour to spare; ` +
          `the scheduler may create a tick up to minute ${DAY_SHAPE.tickCreateWindowMinutes - 1}, and from minute ${Math.max(0, spare + 1)} on the round ends in the next hour.`,
      );
    }
    console.log('');

    console.log(
      `One step is one Worker invocation. Limits: ${FREE_PLAN.d1QueriesPerInvocation} D1 statements, ${FREE_PLAN.subrequestsPerInvocation} subrequests,`,
    );
    console.log(
      `  ${FREE_PLAN.simultaneousConnections} connections at once, ${FREE_PLAN.cpuMsPerCronTrigger} ms of CPU. Each row is the most seen in any step of that kind.`,
    );
    console.log(
      table([
        [
          'Kind of step',
          'Steps',
          'D1 statements',
          'D1 + model + RPC',
          'Model calls at once',
          'Rows read',
          'Rows written',
          'CPU, ESTIMATE',
          'Verdict',
        ],
        ...kinds.map((kind) => [
          kind.name,
          int(kind.steps),
          kind.statements,
          kind.outbound,
          kind.modelCallsAtOnce,
          int(kind.rowsRead),
          int(kind.rowsWritten),
          kind.cpu === null ? '-' : kind.cpu.diverged ? 'replay diverged' : `${kind.cpuMs.toFixed(2)} ms`,
          kind.limitsOk && kind.cpuOk !== false ? 'ok' : 'OVER',
        ]),
      ]),
    );
    console.log(
      `  CPU is an ESTIMATE FROM THIS MACHINE: the heaviest step of each kind, run again ${options.cpuRuns} times with every D1 answer served from memory,`,
    );
    console.log(
      "  so that only the step's own computing is left. The larger of the wall-clock and the process-CPU average is shown.",
    );
    console.log(
      `  An RPC read is counted as ${RPC_READS_PER_SNAPSHOT} subrequests (two endpoints tried). The stand-in models answer at once: a real step waits for its models, which is not CPU.`,
    );
    console.log('');

    if (scenarios.length > 0) {
      console.log('Scenarios that go wrong on purpose (their steps are in the table above)');
      console.log(
        table([['Scenario', 'Steps', 'What happened'], ...scenarios.map((s) => [s.name, s.steps, s.outcome])]),
      );
      console.log('');
    }

    console.log('What one operation costs on D1, measured');
    const operations = [
      ['Operation', 'D1 statements', 'Rows read', 'Rows written', 'Measured through'],
      ...reads.reads.map((read) => [
        read.status === 200 ? read.name : `${read.name} (answered ${read.status})`,
        read.statements,
        int(read.rowsRead),
        int(read.rowsWritten),
        read.source === 'route' ? 'the route' : 'store calls',
      ]),
      [
        'Create an agent',
        one(costs.createAgent.statements),
        one(costs.createAgent.rowsRead),
        one(costs.createAgent.rowsWritten),
        'the store',
      ],
      [
        'Store a model key',
        one(costs.modelKey.statements),
        one(costs.modelKey.rowsRead),
        one(costs.modelKey.rowsWritten),
        'the store',
      ],
      [
        'Change a prompt',
        one(costs.promptChange.statements),
        one(costs.promptChange.rowsRead),
        one(costs.promptChange.rowsWritten),
        'the store',
      ],
      [
        `Sign in (${costs.signIn.statelessNonce ? 'nonce used, user, session' : 'nonce stored and used, user, session'})`,
        one(costs.signIn.statements),
        one(costs.signIn.rowsRead),
        one(costs.signIn.rowsWritten),
        'the store',
      ],
      [
        'Read the session and the agent of a signed-in request',
        one(costs.signedInRead.statements),
        one(costs.signedInRead.rowsRead),
        one(costs.signedInRead.rowsWritten),
        'the store',
      ],
    ];
    console.log(table(operations));
    if (reads.problem) console.log(`  The API routes could not be built: ${reads.problem}`);
    console.log('');

    // --- findings -------------------------------------------------------------------------------

    const findings = [];
    if (readsPerView !== null && readsPerView > 0) {
      const spareRead = FREE_PLAN.d1RowsReadPerDay - (rowsRead - uncachedViews * readsPerView);
      const spareRequests = FREE_PLAN.workerRequestsPerDay - (requests - options.pageViews * 2);
      const byReads = Math.floor(spareRead / readsPerView);
      const byRequests = Math.floor(spareRequests / 2);
      const perUrlPerDay = 86_400 / PUBLIC_CACHE_SECONDS;
      findings.push(
        `Traffic: with no cache hit at all, ${int(Math.min(byReads, byRequests))} page views a day fit; ` +
          `${byReads < byRequests ? 'D1 rows read' : 'Worker requests'} bind first (rows read allow ${int(byReads)}, requests allow ${int(byRequests)}). ` +
          `The ${PUBLIC_CACHE_SECONDS}-second cache lets one data center run a read of one URL at most ${int(perUrlPerDay)} times a day, ` +
          `so the league table costs at most ${int(perUrlPerDay * reads.league.rowsRead)} rows a day there however many people open it.`,
      );
    }
    if (costs.createAgent.rowsWritten > 0) {
      const launch =
        options.open * costs.createAgent.rowsWritten +
        options.pro * (costs.createAgent.rowsWritten + costs.modelKey.rowsWritten);
      findings.push(
        `Launch day: creating all ${int(agentCount)} agents and ${int(options.pro)} model keys wrote ${int(launch)} rows while seeding, ` +
          `${percent(launch, FREE_PLAN.d1RowsWrittenPerDay)} of a day. With the trading day above that is ${int(launch + rowsWritten)} of ${int(FREE_PLAN.d1RowsWrittenPerDay)}.`,
      );
    }
    for (const read of anonymousWrites) {
      findings.push(
        `${read.name} wrote ${int(read.rowsWritten)} D1 rows for a request that carries no session. ` +
          `${int(FREE_PLAN.d1RowsWrittenPerDay / read.rowsWritten)} such requests use up the day's written rows and stop the league until 00:00 UTC. ` +
          'docs/CONTRACTS.md section 15 says issuing a nonce writes nothing.',
      );
    }
    for (const probe of caps.filter((entry) => !entry.ok)) {
      findings.push(
        `The store let one agent more than the cap into the ${probe.division} division: createAgent answered "${probe.result}", not "league_full". ` +
          'Everything above holds only while the caps hold.',
      );
    }
    for (const kind of kinds.filter((entry) => !entry.limitsOk)) {
      findings.push(
        `A step of the kind "${kind.name}" went over a limit of one invocation: ${kind.statements} D1 statements, ${kind.outbound} outbound calls, ${kind.modelCallsAtOnce} model calls at once.`,
      );
    }
    for (const kind of kinds.filter((entry) => entry.cpu?.diverged)) {
      findings.push(
        `The CPU replay of "${kind.name}" asked D1 for something the recorded step had not: no estimate for it.`,
      );
    }
    if (findings.length > 0) {
      console.log('Findings');
      findings.forEach((finding, index) => {
        console.log(`  ${index + 1}. ${finding}`);
      });
      console.log('');
    }

    // --- verdicts -------------------------------------------------------------------------------

    const verdicts = [
      {
        ok: dailyOk,
        text: dailyOk
          ? `${int(options.open)} Open and ${int(options.pro)} Pro agents fit every daily limit.`
          : `${int(options.open)} Open and ${int(options.pro)} Pro agents do not fit: ${daily
              .filter((row) => !row.ok)
              .map((row) => row.name)
              .join('; ')}.`,
      },
      {
        ok: roundsOk,
        text: roundsOk
          ? `all ${DAY_SHAPE.ticksPerDay} rounds reached every agent and ended inside their hour${dailyRound ? `; the daily round took ${dailyRound.minutes} minutes` : ''}.`
          : day.stuck !== null
            ? 'the scheduler stopped writing rows, so no round could finish.'
            : 'not every round reached every agent and ended inside its hour.',
      },
      {
        ok: stepsOk && readsOk,
        text:
          stepsOk && readsOk
            ? `every step and every public read stayed inside the limits of one invocation (most D1 statements in a step: ${Math.max(0, ...kinds.map((kind) => kind.statements))} of ${FREE_PLAN.d1QueriesPerInvocation}).`
            : 'a step or a public read went over a limit of one invocation.',
      },
      {
        ok: cpuOk,
        text:
          cpuWorst === null
            ? 'no CPU estimate was made.'
            : `the heaviest step takes ${cpuWorst.cpuMs.toFixed(2)} ms of CPU on this machine ("${cpuWorst.name}"), ${cpuOk ? 'under' : 'not under'} the ${FREE_PLAN.cpuMsPerCronTrigger} ms limit. ESTIMATE.`,
      },
      {
        ok: capsOk,
        text: capsOk
          ? caps.some((probe) => probe.asked)
            ? 'the store refused one agent more than the cap in every full division.'
            : 'the caps were not put to the test: no division was full.'
          : 'the store does not enforce the caps.',
      },
      {
        ok: anonymousWrites.length === 0,
        text:
          anonymousWrites.length === 0
            ? 'no request without a session wrote a D1 row.'
            : `a request without a session wrote D1 rows: ${anonymousWrites.map((read) => read.name).join('; ')}.`,
      },
    ];
    const closest = daily
      .filter((row) => row.limit > 0)
      .reduce((most, row) => (row.used / row.limit > most.used / most.limit ? row : most));
    console.log(
      `Closest daily limit: ${closest.name}, ${percent(closest.used, closest.limit)} of ${int(closest.limit)}.`,
    );
    for (const verdict of verdicts) console.log(`${verdict.ok ? 'PASS' : 'FAIL'}: ${verdict.text}`);
    const pass = verdicts.every((verdict) => verdict.ok);
    console.log(`Took ${Math.round((performance.now() - startedAt) / 1000)} s.`);

    await writeArtifact(
      'capacity.json',
      `${JSON.stringify(
        {
          measured: true,
          measuredAt: new Date().toISOString(),
          conditions: { node: process.version, cpu: cpus()[0]?.model.trim(), platform: process.platform, migrations },
          options,
          pass,
          verdicts,
          daily,
          day: { ...day, events: Object.fromEntries(dayEvents), neuronsCounted, sizeBefore, sizeAfter },
          rounds: rounds.map((round) => ({
            id: round.tick.id,
            daily: round.tick.daily,
            createdAt: round.tick.createdAt,
            completedAt: round.tick.completedAt,
            steps: round.tick.steps,
            minutes: round.minutes,
            rows: Object.fromEntries(round.tick.rows),
            ok: round.ok,
          })),
          steps: kinds.map(({ sample, ...kind }) => ({
            ...kind,
            heaviestAt: sample.now,
            heaviestStatements: Object.fromEntries(sample.byStatement),
          })),
          scenarios,
          reads: reads.reads,
          costs,
          caps,
          usage,
          findings,
        },
        null,
        2,
      )}\n`,
    );
    return pass ? 0 : 1;
  } finally {
    await d1.stop();
  }
}

await cli(main, USAGE);
