import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FeedItem, StandingRow } from '@prix/contracts';
import {
  agentFeedResponseSchema,
  agentPublicSchema,
  followingFeedResponseSchema,
  followResponseSchema,
  followsResponseSchema,
  leagueFeedResponseSchema,
  leagueResponseSchema,
  marketResponseSchema,
  seasonResultsResponseSchema,
  seasonsResponseSchema,
} from '@prix/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import { repoRoot } from '../support/repo.ts';

const repoPath = (path: string): string => join(repoRoot(), path);

/**
 * The fixtures the pages are built and reviewed against (apps/web/src/lib/fixtures and
 * follow-fixtures.ts), held to the contract the API answers with since revision 5
 * (docs/CONTRACTS.md section 17). A page owner builds on these, so a fixture that the real API
 * could not send would hide a mistake until production.
 *
 * The two modules are loaded by path at run time: their types reach into the site's own
 * declarations, which the tests project does not compile.
 */

interface Call {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';
  path: string;
  body?: unknown;
}
type Transport = (call: Call) => Promise<Response>;

let pageTransport: (url: URL) => Transport;
let followTransport: (url: URL) => Transport;
let pageNames: readonly string[];
let followNames: readonly string[];

beforeAll(async () => {
  const pages = pathToFileURL(repoPath('apps/web/src/lib/fixtures/index.ts')).href;
  const follow = pathToFileURL(repoPath('apps/web/src/lib/follow-fixtures.ts')).href;
  const pageModule = (await import(/* @vite-ignore */ pages)) as {
    createFixtureTransport: (url: URL) => Transport;
    FIXTURE_NAMES: readonly string[];
  };
  const followModule = (await import(/* @vite-ignore */ follow)) as {
    createFollowFixtureTransport: (url: URL) => Transport;
    FOLLOW_FIXTURE_NAMES: readonly string[];
  };
  pageTransport = pageModule.createFixtureTransport;
  followTransport = followModule.createFollowFixtureTransport;
  pageNames = pageModule.FIXTURE_NAMES;
  followNames = followModule.FOLLOW_FIXTURE_NAMES;
});

const pageUrl = (fixture: string): URL =>
  new URL(`https://prix.test/${fixture === '' ? '' : `?fixture=${encodeURIComponent(fixture)}`}`);

async function page(fixture: string, path: string): Promise<{ status: number; json: unknown }> {
  const response = await pageTransport(pageUrl(fixture))({ method: 'GET', path });
  return { status: response.status, json: await response.json() };
}

async function follow(fixture: string, path: string, method: Call['method'] = 'GET', body?: unknown) {
  const response = await followTransport(pageUrl(fixture))({ method, path, body });
  return { status: response.status, json: response.status === 204 ? null : await response.json() };
}

async function league(fixture: string, division: 'open' | 'pro' = 'open') {
  const reply = await page(fixture, `/api/league?division=${division}`);
  expect(reply.status, `${fixture} ${division}`).toBe(200);
  return leagueResponseSchema.parse(reply.json);
}

async function leagueFeed(fixture: string, query = '') {
  const reply = await follow(fixture, `/api/feed/league${query}`);
  expect(reply.status, fixture).toBe(200);
  return leagueFeedResponseSchema.parse(reply.json);
}

const keyOf = (item: FeedItem): string => `${item.tickId}~${item.agentId}`;

/** The fields the API always sends since revision 5: present, and of the right kind. */
function expectProfile(row: StandingRow, where: string): void {
  expect(typeof row.summary, `${where}: summary of ${row.name}`).toBe('string');
  expect((row.summary ?? '').length, `${where}: summary of ${row.name}`).toBeGreaterThan(20);
  expect(typeof row.createdAt, `${where}: createdAt of ${row.name}`).toBe('string');
  expect(typeof row.house, `${where}: house of ${row.name}`).toBe('boolean');
}

describe('the league fixtures', () => {
  it('give every row a summary, a creation time and the house mark, in every state and both divisions', async () => {
    const names = pageNames.filter((name) => name.startsWith('league-') && name !== 'league-none');
    expect(names).toEqual(
      expect.arrayContaining(['league-ranked', 'league-unranked', 'league-round', 'league-ended', 'league-pro']),
    );
    expect(names).toContain('league-early');
    let rows = 0;
    for (const name of names) {
      for (const division of ['open', 'pro'] as const) {
        const body = await league(name, division);
        for (const row of body.rows) expectProfile(row, `${name} ${division}`);
        // An agent is made before it trades, and never after the tick its rank is as of.
        for (const row of body.rows) {
          if (body.state) expect((row.createdAt ?? 'missing') < body.state.tickId, row.name).toBe(true);
        }
        rows += body.rows.length;
      }
    }
    expect(rows).toBeGreaterThan(50);
  });

  it('marks some agents of the full board as house agents, and not all of them', async () => {
    const body = await league('league-ranked');
    const house = body.rows.filter((row) => row.house === true);
    expect(house.map((row) => row.name).sort()).toEqual(['Cash Is A Position', 'Equal Weight', 'Quiet Index']);
    expect(body.rows.length - house.length).toBe(11);
    // Both a ranked and an unranked house agent exist, so a card of each kind can be seen.
    expect(house.some((row) => row.rank !== null)).toBe(true);
    expect(house.some((row) => row.rank === null)).toBe(true);
    // The order New differs from the order Top: the creation times are not in rank order.
    const byRank = body.rows.map((row) => row.agentId);
    const byNew = [...body.rows]
      .sort((a, b) => ((a.createdAt ?? '') < (b.createdAt ?? '') ? 1 : -1))
      .map((r) => r.agentId);
    expect(byNew).not.toEqual(byRank);
  });
});

describe('league-early: production in its first week', () => {
  it('has nine house agents in Open, none ranked, and nobody in Pro', async () => {
    const open = await league('league-early');
    expect(open.rows).toHaveLength(9);
    expect(open.state).toMatchObject({ rankedCount: 0, agentCount: 9 });
    expect(open.seasonEnded).toBe(false);
    expect(open.round).toBeNull();
    expect(open.season).toMatchObject({
      number: 1,
      startsAt: '2026-10-05T00:00:00.000Z',
      endsAt: '2026-11-02T00:00:00.000Z',
    });
    for (const row of open.rows) {
      expect(row.house, row.name).toBe(true);
      expect(row.rank, row.name).toBeNull();
      expect(row.unrankedReason, row.name).toBe('min_trading_days');
      expect(Math.abs(row.seasonReturnBps), row.name).toBeLessThanOrEqual(100);
      expect([1, 2], row.name).toContain(row.spark.length);
      expect(row.tradingDays, row.name).toBe(row.spark.length);
      expect(row.equityMicro, row.name).toBe(row.spark[row.spark.length - 1]);
      expect(row.createdAt && row.createdAt >= '2026-10-06', row.name).toBe(true);
    }
    expect(new Set(open.rows.map((row) => row.spark.length))).toEqual(new Set([1, 2]));
    // Gains and losses both occur, so both colours of a signed figure can be seen.
    expect(open.rows.some((row) => row.seasonReturnBps > 0)).toBe(true);
    expect(open.rows.some((row) => row.seasonReturnBps < 0)).toBe(true);

    const pro = await league('league-early', 'pro');
    expect(pro.rows).toEqual([]);
    expect(pro.state).toMatchObject({ rankedCount: 0, agentCount: 0 });
  });

  it('names Index Core and the eight agents of infra/seed/house-agents.json', async () => {
    const seed = JSON.parse(readFileSync(repoPath('infra/seed/house-agents.json'), 'utf8')) as {
      agents: { name: string }[];
    };
    const open = await league('league-early');
    expect(open.rows.map((row) => row.name).sort()).toEqual(['Index Core', ...seed.agents.map((a) => a.name)].sort());
  });

  it('lists the agents without a rank in the order of the ranking rules', async () => {
    const { rows } = await league('league-early');
    const sorted = [...rows].sort(
      (a, b) =>
        b.seasonReturnBps - a.seasonReturnBps ||
        a.maxDrawdownBps - b.maxDrawdownBps ||
        a.tradeCount - b.tradeCount ||
        ((a.createdAt ?? '') < (b.createdAt ?? '') ? -1 : 1),
    );
    expect(rows.map((row) => row.name)).toEqual(sorted.map((row) => row.name));
  });

  it('answers the market and the seasons for the same season', async () => {
    const market = marketResponseSchema.parse((await page('league-early', '/api/market')).json);
    const seasons = seasonsResponseSchema.parse((await page('league-early', '/api/seasons')).json);
    const open = await league('league-early');
    expect(market.season).toEqual(open.season);
    expect(seasons.seasons).toEqual([open.season]);
    expect(market.market).toMatchObject({ open: true, lastTickId: open.state?.tickId, halted: [] });
  });
});

describe('the agent page fixtures', () => {
  const PAGES = ['slowcompound', 'macrotourist', 'gammascoutaa', 'wwwwwwwwwwww', 'semisrotatio'];

  it('carry the house mark on every page', async () => {
    for (const id of PAGES) {
      const reply = await page('', `/api/agents/${id}`);
      expect(reply.status, id).toBe(200);
      const agent = agentPublicSchema.parse(reply.json);
      expect(typeof agent.house, id).toBe('boolean');
      expect(agent.house, id).toBe(id === 'semisrotatio');
    }
  });

  it('has a house agent in its first week: two points, no rank, one decision', async () => {
    const agent = agentPublicSchema.parse((await page('league-early', '/api/agents/semisrotatio')).json);
    expect(agent).toMatchObject({ name: 'Semis Rotation', house: true, division: 'open', rank: null, rankedCount: 0 });
    expect(agent.unrankedReason).toBe('min_trading_days');
    expect(agent.model).toEqual({ kind: 'house' });
    expect(agent.stats.daily).toHaveLength(2);
    expect(agent.stats.tradingDays).toBe(2);
    expect(agent.stats.decidedCount).toBe(1);
    expect(agent.decisions.filter((row) => row.status === 'decided')).toHaveLength(1);
    expect(agent.decisions).toHaveLength(2);
    expect(Math.abs(agent.stats.seasonReturnBps)).toBeLessThanOrEqual(100);
    // The holdings and the cash add up to the value of the portfolio.
    const held = agent.holdings.reduce((sum, entry) => sum + entry.valueMicro, 0);
    expect(held + agent.cashMicro).toBe(agent.stats.equityMicro);
    expect(agent.holdings.map((entry) => entry.symbol).sort()).toEqual(['AMD', 'NVDA']);

    // Its card on the league says the same as its page.
    const row = (await league('league-early')).rows.find((entry) => entry.agentId === agent.id);
    expect(row).toMatchObject({
      name: agent.name,
      summary: agent.summary,
      createdAt: agent.createdAt,
      seasonReturnBps: agent.stats.seasonReturnBps,
      maxDrawdownBps: agent.stats.maxDrawdownBps,
      tradeCount: agent.stats.tradeCount,
      equityMicro: agent.stats.equityMicro,
      spark: agent.stats.daily.map((point) => point.equityMicro),
    });
    expect(agent.season).toEqual((await league('league-early')).season);

    // And its own feed has its one decision, marked as a house agent's.
    const feed = agentFeedResponseSchema.parse((await follow('league-early', '/api/agents/semisrotatio/feed')).json);
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0]).toMatchObject({ agentId: agent.id, house: true, simulated: true });
    expect(feed.agent).toEqual({ id: agent.id, name: agent.name, division: 'open' });
  });
});

describe('the league feed fixtures', () => {
  it('has eight decisions with fills in several symbols, two of them of house agents', async () => {
    const feed = await leagueFeed('');
    expect(feed.items).toHaveLength(8);
    expect(feed.nextCursor).toBeNull();
    expect(feed.delay).toEqual({ seconds: 0, gatingOn: false });
    for (const item of feed.items) {
      expect(item.fills.length, item.agentName).toBeGreaterThan(0);
      expect(item.simulated).toBe(true);
      expect(typeof item.house, item.agentName).toBe('boolean');
      expect(item.reason.length, item.agentName).toBeGreaterThan(10);
    }
    expect(
      feed.items
        .filter((item) => item.house === true)
        .map((item) => item.agentName)
        .sort(),
    ).toEqual(['Cash Is A Position', 'Quiet Index']);
    const symbols = new Set(feed.items.flatMap((item) => item.fills.map((entry) => entry.symbol)));
    expect(symbols.size).toBeGreaterThanOrEqual(8);
    expect(new Set(feed.items.map((item) => item.agentId)).size).toBe(8);
    // In the order of the API: newest tick first, then agent id descending.
    const keys = feed.items.map(keyOf);
    expect(keys).toEqual([...keys].sort().reverse());
    expect(new Set(feed.items.map((item) => item.tickId)).size).toBe(2);

    // Every item is of an agent the full board shows, with the same mark.
    const rows = new Map((await league('league-ranked')).rows.map((row) => [row.agentId, row]));
    for (const item of feed.items) {
      expect(rows.get(item.agentId), item.agentName).toMatchObject({ name: item.agentName, house: item.house });
    }
  });

  it('pages with the cursor and the limit of the other feeds', async () => {
    const all = (await leagueFeed('')).items.map(keyOf);
    const first = await leagueFeed('', '?limit=3');
    expect(first.items.map(keyOf)).toEqual(all.slice(0, 3));
    // Section 20: the cursor of the API is the last item's key, signed. The schema above checks the
    // shape; a fixture signs with a fixed fake signature, and the web passes it back unchanged.
    expect(first.nextCursor?.startsWith(`${all[2]}~`), String(first.nextCursor)).toBe(true);
    expect(first.nextCursor).toMatch(/~[a-z2-7]{16}$/);
    const second = await leagueFeed('', `?limit=3&cursor=${encodeURIComponent(first.nextCursor ?? '')}`);
    expect(second.items.map(keyOf)).toEqual(all.slice(3, 6));
    const third = await leagueFeed('', `?limit=3&cursor=${encodeURIComponent(second.nextCursor ?? '')}`);
    expect(third.items.map(keyOf)).toEqual(all.slice(6));
    expect(third.nextCursor).toBeNull();
  });

  it('hands out signed cursors on the feed of followed agents and on an agent feed too, and takes them back', async () => {
    for (const [path, schema] of [
      ['/api/feed', followingFeedResponseSchema],
      ['/api/agents/slowcompound/feed', agentFeedResponseSchema],
    ] as const) {
      const all = schema.parse((await follow('', `${path}?limit=30`)).json).items.map(keyOf);
      expect(all.length, path).toBeGreaterThan(1);
      const first = schema.parse((await follow('', `${path}?limit=1`)).json);
      expect(first.items.map(keyOf), path).toEqual(all.slice(0, 1));
      expect(first.nextCursor?.startsWith(`${all[0]}~`), `${path}: ${first.nextCursor}`).toBe(true);
      const cursor = encodeURIComponent(first.nextCursor ?? '');
      const second = schema.parse((await follow('', `${path}?limit=1&cursor=${cursor}`)).json);
      expect(second.items.map(keyOf), path).toEqual(all.slice(1, 2));
    }
  });

  it('has an empty form', async () => {
    for (const fixture of [
      'feed-league-empty',
      'league-early,feed-league-empty',
      'feed-league-empty,follow-signed-out',
    ]) {
      expect(await leagueFeed(fixture)).toEqual({
        items: [],
        nextCursor: null,
        delay: { seconds: 0, gatingOn: false },
      });
    }
  });

  it('is the feed of the nine house agents beside league-early, unless another is named', async () => {
    const early = await leagueFeed('league-early');
    expect(early.items).toHaveLength(13);
    expect(early.items.every((item) => item.house === true)).toBe(true);
    const keys = early.items.map(keyOf);
    expect(keys).toEqual([...keys].sort().reverse());
    const rows = new Map((await league('league-early')).rows.map((row) => [row.agentId, row.name]));
    for (const item of early.items) expect(rows.get(item.agentId), item.agentName).toBe(item.agentName);
    expect(new Set(early.items.map((item) => item.agentId)).size).toBe(9);
    // The newest item of each agent carries the value its card shows, unless its newest row has no decision.
    expect(await leagueFeed('feed-league-early')).toEqual(early);
    expect((await leagueFeed('league-early,feed-league')).items).toHaveLength(8);
  });

  it('is the same signed in and signed out, and needs no session', async () => {
    const signedIn = await leagueFeed('follow-signed-in');
    expect(await leagueFeed('follow-signed-out')).toEqual(signedIn);
    expect(await leagueFeed('signed-out')).toEqual(signedIn);
    // The feed of followed agents still needs one.
    expect((await follow('follow-signed-out', '/api/feed')).status).toBe(401);
  });
});

describe('the other feed fixtures', () => {
  it('say house on every item', async () => {
    const own = agentFeedResponseSchema.parse((await follow('', '/api/agents/slowcompound/feed')).json);
    const following = followingFeedResponseSchema.parse((await follow('', '/api/feed')).json);
    expect(own.items.length).toBeGreaterThan(0);
    expect(following.items.length).toBeGreaterThan(0);
    for (const item of [...own.items, ...following.items]) expect(typeof item.house).toBe('boolean');
  });
});

describe('the house mark on follows and season results (docs/CONTRACTS.md section 17.1)', () => {
  it('says house on every follow, and the three follows hold a house agent and others', async () => {
    for (const fixture of ['follows-three', 'follows-full']) {
      const body = followsResponseSchema.parse((await follow(fixture, '/api/follows')).json);
      for (const entry of body.follows) expect(typeof entry.house, `${fixture}: ${entry.name}`).toBe('boolean');
    }
    const three = followsResponseSchema.parse((await follow('follows-three', '/api/follows')).json).follows;
    expect(three.filter((entry) => entry.house).map((entry) => entry.name)).toEqual(['Quiet Index']);
    expect(three.filter((entry) => !entry.house)).toHaveLength(2);
  });

  it('marks a followed house agent the same in the league, the follows and the feed of followed agents', async () => {
    const quiet = (await league('league-ranked')).rows.find((row) => row.name === 'Quiet Index');
    expect(quiet?.house).toBe(true);
    const three = followsResponseSchema.parse((await follow('follows-three', '/api/follows')).json).follows;
    expect(three.find((entry) => entry.name === 'Quiet Index')?.agentId).toBe(quiet?.agentId);
    const following = followingFeedResponseSchema.parse((await follow('', '/api/feed')).json);
    const items = following.items.filter((item) => item.agentId === quiet?.agentId);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) expect(item.house).toBe(true);
    // A follow made from the board carries the mark of the agent it follows.
    const made = await follow('league-ranked', `/api/follows/${quiet?.agentId}`, 'PUT', { notify: false });
    expect(followResponseSchema.parse(made.json).follow.house).toBe(true);
  });

  it('says house on every row and award of the final results, with a house agent among them', async () => {
    const body = seasonResultsResponseSchema.parse((await follow('results-final', '/api/seasons/1/results')).json);
    let house = 0;
    for (const division of body.divisions) {
      const byId = new Map(division.top.map((row) => [row.agentId, row]));
      for (const row of division.top) {
        expect(typeof row.house, row.name).toBe('boolean');
        if (row.house) house += 1;
      }
      for (const award of division.awards) {
        // An award names a row of the table, with its name, its numbers and its mark.
        const row = byId.get(award.agentId);
        expect(row, `${award.kind} ${division.division}`).toBeDefined();
        expect(award).toMatchObject({
          name: row?.name,
          seasonReturnBps: row?.seasonReturnBps,
          maxDrawdownBps: row?.maxDrawdownBps,
          house: row?.house,
        });
      }
    }
    expect(house).toBeGreaterThan(0);
    const open = body.divisions.find((division) => division.division === 'open');
    expect(open?.awards.map((award) => award.house)).toEqual([true, false]);
  });
});

describe('the fixture names', () => {
  it('list the new names, and neither transport takes a name of the other for a mistake', async () => {
    expect(pageNames).toContain('league-early');
    expect(followNames).toEqual(expect.arrayContaining(['feed-league', 'feed-league-early', 'feed-league-empty']));
    for (const name of ['league-early', 'feed-league', 'feed-league-early', 'feed-league-empty']) {
      expect((await page(name, '/api/league')).status, `page transport, ${name}`).toBe(200);
      expect((await follow(name, '/api/feed/league')).status, `follow transport, ${name}`).toBe(200);
    }
    expect((await page('league-earli', '/api/league')).status).toBe(500);
    expect((await follow('feed-leage', '/api/feed/league')).status).toBe(500);
  });

  it('lets a signed-in visitor follow any agent a league fixture shows', async () => {
    for (const fixture of ['league-ranked', 'league-early', 'league-pro']) {
      for (const division of ['open', 'pro'] as const) {
        for (const row of (await league(fixture, division)).rows) {
          const reply = await follow(fixture, `/api/follows/${row.agentId}`, 'PUT', { notify: false });
          expect([200, 201], `${fixture}: ${row.name}`).toContain(reply.status);
          expect(reply.json).toMatchObject({ follow: { agentId: row.agentId, name: row.name, division } });
        }
      }
    }
  });
});
