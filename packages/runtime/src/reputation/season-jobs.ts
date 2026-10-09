import type {
  Division,
  JobOutcome,
  ReputationJob,
  ReputationJobDeps,
  ReputationJobName,
  ScoreSource,
  SeasonScoreRow,
  UtcDay,
} from '@prix/contracts';
import {
  FREEZE_AFTER_SEASON_HOURS,
  FREEZE_CHUNK_ROWS,
  newId,
  ROLLOVER_CHUNK_AGENTS,
  ROLLOVER_LEAD_HOURS,
  SCORE_CHUNK_AGENTS,
  SCORE_CHUNK_LISTINGS,
  SCORING_METHOD,
  SEASON_LENGTH_DAYS_V2,
  STARTING_CASH_MICRO,
} from '@prix/contracts';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** A v2 season whose last day was never scored is frozen anyway this long after its end. */
const FREEZE_GIVE_UP_HOURS = 48;
const DIVISIONS = ['open', 'pro', 'chain'] as const;
/** The divisions with a league table of portfolios: the ones `rerank` publishes. */
const PAPER_DIVISIONS = ['open', 'pro'] as const satisfies readonly Division[];
/** The hour (UTC) after which the day's prices are final. */
const DAY_PRICES_HOUR_UTC = 20;
/** A chain day counts as exposed only above this start-of-day value (100 USD, micro-USD). */
const MIN_EXPOSED_START_MICRO = 100_000_000;

/**
 * A job never throws: a failure is logged with its job name only (no message, no data) and counts as
 * `more`, so the step ends and the job runs again at the next trigger.
 */
export async function guardJob(name: ReputationJobName, fn: () => Promise<JobOutcome>): Promise<JobOutcome> {
  try {
    return await fn();
  } catch {
    console.warn(JSON.stringify({ event: 'reputation_job_failed', job: name }));
    return 'more';
  }
}

function parseState<T extends object>(body: string | null): Partial<T> {
  if (body === null) return {};
  try {
    const value: unknown = JSON.parse(body);
    return typeof value === 'object' && value !== null ? (value as Partial<T>) : {};
  } catch {
    return {};
  }
}

const dayOf = (iso: string): UtcDay => iso.slice(0, 10);
const lastDayOfSeason = (endsAt: string): UtcDay => new Date(Date.parse(endsAt) - 1).toISOString().slice(0, 10);

/**
 * Publishes the official rank of a division (docs/CONTRACTS.md section 18.1): in a v2 season `rerank`
 * copies the ranks just written by `rankScores` into `portfolios.rank`. A division that has never been
 * ranked has no league state and no tick to name, so it is left alone.
 */
async function publishOfficialRank(
  store: ReputationJobDeps['store'],
  seasonId: string,
  division: Division,
  iso: string,
): Promise<void> {
  const state = await store.getLeagueState(seasonId, division);
  if (state === null) return;
  await store.rerank(seasonId, division, state.tickId, iso, SCORING_METHOD);
}

// --- season_lifecycle ------------------------------------------------------------------------------

interface RolloverState {
  /** early: copying before the end. early_done: copied once. final: copying agents made in between. final_done. */
  phase: 'early' | 'early_done' | 'final' | 'final_done';
  after: string | null;
}

export function createSeasonLifecycleJob(deps: ReputationJobDeps): ReputationJob {
  const { store, reputation, sim, scoring } = deps;
  const name = 'season_lifecycle';

  async function chunk(seasonId: string, st: Partial<RolloverState>, early: boolean, now: Date): Promise<JobOutcome> {
    const key = `rollover:${seasonId}`;
    const active = early ? st.phase === 'early' : st.phase === 'final';
    const res = await reputation.rolloverAgents({
      toSeasonId: seasonId,
      portfolio: sim.newPortfolio(),
      stats: scoring.initialStats(),
      afterAgentId: active ? (st.after ?? null) : null,
      limit: ROLLOVER_CHUNK_AGENTS,
      now: now.toISOString(),
    });
    const finished = res.examined < ROLLOVER_CHUNK_AGENTS;
    const next: RolloverState = finished
      ? { phase: early ? 'early_done' : 'final_done', after: null }
      : { phase: early ? 'early' : 'final', after: res.lastAgentId };
    await reputation.putJobState(key, JSON.stringify(next), now.toISOString());
    return finished ? 'done' : 'more';
  }

  return {
    name,
    run: (now) =>
      guardJob(name, async () => {
        const iso = now.toISOString();
        const cur = await store.getActiveSeason(iso);
        if (cur === null) return 'idle';
        const nowMs = now.getTime();
        if (nowMs >= Date.parse(cur.endsAt) - ROLLOVER_LEAD_HOURS * HOUR_MS) {
          const seasons = await store.listSeasons();
          let next = seasons.find((s) => s.number === cur.number + 1) ?? null;
          let created = false;
          if (next === null) {
            const candidate = {
              id: newId(),
              number: cur.number + 1,
              startsAt: cur.endsAt,
              endsAt: new Date(Date.parse(cur.endsAt) + SEASON_LENGTH_DAYS_V2 * DAY_MS).toISOString(),
            };
            if (!(await reputation.putSeason(candidate, 'v2', SEASON_LENGTH_DAYS_V2))) return 'more';
            next = candidate;
            created = true;
          }
          const st = parseState<RolloverState>(await reputation.getJobState(`rollover:${next.id}`));
          if (st.phase !== undefined && st.phase !== 'early') {
            return created ? 'more' : 'idle';
          }
          return chunk(next.id, st, true, now);
        }
        // The new season has started: one more pass for agents made between the early copy and the start.
        if (cur.number > 1 && nowMs - Date.parse(cur.startsAt) < ROLLOVER_LEAD_HOURS * HOUR_MS) {
          const st = parseState<RolloverState>(await reputation.getJobState(`rollover:${cur.id}`));
          if (st.phase === 'final_done') return 'idle';
          return chunk(cur.id, st, false, now);
        }
        return 'idle';
      }),
  };
}

// --- season_freeze ---------------------------------------------------------------------------------

interface FreezeState {
  phase: 'copy' | 'ready' | 'done';
  after: string | null;
}

export function createSeasonFreezeJob(deps: ReputationJobDeps): ReputationJob {
  const { store, reputation } = deps;
  const name = 'season_freeze';
  return {
    name,
    run: (now) =>
      guardJob(name, async () => {
        const iso = now.toISOString();
        const nowMs = now.getTime();
        const seasons = await store.listSeasons();
        const ended = seasons
          .filter((s) => Date.parse(s.endsAt) + FREEZE_AFTER_SEASON_HOURS * HOUR_MS <= nowMs)
          .sort((a, b) => b.number - a.number);
        const season = ended[0];
        if (season === undefined) return 'idle';
        const key = `freeze:${season.id}`;
        const st = parseState<FreezeState>(await reputation.getJobState(key));
        if (st.phase === 'done') return 'idle';
        const method = await reputation.getSeasonMethod(season.id);
        if (method.frozenAt !== null) return 'idle';

        if (st.phase === 'ready') {
          await reputation.markSeasonFrozen(season.id, iso);
          await reputation.putJobState(key, JSON.stringify({ phase: 'done', after: null }), iso);
          return 'done';
        }
        if (await reputation.hasProcessingTick(season.id)) return 'idle';

        if (method.method === 'v1') {
          const res = await reputation.freezeV1Chunk(season.id, st.after ?? null, FREEZE_CHUNK_ROWS, iso);
          const next: FreezeState =
            res.copied < FREEZE_CHUNK_ROWS
              ? { phase: 'ready', after: null }
              : { phase: 'copy', after: res.lastAgentId };
          await reputation.putJobState(key, JSON.stringify(next), iso);
          return 'more';
        }

        // v2: wait for the last priced day to be scored, or give up after two days.
        const score = parseState<ScoreState>(await reputation.getJobState(`score:${season.id}`));
        const scoredAll = (score.scoredDay ?? '') >= lastDayOfSeason(season.endsAt);
        if (!scoredAll && nowMs < Date.parse(season.endsAt) + FREEZE_GIVE_UP_HOURS * HOUR_MS) return 'idle';
        for (const division of DIVISIONS) await reputation.rankScores(season.id, division);
        for (const division of PAPER_DIVISIONS) await publishOfficialRank(store, season.id, division, iso);
        await reputation.putJobState(key, JSON.stringify({ phase: 'ready', after: null }), iso);
        return 'more';
      }),
  };
}

// --- day_prices ------------------------------------------------------------------------------------

export function createDayPricesJob(deps: ReputationJobDeps): ReputationJob {
  const { reputation } = deps;
  const name = 'day_prices';
  const missKey = 'day_prices:miss';
  return {
    name,
    run: (now) =>
      guardJob(name, async () => {
        const iso = now.toISOString();
        const today = dayOf(iso);
        const target =
          now.getUTCHours() >= DAY_PRICES_HOUR_UTC ? today : dayOf(new Date(now.getTime() - DAY_MS).toISOString());
        const latest = await reputation.latestPricedDay();
        if (latest !== null && latest >= target) return 'idle';
        // A day with no complete tick (a weekend, a holiday) is remembered, so it is not tried every run.
        if (parseState<{ day: string }>(await reputation.getJobState(missKey)).day === target) return 'idle';
        if (await reputation.captureDayPrices(target)) return 'done';
        await reputation.putJobState(missKey, JSON.stringify({ day: target }), iso);
        return 'idle';
      }),
  };
}

// --- season_score ----------------------------------------------------------------------------------

interface ScoreState {
  /** The last priced day scored in full. */
  scoredDay: UtcDay | null;
  /** The day being scored, the division and the cursor inside it. */
  work: { day: UtcDay; division: (typeof DIVISIONS)[number]; after: string | null } | null;
}

export function createSeasonScoreJob(deps: ReputationJobDeps): ReputationJob {
  const { store, reputation, scoringV2 } = deps;
  const name = 'season_score';

  function paperRow(
    seasonId: string,
    division: 'open' | 'pro',
    source: ScoreSource,
    day: UtcDay,
    activeDay: boolean,
    iso: string,
  ): SeasonScoreRow | null {
    const stats = source.stats;
    if (stats === null) return null;
    const core = scoringV2.seasonScore({
      division,
      returnsBps: scoringV2.dailyReturnsBps(STARTING_CASH_MICRO, stats.daily),
      tradingDays: stats.tradingDays,
      decidedCount: stats.decidedCount,
      activeOnScoredDay: activeDay,
      returnBps: stats.seasonReturnBps,
      maxDrawdownBps: stats.maxDrawdownBps,
    });
    return {
      seasonId,
      division,
      agentId: source.agentId,
      name: source.name,
      agentCreatedAt: source.createdAt,
      method: 'v2',
      moments: core.moments,
      returnBps: stats.seasonReturnBps,
      maxDrawdownBps: stats.maxDrawdownBps,
      tradingDays: stats.tradingDays,
      decidedCount: stats.decidedCount,
      tradeCount: stats.tradeCount,
      scoreMilli: core.breakdown.scoreMilli,
      confidence: core.confidence,
      unrankedReason: core.unrankedReason,
      scoredDay: day,
      updatedAt: iso,
    };
  }

  function chainRow(seasonId: string, source: ScoreSource, day: UtcDay, iso: string): SeasonScoreRow | null {
    if (source.chainDays === null) return null;
    // Only days on or after the claim day count, and a day is exposed only when the holdings at the
    // start of the day (the previous day's closing value) were worth at least the minimum.
    const claimDay = source.createdAt.slice(0, 10);
    const all = source.chainDays;
    const days = all.filter((d) => d.day >= claimDay);
    const startValue = (d: (typeof all)[number]): number => {
      const index = all.indexOf(d);
      return Number(index > 0 ? (all[index - 1]?.valueMicro ?? 0) : d.valueMicro);
    };
    const exposed = days.filter((d) => d.exposed && startValue(d) >= MIN_EXPOSED_START_MICRO);
    let growth = 1;
    let peak = 0;
    let drawdown = 0;
    for (const d of exposed) growth *= (10_000 + d.returnBps) / 10_000;
    for (const d of days) {
      if (d.indexMicro > peak) peak = d.indexMicro;
      if (peak > 0) drawdown = Math.max(drawdown, Math.round(((peak - d.indexMicro) * 10_000) / peak));
    }
    const returnBps = Math.round((growth - 1) * 10_000) + 0;
    const decided = days.filter((d) => d.eventCount - d.unpricedEventCount > 0).length;
    const core = scoringV2.seasonScore({
      division: 'chain',
      returnsBps: exposed.map((d) => d.returnBps),
      tradingDays: exposed.length,
      decidedCount: decided,
      activeOnScoredDay: days.length > 0 && days[days.length - 1]?.day === day,
      returnBps,
      maxDrawdownBps: drawdown,
    });
    return {
      seasonId,
      division: 'chain',
      agentId: source.agentId,
      name: source.name,
      agentCreatedAt: source.createdAt,
      method: 'v2',
      moments: core.moments,
      returnBps,
      maxDrawdownBps: drawdown,
      tradingDays: exposed.length,
      decidedCount: decided,
      tradeCount: days.reduce((sum, d) => sum + d.eventCount, 0),
      scoreMilli: core.breakdown.scoreMilli,
      confidence: core.confidence,
      unrankedReason: core.unrankedReason,
      scoredDay: day,
      updatedAt: iso,
    };
  }

  return {
    name,
    run: (now) =>
      guardJob(name, async () => {
        const iso = now.toISOString();
        const season = await store.getActiveSeason(iso);
        if (season === null) return 'idle';
        const method = await reputation.getSeasonMethod(season.id);
        if (method.method !== 'v2' || method.frozenAt !== null) return 'idle';
        const key = `score:${season.id}`;
        const st = parseState<ScoreState>(await reputation.getJobState(key));
        const latest = await reputation.latestPricedDay();
        if (latest === null) return 'idle';
        const startDay = dayOf(season.startsAt);
        const work = st.work ?? null;
        if (work === null) {
          const scored = st.scoredDay ?? null;
          if (latest < startDay || latest > lastDayOfSeason(season.endsAt)) return 'idle';
          if (scored !== null && latest <= scored) return 'idle';
        }
        const current = work ?? { day: latest, division: 'open' as const, after: null };
        const { day, division } = current;

        let sources: ScoreSource[];
        let limit: number;
        if (division === 'chain') {
          limit = SCORE_CHUNK_LISTINGS;
          sources = await reputation.listChainScoreSources(startDay, day, current.after, limit);
        } else {
          limit = SCORE_CHUNK_AGENTS;
          sources = await reputation.listPaperScoreSources(season.id, division, current.after, limit);
        }
        const rows: SeasonScoreRow[] = [];
        for (const source of sources) {
          const row =
            division === 'chain'
              ? chainRow(season.id, source, day, iso)
              : paperRow(season.id, division, source, day, source.stats?.lastDay === day, iso);
          if (row !== null) rows.push(row);
        }
        if (rows.length > 0) await reputation.putScores(rows);

        if (sources.length >= limit) {
          const last = sources[sources.length - 1];
          const next: ScoreState = {
            scoredDay: st.scoredDay ?? null,
            work: { day, division, after: last?.agentId ?? null },
          };
          await reputation.putJobState(key, JSON.stringify(next), iso);
          return 'more';
        }
        await reputation.rankScores(season.id, division);
        if (division !== 'chain') await publishOfficialRank(store, season.id, division, iso);
        const nextDivision = DIVISIONS[DIVISIONS.indexOf(division) + 1];
        const next: ScoreState =
          nextDivision === undefined
            ? { scoredDay: day, work: null }
            : { scoredDay: st.scoredDay ?? null, work: { day, division: nextDivision, after: null } };
        await reputation.putJobState(key, JSON.stringify(next), iso);
        return nextDivision === undefined ? 'done' : 'more';
      }),
  };
}

// --- cleanup ---------------------------------------------------------------------------------------

const COUNTER_DELETE_LIMIT = 200;

export function createCleanupJob(deps: ReputationJobDeps): ReputationJob {
  const { reputation } = deps;
  const name = 'cleanup';
  const key = 'cleanup';
  return {
    name,
    run: (now) =>
      guardJob(name, async () => {
        const iso = now.toISOString();
        const today = dayOf(iso);
        if (parseState<{ day: string }>(await reputation.getJobState(key)).day === today) return 'idle';
        const deleted = await reputation.deleteOldCounters(today, COUNTER_DELETE_LIMIT);
        if (deleted >= COUNTER_DELETE_LIMIT) return 'more';
        await reputation.putJobState(key, JSON.stringify({ day: today }), iso);
        return 'done';
      }),
  };
}
