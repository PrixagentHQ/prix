import { type Address, TokenReadError } from '@prix/contracts';
import { createTokenChainReader } from '@prix/market/token-balances';
import { encodeTokenResult } from '@prix/market/token-wire';
import { describe, expect, it } from 'vitest';
import { DRPC, down, Endpoints, type Handler, KEYED, OFFICIAL, PUBLICNODE } from './support.ts';

/**
 * The token balance read of the tier sweep grants tiers, so a third-party fallback endpoint is
 * trusted only when a second independent endpoint agrees (docs/CONTRACTS.md section 20, D-110
 * finding 4). The keyed RPC_URL and the official endpoint are trusted alone.
 */

const TOKEN = '0x00000000000000000000000000000000000070c0' as Address;
const WALLET = '0x00000000000000000000000000000000000000a1' as Address;
const SUPPLY = 10n ** 27n;

function chain(balance: bigint): Handler {
  return (method) => {
    if (method !== 'eth_call') return { error: { code: -32601, message: 'no' } };
    return {
      result: encodeTokenResult({
        blockNumber: 1_000n,
        blockTimestamp: BigInt(Math.floor(Date.now() / 1000)),
        totalSupply: SUPPLY,
        decimals: 18,
        balances: [balance],
      }),
    };
  };
}

async function readWith(endpoints: Endpoints, urls: string[]) {
  return createTokenChainReader(urls, endpoints.fetch).readBalances(TOKEN, [WALLET]);
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    return error instanceof TokenReadError ? error.code : 'other';
  }
}

describe('the token balance read and third-party endpoints', () => {
  it('trusts the keyed endpoint alone', async () => {
    const e = new Endpoints().on(KEYED, chain(5n)).on(OFFICIAL, chain(5n)).on(PUBLICNODE, chain(5n));
    const read = await readWith(e, [KEYED, OFFICIAL, PUBLICNODE, DRPC]);
    expect(read.balances).toEqual([5n]);
    expect(e.methods(OFFICIAL)).toEqual([]);
  });

  it('trusts the official endpoint alone', async () => {
    const e = new Endpoints().on(KEYED, down).on(OFFICIAL, chain(5n)).on(PUBLICNODE, chain(9n));
    const read = await readWith(e, [KEYED, OFFICIAL, PUBLICNODE, DRPC]);
    expect(read.balances).toEqual([5n]);
    expect(e.methods(PUBLICNODE)).toEqual([]);
  });

  it('accepts a third party when a second independent endpoint agrees', async () => {
    const e = new Endpoints().on(KEYED, down).on(OFFICIAL, down).on(PUBLICNODE, chain(5n)).on(DRPC, chain(5n));
    const read = await readWith(e, [KEYED, OFFICIAL, PUBLICNODE, DRPC]);
    expect(read.balances).toEqual([5n]);
    expect(e.methods(DRPC)).toEqual(['eth_call']);
  });

  it('fails closed when the second endpoint disagrees', async () => {
    const e = new Endpoints()
      .on(OFFICIAL, down)
      .on(PUBLICNODE, chain(10n ** 26n))
      .on(DRPC, chain(5n));
    expect(await codeOf(readWith(e, [OFFICIAL, PUBLICNODE, DRPC]))).toBe('rpc_unavailable');
  });

  it('fails closed when no second endpoint answers', async () => {
    const e = new Endpoints().on(OFFICIAL, down).on(PUBLICNODE, chain(5n)).on(DRPC, down);
    expect(await codeOf(readWith(e, [OFFICIAL, PUBLICNODE, DRPC]))).toBe('rpc_unavailable');
  });

  it('fails closed when a third party is the only endpoint', async () => {
    const e = new Endpoints().on(DRPC, chain(5n));
    expect(await codeOf(readWith(e, [DRPC]))).toBe('rpc_unavailable');
  });
});
