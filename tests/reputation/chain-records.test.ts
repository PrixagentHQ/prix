import type {
  ChainEvent,
  DayPrices,
  ListingPublic,
  ListingRecord,
  RawTransfer,
  StockToken,
  UniverseToken,
} from '@prix/contracts';
import {
  CHAIN_EXCLUSIONS,
  CHAIN_METHOD,
  exclusionCodeSchema,
  isStockToken,
  listingDetailSchema,
  listingsResponseSchema,
  STARTING_CASH_MICRO,
} from '@prix/contracts';
import { chainRecord, createChainRecord } from '@prix/reputation/chain-record';
import { describe, expect, it } from 'vitest';
import { createReputationApp } from '../../apps/api/src/http/reputation/index.ts';
import { createApi } from '../support/api.ts';
import { SEASON_1, testId } from '../support/fixtures.ts';
import { createRng } from '../support/prng.ts';
import { reputationDeps, stubReputation } from './support.ts';

/**
 * Acceptance line 4 of docs/SPEC.md section 9: every on-chain record is labelled `chain-v1` and
 * lists everything it leaves out, and moving tokens between a wallet's own wallets is not a gain.
 */

const ALL_EXCLUSIONS = [
  'non_universe_tokens',
  'cash_and_stablecoins',
  'native_eth',
  'positions_held_in_contracts',
  'intraday_timing',
  'fees_and_slippage',
  'days_without_reference_price',
  'one_sided_swaps_counted_as_transfers',
];

describe('the labels of a chain record', () => {
  it('the method is chain-v1', () => {
    expect(CHAIN_METHOD).toBe('chain-v1');
  });

  it('CHAIN_EXCLUSIONS lists every code of the contract, once', () => {
    expect([...CHAIN_EXCLUSIONS].sort()).toEqual([...ALL_EXCLUSIONS].sort());
    expect(new Set(CHAIN_EXCLUSIONS).size).toBe(CHAIN_EXCLUSIONS.length);
    expect([...exclusionCodeSchema.options].sort()).toEqual([...ALL_EXCLUSIONS].sort());
  });
});

// --- through the HTTP app -----------------------------------------------------------------------

const LISTING_ID = testId('lst', 1);

function bareListing(over: Partial<ListingPublic> = {}): ListingPublic {
  return {
    id: LISTING_ID,
    name: 'Alpha Wallet',
    wallet: `0x${'a'.repeat(40)}`,
    explorerUrl: `https://robinhoodchain.blockscout.com/address/0x${'a'.repeat(40)}`,
    verified: false,
    claimedAt: '2026-10-06T10:00:00.000Z',
    syncState: 'live',
    syncedAt: '2026-10-06T11:00:00.000Z',
    eventCount: 0,
    estimated: true,
    recordMethod: CHAIN_METHOD,
    scoringMethod: null,
    // What a careless store might return: nothing listed as excluded.
    exclusions: [],
    recordFrom: null,
    standing: null,
    ...over,
  };
}

function record(): ListingRecord {
  const p = bareListing();
  return {
    id: p.id,
    wallet: p.wallet as `0x${string}`,
    claimant: `0x${'b'.repeat(40)}` as `0x${string}`,
    name: p.name,
    nameKey: 'alphawallet',
    message: 'm',
    signature: `0x${'1'.repeat(130)}`,
    signatureKind: 'eoa',
    status: 'active',
    hidden: false,
    verified: false,
    claimedAt: p.claimedAt,
    syncState: 'live',
    syncedBlock: 10,
    syncedAt: p.syncedAt,
    windowBlocks: 1000,
    syncErrors: 0,
    eventCount: 0,
    balancesWei: {},
    recordDay: null,
    recordBlock: 0,
    indexMicro: 0,
  };
}

function app() {
  const api = createApi();
  return createReputationApp(
    reputationDeps(api, {
      verifier: { verify: async () => null },
      reputation: stubReputation({
        listListedAgents: async () => [
          bareListing(),
          // A store that wrongly says the record is measured and mislabels the method.
          bareListing({
            id: testId('lst', 2),
            name: 'Beta Wallet',
            estimated: false as unknown as true,
            recordMethod: 'v2' as unknown as 'chain-v1',
          }),
        ],
        getListedAgent: async (id: string) => (id === LISTING_ID ? bareListing() : null),
        getListing: async (id: string) => (id === LISTING_ID ? record() : null),
        listListingDays: async () => [],
        listEventsNewest: async () => [],
        getTrackRecord: async () => null,
      }),
    }),
  );
}

describe('every chain record the API sends', () => {
  it('GET /listings: each row is estimated, chain-v1, and lists all exclusions', async () => {
    const response = await app().fetch(new Request('https://prix.test/api/reputation/listings'));
    expect(response.status).toBe(200);
    const body = listingsResponseSchema.parse(await response.json());
    expect(body.listings).toHaveLength(2);
    for (const row of body.listings) {
      expect(row.recordMethod).toBe('chain-v1');
      expect(row.estimated).toBe(true);
      expect([...row.exclusions].sort()).toEqual([...ALL_EXCLUSIONS].sort());
    }
  });

  it('GET /listings/:id: the detail carries the same labels', async () => {
    const response = await app().fetch(new Request(`https://prix.test/api/reputation/listings/${LISTING_ID}`));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { listing: unknown };
    const listing = listingDetailSchema.parse(body.listing);
    expect(listing.recordMethod).toBe('chain-v1');
    expect(listing.estimated).toBe(true);
    expect([...listing.exclusions].sort()).toEqual([...ALL_EXCLUSIONS].sort());
  });

  it('a results table of the chain division is worded as estimated', async () => {
    const api = createApi();
    const results = createReputationApp(
      reputationDeps(api, {
        verifier: { verify: async () => null },
        reputation: stubReputation({
          getSeasonArchiveEntry: async () => ({
            season: SEASON_1,
            method: 'v2',
            lengthDays: 56,
            frozenAt: null,
            rankedCount: { open: 0, pro: 0, chain: 0 },
            agentCount: { open: 0, pro: 0, chain: 0 },
          }),
          listSeasonResults: async () => [],
        }),
      }),
    );
    const response = await results.fetch(
      new Request(`https://prix.test/api/reputation/seasons/${SEASON_1.id}/results?division=chain`),
    );
    expect(((await response.json()) as { estimated: boolean }).estimated).toBe(true);
  });
});

// --- the engine: a transfer is a flow, never a gain -----------------------------------------------

const WEI = 10n ** 18n;
const wei = (tokens: number): string => (BigInt(tokens) * WEI).toString();

function dayName(i: number): string {
  return `2026-10-${String(10 + i).padStart(2, '0')}`;
}

function priceDays(seed: number, count: number): DayPrices[] {
  const rng = createRng(seed);
  let nvda = 182_410_000;
  let tsla = 248_760_000;
  return Array.from({ length: count }, (_, i) => {
    nvda = Math.round(nvda * (1 + (rng.next() - 0.5) * 0.06));
    tsla = Math.round(tsla * (1 + (rng.next() - 0.5) * 0.06));
    return { day: dayName(i), tickId: `${dayName(i)}T20:00Z`, pricesMicro: { NVDA: nvda, TSLA: tsla } };
  });
}

let nextBlock = 1_000;
function event(day: string, symbol: string, direction: 'in' | 'out', tokens: number): ChainEvent {
  nextBlock += 1;
  return {
    block: nextBlock,
    logIndex: 0,
    txHash: `0x${nextBlock.toString(16).padStart(64, '0')}`,
    symbol,
    direction,
    amountWei: wei(tokens),
    kind: 'transfer',
    day,
  };
}

function run(events: ChainEvent[], days: DayPrices[]) {
  const sorted = [...events].sort((a, b) => a.block - b.block);
  return chainRecord.build({
    balancesWei: {},
    recordDay: null,
    indexMicro: 0,
    events: sorted,
    days,
    baseDayPrices: null,
  });
}

/** The fields of a day that make the record. The event counts are bookkeeping, not performance. */
const performance = (r: ReturnType<typeof run>) =>
  r.newDays.map((d) => ({ day: d.day, returnBps: d.returnBps, exposed: d.exposed, indexMicro: d.indexMicro }));

describe('chainRecord.build: moving tokens between a wallet own wallets', () => {
  it('starts the index at the starting value on the first priced day', () => {
    const days = priceDays(1, 6);
    const result = run([event(dayName(0), 'NVDA', 'in', 10)], days);
    expect(result.newDays[0]?.indexMicro).toBe(STARTING_CASH_MICRO);
  });

  it('gives the same record to a wallet that sent tokens to its other wallet and got them back the same day', () => {
    const days = priceDays(2, 8);
    const base = [event(dayName(0), 'NVDA', 'in', 10), event(dayName(0), 'TSLA', 'in', 4)];
    const control = run(base, days);

    const moved = run(
      [
        ...base,
        event(dayName(3), 'NVDA', 'out', 6),
        event(dayName(3), 'NVDA', 'in', 6),
        event(dayName(5), 'TSLA', 'out', 4),
        event(dayName(5), 'TSLA', 'in', 4),
      ],
      days,
    );
    expect(performance(moved)).toEqual(performance(control));
    expect(moved.balancesWei).toEqual(control.balancesWei);
    expect(moved.indexMicro).toBe(control.indexMicro);
    expect(control.newDays.filter((d) => d.exposed).length).toBeGreaterThan(3);
  });

  it('does not count a deposit as a gain: the return of the day of the deposit is the same', () => {
    const days = priceDays(3, 8);
    const base = [event(dayName(0), 'NVDA', 'in', 10), event(dayName(0), 'TSLA', 'in', 10)];
    const control = run(base, days);
    const deposited = run([...base, event(dayName(4), 'TSLA', 'in', 1_000)], days);
    // Up to and including the day of the deposit nothing differs.
    expect(performance(deposited).slice(0, 5)).toEqual(performance(control).slice(0, 5));
    expect(deposited.newDays[4]?.valueMicro).toBeGreaterThan((control.newDays[4]?.valueMicro ?? 0) * 50);
  });

  it('does not count a withdrawal as a loss: the return of the day of the withdrawal is the same', () => {
    const days = priceDays(4, 8);
    const base = [event(dayName(0), 'NVDA', 'in', 10), event(dayName(0), 'TSLA', 'in', 10)];
    const control = run(base, days);
    const withdrawn = run([...base, event(dayName(4), 'NVDA', 'out', 9)], days);
    expect(performance(withdrawn).slice(0, 5)).toEqual(performance(control).slice(0, 5));
  });

  it('is the same for any number of round trips, in any order, on random records', () => {
    const rng = createRng(99);
    for (let round = 0; round < 40; round += 1) {
      const days = priceDays(1_000 + round, 10);
      const base: ChainEvent[] = [];
      for (let i = 0; i < rng.int(1, 3); i += 1) {
        base.push(event(dayName(rng.int(0, 4)), rng.pick(['NVDA', 'TSLA']), 'in', rng.int(1, 50)));
      }
      const control = run(base, days);
      const trips: ChainEvent[] = [];
      for (let i = 0; i < rng.int(1, 5); i += 1) {
        const day = dayName(rng.int(0, 9));
        const symbol = rng.pick(['NVDA', 'TSLA']);
        const tokens = rng.int(1, 5);
        // Take out only what is surely held after the base events: the round trip starts with an in.
        trips.push(event(day, symbol, 'in', tokens), event(day, symbol, 'out', tokens));
      }
      const moved = run([...base, ...trips], days);
      expect(performance(moved), `round ${round}`).toEqual(performance(control));
      expect(moved.balancesWei, `round ${round}`).toEqual(control.balancesWei);
    }
  });
});

// --- section 21: on-chain records stay Stock Tokens only ------------------------------------------

const SOURCE_URL = 'https://docs.chain.link/data-feeds/price-feeds/addresses?network=robinhood';

function stock(symbol: string, n: number, tokenDecimals = 18): StockToken {
  return {
    kind: 'stock',
    symbol,
    name: symbol,
    tokenAddress: `0x${String(n).repeat(40)}`,
    tokenDecimals,
    feedAddress: `0x${String(n + 1).repeat(40)}`,
    feedDecimals: 8,
    sourceUrl: SOURCE_URL,
    readOn: '2026-10-09',
  };
}

function coin(symbol: string, n: number): UniverseToken {
  return {
    kind: 'crypto',
    symbol,
    name: symbol,
    feedAddress: `0x${String(n).repeat(40)}`,
    feedDecimals: 8,
    sourceUrl: SOURCE_URL,
    readOn: '2026-10-09',
  };
}

/** Two Stock Tokens and the two crypto assets of stage 1, in the order of UNIVERSE. */
const MIXED_UNIVERSE: readonly UniverseToken[] = [stock('NVDA', 1), stock('TSLA', 3), coin('BTC', 5), coin('ETH', 6)];

/** The same days, with the coins priced and moving hard every day. */
function withCrypto(days: DayPrices[]): DayPrices[] {
  return days.map((d, i) => ({
    ...d,
    pricesMicro: {
      ...d.pricesMicro,
      ETH: 2_400_000_000 * (i % 2 === 0 ? 1 : 3),
      BTC: 61_000_000_000 * (i % 2 === 0 ? 2 : 1),
    },
  }));
}

function raw(block: number, logIndex: number, txHash: string, symbol: string, direction: 'in' | 'out'): RawTransfer {
  return { block, logIndex, txHash, symbol, direction, amountWei: wei(1) };
}

describe('createChainRecord: a chain record counts Stock Tokens only (section 21)', () => {
  const engine = createChainRecord(MIXED_UNIVERSE);
  const build = (events: ChainEvent[], days: DayPrices[], balancesWei: Record<string, string> = {}) =>
    engine.build({
      balancesWei,
      recordDay: null,
      indexMicro: 0,
      events: [...events].sort((a, b) => a.block - b.block),
      days,
      baseDayPrices: null,
    });

  it('gives the same record as before when the day prices also carry ETH and BTC', () => {
    const days = priceDays(21, 8);
    const base = [event(dayName(0), 'NVDA', 'in', 10), event(dayName(0), 'TSLA', 'in', 4)];
    expect(build(base, withCrypto(days))).toEqual(run(base, days));
  });

  it('ignores an ETH or a BTC event and never keeps a crypto balance', () => {
    const days = withCrypto(priceDays(22, 8));
    const base = [event(dayName(0), 'NVDA', 'in', 10)];
    const control = build(base, days);
    const crypto = build([...base, event(dayName(1), 'ETH', 'in', 500), event(dayName(2), 'BTC', 'in', 3)], days);
    expect(crypto).toEqual(control);
    expect(Object.keys(crypto.balancesWei)).toEqual(['NVDA']);
  });

  it('drops the crypto balances of a stored checkpoint', () => {
    const days = withCrypto(priceDays(23, 6));
    const control = build([], days, { NVDA: wei(10) });
    expect(build([], days, { NVDA: wei(10), ETH: wei(1_000), BTC: wei(2) })).toEqual(control);
  });

  it('classify leaves out transfers of a crypto symbol and of a symbol outside the universe', () => {
    const events = engine.classify(
      [
        raw(10, 0, '0xa', 'NVDA', 'in'),
        raw(11, 0, '0xb', 'ETH', 'in'),
        raw(12, 0, '0xc', 'BTC', 'out'),
        raw(13, 0, '0xd', 'XYZ', 'in'),
        // One transaction, NVDA out and ETH in: without the coin it is a one-sided transfer.
        raw(14, 0, '0xe', 'NVDA', 'out'),
        raw(14, 1, '0xe', 'ETH', 'in'),
      ],
      () => '2026-10-10',
    );
    expect(events.map((e) => [e.symbol, e.block, e.kind])).toEqual([
      ['NVDA', 10, 'transfer'],
      ['NVDA', 14, 'transfer'],
    ]);
  });

  it('values a Stock Token with its own decimals', () => {
    const days = priceDays(24, 3);
    const r = createChainRecord([stock('NVDA', 1, 6)]).build({
      balancesWei: { NVDA: (10n * 10n ** 6n).toString() },
      recordDay: null,
      indexMicro: 0,
      events: [],
      days,
      baseDayPrices: null,
    });
    expect(r.newDays[0]?.valueMicro).toBe(10 * (days[0]?.pricesMicro.NVDA ?? 0));
  });

  it('with no Stock Token in the universe keeps no balance and has no exposed day', () => {
    const r = createChainRecord(MIXED_UNIVERSE.filter((t) => !isStockToken(t))).build({
      balancesWei: { NVDA: wei(10), ETH: wei(10) },
      recordDay: null,
      indexMicro: 0,
      events: [],
      days: withCrypto(priceDays(25, 4)),
      baseDayPrices: null,
    });
    expect(r.balancesWei).toEqual({});
    expect(r.newDays.every((d) => !d.exposed && d.valueMicro === 0)).toBe(true);
  });
});
