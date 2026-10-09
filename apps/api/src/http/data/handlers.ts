import type {
  AgentDecisionsResponse,
  AgentPublic,
  AgentRecord,
  DataDeps,
  DataHandler,
  DataHandlers,
  LeagueResponse,
  MarketSnapshotResponse,
  Season,
  SeasonsResponse,
  Store,
} from '@prix/contracts';
import { DataFailure, isHouseOwner, isVisibleAt, LEAGUE_PAGE_SIZE, PROVIDERS, SCORING_METHOD } from '@prix/contracts';
import {
  currentSeason,
  pricesOf,
  shortAddress,
  standingOf,
  toDecisionPublic,
  toStandingRow,
  valueHoldings,
} from '../views.ts';
import { createTrustHandlers } from './trust.ts';
import { readUsage } from './usage.ts';

const AGENT_PAGE_DECISIONS = 30;
/** Rows read beyond the limit, so a delay that hides the newest rows still leaves a full page. */
const DECISIONS_EXTRA = 10;

const agentNotFound = (): DataFailure =>
  new DataFailure('not_found', 'No agent has this id. Check the id, or read the league for current ids.');
const seasonNotFound = (): DataFailure =>
  new DataFailure(
    'not_found',
    'Nothing in the league matches this request. Ask without a period to read the league as it is now.',
  );

/** Copy of the Phase 1 helper in routes-public.ts, which does not export it. */
async function modelOf(
  store: Store,
  agent: AgentRecord,
  rows: readonly { status: string; model: string | null }[],
): Promise<AgentPublic['model']> {
  if (agent.division === 'open') return { kind: 'house' };
  const key = agent.modelKeyId === null ? null : await store.getModelKey(agent.modelKeyId, agent.owner);
  const provider = key === null ? undefined : PROVIDERS.find((entry) => entry.id === key.provider);
  if (key === null || provider === undefined) return { kind: 'none' };
  const confirmed = rows.some((row) => row.status === 'decided' && row.model === `${key.provider}:${key.model}`);
  return { kind: 'own', providerLabel: provider.label, model: confirmed ? key.model : '' };
}

/**
 * `deps.houseOwners` is `ApiConfig.houseOwners`, so that a league row and an agent read of the
 * data API carry the same `house` mark as the public API. Absent means there are no house agents.
 */
export function createDataHandlers(deps: DataDeps): DataHandlers {
  const { store, scoring, sim, houseOwners } = deps;
  const trust = createTrustHandlers(deps);
  const typed = <T>(
    fn: (input: T, context: { caller: Parameters<DataHandler>[1]['caller']; now: Date }) => Promise<unknown>,
  ) => fn as unknown as DataHandler;

  return {
    seasons: typed(async (): Promise<SeasonsResponse> => ({ seasons: await store.listSeasons() })),

    league: typed(
      async (query: { division: 'open' | 'pro'; season?: string; page: number }, { now }): Promise<LeagueResponse> => {
        const nowIso = now.toISOString();
        let season: Season | null;
        if (query.season === undefined) {
          season = await currentSeason(store, nowIso);
        } else {
          season = await store.getSeason(query.season);
          if (season !== null && season.startsAt > nowIso) season = null;
        }
        if (season === null) throw seasonNotFound();
        const { division, page } = query;
        const seasonId = season.id;
        const [market, state, sources, processing] = await Promise.all([
          store.getMarketStatus(),
          store.getLeagueState(seasonId, division),
          store.listStandings(seasonId, division, LEAGUE_PAGE_SIZE + 1, (page - 1) * LEAGUE_PAGE_SIZE),
          store.listProcessingTicks(),
        ]);
        const tick = processing.find((entry) => entry.seasonId === seasonId && (division === 'pro' || entry.daily));
        const round =
          tick === undefined ? null : { tickId: tick.id, pending: await store.countPendingAgents(tick.id, division) };
        return {
          season,
          division,
          seasonEnded: nowIso >= season.endsAt,
          market,
          state,
          rows: sources
            .slice(0, LEAGUE_PAGE_SIZE)
            .map((source) => toStandingRow(scoring, state, source, houseOwners, sim)),
          page,
          hasMore: sources.length > LEAGUE_PAGE_SIZE,
          round,
        };
      },
    ),

    agent: typed(async (input: { id: string }, { caller, now }): Promise<AgentPublic> => {
      const [agent, season] = await Promise.all([store.getAgent(input.id), currentSeason(store, now.toISOString())]);
      if (agent === null || agent.hidden || season === null) throw agentNotFound();
      const [record, state, rows] = await Promise.all([
        store.getPortfolio(agent.id, season.id),
        store.getLeagueState(season.id, agent.division),
        store.listDecisions(agent.id, season.id, AGENT_PAGE_DECISIONS + DECISIONS_EXTRA),
      ]);
      if (record === null) throw agentNotFound();
      const model = await modelOf(store, agent, rows);
      const delay = caller?.entitlements.feedDelaySeconds ?? 0;
      const visible = rows.filter((row) => isVisibleAt(row.createdAt, now, delay)).slice(0, AGENT_PAGE_DECISIONS);
      const tick = record.lastTickId === null ? null : await store.getTick(record.lastTickId);
      if (record.lastTickId !== null && tick === null) throw new Error('the tick of an agent row is missing');
      const { holdings, cashWeightBps } = valueHoldings(
        sim,
        record.portfolio,
        tick === null ? {} : pricesOf(tick.snapshot),
      );
      return {
        id: agent.id,
        name: agent.name,
        division: agent.division,
        ownerShort: shortAddress(agent.owner),
        model,
        status: agent.status,
        createdAt: agent.createdAt,
        summary: agent.summary,
        summaryStatus: agent.summaryStatus,
        prompt: agent.promptPublic ? agent.prompt : null,
        season,
        ...standingOf(scoring, state, record.rank, record.stats, record.lastTickId, record.official),
        rankedCount: state?.rankedCount ?? 0,
        stats: record.stats,
        holdings,
        cashMicro: record.portfolio.cashMicro,
        cashWeightBps,
        asOfTickId: record.lastTickId,
        decisions: visible.map(toDecisionPublic),
        method: state?.method ?? SCORING_METHOD,
        house: isHouseOwner(houseOwners, agent.owner),
      };
    }),

    agent_decisions: typed(
      async (
        input: { id: string; season?: string; limit: number },
        { caller, now },
      ): Promise<AgentDecisionsResponse> => {
        const agent = await store.getAgent(input.id);
        if (agent === null || agent.hidden) throw agentNotFound();
        const season =
          input.season === undefined
            ? await currentSeason(store, now.toISOString())
            : await store.getSeason(input.season);
        if (season === null) throw seasonNotFound();
        const delay = caller?.entitlements.feedDelaySeconds ?? 0;
        const rows = await store.listDecisions(agent.id, season.id, input.limit + DECISIONS_EXTRA);
        const visible = rows.filter((row) => isVisibleAt(row.createdAt, now, delay)).slice(0, input.limit);
        return {
          agentId: agent.id,
          seasonId: season.id,
          delayedBySeconds: delay,
          decisions: visible.map(toDecisionPublic),
        };
      },
    ),

    market: typed(async (_input: unknown, { now }): Promise<MarketSnapshotResponse> => {
      const [market, season, tick] = await Promise.all([
        store.getMarketStatus(),
        store.getActiveSeason(now.toISOString()),
        store.getLatestTick(),
      ]);
      return {
        market,
        season,
        snapshot:
          tick === null
            ? null
            : {
                tickId: tick.id,
                takenAt: tick.snapshot.takenAt,
                open: tick.snapshot.open,
                closedReason: tick.snapshot.closedReason,
                prices: tick.snapshot.prices,
              },
      };
    }),

    developer: trust.developer,
    token: trust.token,
    wallet: trust.wallet,

    usage: typed(async (_input: unknown, { caller, now }) => {
      if (caller === null) throw new DataFailure('missing_key', 'Send your key as Authorization: Bearer <key>.');
      return readUsage(deps, caller, now, false);
    }),
  };
}
