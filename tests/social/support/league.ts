import type {
  AgentRecord,
  DecisionRow,
  Division,
  PriceMap,
  ReputationJob,
  ReputationJobDeps,
  WalletActivityPort,
} from '@prix/contracts';
import { openPreviewEntitlements } from '@prix/contracts';
import { scoring } from '@prix/reputation';
import { chainRecord } from '@prix/reputation/chain-record';
import { scoringV2 } from '@prix/reputation/v2';
import { createDayPricesJob, createSeasonScoreJob } from '@prix/runtime/reputation/season-jobs';
import { sim } from '@prix/sim';
import {
  HOUSE_LABEL,
  makeAgent,
  makeSnapshot,
  makeTick,
  SEASON_1,
  startingPortfolio,
  startingStats,
  TEST_PRICES,
  utc,
} from '../../support/fixtures.ts';
import { createRng } from '../../support/prng.ts';
import type { Stores } from './d1.ts';

/**
 * A small league driven through the real stores and the real Phase 2 jobs, for the Phase 6 tests that
 * need ranks, day prices and official scores that were made the way production makes them. Each
 * simulated day has ticks at 15:00 and 17:00 (hourly, Pro agents only) and a daily tick at 19:00
 * (every agent); every agent decides with a deterministic book; the tick completes; the league ranks;
 * at 20:30 the day's prices are stored and the day is scored.
 */

/** Day 0 is Tuesday 2026-10-06, the day after the season starts. */
export const FIRST_DAY = '2026-10-06';
export const dayAt = (i: number): string =>
  new Date(Date.parse(`${FIRST_DAY}T00:00:00.000Z`) + i * 86_400_000).toISOString().slice(0, 10);
export const tickAt = (i: number, hour = 19): string => `${dayAt(i)}T${String(hour).padStart(2, '0')}:00Z`;

const SYMBOLS = Object.keys(TEST_PRICES);

/** Prices for 90 days: a random walk from the test prices, the same on every run. */
export function pricePath(days = 90): PriceMap[] {
  const rng = createRng(2026);
  const current: Record<string, number> = { ...TEST_PRICES };
  const out: PriceMap[] = [];
  for (let d = 0; d < days; d++) {
    for (const symbol of SYMBOLS) {
      const move = rng.int(-250, 250);
      current[symbol] = Math.max(1_000_000, Math.round((current[symbol] as number) * (1 + move / 10_000)));
    }
    out.push({ ...current });
  }
  return out;
}

const walletStub: WalletActivityPort = {
  headBlock: async () => null,
  readTransfers: async () => {
    throw new Error('the wallet reader is not used by the Phase 6 tests');
  },
  blockTimes: async () => null,
};

export interface LeagueOptions {
  /** Open agents, numbered from `firstNumber`. */
  agents: number;
  /** Pro agents, numbered from 200. They decide at every tick of the day. */
  pros?: number;
  firstNumber?: number;
  /** The chance per day that an agent changes its book. */
  activity?: number;
  seed?: number;
}

export interface TickOptions {
  /** Agents that are not asked at this tick. */
  skip?: ReadonlySet<string>;
  daily?: boolean;
}

export class League {
  readonly agents: AgentRecord[] = [];
  readonly prices = pricePath();
  private readonly activity: number;
  private readonly seed: number;
  private readonly dayPrices: ReputationJob;
  private readonly scoreJob: ReputationJob;
  private clock = new Date();
  /** Targets each agent held last, so a quiet day keeps them. */
  private readonly targets = new Map<string, Record<string, number>>();

  constructor(
    readonly stores: Stores,
    private readonly options: LeagueOptions,
  ) {
    this.activity = options.activity ?? 0.5;
    this.seed = options.seed ?? 1;
    const deps = {
      store: stores.store,
      reputation: stores.reputation,
      sim,
      scoring,
      scoringV2,
      chainRecord,
      wallet: walletStub,
      entitlements: openPreviewEntitlements,
      now: () => new Date(this.clock.getTime()),
    } as unknown as ReputationJobDeps;
    this.dayPrices = createDayPricesJob(deps);
    this.scoreJob = createSeasonScoreJob(deps);
  }

  get open(): AgentRecord[] {
    return this.agents.filter((agent) => agent.division === 'open');
  }

  get pro(): AgentRecord[] {
    return this.agents.filter((agent) => agent.division === 'pro');
  }

  async addAgents(): Promise<void> {
    const first = this.options.firstNumber ?? 1;
    const made: AgentRecord[] = [];
    for (let k = 0; k < this.options.agents; k++) made.push(makeAgent({ n: first + k }));
    for (let k = 0; k < (this.options.pros ?? 0); k++) {
      made.push(makeAgent({ n: 200 + k, division: 'pro', modelKeyId: 'keyaaaaaaaaa' }));
    }
    for (const agent of made) {
      const created = await this.stores.store.createAgent(
        agent,
        SEASON_1.id,
        startingPortfolio(),
        startingStats(),
        500,
        500,
      );
      if (created !== 'created') throw new Error(`League: ${created}`);
      this.agents.push(agent);
    }
  }

  private targetsFor(agent: AgentRecord, index: number, day: number, hour: number): Record<string, number> {
    const rng = createRng(this.seed * 1_000_003 + index * 7919 + day * 104_729 + hour * 31);
    const held = this.targets.get(agent.id);
    if (held !== undefined && !rng.chance(this.activity)) return held;
    const count = rng.int(1, 3);
    const chosen = rng.shuffle(SYMBOLS).slice(0, count);
    const targets: Record<string, number> = {};
    for (const symbol of chosen) targets[symbol] = rng.int(1000, 3300);
    this.targets.set(agent.id, targets);
    return targets;
  }

  /** One tick of day `i` at `hour`: every agent of the tick decides, the tick completes, the league ranks. */
  async playTick(i: number, hour = 19, options: TickOptions = {}): Promise<string> {
    const { store } = this.stores;
    const daily = options.daily ?? hour === 19;
    const at = utc(`${dayAt(i)}T${String(hour).padStart(2, '0')}:00:00.000Z`);
    const prices = this.prices[i] as PriceMap;
    const tick = makeTick(at, { daily, status: 'processing', snapshot: makeSnapshot(at, { prices }) });
    if (!(await store.createTick(tick))) throw new Error(`League: tick ${tick.id} exists`);
    for (const [index, agent] of this.agents.entries()) {
      if (options.skip?.has(agent.id)) continue;
      if (agent.division === 'open' && !daily) continue;
      const record = await store.getPortfolio(agent.id, SEASON_1.id);
      if (record === null) throw new Error('League: no portfolio');
      const targetsBps = this.targetsFor(agent, index, i, hour);
      const result = sim.rebalance({ portfolio: record.portfolio, prices, targetsBps, halted: [] });
      const stats = scoring.updateStats(record.stats, {
        day: dayAt(i),
        status: 'decided',
        equityMicro: result.equityAfterMicro,
        fillCount: result.fills.length,
      });
      const row: DecisionRow = {
        agentId: agent.id,
        tickId: tick.id,
        seasonId: SEASON_1.id,
        division: agent.division,
        status: 'decided',
        code: null,
        targetsBps,
        reason: 'Keeps the book as the strategy says.',
        fills: result.fills,
        halted: [],
        portfolio: result.portfolio,
        equityMicro: result.equityAfterMicro,
        costMicro: result.costMicro,
        model: HOUSE_LABEL,
        strategyAt: agent.strategyChangedAt,
        createdAt: `${dayAt(i)}T${String(hour).padStart(2, '0')}:00:${String(10 + (index % 40)).padStart(2, '0')}.000Z`,
      };
      if (!(await store.writeDecision(row, stats, 0))) throw new Error('League: the row was refused');
    }
    await store.completeTick(tick.id, `${dayAt(i)}T${String(hour).padStart(2, '0')}:04:00.000Z`);
    for (const division of ['open', 'pro'] as Division[]) {
      await store.rerank(
        SEASON_1.id,
        division,
        tick.id,
        `${dayAt(i)}T${String(hour).padStart(2, '0')}:05:00.000Z`,
        'v1',
      );
    }
    return tick.id;
  }

  /** At 20:30 the day's prices are stored, and the day is scored until the job has nothing left. */
  async closeDay(i: number, options: { score?: boolean } = {}): Promise<void> {
    this.clock = new Date(`${dayAt(i)}T20:30:00.000Z`);
    await this.dayPrices.run(this.clock);
    if (options.score === false) return;
    for (let guard = 0; guard < 30; guard++) {
      const outcome = await this.scoreJob.run(this.clock);
      if (outcome === 'idle') break;
    }
  }

  /** The ticks of one day (the hourly ones only when there are Pro agents), then the close of the day. */
  async playDay(i: number, options: { skip?: Partial<Record<number, ReadonlySet<string>>> } = {}): Promise<void> {
    if (this.pro.length > 0) {
      for (const hour of [15, 17]) await this.playTick(i, hour, { skip: options.skip?.[hour], daily: false });
    }
    await this.playTick(i, 19, { skip: options.skip?.[19] });
    await this.closeDay(i);
  }
}
