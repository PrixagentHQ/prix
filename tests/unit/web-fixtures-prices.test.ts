import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AgentPublic, LeagueResponse, MarketPricesResponse, MarketResponse, StandingRow } from '@prix/contracts';
import {
  agentPublicSchema,
  BPS,
  leagueResponseSchema,
  marketPricesResponseSchema,
  marketResponseSchema,
  UNIVERSE_SIZE,
} from '@prix/contracts';
import { UNIVERSE } from '@prix/market/universe';
import { beforeAll, describe, expect, it } from 'vitest';
import { repoRoot } from '../support/repo.ts';

/**
 * The two reads of docs/CONTRACTS.md section 17.2 as the pages see them before the API sends
 * them: the price strip, through the page client's `marketPrices()` on the fixture transport,
 * and the holdings on every league row of every league fixture.
 *
 * The site's modules are loaded by path at run time: their types reach into the site's own
 * declarations, which the tests project does not compile.
 */

type Result<T> = { ok: true; status: number; data: T } | { ok: false; status: number; error: { code: string } };
interface PageApi {
  marketPrices(): Promise<Result<MarketPricesResponse>>;
  market(): Promise<Result<MarketResponse>>;
  league(query?: { division?: 'open' | 'pro' }): Promise<Result<LeagueResponse>>;
  agent(id: string): Promise<Result<AgentPublic>>;
}

let createApi: (context: { request: Request; url: URL; locals: Record<string, unknown> }) => PageApi;
let pageNames: readonly string[];

beforeAll(async () => {
  // The site is built with PRIX_FIXTURES=1 for review; the page client then answers from the fixtures.
  (globalThis as { __PRIX_FIXTURES__?: boolean }).__PRIX_FIXTURES__ = true;
  const client = await import(/* @vite-ignore */ pathToFileURL(join(repoRoot(), 'apps/web/src/lib/api.ts')).href);
  const fixtures = await import(
    /* @vite-ignore */ pathToFileURL(join(repoRoot(), 'apps/web/src/lib/fixtures/index.ts')).href
  );
  createApi = client.createApi;
  pageNames = fixtures.FIXTURE_NAMES;
});

/** The page client for one page render with `?fixture=<fixture>`. */
function api(fixture = ''): PageApi {
  const url = new URL(`https://prix.test/${fixture === '' ? '' : `?fixture=${encodeURIComponent(fixture)}`}`);
  return createApi({ request: new Request(url), url, locals: {} });
}

async function ok<T>(result: Promise<Result<T>>, where: string): Promise<T> {
  const answer = await result;
  if (!answer.ok) throw new Error(`${where}: ${answer.status} ${answer.error.code}`);
  return answer.data;
}

const prices = async (fixture = '') =>
  marketPricesResponseSchema.parse(await ok(api(fixture).marketPrices(), `prices ${fixture}`));

describe('marketPrices() on the fixtures', () => {
  it('gives the UNIVERSE_SIZE symbols in universe order with their names, at the round the market reports', async () => {
    const body = await prices();
    expect(body.prices.map((entry) => entry.symbol)).toEqual(UNIVERSE.map((token) => token.symbol));
    expect(body.prices.map((entry) => entry.name)).toEqual(UNIVERSE.map((token) => token.name));
    const market = marketResponseSchema.parse(await ok(api().market(), 'market'));
    expect(body.tickId).not.toBeNull();
    expect(body.tickId).toBe(market.market?.lastTickId);
    expect(body.takenAt?.startsWith(`${body.tickId?.slice(0, 13)}:00`)).toBe(true);
  });

  it('mixes gains and losses, and has one stale feed and one symbol without a change', async () => {
    const body = await prices();
    const changes = body.prices.map((entry) => entry.changeBps);
    expect(changes.filter((bps) => bps !== null && bps > 0).length).toBeGreaterThanOrEqual(5);
    expect(changes.filter((bps) => bps !== null && bps < 0).length).toBeGreaterThanOrEqual(5);
    expect(changes.filter((bps) => bps === null)).toHaveLength(1);
    expect(body.prices.filter((entry) => !entry.fresh)).toHaveLength(1);
    // A daily change of a tokenized stock: well inside twenty percent either way.
    for (const bps of changes) if (bps !== null) expect(Math.abs(bps)).toBeLessThan(2_000);
  });

  it('marks the halted symbols of market-halted as stale feeds', async () => {
    const body = await prices('market-halted');
    expect(body.prices.filter((entry) => !entry.fresh).map((entry) => entry.symbol)).toEqual(['AMD', 'QQQ']);
  });

  it('answers the round of the first week beside league-early', async () => {
    const body = await prices('league-early');
    const market = marketResponseSchema.parse(await ok(api('league-early').market(), 'market'));
    expect(body.tickId).toBe(market.market?.lastTickId);
    expect(body.prices).toHaveLength(UNIVERSE_SIZE);
    // Prices the early agents bought at on Thursday are the prices of the strip.
    expect(body.prices.find((entry) => entry.symbol === 'NVDA')?.priceMicro).toBe(184_030_000);
  });

  it('answers a null round and no prices before the first round and without a season', async () => {
    for (const fixture of ['league-unranked', 'league-none', 'market-none']) {
      expect(await prices(fixture), fixture).toEqual({ tickId: null, takenAt: null, prices: [] });
    }
  });

  it('fails like every read with fail-reads', async () => {
    const answer = await api('fail-reads').marketPrices();
    expect(answer.ok).toBe(false);
    expect(answer.status).toBe(500);
  });
});

/** What section 17.2 says of a row: at most three holdings, largest first, and a cash weight. */
function expectHoldings(row: StandingRow, where: string): void {
  expect(Array.isArray(row.topHoldings), `${where}: topHoldings of ${row.name}`).toBe(true);
  expect(typeof row.cashWeightBps, `${where}: cashWeightBps of ${row.name}`).toBe('number');
  const top = row.topHoldings ?? [];
  expect(top.length, `${where}: ${row.name}`).toBeLessThanOrEqual(3);
  const weights = top.map((entry) => entry.weightBps);
  expect(weights, `${where}: ${row.name}`).toEqual([...weights].sort((a, b) => b - a));
  expect(new Set(top.map((entry) => entry.symbol)).size, `${where}: ${row.name}`).toBe(top.length);
  for (const entry of top) expect(entry.weightBps, `${where}: ${row.name}`).toBeGreaterThan(0);
  expect(weights.reduce((sum, bps) => sum + bps, 0) + (row.cashWeightBps ?? 0)).toBeLessThanOrEqual(BPS + 3);
  if (row.tradeCount === 0) expect(row, `${where}: ${row.name}`).toMatchObject({ topHoldings: [], cashWeightBps: BPS });
}

async function league(fixture: string, division: 'open' | 'pro' = 'open'): Promise<LeagueResponse> {
  return leagueResponseSchema.parse(await ok(api(fixture).league({ division }), `${fixture} ${division}`));
}

describe('the holdings of the league fixtures', () => {
  it('are on every row of every league fixture, in both divisions', async () => {
    const names = pageNames.filter((name) => name.startsWith('league-') && name !== 'league-none');
    let rows = 0;
    for (const name of names) {
      for (const division of ['open', 'pro'] as const) {
        for (const row of (await league(name, division)).rows) expectHoldings(row, `${name} ${division}`);
        rows += (await league(name, division)).rows.length;
      }
    }
    expect(rows).toBeGreaterThan(50);
    // Cards of every kind can be seen: three holdings, fewer, and none at all.
    const counts = new Set((await league('league-ranked')).rows.map((row) => row.topHoldings?.length));
    expect(counts).toEqual(new Set([1, 2, 3]));
    expect((await league('league-unranked')).rows.every((row) => row.topHoldings?.length === 0)).toBe(true);
  });

  it('agree with the agent page of every agent that has one', async () => {
    const rows = [...(await league('league-pro')).rows, ...(await league('league-pro', 'pro')).rows];
    let pages = 0;
    for (const row of rows) {
      const answer = await api('league-pro').agent(row.agentId);
      if (!answer.ok) continue;
      const page = agentPublicSchema.parse(answer.data);
      pages += 1;
      expect(row.topHoldings, page.name).toEqual(
        page.holdings
          .slice()
          .sort((a, b) => b.valueMicro - a.valueMicro)
          .slice(0, 3)
          .map((entry) => ({ symbol: entry.symbol, weightBps: entry.weightBps })),
      );
      expect(row.cashWeightBps, page.name).toBe(page.cashWeightBps);
    }
    expect(pages).toBe(3);
  });

  it('give the house agents of league-early what their strategies hold', async () => {
    const rows = new Map((await league('league-early')).rows.map((row) => [row.name, row]));
    const holds = (name: string) => (rows.get(name)?.topHoldings ?? []).map((entry) => entry.symbol).sort();
    expect(holds('Index Core')).toEqual(['QQQ', 'SPY']);
    expect(holds('Semis Rotation')).toEqual(['AMD', 'NVDA']);
    expect(holds('Treasury First')).toEqual(['SGOV', 'SPY']);
    expect(holds('Dip Buyer')).toEqual(['COIN', 'INTC', 'MSTR']);
    expect(holds('Oil And Idle')).toEqual(['SGOV']);
    expect(holds('Crypto Proxies')).toEqual(['COIN', 'CRCL', 'MSTR']);
    expect(holds('Crowd Favourites')).toEqual(['GME', 'PLTR', 'TSLA']);
    // Five and six names are held: the card names three of them.
    for (const name of ['Momentum Five', 'Big Tech Equal']) expect(holds(name), name).toHaveLength(3);
    // The weights are those of the strategies: SGOV 40% in Treasury First; Index Core asked for 45% each and the
    // 40% limit on one name holds it at 40% each.
    expect(rows.get('Treasury First')?.topHoldings?.[0]).toMatchObject({ symbol: 'SGOV' });
    expect(Math.abs((rows.get('Treasury First')?.topHoldings?.[0]?.weightBps ?? 0) - 4_000)).toBeLessThan(100);
    for (const entry of rows.get('Index Core')?.topHoldings ?? []) {
      expect(Math.abs(entry.weightBps - 4_000), entry.symbol).toBeLessThan(150);
    }
    expect(Math.abs((rows.get('Oil And Idle')?.cashWeightBps ?? 0) - 6_000)).toBeLessThan(100);

    // The page of Semis Rotation says the same as its card.
    const page = agentPublicSchema.parse(await ok(api('league-early').agent('semisrotatio'), 'semis'));
    const card = rows.get('Semis Rotation');
    expect(card?.topHoldings).toEqual(
      page.holdings.map((entry) => ({ symbol: entry.symbol, weightBps: entry.weightBps })),
    );
    expect(card?.cashWeightBps).toBe(page.cashWeightBps);
  });
});
