#!/usr/bin/env node
// The tick-creating step at 25 symbols, with both chains read (docs/CONTRACTS.md section 23,
// "What ships it"): outbound requests, D1 statements, wall time and CPU of one scheduler step
// against the limits of one free-plan invocation (section 2).
//
//   node tools/perf/stage2-tick.mjs [--runs 200] [--skip-slow] [--port-base 8990]
//
// What is real: the scheduler step of packages/runtime, the market of packages/market (the product's
// `createMarket`, with its real RPC_TIMEOUT_MS and retry pause), the store of apps/api on the D1
// that Wrangler runs locally, and real HTTP requests to seven local servers, one per endpoint the
// Worker is configured with (a keyed Robinhood endpoint, the three public Robinhood endpoints, the
// three Arbitrum endpoints of the contract). The market is given the endpoints' real URLs; its
// `fetch` sends each to the local server that stands for it, so the market's own rules (who is a
// third party, who confirms whom) run as deployed. Nothing leaves this machine.
//
// What is a stand-in: the two chains (the servers answer with the market's own result encoder),
// and the machine. CPU is the step replayed in this process with every HTTP and D1 answer served
// from memory, so it is an ESTIMATE for a Worker, not a measurement of one.
//
// Ports: port-base .. port-base+6 the endpoints, port-base+7 the local D1.

import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { cli, parseArgs, REPO_ROOT, table, writeArtifact } from './lib.mjs';
import { FREE_PLAN, SCHEDULER_LIMITS } from './limits.mjs';
import { applyMigrations, createMeteredD1 } from './local-d1.mjs';

const load = (path) => import(pathToFileURL(resolve(REPO_ROOT, path)).href);

const USAGE = 'node tools/perf/stage2-tick.mjs [--runs 200] [--skip-slow] [--port-base 8990]';

await cli(() => main(process.argv.slice(2)), USAGE);

async function main(argv) {
  const { options } = parseArgs(argv, { runs: 200, skipSlow: false, portBase: 8990 });
  const RUNS = options.runs;
  const PORT = options.portBase;

  const contracts = await load('packages/contracts/src/index.ts');
  const { runSchedulerStep } = await load('packages/runtime/src/index.ts');
  const { createD1Store } = await load('apps/api/src/store/index.ts');
  const { createMarketConfig } = await load('apps/api/src/market-config.ts');
  const { sim } = await load('packages/sim/src/index.ts');
  const { scoring } = await load('packages/reputation/src/index.ts');
  const { UNIVERSE, rpcEndpoints } = await load('packages/market/src/index.ts');
  const { createMarket, createMarketWith, RETRY_PAUSE_MS } = await load('packages/market/src/market.ts');
  const { RPC_TIMEOUT_MS } = await load('packages/market/src/chain.ts');
  const wire = await load('packages/market/src/wire.ts');
  const { MICRO, ARBITRUM_MAX_REQUESTS_PER_SNAPSHOT, ARBITRUM_OFFICIAL_RPC_URL, ARBITRUM_CONFIRMING_RPC_URLS } =
    contracts;

  if (UNIVERSE.length !== contracts.UNIVERSE_SIZE || UNIVERSE.length !== 25) {
    throw new Error(`The universe has ${UNIVERSE.length} symbols; this script measures 25.`);
  }

  // --- the endpoints, as the Worker has them with a keyed RPC_URL set ----------------------------

  const KEYED = 'https://keyed.perf.invalid/v1/perf'; // a made-up name; never resolved, never asked
  const robinhoodUrls = rpcEndpoints(KEYED);
  const arbitrumUrls = [ARBITRUM_OFFICIAL_RPC_URL, ...ARBITRUM_CONFIRMING_RPC_URLS];
  const ROBINHOOD_NAMES = ['rh keyed', 'rh official', 'rh publicnode', 'rh dRPC'];
  const ARBITRUM_NAMES = ['arb official', 'arb publicnode', 'arb dRPC'];
  if (robinhoodUrls.length !== 4 || arbitrumUrls.length !== 3) throw new Error('Unexpected endpoint lists.');
  const norm = (url) => String(url).trim().replace(/\/+$/, '');
  const endpoints = [
    ...robinhoodUrls.map((url, i) => ({ url: norm(url), chain: 'robinhood', name: ROBINHOOD_NAMES[i] })),
    ...arbitrumUrls.map((url, i) => ({ url: norm(url), chain: 'arbitrum', name: ARBITRUM_NAMES[i] })),
  ].map((endpoint, i) => ({ ...endpoint, port: PORT + i, mode: 'ok', hits: 0 }));
  const byUrl = new Map(endpoints.map((endpoint) => [endpoint.url, endpoint]));
  const D1_PORT = PORT + endpoints.length;

  // --- the two fake chains: what the servers answer ----------------------------------------------

  const symbols = UNIVERSE.map((token) => token.symbol);
  const COINS = UNIVERSE.filter((token) => token.kind === 'crypto').map((token) => token.symbol);
  const ARBITRUM = UNIVERSE.filter((token) => token.kind === 'crypto' && token.chainId === 42161).map(
    (token) => token.symbol,
  );
  const STOCKS = symbols.filter((symbol) => !COINS.includes(symbol));
  const usdOf = (symbol, k) => ({ BTC: 62_000, ETH: 2_400, BNB: 610, HYPE: 38, SOL: 150 })[symbol] ?? 50 + k * 37;
  const microOf = (symbol, factor = 1) => Math.round((usdOf(symbol, symbols.indexOf(symbol)) + 0.37) * MICRO * factor);

  /** What the chains say now: set per scenario. `change` maps a symbol to a price factor. */
  const chain = { nowSeconds: 0, change: {} };
  const ARB_L2_BLOCK = 391_234_567n;

  function readsNow() {
    return UNIVERSE.map((token) => {
      const factor = chain.change[token.symbol] ?? 1;
      return {
        // A feed has 8 decimals; a micro-dollar has 6.
        round: { answer: BigInt(microOf(token.symbol, factor)) * 100n, updatedAt: BigInt(chain.nowSeconds - 60) },
        decimals: 8,
        oraclePaused: token.kind === 'stock' ? false : null,
      };
    });
  }

  function chainResult(endpoint, blockTag) {
    if (endpoint.chain === 'robinhood') {
      return wire.encodeSnapshotResult(UNIVERSE, {
        blockNumber: 4_242_424n,
        blockTimestamp: BigInt(chain.nowSeconds - 2),
        chainId: 4663n,
        reads: readsNow(),
      });
    }
    // Arbitrum: a pinned read answers for the block it was pinned to, so the pair is byte-identical.
    const pinned = typeof blockTag === 'string' && /^0x[0-9a-f]+$/i.test(blockTag) ? BigInt(blockTag) : null;
    return wire.encodeArbitrumResult(UNIVERSE, {
      l1BlockNumber: 23_456_789n,
      chainId: 42161n,
      blockTimestamp: BigInt(chain.nowSeconds - 2),
      l2BlockNumber: pinned ?? ARB_L2_BLOCK,
      sequencer: { answer: 0n, startedAt: BigInt(chain.nowSeconds - 30 * 86_400) },
      reads: readsNow(),
    });
  }

  // --- seven local servers ----------------------------------------------------------------------

  const hanging = new Set();
  const servers = [];
  for (const endpoint of endpoints) {
    const server = createServer((request, response) => {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        endpoint.hits += 1;
        let mode = endpoint.mode;
        if (mode === 'fail_once') mode = endpoint.hits === 1 ? 'http_500' : 'ok';
        if (mode === 'hang') {
          // Never answers. The request ends when the market's time limit aborts it.
          hanging.add(response.socket);
          return;
        }
        if (mode === 'http_500') {
          response.writeHead(500, { 'content-type': 'text/plain' });
          response.end('upstream error');
          return;
        }
        let answer;
        try {
          const call = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (Array.isArray(call) || call.method !== 'eth_call') throw new Error('not one eth_call');
          answer = { jsonrpc: '2.0', id: call.id ?? null, result: chainResult(endpoint, call.params?.[1]) };
        } catch {
          answer = { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } };
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(answer));
      });
    });
    await new Promise((done, fail) => {
      server.once('error', fail);
      server.listen(endpoint.port, '127.0.0.1', done);
    });
    servers.push(server);
  }
  const dropHanging = () => {
    for (const socket of hanging) socket?.destroy();
    hanging.clear();
  };

  // --- the local D1 -----------------------------------------------------------------------------

  const { unstable_startWorker: startWorker } = await import('wrangler');
  const worker = await startWorker({
    config: resolve(REPO_ROOT, 'tools', 'perf', 'd1-worker', 'wrangler.jsonc'),
    dev: {
      persist: false,
      server: { port: D1_PORT },
      inspector: false,
      logLevel: 'error',
      watch: false,
      remote: false,
    },
  });

  let result;
  try {
    await worker.ready;
    const d1Url = String(await worker.url);
    const execute = async (statements, batch) => {
      const response = await fetch(d1Url, { method: 'POST', body: JSON.stringify({ statements, batch }) });
      const answer = await response.json();
      if (!answer.ok) throw new Error(answer.message);
      return answer.results;
    };
    await applyMigrations(execute);
    result = await measure(execute);
  } finally {
    dropHanging();
    for (const server of servers) {
      server.closeAllConnections?.();
      await new Promise((done) => server.close(done));
    }
    await worker.dispose();
  }
  return result;

  // --- the measurement ---------------------------------------------------------------------------

  async function measure(execute) {
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
    const seedStore = createD1Store(createMeteredD1(execute).db);

    /** The points of a stored tick. `change`: a factor, or 'stale' (priced, not fresh). */
    const pointsAt = (takenAt, only, change = {}) =>
      UNIVERSE.filter((token) => only === undefined || only.includes(token.symbol)).map((token) => {
        const c = change[token.symbol];
        return {
          symbol: token.symbol,
          priceMicro: microOf(token.symbol, typeof c === 'number' ? c : 1),
          updatedAt: takenAt,
          ageSeconds: 60,
          fresh: c !== 'stale',
        };
      });
    const storedSnapshot = (takenAt, prices) => ({
      takenAt,
      chainId: 4663,
      blockNumber: 1_000_000,
      open: true,
      closedReason: null,
      prices,
      otherChains: [{ chainId: 42161, blockNumber: 300_000_000, endpoint: 0, confirmedBy: null, problem: null }],
    });
    const atOf = (id) => `${id.slice(0, 13)}:00:30.000Z`;
    const all25 = (id, change) => ({ id, prices: pointsAt(atOf(id), undefined, change) });
    const without = (id, out) => ({
      id,
      prices: pointsAt(
        atOf(id),
        symbols.filter((symbol) => !out.includes(symbol)),
      ),
    });

    async function reset(history, holds) {
      for (const tableName of ['symbol_holds', 'ticks', 'market_status']) {
        await execute([{ sql: `DELETE FROM ${tableName}`, params: [] }], false);
      }
      for (const { id, prices } of history) {
        const created = await seedStore.createTick({
          id,
          seasonId: SEASON.id,
          daily: id.endsWith('T15:00Z'),
          snapshot: storedSnapshot(atOf(id), prices),
          status: 'complete',
          createdAt: atOf(id),
          completedAt: atOf(id),
        });
        if (!created) throw new Error(`history tick ${id} not stored`);
      }
      for (const hold of holds) {
        await seedStore.putSymbolHold({ ...hold, releasedAt: null });
        if (hold.releasedAt !== null) await seedStore.releaseSymbolHold(hold.symbol, hold.releasedAt);
      }
    }
    const releasedHold = (symbol) => ({
      symbol,
      priceMicro: microOf(symbol),
      seenPriceMicro: microOf(symbol, 2),
      sinceTickId: '2026-10-09T19:00Z',
      releasedAt: '2026-10-12T15:30:00.000Z',
      createdAt: '2026-10-09T19:00:31.000Z',
    });

    const FRI = '2026-10-09T19:00Z';
    const MON15 = '2026-10-12T15:00Z';
    const NOW_15 = '2026-10-12T15:00:30.000Z';
    const NOW_16 = '2026-10-12T16:00:30.000Z';
    const up50 = (list) => Object.fromEntries(list.map((symbol) => [symbol, 1.5]));
    const modes = (robinhood, arbitrum) => [...robinhood, ...arbitrum];
    const OK4 = ['ok', 'ok', 'ok', 'ok'];
    const OK3 = ['ok', 'ok', 'ok'];
    const HANG4 = ['hang', 'hang', 'hang', 'hang'];
    const HANG3 = ['hang', 'hang', 'hang'];
    const DOWN4 = ['http_500', 'http_500', 'http_500', 'http_500'];
    const DOWN3 = ['http_500', 'http_500', 'http_500'];
    // The most requests that still make a tick: the keyed and the official endpoint each fail twice,
    // publicnode and dRPC each fail once and then answer, so the third-party read is confirmed.
    const RH_MOST_OPEN = ['http_500', 'http_500', 'fail_once', 'fail_once'];
    // The most Arbitrum requests that still read the coins: the official one fails, the pair agrees.
    const ARB_PAIR = ['http_500', 'ok', 'ok'];
    // The 25-symbol history that makes the step write the most (packages/runtime's own worst case):
    // the latest tick is today's, SOL has no trusted price, 2 Stock Tokens and the 5 coins move 50%
    // (7 new holds), and the 18 other Stock Tokens have released holds the step uses up.
    const worstHistory = [all25(FRI, { SOL: 'stale' }), all25(MON15, { SOL: 'stale' })];
    const worstHolds = STOCKS.slice(2).map(releasedHold);
    const worstChange = up50([...STOCKS.slice(0, 2), ...COINS]);

    const scenarios = [
      {
        name: 'typical: keyed Robinhood and official Arbitrum answer',
        now: NOW_15,
        history: [all25(FRI)],
        modes: modes(OK4, OK3),
      },
      {
        name: 'first tick with BNB, HYPE, SOL (latest tick has 22)',
        now: NOW_15,
        history: [without(FRI, ARBITRUM)],
        modes: modes(OK4, OK3),
      },
      {
        name: 'Arbitrum official down, the pair confirms',
        now: NOW_15,
        history: [all25(FRI)],
        modes: modes(OK4, ARB_PAIR),
      },
      {
        name: 'Arbitrum down at once (3 x HTTP 500), Robinhood answers',
        now: NOW_15,
        history: [all25(FRI)],
        modes: modes(OK4, DOWN3),
      },
      {
        name: `Arbitrum hangs (3 x ${RPC_TIMEOUT_MS / 1000} s), Robinhood answers`,
        now: NOW_15,
        history: [all25(FRI)],
        modes: modes(OK4, HANG3),
        slow: true,
      },
      {
        name: 'most requests with a tick: 8 Robinhood + 3 Arbitrum, heaviest writes',
        now: NOW_16,
        history: worstHistory,
        holds: worstHolds,
        change: worstChange,
        modes: modes(RH_MOST_OPEN, ARB_PAIR),
      },
      {
        name: 'heaviest writes, Arbitrum hangs',
        now: NOW_16,
        history: worstHistory,
        holds: worstHolds,
        change: worstChange,
        modes: modes(RH_MOST_OPEN, HANG3),
        slow: true,
      },
      {
        name: 'all 25 move 50% (25 new holds), every endpoint tried',
        now: NOW_16,
        history: worstHistory,
        change: up50(symbols),
        modes: modes(RH_MOST_OPEN, ARB_PAIR),
      },
      {
        name: 'every endpoint fails at once (11 x HTTP 500)',
        now: NOW_15,
        history: [all25(FRI)],
        modes: modes(DOWN4, DOWN3),
      },
      {
        name: `every endpoint hangs (7 endpoints, ${RPC_TIMEOUT_MS / 1000} s each try)`,
        now: NOW_15,
        history: [all25(FRI)],
        modes: modes(HANG4, HANG3),
        slow: true,
      },
    ];

    const rows = [];
    let first = null;
    for (const scenario of scenarios) {
      if (scenario.slow && options.skipSlow) continue;
      await reset(scenario.history, scenario.holds ?? []);
      chain.nowSeconds = Math.floor(new Date(scenario.now).getTime() / 1000);
      chain.change = scenario.change ?? {};
      endpoints.forEach((endpoint, i) => {
        endpoint.mode = scenario.modes[i];
        endpoint.hits = 0;
      });

      // The step, once, for real: real HTTP to the local endpoints, real D1.
      const http = []; // every outbound request of the market, in order, with what came back
      let inFlight = 0;
      let mostInFlight = 0;
      const routedFetch = async (input, init) => {
        const endpoint = byUrl.get(norm(typeof input === 'string' ? input : input.url));
        if (endpoint === undefined) throw new Error('The market asked an endpoint this script does not know.');
        const entry = { chain: endpoint.chain, name: endpoint.name, startedMs: performance.now(), outcome: null };
        http.push(entry);
        inFlight += 1;
        mostInFlight = Math.max(mostInFlight, inFlight);
        try {
          const response = await fetch(`http://127.0.0.1:${endpoint.port}/`, init);
          const text = await response.text();
          entry.outcome = { status: response.status, text };
          return new Response(text, { status: response.status, headers: response.headers });
        } catch (error) {
          entry.outcome = { thrown: error?.name ?? 'Error' };
          throw error;
        } finally {
          inFlight -= 1;
          entry.ms = performance.now() - entry.startedMs;
        }
      };
      const d1Answers = [];
      const metered = createMeteredD1(async (statements, batch) => {
        const results = await execute(statements, batch);
        d1Answers.push(results);
        return results;
      });
      const failures = [];
      const config = { ...createMarketConfig(robinhoodUrls), fetch: routedFetch };
      config.onEndpointFailure = (failure) => failures.push(failure);
      const events = [];
      const quiet = silenceConsole();
      let report;
      const started = performance.now();
      try {
        report = await runSchedulerStep(
          depsFor(createD1Store(metered.db), createMarket(config), events),
          new Date(scenario.now),
        );
      } finally {
        quiet.restore();
      }
      const wallMs = performance.now() - started;
      dropHanging();
      const taken = metered.meter.take();
      const robinhood = http.filter((entry) => entry.chain === 'robinhood').length;
      const arbitrum = http.filter((entry) => entry.chain === 'arbitrum').length;
      const stored = await execute([{ sql: 'SELECT snapshot FROM ticks ORDER BY id DESC LIMIT 1', params: [] }], false);
      const snapshot = report.action === 'tick_created' ? JSON.parse(stored[0].results[0].snapshot) : null;
      const arbitrumProblem = snapshot?.otherChains?.[0]?.problem ?? null;
      const unread = snapshot === null ? null : snapshot.prices.filter((p) => ARBITRUM.includes(p.symbol) && !p.fresh);

      // CPU: the same step again, every HTTP and D1 answer from memory, the retry pause skipped.
      let cpuMs = null;
      let firstMs = null;
      let p99Ms = null;
      let p50Ms = null;
      if (RUNS > 0) {
        const replayStep = async () => {
          let nextHttp = 0;
          let nextD1 = 0;
          // Both chains are read at once, so the order of the two chains' requests is not fixed:
          // each chain replays its own requests in order.
          const queues = {
            robinhood: http.filter((e) => e.chain === 'robinhood'),
            arbitrum: http.filter((e) => e.chain === 'arbitrum'),
          };
          const at = { robinhood: 0, arbitrum: 0 };
          const replayFetch = async (input) => {
            const endpoint = byUrl.get(norm(typeof input === 'string' ? input : input.url));
            const entry = queues[endpoint.chain][at[endpoint.chain]];
            at[endpoint.chain] += 1;
            nextHttp += 1;
            if (entry === undefined || entry.name !== endpoint.name) throw new Error('replay diverged (HTTP)');
            if (entry.outcome.thrown !== undefined) throw new DOMException('replayed', entry.outcome.thrown);
            return new Response(entry.outcome.text, { status: entry.outcome.status });
          };
          const replayD1 = createMeteredD1(async () => {
            const results = d1Answers[nextD1];
            nextD1 += 1;
            if (results === undefined) throw new Error('replay diverged (D1)');
            return results;
          });
          const market = createMarketWith(
            { ...createMarketConfig(robinhoodUrls), fetch: replayFetch, onEndpointFailure: () => {} },
            { pause: async () => {}, log: () => {} },
          );
          const again = await runSchedulerStep(depsFor(createD1Store(replayD1.db), market, []), new Date(scenario.now));
          if (again.action !== report.action || nextHttp !== http.length || nextD1 !== d1Answers.length) {
            throw new Error(
              `replay diverged: ${again.action}, ${nextHttp}/${http.length} HTTP, ${nextD1}/${d1Answers.length} D1`,
            );
          }
        };
        const t0 = performance.now();
        await replayStep();
        firstMs = performance.now() - t0;
        if (first === null) first = { scenario: scenario.name, ms: firstMs };
        for (let i = 0; i < 30; i += 1) await replayStep(); // warm the JIT, as a warm isolate is
        const walls = [];
        const before = process.cpuUsage();
        for (let i = 0; i < RUNS; i += 1) {
          const t = performance.now();
          await replayStep();
          walls.push(performance.now() - t);
        }
        const used = process.cpuUsage(before);
        cpuMs = (used.user + used.system) / 1000 / RUNS;
        walls.sort((a, b) => a - b);
        p99Ms = walls[Math.min(walls.length - 1, Math.floor(walls.length * 0.99))];
        p50Ms = walls[Math.floor(walls.length / 2)];
      }

      rows.push({
        scenario: scenario.name,
        action: report.action,
        robinhood,
        arbitrum,
        requests: http.length,
        mostInFlight,
        statements: taken.statements,
        rowsRead: taken.rowsRead,
        rowsWritten: taken.rowsWritten,
        holds: events.filter((event) => event === 'symbol_held').length,
        arbitrumProblem,
        arbitrumUnread: unread === null ? null : unread.length,
        endpointFailures: failures.length,
        wallMs,
        slowestRequestMs: Math.max(0, ...http.map((entry) => entry.ms)),
        cpuMs,
        cpuP50Ms: p50Ms,
        cpuP99Ms: p99Ms,
        robinhoodAnswers: http.filter((e) => e.chain === 'robinhood' && e.outcome?.status === 200).length,
        arbitrumAnswers: http.filter((e) => e.chain === 'arbitrum' && e.outcome?.status === 200).length,
        cpuFirstMs: firstMs,
      });
    }
    return printReport(rows, first, await wireCost());
  }

  /**
   * The CPU of the four pure functions of packages/market/src/wire.ts that the market runs for
   * every request: the calldata is encoded once per request, an answer is decoded once. Mean of
   * 1,000 calls each, after 200 to warm the JIT.
   */
  async function wireCost() {
    const robinhoodResult = chainResult(endpoints[0], 'latest');
    const arbitrumResult = chainResult(endpoints[4], 'latest');
    const { ARBITRUM_SEQUENCER_FEED } = await load('packages/market/src/universe.ts');
    const bench = (fn) => {
      for (let i = 0; i < 200; i += 1) fn();
      const before = process.cpuUsage();
      for (let i = 0; i < 1000; i += 1) fn();
      const used = process.cpuUsage(before);
      return (used.user + used.system) / 1000 / 1000;
    };
    return {
      encodeSnapshotCall: bench(() => wire.encodeSnapshotCall(UNIVERSE)),
      decodeSnapshotResult: bench(() => wire.decodeSnapshotResult(UNIVERSE, robinhoodResult)),
      encodeArbitrumCall: bench(() => wire.encodeArbitrumCall(UNIVERSE, ARBITRUM_SEQUENCER_FEED.address)),
      decodeArbitrumResult: bench(() => wire.decodeArbitrumResult(UNIVERSE, arbitrumResult)),
    };
  }

  function depsFor(store, market, events) {
    const refuse = async () => {
      throw new Error('no model in this measurement');
    };
    return {
      store,
      market,
      sim,
      scoring,
      houseModel: { complete: refuse },
      ownModel: () => ({ complete: refuse }),
      keys: { open: refuse },
      limits: SCHEDULER_LIMITS,
      log: (event) => events.push(event),
    };
  }

  // --- the report -------------------------------------------------------------------------------

  async function printReport(rows, first, cost) {
    const ms = (value) => (value === null ? '-' : value.toFixed(2));
    const seconds = (value) => (value / 1000).toFixed(2);
    console.log(`Tick-creating step at ${UNIVERSE.length} symbols, both chains read. ${new Date().toISOString()}`);
    console.log(
      `Conditions: Node ${process.version} on ${process.platform} ${process.arch}; the product's createMarket ` +
        `(RPC_TIMEOUT_MS ${RPC_TIMEOUT_MS}, retry pause ${RETRY_PAUSE_MS} ms); a keyed RPC_URL set, so 4 Robinhood ` +
        `endpoints and 3 Arbitrum endpoints, each a local HTTP server; D1 is Wrangler's local D1.`,
    );
    console.log(
      `CPU: the step replayed ${RUNS} times with every HTTP and D1 answer from memory (CPU ms: the mean CPU of ` +
        'the process; p50 and p99: the time of one replay). An ESTIMATE from this machine, not a Worker measurement.\n',
    );
    console.log(
      table([
        [
          'Scenario',
          'Step',
          'RH',
          'ARB',
          'HTTP',
          'At once',
          'D1',
          'HTTP+D1',
          'Holds',
          'Arbitrum',
          'Wall s',
          'CPU ms',
          'p50 ms',
          'p99 ms',
        ],
        ...rows.map((row) => [
          row.scenario,
          row.action,
          String(row.robinhood),
          String(row.arbitrum),
          String(row.requests),
          String(row.mostInFlight),
          String(row.statements),
          String(row.requests + row.statements),
          String(row.holds),
          row.action === 'tick_created' ? (row.arbitrumProblem ?? 'read') : '-',
          seconds(row.wallMs),
          ms(row.cpuMs),
          ms(row.cpuP50Ms),
          ms(row.cpuP99Ms),
        ]),
      ]),
    );

    const most = (key) => rows.reduce((best, row) => (row[key] > best[key] ? row : best), rows[0]);
    const mostHttp = most('requests');
    const mostD1 = most('statements');
    const mostSum = rows.reduce(
      (best, row) => (row.requests + row.statements > best.requests + best.statements ? row : best),
      rows[0],
    );
    const mostAtOnce = most('mostInFlight');
    const mostWall = most('wallMs');
    const measuredCpu = rows.filter((row) => row.cpuMs !== null);
    const mostCpu = measuredCpu.length === 0 ? null : measuredCpu.reduce((a, b) => (b.cpuMs > a.cpuMs ? b : a));
    const mostP99 = measuredCpu.length === 0 ? null : measuredCpu.reduce((a, b) => (b.cpuP99Ms > a.cpuP99Ms ? b : a));
    const contractHttp = 2 * 4 + ARBITRUM_MAX_REQUESTS_PER_SNAPSHOT;
    const sum = mostSum.requests + mostSum.statements;

    const checks = [
      {
        name: 'outbound requests',
        ok: mostHttp.requests <= FREE_PLAN.subrequestsPerInvocation && mostHttp.requests <= contractHttp,
        line: `most outbound requests in one step: ${mostHttp.requests} (the contract's most: ${contractHttp} = 8 Robinhood + ${ARBITRUM_MAX_REQUESTS_PER_SNAPSHOT} Arbitrum; limit ${FREE_PLAN.subrequestsPerInvocation}) in "${mostHttp.scenario}"`,
      },
      {
        name: 'Arbitrum requests',
        ok: rows.every((row) => row.arbitrum <= ARBITRUM_MAX_REQUESTS_PER_SNAPSHOT),
        line: `most Arbitrum requests in one snapshot: ${Math.max(...rows.map((row) => row.arbitrum))} (ARBITRUM_MAX_REQUESTS_PER_SNAPSHOT ${ARBITRUM_MAX_REQUESTS_PER_SNAPSHOT})`,
      },
      {
        name: 'D1 statements',
        ok: mostD1.statements <= FREE_PLAN.d1QueriesPerInvocation,
        line: `most D1 statements in one step: ${mostD1.statements} (limit ${FREE_PLAN.d1QueriesPerInvocation}) in "${mostD1.scenario}"`,
      },
      {
        name: 'outbound requests + D1 statements',
        ok: sum <= FREE_PLAN.subrequestsPerInvocation,
        line: `most outbound requests and D1 statements together: ${sum} (${mostSum.requests} + ${mostSum.statements}; the strict reading of the ${FREE_PLAN.subrequestsPerInvocation} limit, a D1 statement counted as a subrequest) in "${mostSum.scenario}"`,
      },
      {
        name: 'connections at once',
        ok: mostAtOnce.mostInFlight < FREE_PLAN.simultaneousConnections,
        line: `most outbound requests open at once: ${mostAtOnce.mostInFlight} (limit ${FREE_PLAN.simultaneousConnections})`,
      },
      {
        name: 'CPU',
        ok: mostCpu === null ? null : mostCpu.cpuMs < FREE_PLAN.cpuMsPerCronTrigger,
        line:
          mostCpu === null
            ? 'CPU not measured (--runs 0)'
            : `most CPU per step: ${mostCpu.cpuMs.toFixed(2)} ms mean in "${mostCpu.scenario}", ${mostP99.cpuP99Ms.toFixed(2)} ms at the 99th percentile in "${mostP99.scenario}" (limit ${FREE_PLAN.cpuMsPerCronTrigger} ms). ESTIMATE.`,
      },
    ];

    console.log('');
    for (const check of checks) {
      console.log(`${check.ok === null ? 'SKIP' : check.ok ? 'PASS' : 'FAIL'}  ${check.line}`);
    }
    console.log(
      `INFO  longest step: ${seconds(mostWall.wallMs)} s of wall time in "${mostWall.scenario}". Wall time is not a free-plan limit; the alarm fires every 60 s.`,
    );
    const hang = rows.find((row) => row.scenario.startsWith('Arbitrum hangs'));
    if (hang !== undefined) {
      console.log(
        `INFO  Arbitrum hanging while Robinhood answers: ${seconds(hang.wallMs)} s (3 x ${RPC_TIMEOUT_MS / 1000} s = ${(3 * RPC_TIMEOUT_MS) / 1000} s expected), step ${hang.action}, Arbitrum "${hang.arbitrumProblem}", ${hang.arbitrumUnread} of 3 coins unread.`,
      );
    }
    if (mostWall.wallMs > 60_000) {
      console.log(
        `RISK  the longest step outlasts the 60 s between alarms (${seconds(mostWall.wallMs)} s): the next alarm is due before it ends.`,
      );
    }
    if (first !== null) {
      console.log(
        `${first.ms >= FREE_PLAN.cpuMsPerCronTrigger ? 'RISK' : 'INFO'}  first replay in this process, before the JIT is warm: ${first.ms.toFixed(2)} ms of wall time ("${first.scenario}"). A cold isolate pays something like it once; the mean above is a warm one. ESTIMATE.`,
      );
    }
    if (mostCpu !== null) {
      // packages/market keeps each chain's calldata (`snapshotCalldata`, `arbitrumCalldata`), so a
      // step in a warm isolate encodes nothing and a new isolate encodes each chain once. Answers
      // two endpoints of one snapshot give in the same bytes are decoded once, so the decoding
      // below is the most it can be, not what it is.
      const coldEncodeMs = cost.encodeSnapshotCall + cost.encodeArbitrumCall;
      const decodeAtMostMs =
        mostCpu.robinhoodAnswers * cost.decodeSnapshotResult + mostCpu.arbitrumAnswers * cost.decodeArbitrumResult;
      console.log(
        `INFO  where the CPU goes (packages/market/src/wire.ts, mean of 1,000 calls each): encodeSnapshotCall ${cost.encodeSnapshotCall.toFixed(2)} ms, decodeSnapshotResult ${cost.decodeSnapshotResult.toFixed(2)} ms per Robinhood answer, encodeArbitrumCall ${cost.encodeArbitrumCall.toFixed(2)} ms, decodeArbitrumResult ${cost.decodeArbitrumResult.toFixed(2)} ms per Arbitrum answer. ESTIMATE.`,
      );
      console.log(
        `INFO  the heaviest step sends ${mostCpu.robinhood} + ${mostCpu.arbitrum} requests and reads ${mostCpu.robinhoodAnswers} + ${mostCpu.arbitrumAnswers} answers. The market keeps each chain's calldata: a warm isolate encodes nothing (the mean above), a new isolate encodes each chain once, ${coldEncodeMs.toFixed(2)} ms more on its first step. Decoding is at most ${decodeAtMostMs.toFixed(2)} ms of its ${mostCpu.cpuMs.toFixed(2)} ms. ESTIMATE.`,
      );
    }
    console.log(
      'NOTE  not in these counts: the alarm itself also calls start() on the 4 other Clock objects (Durable Object calls, apps/api/src/index.ts) and sets its next alarm.',
    );

    const passed = checks.every((check) => check.ok !== false);
    const artifact = await writeArtifact(
      'stage2-tick.json',
      JSON.stringify(
        {
          measuredAt: new Date().toISOString(),
          conditions: {
            node: process.version,
            platform: `${process.platform} ${process.arch}`,
            symbols: UNIVERSE.length,
            rpcTimeoutMs: RPC_TIMEOUT_MS,
            retryPauseMs: RETRY_PAUSE_MS,
            robinhoodEndpoints: 4,
            arbitrumEndpoints: 3,
            cpuRuns: RUNS,
            cpu: 'estimate: replay in Node on this machine',
          },
          limits: FREE_PLAN,
          rows,
          wireCostMs: cost,
          checks: checks.map(({ name, ok, line }) => ({ name, ok, line })),
          passed,
        },
        null,
        2,
      ),
    );
    console.log(`\n${passed ? 'PASS' : 'FAIL'}  tick-creating step at 25 symbols. Result: ${artifact}`);
    return passed ? 0 : 1;
  }
}

/** The market and the Worker's failure hook log to the console; a measurement does not need the lines. */
function silenceConsole() {
  const { log, warn } = console;
  console.log = () => {};
  console.warn = () => {};
  return {
    restore() {
      console.log = log;
      console.warn = warn;
    },
  };
}
