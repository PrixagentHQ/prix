#!/usr/bin/env node
// Gate 3 of docs/contracts/phase-6-holders.md section 12, as revision 8f words it (section 25, perf's row): the
// holders' poll tally at POLL_MAX_VOTERS voters, measured after the build and before POLLS_ENABLED is "true".
//
//   node tools/perf/polls-tally.mjs [--runs 100] [--tail 20]
//
// Four parts, one results file (.artifacts/perf/polls-tally-<date>.json), each with its method:
//
// 1. COUNTS, by driving the built entry's `Clock.alarm()` for SOCIAL_CRON in local workerd
//    (tools/perf/polls-tally-worker): every D1 statement, every fetch and every Durable Object call of the
//    invocation, for the worst tally run and the worst prune run with the official endpoint answering 429 to every
//    call, and for a waiting run (F3: POLLS_ENABLED "false", a closed poll with no voter) whose poll_tally
//    statements are the difference between the same alarm with POLL_TALLY_JOB "on" and "off".
// 2. CPU, an ESTIMATE: the social step's jobs replayed in this Node process (createPollTallyJob and the five jobs
//    ahead with the entry's engines, runSocialStep), every D1 answer served from a recording made on the local D1
//    and every chain answer from the fake chain at zero latency; process.cpuUsage around a loop of runs (its mean),
//    plus the first replay's wall time. The configuration is read through the real token service over the local
//    D1, its cache cold (R8B-1).
// 3. WALL TIME of the worst tally and prune runs on the real clock against POLL_TALLY_MAX_RUN_SECONDS, the fake
//    chain answering each fetch after POLL_TALLY_FETCH_LATENCY_MS, its head moving POLL_TALLY_CHAIN_BLOCKS_PER_SECOND
//    blocks a second from the run's first fetch, publicnode answering 403 past POLL_TALLY_KEYLESS_STATE_BLOCKS; four
//    cases: the official endpoint answering 429, never answering, answering every call correctly after 1,400 ms
//    (D4), and answering 429 with publicnode answering one read that is not the last after 1,400 ms (F1).
// 4. THE TAIL of one full page's read on the REAL publicnode and dRPC endpoints, from this laptop (not from a
//    Worker): at least --tail reads of each of a 400-wallet lean tryBlockAndAggregate at a block
//    POLL_TALLY_BLOCK_MARGIN behind that endpoint's head, each aborted at POLL_TALLY_FETCH_TIMEOUT_MS; a read that
//    fails, is refused or is aborted counts as POLL_TALLY_FETCH_TIMEOUT_MS and is never dropped; the mean, the 95th
//    percentile by nearest rank and the largest, against POLL_TALLY_TAIL_P95_MAX_MS and POLL_TALLY_FETCH_TIMEOUT_MS.
//
// Exit 0 when every figure is inside its bound, 1 when one is outside, 2 on a crash.

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { cli, PERF_DIR, parseArgs, REPO_ROOT, writeArtifact } from './lib.mjs';
import { createMeteredD1, splitSql } from './local-d1.mjs';
import { makeFakeChain } from './polls-fake-chain.mjs';

const load = (path) => import(pathToFileURL(resolve(REPO_ROOT, path)).href);

const USAGE = 'node tools/perf/polls-tally.mjs [--runs 100] [--tail 20]';

// packages/market/src/token-wire.ts has a parameter property, which Node's type stripping refuses: the script
// runs itself again with the transform when it was started without it.
if (process.execArgv.includes('--experimental-transform-types')) {
  await cli(
    () =>
      main(process.argv.slice(2)).catch((error) => {
        if (error?.cause !== undefined) console.error('cause:', error.cause);
        throw error;
      }),
    USAGE,
  );
} else {
  const again = spawnSync(
    process.execPath,
    ['--experimental-transform-types', '--no-warnings', ...process.argv.slice(1)],
    { stdio: 'inherit' },
  );
  process.exitCode = again.status ?? 2;
}

async function main(argv) {
  const { options } = parseArgs(argv, { runs: 100, tail: 20 });
  const RUNS = options.runs;
  const c = await load('packages/contracts/src/index.ts');
  const need = (name) => {
    if (c[name] === undefined) throw new Error(`@prix/contracts exports no ${name}.`);
    return c[name];
  };
  const POLL = need('HOLDER_POLLS')[0];
  const VOTERS = need('POLL_MAX_VOTERS');
  const PAGE = need('POLL_TALLY_PAGE');
  const MARGIN = need('POLL_TALLY_BLOCK_MARGIN');
  const B = {
    runCpuMs: need('POLL_TALLY_RUN_CPU_MS'),
    stepCpuMs: need('SOCIAL_STEP_CPU_MS'),
    chainReads: need('POLL_TALLY_MAX_CHAIN_READS'),
    fetches: need('POLL_TALLY_MAX_FETCHES'),
    tallyStatements: need('POLL_TALLY_RUN_STATEMENTS_MAX'),
    pruneStatements: need('POLL_PRUNE_RUN_STATEMENTS_MAX'),
    waitingStatements: need('POLL_TALLY_WAITING_STATEMENTS'),
    stepSubrequests: need('SOCIAL_STEP_SUBREQUESTS_MAX'),
    jobsAhead: need('POLL_TALLY_JOBS_AHEAD'),
    idleReadsPerJob: need('SOCIAL_IDLE_READS_PER_JOB'),
    doCalls: need('POLL_TALLY_RUN_DO_CALLS') + need('CLOCK_ALARM_FANOUT_CALLS'),
    runSeconds: need('POLL_TALLY_MAX_RUN_SECONDS'),
    latencyMs: need('POLL_TALLY_FETCH_LATENCY_MS'),
    timeoutMs: need('POLL_TALLY_FETCH_TIMEOUT_MS'),
    tailP95Ms: need('POLL_TALLY_TAIL_P95_MAX_MS'),
    tailReadsMin: need('POLL_TALLY_TAIL_READS_MIN'),
    blocksPerSecond: need('POLL_TALLY_CHAIN_BLOCKS_PER_SECOND'),
    keylessStateBlocks: need('POLL_TALLY_KEYLESS_STATE_BLOCKS'),
  };
  // The booked sums of docs/contracts/phase-6-holders-2.md section 8 (35 and 36; 43 behind a waiting run).
  B.tallySum = B.jobsAhead * B.idleReadsPerJob + B.tallyStatements + B.doCalls + B.fetches;
  B.pruneSum = B.jobsAhead * B.idleReadsPerJob + B.pruneStatements + B.doCalls + B.fetches;
  B.waitingSweepSum = 43;
  const nearestRank = need('pollTallyNearestRank');
  const tailHolds = need('pollTallyTailHolds');
  const socialFailureCursor = need('socialFailureCursor');
  if (options.tail < B.tailReadsMin) throw new Error(`--tail must be at least ${B.tailReadsMin}.`);

  const { createPollTallyJob } = await load('packages/runtime/src/social/poll-tally.ts');
  const social = await load('packages/runtime/src/social/index.ts');
  const runtime = await load('packages/runtime/src/index.ts');
  const { createTokenService, resetTokenMemory } = await load('packages/runtime/src/token/service.ts');
  const { pollHoldingFor } = await load('apps/api/src/poll-holding.ts');
  const { createTokenChainReader } = await load('packages/market/src/token-balances.ts');
  const { createPollStore } = await load('apps/api/src/store/polls.ts');
  const { createSocialStore } = await load('apps/api/src/store/social.ts');
  const { createReputationStore } = await load('apps/api/src/store/reputation.ts');
  const { createTokenStore } = await load('apps/api/src/store/token.ts');
  const { createD1Store } = await load('apps/api/src/store/index.ts');
  const { rpcEndpoints } = await load('packages/market/src/chain.ts');
  const wire = await load('packages/market/src/token-wire.ts');
  const { sim } = await load('packages/sim/src/index.ts');
  const { createManagerEngine } = await load('packages/sim/src/manager.ts');
  const { scoring } = await load('packages/reputation/src/index.ts');
  const { scoringV2 } = await load('packages/reputation/src/v2.ts');
  const { strategyDna } = await load('packages/reputation/src/dna.ts');
  const { rivalryEngine } = await load('packages/reputation/src/rivalry.ts');

  const rpcUrls = rpcEndpoints(undefined);
  const TOKEN = '0xa74ac6e9f2f8493344923c23972d496364241044';
  const HOLDS = 20_000n * 10n ** 18n; // tier 1 (10,000 tokens) and above
  const HEAD0 = 90_500_000n;
  const wallets = Array.from({ length: VOTERS }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}`);
  const optionIds = POLL.options.map((option) => option.id);
  const DELAY = 1_800; // the replay's d; the entry draws its own from NONCE_SECRET, at most 3,599
  const tallyAt = new Date(Date.parse(POLL.closesAt) + (60 + 3_600 + 120) * 1000); // past any d, in the lookback
  const pruneAt = new Date('2026-10-18T10:01:00.000Z'); // the poll open, the first five minutes of an hour

  // --- the Worker in local workerd, which holds the local D1 for every part ------------------------------
  const { unstable_startWorker: start } = await import('wrangler');
  const worker = await start({
    config: resolve(PERF_DIR, 'polls-tally-worker', 'wrangler.jsonc'),
    dev: { persist: false, server: { port: 0 }, inspector: false, logLevel: 'error', watch: false, remote: false },
  });
  try {
    await worker.ready;
    const url = String(await worker.url).replace(/\/$/, '');
    const post = async (path, body) => {
      const send = () =>
        fetch(`${url}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(120_000),
        });
      let response;
      try {
        response = await send();
      } catch (error) {
        // Node's kept-alive connection to workerd may have been closed after a long replay: sent once more.
        if (error?.cause?.code !== 'ECONNRESET') throw error;
        response = await send();
      }
      const answer = await response.json();
      if (response.status !== 200) throw new Error(`The perf Worker failed at ${path}: ${answer.message}`);
      return answer;
    };
    const execute = async (statements, batch) => (await post('/__perf/sql', { statements, batch })).results;
    const raw = (sql) => execute([{ sql, params: [] }], false);

    // Migrations, in name order, then the token's configuration as production has it (gating on).
    const { readdir, readFile } = await import('node:fs/promises');
    const dir = resolve(REPO_ROOT, 'infra', 'migrations');
    for (const file of (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort()) {
      for (const sql of splitSql(await readFile(resolve(dir, file), 'utf8'))) await raw(sql);
    }
    await raw(
      `UPDATE token_config SET enabled = 1, token_address = '${TOKEN}', updated_at = '2026-10-16T00:00:00.000Z', updated_by = 'perf' WHERE id = 1`,
    );

    /** The poll's votes (`voters` of them) and counts, no result, and the guard's failure count of the day. */
    const reset = async (now, voters, failuresToday) => {
      await raw(`DELETE FROM poll_votes WHERE poll_id = '${POLL.id}'`);
      await raw(`DELETE FROM poll_counts WHERE poll_id = '${POLL.id}'`);
      await raw(`DELETE FROM poll_results WHERE poll_id = '${POLL.id}'`);
      const at = '2026-10-17T00:00:00.000Z';
      for (let s = 0; s < voters; s += 500) {
        const values = wallets
          .slice(s, Math.min(voters, s + 500))
          .map((wallet, i) => `('${POLL.id}','${wallet}','${optionIds[(s + i) % optionIds.length]}','${at}')`)
          .join(',');
        await raw(`INSERT INTO poll_votes (poll_id, wallet, option_id, created_at) VALUES ${values}`);
      }
      if (voters > 0) {
        const counts = optionIds.map((option, i) => {
          const n = wallets.slice(0, voters).filter((_, w) => w % optionIds.length === i).length;
          return `('${POLL.id}','${option}',${n})`;
        });
        await raw(`INSERT INTO poll_counts (poll_id, option_id, votes) VALUES ${counts.join(',')}`);
      }
      const store = createSocialStore(createMeteredD1(execute).db);
      await store.putCursor(
        {
          name: socialFailureCursor('poll_tally'),
          body: JSON.stringify({ day: now.toISOString().slice(0, 10), failures: failuresToday }),
        },
        now.toISOString(),
      );
    };
    const resultRows = async () =>
      (await raw(`SELECT COUNT(*) AS n FROM poll_results WHERE poll_id = '${POLL.id}'`))[0].results[0].n;
    const votesLeft = async () =>
      (await raw(`SELECT COUNT(*) AS n FROM poll_votes WHERE poll_id = '${POLL.id}'`))[0].results[0].n;

    // ===== Part 1: the counts, from the built entry's Clock.alarm() ===================================
    const alarmCase = async ({ name, at, voters, holds, pollsEnabled, pollTallyJob, failures }) => {
      console.error(`${new Date().toISOString()} alarm: ${name}`);
      await reset(at, voters, failures);
      const answer = await post('/__perf/alarm', {
        at: at.toISOString(),
        holds: String(holds),
        head0: String(HEAD0),
        latencyMs: B.latencyMs,
        blocksPerSecond: B.blocksPerSecond,
        keylessStateBlocks: B.keylessStateBlocks,
        official: '429',
        pollsEnabled,
        pollTallyJob,
      });
      return { name, ...answer, resultRows: await resultRows(), votesLeft: await votesLeft() };
    };
    const alarms = {
      tally: await alarmCase({
        name: 'tally, official endpoint 429, guard clear',
        at: tallyAt,
        voters: VOTERS,
        holds: HOLDS,
        pollsEnabled: 'true',
        pollTallyJob: 'on',
        failures: 1,
      }),
      prune: await alarmCase({
        name: 'prune, official endpoint 429, guard clear',
        at: pruneAt,
        voters: VOTERS,
        holds: 0n,
        pollsEnabled: 'true',
        pollTallyJob: 'on',
        failures: 1,
      }),
      waitingOn: await alarmCase({
        name: 'waiting (F3), POLL_TALLY_JOB on',
        at: tallyAt,
        voters: 0,
        holds: HOLDS,
        pollsEnabled: 'false',
        pollTallyJob: 'on',
        failures: 0,
      }),
      waitingOff: await alarmCase({
        name: 'waiting (F3), POLL_TALLY_JOB off',
        at: tallyAt,
        voters: 0,
        holds: HOLDS,
        pollsEnabled: 'false',
        pollTallyJob: 'off',
        failures: 0,
      }),
    };

    // ===== Parts 2 and 3: the Node replay (CPU) and the real-clock runs (wall time) ===================
    const config = (db) => {
      // The service keeps its configuration in the isolate's memory (TOKEN_CONFIG_CACHE_SECONDS); the contract books
      // its read at every social run, so every run here starts with it cold (R8B-1).
      resetTokenMemory();
      const tokenService = createTokenService({
        store: createTokenStore(db),
        chain: createTokenChainReader(rpcUrls, async () => {
          throw new Error('the token service reads no chain in a tally run');
        }),
        now: () => new Date(),
        log: () => {},
      });
      return async () => {
        const cfg = await tokenService.getConfig();
        return {
          token: cfg.tokenAddress,
          thresholdsPpm: cfg.thresholdsPpm,
          gatingOn: cfg.enabled && cfg.tokenAddress !== null,
        };
      };
    };
    const chainFor = (scenario, latencyMs, blocksPerSecond) =>
      makeFakeChain({
        wire,
        token: TOKEN,
        holds: scenario.holds,
        supply: 10n ** 27n,
        head0: HEAD0,
        latencyMs,
        blocksPerSecond,
        keylessStateBlocks: B.keylessStateBlocks,
        official: scenario.official,
        slowMs: 1_400,
        publicnodeSlowCall: scenario.publicnodeSlowCall ?? null,
        realNow: () => performance.now(),
        chainSeconds: () => scenario.at.getTime() / 1000,
      });

    /** The step's jobs on a D1 binding: the five ahead, poll_tally, and a sentinel behind it. */
    const stepOn = (db, meter, ch, clock, pollsEnabled) => {
      const socialStore = createSocialStore(db);
      const reputation = createReputationStore(db);
      const now = () => new Date(clock.at + (performance.now() - clock.started));
      const deps = {
        store: createD1Store(db),
        social: socialStore,
        reputation,
        sim,
        scoring,
        scoringV2,
        dna: strategyDna,
        rivalry: rivalryEngine,
        manager: createManagerEngine({ sim, scoring }),
        war: {
          ai: {
            run: async () => {
              throw new Error('no model in the perf run');
            },
          },
          groqApiKey: null,
          createHouseModel: runtime.createHouseModel,
          createOwnModel: runtime.createOwnModel,
        },
        now,
        log: () => {},
      };
      const reads = { n: 0 };
      const reader = pollHoldingFor(rpcUrls, config(db), ch.fetch);
      const lines = [];
      const tallyDeps = {
        polls: createPollStore(db),
        holding: {
          async tiersNow(list, atBlock) {
            reads.n += 1;
            try {
              return await reader.tiersNow(list, atBlock);
            } catch (error) {
              lines.push({ event: 'perf_tiers_now_threw', step: String(error?.message ?? error).slice(0, 200) });
              throw error;
            }
          },
        },
        adminAddresses: [],
        houseOwners: [],
        tallyDelaySeconds: async () => DELAY,
        pollsEnabled,
        social: socialStore,
        reputation,
        now,
        log: (event, data) => lines.push({ event, step: data?.step, readMs: data?.readMs }),
      };
      const per = new Map();
      let behindRan = false;
      const wrap = (job) => ({
        name: job.name,
        run: async (at) => {
          const s0 = meter?.statements ?? 0;
          const t0 = performance.now();
          const outcome = await job.run(at);
          per.set(job.name, { outcome, statements: (meter?.statements ?? 0) - s0, wallMs: performance.now() - t0 });
          return outcome;
        },
      });
      const jobs = [
        social.createModelWarJob(deps),
        social.createRankTapeJob(deps),
        social.createRivalryMatchJob(deps),
        social.createStrategyDnaJob(deps),
        social.createManagerValueJob(deps),
        createPollTallyJob(tallyDeps),
        {
          name: 'room_picture_sweep',
          run: async () => {
            behindRan = true;
            return 'idle';
          },
        },
      ].map(wrap);
      return { jobs, per, reads, lines, behindRan: () => behindRan };
    };

    /** A D1 binding that answers from a recording, in order (the CPU replay). */
    let mismatch = null;
    const replayDb = (recorded) => {
      let next = 0;
      const take = (n, sqls) => {
        const out = recorded.slice(next, next + n);
        next += n;
        if (out.length !== n) throw new Error('the replay ran past its recording');
        sqls.forEach((sql, i) => {
          if (out[i].sql !== undefined && out[i].sql !== sql) {
            mismatch ??= `the replay asked "${sql.replace(/\s+/g, ' ').slice(0, 90)}" where the recording has "${out[i].sql.replace(/\s+/g, ' ').slice(0, 90)}" at ${next - n + i}`;
            throw new Error('the replay diverged from its recording');
          }
        });
        return out;
      };
      class Statement {
        constructor(sql) {
          this.sql = sql;
        }
        bind() {
          return this;
        }
        async all() {
          return take(1, [this.sql])[0];
        }
        async run() {
          return take(1, [this.sql])[0];
        }
        async first(column) {
          const row = take(1, [this.sql])[0].results[0];
          if (row === undefined) return null;
          return column === undefined ? row : (row[column] ?? null);
        }
        async raw() {
          return take(1, [this.sql])[0].results.map((row) => Object.values(row));
        }
      }
      return {
        db: {
          prepare: (sql) => new Statement(sql),
          batch: async (list) =>
            take(
              list.length,
              list.map((each) => each.sql),
            ),
        },
        used: () => next,
      };
    };

    /** One metered run of the step on the local D1, recorded. */
    const meteredRun = async (scenario, latencyMs, blocksPerSecond) => {
      await reset(scenario.at, scenario.voters, scenario.failures);
      const metered = createMeteredD1(execute);
      const recorded = [];
      metered.meter.onExecute = (sent, _batch, results) => {
        results.forEach((result, i) => {
          recorded.push({ success: true, results: result.results ?? [], meta: result.meta ?? {}, sql: sent[i].sql });
        });
      };
      const ch = chainFor(scenario, latencyMs, blocksPerSecond);
      const clock = { at: scenario.at.getTime(), started: performance.now() };
      const step = stepOn(metered.db, metered.meter, ch, clock, scenario.pollsEnabled);
      const result = await social.runSocialStep(step.jobs, scenario.at);
      const tally = step.per.get('poll_tally');
      const ahead = [...step.per.entries()].filter(([n]) => n !== 'poll_tally' && n !== 'room_picture_sweep');
      return {
        result,
        tally,
        ahead,
        aheadStatements: ahead.reduce((sum, [, v]) => sum + v.statements, 0),
        recorded,
        ch,
        reads: step.reads.n,
        lines: step.lines,
        behindRan: step.behindRan(),
        resultRows: await resultRows(),
        votesLeft: await votesLeft(),
      };
    };

    // Part 2: CPU, zero latency, a standing head, the official endpoint answering 429 (the most fetches).
    const cpuScenarios = [
      {
        name: 'tally, official 429, guard clear',
        kind: 'tally',
        at: tallyAt,
        voters: VOTERS,
        holds: HOLDS,
        official: '429',
        pollsEnabled: true,
        failures: 1,
      },
      {
        name: 'prune, official 429, guard clear',
        kind: 'prune',
        at: pruneAt,
        voters: VOTERS,
        holds: 0n,
        official: '429',
        pollsEnabled: true,
        failures: 1,
      },
      {
        name: 'waiting (F3), no voter, polls off',
        kind: 'waiting',
        at: tallyAt,
        voters: 0,
        holds: HOLDS,
        official: '429',
        pollsEnabled: false,
        failures: 0,
      },
    ];
    const cpuRows = [];
    for (const scenario of cpuScenarios) {
      console.error(`${new Date().toISOString()} cpu: ${scenario.name}`);
      const run = await meteredRun(scenario, 0, 0);
      if (process.env.PERF_DEBUG === '1') {
        console.error(
          run.recorded.slice(run.aheadStatements).map((r) => r.sql.replace(/\s+/g, ' ').trim().slice(0, 50)),
        );
      }
      const replayOnce = async (only) => {
        const replay = replayDb(only === 'tally' ? run.recorded.slice(run.aheadStatements) : run.recorded);
        const rch = chainFor(scenario, 0, 0);
        const rclock = { at: scenario.at.getTime(), started: performance.now() };
        const rstep = stepOn(replay.db, null, rch, rclock, scenario.pollsEnabled);
        if (only === 'tally') {
          const outcome = await rstep.jobs[5].run(scenario.at);
          if (outcome !== run.tally?.outcome || replay.used() !== run.recorded.length - run.aheadStatements) {
            throw new Error(
              `the replay of "${scenario.name}" (poll_tally alone) diverged from its recording: ${outcome} against ${run.tally?.outcome}, ${replay.used()} answers against ${run.recorded.length - run.aheadStatements}; ${JSON.stringify(rstep.lines)} against ${JSON.stringify(run.lines)}; ${mismatch}`,
            );
          }
        } else {
          const again = await social.runSocialStep(rstep.jobs, scenario.at);
          if (
            again.ran !== run.result.ran ||
            again.outcome !== run.result.outcome ||
            replay.used() !== run.recorded.length
          ) {
            throw new Error(`the replay of "${scenario.name}" diverged from its recording`);
          }
        }
        if (rch.sent.total !== run.ch.sent.total)
          throw new Error(`the replay of "${scenario.name}" sent other fetches`);
      };
      const t1 = performance.now();
      const c1 = process.cpuUsage();
      await replayOnce('tally');
      const firstCpu = process.cpuUsage(c1);
      const firstWallMs = performance.now() - t1;
      const loop = async (only) => {
        for (let i = 0; i < 20; i += 1) await replayOnce(only);
        const walls = [];
        const c0 = process.cpuUsage();
        for (let i = 0; i < RUNS; i += 1) {
          const t = performance.now();
          await replayOnce(only);
          walls.push(performance.now() - t);
        }
        const used = process.cpuUsage(c0);
        walls.sort((a, b) => a - b);
        return {
          cpuMeanMs: (used.user + used.system) / 1000 / RUNS,
          wallP99Ms: walls[Math.min(walls.length - 1, Math.floor(walls.length * 0.99))],
        };
      };
      const tallyLoop = await loop('tally');
      const stepLoop = await loop('step');
      cpuRows.push({
        scenario: scenario.name,
        kind: scenario.kind,
        step: `${run.result.ran}:${run.result.outcome}`,
        tallyAnswer: run.tally?.outcome ?? null,
        behindRan: run.behindRan,
        aheadStatements: run.aheadStatements,
        aheadDetail: Object.fromEntries(run.ahead.map(([n, v]) => [n, `${v.outcome}/${v.statements}`])),
        statements: run.tally?.statements ?? null,
        chainReads: run.reads,
        fetches: run.ch.sent.total,
        fetchesByHost: run.ch.sent.byHost,
        resultRows: run.resultRows,
        votesLeft: run.votesLeft,
        tallyFirstCpuMs: (firstCpu.user + firstCpu.system) / 1000,
        tallyFirstWallMs: firstWallMs,
        tallyCpuMeanMs: tallyLoop.cpuMeanMs,
        tallyWallP99Ms: tallyLoop.wallP99Ms,
        stepCpuMeanMs: stepLoop.cpuMeanMs,
        stepWallP99Ms: stepLoop.wallP99Ms,
      });
    }

    // Part 3: wall time on the real clock, the fake chain at POLL_TALLY_FETCH_LATENCY_MS with a moving head.
    const cases = [
      { label: 'official 429', official: '429' },
      { label: 'official never answers', official: 'never' },
      { label: 'official correct after 1,400 ms', official: 'slow' },
      { label: 'official 429, publicnode read 2 after 1,400 ms', official: '429', publicnodeSlowCall: 2 },
    ];
    const wallRows = [];
    for (const kind of ['tally', 'prune']) {
      for (const each of cases) {
        const scenario = {
          name: `${kind}, ${each.label}`,
          kind,
          at: kind === 'tally' ? tallyAt : pruneAt,
          voters: VOTERS,
          holds: kind === 'tally' ? HOLDS : 0n,
          official: each.official,
          publicnodeSlowCall: each.publicnodeSlowCall,
          pollsEnabled: true,
          failures: 0,
        };
        console.error(`${new Date().toISOString()} wall: ${scenario.name}`);
        const run = await meteredRun(scenario, B.latencyMs, B.blocksPerSecond);
        const line = run.lines.find(
          (l) => l.event === 'poll_tallied' || l.event === 'poll_pruned' || l.event === 'poll_tally_failed',
        );
        wallRows.push({
          scenario: scenario.name,
          kind,
          tallyAnswer: run.tally?.outcome ?? null,
          event: line?.event ?? null,
          failedStep: line?.step ?? null,
          readMs: line?.readMs ?? null,
          runWallMs: run.tally?.wallMs ?? null,
          statements: run.tally?.statements ?? null,
          chainReads: run.reads,
          fetches: run.ch.sent.total,
          fetchesByHost: run.ch.sent.byHost,
          resultRows: run.resultRows,
          votesLeft: run.votesLeft,
          behindRan: run.behindRan,
        });
      }
    }

    // Part 4: the tail on the real endpoints, from this laptop.
    const tail = [];
    for (const endpoint of rpcUrls.filter((u) => !u.includes('rpc.mainnet.chain.robinhood.com'))) {
      console.error(`${new Date().toISOString()} tail: ${new URL(endpoint).host}`);
      const samples = [];
      const notes = { failed: 0, refused: 0, aborted: 0, headFailed: 0 };
      const page = wallets.slice(0, PAGE);
      const data = wire.encodeTokenCallLean(TOKEN, page);
      for (let i = 0; i < options.tail; i += 1) {
        let head = null;
        try {
          const h = await fetch(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
            signal: AbortSignal.timeout(5_000),
          });
          head = BigInt((await h.json()).result);
        } catch {
          notes.headFailed += 1;
        }
        const tag = head === null ? 'latest' : `0x${(head - BigInt(MARGIN)).toString(16)}`;
        const t = performance.now();
        let ms;
        try {
          const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 2,
              method: 'eth_call',
              params: [{ to: '0xca11bde05977b3631167028862be2a173976ca11', data }, tag],
            }),
            signal: AbortSignal.timeout(B.timeoutMs),
          });
          const body = await response.text();
          ms = performance.now() - t;
          let ok = response.ok;
          if (ok) {
            const parsed = JSON.parse(body);
            if (typeof parsed.result !== 'string') ok = false;
            else wire.decodeTokenResultLean(page, parsed.result);
          }
          if (!ok) {
            notes.refused += 1;
            ms = B.timeoutMs;
          }
        } catch (error) {
          if (error?.name === 'TimeoutError' || error?.name === 'AbortError') notes.aborted += 1;
          else notes.failed += 1;
          ms = B.timeoutMs;
        }
        samples.push(ms);
      }
      const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
      const p95 = nearestRank(samples, 95);
      const max = Math.max(...samples);
      tail.push({
        host: new URL(endpoint).host,
        reads: samples.length,
        meanMs: mean,
        p95Ms: p95,
        maxMs: max,
        holds: tailHolds(p95, max),
        notes,
        samples,
      });
    }

    return report({ alarms, cpuRows, wallRows, tail });
  } finally {
    await worker.dispose();
  }

  function report({ alarms, cpuRows, wallRows, tail }) {
    const fails = [];
    const round = (n) => (typeof n !== 'number' ? n : Number.isInteger(n) ? n : Number(n.toFixed(2)));
    const check = (label, value, bound, cmp = '<=') => {
      const ok =
        value !== null &&
        value !== undefined &&
        (cmp === '<=' ? value <= bound : cmp === '<' ? value < bound : cmp === '>=' ? value >= bound : value === bound);
      if (!ok) fails.push(`${label}: ${round(value)} not ${cmp} ${bound}`);
      return `${ok ? 'ok  ' : 'OUT '} ${label}: ${round(value)} (${cmp} ${bound})`;
    };
    const L = [];
    L.push(
      'Gate 3, docs/contracts/phase-6-holders.md section 12, revision 8f: the poll tally at POLL_MAX_VOTERS voters.',
    );
    L.push(
      `Conditions: Node ${process.version} on ${process.platform}, ${new Date().toISOString()}; ${RUNS} CPU replays after 20 warm-up runs; a shared laptop.`,
    );
    L.push(
      `Endpoints of the fake chain: ${rpcUrls.map((u) => new URL(u).host).join(', ')}; ${VOTERS} voters, pages of ${PAGE}.`,
    );
    L.push('');
    L.push(
      "1. Counts, the built entry's Clock.alarm() for SOCIAL_CRON in local workerd (fake chain at 300 ms, moving head):",
    );
    for (const key of ['tally', 'prune']) {
      const a = alarms[key];
      const sum = a.statements + a.fetches + a.doCalls;
      const social = a.lines.find((l) => l.event === 'social_step');
      L.push(
        `  ${a.name}: social_step ${social?.job}:${social?.outcome}; thrown ${a.thrown}; result rows ${a.resultRows}; votes left ${a.votesLeft}; wall ${round(a.wallMs)} ms`,
      );
      L.push(
        `    statements ${a.statements} (D1 calls ${a.d1Calls}), fetches ${a.fetches} ${JSON.stringify(a.fetchesByHost)}, DO calls ${a.doCalls}, other fetches ${a.otherFetches}`,
      );
      L.push(`    ${check(`${key}: fetches of the invocation`, a.fetches, B.fetches)}`);
      L.push(`    ${check(`${key}: Durable Object calls of the invocation`, a.doCalls, B.doCalls, '===')}`);
      L.push(
        `    ${check(`${key}: one sum (statements + DO calls + fetches) against the booking`, sum, key === 'tally' ? B.tallySum : B.pruneSum)}`,
      );
      L.push(`    ${check(`${key}: one sum against the step's subrequests`, sum, B.stepSubrequests)}`);
      if (social?.job !== 'poll_tally' || social?.outcome !== 'done') {
        fails.push(`${a.name}: the step answered ${social?.job}:${social?.outcome}, not poll_tally:done`);
        L.push('    OUT  the step did not end with poll_tally:done');
      }
      if (a.thrown !== null || a.otherFetches !== 0)
        fails.push(`${a.name}: thrown ${a.thrown}, other fetches ${a.otherFetches}`);
    }
    {
      const on = alarms.waitingOn;
      const off = alarms.waitingOff;
      const diff = on.statements - off.statements;
      const total = on.statements + on.fetches + on.doCalls;
      const social = on.lines.find((l) => l.event === 'social_step');
      L.push(
        `  waiting run (F3): POLL_TALLY_JOB on ${on.statements} statements, ${on.fetches} fetches, ${on.doCalls} DO calls, step ${social?.job}:${social?.outcome}, result rows ${on.resultRows}; off ${off.statements} statements`,
      );
      L.push(`    ${check("waiting: poll_tally's statements (on less off)", diff, B.waitingStatements)}`);
      L.push(`    ${check('waiting: chain fetches', on.fetches, 0, '===')}`);
      L.push(
        `    ${check('waiting: the invocation (sweep idle, lounge off) against the sweep-behind booking', total, B.waitingSweepSum)}`,
      );
      if (on.resultRows !== 0) fails.push('waiting: a result was written while POLLS_ENABLED is "false"');
      // room_prune, last in the step, sends this statement (as tests/holders/poll-entry.d1.test.ts reads it).
      const pruneRan = on.sql.some((s) => s.includes('DELETE FROM room_picture_reports'));
      L.push(`    ${check('waiting: room_prune ran behind poll_tally in the same invocation', pruneRan, true, '===')}`);
      L.push(`    log lines: ${on.lines.map((l) => l.event ?? l.text).join(', ')}`);
    }
    L.push('');
    L.push(
      '2. CPU, an ESTIMATE: the Node replay of the social step (D1 answers recorded on local D1, chain at zero latency):',
    );
    for (const r of cpuRows) {
      L.push(
        `  ${r.scenario}: step ${r.step}; poll_tally ${r.tallyAnswer}; behind ran ${r.behindRan}; ahead ${JSON.stringify(r.aheadDetail)}`,
      );
      L.push(
        `    statements ${r.statements}, chain reads ${r.chainReads}, fetches ${r.fetches} ${JSON.stringify(r.fetchesByHost)}, result rows ${r.resultRows}, votes left ${r.votesLeft}`,
      );
      L.push(
        `    first replay of poll_tally: CPU ${round(r.tallyFirstCpuMs)} ms, wall ${round(r.tallyFirstWallMs)} ms (a warm process, not a cold isolate)`,
      );
      L.push(`    ${check(`${r.kind}: CPU of the poll_tally run, mean (ms)`, r.tallyCpuMeanMs, B.runCpuMs)}`);
      L.push(`    ${check(`${r.kind}: CPU of the first poll_tally replay (ms)`, r.tallyFirstCpuMs, B.runCpuMs)}`);
      L.push(`    ${check(`${r.kind}: CPU of the whole step, mean (ms)`, r.stepCpuMeanMs, B.stepCpuMs)}`);
      L.push(`    wall p99 in replay: poll_tally ${round(r.tallyWallP99Ms)} ms, step ${round(r.stepWallP99Ms)} ms`);
      if (r.kind === 'tally') L.push(`    ${check('tally: statements', r.statements, B.tallyStatements)}`);
      if (r.kind === 'prune') L.push(`    ${check('prune: statements', r.statements, B.pruneStatements)}`);
      if (r.kind === 'waiting') {
        L.push(`    ${check('waiting: statements', r.statements, B.waitingStatements)}`);
        if (r.tallyAnswer !== 'idle' || !r.behindRan)
          fails.push(`${r.scenario}: poll_tally ${r.tallyAnswer}, behind ran ${r.behindRan}`);
      } else {
        L.push(`    ${check(`${r.kind}: chain reads`, r.chainReads, B.chainReads)}`);
        if (r.tallyAnswer !== 'done' || r.behindRan)
          fails.push(`${r.scenario}: poll_tally ${r.tallyAnswer}, behind ran ${r.behindRan}`);
      }
    }
    L.push('');
    L.push(
      `3. Wall time on the real clock, ${B.latencyMs} ms a fetch, head ${B.blocksPerSecond} blocks/s, publicnode 403 past ${B.keylessStateBlocks} blocks:`,
    );
    for (const r of wallRows) {
      L.push(
        `  ${r.scenario}: poll_tally ${r.tallyAnswer}, ${r.event}${r.failedStep ? ` at ${r.failedStep}` : ''}, readMs ${r.readMs}; reads ${r.chainReads}, fetches ${r.fetches} ${JSON.stringify(r.fetchesByHost)}; result rows ${r.resultRows}, votes left ${r.votesLeft}`,
      );
      L.push(`    ${check(`${r.scenario}: run wall (ms)`, r.runWallMs, B.runSeconds * 1000)}`);
      L.push(`    ${check(`${r.scenario}: readMs`, r.readMs, B.runSeconds * 1000)}`);
      L.push(`    ${check(`${r.scenario}: fetches`, r.fetches, B.fetches)}`);
      // A result is one row a poll option; a prune of voters below tier 1 deletes every row.
      const ok =
        r.kind === 'tally'
          ? r.event === 'poll_tallied' && r.resultRows === POLL.options.length
          : r.event === 'poll_pruned' && r.votesLeft === 0;
      if (!ok) {
        fails.push(
          `${r.scenario}: not ${r.kind === 'tally' ? 'tallied' : 'pruned'} (${r.event}${r.failedStep ? ` at ${r.failedStep}` : ''})`,
        );
        L.push(`    OUT  not ${r.kind === 'tally' ? 'tallied' : 'pruned'}`);
      }
    }
    L.push('');
    L.push(
      `4. The tail of one full page (${PAGE} wallets) at head - ${MARGIN}, real endpoints, from this laptop (not a Worker):`,
    );
    for (const t of tail) {
      L.push(
        `  ${t.host}: ${t.reads} reads, mean ${round(t.meanMs)} ms, p95 (nearest rank) ${round(t.p95Ms)} ms, largest ${round(t.maxMs)} ms; ${JSON.stringify(t.notes)}`,
      );
      L.push(`    ${check(`${t.host}: reads`, t.reads, B.tailReadsMin, '>=')}`);
      L.push(`    ${check(`${t.host}: p95 (ms)`, t.p95Ms, B.tailP95Ms)}`);
      L.push(`    ${check(`${t.host}: largest (ms)`, t.maxMs, B.timeoutMs, '<')}`);
    }
    L.push('');
    L.push(
      fails.length === 0
        ? 'GATE 3 PASS: every figure inside its bound'
        : `GATE 3 FAIL: ${fails.length} figure(s) outside:`,
    );
    for (const f of fails) L.push(`  ${f}`);
    console.log(L.join('\n'));
    const methods = {
      counts:
        "the built entry's Clock.alarm() for SOCIAL_CRON in local workerd (tools/perf/polls-tally-worker), every D1 statement, fetch and CLOCK call of the invocation counted",
      cpu: 'process.cpuUsage around a Node replay of the social step (D1 answers recorded on the local D1, the fake chain at zero latency): an estimate for a Worker',
      wall: 'the same jobs on the local D1 with the fake chain at POLL_TALLY_FETCH_LATENCY_MS on the real clock, the head moving',
      tail: 'real publicnode and dRPC endpoints from this laptop, a lean 400-wallet tryBlockAndAggregate at head - POLL_TALLY_BLOCK_MARGIN',
    };
    const strip = (a) => ({ ...a, lines: a.lines.map((l) => l.event ?? l.text) });
    return writeArtifact(
      `polls-tally-${new Date().toISOString().slice(0, 10)}.json`,
      `${JSON.stringify({ at: new Date().toISOString(), contract: 'revision 8f', runs: RUNS, methods, bounds: B, alarms: Object.fromEntries(Object.entries(alarms).map(([k, v]) => [k, strip(v)])), cpuRows, wallRows, tail, fails }, null, 2)}\n`,
    ).then((file) => {
      console.log(`\nWritten: ${file}`);
      return fails.length === 0 ? 0 : 1;
    });
  }
}
