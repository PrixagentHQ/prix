import type { Address, TokenBalances, TokenChainReader } from '@prix/contracts';
import { POLL_TALLY_MAX_FETCHES, TokenReadError } from '@prix/contracts';
import { describe, expect, it } from 'vitest';
import { createPollFetchMeter, createPollHoldingReader } from './poll-holding.ts';

/**
 * The tally's holding reader (docs/contracts/phase-6-holders.md section 5): one `readBalances` a call, each
 * tier by `computeTier` at the configured thresholds, no hold before a rise, no `token_holders` row (the
 * reader has no store at all), `atBlock` passed as the read's block tag, and its fetches counted to the run.
 */

const TOKEN = '0xa74ac6e9f2f8493344923c23972d496364241044' as Address;
const SUPPLY = 1_000_000_000n * 10n ** 18n;
const whole = (tokens: bigint): bigint => tokens * 10n ** 18n;
const wallet = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}` as Address;

const CONFIG = { token: TOKEN, thresholdsPpm: [10, 100, 1000] as const, gatingOn: true };

function chainOf(balances: (wallets: readonly Address[]) => bigint[], head = 1_000n) {
  const calls: { token: Address; wallets: readonly Address[]; args: number; atBlock: number | undefined }[] = [];
  const chain: TokenChainReader = {
    async readBalances(token, wallets, ...rest: [number?]): Promise<TokenBalances> {
      const atBlock = rest[0];
      calls.push({ token, wallets, args: 2 + rest.length, atBlock });
      return {
        totalSupply: SUPPLY,
        decimals: 18,
        balances: balances(wallets),
        blockNumber: atBlock === undefined ? head : BigInt(atBlock),
      };
    },
  };
  return { chain, calls };
}

describe('tiersNow', () => {
  it('computes each tier at the configured thresholds, in the wallets order, with no hold', async () => {
    const amounts = [0n, whole(9_999n), whole(10_000n), whole(100_000n), whole(1_000_000n)];
    const { chain, calls } = chainOf(() => amounts);
    const reader = createPollHoldingReader({ chain, config: async () => CONFIG });
    const wallets = [1, 2, 3, 4, 5].map(wallet);
    const read = await reader.tiersNow(wallets, null);
    expect(read.gatingOn).toBe(true);
    expect(read.tiers).toEqual([0, 0, 1, 2, 3]);
    expect(read.blockNumber).toBe(1_000);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.token).toBe(TOKEN);
    expect(calls[0]?.wallets).toEqual(wallets);
  });

  it('reads at the head with no block tag, and at a block with that block as the tag', async () => {
    const { chain, calls } = chainOf((w) => w.map(() => 0n));
    const reader = createPollHoldingReader({ chain, config: async () => CONFIG });
    await reader.tiersNow([wallet(1)], null);
    const pinned = await reader.tiersNow([wallet(1)], 950);
    expect(calls[0]?.args).toBe(2);
    expect(calls[0]?.atBlock).toBeUndefined();
    expect(calls[1]?.args).toBe(3);
    expect(calls[1]?.atBlock).toBe(950);
    expect(pinned.blockNumber).toBe(950);
  });

  it('uses the configured thresholds, not the defaults', async () => {
    const { chain } = chainOf(() => [whole(7_000n)]);
    const reader = createPollHoldingReader({
      chain,
      config: async () => ({ ...CONFIG, thresholdsPpm: [7, 100, 1000] as const }),
    });
    expect((await reader.tiersNow([wallet(1)], null)).tiers).toEqual([1]);
  });

  it('answers gating off with no chain read while gating is off or no token is configured', async () => {
    for (const config of [
      { ...CONFIG, gatingOn: false },
      { ...CONFIG, token: null },
    ]) {
      const { chain, calls } = chainOf((w) => w.map(() => whole(1_000_000n)));
      const reader = createPollHoldingReader({ chain, config: async () => config });
      const read = await reader.tiersNow([wallet(1), wallet(2)], null);
      expect(read.gatingOn).toBe(false);
      expect(read.tiers).toEqual([0, 0]);
      expect(calls).toHaveLength(0);
    }
  });

  it('throws when the chain answers a different number of balances or a block that is not a safe number', async () => {
    const short = chainOf(() => [0n]);
    await expect(
      createPollHoldingReader({ chain: short.chain, config: async () => CONFIG }).tiersNow(
        [wallet(1), wallet(2)],
        null,
      ),
    ).rejects.toBeInstanceOf(TokenReadError);
    const huge = chainOf(() => [0n], 2n ** 60n);
    await expect(
      createPollHoldingReader({ chain: huge.chain, config: async () => CONFIG }).tiersNow([wallet(1)], null),
    ).rejects.toBeInstanceOf(TokenReadError);
  });

  it('passes a chain failure on', async () => {
    const chain: TokenChainReader = {
      async readBalances() {
        throw new TokenReadError('rpc_unavailable');
      },
    };
    await expect(
      createPollHoldingReader({ chain, config: async () => CONFIG }).tiersNow([wallet(1)], null),
    ).rejects.toThrow(TokenReadError);
  });
});

describe('the fetch meter', () => {
  it('counts every fetch of a run, starts a new run at each head read, and reports the count with the read', async () => {
    let real = 0;
    const meter = createPollFetchMeter((async () => {
      real += 1;
      return new Response('{}');
    }) as typeof fetch);
    // A chain that makes two fetches a read, as a third-party answer and its confirmation would.
    const chain: TokenChainReader = {
      async readBalances(_token, wallets, atBlock) {
        await meter.fetch('https://rpc.example/one');
        await meter.fetch('https://rpc.example/two');
        return {
          totalSupply: SUPPLY,
          decimals: 18,
          balances: wallets.map(() => 0n),
          blockNumber: BigInt(atBlock ?? 99),
        };
      },
    };
    const reader = createPollHoldingReader({ chain, config: async () => CONFIG, meter });
    expect((await reader.tiersNow([wallet(1)], null)).fetches).toBe(2);
    expect((await reader.tiersNow([wallet(1)], 49)).fetches).toBe(4);
    expect(meter.spent()).toBe(4);
    // A new head read is a new run.
    expect((await reader.tiersNow([wallet(1)], null)).fetches).toBe(2);
    expect(real).toBe(6);
  });

  it('refuses the fetch past POLL_TALLY_MAX_FETCHES without sending it, so the read fails', async () => {
    let real = 0;
    const meter = createPollFetchMeter((async () => {
      real += 1;
      return new Response('{}');
    }) as typeof fetch);
    const chain: TokenChainReader = {
      async readBalances(_token, wallets, atBlock) {
        // Three endpoints tried, as with one endpoint failing on every call.
        for (const n of [1, 2, 3]) {
          try {
            await meter.fetch(`https://rpc.example/${n}`);
          } catch {
            throw new TokenReadError('rpc_unavailable');
          }
        }
        return {
          totalSupply: SUPPLY,
          decimals: 18,
          balances: wallets.map(() => 0n),
          blockNumber: BigInt(atBlock ?? 99),
        };
      },
    };
    const reader = createPollHoldingReader({ chain, config: async () => CONFIG, meter });
    await reader.tiersNow([wallet(1)], null);
    let reads = 1;
    let failed = false;
    while (reads < 20) {
      try {
        await reader.tiersNow([wallet(1)], 49);
        reads += 1;
      } catch {
        failed = true;
        break;
      }
    }
    expect(failed).toBe(true);
    expect(reads).toBe(POLL_TALLY_MAX_FETCHES / 3);
    expect(real).toBe(POLL_TALLY_MAX_FETCHES);
    expect(meter.spent()).toBe(POLL_TALLY_MAX_FETCHES);
  });

  it('reports no count when no meter is given', async () => {
    const { chain } = chainOf(() => [0n]);
    const read = await createPollHoldingReader({ chain, config: async () => CONFIG }).tiersNow([wallet(1)], null);
    expect(read.fetches).toBeUndefined();
  });
});
