import type {
  AgentPublic,
  AgentRecord,
  ApiDeps,
  LeagueResponse,
  MarketPricesResponse,
  MarketResponse,
  PortfolioState,
  ProvidersResponse,
  Season,
  SeasonsResponse,
  SimEngine,
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
import type { HoldingsSource, LiveDelay } from './league/delay.ts';
import { delayAgentRows, delayStandingRows, NO_LIVE_DELAY } from './league/delay.ts';
import { readSessionToken } from './session.ts';
import { ownerHoldsFor } from './token/owner-holds.ts';
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
 * The portfolio an agent read shows, and the tick it is as of, once the Live delay has been applied:
 * the stored one, the one the newest visible row left, or the starting one.
 */
function shownPortfolio(
  sim: SimEngine,
  record: { portfolio: PortfolioState; lastTickId: string | null },
  source: HoldingsSource,
): { portfolio: PortfolioState; asOfTickId: string | null } {
  if (source.kind === 'row') return { portfolio: source.row.portfolio, asOfTickId: source.row.tickId };
  if (source.kind === 'start') return { portfolio: sim.newPortfolio(), asOfTickId: null };
  return { portfolio: record.portfolio, asOfTickId: record.lastTickId };
}

/**
 * The reads anyone may make. None of them looks at a session, so none of them can show
 * anything that belongs to one wallet, and all of them may be cached.
 *
 * `delay` is the publication delay of Prix Live (docs/CONTRACTS.md section 24.8): today's rows and
 * the holdings they left, of an agent linked to a Live wallet, stay out of these reads until 20:00
 * UTC, except for the agent's own owner.
 */
export function registerPublicRoutes(app: Hono, deps: ApiDeps, delay: LiveDelay = NO_LIVE_DELAY): void {
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
    // The universe gives the order and the names: the Stock Tokens, then the crypto assets (sections 21
    // and 23), whatever chain their feed is read on. A symbol without a price at the round, such as a
    // coin in a tick stored before it joined, is left out. The snapshot's `otherChains` (which endpoint
    // answered, at which block) is never part of this answer.
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
    // The holdings of a Live-linked agent's row wait for 20:00 UTC (section 24.8); its figures do not.
    const shown = sources.slice(0, LEAGUE_PAGE_SIZE);
    const rows = await delayStandingRows(
      delay,
      shown,
      shown.map((source) => toStandingRow(scoring, state, source, config.houseOwners, sim)),
      deps.now(),
    );

    return json<LeagueResponse>(
      {
        season,
        division,
        seasonEnded: now >= season.endsAt,
        market,
        state,
        rows,
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
    // Prix Live (section 24.8): today's rows of a linked agent, and the holdings they left, wait for
    // 20:00 UTC. The owner sees them at once.
    const live = await delayAgentRows(delay, agent.id, rows, record.lastTickId, nowDate, isOwner);
    const visibleRows = live.rows.filter((row) => isVisibleAt(row.createdAt, nowDate, delaySeconds));
    const shown = shownPortfolio(sim, record, live.holdings);

    // Holdings are valued at the prices of the tick they are as of. Before its first row an
    // agent holds cash only, so there is nothing to price.
    const tick = shown.asOfTickId === null ? null : await store.getTick(shown.asOfTickId);
    if (shown.asOfTickId !== null && tick === null) throw new Error('the tick of an agent row is missing');
    const { holdings, cashWeightBps } = valueHoldings(
      sim,
      shown.portfolio,
      tick === null ? {} : pricesOf(tick.snapshot),
    );

    // The owner's full address is read for these two marks and reaches no field of the answer.
    const house = isHouseOwner(config.houseOwners, agent.owner);
    // Phase 6.7, part B: the owner's choice first, then the STORED tier with `cachedOnly`. The same answer
    // for every viewer; a failure answers false and never fails the read.
    const ownerHolds = await ownerHoldsFor(deps, agent.owner, house);

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
        cashMicro: shown.portfolio.cashMicro,
        cashWeightBps,
        asOfTickId: shown.asOfTickId,
        decisions: visibleRows.map(toDecisionPublic),
        method: state?.method ?? SCORING_METHOD,
        house,
        ownerHolds,
      },
      200,
      // The owner sees what the public may not see yet (a Live agent's day before 20:00 UTC), so the
      // owner's answer is never one anybody may keep.
      hasCookie && (entitlements.gatingOn || isOwner) ? 'private' : 'public',
    );
  });
}
