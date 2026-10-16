import type { DecisionPromptInput, PricePoint, RecentReturns } from '@prix/contracts';
import { marketPricesResponseSchema, UNIVERSE_SIZE } from '@prix/contracts';
import { UNIVERSE } from '@prix/market';
import { assembleDecisionMessages } from '@prix/runtime';
import { DECISION_SYSTEM_MESSAGE, decisionSystemMessage, describeSymbols } from '@prix/runtime/prompts';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Api } from '../support/api.ts';
import { createApi, expectPublicCache, expectShape } from '../support/api.ts';
import { makeSnapshot, makeTick, TEST_ARBITRUM_SYMBOLS, TEST_PRICES, TEST_SYMBOLS, utc } from '../support/fixtures.ts';

/**
 * The decision prompt and the public price read at 25 symbols (docs/CONTRACTS.md section 23 with
 * section 21, rules 5, 7 and 8, and section 17.2). The symbol line names BNB, HYPE Hyperliquid and
 * SOL Solana in the crypto group; the user document prices all 25; a new coin's returns are null
 * until the league has its history; a war keeps the universe it froze. GET /api/market/prices gives
 * the 25 symbols in universe order and never the provenance of a second chain.
 */

const NOW = '2026-10-12T15:00:00.000Z';

function points(overrides: Record<string, number> = {}, halted: readonly string[] = []): PricePoint[] {
  return TEST_SYMBOLS.map((symbol) => ({
    symbol,
    priceMicro: overrides[symbol] ?? (TEST_PRICES[symbol] as number),
    updatedAt: '2026-10-12T14:59:18.000Z',
    ageSeconds: 42,
    fresh: !halted.includes(symbol),
  }));
}

function returns(withHistory: readonly string[]): RecentReturns[] {
  return TEST_SYMBOLS.map((symbol) =>
    withHistory.includes(symbol)
      ? { symbol, day1Bps: 120, day5Bps: -40, day20Bps: 310 }
      : { symbol, day1Bps: null, day5Bps: null, day20Bps: null },
  );
}

function input(overrides: Partial<DecisionPromptInput> = {}): DecisionPromptInput {
  return {
    now: NOW,
    prices: points(),
    returns: returns([]),
    halted: [],
    portfolio: { cashMicro: 10_000_000_000, holdings: {} },
    equityMicro: 10_000_000_000,
    strategy: 'Hold the largest coins in equal parts.',
    ...overrides,
  };
}

function userDocument(value: DecisionPromptInput) {
  const user = assembleDecisionMessages(value)[1];
  if (!user) throw new Error('no user message');
  return JSON.parse(user.content) as {
    prices: Record<string, [number, number | null, number | null, number | null]>;
    halted: string[];
  };
}

describe('the decision prompt at 25 symbols', () => {
  it('names the five crypto assets after the Stock Tokens, in universe order, with their names', () => {
    const line = DECISION_SYSTEM_MESSAGE.split('\n').find((text) => text.startsWith('The symbols'));
    expect(line).toContain('crypto: BTC Bitcoin, ETH Ethereum, BNB, HYPE Hyperliquid, SOL Solana');
    expect(line).toContain(describeSymbols(UNIVERSE));
  });

  it('prices all 25 symbols in the user document, SOL, BNB and HYPE included', () => {
    const document = userDocument(input());
    expect(Object.keys(document.prices)).toHaveLength(UNIVERSE_SIZE);
    expect(document.prices.SOL?.[0]).toBe(152.88);
    expect(document.prices.BNB?.[0]).toBe(612.34);
    expect(document.prices.HYPE?.[0]).toBe(38.71);
  });

  it('gives a new coin null returns while every older symbol has its own (no backfill)', () => {
    const older = TEST_SYMBOLS.filter((symbol) => !TEST_ARBITRUM_SYMBOLS.includes(symbol));
    const document = userDocument(input({ returns: returns(older) }));
    for (const symbol of TEST_ARBITRUM_SYMBOLS) {
      expect(document.prices[symbol]?.slice(1), symbol).toEqual([null, null, null]);
    }
    expect(document.prices.BTC?.slice(1)).toEqual([1.2, -0.4, 3.1]);
  });

  it('lists the coins Arbitrum left unread as halted, at the price they are valued at', () => {
    const document = userDocument(
      input({ prices: points({}, TEST_ARBITRUM_SYMBOLS), halted: [...TEST_ARBITRUM_SYMBOLS] }),
    );
    expect([...document.halted].sort()).toEqual([...TEST_ARBITRUM_SYMBOLS].sort());
    expect(document.prices.SOL?.[0]).toBe(152.88);
  });

  it('keeps a frozen stage 1 universe for a war: 22 symbols and no new coin', () => {
    const stage1 = UNIVERSE.filter((token) => !TEST_ARBITRUM_SYMBOLS.includes(token.symbol));
    expect(stage1).toHaveLength(22);
    const line = decisionSystemMessage(stage1)
      .split('\n')
      .find((text) => text.startsWith('The symbols'));
    expect(line).toContain('crypto: BTC Bitcoin, ETH Ethereum.');
    for (const symbol of TEST_ARBITRUM_SYMBOLS) expect(line).not.toMatch(new RegExp(`\\b${symbol}\\b`));
  });

  it('never names a chain, an endpoint or a provider in the prompt', () => {
    for (const piece of ['Arbitrum', 'arbitrum', 'Robinhood Chain', 'publicnode', 'drpc', 'https://', 'sequencer']) {
      expect(DECISION_SYSTEM_MESSAGE).not.toContain(piece);
    }
  });
});

describe('GET /api/market/prices at 25 symbols', () => {
  let api: Api;
  beforeEach(() => {
    api = createApi({ now: '2026-10-12T15:10:00.000Z' });
  });

  const read = async () => {
    const reply = await api.client().get('/api/market/prices');
    expectPublicCache(reply);
    return expectShape(marketPricesResponseSchema, reply);
  };

  async function addTick(at: string, options: Parameters<typeof makeSnapshot>[1] = {}): Promise<void> {
    const now = utc(at);
    expect(
      await api.store.createTick(makeTick(now, { status: 'complete', snapshot: makeSnapshot(now, options) })),
    ).toBe(true);
  }

  const read2 = {
    chainId: 42161 as const,
    blockNumber: 391_234_567,
    endpoint: 1,
    confirmedBy: 2,
    problem: null,
  };

  it('gives the 25 symbols in universe order, with the names of the universe', async () => {
    await addTick('2026-10-12T15:00:00.000Z', { otherChains: [read2] });
    const body = await read();
    expect(body.prices).toHaveLength(25);
    expect(body.prices.map((entry) => entry.symbol)).toEqual(UNIVERSE.map((token) => token.symbol));
    expect(body.prices.find((entry) => entry.symbol === 'HYPE')).toMatchObject({
      name: 'Hyperliquid',
      priceMicro: TEST_PRICES.HYPE,
      fresh: true,
    });
    expect(body.prices.find((entry) => entry.symbol === 'SOL')?.name).toBe('Solana');
  });

  it('never carries the provenance of the second chain', async () => {
    await addTick('2026-10-12T15:00:00.000Z', { otherChains: [read2] });
    const reply = await api.client().get('/api/market/prices');
    const text = reply.text;
    for (const piece of ['otherChains', '42161', 'confirmedBy', '391234567']) expect(text).not.toContain(piece);
  });

  it('gives the new coins a null change on their first day after a stage 1 round, and BTC and ETH theirs', async () => {
    const { BNB: _b, HYPE: _h, SOL: _s, ...stage1 } = TEST_PRICES;
    await addTick('2026-10-09T19:00:00.000Z', { prices: stage1 });
    await addTick('2026-10-12T15:00:00.000Z');
    const body = await read();
    for (const entry of body.prices) {
      if (TEST_ARBITRUM_SYMBOLS.includes(entry.symbol)) expect(entry.changeBps, entry.symbol).toBeNull();
      else expect(entry.changeBps, entry.symbol).toBe(0);
    }
  });

  it('marks the coins Arbitrum left unread as not fresh, at the price the tick stored', async () => {
    await addTick('2026-10-12T15:00:00.000Z', { stale: [...TEST_ARBITRUM_SYMBOLS] });
    const body = await read();
    expect(body.prices.filter((entry) => !entry.fresh).map((entry) => entry.symbol)).toEqual(['BNB', 'HYPE', 'SOL']);
    expect(body.prices.find((entry) => entry.symbol === 'BNB')?.priceMicro).toBe(TEST_PRICES.BNB);
  });
});
