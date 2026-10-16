import type {
  ApiErrorCode,
  TierRuleView,
  TokenConfig,
  TokenInfoResponse,
  TokenMeResponse,
  TokenProbeResponse,
} from '@prix/contracts';

/**
 * Fixtures for the tier page and its client. Reached only when the site is built with
 * PRIX_FIXTURES=1. `?tokenfixture=<name>` on the page URL selects the state (Phase 1's
 * `?fixture=` refuses a name it does not know, so this page uses a parameter of its own):
 *
 *   gating-off   preview: everyone has the open allowance, no token
 *   tier0        gating on, a small holding, one slot used of one, a buy link set
 *   tier1        gating on, tier 1
 *   tier2        gating on, tier 2 with four agents, no buy link
 *   tier3        gating on, tier 3, the last column of "Open to holders now" marked
 *   stale       gating on, tier 1 from an older read because the last read failed
 *   signed-out   every signed-in call answers 401
 *   rate-limited the refresh answers 429
 *   fail         every call answers 500
 *
 * An unknown name makes every call fail, so a typing mistake is seen at once. Beside it, for "Open to
 * holders now" (the holders round): `?ownerholds=off` makes GET /api/token/me/owner-holds answer 404 (the API
 * without B's half), `on` answers the mark on, `refuse` refuses its PUT with 429, and anything else answers it
 * off; `?pictures=off` reads the room's pictures as off; `?holdertiers=missing` leaves tier 3 out of GET
 * /api/token's tiers, so that "Open to holders now" does not show and the tier table stands whole (revision 5,
 * D1).
 */

export interface TokenCall {
  method: 'GET' | 'POST' | 'PUT';
  path: string;
  body?: unknown;
}
export type TokenTransport = (call: TokenCall) => Promise<Response>;

const NAMES = [
  'gating-off',
  'tier0',
  'tier1',
  'tier2',
  'tier3',
  'stale',
  'signed-out',
  'rate-limited',
  'fail',
] as const;
type Name = (typeof NAMES)[number];

const TOKEN = '0x00000000000000000000000000000000000fa11e';
const WALLET = '0x00000000000000000000000000000000000c0ffe';
const SUPPLY = '1000000000000000000000000000';
const THRESHOLDS: [number, number, number] = [10, 100, 1000];

const TIERS: TierRuleView[] = [
  { tier: 0, thresholdPpm: 0, maxAgents: 1, realtimeFeed: false, verifiedBadge: false, apiDailyQuota: 50 },
  { tier: 1, thresholdPpm: 10, maxAgents: 3, realtimeFeed: true, verifiedBadge: false, apiDailyQuota: 500 },
  { tier: 2, thresholdPpm: 100, maxAgents: 10, realtimeFeed: true, verifiedBadge: true, apiDailyQuota: 2000 },
  { tier: 3, thresholdPpm: 1000, maxAgents: 25, realtimeFeed: true, verifiedBadge: true, apiDailyQuota: 5000 },
];

export function tokenFixtureName(url: URL): string {
  return (url.searchParams.get('tokenfixture') ?? 'tier0').trim();
}

function known(name: string): name is Name {
  return (NAMES as readonly string[]).includes(name);
}

export function tokenInfoFixture(url: URL): TokenInfoResponse | null {
  const name = tokenFixtureName(url);
  if (!known(name) || name === 'fail') return null;
  const on = name !== 'gating-off';
  return {
    gatingOn: on,
    tokenAddress: on ? TOKEN : null,
    explorerUrl: on ? `https://robinhoodchain.blockscout.com/token/${TOKEN}` : null,
    buyUrl: name === 'tier0' ? 'https://ponsfamily.com/token/fixture' : null,
    tiers: url.searchParams.get('holdertiers') === 'missing' ? TIERS.filter((rule) => rule.tier !== 3) : TIERS,
    feedDelaySeconds: 86_400,
  };
}

function entitlementsOf(tier: 0 | 1 | 2 | 3, gatingOn: boolean): TokenMeResponse['entitlements'] {
  const rule = TIERS[tier] as TierRuleView;
  return {
    tier,
    maxAgents: rule.maxAgents,
    feedDelaySeconds: rule.realtimeFeed || !gatingOn ? 0 : 86_400,
    verifiedBadge: rule.verifiedBadge,
    apiDailyQuota: rule.apiDailyQuota,
    gatingOn,
  };
}

function meFor(name: Name, now: string): TokenMeResponse {
  const base = { tokenAddress: TOKEN, totalSupply: SUPPLY, decimals: 18, checkedAt: now, stale: false };
  if (name === 'gating-off') {
    return {
      gatingOn: false,
      tokenAddress: null,
      tier: 0,
      entitlements: entitlementsOf(0, false),
      balance: null,
      totalSupply: null,
      decimals: null,
      holdingPpm: null,
      nextTier: null,
      slots: { used: 1, max: 1, pausedForSlots: 0 },
      checkedAt: null,
      stale: false,
    };
  }
  if (name === 'tier3') {
    return {
      ...base,
      gatingOn: true,
      tier: 3,
      entitlements: entitlementsOf(3, true),
      balance: '2000000000000000000000000',
      holdingPpm: 2000,
      nextTier: null,
      slots: { used: 6, max: 25, pausedForSlots: 0 },
    };
  }
  if (name === 'tier2') {
    return {
      ...base,
      gatingOn: true,
      tier: 2,
      entitlements: entitlementsOf(2, true),
      balance: '200000000000000000000000',
      holdingPpm: 200,
      nextTier: { tier: 3, thresholdPpm: 1000, missingPpm: 800 },
      slots: { used: 4, max: 10, pausedForSlots: 0 },
    };
  }
  if (name === 'tier1' || name === 'stale') {
    return {
      ...base,
      gatingOn: true,
      tier: 1,
      entitlements: entitlementsOf(1, true),
      balance: '50000000000000000000000',
      holdingPpm: 50,
      nextTier: { tier: 2, thresholdPpm: 100, missingPpm: 50 },
      slots: { used: 2, max: 3, pausedForSlots: 0 },
      checkedAt: name === 'stale' ? '2026-10-05T08:00:00.000Z' : now,
      stale: name === 'stale',
    };
  }
  return {
    ...base,
    gatingOn: true,
    tier: 0,
    entitlements: entitlementsOf(0, true),
    balance: '5000000000000000000000',
    holdingPpm: 5,
    nextTier: { tier: 1, thresholdPpm: 10, missingPpm: 5 },
    slots: { used: 1, max: 1, pausedForSlots: 0 },
  };
}

const CONFIG: TokenConfig = {
  enabled: false,
  tokenAddress: null,
  thresholdsPpm: THRESHOLDS,
  buyUrl: null,
  activatedAt: null,
  updatedAt: '2026-10-06T00:00:00.000Z',
  updatedBy: 'migration',
};

const STATUS: Record<ApiErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  invalid_input: 400,
  rate_limited: 429,
  name_taken: 409,
  name_not_allowed: 400,
  owner_has_agent: 409,
  league_full: 409,
  key_limit_reached: 409,
  daily_limit: 503,
  no_active_season: 503,
  internal: 500,
};

function failure(code: ApiErrorCode, message: string): Response {
  return Response.json({ error: { code, message, field: null } }, { status: STATUS[code] });
}

/** A transport that answers from fixtures. `pageUrl` is the page being rendered or the page the script runs on. */
export function createTokenFixtureTransport(pageUrl: URL): TokenTransport {
  const name = tokenFixtureName(pageUrl);
  return async (call) => {
    if (!known(name)) return failure('internal', `Unknown token fixture: ${name}`);
    if (name === 'fail') return failure('internal', 'The fixture is set to fail every call.');
    if (name === 'signed-out') return failure('unauthorized', 'Sign in to continue.');
    const now = new Date().toISOString();
    if (call.path === '/api/token/me') return Response.json(meFor(name, now));
    if (call.path === '/api/token/refresh') {
      if (name === 'rate-limited') return failure('rate_limited', 'Checked a moment ago. Try again in a minute.');
      return Response.json(meFor(name === 'stale' ? 'tier1' : name, now));
    }
    if (call.path === '/api/token/me/owner-holds') {
      // `?ownerholds=off`: the API has no B half yet (404); `on`: the mark is on; otherwise it is off.
      const holds = pageUrl.searchParams.get('ownerholds');
      if (holds === 'off') return failure('not_found', 'Not found.');
      if (call.method === 'PUT') {
        if (holds === 'refuse') return failure('rate_limited', 'Too many requests.');
        const show = (call.body as { show?: unknown } | undefined)?.show;
        return typeof show === 'boolean' ? Response.json({ show }) : failure('invalid_input', 'Send { show }.');
      }
      return Response.json({ show: holds === 'on' });
    }
    if (call.path === '/api/admin/token/config') {
      if (call.method === 'PUT') {
        const input = (call.body ?? {}) as Partial<TokenConfig>;
        return Response.json({ config: { ...CONFIG, ...input, updatedAt: now, updatedBy: WALLET } });
      }
      return Response.json({ config: CONFIG });
    }
    if (call.path.startsWith('/api/admin/token/probe')) {
      const probe: TokenProbeResponse = {
        wallet: WALLET,
        tokenAddress: TOKEN,
        tier: 1,
        balance: '50000000000000000000000',
        totalSupply: SUPPLY,
        decimals: 18,
        holdingPpm: 50,
        blockNumber: 1_234_567,
        readAt: now,
      };
      return Response.json(probe);
    }
    return failure('not_found', 'No such fixture route.');
  };
}
