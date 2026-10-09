import type {
  AgentRecord,
  AgentStats,
  DecisionRow,
  ModelRequest,
  ModelResponse,
  PortfolioState,
  PriceMap,
  SchedulerDeps,
  SchedulerLimits,
  SchedulerReport,
  Tick,
} from '@prix/contracts';
import {
  FEED_STALE_AFTER_SECONDS,
  HOUSE_MAX_OUTPUT_TOKENS,
  HOUSE_NEURONS_PER_DAY,
  HOUSE_SUMMARY_NEURONS_PER_DAY,
  MAX_AGENTS_OPEN,
  MAX_AGENTS_PRO,
  MAX_MODEL_KEYS_PER_WALLET,
  modelKeyAad,
  OWN_MAX_OUTPUT_TOKENS,
  tickIdSchema,
  utcDayOfTick,
} from '@prix/contracts';
import { scoring } from '@prix/reputation';
import { runSchedulerStep } from '@prix/runtime';
import { sim } from '@prix/sim';
import { expect } from 'vitest';
import {
  createLog,
  createTestVault,
  decisionJson,
  FakeMarket,
  FakeModel,
  FakeOwnModels,
  modelText,
  strategyOf,
} from './fakes.ts';
import type { SnapshotOptions } from './fixtures.ts';
import {
  makeAgent,
  makeSnapshot,
  SEASON_1,
  startingPortfolio,
  startingStats,
  TEST_PRICES,
  testAddress,
  testId,
  utc,
} from './fixtures.ts';
import type { MemoryStore } from './memory-store.ts';
import { createMemoryStore } from './memory-store.ts';

/**
 * A whole scheduler world in memory: the store, a scripted market, a house model and owner
 * models that answer per agent, real sealed keys, and the real simulation and scoring
 * engines. `runSchedulerStep` from `packages/runtime` is the only thing under test.
 */

/** The limits the Worker entry point sets, from docs/CONTRACTS.md section 2. */
export const LIMITS: SchedulerLimits = Object.freeze({
  maxDecisionsPerStep: 5,
  maxSkipsPerStep: 10,
  maxSummariesPerStep: 2,
  houseNeuronsPerDay: HOUSE_NEURONS_PER_DAY,
  houseNeuronsPerMillionInputTokens: 26_668,
  houseNeuronsPerMillionOutputTokens: 204_805,
  summaryNeuronsPerDay: HOUSE_SUMMARY_NEURONS_PER_DAY,
  modelTimeoutMs: 20_000,
  maxOutputTokens: HOUSE_MAX_OUTPUT_TOKENS,
  ownMaxOutputTokens: OWN_MAX_OUTPUT_TOKENS,
  feedStaleAfterSeconds: FEED_STALE_AFTER_SECONDS,
});

export const DEFAULT_TARGETS = { NVDA: 20, MSFT: 20 };
export const DEFAULT_REASON = 'Holds two large companies in equal parts.';
export const DEFAULT_SUMMARY = 'Holds a few large companies and changes the portfolio rarely.';
/** A fixture key per Pro agent. It opens nothing. */
export const proApiKey = (n: number): string => `fixture-own-key-${String(n).padStart(4, '0')}-Qw8Er2Ty6Ui0`;

export type Answer =
  | string
  | ModelResponse
  | ((request: ModelRequest) => string | ModelResponse | Promise<string | ModelResponse>);

export interface World {
  store: MemoryStore;
  market: FakeMarket;
  house: FakeModel;
  own: FakeOwnModels;
  vault: ReturnType<typeof createTestVault>;
  log: ReturnType<typeof createLog>;
  limits: SchedulerLimits;
  deps: SchedulerDeps;
  /** What the feeds report now. A test changes it to move prices. */
  feed: { prices: PriceMap; options: SnapshotOptions };
  /** How an agent's model answers, by the agent's number. Without an entry it gives a valid decision. */
  answers: Map<number, Answer>;
  /** How the house model answers a summary request. */
  summaryAnswer: Answer;
  /** The most model calls in flight at one moment, and the most made or database calls in one step. */
  peak: { concurrentModelCalls: number; modelCallsInStep: number; storeCallsInStep: number };
  reports: { at: string; report: SchedulerReport }[];
  /** Decision requests the models received, in order, with the number of the agent asked. */
  decisionCalls: { n: number; division: 'open' | 'pro'; request: ModelRequest }[];
  summaryCalls: ModelRequest[];
  step(iso: string): Promise<SchedulerReport>;
  /** One step per minute from `fromIso` up to and including `toIso`. */
  run(fromIso: string, toIso: string): Promise<SchedulerReport[]>;
  /** Steps every minute from `fromIso` until the tick of that hour is complete. Fails after 59 minutes. */
  runTick(fromIso: string): Promise<Tick>;
  addOpen(n: number, options?: AddOptions): Promise<AgentRecord>;
  addPro(n: number, options?: AddOptions): Promise<AgentRecord>;
  rows(agent: AgentRecord): Promise<DecisionRow[]>;
  row(agent: AgentRecord, tickId: string): DecisionRow;
  stats(agent: AgentRecord): Promise<AgentStats>;
  portfolio(agent: AgentRecord): Promise<PortfolioState>;
}

export interface AddOptions {
  portfolio?: PortfolioState;
  stats?: AgentStats;
  overrides?: Partial<AgentRecord>;
  createdAt?: string;
}

/** The number of the fixture agent whose prompt is in the request, from the marker in the prompt. */
export function agentNumber(request: ModelRequest): number | null {
  const match = /marker-(\d+)-end/.exec(request.messages.map((message) => message.content).join('\n'));
  return match ? Number(match[1]) : null;
}

/** A decision call asks for the decision JSON, or carries the JSON document of section 6. */
function isDecisionCall(request: ModelRequest): boolean {
  if (request.jsonDecision) return true;
  const user = request.messages.find((message) => message.role === 'user');
  try {
    const parsed = JSON.parse(user?.content ?? '') as Record<string, unknown>;
    return typeof parsed === 'object' && parsed !== null && 'prices' in parsed && strategyOf(request) !== '';
  } catch {
    return false;
  }
}

export function createWorld(
  options: { limits?: Partial<SchedulerLimits>; store?: MemoryStore; vault?: ReturnType<typeof createTestVault> } = {},
): World {
  const store = options.store ?? createMemoryStore([SEASON_1]);
  const vault = options.vault ?? createTestVault();
  const log = createLog();
  const limits: SchedulerLimits = { ...LIMITS, ...options.limits };
  const feed: World['feed'] = { prices: { ...TEST_PRICES }, options: {} };
  const market = new FakeMarket((now) => makeSnapshot(now, { ...feed.options, prices: feed.prices }));
  const answers = new Map<number, Answer>();
  const peak = { concurrentModelCalls: 0, modelCallsInStep: 0, storeCallsInStep: 0 };
  const decisionCalls: World['decisionCalls'] = [];
  const summaryCalls: ModelRequest[] = [];
  let inFlight = 0;
  let callsThisStep = 0;

  const resolve = async (answer: Answer, request: ModelRequest): Promise<ModelResponse> => {
    const value = typeof answer === 'function' ? await answer(request) : answer;
    return typeof value === 'string' ? modelText(value) : value;
  };

  const respond =
    (division: 'open' | 'pro') =>
    async (request: ModelRequest): Promise<ModelResponse> => {
      inFlight += 1;
      callsThisStep += 1;
      peak.concurrentModelCalls = Math.max(peak.concurrentModelCalls, inFlight);
      try {
        // Give the other calls of the step a chance to start, as a real network call does.
        await new Promise((done) => setTimeout(done, 0));
        const n = agentNumber(request);
        if (n === null || !isDecisionCall(request)) {
          summaryCalls.push(request);
          return await resolve(world.summaryAnswer, request);
        }
        decisionCalls.push({ n, division, request });
        return await resolve(answers.get(n) ?? decisionJson(DEFAULT_TARGETS, DEFAULT_REASON), request);
      } finally {
        inFlight -= 1;
      }
    };

  const house = new FakeModel('house', respond('open'));
  const own = new FakeOwnModels(respond('pro'));

  const deps: SchedulerDeps = {
    store,
    market,
    sim,
    scoring,
    houseModel: house,
    ownModel: own.factory,
    keys: vault.opener,
    limits,
    log: log.log,
  };

  const add = async (agent: AgentRecord, addOptions: AddOptions): Promise<AgentRecord> => {
    const created = await store.createAgent(
      agent,
      SEASON_1.id,
      addOptions.portfolio ?? startingPortfolio(),
      addOptions.stats ?? startingStats(),
      agent.division === 'pro' ? MAX_AGENTS_PRO : MAX_AGENTS_OPEN,
    );
    if (created !== 'created') throw new Error(`createWorld: agent ${agent.id} was not created: ${created}`);
    return agent;
  };

  const world: World = {
    store,
    market,
    house,
    own,
    vault,
    log,
    limits,
    deps,
    feed,
    answers,
    summaryAnswer: DEFAULT_SUMMARY,
    peak,
    reports: [],
    decisionCalls,
    summaryCalls,

    async step(iso) {
      store.resetCalls();
      callsThisStep = 0;
      let report: SchedulerReport;
      try {
        report = await runSchedulerStep(deps, utc(iso));
      } catch (error) {
        throw new Error(`runSchedulerStep threw at ${iso}, and a step must never throw: ${(error as Error).message}`);
      }
      peak.storeCallsInStep = Math.max(peak.storeCallsInStep, store.callCount());
      peak.modelCallsInStep = Math.max(peak.modelCallsInStep, callsThisStep);
      expectReport(report);
      world.reports.push({ at: iso, report });
      return report;
    },

    async run(fromIso, toIso) {
      const reports: SchedulerReport[] = [];
      const end = utc(toIso).getTime();
      for (let at = utc(fromIso).getTime(); at <= end; at += 60_000) {
        reports.push(await world.step(new Date(at).toISOString()));
      }
      return reports;
    },

    async runTick(fromIso) {
      const start = utc(fromIso);
      const tickId = `${fromIso.slice(0, 13)}:00Z`;
      for (let minute = 0; minute < 59 - start.getUTCMinutes(); minute += 1) {
        await world.step(new Date(start.getTime() + minute * 60_000).toISOString());
        const tick = await store.getTick(tickId);
        if (tick?.status === 'complete') return tick;
        if (!tick && minute === 0) break;
      }
      const tick = await store.getTick(tickId);
      throw new Error(
        tick
          ? `the tick ${tickId} was not complete at the end of its hour`
          : `no tick ${tickId} was created at ${fromIso}`,
      );
    },

    addOpen(n, addOptions = {}) {
      return add(
        makeAgent({ n, division: 'open', createdAt: addOptions.createdAt, overrides: addOptions.overrides }),
        addOptions,
      );
    },

    async addPro(n, addOptions = {}) {
      const owner = testAddress(1000 + n);
      const id = testId('key', n);
      const aad = modelKeyAad({ id, owner, provider: 'openai', keyVersion: vault.sealer.keyVersion });
      const sealed = await vault.sealer.seal(proApiKey(n), aad);
      await store.putModelKey(
        {
          id,
          owner,
          provider: 'openai',
          model: `model-${n}`,
          last4: proApiKey(n).slice(-4),
          ...sealed,
          createdAt: '2026-10-05T07:00:00.000Z',
        },
        MAX_MODEL_KEYS_PER_WALLET,
      );
      return add(
        makeAgent({
          n,
          division: 'pro',
          owner,
          modelKeyId: id,
          createdAt: addOptions.createdAt,
          overrides: addOptions.overrides,
        }),
        addOptions,
      );
    },

    async rows(agent) {
      return (await store.listDecisions(agent.id, SEASON_1.id, 10_000)).reverse();
    },

    row(agent, tickId) {
      const found = store.decisions.get(`${agent.id}|${tickId}`);
      if (!found) throw new Error(`agent ${agent.name} has no row at ${tickId}`);
      return structuredClone(found);
    },

    async stats(agent) {
      const record = await store.getPortfolio(agent.id, SEASON_1.id);
      if (!record) throw new Error('no portfolio');
      return record.stats;
    },

    async portfolio(agent) {
      const record = await store.getPortfolio(agent.id, SEASON_1.id);
      if (!record) throw new Error('no portfolio');
      return record.portfolio;
    },
  };
  return world;
}

/** A report has the shape of the contract, whatever the step did. */
export function expectReport(report: SchedulerReport): void {
  expect(['idle', 'market_closed', 'tick_created', 'batch', 'tick_completed']).toContain(report.action);
  if (report.tickId !== null) expect(tickIdSchema.safeParse(report.tickId).success).toBe(true);
  for (const count of [report.decided, report.noDecision, report.skipped, report.pending, report.summaries]) {
    expect(Number.isInteger(count) && count >= 0).toBe(true);
  }
}

/**
 * Replays the stored rows of an agent from the starting portfolio and the starting stats,
 * with the stored targets and the prices of each tick, and checks that every row and the
 * final record come out the same. This is the property the record of an agent rests on.
 */
export async function expectReplayMatches(
  world: World,
  agent: AgentRecord,
  start?: { portfolio: PortfolioState; stats: AgentStats },
): Promise<void> {
  let portfolio = start?.portfolio ?? startingPortfolio();
  let stats = start?.stats ?? startingStats();
  for (const row of await world.rows(agent)) {
    const tick = await world.store.getTick(row.tickId);
    if (!tick) throw new Error(`row at ${row.tickId} has no tick`);
    const prices = Object.fromEntries(tick.snapshot.prices.map((point) => [point.symbol, point.priceMicro]));
    const halted = tick.snapshot.prices.filter((point) => !point.fresh).map((point) => point.symbol);
    expect([...row.halted].sort(), `halted symbols at ${row.tickId}`).toEqual([...halted].sort());

    if (row.status === 'decided') {
      expect(row.targetsBps, `targets at ${row.tickId}`).not.toBeNull();
      const result = sim.rebalance({ portfolio, prices, targetsBps: row.targetsBps ?? {}, halted });
      expect(row.portfolio, `portfolio at ${row.tickId}`).toEqual(result.portfolio);
      expect(row.fills, `fills at ${row.tickId}`).toEqual(result.fills);
      expect(row.equityMicro, `equity at ${row.tickId}`).toBe(result.equityAfterMicro);
      expect(row.costMicro, `cost at ${row.tickId}`).toBe(result.costMicro);
      portfolio = result.portfolio;
    } else {
      expect(row.portfolio, `portfolio at ${row.tickId}`).toEqual(portfolio);
      expect(row.fills).toEqual([]);
      expect(row.costMicro).toBe(0);
      expect(row.targetsBps).toBeNull();
      expect(row.reason).toBeNull();
      expect(row.equityMicro, `equity at ${row.tickId}`).toBe(sim.valuePortfolio(portfolio, prices));
    }
    stats = scoring.updateStats(stats, {
      day: utcDayOfTick(row.tickId),
      status: row.status,
      equityMicro: row.equityMicro,
      fillCount: row.fills.length,
    });
  }
  expect(await world.portfolio(agent), `stored portfolio of ${agent.name}`).toEqual(portfolio);
  expect(await world.stats(agent), `stored stats of ${agent.name}`).toEqual(stats);
}
