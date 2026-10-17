import type {
  Address,
  ApiError,
  EntitlementsPort,
  HolderPoll,
  PollApiDeps,
  PollStore,
  PollTallyJobDeps,
  PollTallyOutcome,
  RateLimitRule,
  Tier,
  TokenChainReader,
  TokenConfig,
  TokenHolder,
  TokenStore,
} from '@prix/contracts';
import {
  entitlementsOfTier,
  HOLDER_POLLS,
  OPEN_PREVIEW_ENTITLEMENTS,
  POLL_MAX_VOTERS,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
} from '@prix/contracts';
import { scoring } from '@prix/reputation';
import { createPollHoldingReader } from '@prix/runtime/token/poll-holding';
import { createTokenService, resetTokenMemory } from '@prix/runtime/token/service';
import { sim } from '@prix/sim';
import { createApp } from '../../apps/api/src/http/index.ts';
import { hashToken, newSessionToken } from '../../apps/api/src/http/session.ts';
import { createPollStore } from '../../apps/api/src/store/polls.ts';
import { fakeWarStandings } from '../social/api/harness.ts';
import { db, storesOn } from '../social/support/d1.ts';
import { createTestVault, FakeRateLimiter } from '../support/fakes.ts';

/**
 * What the holders round's qa suites stand on (docs/contracts/phase-6-holders.md section 11): the poll's
 * routes behind `createApp` itself, the real poll store on the local D1 of the Workers tests, the real stores
 * of Phase 2, a limiter that records every asking, and either a recording entitlements port or the real token
 * service on a chain of the test's own. Nothing here comes from the routes' own code but the app.
 */

export const SITE = 'https://prix.test';
export const ADMIN = '0x00000000000000000000000000000000000009a1';
export const HOUSE = '0x00000000000000000000000000000000000004a1';
export const PRIX = '0xa74ac6e9f2f8493344923c23972d496364241044' as Address;
/** 1,000,000,000 whole tokens of 18 decimals. */
export const SUPPLY = 1_000_000_000n * 10n ** 18n;
export const WHOLE = 10n ** 18n;
/** Base units for a tier at the configured thresholds (10, 100 and 1,000 ppm): 10,000, 100,000, 1,000,000 tokens. */
export const AT_TIER: Record<Tier, bigint> = {
  0: 9_999n * WHOLE,
  1: 10_000n * WHOLE,
  2: 100_000n * WHOLE,
  3: 1_000_000n * WHOLE,
};

const FIRST: HolderPoll = (() => {
  const first = HOLDER_POLLS[0];
  if (first === undefined) throw new Error('HOLDER_POLLS holds no poll');
  return first;
})();
/**
 * The first poll's id and dates, read from `HOLDER_POLLS[0]` and never typed (revision 8f, R8E-B1, qa row (8)):
 * a move of the close is then one edit of `HOLDER_POLLS` on the build's branch.
 */
export const POLL = FIRST.id;
export const OPENS = FIRST.opensAt;
export const CLOSES = FIRST.closesAt;
/** Inside the first poll's window, a Saturday 12:10 UTC. */
export const INSIDE = '2026-10-17T12:10:00.000Z';

export function wallet(n: number): Address {
  return `0x${n.toString(16).padStart(40, '0')}` as Address;
}

export interface Reply {
  status: number;
  headers: Headers;
  text: string;
  json: unknown;
}

export function errorOf(reply: Reply): ApiError['error'] {
  const body = reply.json as ApiError | null;
  if (body === null || typeof body !== 'object' || !('error' in body)) throw new Error(`not an error: ${reply.text}`);
  return body.error;
}

/** Every table of the round, read from D1 itself. */
export async function pollTables(pollId = POLL) {
  const votes = await db
    .prepare('SELECT wallet, option_id, created_at FROM poll_votes WHERE poll_id = ? ORDER BY wallet')
    .bind(pollId)
    .all<{ wallet: string; option_id: string; created_at: string }>();
  const counts = await db
    .prepare('SELECT option_id, votes FROM poll_counts WHERE poll_id = ? ORDER BY option_id')
    .bind(pollId)
    .all<{ option_id: string; votes: number }>();
  const grouped = await db
    .prepare(
      'SELECT option_id, COUNT(*) AS votes FROM poll_votes WHERE poll_id = ? GROUP BY option_id ORDER BY option_id',
    )
    .bind(pollId)
    .all<{ option_id: string; votes: number }>();
  const results = await db
    .prepare('SELECT * FROM poll_results WHERE poll_id = ? ORDER BY option_id')
    .bind(pollId)
    .all<Record<string, unknown>>();
  const countsByOption: Record<string, number> = {};
  for (const row of counts.results) if (row.votes !== 0) countsByOption[row.option_id] = row.votes;
  const groupedByOption: Record<string, number> = {};
  for (const row of grouped.results) groupedByOption[row.option_id] = row.votes;
  return {
    votes: votes.results,
    countsByOption,
    groupedByOption,
    sum: counts.results.reduce((total, row) => total + row.votes, 0),
    results: results.results,
  };
}

/** A limiter that records every asking and can refuse one rule. */
export class PollLimiter extends FakeRateLimiter {
  asks(rule: RateLimitRule): number {
    return this.asked.filter((ask) => ask.rule === rule).length;
  }
}

/** The real token service on a store in memory and a chain of the test's own (section 11, C: step 5 checked against it). */
export function tokenWorld(now: () => Date) {
  resetTokenMemory();
  const rows = new Map<string, TokenHolder>();
  const chain = { balances: new Map<string, bigint>(), asked: [] as string[] };
  const stored: TokenConfig = {
    enabled: true,
    tokenAddress: PRIX,
    thresholdsPpm: [10, 100, 1_000],
    buyUrl: null,
    activatedAt: '2026-10-08T18:37:00.000Z',
    updatedAt: '2026-10-08T18:37:00.000Z',
    updatedBy: 'test',
  };
  const store = new Proxy(
    {
      getConfig: async () => structuredClone(stored),
      getHolder: async (address: Address, token: Address) => {
        const row = rows.get(address);
        return row === undefined || row.tokenAddress !== token ? null : { ...row };
      },
      putHolders: async (put: readonly TokenHolder[]) => {
        for (const row of put) rows.set(row.address, { ...row });
      },
      applySlots: async () => ({ paused: 0, resumed: 0 }),
      countOwnerAgents: async () => ({ total: 0, pausedForSlots: 0 }),
    } as Partial<TokenStore> as TokenStore,
    {
      get(target, key, receiver) {
        if (!(key in target)) throw new Error(`unexpected use of the token store: ${String(key)}`);
        return Reflect.get(target, key, receiver);
      },
    },
  );
  const reader: TokenChainReader = {
    async readBalances(_token, wallets) {
      chain.asked.push(...wallets);
      return {
        totalSupply: SUPPLY,
        decimals: 18,
        balances: wallets.map((w) => chain.balances.get(w) ?? 0n),
        blockNumber: 1_000n,
      };
    },
  };
  const service = createTokenService({ store, chain: reader, now });
  return { service, chain, rows };
}

export interface PollHarness {
  deps: PollApiDeps;
  polls: PollStore;
  limiter: PollLimiter;
  gate: { on: boolean };
  tiers: Map<string, Tier>;
  /** Every asking of the entitlements port with whether it asked for the stored row only. */
  tierReads: { address: string; cachedOnly: boolean }[];
  tallied: string[];
  setNow(iso: string): void;
  advance(ms: number): void;
  now(): Date;
  fetch(
    method: string,
    path: string,
    options?: { cookie?: string; origin?: string | null; body?: unknown; rawBody?: string },
  ): Promise<Reply>;
  signIn(address: string): Promise<string>;
}

export function createPollHarness(
  options: {
    on?: boolean;
    now?: string;
    entitlements?: (now: () => Date) => EntitlementsPort;
    tally?: (poll: HolderPoll) => Promise<PollTallyOutcome>;
    /** `ApiDeps.ownerHolds`; absent unless given (section 3: both owner-holds routes then the generic 404). */
    ownerHolds?: unknown;
    /** Mount the token routes (where the owner-holds routes live) even without an owner-holds store. */
    tokenRoutes?: boolean;
    /** Logs of the API, for the owner-holds read's failure line. */
    log?: (event: string, data?: Record<string, unknown>) => void;
  } = {},
): PollHarness {
  let now = new Date(options.now ?? INSIDE);
  const clock = () => new Date(now.getTime());
  const parts = storesOn(db, [HOUSE]);
  const polls = createPollStore(db);
  const limiter = new PollLimiter();
  const gate = { on: true };
  const tiers = new Map<string, Tier>();
  const tierReads: PollHarness['tierReads'] = [];
  const tallied: string[] = [];
  const recording: EntitlementsPort = {
    async entitlementsFor(address, read) {
      tierReads.push({ address: address ?? 'nobody', cachedOnly: read?.cachedOnly === true });
      if (!gate.on) return OPEN_PREVIEW_ENTITLEMENTS;
      return entitlementsOfTier(tiers.get((address ?? '').toLowerCase()) ?? 0);
    },
  };
  const inner = options.entitlements?.(clock);
  const entitlements: EntitlementsPort = inner
    ? {
        async entitlementsFor(address, read) {
          tierReads.push({ address: address ?? 'nobody', cachedOnly: read?.cachedOnly === true });
          return inner.entitlementsFor(address, read);
        },
      }
    : recording;
  const deps = {
    store: parts.store,
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
    now: clock,
    entitlements,
    social: parts.social,
    reputation: parts.reputation,
    warStandings: fakeWarStandings,
    groqConfigured: false,
    ...(options.ownerHolds === undefined ? {} : { ownerHolds: options.ownerHolds }),
    ...(options.log === undefined ? {} : { log: options.log }),
    polls,
    pollsEnabled: options.on ?? true,
    tierOnePpm: async () => 10,
    tally:
      options.tally ??
      (async (poll: HolderPoll) => {
        tallied.push(poll.id);
        return { outcome: 'done', step: null } as PollTallyOutcome;
      }),
  } as unknown as PollApiDeps;
  const app = createApp(deps, {
    polls: deps,
    ...(options.ownerHolds === undefined && options.tokenRoutes !== true
      ? {}
      : { token: { service: tokenWorld(clock).service } }),
  });
  const context = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} };
  return {
    deps,
    polls,
    limiter,
    gate,
    tiers,
    tierReads,
    tallied,
    setNow(iso) {
      now = new Date(iso);
    },
    advance(ms) {
      now = new Date(now.getTime() + ms);
    },
    now: clock,
    async fetch(method, path, request = {}) {
      const changes = method !== 'GET' && method !== 'HEAD';
      const headers = new Headers({ 'CF-Connecting-IP': '203.0.113.9' });
      const origin = request.origin === undefined ? (changes ? SITE : null) : request.origin;
      if (origin !== null) headers.set('Origin', origin);
      if (changes) headers.set('Content-Type', 'application/json');
      if (request.cookie !== undefined) headers.set('Cookie', `${SESSION_COOKIE}=${request.cookie}`);
      const body = request.rawBody ?? (request.body === undefined ? undefined : JSON.stringify(request.body));
      const response = await app.fetch(new Request(`${SITE}${path}`, { method, headers, body }), context as never);
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
      await parts.store.putSession({ tokenHash: await hashToken(token), address, createdAt: at, expiresAt });
      await parts.store.touchUser(address, '2020-01-01T00:00:00.000Z');
      return token;
    },
  };
}

/**
 * A chain whose balances are kept by block: `at(block)` answers what each wallet held at that block (the latest
 * set at or before it). `head` is what a read without a block tag answers. Every call is recorded.
 */
export function blockChain(head: number) {
  const history: { block: number; wallet: string; balance: bigint }[] = [];
  const calls: { wallets: number; atBlock: bigint | number | undefined }[] = [];
  const state = {
    head,
    fail: null as null | ((call: number) => Error | null),
    answerBlock: null as null | ((call: number, asked: number) => number),
  };
  function balanceAt(w: string, block: number): bigint {
    let best: { block: number; balance: bigint } | null = null;
    for (const entry of history) {
      if (entry.wallet === w && entry.block <= block && (best === null || entry.block >= best.block)) best = entry;
    }
    return best?.balance ?? 0n;
  }
  const reader: TokenChainReader = {
    async readBalances(_token, wallets, atBlock?: bigint | number) {
      calls.push({ wallets: wallets.length, atBlock });
      const n = calls.length;
      const failure = state.fail?.(n) ?? null;
      if (failure !== null) throw failure;
      const asked = atBlock === undefined ? state.head : Number(atBlock);
      const answered = state.answerBlock?.(n, asked) ?? asked;
      return {
        totalSupply: SUPPLY,
        decimals: 18,
        balances: wallets.map((w) => balanceAt(w.toLowerCase(), asked)),
        blockNumber: BigInt(answered),
      };
    },
  } as TokenChainReader;
  return {
    reader,
    calls,
    state,
    set(w: string, balance: bigint, block = 0) {
      history.push({ block, wallet: w.toLowerCase(), balance });
    },
  };
}

/** The tally's deps on the real poll store and the real holding reader over `chain`. */
export function tallyDeps(
  chain: TokenChainReader,
  options: {
    now: () => Date;
    delay?: number;
    gatingOn?: boolean;
    holding?: PollTallyJobDeps['holding'];
    /** `PollTallyJobDeps.pollsEnabled` (revision 8e, F3); true unless a test says otherwise. */
    pollsEnabled?: boolean;
  },
) {
  const lines: { event: string; data: Record<string, unknown> | undefined }[] = [];
  const cursors = new Map<string, string>();
  const deps: PollTallyJobDeps = {
    polls: createPollStore(db),
    holding:
      options.holding ??
      createPollHoldingReader({
        chain,
        config: async () => ({
          token: PRIX,
          thresholdsPpm: [10, 100, 1_000] as const,
          gatingOn: options.gatingOn ?? true,
        }),
      }),
    adminAddresses: [ADMIN],
    houseOwners: [HOUSE],
    tallyDelaySeconds: async () => options.delay ?? 0,
    social: {
      async putCursor(cursor) {
        cursors.set(cursor.name, cursor.body);
      },
    },
    reputation: {
      async getJobState(name) {
        return cursors.get(name) ?? null;
      },
    },
    pollsEnabled: options.pollsEnabled ?? true,
    now: options.now,
    log: (event, data) => {
      lines.push({ event, data });
    },
  };
  return { deps, lines, logText: () => JSON.stringify(lines) };
}

/** Seeds votes straight through the real store's batch, as the route stores them. */
export async function seedVotes(store: PollStore, votes: readonly { wallet: Address; option: string; at?: string }[]) {
  for (const vote of votes) {
    const answer = await store.putVote(POLL, vote.wallet, vote.option, vote.at ?? INSIDE, POLL_MAX_VOTERS);
    if (answer !== 'stored') throw new Error(`seedVotes: ${answer}`);
  }
}
