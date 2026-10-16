// The cost of the tick-creating step at 25 symbols (docs/CONTRACTS.md section 23): D1 statements
// measured on a local D1 through the real store of apps/api, and the CPU of the step replayed with
// every D1 answer served from memory. Local only, never deployed, no network, no Cloudflare account.
//
//   node packages/runtime/scripts/stage2-tick-cost.mjs [--runs 200] [--port 8970]
//
// What is real: the scheduler step of packages/runtime, the store of apps/api/src/store, the D1
// SQLite build Wrangler runs locally (tools/perf/d1-worker). What is a stand-in: the market, which
// returns a made-up snapshot without a request. Its requests are counted from the contract:
// Robinhood worst case 8 (keyed plus three public endpoints, each retried once) and Arbitrum 3
// (ARBITRUM_MAX_REQUESTS_PER_SNAPSHOT). The CPU of the market's own reads and decoding is not in
// the CPU figure: perf measures it on the real market after the integration.

import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { ensureUniverse25, UNIVERSE } from './universe25.mjs';

const added = ensureUniverse25();
const { values } = parseArgs({
  options: { runs: { type: 'string', default: '200' }, port: { type: 'string', default: '8970' } },
});
const RUNS = Number(values.runs);
const PORT = Number(values.port);

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');
const load = (path) => import(pathToFileURL(resolve(ROOT, path)).href);

const contracts = await load('packages/contracts/src/index.ts');
const { runSchedulerStep } = await load('packages/runtime/src/index.ts');
const { createD1Store } = await load('apps/api/src/store/index.ts');
const { sim } = await load('packages/sim/src/index.ts');
const { scoring } = await load('packages/reputation/src/index.ts');
const { applyMigrations, createMeteredD1 } = await load('tools/perf/local-d1.mjs');
const { MICRO, ARBITRUM_MAX_REQUESTS_PER_SNAPSHOT } = contracts;

const ROBINHOOD_WORST_REQUESTS = 8;
const MARKET_REQUESTS = ROBINHOOD_WORST_REQUESTS + ARBITRUM_MAX_REQUESTS_PER_SNAPSHOT;
const SUBREQUEST_LIMIT = 50;
const CPU_LIMIT_MS = 10;

// --- a local D1 on a port of this agent's range -----------------------------------------------------

const { unstable_startWorker: startWorker } = await import('wrangler');
const worker = await startWorker({
  config: resolve(ROOT, 'tools', 'perf', 'd1-worker', 'wrangler.jsonc'),
  dev: { persist: false, server: { port: PORT }, inspector: false, logLevel: 'error', watch: false, remote: false },
});

try {
  await worker.ready;
  const url = String(await worker.url);
  const execute = async (statements, batch) => {
    const response = await fetch(url, { method: 'POST', body: JSON.stringify({ statements, batch }) });
    const answer = await response.json();
    if (!answer.ok) throw new Error(answer.message);
    return answer.results;
  };
  await applyMigrations(execute);
  await main(execute);
} finally {
  await worker.dispose();
}

async function main(execute) {
  console.log(
    `universe: ${UNIVERSE.length} symbols${added.length > 0 ? ` (added in memory for this run: ${added.join(', ')})` : ''}`,
  );
  const symbols = UNIVERSE.map((token) => token.symbol);
  const ARBITRUM = ['BNB', 'HYPE', 'SOL'];
  const COINS = UNIVERSE.filter((token) => token.kind === 'crypto').map((token) => token.symbol);
  const STOCKS = symbols.filter((symbol) => !COINS.includes(symbol));
  const usdOf = (symbol, k) => ({ BTC: 62_000, ETH: 2_400, BNB: 610, HYPE: 38, SOL: 150 })[symbol] ?? 50 + k * 37;

  const SEASON = {
    id: 'saaaaaaaaaab',
    number: 1,
    startsAt: '2026-10-01T00:00:00.000Z',
    endsAt: '2026-12-31T00:00:00.000Z',
  };
  await execute(
    [
      {
        sql: 'INSERT INTO seasons (id, number, starts_at, ends_at) VALUES (?1, ?2, ?3, ?4)',
        params: Object.values(SEASON),
      },
    ],
    false,
  );

  const pointsAt = (takenAt, only, change = {}) =>
    UNIVERSE.filter((token) => only === undefined || only.includes(token.symbol)).map((token) => {
      const k = symbols.indexOf(token.symbol);
      const c = change[token.symbol];
      const unread = c === 'unread';
      const stale = c === 'stale';
      return {
        symbol: token.symbol,
        priceMicro: unread ? 0 : Math.round((usdOf(token.symbol, k) + 0.37) * MICRO * (typeof c === 'number' ? c : 1)),
        updatedAt: takenAt,
        ageSeconds: 60,
        fresh: !unread && !stale,
      };
    });
  const snapshotAt = (takenAt, prices, problem = null) => ({
    takenAt,
    chainId: 4663,
    blockNumber: 1_000_000,
    open: true,
    closedReason: null,
    prices,
    otherChains: [
      {
        chainId: 42161,
        blockNumber: problem === null ? 300_000_000 : 0,
        endpoint: problem === null ? 0 : null,
        confirmedBy: null,
        problem,
      },
    ],
  });

  const base = createMeteredD1(execute);
  const store = createD1Store(base.db);

  async function reset(history) {
    await execute([{ sql: 'DELETE FROM symbol_holds', params: [] }], false);
    await execute([{ sql: 'DELETE FROM ticks', params: [] }], false);
    await execute([{ sql: 'DELETE FROM market_status', params: [] }], false);
    for (const { id, prices } of history) {
      const at = `${id.slice(0, 13)}:00:30.000Z`;
      const created = await store.createTick({
        id,
        seasonId: SEASON.id,
        daily: id.endsWith('T15:00Z'),
        snapshot: snapshotAt(at, prices),
        status: 'complete',
        createdAt: at,
        completedAt: at,
      });
      if (!created) throw new Error(`history tick ${id} not stored`);
    }
  }

  const holdOf = (symbol, k, releasedAt) => ({
    symbol,
    priceMicro: Math.round((usdOf(symbol, k) + 0.37) * MICRO),
    seenPriceMicro: Math.round((usdOf(symbol, k) + 0.37) * MICRO * 2),
    sinceTickId: '2026-10-09T19:00Z',
    releasedAt,
    createdAt: '2026-10-09T19:00:31.000Z',
  });

  const FRI = '2026-10-09T19:00Z';
  const MON15 = '2026-10-12T15:00Z';
  const all25 = (id, change) => ({ id, prices: pointsAt(`${id.slice(0, 13)}:00:30.000Z`, undefined, change) });
  const without = (id, out) => ({
    id,
    prices: pointsAt(
      `${id.slice(0, 13)}:00:30.000Z`,
      symbols.filter((symbol) => !out.includes(symbol)),
    ),
  });

  const fiftyPercent = (list) => Object.fromEntries(list.map((symbol) => [symbol, 1.5]));
  const scenarios = [
    {
      name: 'typical: every feed read, no hold',
      now: '2026-10-12T15:00:30.000Z',
      history: [all25(FRI)],
      market: (at) => snapshotAt(at, pointsAt(at)),
    },
    {
      name: 'Arbitrum unread (BNB, HYPE, SOL at 0)',
      now: '2026-10-12T15:00:30.000Z',
      history: [all25(FRI)],
      market: (at) =>
        snapshotAt(at, pointsAt(at, undefined, { BNB: 'unread', HYPE: 'unread', SOL: 'unread' }), 'rpc_unavailable'),
    },
    {
      name: 'first appearance of BNB, HYPE, SOL (latest tick has 22)',
      now: '2026-10-12T15:00:30.000Z',
      history: [without(FRI, ARBITRUM)],
      market: (at) => snapshotAt(at, pointsAt(at)),
    },
    {
      // Latest tick today (one more seek for the previous trading day); SOL has no trusted price
      // but the latest tick carries it (the read of the day before); 2 Stock Tokens and the
      // 5 coins move 50% (7 new holds); the 18 other Stock Tokens have released holds (18 deletes).
      name: 'worst open: 7 new holds, 18 releases used, both daily-price reads',
      now: '2026-10-12T16:00:30.000Z',
      history: [all25(FRI, { SOL: 'stale' }), all25(MON15, { SOL: 'stale' })],
      holds: STOCKS.slice(2).map((symbol) => holdOf(symbol, symbols.indexOf(symbol), '2026-10-12T15:30:00.000Z')),
      market: (at) => snapshotAt(at, pointsAt(at, undefined, fiftyPercent([...STOCKS.slice(0, 2), ...COINS]))),
    },
    {
      name: 'worst closed: all 25 move 50%, 25 new holds',
      now: '2026-10-12T16:00:30.000Z',
      history: [all25(FRI, { SOL: 'stale' }), all25(MON15, { SOL: 'stale' })],
      market: (at) => snapshotAt(at, pointsAt(at, undefined, fiftyPercent(symbols))),
    },
  ];

  const rows = [];
  let worst = 0;
  for (const scenario of scenarios) {
    await reset(scenario.history);
    for (const hold of scenario.holds ?? []) {
      await store.putSymbolHold({ ...hold, releasedAt: null });
      if (hold.releasedAt !== null) await store.releaseSymbolHold(hold.symbol, hold.releasedAt);
    }
    // Record every D1 answer of the measured step, to replay the step for the CPU figure.
    const recorded = [];
    const metered = createMeteredD1(async (statements, batch) => {
      const results = await execute(statements, batch);
      recorded.push(results);
      return results;
    });
    const events = [];
    const deps = depsFor(createD1Store(metered.db), scenario.market, events);
    const report = await runSchedulerStep(deps, new Date(scenario.now));
    const taken = metered.meter.take();
    const statements = taken.statements;
    const total = statements + MARKET_REQUESTS;
    worst = Math.max(worst, total);
    const held = events.filter((event) => event === 'symbol_held').length;

    // CPU: the same step again, every D1 answer from memory, in order.
    let cpuMs = null;
    if (RUNS > 0) {
      const replayStep = async () => {
        let next = 0;
        const replay = createMeteredD1(async () => {
          const results = recorded[next];
          next += 1;
          if (results === undefined) throw new Error('replay diverged');
          return results;
        });
        await runSchedulerStep(depsFor(createD1Store(replay.db), scenario.market, []), new Date(scenario.now));
        if (next !== recorded.length) throw new Error('replay diverged');
      };
      for (let i = 0; i < 20; i += 1) await replayStep(); // warm the JIT, as a warm isolate is
      const before = process.cpuUsage();
      for (let i = 0; i < RUNS; i += 1) await replayStep();
      const used = process.cpuUsage(before);
      cpuMs = (used.user + used.system) / 1000 / RUNS;
    }
    rows.push({ scenario: scenario.name, action: report.action, held, statements, total, cpuMs });
  }

  console.log(
    `\nSubrequests of the tick-creating step: D1 statements (measured) + market requests (${ROBINHOOD_WORST_REQUESTS} Robinhood worst case + ${ARBITRUM_MAX_REQUESTS_PER_SNAPSHOT} Arbitrum, from the contract).`,
  );
  console.log(
    `CPU: the step replayed ${RUNS} times with D1 answers from memory, average, on this machine (an estimate).`,
  );
  for (const row of rows) {
    console.log(
      `  ${row.scenario.padEnd(66)} ${row.action.padEnd(14)} holds ${String(row.held).padStart(2)}  ` +
        `D1 ${String(row.statements).padStart(2)} + ${MARKET_REQUESTS} = ${String(row.total).padStart(2)}  ` +
        `CPU ${row.cpuMs === null ? '-' : `${row.cpuMs.toFixed(3)} ms`}`,
    );
  }
  const cpuWorst = Math.max(...rows.map((row) => row.cpuMs ?? 0));
  console.log(
    `\nmost subrequests: ${worst} (limit ${SUBREQUEST_LIMIT}: ${worst < SUBREQUEST_LIMIT ? 'under' : 'NOT under'})`,
  );
  console.log(
    `most CPU: ${cpuWorst.toFixed(3)} ms (limit ${CPU_LIMIT_MS} ms: ${cpuWorst < CPU_LIMIT_MS ? 'under' : 'NOT under'})`,
  );
  process.exitCode = worst < SUBREQUEST_LIMIT && cpuWorst < CPU_LIMIT_MS ? 0 : 1;
}

function depsFor(store, market, events) {
  const refuse = async () => {
    throw new Error('no model in this measurement');
  };
  return {
    store,
    market: { takeSnapshot: async (now) => market(now.toISOString()) },
    sim,
    scoring,
    houseModel: { complete: refuse },
    ownModel: () => ({ complete: refuse }),
    keys: { open: refuse },
    limits: {
      maxDecisionsPerStep: 5,
      maxSkipsPerStep: 10,
      maxSummariesPerStep: 2,
      houseNeuronsPerDay: contracts.HOUSE_NEURONS_PER_DAY,
      houseNeuronsPerMillionInputTokens: 26_668,
      houseNeuronsPerMillionOutputTokens: 204_805,
      modelTimeoutMs: 20_000,
      maxOutputTokens: 300,
      feedStaleAfterSeconds: contracts.FEED_STALE_AFTER_SECONDS,
    },
    log: (event) => events.push(event),
  };
}
