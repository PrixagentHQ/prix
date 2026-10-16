import type { Address, Tier, TokenChainReader, TokenConfig, TokenHolder, TokenStore } from '@prix/contracts';
import { entitlementsOfTier, TOKEN_CACHE_SECONDS, TOKEN_STALE_GRACE_SECONDS, TokenReadError } from '@prix/contracts';
import { describe, expect, it } from 'vitest';
import { createTokenService, resetTokenMemory } from './service.ts';

/**
 * `holdingOf` of the token service against the comment of `TokenService.holdingOf` in
 * packages/contracts/src/phase4-token.ts and docs/contracts/phase-6-room.md, sections 3 and 6: a wallet's
 * holding in whole tokens for the room, which asks for one whole $PRIX and for no tier.
 *
 * The store and the chain are fakes of the ports; nothing here reaches a network.
 * Run it with `pnpm --filter @prix/runtime test`: the root config collects `tests/**` only.
 */

const TOKEN = `0x${'7'.repeat(40)}` as Address;
const OTHER_TOKEN = `0x${'9'.repeat(40)}` as Address;
/** What a holding could leak: a whole address and a balance. Neither may reach a log line. */
const WALLET_HEX = 'ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12';
const WALLET = `0x${WALLET_HEX}` as Address;
const ONE = 10n ** 18n;
/** A supply of one billion tokens at 18 decimals, as $PRIX has. Tier 1 starts at 10,000 tokens. */
const SUPPLY = 10n ** 27n;
const START = Date.parse('2026-10-11T08:00:00.000Z');
/** The service's own budget of reads on demand for one isolate and one UTC day. */
const ON_DEMAND_READS_PER_DAY = 3000;

interface LogLine {
  event: string;
  data: Record<string, string | number | boolean | null>;
}

/** A fake that holds the given methods only: any other use throws, so the test sees it. */
function only<T extends object>(label: string, methods: Partial<T>): T {
  return new Proxy(methods as T, {
    get(target, key, receiver) {
      if (!(key in target)) throw new Error(`unexpected use of ${label}.${String(key)}`);
      return Reflect.get(target, key, receiver);
    },
  });
}

function harness(configOverride: Partial<TokenConfig> = {}) {
  resetTokenMemory();
  let clock = START;
  const config: TokenConfig = {
    enabled: true,
    tokenAddress: TOKEN,
    thresholdsPpm: [10, 100, 1_000],
    buyUrl: null,
    activatedAt: '2026-10-08T18:37:00.000Z',
    updatedAt: '2026-10-08T18:37:00.000Z',
    updatedBy: 'test',
    ...configOverride,
  };
  const rows = new Map<string, TokenHolder>();
  const counts = { getHolder: 0, getHolders: 0, putHolders: 0, applySlots: 0, reads: 0 };
  const logs: LogLine[] = [];
  const chain = {
    balances: new Map<string, bigint>(),
    decimals: 18,
    totalSupply: SUPPLY,
    /** Set to make every read fail with this error. */
    fail: null as Error | null,
    /** Every wallet a read asked about, in order. */
    asked: [] as string[],
  };

  const store = only<TokenStore>('store', {
    async getConfig() {
      return structuredClone(config);
    },
    async getHolder(address, token) {
      counts.getHolder += 1;
      const row = rows.get(address);
      return row === undefined || row.tokenAddress !== token ? null : { ...row };
    },
    async getHolders(addresses, token) {
      counts.getHolders += 1;
      return addresses.flatMap((address) => {
        const row = rows.get(address);
        return row === undefined || row.tokenAddress !== token ? [] : [{ ...row }];
      });
    },
    async putHolders(put) {
      counts.putHolders += 1;
      for (const row of put) rows.set(row.address, { ...row });
    },
    async applySlots() {
      counts.applySlots += 1;
      return { paused: 0, resumed: 0 };
    },
    async countOwnerAgents() {
      return { total: 0, pausedForSlots: 0 };
    },
  });
  const reader: TokenChainReader = {
    async readBalances(token, wallets) {
      counts.reads += 1;
      chain.asked.push(...wallets);
      if (chain.fail !== null) throw chain.fail;
      if (token !== TOKEN) throw new TokenReadError('invalid_token');
      return {
        totalSupply: chain.totalSupply,
        decimals: chain.decimals,
        balances: wallets.map((wallet) => chain.balances.get(wallet) ?? 0n),
        blockNumber: 1_000n,
      };
    },
  };
  const service = createTokenService({
    store,
    chain: reader,
    now: () => new Date(clock),
    log: (event, data) => {
      logs.push({ event, data });
    },
  });

  return {
    service,
    chain,
    counts,
    logs,
    rows,
    advanceSeconds(seconds: number): void {
      clock += seconds * 1000;
    },
    /** A stored row of WALLET, read `ageSeconds` ago. */
    seed(row: { balance: bigint; ageSeconds: number; decimals?: number; tier?: Tier; token?: Address }): void {
      const tier = row.tier ?? 0;
      rows.set(WALLET, {
        address: WALLET,
        balance: row.balance.toString(),
        totalSupply: SUPPLY.toString(),
        decimals: row.decimals ?? 18,
        tier,
        maxAgents: entitlementsOfTier(tier).maxAgents,
        tokenAddress: row.token ?? TOKEN,
        checkedAt: new Date(clock - row.ageSeconds * 1000).toISOString(),
        riseTier: null,
        riseSince: null,
      });
    },
    /** A second isolate on the same store and chain: the service's memory is empty again. */
    newIsolate(): void {
      resetTokenMemory();
    },
    /** Spends the isolate's whole budget of reads on demand, through `entitlementsFor` of wallets with no row. */
    async spendBudget(): Promise<void> {
      for (let index = 0; index < ON_DEMAND_READS_PER_DAY; index += 1) {
        await service.entitlementsFor(`0x${index.toString(16).padStart(40, '0')}` as Address);
      }
      chain.asked.length = 0;
    },
  };
}

const TWENTY_MINUTES = 20 * 60;

describe('holdingOf while the gate is off', () => {
  it('answers no gate and no tokens, and reads neither a row nor the chain', async () => {
    const h = harness({ enabled: false });
    h.seed({ balance: 50n * ONE, ageSeconds: 60 });
    h.chain.balances.set(WALLET, 50n * ONE);

    expect(await h.service.holdingOf(WALLET)).toMatchObject({ gatingOn: false, tokens: 0 });
    expect(await h.service.holdingOf(WALLET, { cachedOnly: true })).toMatchObject({ gatingOn: false, tokens: 0 });
    expect(h.counts.getHolder).toBe(0);
    expect(h.chain.asked).toEqual([]);
  });

  it('answers the same while no token is configured, as info() does', async () => {
    const h = harness({ enabled: true, tokenAddress: null });

    expect(await h.service.holdingOf(WALLET)).toMatchObject({ gatingOn: false, tokens: 0 });
    expect((await h.service.info()).gatingOn).toBe(false);
    expect(h.chain.asked).toEqual([]);
  });
});

describe('holdingOf from the stored row', () => {
  it('has the gate as info() has it while the gate is on', async () => {
    const h = harness();
    h.seed({ balance: ONE, ageSeconds: 60 });

    const holding = await h.service.holdingOf(WALLET);
    expect(holding.gatingOn).toBe(true);
    expect(holding.gatingOn).toBe((await h.service.info()).gatingOn);
  });

  it.each([
    { name: 'exactly one token', balance: ONE, decimals: 18, tokens: 1 },
    { name: 'one unit less than one token', balance: ONE - 1n, decimals: 18, tokens: 0 },
    { name: 'nothing', balance: 0n, decimals: 18, tokens: 0 },
    { name: 'one unit less than two tokens', balance: 2n * ONE - 1n, decimals: 18, tokens: 1 },
    { name: 'many tokens and a fraction', balance: 123_456_789n * ONE + ONE / 2n, decimals: 18, tokens: 123_456_789 },
    { name: 'one token at 6 decimals', balance: 1_000_000n, decimals: 6, tokens: 1 },
    { name: 'one unit less than one token at 6 decimals', balance: 999_999n, decimals: 6, tokens: 0 },
    { name: 'two and a half tokens at 6 decimals', balance: 2_500_000n, decimals: 6, tokens: 2 },
    { name: 'a token with no decimals', balance: 42n, decimals: 0, tokens: 42 },
    { name: 'one token at 36 decimals', balance: 10n ** 36n, decimals: 36, tokens: 1 },
    { name: 'one unit less than one token at 36 decimals', balance: 10n ** 36n - 1n, decimals: 36, tokens: 0 },
    {
      name: 'more than a number holds: the cap',
      balance: 10n ** 30n,
      decimals: 0,
      tokens: Number.MAX_SAFE_INTEGER,
    },
  ])('counts $name as $tokens', async ({ balance, decimals, tokens }) => {
    const h = harness();
    h.seed({ balance, decimals, ageSeconds: 60 });

    expect(await h.service.holdingOf(WALLET)).toMatchObject({ gatingOn: true, tokens });
    expect(await h.service.holdingOf(WALLET, { cachedOnly: true })).toMatchObject({ gatingOn: true, tokens });
    expect(h.chain.asked).toEqual([]);
  });

  it('answers a number whatever the wallet holds, never above the cap', async () => {
    const h = harness();
    h.seed({ balance: BigInt(Number.MAX_SAFE_INTEGER) * ONE + ONE, ageSeconds: 60 });

    const { tokens } = await h.service.holdingOf(WALLET);
    expect(Number.isSafeInteger(tokens)).toBe(true);
    expect(tokens).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('makes no read for a fresh row', async () => {
    const h = harness();
    h.seed({ balance: 3n * ONE, ageSeconds: TOKEN_CACHE_SECONDS - 1 });
    h.chain.balances.set(WALLET, 9n * ONE);

    expect(await h.service.holdingOf(WALLET)).toMatchObject({ gatingOn: true, tokens: 3 });
    expect(h.chain.asked).toEqual([]);
    expect(h.counts.putHolders).toBe(0);
  });

  it('asks the store and the chain for the wallet in lower case', async () => {
    const h = harness();
    h.seed({ balance: 4n * ONE, ageSeconds: 60 });
    const mixed = `0x${WALLET_HEX.toUpperCase()}` as Address;

    expect(await h.service.holdingOf(mixed, { cachedOnly: true })).toMatchObject({ gatingOn: true, tokens: 4 });
    h.advanceSeconds(TWENTY_MINUTES);
    await h.service.holdingOf(mixed);
    expect(h.chain.asked).toEqual([WALLET]);
  });

  it('treats a row read from another token as no row', async () => {
    const h = harness();
    h.seed({ balance: 5n * ONE, ageSeconds: 60, token: OTHER_TOKEN });

    expect(await h.service.holdingOf(WALLET, { cachedOnly: true })).toMatchObject({ gatingOn: true, tokens: 0 });
  });
});

describe('holdingOf with cachedOnly', () => {
  it('answers 0 for a wallet with no row, and never reads the chain', async () => {
    const h = harness();
    h.chain.balances.set(WALLET, 5n * ONE);

    expect(await h.service.holdingOf(WALLET, { cachedOnly: true })).toMatchObject({ gatingOn: true, tokens: 0 });
    expect(h.chain.asked).toEqual([]);
    expect(h.counts.putHolders).toBe(0);
  });

  it('answers from a row of tier 0 that is twenty minutes old, with no read', async () => {
    const h = harness();
    h.seed({ balance: 2n * ONE, ageSeconds: TWENTY_MINUTES, tier: 0 });
    h.chain.balances.set(WALLET, 9n * ONE);

    expect(await h.service.holdingOf(WALLET, { cachedOnly: true })).toMatchObject({ gatingOn: true, tokens: 2 });
    expect(h.chain.asked).toEqual([]);
  });

  it('answers from a row of any age within the stale grace, and 0 from an older one', async () => {
    const h = harness();
    h.seed({ balance: 2n * ONE, ageSeconds: TOKEN_STALE_GRACE_SECONDS - 1 });
    expect(await h.service.holdingOf(WALLET, { cachedOnly: true })).toMatchObject({ gatingOn: true, tokens: 2 });

    h.advanceSeconds(1);
    expect(await h.service.holdingOf(WALLET, { cachedOnly: true })).toMatchObject({ gatingOn: true, tokens: 0 });
    expect(h.chain.asked).toEqual([]);
  });
});

describe('holdingOf without cachedOnly', () => {
  it('reads a row of tier 0 that is twenty minutes old again, and stores what it read', async () => {
    const h = harness();
    h.seed({ balance: 0n, ageSeconds: TWENTY_MINUTES, tier: 0 });
    h.chain.balances.set(WALLET, 5n * ONE);

    expect(await h.service.holdingOf(WALLET)).toMatchObject({ gatingOn: true, tokens: 5 });
    expect(h.chain.asked).toEqual([WALLET]);
    expect(h.rows.get(WALLET)).toMatchObject({
      balance: (5n * ONE).toString(),
      tier: 0,
      checkedAt: new Date(START).toISOString(),
    });
  });

  it('reads a row again at TOKEN_CACHE_SECONDS, and not a second time while that read is fresh', async () => {
    const h = harness();
    h.seed({ balance: ONE, ageSeconds: TOKEN_CACHE_SECONDS });
    h.chain.balances.set(WALLET, 0n);

    expect(await h.service.holdingOf(WALLET)).toMatchObject({ gatingOn: true, tokens: 0 });
    expect(h.chain.asked).toEqual([WALLET]);

    h.advanceSeconds(TOKEN_CACHE_SECONDS - 1);
    h.chain.balances.set(WALLET, 8n * ONE);
    expect(await h.service.holdingOf(WALLET)).toMatchObject({ gatingOn: true, tokens: 0 });
    expect(h.chain.asked).toEqual([WALLET]);
  });

  it('reads a wallet with no row, and stores one whole token so that a write in another isolate finds it', async () => {
    const h = harness();
    h.chain.balances.set(WALLET, ONE);

    expect(await h.service.holdingOf(WALLET)).toMatchObject({ gatingOn: true, tokens: 1 });
    expect(h.chain.asked).toEqual([WALLET]);

    h.newIsolate();
    expect(await h.service.holdingOf(WALLET, { cachedOnly: true })).toMatchObject({ gatingOn: true, tokens: 1 });
    expect(h.chain.asked).toEqual([WALLET]);
  });

  it('finds, in another isolate, one whole token that the refresh of the Account page read', async () => {
    const h = harness();
    h.chain.balances.set(WALLET, ONE);

    const status = await h.service.statusOf(WALLET, true);
    expect(status).toMatchObject({ tier: 0, balance: ONE.toString() });

    h.newIsolate();
    expect(await h.service.holdingOf(WALLET, { cachedOnly: true })).toMatchObject({ gatingOn: true, tokens: 1 });
    expect(h.chain.asked).toEqual([WALLET]);
  });

  it('writes no row for a wallet that holds less than one token, and does not read it twice within the cache time', async () => {
    const h = harness();
    h.chain.balances.set(WALLET, ONE - 1n);

    expect(await h.service.holdingOf(WALLET)).toMatchObject({ gatingOn: true, tokens: 0 });
    h.advanceSeconds(TOKEN_CACHE_SECONDS - 1);
    expect(await h.service.holdingOf(WALLET)).toMatchObject({ gatingOn: true, tokens: 0 });
    expect(h.chain.asked).toEqual([WALLET]);
    expect(h.counts.putHolders).toBe(0);

    h.advanceSeconds(1);
    h.chain.balances.set(WALLET, ONE);
    expect(await h.service.holdingOf(WALLET)).toMatchObject({ gatingOn: true, tokens: 1 });
    expect(h.chain.asked).toEqual([WALLET, WALLET]);
  });

  it('counts a balance at the first read that shows it, while the tier still waits for its second read', async () => {
    const h = harness();
    h.chain.balances.set(WALLET, 10_000n * ONE);

    expect(await h.service.holdingOf(WALLET)).toMatchObject({ gatingOn: true, tokens: 10_000 });
    expect(h.rows.get(WALLET)).toMatchObject({ tier: 0, riseTier: 1, riseSince: new Date(START).toISOString() });
    expect((await h.service.entitlementsFor(WALLET)).tier).toBe(0);
  });

  it('keeps the tier row right with its read: a holder of tier 1 who sold falls to tier 0 and the slots are matched', async () => {
    const h = harness();
    h.seed({ balance: 10_000n * ONE, ageSeconds: TWENTY_MINUTES, tier: 1 });
    h.chain.balances.set(WALLET, 2n * ONE);

    expect(await h.service.holdingOf(WALLET)).toMatchObject({ gatingOn: true, tokens: 2 });
    expect(h.rows.get(WALLET)).toMatchObject({ tier: 0, maxAgents: entitlementsOfTier(0).maxAgents });
    expect(h.counts.applySlots).toBe(1);
  });
});

describe('holdingOf when the budget of reads on demand is spent', () => {
  it('makes no read and answers from the stored row within the grace', async () => {
    const h = harness();
    await h.spendBudget();
    h.seed({ balance: 6n * ONE, ageSeconds: TWENTY_MINUTES });
    h.chain.balances.set(WALLET, 0n);
    h.logs.length = 0;

    expect(await h.service.holdingOf(WALLET)).toMatchObject({ gatingOn: true, tokens: 6 });
    expect(h.chain.asked).toEqual([]);
    expect(h.logs).toEqual([{ event: 'token_on_demand_spent', data: {} }]);
  });

  it('answers 0 for a row older than the grace and for a wallet with no row', async () => {
    const h = harness();
    await h.spendBudget();
    h.chain.balances.set(WALLET, 6n * ONE);

    expect(await h.service.holdingOf(WALLET)).toMatchObject({ gatingOn: true, tokens: 0 });
    h.seed({ balance: 6n * ONE, ageSeconds: TOKEN_STALE_GRACE_SECONDS });
    expect(await h.service.holdingOf(WALLET)).toMatchObject({ gatingOn: true, tokens: 0 });
    expect(h.chain.asked).toEqual([]);
  });

  it('takes one read from the same budget as entitlementsFor for each read it makes', async () => {
    const h = harness();
    for (let index = 0; index < ON_DEMAND_READS_PER_DAY - 1; index += 1) {
      await h.service.entitlementsFor(`0x${index.toString(16).padStart(40, '0')}` as Address);
    }
    h.chain.asked.length = 0;
    h.seed({ balance: ONE, ageSeconds: TWENTY_MINUTES });
    h.chain.balances.set(WALLET, 2n * ONE);

    expect(await h.service.holdingOf(WALLET)).toMatchObject({ gatingOn: true, tokens: 2 });
    expect(h.chain.asked).toEqual([WALLET]);

    const other = `0x${'c'.repeat(40)}` as Address;
    expect((await h.service.entitlementsFor(other)).tier).toBe(0);
    expect(h.chain.asked).toEqual([WALLET]);
    expect(h.logs).toEqual([{ event: 'token_on_demand_spent', data: {} }]);
  });
});

describe('holdingOf when the read fails', () => {
  it('answers from the stored row inside the grace', async () => {
    const h = harness();
    h.seed({ balance: 7n * ONE, ageSeconds: TWENTY_MINUTES });
    h.chain.fail = new TokenReadError('rpc_unavailable');

    expect(await h.service.holdingOf(WALLET)).toMatchObject({ gatingOn: true, tokens: 7 });
    expect(h.chain.asked).toEqual([WALLET]);
    expect(h.logs).toEqual([{ event: 'token_read_failed', data: { code: 'rpc_unavailable' } }]);
  });

  it('answers 0 from a row outside the grace', async () => {
    const h = harness();
    h.seed({ balance: 7n * ONE, ageSeconds: TOKEN_STALE_GRACE_SECONDS });
    h.chain.fail = new TokenReadError('rpc_unavailable');

    expect(await h.service.holdingOf(WALLET)).toMatchObject({ gatingOn: true, tokens: 0 });
    expect(h.chain.asked).toEqual([WALLET]);
  });

  it('answers 0 for a wallet with no row, and never throws', async () => {
    const h = harness();
    h.chain.fail = new Error('the endpoint hung up');

    expect(await h.service.holdingOf(WALLET)).toMatchObject({ gatingOn: true, tokens: 0 });
    expect(h.logs).toEqual([{ event: 'token_read_failed', data: { code: 'error' } }]);
  });
});

describe('holdingOf and the log', () => {
  it('puts no address and no balance in a log line, whatever the failure says', async () => {
    const balance = 7_654_321n * ONE + 123n;
    const h = harness();
    await h.spendBudget();
    h.logs.length = 0;
    h.seed({ balance, ageSeconds: TWENTY_MINUTES });
    await h.service.holdingOf(WALLET);

    h.newIsolate();
    h.chain.fail = new Error(`balanceOf(${WALLET}) of ${TOKEN} failed after ${balance.toString()}`);
    await h.service.holdingOf(WALLET);
    h.chain.fail = new TokenReadError('invalid_answer');
    h.advanceSeconds(1);
    await h.service.holdingOf(WALLET);

    expect(h.logs.map((line) => line.event)).toEqual([
      'token_on_demand_spent',
      'token_read_failed',
      'token_read_failed',
    ]);
    const text = JSON.stringify(h.logs).toLowerCase();
    expect(text).not.toContain(WALLET_HEX);
    expect(text).not.toContain(TOKEN.slice(2));
    expect(text).not.toContain(balance.toString());
    expect(text).not.toContain('7654321');
    for (const line of h.logs) {
      expect(Object.keys(line.data).every((key) => key === 'code')).toBe(true);
    }
  });
});

/**
 * Phase 6.8 (docs/contracts/phase-6-holders-2.md sections 2.2 and 4.4 step 5; the comment of
 * `TokenService.holdingOf` in phase4-token.ts): `holdingOf` answers the tier column of the row it took
 * `tokens` from, and `checkedAt`, the time of the successful chain read the answer rests on.
 */
describe('holdingOf answers tier and checkedAt (Phase 6.8)', () => {
  const at = (ageSeconds: number): string => new Date(START - ageSeconds * 1000).toISOString();

  it('answers tier 0 and no read while the gate is off', async () => {
    const h = harness({ enabled: false });
    h.seed({ balance: 50_000n * ONE, ageSeconds: 60, tier: 1 });

    expect(await h.service.holdingOf(WALLET)).toEqual({ gatingOn: false, tokens: 0, tier: 0, checkedAt: null });
    expect(await h.service.holdingOf(WALLET, { cachedOnly: true })).toEqual({
      gatingOn: false,
      tokens: 0,
      tier: 0,
      checkedAt: null,
    });
  });

  it('answers the fresh stored row’s tier and its read time', async () => {
    const h = harness();
    h.seed({ balance: 20_000n * ONE, ageSeconds: 60, tier: 1 });

    expect(await h.service.holdingOf(WALLET)).toEqual({ gatingOn: true, tokens: 20_000, tier: 1, checkedAt: at(60) });
    expect(h.chain.asked).toEqual([]);
  });

  it('with cachedOnly answers the row within the grace, and tier 0 with no time outside it or with no row', async () => {
    const h = harness();
    h.seed({ balance: 200_000n * ONE, ageSeconds: TWENTY_MINUTES, tier: 2 });
    expect(await h.service.holdingOf(WALLET, { cachedOnly: true })).toEqual({
      gatingOn: true,
      tokens: 200_000,
      tier: 2,
      checkedAt: at(TWENTY_MINUTES),
    });

    h.seed({ balance: 200_000n * ONE, ageSeconds: TOKEN_STALE_GRACE_SECONDS, tier: 2 });
    expect(await h.service.holdingOf(WALLET, { cachedOnly: true })).toEqual({
      gatingOn: true,
      tokens: 0,
      tier: 0,
      checkedAt: null,
    });

    h.rows.clear();
    expect(await h.service.holdingOf(WALLET, { cachedOnly: true })).toEqual({
      gatingOn: true,
      tokens: 0,
      tier: 0,
      checkedAt: null,
    });
    expect(h.chain.asked).toEqual([]);
  });

  it('answers the settled tier of a read it makes, not the read’s own tier, and the read’s time', async () => {
    const h = harness();
    h.chain.balances.set(WALLET, 20_000n * ONE);

    // A first read of 20,000 tokens: the tier rise waits for a second read an hour later.
    expect(await h.service.holdingOf(WALLET)).toEqual({ gatingOn: true, tokens: 20_000, tier: 0, checkedAt: at(0) });
  });

  it('answers the tier the read settled when a holder sold, at once', async () => {
    const h = harness();
    h.seed({ balance: 20_000n * ONE, ageSeconds: TOKEN_CACHE_SECONDS, tier: 1 });
    h.chain.balances.set(WALLET, 2n * ONE);

    expect(await h.service.holdingOf(WALLET)).toEqual({ gatingOn: true, tokens: 2, tier: 0, checkedAt: at(0) });
  });

  it('answers the memory-only read under one whole token with tier 0 and that read’s time', async () => {
    const h = harness();
    h.chain.balances.set(WALLET, ONE - 1n);
    await h.service.holdingOf(WALLET);
    h.advanceSeconds(60);

    expect(await h.service.holdingOf(WALLET)).toEqual({ gatingOn: true, tokens: 0, tier: 0, checkedAt: at(0) });
    expect(h.counts.putHolders).toBe(0);
  });

  it('answers the old row’s tier and time when the read fails inside the grace', async () => {
    const h = harness();
    h.seed({ balance: 20_000n * ONE, ageSeconds: TWENTY_MINUTES, tier: 1 });
    h.chain.fail = new TokenReadError('rpc_unavailable');

    expect(await h.service.holdingOf(WALLET)).toEqual({
      gatingOn: true,
      tokens: 20_000,
      tier: 1,
      checkedAt: at(TWENTY_MINUTES),
    });
  });

  it('answers tier 0 and no time when the budget is spent and there is no row', async () => {
    const h = harness();
    await h.spendBudget();

    expect(await h.service.holdingOf(WALLET)).toEqual({ gatingOn: true, tokens: 0, tier: 0, checkedAt: null });
  });
});

/**
 * Phase 6.8, revision 3 (security H1; docs/contracts/phase-6-holders-2.md section 4.6 step 3; the comment of
 * `TokenService.refreshHolders`): the lounge sweep's batched read of its members' wallets again.
 */
describe('refreshHolders (Phase 6.8)', () => {
  const walletOf = (index: number): Address => `0x${(index + 1).toString(16).padStart(40, '0')}` as Address;
  const NOW = new Date(START);

  function seedAt(h: ReturnType<typeof harness>, address: Address, tier: Tier, balance: bigint, extra = {}): void {
    h.rows.set(address, {
      address,
      balance: balance.toString(),
      totalSupply: SUPPLY.toString(),
      decimals: 18,
      tier,
      maxAgents: entitlementsOfTier(tier).maxAgents,
      tokenAddress: TOKEN,
      checkedAt: new Date(START - 30 * 3600 * 1000).toISOString(),
      riseTier: null,
      riseSince: null,
      ...extra,
    });
  }

  it('answers null and reads nothing while the gate is off', async () => {
    const h = harness({ enabled: false });
    expect(await h.service.refreshHolders?.([WALLET], NOW)).toBeNull();
    expect(h.counts.reads + h.counts.getHolders + h.counts.putHolders).toBe(0);
  });

  it('answers an empty map and reads nothing for no wallet', async () => {
    const h = harness();
    const answer = await h.service.refreshHolders?.([], NOW);
    expect(answer?.size).toBe(0);
    expect(h.counts.reads + h.counts.getHolders + h.counts.putHolders).toBe(0);
  });

  it('reads every wallet in one chain read, one read of the rows and one store, and calls no applySlots', async () => {
    const h = harness();
    const wallets = [0, 1, 2].map(walletOf);
    for (const wallet of wallets) {
      seedAt(h, wallet, 1, 20_000n * ONE);
      h.chain.balances.set(wallet, 20_000n * ONE);
    }

    const answer = await h.service.refreshHolders?.(wallets, NOW);

    expect(h.counts.reads).toBe(1);
    expect(h.chain.asked).toEqual(wallets);
    expect(h.counts.getHolders).toBe(1);
    expect(h.counts.putHolders).toBe(1);
    expect(h.counts.applySlots).toBe(0);
    expect(h.counts.getHolder).toBe(0);
    expect([...(answer ?? new Map()).entries()]).toEqual(
      wallets.map((wallet) => [wallet, { tier: 1, tokenAddress: TOKEN, checkedAt: NOW.toISOString() }]),
    );
    for (const wallet of wallets) expect(h.rows.get(wallet)?.checkedAt).toBe(NOW.toISOString());
  });

  it('settles each tier as the token sweep does: a fall at once, a rise held, a held rise granted after the hour', async () => {
    const h = harness();
    const [sold, risingNew, risingHeld] = [0, 1, 2].map(walletOf) as [Address, Address, Address];
    seedAt(h, sold, 1, 20_000n * ONE);
    h.chain.balances.set(sold, 5n * ONE);
    seedAt(h, risingNew, 0, 5n * ONE);
    h.chain.balances.set(risingNew, 20_000n * ONE);
    seedAt(h, risingHeld, 0, 20_000n * ONE, {
      riseTier: 1,
      riseSince: new Date(START - 2 * 3600 * 1000).toISOString(),
    });
    h.chain.balances.set(risingHeld, 20_000n * ONE);

    const answer = await h.service.refreshHolders?.([sold, risingNew, risingHeld], NOW);

    expect(answer?.get(sold)?.tier).toBe(0);
    expect(answer?.get(risingNew)?.tier).toBe(0);
    expect(answer?.get(risingHeld)?.tier).toBe(1);
    expect(h.rows.get(sold)?.tier).toBe(0);
    expect(h.rows.get(risingNew)?.riseTier).toBe(1);
    expect(h.rows.get(risingHeld)?.tier).toBe(1);
  });

  it('answers a wallet under one whole token with no row at tier 0 and stores no row for it', async () => {
    const h = harness();
    const wallet = walletOf(0);
    h.chain.balances.set(wallet, ONE - 1n);

    const answer = await h.service.refreshHolders?.([wallet], NOW);

    expect(answer?.get(wallet)).toEqual({ tier: 0, tokenAddress: TOKEN, checkedAt: NOW.toISOString() });
    expect(h.rows.has(wallet)).toBe(false);
  });

  it('reads at most LOUNGE_SWEEP_CHECKS_PER_RUN wallets, in lower case and once each', async () => {
    const h = harness();
    const many = Array.from({ length: 60 }, (_, index) => walletOf(index));
    const upper = WALLET.toUpperCase().replace('0X', '0x') as Address;

    await h.service.refreshHolders?.([upper, WALLET, ...many], NOW);

    expect(h.counts.reads).toBe(1);
    expect(h.chain.asked.length).toBe(50);
    expect(h.chain.asked[0]).toBe(WALLET);
    expect(new Set(h.chain.asked).size).toBe(50);
  });

  it('answers null, writes nothing and logs only a code when the read fails', async () => {
    const h = harness();
    const wallet = walletOf(0);
    seedAt(h, wallet, 1, 20_000n * ONE);
    const before = { ...h.rows.get(wallet) };
    h.chain.fail = new Error(`balanceOf(${WALLET}) of ${TOKEN} failed`);

    expect(await h.service.refreshHolders?.([WALLET, wallet], NOW)).toBeNull();
    expect(h.counts.putHolders).toBe(0);
    expect(h.rows.get(wallet)).toEqual(before);
    expect(h.logs.map((line) => line.event)).toEqual(['token_refresh_failed']);
    expect(JSON.stringify(h.logs).toLowerCase()).not.toContain(WALLET_HEX);
    expect(Object.keys(h.logs[0]?.data ?? {})).toEqual(['code']);
  });

  it('answers null when the chain answers fewer balances than wallets', async () => {
    const wallets = [0, 1].map(walletOf);
    const service = createTokenService({
      store: {
        getConfig: async () => ({
          enabled: true,
          tokenAddress: TOKEN,
          thresholdsPpm: [10, 100, 1_000],
          buyUrl: null,
          activatedAt: null,
          updatedAt: '2026-10-08T18:37:00.000Z',
          updatedBy: 'test',
        }),
        getHolders: async () => [],
        putHolders: async () => {
          throw new Error('nothing may be stored');
        },
      } as unknown as TokenStore,
      chain: {
        async readBalances() {
          return { totalSupply: SUPPLY, decimals: 18, balances: [ONE], blockNumber: 1n };
        },
      },
      now: () => NOW,
    });
    resetTokenMemory();
    expect(await service.refreshHolders?.(wallets, NOW)).toBeNull();
  });

  it('lets the next entitlementsFor of a refreshed wallet see the new tier, not the isolate’s memory', async () => {
    const h = harness();
    h.seed({ balance: 20_000n * ONE, ageSeconds: 60, tier: 1 });
    expect((await h.service.entitlementsFor(WALLET)).tier).toBe(1);
    h.chain.balances.set(WALLET, 0n);

    await h.service.refreshHolders?.([WALLET], NOW);

    expect((await h.service.entitlementsFor(WALLET)).tier).toBe(0);
  });
});
