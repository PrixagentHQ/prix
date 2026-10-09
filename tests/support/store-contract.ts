import type {
  AgentRecord,
  AgentStats,
  ModelKeyRecord,
  RankInput,
  RowStatus,
  Season,
  Store,
  SymbolHold,
} from '@prix/contracts';
import {
  leagueStateSchema,
  MAX_AGENTS_OPEN,
  MAX_AGENTS_PRO,
  MAX_MODEL_KEYS_PER_WALLET,
  SCORING_METHOD,
} from '@prix/contracts';
import { scoring } from '@prix/reputation';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  makeAgent,
  makeRow,
  makeSnapshot,
  makeTick,
  SEASON_1,
  startingPortfolio,
  startingStats,
  TEST_PRICES,
  testAddress,
  testId,
  utc,
} from './fixtures.ts';
import { createRng } from './prng.ts';

/**
 * What every `Store` must do, from the comments of `packages/contracts/src/store.ts` and
 * docs/CONTRACTS.md sections 3, 9, 10 and 15. The suite takes a factory, so the same checks
 * run against the in-memory store of the tests (tests/unit/support.memory-store.test.ts) and
 * against the D1 store of `platform` on a local D1 (tests/workers/store.d1.test.ts).
 *
 * It imports nothing from Node, so it also runs inside the Workers runtime.
 */
export interface StoreHarness {
  store: Store;
  seedSeason(season: Season): Promise<void>;
}

const T1 = '2026-10-06T15:00Z';
const T2 = '2026-10-06T16:00Z';
const T3 = '2026-10-06T17:00Z';
const NOW = '2026-10-06T16:00:00.000Z';

function modelKey(n: number, owner: string): ModelKeyRecord {
  return {
    id: testId('key', n),
    owner,
    provider: 'openai',
    model: 'gpt-test',
    last4: 'abcd',
    ciphertext: 'Y2lwaGVydGV4dA==',
    iv: 'AAAAAAAAAAAAAAAB',
    keyVersion: 1,
    createdAt: NOW,
  };
}

const capOf = (agent: AgentRecord): number => (agent.division === 'pro' ? MAX_AGENTS_PRO : MAX_AGENTS_OPEN);

export function describeStoreContract(name: string, create: () => Promise<StoreHarness>): void {
  describe(`Store contract: ${name}`, () => {
    let store: Store;

    beforeEach(async () => {
      const harness = await create();
      store = harness.store;
      await harness.seedSeason(SEASON_1);
    });

    const createAgent = (agent: AgentRecord, max = capOf(agent), maxPerOwner?: number) =>
      store.createAgent(agent, SEASON_1.id, startingPortfolio(), startingStats(), max, maxPerOwner);
    const addAgent = async (agent: AgentRecord): Promise<AgentRecord> => {
      expect(await createAgent(agent)).toBe('created');
      return agent;
    };
    const addKey = async (key: ModelKeyRecord): Promise<ModelKeyRecord> => {
      expect(await store.putModelKey(key, MAX_MODEL_KEYS_PER_WALLET)).toBe('stored');
      return key;
    };
    const addTick = async (tickId: string, daily = false) => {
      const at = utc(`${tickId.slice(0, 16)}:00.000Z`);
      expect(await store.createTick(makeTick(at, { daily }))).toBe(true);
    };
    /** Writes a row with no key failures counted. */
    const write = (row: Parameters<Store['writeDecision']>[0], stats: AgentStats = startingStats(), keyFailures = 0) =>
      store.writeDecision(row, stats, keyFailures);

    describe('sign-in', () => {
      const expiresAt = '2026-10-06T16:05:00.000Z';

      it('records the use of a nonce exactly once', async () => {
        expect(await store.useNonce('nonce-one', expiresAt)).toBe(true);
        expect(await store.useNonce('nonce-one', expiresAt)).toBe(false);
        // Another nonce is not affected.
        expect(await store.useNonce('nonce-two', expiresAt)).toBe(true);
      });

      it('lets exactly one of many simultaneous attempts use a nonce', async () => {
        const results = await Promise.all(Array.from({ length: 20 }, () => store.useNonce('nonce-race', expiresAt)));
        expect(results.filter(Boolean)).toHaveLength(1);
      });

      it('returns a session until it expires or is deleted', async () => {
        const session = {
          tokenHash: 'a'.repeat(64),
          address: testAddress(1),
          createdAt: NOW,
          expiresAt: '2026-10-13T16:00:00.000Z',
        };
        await store.putSession(session);
        expect(await store.getSession(session.tokenHash, NOW)).toEqual(session);
        expect(await store.getSession('b'.repeat(64), NOW)).toBeNull();
        expect(await store.getSession(session.tokenHash, '2026-10-13T16:00:00.001Z')).toBeNull();
        await store.deleteSession(session.tokenHash);
        expect(await store.getSession(session.tokenHash, NOW)).toBeNull();
      });

      it('deletes expired nonces and sessions, and keeps the live ones', async () => {
        expect(await store.useNonce('nonce-dead', '2026-10-06T15:00:00.000Z')).toBe(true);
        expect(await store.useNonce('nonce-live', '2026-10-06T17:00:00.000Z')).toBe(true);
        const live = {
          tokenHash: 'c'.repeat(64),
          address: testAddress(1),
          createdAt: NOW,
          expiresAt: '2026-10-13T16:00:00.000Z',
        };
        const dead = {
          tokenHash: 'd'.repeat(64),
          address: testAddress(2),
          createdAt: NOW,
          expiresAt: '2026-10-06T15:00:00.000Z',
        };
        await store.putSession(live);
        await store.putSession(dead);
        await store.deleteExpired(NOW, 100);
        // A live nonce is still remembered as used. The row of the expired one is gone, which is
        // safe: the API refuses an expired nonce before it ever asks the store.
        expect(await store.useNonce('nonce-live', '2026-10-06T17:00:00.000Z')).toBe(false);
        expect(await store.useNonce('nonce-dead', '2026-10-06T15:00:00.000Z')).toBe(true);
        expect(await store.getSession(live.tokenHash, NOW)).toEqual(live);
        expect(await store.getSession(dead.tokenHash, '2026-10-06T14:00:00.000Z')).toBeNull();
      });

      it('records a wallet once and accepts it again', async () => {
        await store.touchUser(testAddress(1), NOW);
        await expect(store.touchUser(testAddress(1), '2026-10-07T00:00:00.000Z')).resolves.toBeUndefined();
      });
    });

    describe('agents', () => {
      it('creates an agent with its starting portfolio and stats', async () => {
        const agent = await addAgent(makeAgent({ n: 1 }));
        expect(await store.getAgent(agent.id)).toEqual(agent);
        expect(await store.getAgentByOwner(agent.owner)).toEqual(agent);
        expect(await store.getPortfolio(agent.id, SEASON_1.id)).toEqual({
          portfolio: startingPortfolio(),
          stats: startingStats(),
          lastTickId: null,
          rank: null,
          official: null,
        });
        expect(await store.getAgent(testId('agent', 99))).toBeNull();
        expect(await store.getAgentByOwner(testAddress(99))).toBeNull();
      });

      it('applies a patch with an expectation only while the prompt-change counters are the ones read', async () => {
        const agent = await addAgent(
          makeAgent({ n: 1, overrides: { promptChangeDay: '2026-10-06', promptChangeCount: 2 } }),
        );
        const read = { promptChangeDay: '2026-10-06', promptChangeCount: 2 };
        // Two requests read the same count and both try to take the last change of the day.
        expect(await store.updateAgent(agent.id, { promptChangeCount: 3 }, NOW, read)).toBe('updated');
        expect(await store.updateAgent(agent.id, { promptChangeCount: 3, promptPublic: true }, NOW, read)).toBe(
          'changed',
        );
        const stored = await store.getAgent(agent.id);
        expect(stored?.promptChangeCount).toBe(3);
        expect(stored?.promptPublic).toBe(agent.promptPublic);
        // A day that is not the one read is a change too.
        expect(
          await store.updateAgent(agent.id, { promptChangeCount: 1 }, NOW, {
            promptChangeDay: '2026-10-05',
            promptChangeCount: 3,
          }),
        ).toBe('changed');
        expect(
          await store.updateAgent(agent.id, { promptChangeDay: '2026-10-07', promptChangeCount: 1 }, NOW, {
            promptChangeDay: '2026-10-06',
            promptChangeCount: 3,
          }),
        ).toBe('updated');
        // Without an expectation the patch applies as before, and a missing agent is still not_found.
        expect(await store.updateAgent(agent.id, { promptPublic: true }, NOW)).toBe('updated');
        expect(await store.updateAgent(testId('agent', 99), { promptPublic: true }, NOW, read)).toBe('not_found');
      });

      it('keeps the strategy time and the prompt-change count of an agent', async () => {
        const agent = await addAgent(
          makeAgent({
            n: 1,
            overrides: {
              strategyChangedAt: '2026-10-06T09:30:00.000Z',
              promptChangeDay: '2026-10-06',
              promptChangeCount: 2,
            },
          }),
        );
        expect(await store.getAgent(agent.id)).toEqual(agent);
        expect(
          await store.updateAgent(
            agent.id,
            { strategyChangedAt: NOW, promptChangeDay: '2026-10-07', promptChangeCount: 1 },
            NOW,
          ),
        ).toBe('updated');
        expect(await store.getAgent(agent.id)).toEqual({
          ...agent,
          strategyChangedAt: NOW,
          promptChangeDay: '2026-10-07',
          promptChangeCount: 1,
          updatedAt: NOW,
        });
      });

      it('allows one agent per wallet and writes nothing for a second one', async () => {
        const first = await addAgent(makeAgent({ n: 1 }));
        const second = makeAgent({ n: 2, owner: first.owner });
        expect(await createAgent(second)).toBe('owner_has_agent');
        expect(await store.getAgent(second.id)).toBeNull();
        expect(await store.getPortfolio(second.id, SEASON_1.id)).toBeNull();
      });

      it('allows as many agents per wallet as maxPerOwner says, and writes nothing for the next one', async () => {
        const owner = testAddress(8);
        const first = makeAgent({ n: 1, owner });
        expect(await createAgent(first, 200, 2)).toBe('created');
        expect(await createAgent(makeAgent({ n: 2, owner }), 200, 2)).toBe('created');
        const third = makeAgent({ n: 3, owner });
        expect(await createAgent(third, 200, 2)).toBe('owner_has_agent');
        expect(await store.getAgent(third.id)).toBeNull();
        expect(await store.getPortfolio(third.id, SEASON_1.id)).toBeNull();
        // A lower limit refuses a wallet that is already over it, and deletes nothing.
        expect(await createAgent(makeAgent({ n: 4, owner }), 200, 1)).toBe('owner_has_agent');
        expect((await store.getAgentByOwner(owner))?.id).toBe(first.id);
      });

      it('allows one agent per name key', async () => {
        await addAgent(makeAgent({ n: 1, name: 'Slow Compounder' }));
        const clash = makeAgent({ n: 2, name: 'slow-compounder' });
        expect(await createAgent(clash)).toBe('name_taken');
        expect(await store.getAgent(clash.id)).toBeNull();
      });

      it('creates exactly one agent when one wallet sends two requests at once', async () => {
        const owner = testAddress(7);
        const results = await Promise.all([
          createAgent(makeAgent({ n: 1, owner })),
          createAgent(makeAgent({ n: 2, owner })),
        ]);
        expect(results.filter((result) => result === 'created')).toHaveLength(1);
        expect(results.filter((result) => result === 'owner_has_agent')).toHaveLength(1);
      });

      it('takes no more agents than a division may hold, and writes nothing for the one too many', async () => {
        await addAgent(makeAgent({ n: 1 }));
        expect(await createAgent(makeAgent({ n: 2 }), 2)).toBe('created');
        const late = makeAgent({ n: 3 });
        expect(await createAgent(late, 2)).toBe('league_full');
        expect(await store.getAgent(late.id)).toBeNull();
        expect(await store.getAgentByOwner(late.owner)).toBeNull();
        expect(await store.getPortfolio(late.id, SEASON_1.id)).toBeNull();
        expect(await store.listStandings(SEASON_1.id, 'open', 100, 0)).toHaveLength(2);
      });

      it('counts the two divisions apart, and counts paused agents, and a hidden one frees its seat', async () => {
        await addAgent(makeAgent({ n: 1, overrides: { status: 'paused', pausedReason: 'owner' } }));
        await addAgent(makeAgent({ n: 2, overrides: { hidden: true } }));
        // Open holds one agent that counts: the hidden one frees its seat (contract section 15).
        expect(await createAgent(makeAgent({ n: 3 }), 2)).toBe('created');
        expect(await createAgent(makeAgent({ n: 6 }), 2)).toBe('league_full');
        expect(await createAgent(makeAgent({ n: 4, division: 'pro', modelKeyId: testId('key', 4) }), 1)).toBe(
          'created',
        );
        expect(await createAgent(makeAgent({ n: 5, division: 'pro', modelKeyId: testId('key', 5) }), 1)).toBe(
          'league_full',
        );
      });

      it('fills a division exactly to its cap when many wallets join at once', async () => {
        const results = await Promise.all(
          Array.from({ length: 8 }, (_, index) => createAgent(makeAgent({ n: index + 1 }), 3)),
        );
        expect(results.filter((result) => result === 'created')).toHaveLength(3);
        expect(results.filter((result) => result === 'league_full')).toHaveLength(5);
        expect(await store.listStandings(SEASON_1.id, 'open', 100, 0)).toHaveLength(3);
      });

      it('updates only the fields of the patch', async () => {
        const agent = await addAgent(makeAgent({ n: 1 }));
        expect(
          await store.updateAgent(agent.id, { promptPublic: true, summary: null, summaryStatus: 'pending' }, NOW),
        ).toBe('updated');
        expect(await store.getAgent(agent.id)).toEqual({
          ...agent,
          promptPublic: true,
          summary: null,
          summaryStatus: 'pending',
          updatedAt: NOW,
        });
        expect(await store.updateAgent(testId('agent', 99), { promptPublic: true }, NOW)).toBe('not_found');
      });

      it('hides an agent without touching anything else, and shows it again as it was', async () => {
        const agent = await addAgent(makeAgent({ n: 1, overrides: { status: 'paused', pausedReason: 'owner' } }));
        expect(await store.updateAgent(agent.id, { hidden: true }, NOW)).toBe('updated');
        expect(await store.getAgent(agent.id)).toEqual({ ...agent, hidden: true, updatedAt: NOW });
        expect(await store.updateAgent(agent.id, { hidden: false }, NOW)).toBe('updated');
        expect(await store.getAgent(agent.id)).toEqual({ ...agent, updatedAt: NOW });
      });

      it('refuses a rename to a name key that another agent has, and allows its own', async () => {
        const first = await addAgent(makeAgent({ n: 1, name: 'Slow Compounder' }));
        const second = await addAgent(makeAgent({ n: 2, name: 'Fast Trader' }));
        expect(await store.updateAgent(second.id, { name: 'SLOW.COMPOUNDER', nameKey: 'slowcompounder' }, NOW)).toBe(
          'name_taken',
        );
        expect((await store.getAgent(second.id))?.name).toBe('Fast Trader');
        expect(await store.updateAgent(first.id, { name: 'Slow-Compounder', nameKey: 'slowcompounder' }, NOW)).toBe(
          'updated',
        );
      });

      it('lists the active, visible agents that wait for a summary, oldest first', async () => {
        const pending = { summary: null, summaryStatus: 'pending' as const };
        const late = await addAgent(makeAgent({ n: 1, createdAt: '2026-10-05T10:00:00.000Z', overrides: pending }));
        const early = await addAgent(makeAgent({ n: 2, createdAt: '2026-10-05T09:00:00.000Z', overrides: pending }));
        await addAgent(makeAgent({ n: 3, overrides: { ...pending, hidden: true } }));
        await addAgent(makeAgent({ n: 4, overrides: { ...pending, status: 'paused', pausedReason: 'owner' } }));
        await addAgent(makeAgent({ n: 5 }));
        expect((await store.listAgentsNeedingSummary(10)).map((agent) => agent.id)).toEqual([early.id, late.id]);
        expect((await store.listAgentsNeedingSummary(1)).map((agent) => agent.id)).toEqual([early.id]);
      });
    });

    describe('model keys', () => {
      it('stores a key and returns it to its owner only', async () => {
        const key = await addKey(modelKey(1, testAddress(1)));
        expect(await store.getModelKey(key.id, testAddress(1))).toEqual(key);
        expect(await store.getModelKey(key.id, testAddress(2))).toBeNull();
        expect(await store.listModelKeys(testAddress(1))).toEqual([key]);
        expect(await store.listModelKeys(testAddress(2))).toEqual([]);
        expect(await store.getModelKey(testId('key', 9), testAddress(1))).toBeNull();
      });

      it('stores no more keys than a wallet may have, and writes nothing for the one too many', async () => {
        const owner = testAddress(1);
        for (let n = 1; n <= MAX_MODEL_KEYS_PER_WALLET; n += 1) await addKey(modelKey(n, owner));
        const extra = modelKey(8, owner);
        expect(await store.putModelKey(extra, MAX_MODEL_KEYS_PER_WALLET)).toBe('key_limit_reached');
        expect(await store.getModelKey(extra.id, owner)).toBeNull();
        expect(await store.listModelKeys(owner)).toHaveLength(MAX_MODEL_KEYS_PER_WALLET);
        // The cap is per wallet: another wallet still stores a key.
        expect(await store.putModelKey(modelKey(9, testAddress(2)), MAX_MODEL_KEYS_PER_WALLET)).toBe('stored');
        // A deleted key makes room again.
        expect(await store.deleteModelKey(testId('key', 1), owner, NOW)).toBe(true);
        expect(await store.putModelKey(extra, MAX_MODEL_KEYS_PER_WALLET)).toBe('stored');
      });

      it('stores exactly as many keys as the cap when one wallet sends several at once', async () => {
        const owner = testAddress(1);
        const results = await Promise.all(
          Array.from({ length: 6 }, (_, index) => store.putModelKey(modelKey(index + 1, owner), 2)),
        );
        expect(results.filter((result) => result === 'stored')).toHaveLength(2);
        expect(results.filter((result) => result === 'key_limit_reached')).toHaveLength(4);
        expect(await store.listModelKeys(owner)).toHaveLength(2);
      });

      it('does not delete a key for a wallet that does not own it', async () => {
        const key = await addKey(modelKey(1, testAddress(1)));
        expect(await store.deleteModelKey(key.id, testAddress(2), NOW)).toBe(false);
        expect(await store.getModelKey(key.id, testAddress(1))).toEqual(key);
        expect(await store.deleteModelKey(testId('key', 9), testAddress(1), NOW)).toBe(false);
      });

      it('deletes the row, pauses the agent that used the key and clears its key, together', async () => {
        const owner = testAddress(1);
        const key = await addKey(modelKey(1, owner));
        const agent = await addAgent(makeAgent({ n: 1, owner, division: 'pro', modelKeyId: key.id }));
        const other = await addAgent(makeAgent({ n: 2 }));
        expect(await store.deleteModelKey(key.id, owner, NOW)).toBe(true);
        expect(await store.getModelKey(key.id, owner)).toBeNull();
        expect(await store.listModelKeys(owner)).toEqual([]);
        expect(await store.getAgent(agent.id)).toMatchObject({
          status: 'paused',
          pausedReason: 'key_removed',
          modelKeyId: null,
        });
        expect(await store.getAgent(other.id)).toMatchObject({ status: 'active', pausedReason: null });
      });
    });

    describe('seasons, market and ticks', () => {
      it('finds the season that contains a moment, and the latest one that has started', async () => {
        expect(await store.getActiveSeason('2026-10-05T00:00:00.000Z')).toEqual(SEASON_1);
        expect(await store.getActiveSeason('2026-11-01T23:59:59.999Z')).toEqual(SEASON_1);
        expect(await store.getActiveSeason('2026-11-02T00:00:00.000Z')).toBeNull();
        expect(await store.getActiveSeason('2026-10-04T23:59:59.999Z')).toBeNull();
        expect(await store.getLatestStartedSeason('2026-12-25T00:00:00.000Z')).toEqual(SEASON_1);
        expect(await store.getLatestStartedSeason('2026-10-04T23:59:59.999Z')).toBeNull();
        expect(await store.getSeason(SEASON_1.id)).toEqual(SEASON_1);
        expect(await store.listSeasons()).toEqual([SEASON_1]);
      });

      it('keeps one market status, with every closed reason of the contract', async () => {
        expect(await store.getMarketStatus()).toBeNull();
        const status = { open: true, closedReason: null, checkedAt: NOW, lastTickId: T1, halted: ['NVDA'] };
        await store.putMarketStatus(status);
        for (const closedReason of ['feeds_stale', 'rpc_unavailable', 'feed_invalid', 'held_for_review'] as const) {
          await store.putMarketStatus({ ...status, open: false, closedReason });
          expect(await store.getMarketStatus()).toEqual({ ...status, open: false, closedReason });
        }
      });

      it('creates a tick once and never overwrites it', async () => {
        const at = utc('2026-10-06T15:00:10.000Z');
        const first = makeTick(at);
        expect(await store.createTick(first)).toBe(true);
        const second = makeTick(at, {
          daily: true,
          snapshot: makeSnapshot(at, { prices: { ...TEST_PRICES, NVDA: 1 } }),
        });
        expect(await store.createTick(second)).toBe(false);
        expect(await store.getTick(first.id)).toEqual(first);
      });

      it('creates one tick when two steps try at the same moment', async () => {
        const tick = makeTick(utc('2026-10-06T15:00:10.000Z'));
        const results = await Promise.all([store.createTick(tick), store.createTick(tick)]);
        expect(results.filter(Boolean)).toHaveLength(1);
      });

      it('lists processing ticks oldest first, and completes one', async () => {
        await addTick(T2);
        await addTick(T1);
        expect((await store.listProcessingTicks()).map((tick) => tick.id)).toEqual([T1, T2]);
        await store.completeTick(T1, '2026-10-06T15:07:00.000Z');
        expect((await store.listProcessingTicks()).map((tick) => tick.id)).toEqual([T2]);
        expect(await store.getTick(T1)).toMatchObject({ status: 'complete', completedAt: '2026-10-06T15:07:00.000Z' });
        expect((await store.getLatestTick())?.id).toBe(T2);
      });

      it('knows whether a season has its daily tick on a day', async () => {
        await addTick(T1);
        expect(await store.hasDailyTick(SEASON_1.id, '2026-10-06')).toBe(false);
        await addTick(T3, true);
        expect(await store.hasDailyTick(SEASON_1.id, '2026-10-06')).toBe(true);
        expect(await store.hasDailyTick(SEASON_1.id, '2026-10-07')).toBe(false);
      });

      it('lists the prices of the last tick of each earlier trading day, newest first', async () => {
        const tickAt = async (iso: string, nvda: number) => {
          const at = utc(iso);
          await store.createTick(
            makeTick(at, { snapshot: makeSnapshot(at, { prices: { ...TEST_PRICES, NVDA: nvda } }) }),
          );
        };
        await tickAt('2026-10-05T15:00:00.000Z', 100_000_000);
        await tickAt('2026-10-05T19:00:00.000Z', 101_000_000);
        await tickAt('2026-10-06T15:00:00.000Z', 102_000_000);
        await tickAt('2026-10-06T18:00:00.000Z', 103_000_000);
        await tickAt('2026-10-07T15:00:00.000Z', 104_000_000);
        const days = await store.listDailyPrices('2026-10-07', 10);
        expect(days.map((day) => [day.day, day.prices.NVDA])).toEqual([
          ['2026-10-06', 103_000_000],
          ['2026-10-05', 101_000_000],
        ]);
        expect(days[0]?.prices.MSFT).toBe(TEST_PRICES.MSFT);
        expect(await store.listDailyPrices('2026-10-07', 1)).toHaveLength(1);
        expect(await store.listDailyPrices('2026-10-05', 10)).toEqual([]);
      });
    });

    describe('symbols held for review', () => {
      const hold: SymbolHold = {
        symbol: 'NVDA',
        priceMicro: 182_410_000,
        seenPriceMicro: 91_205_000,
        sinceTickId: T2,
        releasedAt: null,
        createdAt: NOW,
      };

      it('keeps the first hold of a symbol and reports whether a delete removed one', async () => {
        await store.putSymbolHold(hold);
        await store.putSymbolHold({ ...hold, priceMicro: 1, seenPriceMicro: 2, sinceTickId: T3 });
        expect(await store.listSymbolHolds()).toEqual([hold]);
        expect(await store.deleteSymbolHold('NVDA')).toBe(true);
        expect(await store.deleteSymbolHold('NVDA')).toBe(false);
        expect(await store.listSymbolHolds()).toEqual([]);
      });

      it('releases a hold once: the row stays, with the time it was released', async () => {
        const releasedAt = '2026-10-06T16:30:00.000Z';
        await store.putSymbolHold(hold);
        expect(await store.releaseSymbolHold('NVDA', releasedAt)).toBe(true);
        expect(await store.listSymbolHolds()).toEqual([{ ...hold, releasedAt }]);
        // Already released, and a symbol that is not held.
        expect(await store.releaseSymbolHold('NVDA', '2026-10-06T16:45:00.000Z')).toBe(false);
        expect(await store.releaseSymbolHold('MSFT', releasedAt)).toBe(false);
        expect(await store.listSymbolHolds()).toEqual([{ ...hold, releasedAt }]);
      });

      it('does not turn a released hold back into a new one', async () => {
        const releasedAt = '2026-10-06T16:30:00.000Z';
        await store.putSymbolHold(hold);
        await store.releaseSymbolHold('NVDA', releasedAt);
        // The symbol is still held as far as the table goes, so a second put does nothing.
        await store.putSymbolHold({ ...hold, priceMicro: 5, seenPriceMicro: 6, sinceTickId: T3 });
        expect(await store.listSymbolHolds()).toEqual([{ ...hold, releasedAt }]);
        expect(await store.deleteSymbolHold('NVDA')).toBe(true);
        expect(await store.listSymbolHolds()).toEqual([]);
      });
    });

    describe('scheduler work', () => {
      it('accepts the small write that proves the database takes writes', async () => {
        await expect(store.touchScheduler(NOW)).resolves.toBeUndefined();
        await expect(store.touchScheduler('2026-10-06T16:01:00.000Z')).resolves.toBeUndefined();
      });

      it('lists the active, visible agents of a division that have no row for the tick', async () => {
        await addTick(T1);
        const open = await addAgent(makeAgent({ n: 1 }));
        const done = await addAgent(makeAgent({ n: 2 }));
        await addAgent(makeAgent({ n: 3, overrides: { status: 'paused', pausedReason: 'owner' } }));
        // Hidden is separate from paused: a hidden agent that is still "active" is not scheduled.
        await addAgent(makeAgent({ n: 4, overrides: { hidden: true } }));
        const pro = await addAgent(makeAgent({ n: 5, division: 'pro', modelKeyId: testId('key', 1) }));
        expect(await write(makeRow({ agent: done, tickId: T1 }))).toBe(true);

        const pendingOpen = await store.listPendingAgents(T1, 'open', 10);
        expect(pendingOpen.map((work) => work.agent.id)).toEqual([open.id]);
        expect(pendingOpen[0]).toEqual({
          agent: open,
          portfolio: startingPortfolio(),
          stats: startingStats(),
          keyFailures: 0,
        });
        expect((await store.listPendingAgents(T1, 'pro', 10)).map((work) => work.agent.id)).toEqual([pro.id]);
        expect(await store.countPendingAgents(T1, 'open')).toBe(1);
        expect(await store.countPendingAgents(T1, 'pro')).toBe(1);
      });

      it('fixes the members of a tick at its snapshot: an agent created at or after it is not in the tick', async () => {
        // The tick is created at 15:00:00.000.
        await addTick(T1);
        const before = await addAgent(makeAgent({ n: 1, createdAt: '2026-10-06T14:59:59.999Z' }));
        await addAgent(makeAgent({ n: 2, createdAt: '2026-10-06T15:00:00.000Z' }));
        await addAgent(makeAgent({ n: 3, createdAt: '2026-10-06T15:20:00.000Z' }));
        expect((await store.listPendingAgents(T1, 'open', 10)).map((work) => work.agent.id)).toEqual([before.id]);
        expect(await store.countPendingAgents(T1, 'open')).toBe(1);

        // At the next tick all three are members.
        await addTick(T2);
        expect(await store.countPendingAgents(T2, 'open')).toBe(3);
      });

      it('keeps an agent whose strategy changed after the snapshot in the tick, for the scheduler to skip', async () => {
        await addTick(T1);
        const changed = await addAgent(
          makeAgent({ n: 1, overrides: { strategyChangedAt: '2026-10-06T15:05:00.000Z' } }),
        );
        const pending = await store.listPendingAgents(T1, 'open', 10);
        expect(pending.map((work) => work.agent.id)).toEqual([changed.id]);
        expect(pending[0]?.agent.strategyChangedAt).toBe('2026-10-06T15:05:00.000Z');
      });

      it('orders pending agents fairly: never asked first, then asked longest ago, ties by id', async () => {
        await addTick(T1);
        await addTick(T2);
        await addTick(T3);
        const a = await addAgent(makeAgent({ n: 1 }));
        const b = await addAgent(makeAgent({ n: 2 }));
        const c = await addAgent(makeAgent({ n: 3 }));
        const d = await addAgent(makeAgent({ n: 4 }));
        const e = await addAgent(makeAgent({ n: 5 }));
        // a decided at T1 and again at T2. b decided at T1 and was skipped at T2.
        // c was only ever skipped. d and e have no rows.
        await write(makeRow({ agent: a, tickId: T1 }));
        await write(makeRow({ agent: b, tickId: T1, status: 'no_decision' }));
        await write(makeRow({ agent: a, tickId: T2 }));
        await write(makeRow({ agent: b, tickId: T2, status: 'skipped' }));
        await write(makeRow({ agent: c, tickId: T2, status: 'skipped' }));

        const order = (await store.listPendingAgents(T3, 'open', 10)).map((work) => work.agent.id);
        // Never asked: c (a skipped row does not count), d, e, by id. Then b (asked at T1), then a (asked at T2).
        expect(order).toEqual([c.id, d.id, e.id, b.id, a.id]);
        expect((await store.listPendingAgents(T3, 'open', 2)).map((work) => work.agent.id)).toEqual([c.id, d.id]);
        expect(await store.countPendingAgents(T3, 'open')).toBe(5);
      });

      it('writes a row with the new portfolio and stats, and refuses a second row for the tick', async () => {
        await addTick(T1);
        const agent = await addAgent(makeAgent({ n: 1 }));
        const portfolio = { cashMicro: 6_000_000_000, holdings: { NVDA: 21_000_000 } };
        const stats: AgentStats = {
          ...startingStats(),
          equityMicro: 9_830_610_000,
          tradeCount: 1,
          decidedCount: 1,
          tradingDays: 1,
          lastDay: '2026-10-06',
          daily: [{ day: '2026-10-06', equityMicro: 9_830_610_000 }],
          seasonReturnBps: -169,
          maxDrawdownBps: 169,
        };
        const row = makeRow({ agent, tickId: T1, portfolio, equityMicro: 9_830_610_000, fillCount: 1 });
        expect(await write(row, stats)).toBe(true);

        const other = makeRow({ agent, tickId: T1, portfolio: { cashMicro: 1, holdings: {} }, equityMicro: 1 });
        expect(await write(other, { ...stats, tradeCount: 99, decidedCount: 2 }, 2)).toBe(false);

        expect(await store.getPortfolio(agent.id, SEASON_1.id)).toEqual({
          portfolio,
          stats,
          lastTickId: T1,
          rank: null,
          official: null,
        });
        expect(await store.listDecisions(agent.id, SEASON_1.id, 10)).toEqual([row]);
        expect(await store.countPendingAgents(T1, 'open')).toBe(0);
      });

      it('applies a decision once when two steps write it at the same moment', async () => {
        await addTick(T1);
        const agent = await addAgent(makeAgent({ n: 1 }));
        const stats = {
          ...startingStats(),
          decidedCount: 1,
          tradingDays: 1,
          lastDay: '2026-10-06',
          daily: [{ day: '2026-10-06', equityMicro: 10_000_000_000 }],
        };
        const row = makeRow({ agent, tickId: T1 });
        const results = await Promise.all([write(row, stats), write(row, stats), write(row, stats)]);
        expect(results.filter(Boolean)).toHaveLength(1);
        expect(await store.listDecisions(agent.id, SEASON_1.id, 10)).toHaveLength(1);
        expect((await store.getPortfolio(agent.id, SEASON_1.id))?.stats.decidedCount).toBe(1);
      });

      it('keeps the rows of an agent in tick order: a row for an earlier tick is refused and writes nothing', async () => {
        await addTick(T1);
        await addTick(T2);
        const agent = await addAgent(makeAgent({ n: 1 }));
        const later = makeRow({ agent, tickId: T2 });
        const laterStats = { ...startingStats(), decidedCount: 1, tradingDays: 1 };
        expect(await write(later, laterStats)).toBe(true);

        const earlier = makeRow({ agent, tickId: T1, portfolio: { cashMicro: 1, holdings: {} }, equityMicro: 1 });
        expect(await write(earlier, { ...startingStats(), decidedCount: 7 }, 2)).toBe(false);
        expect(await store.listDecisions(agent.id, SEASON_1.id, 10)).toEqual([later]);
        expect(await store.getPortfolio(agent.id, SEASON_1.id)).toEqual({
          portfolio: startingPortfolio(),
          stats: laterStats,
          lastTickId: T2,
          rank: null,
          official: null,
        });
        // The earlier tick has nothing left to wait for from this agent.
        expect(await store.countPendingAgents(T1, 'open')).toBe(0);
      });

      it('refuses a row for a season in which the agent has no portfolio, and writes nothing', async () => {
        await addTick(T1);
        const agent = await addAgent(makeAgent({ n: 1 }));
        const elsewhere = { ...makeRow({ agent, tickId: T1 }), seasonId: testId('season', 2) };
        expect(await write(elsewhere, { ...startingStats(), decidedCount: 1 })).toBe(false);
        expect(await store.listDecisions(agent.id, testId('season', 2), 10)).toEqual([]);
        expect(await store.listDecisions(agent.id, SEASON_1.id, 10)).toEqual([]);
        expect((await store.getPortfolio(agent.id, SEASON_1.id))?.stats).toEqual(startingStats());
      });

      it('stores the count of key failures with a row and hands it to the next round', async () => {
        await addTick(T1);
        await addTick(T2);
        await addTick(T3);
        const agent = await addAgent(makeAgent({ n: 1, division: 'pro', modelKeyId: testId('key', 1) }));
        const failures = async (tickId: string) => (await store.listPendingAgents(tickId, 'pro', 10))[0]?.keyFailures;
        expect(await failures(T1)).toBe(0);
        const rejected = { status: 'no_decision' as const, code: 'provider_rejected', model: 'openai:gpt-test' };
        expect(await write(makeRow({ agent, tickId: T1, ...rejected }), startingStats(), 1)).toBe(true);
        expect(await failures(T2)).toBe(1);
        expect(await write(makeRow({ agent, tickId: T2, ...rejected }), startingStats(), 2)).toBe(true);
        expect(await failures(T3)).toBe(2);
        // A row that was refused does not change the count.
        expect(await write(makeRow({ agent, tickId: T2, ...rejected }), startingStats(), 9)).toBe(false);
        expect(await failures(T3)).toBe(2);
        expect(await write(makeRow({ agent, tickId: T3, model: 'openai:gpt-test' }), startingStats(), 0)).toBe(true);
        await addTick('2026-10-06T18:00Z');
        expect(await failures('2026-10-06T18:00Z')).toBe(0);
      });

      it('lists the rows of an agent newest first', async () => {
        await addTick(T1);
        await addTick(T2);
        await addTick(T3);
        const agent = await addAgent(makeAgent({ n: 1 }));
        for (const tickId of [T1, T2, T3]) await write(makeRow({ agent, tickId }));
        expect((await store.listDecisions(agent.id, SEASON_1.id, 10)).map((row) => row.tickId)).toEqual([T3, T2, T1]);
        expect((await store.listDecisions(agent.id, SEASON_1.id, 2)).map((row) => row.tickId)).toEqual([T3, T2]);
      });

      it('returns a row exactly as it was written, with the strategy time and every kind of code', async () => {
        await addTick(T1);
        await addTick(T2);
        await addTick(T3);
        const agent = await addAgent(makeAgent({ n: 1, overrides: { strategyChangedAt: '2026-10-06T09:30:00.000Z' } }));
        const decided = {
          ...makeRow({ agent, tickId: T1, fillCount: 2 }),
          targetsBps: { NVDA: 2_100, MSFT: 1_800 },
          halted: ['TSLA'],
          costMicro: 364_820,
        };
        const failed = makeRow({ agent, tickId: T2, status: 'no_decision', code: 'unknown_symbol' });
        const skipped = makeRow({ agent, tickId: T3, status: 'skipped', code: 'changed_this_round' });
        expect(decided.strategyAt).toBe('2026-10-06T09:30:00.000Z');
        expect(skipped.strategyAt).toBeNull();
        for (const row of [decided, failed, skipped]) expect(await write(row)).toBe(true);
        expect(await store.listDecisions(agent.id, SEASON_1.id, 10)).toEqual([skipped, failed, decided]);
      });
    });

    describe('ranking', () => {
      const rankableStats = (seasonReturnBps: number, extra: Partial<AgentStats> = {}): AgentStats => ({
        ...startingStats(),
        seasonReturnBps,
        tradingDays: 5,
        decidedCount: 3,
        ...extra,
      });

      it('has no league state and no ranks before the first ranking', async () => {
        const agent = await addAgent(makeAgent({ n: 1 }));
        expect(await store.getLeagueState(SEASON_1.id, 'open')).toBeNull();
        expect(await store.listStandings(SEASON_1.id, 'open', 100, 0)).toEqual([
          {
            agentId: agent.id,
            name: agent.name,
            createdAt: agent.createdAt,
            rank: null,
            stats: startingStats(),
            lastTickId: null,
            lastStatus: null,
            summary: agent.summary,
            owner: agent.owner,
            // No row yet: the starting portfolio, and no tick to take prices from.
            portfolio: startingPortfolio(),
            prices: {},
            official: null,
          },
        ]);
      });

      it('gives a standing the portfolio of its latest row and the prices of that row tick (section 17.2)', async () => {
        const pricesAt = (scale: number) =>
          Object.fromEntries(Object.entries(TEST_PRICES).map(([symbol, price]) => [symbol, price * scale]));
        const tickAt = async (tickId: string, prices: Record<string, number>) => {
          const at = utc(`${tickId.slice(0, 16)}:00.000Z`);
          expect(await store.createTick(makeTick(at, { snapshot: makeSnapshot(at, { prices }) }))).toBe(true);
        };
        await tickAt(T1, pricesAt(1));
        await tickAt(T2, pricesAt(2));
        const early = await addAgent(makeAgent({ n: 1 }));
        const late = await addAgent(makeAgent({ n: 2 }));
        const fresh = await addAgent(makeAgent({ n: 3 }));
        const held = { cashMicro: 4_000_000_000, holdings: { NVDA: 20_000_000, AAPL: 7_000_000 } };
        const moved = { cashMicro: 1_000_000_000, holdings: { SPY: 3_000_000 } };
        await write(makeRow({ agent: early, tickId: T1, portfolio: held }));
        await write(makeRow({ agent: late, tickId: T1 }));
        await write(makeRow({ agent: late, tickId: T2, portfolio: moved }));

        const table = await store.listStandings(SEASON_1.id, 'open', 100, 0);
        const byId = new Map(table.map((row) => [row.agentId, row]));
        expect([byId.get(early.id)?.portfolio, byId.get(early.id)?.prices]).toEqual([held, pricesAt(1)]);
        expect([byId.get(late.id)?.portfolio, byId.get(late.id)?.prices]).toEqual([moved, pricesAt(2)]);
        expect([byId.get(fresh.id)?.portfolio, byId.get(fresh.id)?.prices]).toEqual([startingPortfolio(), {}]);

        const one = await store.getStanding(late.id, SEASON_1.id);
        expect([one?.portfolio, one?.prices]).toEqual([moved, pricesAt(2)]);
        const none = await store.getStanding(fresh.id, SEASON_1.id);
        expect([none?.portfolio, none?.prices]).toEqual([startingPortfolio(), {}]);
      });

      it('returns the summary and the owner with a standing, and null for an agent without a summary', async () => {
        const agent = await addAgent(makeAgent({ n: 1 }));
        const waiting = await addAgent(makeAgent({ n: 2, overrides: { summary: null, summaryStatus: 'pending' } }));
        const table = await store.listStandings(SEASON_1.id, 'open', 100, 0);
        expect(new Map(table.map((row) => [row.agentId, [row.summary, row.owner]]))).toEqual(
          new Map([
            [agent.id, [agent.summary, agent.owner]],
            [waiting.id, [null, waiting.owner]],
          ]),
        );
        const one = await store.getStanding(waiting.id, SEASON_1.id);
        expect([one?.summary, one?.owner]).toEqual([null, waiting.owner]);
      });

      it('ranks the visible agents that have a row at the tick and meet both thresholds', async () => {
        await addTick(T1);
        await addTick(T2);
        const leader = await addAgent(makeAgent({ n: 1 }));
        const second = await addAgent(makeAgent({ n: 2 }));
        const paused = await addAgent(makeAgent({ n: 3 }));
        const young = await addAgent(makeAgent({ n: 4 }));
        const hidden = await addAgent(makeAgent({ n: 5 }));
        const pro = await addAgent(makeAgent({ n: 6, division: 'pro', modelKeyId: testId('key', 1) }));
        await write(makeRow({ agent: leader, tickId: T2 }), rankableStats(900));
        await write(makeRow({ agent: second, tickId: T2, status: 'skipped' }), rankableStats(300));
        // The paused agent has the best record but its last row is at the earlier tick.
        await write(makeRow({ agent: paused, tickId: T1 }), rankableStats(5_000));
        await write(makeRow({ agent: young, tickId: T2 }), rankableStats(2_000, { tradingDays: 4 }));
        await write(makeRow({ agent: hidden, tickId: T2 }), rankableStats(9_000));
        await write(makeRow({ agent: pro, tickId: T2 }), rankableStats(7_000));
        await store.updateAgent(hidden.id, { hidden: true }, NOW);

        const state = await store.rerank(SEASON_1.id, 'open', T2, NOW, SCORING_METHOD);
        expect(leagueStateSchema.safeParse(state).success).toBe(true);
        expect(state).toEqual({
          seasonId: SEASON_1.id,
          division: 'open',
          tickId: T2,
          computedAt: NOW,
          method: 'v1',
          rankedCount: 2,
          agentCount: 4,
        });
        expect(await store.getLeagueState(SEASON_1.id, 'open')).toEqual(state);
        expect(await store.getLeagueState(SEASON_1.id, 'pro')).toBeNull();

        const standings = await store.listStandings(SEASON_1.id, 'open', 100, 0);
        expect(standings.map((row) => [row.agentId, row.rank, row.lastTickId, row.lastStatus])).toEqual([
          [leader.id, 1, T2, 'decided'],
          [second.id, 2, T2, 'skipped'],
          [paused.id, null, T1, 'decided'],
          [young.id, null, T2, 'decided'],
        ]);
        expect((await store.getPortfolio(leader.id, SEASON_1.id))?.rank).toBe(1);
        expect((await store.getStanding(second.id, SEASON_1.id))?.rank).toBe(2);
        expect(await store.getStanding(hidden.id, SEASON_1.id)).toBeNull();
        expect((await store.getPortfolio(pro.id, SEASON_1.id))?.rank).toBeNull();
      });

      it('ranks an agent whose latest row is at a later tick than the one being ranked', async () => {
        // What the admin route does: it reranks at the league state's tick while a newer round runs.
        await addTick(T1);
        await addTick(T2);
        const ahead = await addAgent(makeAgent({ n: 1 }));
        const behind = await addAgent(makeAgent({ n: 2 }));
        const gone = await addAgent(makeAgent({ n: 3 }));
        await addTick(T3);
        await write(makeRow({ agent: ahead, tickId: T3 }), rankableStats(100));
        await write(makeRow({ agent: behind, tickId: T2 }), rankableStats(900));
        await write(makeRow({ agent: gone, tickId: T1 }), rankableStats(5_000));
        const state = await store.rerank(SEASON_1.id, 'open', T2, NOW, SCORING_METHOD);
        expect(state).toMatchObject({ tickId: T2, rankedCount: 2, agentCount: 3 });
        expect((await store.listStandings(SEASON_1.id, 'open', 100, 0)).map((row) => [row.agentId, row.rank])).toEqual([
          [behind.id, 1],
          [ahead.id, 2],
          [gone.id, null],
        ]);
      });

      it('gives the same result when it runs twice', async () => {
        await addTick(T2);
        for (let n = 1; n <= 6; n += 1) {
          const agent = await addAgent(makeAgent({ n }));
          await write(makeRow({ agent, tickId: T2 }), rankableStats(n * 10));
        }
        const first = await store.rerank(SEASON_1.id, 'open', T2, NOW, SCORING_METHOD);
        const table = await store.listStandings(SEASON_1.id, 'open', 100, 0);
        const second = await store.rerank(SEASON_1.id, 'open', T2, NOW, SCORING_METHOD);
        expect(second).toEqual(first);
        expect(await store.listStandings(SEASON_1.id, 'open', 100, 0)).toEqual(table);
      });

      it('takes the rank away from an agent that is hidden, at the next ranking, and gives it back', async () => {
        await addTick(T2);
        const a = await addAgent(makeAgent({ n: 1 }));
        const b = await addAgent(makeAgent({ n: 2 }));
        await write(makeRow({ agent: a, tickId: T2 }), rankableStats(900));
        await write(makeRow({ agent: b, tickId: T2 }), rankableStats(100));
        await store.rerank(SEASON_1.id, 'open', T2, NOW, SCORING_METHOD);
        await store.updateAgent(a.id, { hidden: true }, NOW);
        const state = await store.rerank(SEASON_1.id, 'open', T2, NOW, SCORING_METHOD);
        expect(state).toMatchObject({ rankedCount: 1, agentCount: 1 });
        const table = async () =>
          (await store.listStandings(SEASON_1.id, 'open', 100, 0)).map((row) => [row.agentId, row.rank]);
        expect(await table()).toEqual([[b.id, 1]]);
        await store.updateAgent(a.id, { hidden: false }, NOW);
        expect(await store.rerank(SEASON_1.id, 'open', T2, NOW, SCORING_METHOD)).toMatchObject({
          rankedCount: 2,
          agentCount: 2,
        });
        expect(await table()).toEqual([
          [a.id, 1],
          [b.id, 2],
        ]);
      });

      it('pages through a table with a limit and an offset', async () => {
        await addTick(T2);
        const ids: string[] = [];
        for (let n = 1; n <= 7; n += 1) {
          const agent = await addAgent(makeAgent({ n }));
          ids.push(agent.id);
          await write(makeRow({ agent, tickId: T2 }), rankableStats(1_000 - n, { tradingDays: n <= 4 ? 5 : 1 }));
        }
        await store.rerank(SEASON_1.id, 'open', T2, NOW, SCORING_METHOD);
        const page = async (limit: number, offset: number) =>
          (await store.listStandings(SEASON_1.id, 'open', limit, offset)).map((row) => row.agentId);
        expect(await page(3, 0)).toEqual(ids.slice(0, 3));
        expect(await page(3, 3)).toEqual(ids.slice(3, 6));
        expect(await page(3, 6)).toEqual(ids.slice(6));
        expect(await page(3, 9)).toEqual([]);
      });

      it('orders and ranks exactly as scoring.rankAgents does on the same data', async () => {
        const rng = createRng(501);
        await addTick(T1);
        await addTick(T2);
        const inputs: RankInput[] = [];
        for (let n = 1; n <= 60; n += 1) {
          const agent = await addAgent(makeAgent({ n, createdAt: `2026-10-05T0${rng.int(7, 9)}:00:00.000Z` }));
          const stats: AgentStats = {
            ...startingStats(),
            // Few distinct values, so that every tie-break is exercised.
            seasonReturnBps: rng.int(-2, 2) * 100,
            maxDrawdownBps: rng.int(0, 2) * 50,
            tradeCount: rng.int(0, 2),
            tradingDays: rng.int(4, 6),
            decidedCount: rng.int(2, 4),
          };
          const kind = rng.int(0, 9);
          let lastStatus: RowStatus | null = null;
          if (kind <= 6) {
            lastStatus = rng.pick<RowStatus>(['decided', 'no_decision', 'skipped']);
            await write(makeRow({ agent, tickId: T2, status: lastStatus }), stats);
          } else if (kind <= 8) {
            // Paused since the earlier tick: a row, but not at the tick being ranked.
            await write(makeRow({ agent, tickId: T1 }), stats);
          }
          const stored = kind <= 8 ? stats : startingStats();
          inputs.push({ agentId: agent.id, name: agent.name, createdAt: agent.createdAt, stats: stored, lastStatus });
        }

        const state = await store.rerank(SEASON_1.id, 'open', T2, NOW, SCORING_METHOD);
        const expected = scoring.rankAgents(inputs);
        const standings = await store.listStandings(SEASON_1.id, 'open', 1_000, 0);
        expect(standings.map((row) => row.agentId)).toEqual(expected.map((row) => row.agentId));
        expect(standings.map((row) => row.rank)).toEqual(expected.map((row) => row.rank));
        expect(state.rankedCount).toBe(expected.filter((row) => row.rank !== null).length);
        expect(state.agentCount).toBe(expected.length);
        // The reason the API derives for each row is the one the reference ranking gives.
        expect(
          standings.map((row) =>
            row.rank !== null
              ? null
              : scoring.unrankedReason(row.stats, row.lastTickId !== null && row.lastTickId >= state.tickId),
          ),
        ).toEqual(expected.map((row) => row.unrankedReason));
      });
    });

    describe('budgets', () => {
      it('spends rows from the API write budget of a day and refuses at the limit, taking nothing', async () => {
        expect(await store.spendApiWrites('2026-10-06', 4, 10)).toBe(true);
        expect(await store.spendApiWrites('2026-10-06', 6, 10)).toBe(true);
        // The day is full: one more row is refused, and a refusal takes nothing.
        expect(await store.spendApiWrites('2026-10-06', 1, 10)).toBe(false);
        expect(await store.spendApiWrites('2026-10-07', 8, 10)).toBe(true);
        expect(await store.spendApiWrites('2026-10-07', 3, 10)).toBe(false);
        expect(await store.spendApiWrites('2026-10-07', 2, 10)).toBe(true);
      });

      it('counts the writes of a wallet per day and refuses at the limit', async () => {
        const a = testAddress(1);
        const b = testAddress(2);
        expect(await store.spendWalletWrite(a, '2026-10-06', 2)).toBe(true);
        expect(await store.spendWalletWrite(a, '2026-10-06', 2)).toBe(true);
        expect(await store.spendWalletWrite(a, '2026-10-06', 2)).toBe(false);
        expect(await store.spendWalletWrite(b, '2026-10-06', 2)).toBe(true);
        expect(await store.spendWalletWrite(a, '2026-10-07', 2)).toBe(true);
      });

      it('counts the neurons of the house model per UTC day', async () => {
        expect(await store.getAiNeurons('2026-10-06', 'decision')).toBe(0);
        await store.addAiNeurons('2026-10-06', 'decision', 11);
        await store.addAiNeurons('2026-10-06', 'decision', 12);
        await store.addAiNeurons('2026-10-07', 'decision', 5);
        expect(await store.getAiNeurons('2026-10-06', 'decision')).toBe(23);
        expect(await store.getAiNeurons('2026-10-07', 'decision')).toBe(5);
      });

      it('counts decisions and summaries apart, each against its own count', async () => {
        await store.addAiNeurons('2026-10-06', 'decision', 40);
        expect(await store.getAiNeurons('2026-10-06', 'summary')).toBe(0);
        await store.addAiNeurons('2026-10-06', 'summary', 7.5);
        await store.addAiNeurons('2026-10-06', 'summary', 2);
        expect(await store.getAiNeurons('2026-10-06', 'decision')).toBe(40);
        expect(await store.getAiNeurons('2026-10-06', 'summary')).toBe(9.5);
        expect(await store.getAiNeurons('2026-10-07', 'summary')).toBe(0);
      });
    });

    describe('isolation', () => {
      it('does not let a caller change stored data through an object it passed or received', async () => {
        const agent = makeAgent({ n: 1 });
        const portfolio = startingPortfolio();
        const stats = startingStats();
        await store.createAgent(agent, SEASON_1.id, portfolio, stats, MAX_AGENTS_OPEN);
        portfolio.holdings.NVDA = 5;
        stats.daily.push({ day: '2026-10-06', equityMicro: 1 });
        agent.name = 'Changed After';
        const read = await store.getPortfolio(agent.id, SEASON_1.id);
        expect(read).toEqual({
          portfolio: startingPortfolio(),
          stats: startingStats(),
          lastTickId: null,
          rank: null,
          official: null,
        });
        if (read) read.portfolio.cashMicro = 0;
        expect((await store.getPortfolio(agent.id, SEASON_1.id))?.portfolio.cashMicro).toBe(10_000_000_000);
        expect((await store.getAgent(agent.id))?.name).not.toBe('Changed After');
      });
    });
  });
}
