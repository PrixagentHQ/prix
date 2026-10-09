import type {
  AgentFeedResponse,
  AgentPublic,
  AwardsEngine,
  Entitlements,
  EntitlementsPort,
  FeedAgent,
  FeedRow,
  FeedStoreQuery,
  FollowApiDeps,
  FollowStore,
  RecordsReadPort,
} from '@prix/contracts';
import { agentPublicSchema, feedCursorBase, OPEN_PREVIEW_ENTITLEMENTS } from '@prix/contracts';
import { scoring } from '@prix/reputation';
import { sim } from '@prix/sim';
import { expect } from 'vitest';
import { createFeedReadPort } from '../../apps/api/src/http/follow/feed-read.ts';
import { createApp } from '../../apps/api/src/http/index.ts';
import type { Api } from '../support/api.ts';
import {
  ADMIN_WALLET,
  Client,
  createApi,
  expectShape,
  HOUSE_MODEL,
  NONCE_SECRET,
  SITE_ORIGIN,
} from '../support/api.ts';
import type { TestWallet } from '../support/eth.ts';
import { testWallet } from '../support/eth.ts';
import { makeRow, makeTick, utc } from '../support/fixtures.ts';

/** The clock of every follow test. The delay cut of a tier 0 viewer is 2026-10-06T16:00:00.000Z. */
export const FOLLOW_NOW = '2026-10-07T16:00:00.000Z';
export const CUT = '2026-10-06T16:00:00.000Z';

/** Eleven rounds: five on Oct 5, five on Oct 6 and one an hour ago. A row is written one second into its round. */
export const TICK_IDS: readonly string[] = [
  ...[15, 16, 17, 18, 19].map((hour) => `2026-10-05T${hour}:00Z`),
  ...[15, 16, 17, 18, 19].map((hour) => `2026-10-06T${hour}:00Z`),
  '2026-10-07T15:00Z',
];
/** Rounds whose row was written at or before the cut: a tier 0 viewer sees these. */
export const VISIBLE_TICK_IDS: readonly string[] = TICK_IDS.filter((id) => `${id.slice(0, 16)}:01.000Z` <= CUT);

/** An object of which a test implements only some methods. Any other call fails loudly. */
function stub<T extends object>(label: string, methods: Record<string, unknown>): T {
  return new Proxy(methods, {
    get(target, name) {
      const found = target[name as string];
      if (found !== undefined) return found;
      return () => {
        throw new Error(`the stub ${label} has no ${String(name)}`);
      };
    },
  }) as unknown as T;
}

/** An in-memory store for the feed reads: the rows, the agents and the follow sets. */
export class MemoryFeedStore {
  readonly rows: FeedRow[] = [];
  readonly agents = new Map<string, FeedAgent>();
  readonly follows = new Map<string, Set<string>>();

  private page(rows: FeedRow[], query: FeedStoreQuery): FeedRow[] {
    const key = (entry: FeedRow) => feedCursorBase({ tickId: entry.row.tickId, agentId: entry.row.agentId });
    return rows
      .filter((entry) => entry.row.status === 'decided' && entry.row.createdAt <= query.notAfter)
      .filter((entry) => query.sinceTickId === undefined || entry.row.tickId >= query.sinceTickId)
      .filter((entry) => query.before === null || key(entry) < feedCursorBase(query.before))
      .sort((a, b) => (key(a) < key(b) ? 1 : -1))
      .slice(0, query.limit);
  }

  store(): FollowStore {
    return stub<FollowStore>('follow store', {
      getFeedAgent: async (id: string) => this.agents.get(id) ?? null,
      listAgentFeed: async (agentId: string, query: FeedStoreQuery) =>
        this.page(
          this.rows.filter((entry) => entry.row.agentId === agentId),
          query,
        ),
      listFollowFeed: async (address: string, query: FeedStoreQuery) => {
        const followed = this.follows.get(address) ?? new Set<string>();
        return this.page(
          this.rows.filter((entry) => followed.has(entry.row.agentId) && this.agents.has(entry.row.agentId)),
          query,
        );
      },
      // Every agent that is not hidden: a hidden one is not in `agents`.
      listLeagueFeed: async (query: FeedStoreQuery) =>
        this.page(
          this.rows.filter((entry) => this.agents.has(entry.row.agentId)),
          query,
        ),
    });
  }
}

export interface Harness {
  api: Api;
  feedStore: MemoryFeedStore;
  /** A client that is not signed in. */
  anonymous(): Client;
  /** A client signed in with the wallet. */
  as(wallet: TestWallet): Promise<Client>;
  /** An agent with a decided row in every round of TICK_IDS, in both stores. */
  seedAgent(
    n: number,
    options?: { owner?: string; hidden?: boolean; ticks?: readonly string[] },
  ): Promise<{ id: string; name: string }>;
}

export interface HarnessOptions {
  /** What a viewer gets when no entry of `byAddress` applies, and what a visitor who is not signed in gets. */
  base?: Entitlements;
  byAddress?: Record<string, Entitlements>;
  /** `ApiConfig.houseOwners`: the wallets whose agents are house agents. */
  houseOwners?: readonly string[];
  /** Phase 2's read side and the awards engine, for the season results. Left out: stubs that fail the test. */
  records?: RecordsReadPort;
  awards?: AwardsEngine;
}

/**
 * The real HTTP app with the follow routes, over the Phase 1 memory store (sessions, agents,
 * decisions), an in-memory feed store, and an entitlements port the test controls. Awards and
 * records are stubs that fail the test if a feed route touches them.
 */
export function createHarness(options: HarnessOptions = {}): Harness {
  const api = createApi({ now: FOLLOW_NOW });
  const feedStore = new MemoryFeedStore();
  const base = options.base ?? OPEN_PREVIEW_ENTITLEMENTS;
  const entitlements: EntitlementsPort = {
    entitlementsFor: async (address) => (address === null ? base : (options.byAddress?.[address] ?? base)),
  };
  const follow = feedStore.store();
  const deps: FollowApiDeps = {
    store: api.store,
    sim,
    scoring,
    sealer: api.vault.sealer,
    rateLimiter: api.limiter,
    config: {
      siteOrigin: SITE_ORIGIN,
      adminAddresses: [ADMIN_WALLET.address],
      houseModel: HOUSE_MODEL,
      nonceSecret: NONCE_SECRET,
      houseOwners: options.houseOwners,
    },
    now: () => api.now(),
    entitlements,
    follow,
    feed: createFeedReadPort({
      store: follow,
      entitlements,
      now: () => api.now(),
      houseOwners: options.houseOwners,
    }),
    awards: options.awards ?? stub<AwardsEngine>('awards engine', {}),
    records: options.records ?? stub<RecordsReadPort>('records port', {}),
    telegram: null,
  };
  const shim: Api = { ...api, app: createApp(deps, { follow: deps }) };
  let ip = 100;

  const harness: Harness = {
    api: shim,
    feedStore,
    anonymous() {
      ip += 1;
      return new Client(shim, `198.51.100.${ip}`);
    },
    async as(wallet) {
      const signed = await api.signedIn(wallet);
      const client = harness.anonymous();
      client.cookie = signed.cookie;
      return client;
    },
    async seedAgent(n, seed = {}) {
      const agent = await api.seedAgent({
        n,
        owner: seed.owner,
        overrides: seed.hidden ? { hidden: true } : undefined,
      });
      for (const tickId of seed.ticks ?? TICK_IDS) {
        const tick = makeTick(utc(`${tickId.slice(0, 16)}:00.000Z`), { status: 'complete' });
        await api.store.createTick(tick);
        const row = makeRow({ agent, tickId, fillCount: 1 });
        expect(await api.store.writeDecision(row, scoring.initialStats(), 0), `row ${tickId}`).toBe(true);
        // The real store returns the owner with every feed row.
        feedStore.rows.push({ agentName: agent.name, row, owner: agent.owner });
      }
      // The real store answers null for a hidden agent: the fake leaves it out of its agents.
      if (!seed.hidden) {
        feedStore.agents.set(agent.id, {
          id: agent.id,
          name: agent.name,
          division: agent.division,
          owner: agent.owner,
          followers: 0,
        });
      }
      return { id: agent.id, name: agent.name };
    },
  };
  return harness;
}

export function wallet(n: number): TestWallet {
  return testWallet(n);
}

export function followAgent(harness: Harness, address: string, agentId: string): void {
  const set = harness.feedStore.follows.get(address) ?? new Set<string>();
  set.add(agentId);
  harness.feedStore.follows.set(address, set);
}

/** Every page of a feed read, joined, following nextCursor. */
export async function readAll(client: Client, path: string, limit: number): Promise<AgentFeedResponse['items']> {
  const items: AgentFeedResponse['items'] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 50; guard += 1) {
    const query: string = `limit=${limit}${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;
    const reply = await client.get(`${path}?${query}`);
    expect(reply.status, reply.text).toBe(200);
    items.push(...reply.json.items);
    cursor = reply.json.nextCursor;
    if (cursor === null) return items;
  }
  throw new Error('a feed never ended');
}

/** A schema-valid AgentPublic from the real route, for the share tests to change. */
export async function baseAgentPublic(): Promise<AgentPublic> {
  const harness = createHarness();
  const agent = await harness.seedAgent(1, { ticks: ['2026-10-05T15:00Z'] });
  return expectShape(agentPublicSchema, await harness.anonymous().get(`/api/agents/${agent.id}`));
}
