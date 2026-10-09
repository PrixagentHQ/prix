import type {
  AgentRecord,
  ApiError,
  Entitlements,
  SeasonMethod,
  SocialApiDeps,
  WarStanding,
  WarStandingsEngine,
} from '@prix/contracts';
import { OPEN_PREVIEW_ENTITLEMENTS, SESSION_COOKIE, SESSION_TTL_SECONDS } from '@prix/contracts';
import { scoring } from '@prix/reputation';
import { sim } from '@prix/sim';
import { createApp } from '../../../apps/api/src/http/index.ts';
import { hashToken, newSessionToken } from '../../../apps/api/src/http/session.ts';
import { createTestVault, FakeRateLimiter } from '../../support/fakes.ts';
import { makeAgent, SEASON_1, startingPortfolio } from '../../support/fixtures.ts';
import type { MemoryStore } from '../../support/memory-store.ts';
import { createMemoryStore } from '../../support/memory-store.ts';
import { FakeSocialStore } from './fake-social-store.ts';

export const SITE = 'https://prix.test';
export const ADMIN = '0x00000000000000000000000000000000000009a1';
export const HOUSE = '0x00000000000000000000000000000000000004a1';
export const START = '2026-10-20T12:00:00.000Z';

export interface Reply {
  status: number;
  headers: Headers;
  text: string;
  // biome-ignore lint/suspicious/noExplicitAny: a test reads whatever the API sent and then checks it against a schema
  json: any;
}

/** The war standings engine is reputation's; this fake returns one schema-valid line per entrant. */
export const fakeWarStandings: WarStandingsEngine = {
  standings(entrants, complete): WarStanding[] {
    return entrants.map(({ entrant, rows }, index) => ({
      slot: entrant.slot,
      modelId: entrant.modelId,
      provider: entrant.provider,
      label: entrant.label,
      maker: entrant.maker,
      rank: complete ? index + 1 : null,
      returnBps: entrant.stats.seasonReturnBps,
      maxDrawdownBps: entrant.stats.maxDrawdownBps,
      tradeCount: entrant.stats.tradeCount,
      days: entrant.days,
      decided: rows.filter((row) => row.status === 'decided').length,
      noDecision: rows.filter((row) => row.status === 'no_decision').length,
      skipped: rows.filter((row) => row.status === 'skipped').length,
      codes: {},
      costMicro: 0,
      neurons: 0,
      v2: { n: 0, meanMilliBps: 0, volMilliBps: 0, ratioMilli: 0, shrinkMilli: 0, scoreMilli: 0 },
      confidence: 'insufficient',
      daily: entrant.stats.daily,
    }));
  },
};

export interface Harness {
  store: MemoryStore;
  social: FakeSocialStore;
  limiter: FakeRateLimiter;
  counters: Map<string, number>;
  methods: Map<string, SeasonMethod>;
  deps: SocialApiDeps;
  entitlements: { value: Entitlements };
  setNow(iso: string): void;
  advance(ms: number): void;
  fetch(method: string, path: string, options?: RequestOptions): Promise<Reply>;
  /** A session cookie for `address`, stored as the sign-in route would store it. */
  signIn(address: string): Promise<string>;
  seedAgent(
    n: number,
    options?: { owner?: string; createdAt?: string; overrides?: Partial<AgentRecord> },
  ): Promise<AgentRecord>;
}

export interface RequestOptions {
  body?: unknown;
  rawBody?: string;
  cookie?: string;
  origin?: string | null;
  contentType?: string | null;
}

export function createHarness(options: { on?: boolean; groqConfigured?: boolean } = {}): Harness {
  let now = new Date(START);
  const store = createMemoryStore([SEASON_1]);
  const social = new FakeSocialStore(store);
  const limiter = new FakeRateLimiter();
  const counters = new Map<string, number>();
  const methods = new Map<string, SeasonMethod>();
  const entitlements = { value: OPEN_PREVIEW_ENTITLEMENTS };
  const deps: SocialApiDeps = {
    store,
    sim,
    scoring,
    sealer: createTestVault().sealer,
    rateLimiter: limiter,
    config: {
      siteOrigin: SITE,
      adminAddresses: [ADMIN],
      houseModel: '@cf/test/house-model',
      nonceSecret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      houseOwners: [HOUSE],
    },
    now: () => new Date(now.getTime()),
    entitlements: { entitlementsFor: async () => entitlements.value },
    social,
    reputation: {
      async takeCounter(key, cap) {
        const value = counters.get(key) ?? 0;
        if (value >= cap) return false;
        counters.set(key, value + 1);
        return true;
      },
      async giveBackCounter(key) {
        counters.set(key, Math.max(0, (counters.get(key) ?? 0) - 1));
      },
      async getSeasonMethod(seasonId) {
        return { seasonId, method: methods.get(seasonId) ?? 'v1', lengthDays: 28, frozenAt: null };
      },
      // Every wallet of the harness signed in long ago, so no seasoning rule refuses it.
      async getFirstSignIn() {
        return '2020-01-01T00:00:00.000Z';
      },
    },
    warStandings: fakeWarStandings,
    groqConfigured: options.groqConfigured ?? false,
  };

  // The app the Worker serves: createApp mounts the admin routes always, the public ones while the switch is on.
  const app = createApp(deps, {
    socialAdmin: deps,
    ...((options.on ?? true) ? { social: deps } : {}),
  });

  const harness: Harness = {
    store,
    social,
    limiter,
    counters,
    methods,
    deps,
    entitlements,
    setNow(iso) {
      now = new Date(iso);
    },
    advance(ms) {
      now = new Date(now.getTime() + ms);
    },
    async fetch(method, path, request = {}) {
      const changes = method !== 'GET' && method !== 'HEAD';
      const headers = new Headers({ 'CF-Connecting-IP': '203.0.113.9' });
      const origin = request.origin === undefined ? (changes ? SITE : null) : request.origin;
      if (origin !== null) headers.set('Origin', origin);
      const type = request.contentType === undefined ? (changes ? 'application/json' : null) : request.contentType;
      if (type !== null) headers.set('Content-Type', type);
      if (request.cookie !== undefined) headers.set('Cookie', `${SESSION_COOKIE}=${request.cookie}`);
      const body = request.rawBody ?? (request.body === undefined ? undefined : JSON.stringify(request.body));
      const response = await app.fetch(new Request(`${SITE}${path}`, { method, headers, body }));
      const text = await response.text();
      let json: unknown = null;
      try {
        json = text === '' ? null : JSON.parse(text);
      } catch {
        json = null;
      }
      return { status: response.status, headers: response.headers, text, json };
    },
    async signIn(address) {
      const token = newSessionToken();
      const at = now.toISOString();
      const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000).toISOString();
      await store.putSession({ tokenHash: await hashToken(token), address, createdAt: at, expiresAt });
      return token;
    },
    async seedAgent(n, seed = {}) {
      const agent = makeAgent({ n, owner: seed.owner, createdAt: seed.createdAt, overrides: seed.overrides });
      const created = await store.createAgent(
        agent,
        SEASON_1.id,
        startingPortfolio(),
        scoring.initialStats(),
        1000,
        1000,
      );
      if (created !== 'created') throw new Error(`seedAgent: ${created}`);
      return agent;
    },
  };
  return harness;
}

export function errorOf(reply: Reply): ApiError['error'] {
  return (reply.json as ApiError).error;
}
