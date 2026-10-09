import type {
  AgentPublic,
  AgentRecord,
  ApiDeps,
  LeagueResponse,
  MarketPricesResponse,
  MarketResponse,
  ProvidersResponse,
  Season,
  SeasonsResponse,
  Store,
} from '@prix/contracts';
import {
  idSchema,
  isHouseOwner,
  isVisibleAt,
  LEAGUE_PAGE_SIZE,
  leagueQuerySchema,
  openPreviewEntitlements,
  PROVIDERS,
  SCORING_METHOD,
  utcDayOfTick,
} from '@prix/contracts';
import { computeRecentReturns } from '@prix/market/returns';
import { UNIVERSE } from '@prix/market/universe';
import type { Hono } from 'hono';
import { failures, json } from './errors.ts';
import { readSession } from './guard.ts';
import { matches, readQuery } from './input.ts';
import { readSessionToken } from './session.ts';
import {
  currentSeason,
  pricesOf,
  shortAddress,
  standingOf,
  toDecisionPublic,
  toStandingRow,
  valueHoldings,
} from './views.ts';

/** The newest rows an agent's page shows. docs/CONTRACTS.md section 4. */
const AGENT_PAGE_DECISIONS = 30;

/** What the page says about the model behind an agent. Never a key, and never anything of a key but its provider and model name. */
export async function modelOf(
  store: Store,
  agent: AgentRecord,
  rows: readonly { status: string; model: string | null }[],
): Promise<AgentPublic['model']> {
  if (agent.division === 'open') return { kind: 'house' };
  // The store gives a key only to its owner, so an agent can never show a model that is not its owner's.
  const key = agent.modelKeyId === null ? null : await store.getModelKey(agent.modelKeyId, agent.owner);
  const provider = key === null ? undefined : PROVIDERS.find((entry) => entry.id === key.provider);
  // A Pro agent whose key was removed has no model to name until its owner sets a new key.
  if (key === null || provider === undefined) return { kind: 'none' };
  // The owner's model name is free text. It is shown only once a provider has decided with it.
  // Until then the page gets the provider alone: `model` is empty, as `agentPublicSchema` needs a string.
  const confirmed = rows.some((row) => row.status === 'decided' && row.model === `${key.provider}:${key.model}`);
  return { kind: 'own', providerLabel: provider.label, model: confirmed ? key.model : '' };
}

/**
 * The reads anyone may make. None of them looks at a session, so none of them can show
 * anything that belongs to one wallet, and all of them may be cached.
 */
export function registerPublicRoutes(app: Hono, deps: ApiDeps): void {
  const { store, scoring, sim, config } = deps;

  app.get('/market', async () => {
    const now = deps.now().toISOString();
    const [market, season] = await Promise.all([store.getMarketStatus(), store.getActiveSeason(now)]);
    return json<MarketResponse>({ market, season }, 200, 'public');
  });

  // The price strip (docs/CONTRACTS.md section 17.2). Two reads: the latest tick, then the last
  // stored daily prices before its day. The change is the one-day return the agents are given.
  app.get('/market/prices', async () => {
    const tick = await store.getLatestTick();
    if (tick === null) return json<MarketPricesResponse>({ tickId: null, takenAt: null, prices: [] }, 200, 'public');
    const previous = await store.listDailyPrices(utcDayOfTick(tick.id), 1);
    const points = new Map(tick.snapshot.prices.map((point) => [point.symbol, point]));
    const changes = new Map(
      computeRecentReturns(pricesOf(tick.snapshot), previous).map((entry) => [entry.symbol, entry.day1Bps]),
    );
    const prices: MarketPricesResponse['prices'] = [];
    // The universe gives the order and the names: the Stock Tokens, then the crypto assets (section 21).
    // A symbol without a price at the round, such as a coin in a tick stored before it joined, is left out.
    for (const token of UNIVERSE) {
      const point = points.get(token.symbol);
      if (point === undefined) continue;
      prices.push({
        symbol: token.symbol,
        name: token.name,
        priceMicro: point.priceMicro,
        changeBps: changes.get(token.symbol) ?? null,
        fresh: point.fresh,
      });
    }
    return json<MarketPricesResponse>({ tickId: tick.id, takenAt: tick.snapshot.takenAt, prices }, 200, 'public');
  });

  app.get('/seasons', async () => {
    return json<SeasonsResponse>({ seasons: await store.listSeasons() }, 200, 'public');
  });

  app.get('/providers', () => {
    const providers = PROVIDERS.map((provider) => ({ id: provider.id, label: provider.label }));
    return json<ProvidersResponse>({ providers, houseModel: config.houseModel }, 200, 'public');
  });

  app.get('/league', async (c) => {
    const query = readQuery(leagueQuerySchema, c.req.url);
    const now = deps.now().toISOString();

    let season: Season | null;
    if (query.season === undefined) {
      season = await currentSeason(store, now);
    } else {
      season = await store.getSeason(query.season);
      // A season that has not started has no table yet.
      if (season !== null && season.startsAt > now) season = null;
    }
    if (season === null) throw failures.seasonNotFound();

    const { division, page } = query;
    const seasonId = season.id;
    // One row more than a page, to know whether there is a next page without counting the division.
    // A page beyond the last one finds nothing: it answers with no rows and `hasMore: false`.
    const [market, state, sources, processing] = await Promise.all([
      store.getMarketStatus(),
      store.getLeagueState(seasonId, division),
      store.listStandings(seasonId, division, LEAGUE_PAGE_SIZE + 1, (page - 1) * LEAGUE_PAGE_SIZE),
      store.listProcessingTicks(),
    ]);

    // The round in progress for this table: the oldest unfinished tick of this season in which
    // this division decides. Open agents decide at the daily tick only.
    const tick = processing.find((entry) => entry.seasonId === seasonId && (division === 'pro' || entry.daily));
    const round =
      tick === undefined ? null : { tickId: tick.id, pending: await store.countPendingAgents(tick.id, division) };

    return json<LeagueResponse>(
      {
        season,
        division,
        seasonEnded: now >= season.endsAt,
        market,
        state,
        rows: sources
          .slice(0, LEAGUE_PAGE_SIZE)
          .map((source) => toStandingRow(scoring, state, source, config.houseOwners, sim)),
        page,
        hasMore: sources.length > LEAGUE_PAGE_SIZE,
        round,
      },
      200,
      'public',
    );
  });

  app.get('/agents/:id', async (c) => {
    const id = c.req.param('id');
    if (!matches(idSchema, id)) throw failures.agentNotFound();
    const now = deps.now().toISOString();

    const [agent, season] = await Promise.all([store.getAgent(id), currentSeason(store, now)]);
    // A hidden agent does not exist for the public: the same answer as for an unknown id.
    if (agent === null || agent.hidden || season === null) throw failures.agentNotFound();

    const [record, state, rows] = await Promise.all([
      store.getPortfolio(agent.id, season.id),
      store.getLeagueState(season.id, agent.division),
      store.listDecisions(agent.id, season.id, AGENT_PAGE_DECISIONS),
    ]);
    const model = await modelOf(store, agent, rows);
    if (record === null) throw failures.agentNotFound();

    // The delay of the viewer's tier, from the entitlements port and nothing the client sent. The
    // agent's owner sees everything. A request with a session cookie is the one that can differ, so it is private.
    const hasCookie = readSessionToken(c.req.raw) !== null;
    const viewer = hasCookie ? ((await readSession(deps, c.req.raw))?.address ?? null) : null;
    const entitlements = await (deps.entitlements ?? openPreviewEntitlements).entitlementsFor(viewer);
    const isOwner = viewer !== null && viewer.toLowerCase() === agent.owner.toLowerCase();
    const delaySeconds = isOwner ? 0 : entitlements.feedDelaySeconds;
    const nowDate = deps.now();
    const visibleRows = rows.filter((row) => isVisibleAt(row.createdAt, nowDate, delaySeconds));

    // Holdings are valued at the prices of the agent's latest tick. Before its first row an
    // agent holds cash only, so there is nothing to price.
    const tick = record.lastTickId === null ? null : await store.getTick(record.lastTickId);
    if (record.lastTickId !== null && tick === null) throw new Error('the tick of an agent row is missing');
    const { holdings, cashWeightBps } = valueHoldings(
      sim,
      record.portfolio,
      tick === null ? {} : pricesOf(tick.snapshot),
    );

    return json<AgentPublic>(
      {
        id: agent.id,
        name: agent.name,
        division: agent.division,
        ownerShort: shortAddress(agent.owner),
        model,
        status: agent.status,
        createdAt: agent.createdAt,
        summary: agent.summary,
        summaryStatus: agent.summaryStatus,
        // The prompt is private unless its owner has published it.
        prompt: agent.promptPublic ? agent.prompt : null,
        season,
        ...standingOf(scoring, state, record.rank, record.stats, record.lastTickId, record.official),
        rankedCount: state?.rankedCount ?? 0,
        stats: record.stats,
        holdings,
        cashMicro: record.portfolio.cashMicro,
        cashWeightBps,
        asOfTickId: record.lastTickId,
        decisions: visibleRows.map(toDecisionPublic),
        method: state?.method ?? SCORING_METHOD,
        // The owner's full address is read for this mark and reaches no field of the answer.
        house: isHouseOwner(config.houseOwners, agent.owner),
      },
      200,
      hasCookie && entitlements.gatingOn ? 'private' : 'public',
    );
  });
}
