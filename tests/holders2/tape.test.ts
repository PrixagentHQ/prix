import type { DecisionRow, Entitlements, FeedRow, SessionRecord, Store, TapeApiDeps } from '@prix/contracts';
import {
  entitlementsOfTier,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  TAPE_ROWS,
  tapeCacheKey,
  tapeResponseSchema,
} from '@prix/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/http/index.ts';
import { hashToken, newSessionToken } from '../../apps/api/src/http/session.ts';

/**
 * Phase 6.8, H (docs/contracts/phase-6-holders-2.md section 3.1, qa case 10): the tape's attacks, through
 * the real `createApp` with qa's own ports. A tier 0 and a tier 1 viewer, a viewer who claims a tier in
 * every place a request can carry one, an agent linked to Prix Live before and after 20:00 UTC for both,
 * and one shared cache across viewers so a holder's answer can never reach a stranger.
 */

const SITE = 'https://prix.test';
const HOLDER = '0x00000000000000000000000000000000000000a1';
const STRANGER = '0x00000000000000000000000000000000000000a2';
const HOUSE = '0x00000000000000000000000000000000000000a3';
const LINKED = 'linkedagentx';
const PAPER = 'paperagentzz';

function decision(agentId: string, tickId: string, createdAt: string): DecisionRow {
  return {
    agentId,
    tickId,
    seasonId: 'seasonaaaaaa',
    division: 'open',
    status: 'decided',
    code: null,
    targetsBps: {},
    reason: 'Rebalanced.',
    fills: [],
    halted: [],
    equityMicro: 1_000_000,
    costMicro: 0,
    model: null,
    createdAt,
  } as unknown as DecisionRow;
}

const realCaches = (globalThis as { caches?: unknown }).caches;
afterEach(() => {
  (globalThis as { caches?: unknown }).caches = realCaches;
});

function harness(nowIso: string, options: { linksFail?: boolean } = {}) {
  let now = new Date(nowIso);
  const sessions = new Map<string, SessionRecord>();
  const tiers = new Map<string, Entitlements>([
    [HOLDER, entitlementsOfTier(1)],
    [STRANGER, entitlementsOfTier(0)],
  ]);
  const rows: FeedRow[] = [];
  const keys: string[] = [];
  const entries = new Map<string, Response>();
  const waited: Promise<unknown>[] = [];
  let reads = 0;
  (globalThis as { caches?: unknown }).caches = {
    default: {
      async match(key: string) {
        keys.push(String(key));
        return entries.get(String(key))?.clone();
      },
      async put(key: string, response: Response) {
        keys.push(String(key));
        entries.set(String(key), response);
      },
    },
  };
  const deps: TapeApiDeps = {
    store: {
      async getSession(tokenHash: string) {
        return sessions.get(tokenHash) ?? null;
      },
    } as unknown as Store,
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
      async entitlementsFor(address) {
        return (address === null ? undefined : tiers.get(address)) ?? entitlementsOfTier(0);
      },
    },
    follow: {
      async listLeagueFeed(query) {
        reads += 1;
        return rows.filter((row) => row.row.createdAt <= query.notAfter).slice(0, query.limit);
      },
    },
  };
  const app = createApp(deps, {
    tape: deps,
    live: {
      service: null,
      enabled: false,
      links: {
        async linkedAgentIds() {
          if (options.linksFail === true) throw new Error('live_links unreadable');
          return [LINKED];
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
    rows,
    keys,
    entries,
    tiers,
    reads: () => reads,
    setNow(iso: string) {
      now = new Date(iso);
    },
    async signIn(address: string) {
      const token = newSessionToken();
      const tokenHash = await hashToken(token);
      sessions.set(tokenHash, {
        tokenHash,
        address,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + SESSION_TTL_SECONDS * 1000).toISOString(),
      });
      return token;
    },
    async tape(request: { cookie?: string; headers?: Record<string, string>; query?: string } = {}) {
      const headers = new Headers({ 'CF-Connecting-IP': '203.0.113.7', ...(request.headers ?? {}) });
      const cookies = [
        request.cookie === undefined ? null : `${SESSION_COOKIE}=${request.cookie}`,
        request.headers?.Cookie,
      ]
        .filter((part) => part !== null && part !== undefined)
        .join('; ');
      if (cookies !== '') headers.set('Cookie', cookies);
      const response = await app.fetch(
        new Request(`${SITE}/api/tape${request.query ?? ''}`, { headers }),
        ctx as unknown as Parameters<typeof app.fetch>[1],
      );
      await Promise.allSettled(waited);
      return response;
    },
  };
}

const ids = (body: { items: { agentId: string; tickId: string }[] }) =>
  body.items.map((item) => `${item.agentId}@${item.tickId}`).sort();

describe('case 10: the view comes from the server entitlements, never from the request', () => {
  it('a tier 0 viewer claiming tier 3 in a header, a cookie and the query still gets the delayed view', async () => {
    const h = harness('2026-10-20T16:00:00.000Z');
    const cookie = await h.signIn(STRANGER);
    const forged = await h.tape({
      cookie,
      headers: { 'X-Prix-Tier': '3', 'X-Tier': '3', Cookie: 'prix_tier=3; tier=3', 'CF-IPCountry': 'US' },
    });
    expect(forged.status).toBe(200);
    expect(tapeResponseSchema.parse(await forged.json()).view).toBe('delayed');
    expect((await h.tape({ cookie, query: '?view=live' })).status).toBe(400);
    expect((await h.tape({ cookie, query: '?tier=3' })).status).toBe(400);
  });

  it("a holder's live answer, stored in the shared cache, is never served to a tier 0 viewer or a visitor", async () => {
    const h = harness('2026-10-20T16:00:00.000Z');
    h.rows.push({
      agentName: 'Paper',
      owner: HOUSE,
      row: decision(PAPER, '2026-10-20T14:00Z', '2026-10-20T14:01:00.000Z'),
    });
    const live = tapeResponseSchema.parse(await (await h.tape({ cookie: await h.signIn(HOLDER) })).json());
    expect(live.view).toBe('live');
    expect(ids(live)).toEqual([`${PAPER}@2026-10-20T14:00Z`]);
    const stranger = tapeResponseSchema.parse(await (await h.tape({ cookie: await h.signIn(STRANGER) })).json());
    const visitor = tapeResponseSchema.parse(await (await h.tape()).json());
    for (const body of [stranger, visitor]) {
      expect(body.view).toBe('delayed');
      expect(body.items).toEqual([]);
    }
    // Only the two view keys were ever asked or written, none made of the request.
    expect(new Set(h.keys)).toEqual(new Set([tapeCacheKey(SITE, 'live'), tapeCacheKey(SITE, 'delayed')]));
  });

  it('the delayed view cuts at 24 hours: a decision 23 hours old is absent, 24 hours old is present', async () => {
    const h = harness('2026-10-20T16:00:00.000Z');
    h.rows.push({
      agentName: 'A',
      owner: HOUSE,
      row: decision(PAPER, '2026-10-19T17:00Z', '2026-10-19T17:00:00.000Z'),
    });
    h.rows.push({
      agentName: 'B',
      owner: HOUSE,
      row: decision(PAPER, '2026-10-19T16:00Z', '2026-10-19T16:00:00.000Z'),
    });
    const body = tapeResponseSchema.parse(await (await h.tape()).json());
    expect(ids(body)).toEqual([`${PAPER}@2026-10-19T16:00Z`]);
    for (const item of body.items) expect(item.simulated).toBe(true);
  });
});

describe('case 10: an agent linked to Prix Live is held until 20:00 UTC for everyone', () => {
  function withRounds(nowIso: string) {
    const h = harness(nowIso);
    h.rows.push({
      agentName: 'Linked',
      owner: HOLDER,
      row: decision(LINKED, '2026-10-20T15:00Z', '2026-10-20T15:01:00.000Z'),
    });
    h.rows.push({
      agentName: 'Paper',
      owner: HOUSE,
      row: decision(PAPER, '2026-10-20T15:00Z', '2026-10-20T15:01:00.000Z'),
    });
    return h;
  }

  it('before 20:00 UTC: absent for a tier 1 holder who owns it, for tier 0 and for a visitor', async () => {
    const h = withRounds('2026-10-20T19:59:59.000Z');
    const owner = tapeResponseSchema.parse(await (await h.tape({ cookie: await h.signIn(HOLDER) })).json());
    expect(owner.view).toBe('live');
    expect(ids(owner)).toEqual([`${PAPER}@2026-10-20T15:00Z`]);
    const stored = tapeResponseSchema.parse(await h.entries.get(tapeCacheKey(SITE, 'live'))?.clone().json());
    expect(ids(stored)).toEqual([`${PAPER}@2026-10-20T15:00Z`]);
    const tier0 = tapeResponseSchema.parse(await (await h.tape({ cookie: await h.signIn(STRANGER) })).json());
    expect(tier0.items.some((item) => item.agentId === LINKED)).toBe(false);
  });

  it('from 20:00 UTC: present for the holder; still absent for tier 0 until the 24 hours pass', async () => {
    const h = withRounds('2026-10-20T20:00:00.000Z');
    const holder = tapeResponseSchema.parse(await (await h.tape({ cookie: await h.signIn(HOLDER) })).json());
    expect(ids(holder)).toEqual([`${LINKED}@2026-10-20T15:00Z`, `${PAPER}@2026-10-20T15:00Z`]);
    const tier0 = tapeResponseSchema.parse(await (await h.tape({ cookie: await h.signIn(STRANGER) })).json());
    expect(tier0.items).toEqual([]);
    const later = withRounds('2026-10-21T15:01:00.000Z');
    const next = tapeResponseSchema.parse(await (await later.tape({ cookie: await later.signIn(STRANGER) })).json());
    expect(ids(next)).toEqual([`${LINKED}@2026-10-20T15:00Z`, `${PAPER}@2026-10-20T15:00Z`]);
  });

  it('live_links unreadable: every round of today is held, for the holder too, and the stored copy too', async () => {
    const h = harness('2026-10-20T19:00:00.000Z', { linksFail: true });
    h.rows.push({
      agentName: 'Paper',
      owner: HOUSE,
      row: decision(PAPER, '2026-10-20T15:00Z', '2026-10-20T15:01:00.000Z'),
    });
    const holder = tapeResponseSchema.parse(await (await h.tape({ cookie: await h.signIn(HOLDER) })).json());
    expect(holder.items).toEqual([]);
    const stored = h.entries.get(tapeCacheKey(SITE, 'live'));
    if (stored !== undefined) expect(tapeResponseSchema.parse(await stored.clone().json()).items).toEqual([]);
  });

  it('at most TAPE_ROWS items, all simulated, answered private and no-store', async () => {
    const h = harness('2026-10-20T16:00:00.000Z');
    for (let index = 0; index < TAPE_ROWS + 3; index += 1) {
      h.rows.push({
        agentName: 'P',
        owner: HOUSE,
        row: decision(PAPER, '2026-10-18T15:00Z', '2026-10-18T15:01:00.000Z'),
      });
    }
    const reply = await h.tape();
    expect(reply.headers.get('Cache-Control')).toBe('private, no-store');
    const body = tapeResponseSchema.parse(await reply.json());
    expect(body.items).toHaveLength(TAPE_ROWS);
    expect(body.items.every((item) => item.simulated === true)).toBe(true);
  });
});
