import type {
  DecisionRow,
  Entitlements,
  EntitlementsReadOptions,
  FeedRow,
  FeedStoreQuery,
  SessionRecord,
  Store,
  TapeApiDeps,
} from '@prix/contracts';
import {
  entitlementsOfTier,
  FEED_DELAY_SECONDS,
  OPEN_PREVIEW_ENTITLEMENTS,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  TAPE_CACHE_SECONDS,
  TAPE_ROWS,
  tapeCacheKey,
  tapeResponseSchema,
} from '@prix/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../index.ts';
import { hashToken, newSessionToken } from '../session.ts';

/**
 * GET /api/tape (docs/contracts/phase-6-holders-2.md section 3.1): the strict empty query, the optional
 * viewer, the view from the entitlements alone, the two cache keys, and the Live hold applied before any
 * answer is stored. Ports in memory, the Cache API faked on `globalThis.caches`.
 */

const SITE = 'https://prix.test';
const HOLDER = '0x00000000000000000000000000000000000000b1';
const STRANGER = '0x00000000000000000000000000000000000000c2';
const HOUSE = '0x00000000000000000000000000000000000000d3';
const LINKED = 'linkedagent2';
const PAPER = 'paperagentaa';

function row(agentId: string, tickId: string, createdAt: string, reason = 'Rebalanced.'): DecisionRow {
  return {
    agentId,
    tickId,
    seasonId: 'seasonaaaaaa',
    division: 'open',
    status: 'decided',
    code: null,
    targetsBps: {},
    reason,
    fills: [],
    halted: [],
    equityMicro: 1_000_000,
    costMicro: 0,
    model: null,
    createdAt,
  } as unknown as DecisionRow;
}

interface FakeCache {
  entries: Map<string, Response>;
  matched: string[];
  put: { key: string; response: Response }[];
  failPut: boolean;
}

interface Harness {
  fetch(options?: { query?: string; cookie?: string; context?: boolean }): Promise<Response>;
  signIn(address: string): Promise<string>;
  setNow(iso: string): void;
  asked: FeedStoreQuery[];
  entitled: { address: string | null; options: EntitlementsReadOptions | undefined }[];
  tiers: Map<string, Entitlements>;
  rows: FeedRow[];
  links: { ids: string[]; fail: boolean };
  cache: FakeCache;
  waited: Promise<unknown>[];
}

const realCaches = (globalThis as { caches?: unknown }).caches;

function harness(options: { mounted?: boolean; gatingOn?: boolean } = {}): Harness {
  let now = new Date('2026-10-20T16:00:00.000Z');
  const sessions = new Map<string, SessionRecord>();
  const asked: FeedStoreQuery[] = [];
  const entitled: Harness['entitled'] = [];
  const tiers = new Map<string, Entitlements>([[HOLDER, entitlementsOfTier(1)]]);
  const rows: FeedRow[] = [];
  const links = { ids: [LINKED], fail: false };
  const cache: FakeCache = { entries: new Map(), matched: [], put: [], failPut: false };
  const waited: Promise<unknown>[] = [];
  const gatingOn = options.gatingOn ?? true;

  (globalThis as { caches?: unknown }).caches = {
    default: {
      async match(key: string) {
        cache.matched.push(String(key));
        const hit = cache.entries.get(String(key));
        return hit === undefined ? undefined : hit.clone();
      },
      async put(key: string, response: Response) {
        if (cache.failPut) throw new Error(`put failed for ${String(key)}`);
        cache.put.push({ key: String(key), response: response.clone() });
        cache.entries.set(String(key), response);
      },
    },
  };

  const store = {
    async getSession(tokenHash: string) {
      return sessions.get(tokenHash) ?? null;
    },
  } as unknown as Store;

  const deps: TapeApiDeps = {
    store,
    sim: {} as TapeApiDeps['sim'],
    scoring: {} as TapeApiDeps['scoring'],
    sealer: {} as TapeApiDeps['sealer'],
    rateLimiter: { allow: async () => true },
    config: {
      siteOrigin: SITE,
      adminAddresses: [],
      houseModel: '@cf/test/house-model',
      nonceSecret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      houseOwners: [HOUSE],
    },
    now: () => new Date(now.getTime()),
    entitlements: {
      async entitlementsFor(address, read) {
        entitled.push({ address, options: read });
        if (!gatingOn) return OPEN_PREVIEW_ENTITLEMENTS;
        return (address === null ? undefined : tiers.get(address)) ?? entitlementsOfTier(0);
      },
    },
    follow: {
      async listLeagueFeed(query) {
        asked.push(query);
        return rows.filter((feedRow) => feedRow.row.createdAt <= query.notAfter).slice(0, query.limit);
      },
    },
  };
  const app = createApp(deps, {
    ...(options.mounted === false ? {} : { tape: deps }),
    live: {
      service: null,
      enabled: false,
      links: {
        async linkedAgentIds() {
          if (links.fail) throw new Error('live_links unreadable');
          return links.ids;
        },
        async link() {
          return { created: false };
        },
        async unlink() {},
      },
    },
  });
  const ctx = {
    waitUntil(promise: Promise<unknown>) {
      waited.push(promise);
    },
    passThroughOnException() {},
    props: {},
  };

  return {
    asked,
    entitled,
    tiers,
    rows,
    links,
    cache,
    waited,
    setNow(iso) {
      now = new Date(iso);
    },
    async signIn(address) {
      const token = newSessionToken();
      const tokenHash = await hashToken(token);
      const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000).toISOString();
      sessions.set(tokenHash, { tokenHash, address, createdAt: now.toISOString(), expiresAt });
      return token;
    },
    async fetch(request = {}) {
      const headers = new Headers({ 'CF-Connecting-IP': '203.0.113.9' });
      if (request.cookie !== undefined) headers.set('Cookie', `${SESSION_COOKIE}=${request.cookie}`);
      const sent = new Request(`${SITE}/api/tape${request.query ?? ''}`, { headers });
      const response = await (request.context === false
        ? app.fetch(sent)
        : app.fetch(sent, ctx as unknown as Parameters<typeof app.fetch>[1]));
      await Promise.allSettled(waited);
      return response;
    },
  };
}

let h: Harness;
beforeEach(() => {
  h = harness();
});
afterEach(() => {
  (globalThis as { caches?: unknown }).caches = realCaches;
});

describe('GET /api/tape', () => {
  it('refuses any query with 400 before anything is read', async () => {
    for (const query of ['?view=live', '?x=1', '?delay=0&view=live']) {
      const reply = await h.fetch({ query, cookie: await h.signIn(HOLDER) });
      expect(reply.status).toBe(400);
      expect(((await reply.json()) as { error: { code: string } }).error.code).toBe('invalid_input');
    }
    expect(h.asked).toEqual([]);
    expect(h.entitled).toEqual([]);
    expect(h.cache.matched).toEqual([]);
  });

  it('gives a visitor with no cookie the delayed view, cut at 24 hours', async () => {
    const reply = await h.fetch();
    expect(reply.status).toBe(200);
    const body = tapeResponseSchema.parse(await reply.json());
    expect(body.view).toBe('delayed');
    expect(body.delay).toEqual({ seconds: FEED_DELAY_SECONDS, gatingOn: true });
    expect(h.entitled).toEqual([{ address: null, options: undefined }]);
    expect(h.asked).toEqual([
      {
        before: null,
        notAfter: new Date(Date.parse('2026-10-20T16:00:00.000Z') - 86_400_000).toISOString(),
        limit: TAPE_ROWS,
      },
    ]);
  });

  it('gives a tier 0 session the delayed view, and a session that is not valid no viewer', async () => {
    await h.fetch({ cookie: await h.signIn(STRANGER) });
    await h.fetch({ cookie: 'not-a-session-token' });
    expect(h.entitled.map((ask) => ask.address)).toEqual([STRANGER, null]);
    expect(h.cache.matched).toEqual([tapeCacheKey(SITE, 'delayed'), tapeCacheKey(SITE, 'delayed')]);
  });

  it('gives a tier 1 session the live view, read without cachedOnly', async () => {
    const reply = await h.fetch({ cookie: await h.signIn(HOLDER) });
    const body = tapeResponseSchema.parse(await reply.json());
    expect(body.view).toBe('live');
    expect(h.entitled).toEqual([{ address: HOLDER, options: undefined }]);
    expect(h.asked[0]?.notAfter).toBe('2026-10-20T16:00:00.000Z');
  });

  it('gives everyone the live view while the gate is off', async () => {
    const off = harness({ gatingOn: false });
    const body = tapeResponseSchema.parse(await (await off.fetch()).json());
    expect(body.view).toBe('live');
    expect(body.delay).toEqual({ seconds: 0, gatingOn: false });
  });

  it('keys the cache by the view alone, never by the request', async () => {
    await h.fetch({ cookie: await h.signIn(HOLDER) });
    await h.fetch();
    expect(h.cache.matched).toEqual([tapeCacheKey(SITE, 'live'), tapeCacheKey(SITE, 'delayed')]);
    expect(h.cache.put.map((entry) => entry.key)).toEqual([tapeCacheKey(SITE, 'live'), tapeCacheKey(SITE, 'delayed')]);
    for (const key of [...h.cache.matched, ...h.cache.put.map((entry) => entry.key)]) {
      expect(key).not.toContain('/api/tape');
      expect(key).not.toContain('?');
    }
  });

  it('stores a miss for TAPE_CACHE_SECONDS and answers private, no-store', async () => {
    h.rows.push({ agentName: 'Paper', owner: HOUSE, row: row(PAPER, '2026-10-18T15:00Z', '2026-10-18T15:01:00.000Z') });
    const reply = await h.fetch();
    expect(reply.headers.get('Cache-Control')).toBe('private, no-store');
    expect(h.cache.put).toHaveLength(1);
    expect(h.cache.put[0]?.response.headers.get('Cache-Control')).toBe(`public, s-maxage=${TAPE_CACHE_SECONDS}`);
    const body = tapeResponseSchema.parse(await reply.json());
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.simulated).toBe(true);
    expect(body.items[0]?.house).toBe(true);
  });

  it('answers a hit from the cache with private, no-store and reads no row', async () => {
    await h.fetch();
    const reads = h.asked.length;
    const reply = await h.fetch();
    expect(reply.status).toBe(200);
    expect(reply.headers.get('Cache-Control')).toBe('private, no-store');
    expect(h.asked.length).toBe(reads);
    tapeResponseSchema.parse(await reply.json());
  });

  it("holds a linked agent's round of today from both views before 20:00 UTC, its owner included", async () => {
    h.tiers.set(HOLDER, entitlementsOfTier(1));
    h.rows.push({
      agentName: 'Linked',
      owner: HOLDER,
      row: row(LINKED, '2026-10-20T15:00Z', '2026-10-20T15:01:00.000Z'),
    });
    h.rows.push({ agentName: 'Paper', owner: HOUSE, row: row(PAPER, '2026-10-20T15:00Z', '2026-10-20T15:01:00.000Z') });
    const live = tapeResponseSchema.parse(await (await h.fetch({ cookie: await h.signIn(HOLDER) })).json());
    expect(live.items.map((item) => item.agentId)).toEqual([PAPER]);
    // What was stored is what was answered: the hold came first.
    const stored = tapeResponseSchema.parse(await h.cache.put[0]?.response.clone().json());
    expect(stored.items.map((item) => item.agentId)).toEqual([PAPER]);

    const later = harness();
    later.rows.push(...h.rows);
    later.setNow('2026-10-20T20:00:00.000Z');
    const after = tapeResponseSchema.parse(await (await later.fetch({ cookie: await later.signIn(HOLDER) })).json());
    expect(after.items.map((item) => item.agentId).sort()).toEqual([LINKED, PAPER].sort());
  });

  it("holds every agent's round of today when live_links cannot be read", async () => {
    h.links.fail = true;
    h.rows.push({ agentName: 'Paper', owner: HOUSE, row: row(PAPER, '2026-10-20T15:00Z', '2026-10-20T15:01:00.000Z') });
    h.rows.push({ agentName: 'Old', owner: HOUSE, row: row(PAPER, '2026-10-19T15:00Z', '2026-10-19T15:01:00.000Z') });
    const reply = await h.fetch({ cookie: await h.signIn(HOLDER) });
    const body = tapeResponseSchema.parse(await reply.json());
    expect(body.items.map((item) => item.tickId)).toEqual(['2026-10-19T15:00Z']);
  });

  it('carries at most TAPE_ROWS items', async () => {
    for (let index = 0; index < TAPE_ROWS + 5; index += 1) {
      h.rows.push({
        agentName: 'Paper',
        owner: HOUSE,
        row: row(PAPER, '2026-10-17T15:00Z', '2026-10-17T15:01:00.000Z'),
      });
    }
    const body = tapeResponseSchema.parse(await (await h.fetch()).json());
    expect(body.items).toHaveLength(TAPE_ROWS);
  });

  it('answers even when the put fails, and stores nothing without a context', async () => {
    h.cache.failPut = true;
    expect((await h.fetch()).status).toBe(200);
    const other = harness();
    expect((await other.fetch({ context: false })).status).toBe(200);
    expect(other.cache.put).toEqual([]);
  });

  it('is the generic 404 when the entry does not give it', async () => {
    const off = harness({ mounted: false });
    const reply = await off.fetch();
    expect(reply.status).toBe(404);
    expect(off.asked).toEqual([]);
  });
});
