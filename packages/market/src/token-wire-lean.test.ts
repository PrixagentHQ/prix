// The lean balanceOf encoding of the token read (docs/contracts/phase-6-holders.md section 5, revision 3 HB-1,
// revision 4 HB3-1) against viem's own encoding and decoding, and readBalances' optional block tag.
// Run: pnpm exec vitest run --config packages/market/vitest.config.ts
import type { Address } from '@prix/contracts';
import { TOKEN_SWEEP_BATCH } from '@prix/contracts';
import type { Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { createTokenChainReader } from './token-balances.ts';
import {
  decodeTokenResult,
  decodeTokenResultLean,
  encodeTokenCall,
  encodeTokenCallLean,
  encodeTokenResult,
  type TokenReads,
} from './token-wire.ts';

const TOKEN = '0xa74ac6e9f2f8493344923c23972d496364241044' as Address;

function wallets(n: number): Address[] {
  return Array.from({ length: n }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}` as Address);
}

describe('encodeTokenCallLean', () => {
  for (const n of [0, 1, 2, 31, 400]) {
    it(`writes exactly the bytes viem writes, for ${n} wallets`, () => {
      expect(encodeTokenCallLean(TOKEN, wallets(n))).toBe(encodeTokenCall(TOKEN, wallets(n)));
    });
  }

  it('writes a checksummed address as viem does, in lower case', () => {
    const mixed = ['0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as Address];
    expect(encodeTokenCallLean(TOKEN, mixed)).toBe(encodeTokenCall(TOKEN, mixed));
  });
});

describe('decodeTokenResultLean', () => {
  const cases: [string, TokenReads][] = [
    [
      'every call answered',
      {
        blockNumber: 90_000_123n,
        blockTimestamp: 1_792_000_000n,
        totalSupply: 10n ** 27n,
        decimals: 18,
        balances: [0n, 1n, 10n ** 22n, 2n ** 255n],
      },
    ],
    [
      'failed calls',
      { blockNumber: 1n, blockTimestamp: null, totalSupply: null, decimals: null, balances: [null, 5n, null] },
    ],
    ['no wallet', { blockNumber: 7n, blockTimestamp: 3n, totalSupply: 9n, decimals: 6, balances: [] }],
  ];
  for (const [name, reads] of cases) {
    it(`answers what decodeTokenResult answers: ${name}`, () => {
      const asked = wallets(reads.balances.length);
      const data = encodeTokenResult(reads);
      expect(decodeTokenResultLean(asked, data)).toEqual(decodeTokenResult(asked, data));
      expect(decodeTokenResultLean(asked, data)).toEqual(reads);
    });
  }

  it('answers what decodeTokenResult answers for 400 wallets', () => {
    const asked = wallets(400);
    const data = encodeTokenResult({
      blockNumber: 5n,
      blockTimestamp: 6n,
      totalSupply: 10n ** 27n,
      decimals: 18,
      balances: asked.map((_, i) => BigInt(i) * 10n ** 18n),
    });
    expect(decodeTokenResultLean(asked, data)).toEqual(decodeTokenResult(asked, data));
  });

  it('throws, as decodeTokenResult does, when the answer holds another number of results', () => {
    const data = encodeTokenResult({
      blockNumber: 1n,
      blockTimestamp: 1n,
      totalSupply: 1n,
      decimals: 1,
      balances: [1n],
    });
    expect(() => decodeTokenResult(wallets(2), data)).toThrow();
    expect(() => decodeTokenResultLean(wallets(2), data)).toThrow();
  });

  it('throws on an answer that is cut short or not hex', () => {
    const data = encodeTokenResult({
      blockNumber: 1n,
      blockTimestamp: 1n,
      totalSupply: 1n,
      decimals: 1,
      balances: [1n],
    });
    expect(() => decodeTokenResultLean(wallets(1), data.slice(0, data.length - 64) as Hex)).toThrow();
    expect(() => decodeTokenResultLean(wallets(1), '0x' as Hex)).toThrow();
    expect(() => decodeTokenResultLean(wallets(1), `0x${'zz'.repeat(200)}` as Hex)).toThrow();
  });
});

/** A fake endpoint that writes down each eth_call's block tag and answers a fresh block. */
function endpoint(seen: unknown[]): typeof fetch {
  return (async (_input: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body ?? '{}')) as { id?: unknown; params?: unknown[] };
    seen.push(request.params?.[1]);
    const data = String((request.params?.[0] as { data?: string; input?: string })?.data ?? '');
    const count = [...data.matchAll(/70a08231/g)].length;
    const result = encodeTokenResult({
      blockNumber: 1_000n,
      blockTimestamp: BigInt(Math.floor(Date.now() / 1000)),
      totalSupply: 10n ** 27n,
      decimals: 18,
      balances: Array.from({ length: count }, () => 1n),
    });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id ?? 1, result }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

describe('readBalances with atBlock', () => {
  const urls = ['https://rpc.mainnet.chain.robinhood.com', 'https://robinhood.drpc.org'];

  it('sends the block as the tag of every endpoint’s eth_call', async () => {
    const seen: unknown[] = [];
    const reader = createTokenChainReader(urls, endpoint(seen));
    await reader.readBalances(TOKEN, wallets(3), 90_000_000);
    expect(seen.length).toBeGreaterThan(0);
    for (const tag of seen) expect(tag).toBe(`0x${(90_000_000).toString(16)}`);
  });

  it('sends latest without it, as before', async () => {
    const seen: unknown[] = [];
    await createTokenChainReader(urls, endpoint(seen)).readBalances(TOKEN, wallets(3));
    for (const tag of seen) expect(tag).toBe('latest');
  });

  it(`reads more than ${TOKEN_SWEEP_BATCH} wallets through the lean encoding and answers each balance`, async () => {
    const seen: unknown[] = [];
    const read = await createTokenChainReader(urls, endpoint(seen)).readBalances(TOKEN, wallets(400), 5);
    expect(read.balances).toHaveLength(400);
  });
});
