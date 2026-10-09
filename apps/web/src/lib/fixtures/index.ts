import type { AgentOwnerView, ApiError, ApiErrorCode, HoldsResponse, MarketStatus } from '@prix/contracts';
import {
  CHAIN_ID,
  createAgentInputSchema,
  createModelKeyInputSchema,
  divisionSchema,
  SIWE_STATEMENT,
  setHiddenInputSchema,
  updateAgentInputSchema,
  verifyInputSchema,
} from '@prix/contracts';
import type { ApiCall, Transport } from '../api.ts';
import type { MeFixture } from './account.ts';
import {
  HOLDS,
  HOLDS_EMPTY,
  HOLDS_RELEASED,
  MODEL_KEY,
  meResponse,
  OWNED_AGENT,
  PROVIDERS_RESPONSE,
} from './account.ts';
import { AGENT_PAGES, SLOW_COMPOUNDER_ID, SLOW_COMPOUNDER_OWNER } from './agent.ts';
import { EARLY_HOUSE_AGENT, EARLY_MARKET, EARLY_SEASON, earlyLeagueResponse } from './early.ts';
import type { LeagueFixture } from './league.ts';
import { fixtureId, leagueResponse, MARKETS, SEASON } from './league.ts';
import { marketPricesResponse, NO_PRICES } from './prices.ts';

/**
 * Fixtures: what the API would answer, for building and reviewing pages before the API exists.
 *
 * This folder is reached only when the site is built with PRIX_FIXTURES=1. The page URL then
 * takes `?fixture=<name>`, or several names separated by commas, one per group below. A name
 * that is left out means the first name of its group.
 *
 *   league   league-ranked    Open: ten ranked agents and four without a rank. Pro: no agents.
 *                             Three of the Open agents are house agents.
 *            league-early     Production in its first week (early.ts): nine agents in Open, all
 *                             of them house agents, none ranked (min_trading_days), returns
 *                             within one percent of zero, sparklines of one or two points. Pro:
 *                             no agents. The season is 5 October to 2 November 2026, and the
 *                             market and the seasons answer for that season too.
 *            league-unranked  Before the first ranking of the season: no ranks, no reasons.
 *            league-round     As league-ranked, with a round still being processed.
 *            league-ended     As league-ranked, after the season has ended.
 *            league-pro       As league-ranked, with five agents in the Pro division.
 *            league-none      No season yet: the league answers 404, seasons are empty and the
 *                             market has no season. `page=2` (any page past the last) on any
 *                             league fixture gives a page with no rows.
 *   market   market-open, market-closed (feeds stale), market-paused (prices cannot be read),
 *            market-halted (open, two symbols halted), market-crypto-halted (open, BTC halted:
 *            a crypto feed halts its own symbol and never closes the market), market-none (no
 *            season: market and season are null)
 *   holds    holds-list (one open hold), holds-empty (none), holds-released (the hold released)
 *   visitor  signed-out, signed-in (no agent, no key), signed-in-agent (Slow Compounder and
 *            one model key), signed-in-admin (the same, as an admin),
 *            signed-in-key-failing (Gamma Scout's owner: paused, key_failing),
 *            signed-in-pro (a Pro agent with its key), signed-in-paused-owner,
 *            signed-in-paused-key-removed, signed-in-paused-admin (an agent paused for each
 *            reason; key_failing is signed-in-key-failing), signed-in-hidden (hidden by an admin),
 *            signed-in-provider-rejected (the latest turn is no decision, provider_rejected),
 *            signed-in-skipped (the latest turn is skipped), signed-in-three-keys (three keys)
 *   failure  fail-reads (every read answers 500), and error-<code> (every write answers that
 *            error): error-unauthorized, error-forbidden, error-not-found, error-invalid-input,
 *            error-rate-limited, error-name-taken, error-name-not-allowed,
 *            error-owner-has-agent, error-league-full, error-key-limit-reached,
 *            error-daily-limit, error-no-active-season, error-internal
 *
 * Every league row carries a summary, a creation time and the house mark, and every agent page
 * carries the house mark, as the API sends them since revision 5 (docs/CONTRACTS.md section 17).
 * Every league row also carries its three largest holdings and its cash weight (section 17.2);
 * an agent with a page shows the same on its card as on its page.
 *
 * The price strip, GET /api/market/prices (prices.ts), follows the market and league names: the
 * twenty Stock Tokens, then BTC and ETH, at the market's last round, with gains, losses, one stale
 * feed (the halted symbols of market-halted and market-crypto-halted, USO otherwise) and one symbol
 * without a change. In the round of league-early the coins have no change yet. Before the first
 * round (league-unranked) and without a season (league-none, market-none) it has no round.
 *
 * The league feed, GET /api/feed/league, is answered by the follow client (follow-fixtures.ts):
 *   league feed  feed-league        Eight decisions with fills, two of them of house agents.
 *                feed-league-early  The thirteen decisions of the nine agents of league-early,
 *                                   all of house agents. It is the default beside league-early.
 *                feed-league-empty  No decision yet.
 *
 * Agent pages: Slow Compounder at /agents/slowcompound, Macro Tourist (model none, paused),
 * Gamma Scout (paused, key failing), the stress agent (a name of 32 W, a holding of every
 * symbol of the universe, BTC and ETH among them, 30 rows, a published prompt) at
 * /agents/wwwwwwwwwwww, and Semis Rotation at /agents/semisrotatio:
 * a house agent in its first week, with two points on its chart, no rank and one decision.
 * Any other address is a 404.
 * An unknown name makes every call fail, so a typing mistake is seen at once.
 */

/** `early` is the league of early.ts. Every other name is a state of the sample league of league.ts. */
type LeagueName = LeagueFixture | 'early';

const LEAGUE_NAMES: Record<string, LeagueName> = {
  'league-ranked': 'ranked',
  'league-early': 'early',
  'league-unranked': 'unranked',
  'league-round': 'round',
  'league-ended': 'ended',
  'league-pro': 'pro',
  'league-none': 'none',
};

const MARKET_NAMES: Record<string, MarketStatus> = {
  'market-open': MARKETS.open,
  'market-closed': MARKETS.closed,
  'market-paused': MARKETS.paused,
  'market-halted': MARKETS.halted,
  'market-crypto-halted': MARKETS.cryptoHalted,
};

/** `market-none`: no season exists, so the market and the season are both null. */
const MARKET_NONE = 'market-none';

const HOLDS_NAMES: Record<string, HoldsResponse> = {
  'holds-list': HOLDS,
  'holds-empty': HOLDS_EMPTY,
  'holds-released': HOLDS_RELEASED,
};

const VISITOR_NAMES: readonly MeFixture[] = [
  'signed-out',
  'signed-in',
  'signed-in-agent',
  'signed-in-admin',
  'signed-in-key-failing',
  'signed-in-pro',
  'signed-in-paused-owner',
  'signed-in-paused-key-removed',
  'signed-in-paused-admin',
  'signed-in-hidden',
  'signed-in-provider-rejected',
  'signed-in-skipped',
  'signed-in-three-keys',
];

const ERROR_STATUS: Record<ApiErrorCode, number> = {
  invalid_input: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  name_taken: 409,
  name_not_allowed: 409,
  owner_has_agent: 409,
  league_full: 409,
  key_limit_reached: 409,
  daily_limit: 503,
  rate_limited: 429,
  internal: 500,
  no_active_season: 503,
};

const ERROR_NAMES = new Map<string, ApiErrorCode>(
  (Object.keys(ERROR_STATUS) as ApiErrorCode[]).map((code) => [`error-${code.replaceAll('_', '-')}`, code]),
);

/** Every name `?fixture=` accepts. */
export const FIXTURE_NAMES: readonly string[] = [
  ...Object.keys(LEAGUE_NAMES),
  ...Object.keys(MARKET_NAMES),
  MARKET_NONE,
  ...Object.keys(HOLDS_NAMES),
  ...VISITOR_NAMES,
  'fail-reads',
  ...ERROR_NAMES.keys(),
];

interface Selection {
  league: LeagueName;
  /** Null when no market name was given: the league fixture then decides. */
  market: MarketStatus | null;
  visitor: MeFixture;
  noSeason: boolean;
  holds: HoldsResponse;
  failReads: boolean;
  writeError: ApiErrorCode | null;
  unknown: string[];
}

function select(url: URL): Selection {
  const selection: Selection = {
    league: 'ranked',
    market: null,
    visitor: 'signed-out',
    noSeason: false,
    holds: HOLDS,
    failReads: false,
    writeError: null,
    unknown: [],
  };
  const names = (url.searchParams.get('fixture') ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
  for (const name of names) {
    const league = LEAGUE_NAMES[name];
    const market = MARKET_NAMES[name];
    const visitor = VISITOR_NAMES.find((entry) => entry === name);
    const writeError = ERROR_NAMES.get(name);
    if (league) selection.league = league;
    else if (market) selection.market = market;
    else if (visitor) selection.visitor = visitor;
    else if (writeError) selection.writeError = writeError;
    else if (HOLDS_NAMES[name]) selection.holds = HOLDS_NAMES[name];
    else if (name === MARKET_NONE) selection.noSeason = true;
    else if (name === 'fail-reads') selection.failReads = true;
    else if (/^(follow|follows|feed|results|telegram|social)-/.test(name))
      continue; // a name of the follow transport
    else selection.unknown.push(name);
  }
  return selection;
}

function json(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

const noContent = (): Response => new Response(null, { status: 204 });

function failure(code: ApiErrorCode, message: string, field: string | null = null): Response {
  const body: ApiError = { error: { code, message, field } };
  return json(ERROR_STATUS[code], body);
}

const MESSAGES: Record<ApiErrorCode, string> = {
  unauthorized: 'Sign in to continue.',
  forbidden: 'This wallet cannot do that.',
  not_found: 'Nothing exists at that address.',
  invalid_input: 'Use letters, digits, spaces, dots, underscores and hyphens.',
  rate_limited: 'Too many requests. Wait a minute and try again.',
  name_taken: 'That name is taken. Choose another.',
  name_not_allowed: 'That name is not allowed. Choose another.',
  owner_has_agent: 'This wallet already has an agent.',
  league_full: 'This division is full. Try again when a place opens.',
  key_limit_reached: 'This wallet already stores the most model keys it may. Remove one first.',
  daily_limit: 'A daily limit of the free plan is used up. The product resumes at 00:00 UTC.',
  no_active_season: 'No season is running. You can build an agent when the next one starts.',
  internal: 'Something went wrong on our side. Try again in a minute.',
};

interface Parser<T> {
  safeParse(
    data: unknown,
  ): { success: true; data: T } | { success: false; error: { issues: { message: string; path: PropertyKey[] }[] } };
}

/** Checks a request body as the API does. Returns the body, or the 400 response for it. */
function parseBody<T>(schema: Parser<T>, body: unknown): { data: T } | { response: Response } {
  const parsed = schema.safeParse(body);
  if (parsed.success) return { data: parsed.data };
  const issue = parsed.error.issues[0];
  const field = issue && issue.path.length > 0 ? issue.path.map(String).join('.') : null;
  return { response: failure('invalid_input', issue ? issue.message : MESSAGES.invalid_input, field) };
}

function marketFor(selection: Selection): MarketStatus {
  if (selection.market) return selection.market;
  if (selection.league === 'early') return EARLY_MARKET;
  return selection.league === 'unranked' ? MARKETS.beforeFirstRound : MARKETS.open;
}

function read(pathname: string, query: URLSearchParams, origin: URL, selection: Selection): Response {
  const me = meResponse(selection.visitor);
  const noSeason = selection.noSeason || selection.league === 'none';
  const season = selection.league === 'early' ? EARLY_SEASON : SEASON;
  if (pathname === '/api/market') {
    return json(200, noSeason ? { market: null, season: null } : { market: marketFor(selection), season });
  }
  if (pathname === '/api/market/prices') {
    return json(200, noSeason ? NO_PRICES : marketPricesResponse(marketFor(selection), selection.league === 'early'));
  }
  if (pathname === '/api/seasons') return json(200, { seasons: noSeason ? [] : [season] });
  if (pathname === '/api/providers') return json(200, PROVIDERS_RESPONSE);
  if (pathname === '/api/league') {
    const division = divisionSchema.safeParse(query.get('division') ?? 'open');
    if (!division.success) return failure('invalid_input', 'Choose the Open or the Pro division.', 'division');
    if (selection.league === 'none') return failure('not_found', MESSAGES.not_found);
    const page = Number(query.get('page') ?? '1');
    const wanted = Number.isInteger(page) && page >= 1 ? page : 1;
    if (selection.league === 'early')
      return json(200, earlyLeagueResponse(division.data, marketFor(selection), wanted));
    return json(200, leagueResponse(selection.league, division.data, marketFor(selection), wanted));
  }
  const agentId = /^\/api\/agents\/([a-z2-7]{12})$/.exec(pathname)?.[1];
  if (agentId) {
    const agent = agentId === EARLY_HOUSE_AGENT.id ? EARLY_HOUSE_AGENT : AGENT_PAGES.get(agentId);
    return agent ? json(200, agent) : failure('not_found', MESSAGES.not_found);
  }
  if (pathname === '/api/siwe/nonce') {
    return json(200, {
      nonce: 'fixtureNonce2026',
      expiresAt: '2026-10-06T15:10:00.000Z',
      domain: origin.host,
      uri: origin.origin,
      chainId: CHAIN_ID,
      statement: SIWE_STATEMENT,
    });
  }
  if (pathname === '/api/me') return me ? json(200, me) : failure('unauthorized', MESSAGES.unauthorized);
  if (pathname === '/api/admin/holds') {
    if (!me) return failure('unauthorized', MESSAGES.unauthorized);
    return me.isAdmin ? json(200, selection.holds) : failure('forbidden', MESSAGES.forbidden);
  }
  return failure('not_found', MESSAGES.not_found);
}

function write(call: ApiCall, pathname: string, selection: Selection): Response {
  if (selection.writeError) {
    const field = selection.writeError === 'invalid_input' ? 'name' : null;
    return failure(selection.writeError, MESSAGES[selection.writeError], field);
  }
  if (call.method === 'POST' && pathname === '/api/siwe/verify') {
    const input = parseBody(verifyInputSchema, call.body);
    return 'response' in input ? input.response : json(200, { address: SLOW_COMPOUNDER_OWNER });
  }

  const me = meResponse(selection.visitor);
  if (!me) return failure('unauthorized', MESSAGES.unauthorized);
  if (call.method === 'POST' && pathname === '/api/siwe/logout') return noContent();

  if (call.method === 'POST' && pathname === '/api/agents') {
    const input = parseBody(createAgentInputSchema, call.body);
    if ('response' in input) return input.response;
    if (me.agent) return failure('owner_has_agent', MESSAGES.owner_has_agent);
    const agent: AgentOwnerView = {
      ...OWNED_AGENT,
      id: fixtureId(input.data.name),
      name: input.data.name,
      division: input.data.division,
      prompt: input.data.prompt,
      summary: null,
      summaryStatus: 'pending',
      modelKeyId: input.data.modelKeyId ?? null,
      createdAt: '2026-10-06T15:06:00.000Z',
      lastDecision: null,
    };
    return json(201, { agent });
  }
  if (call.method === 'PATCH' && pathname === `/api/agents/${SLOW_COMPOUNDER_ID}`) {
    const input = parseBody(updateAgentInputSchema, call.body);
    if ('response' in input) return input.response;
    if (!me.agent) return failure('not_found', MESSAGES.not_found);
    const { name, prompt, promptPublic, paused, modelKeyId } = input.data;
    const agent: AgentOwnerView = { ...me.agent };
    if (name !== undefined) agent.name = name;
    if (prompt !== undefined) {
      agent.prompt = prompt;
      agent.summary = null;
      agent.summaryStatus = 'pending';
    }
    if (promptPublic !== undefined) agent.promptPublic = promptPublic;
    if (paused !== undefined) {
      agent.status = paused ? 'paused' : 'active';
      agent.pausedReason = paused ? 'owner' : null;
    }
    if (modelKeyId !== undefined) agent.modelKeyId = modelKeyId;
    return json(200, { agent });
  }
  if (call.method === 'POST' && pathname === '/api/model-keys') {
    const input = parseBody(createModelKeyInputSchema, call.body);
    if ('response' in input) return input.response;
    const { provider, model, apiKey } = input.data;
    return json(201, {
      modelKey: { ...MODEL_KEY, id: fixtureId('key new'), provider, model, last4: apiKey.slice(-4) },
    });
  }
  if (call.method === 'DELETE' && pathname === `/api/model-keys/${MODEL_KEY.id}`) return noContent();

  if (pathname.startsWith('/api/admin/')) {
    if (!me.isAdmin) return failure('forbidden', MESSAGES.forbidden);
    if (call.method === 'POST' && /^\/api\/admin\/agents\/[a-z2-7]{12}\/hidden$/.test(pathname)) {
      const input = parseBody(setHiddenInputSchema, call.body);
      return 'response' in input ? input.response : noContent();
    }
    if (call.method === 'POST' && pathname === `/api/admin/holds/${HOLDS.holds[0]?.symbol}/release`) return noContent();
  }
  return failure('not_found', MESSAGES.not_found);
}

/**
 * A transport that answers from fixtures. `pageUrl` is the URL of the page being rendered,
 * or of the page a browser script runs on: its `fixture` parameter selects the state.
 */
export function createFixtureTransport(pageUrl: URL): Transport {
  const selection = select(pageUrl);
  return async (call) => {
    if (selection.unknown.length > 0) {
      return failure(
        'internal',
        `Unknown fixture: ${selection.unknown.join(', ')}. Known fixtures: ${FIXTURE_NAMES.join(', ')}.`,
      );
    }
    const target = new URL(call.path, pageUrl.origin);
    if (call.method !== 'GET') return write(call, target.pathname, selection);
    if (selection.failReads) return failure('internal', MESSAGES.internal);
    return read(target.pathname, target.searchParams, pageUrl, selection);
  };
}
