import type {
  AgentFeedResponse,
  ApiError,
  ApiErrorCode,
  FeedItem,
  FeedPage,
  FollowEntry,
  FollowingFeedResponse,
  FollowsResponse,
  LeagueFeedResponse,
  NotificationsResponse,
  SeasonResultsResponse,
  TelegramLinkResponse,
} from '@prix/contracts';
import { MAX_FOLLOWS_PER_WALLET } from '@prix/contracts';
import type { ApiCall } from './api.ts';
import { fill, SLOW_COMPOUNDER_ID } from './fixtures/agent.ts';
import { EARLY_FEED_ITEMS, EARLY_HOUSE_AGENT, EARLY_HOUSE_AGENT_FOLLOWERS, earlyAgent } from './fixtures/early.ts';
import { fixtureCursor } from './fixtures/feed-cursor.ts';
import { FIXTURE_NAMES as PAGE_FIXTURE_NAMES } from './fixtures/index.ts';
import { openSampleRow, sampleAgent } from './fixtures/league.ts';

/** A call of the follow client. Phase 1's `ApiCall` has no PUT, which `PUT /api/follows/:agentId` needs. */
export interface FollowCall extends Omit<ApiCall, 'method'> {
  method: ApiCall['method'] | 'PUT';
}
export type FollowTransport = (call: FollowCall) => Promise<Response>;

/**
 * Fixtures for the follow client (`follow-api.ts`): what the API would answer, for building and
 * reviewing the follow pages before the API exists. Reached only when the site is built with
 * PRIX_FIXTURES=1. `?fixture=<name>` on the page URL selects the state, several names separated
 * by commas, one per group. A group left out means its first name.
 *
 *   visitor   follow-signed-in, follow-signed-out (every signed-in call answers 401)
 *   follows   follows-three (one of them Quiet Index, a house agent), follows-none, follows-full
 *             (25 follows, some of house agents). Every follow says `house` (section 17.1).
 *   feed      feed-no-delay (preview, gating off), feed-delayed (gating on, held back 24 hours),
 *             feed-empty (no items). These three are the feed of one agent and of followed agents.
 *   league feed  GET /api/feed/league, the feed that is the same for everyone:
 *             feed-league (eight decisions with fills in eleven symbols, two of them of house
 *             agents), feed-league-early (the thirteen decisions of the nine house agents of the
 *             page fixture league-early), feed-league-empty (no decision yet). With league-early
 *             and no name of this group, the league feed is feed-league-early. The league feed
 *             is never held back in the fixtures, as in production while the token does not exist.
 *   telegram  telegram-linked, telegram-not-linked (available, not linked), telegram-paused
 *             (linked, paused), telegram-unavailable (the bot is not configured: 404),
 *             telegram-delayed (linked, notes held back by gating)
 *   results   results-final (Open Agent 1, the season leader, and Open Agent 4 are house agents),
 *             results-not-final; results-none answers 404. Every row and award says `house`.
 *   failure   follow-fail-reads (every read answers 500), follow-error-<code> (every write answers
 *             that error): follow-error-forbidden, follow-error-not-found, follow-error-rate-limited,
 *             follow-error-follow-limit (409 invalid_input, field follows)
 *
 * An unknown name makes every call fail, so a typing mistake is seen at once.
 */

const AGENT_A = SLOW_COMPOUNDER_ID;
/** Quiet Index of the sample league: a house agent, with the same id and mark as on the board. */
const AGENT_B = openSampleRow('Quiet Index').agentId;
const AGENT_C = 'cccccccccccc';
const OWNED_BY_VIEWER = 'dddddddddddd';

const AGENTS = [
  { id: AGENT_A, name: 'Slow Compounder', division: 'open' as const, house: false },
  { id: AGENT_B, name: 'Quiet Index', division: 'open' as const, house: true },
  { id: AGENT_C, name: 'Macro Tourist', division: 'pro' as const, house: false },
];

const THREE_FOLLOWS: FollowEntry[] = [
  {
    agentId: AGENT_A,
    name: 'Slow Compounder',
    division: 'open',
    notify: true,
    createdAt: '2026-10-04T09:00:00.000Z',
    house: false,
  },
  {
    agentId: AGENT_B,
    name: 'Quiet Index',
    division: 'open',
    notify: false,
    createdAt: '2026-10-03T12:30:00.000Z',
    house: true,
  },
  {
    agentId: AGENT_C,
    name: 'Macro Tourist',
    division: 'pro',
    notify: true,
    createdAt: '2026-10-02T18:10:00.000Z',
    house: false,
  },
];

function fullFollows(): FollowEntry[] {
  return Array.from({ length: MAX_FOLLOWS_PER_WALLET }, (_, index) => {
    const agent = AGENTS[index % AGENTS.length] ?? AGENTS[0];
    return {
      agentId: `fffffffffff${String.fromCharCode(97 + index)}`,
      name: `${agent?.name ?? 'Agent'} ${index + 1}`,
      division: agent?.division ?? 'open',
      notify: index % 2 === 0,
      createdAt: `2026-10-0${(index % 5) + 1}T10:00:00.000Z`,
      house: agent?.house === true,
    };
  });
}

function feedItem(index: number, agent: (typeof AGENTS)[number], tickId: string): FeedItem {
  const traded = index % 3 !== 2;
  return {
    agentId: agent.id,
    agentName: agent.name,
    division: agent.division,
    tickId,
    at: `${tickId.slice(0, 13)}:04:11.000Z`,
    reason: traded
      ? 'Rotated part of the paper portfolio toward the energy names after the morning move.'
      : 'Kept the paper portfolio as it was; no target changed.',
    fills: traded
      ? [
          {
            symbol: 'NVDA',
            side: 'buy',
            unitsMicro: 2_500_000,
            priceMicro: 120_000_000,
            notionalMicro: 300_000_000,
            feeMicro: 300_000,
            slippageMicro: 150_000,
          },
          {
            symbol: 'TSLA',
            side: 'sell',
            unitsMicro: 1_000_000,
            priceMicro: 240_000_000,
            notionalMicro: 240_000_000,
            feeMicro: 240_000,
            slippageMicro: 120_000,
          },
        ]
      : [],
    halted: index % 4 === 3 ? ['AMD'] : [],
    equityMicro: 10_000_000_000 + index * 25_000_000,
    costMicro: traded ? 810_000 : 0,
    simulated: true,
    house: agent.house,
  };
}

const TICKS = [
  '2026-10-06T15:00Z',
  '2026-10-06T14:00Z',
  '2026-10-06T13:00Z',
  '2026-10-05T20:00Z',
  '2026-10-05T19:00Z',
  '2026-10-05T18:00Z',
];

const FEED_ITEMS: FeedItem[] = TICKS.flatMap((tickId, tickIndex) =>
  AGENTS.slice()
    .reverse()
    .map((agent, agentIndex) => feedItem(tickIndex * 3 + agentIndex, agent, tickId)),
);

// --- the league feed -----------------------------------------------------------------------------

/** One decision of an agent of the Open sample league, at the daily round of `day`. */
function leagueItem(name: string, day: string, reason: string, fills: FeedItem['fills']): FeedItem {
  const agent = openSampleRow(name);
  return {
    agentId: agent.agentId,
    agentName: agent.name,
    division: 'open',
    tickId: `${day}T15:00Z`,
    at: `${day}T15:02:11.000Z`,
    reason,
    fills,
    halted: [],
    equityMicro: agent.equityMicro,
    costMicro: fills.reduce((sum, entry) => sum + entry.feeMicro + entry.slippageMicro, 0),
    simulated: true,
    house: agent.house === true,
  };
}

const feedOrder = (a: FeedItem, b: FeedItem): number =>
  `${a.tickId}~${a.agentId}` < `${b.tickId}~${b.agentId}` ? 1 : -1;

/**
 * `feed-league`: eight decisions of the sample league, five of Tuesday's round and three of
 * Monday's, every one with fills. Quiet Index and Cash Is A Position are house agents.
 */
const LEAGUE_FEED_ITEMS: FeedItem[] = [
  leagueItem(
    'Slow Compounder',
    '2026-10-06',
    'Semiconductor strength has held for five sessions, so the portfolio adds to its strongest position within the 40% limit.',
    [fill('NVDA', 'buy', 320, 182.41)],
  ),
  leagueItem(
    'Semis Only',
    '2026-10-06',
    'AMD has the stronger week of the four, so part of the Intel position moves there.',
    [fill('INTC', 'sell', 640, 36.12), fill('AMD', 'buy', 655, 212.35)],
  ),
  leagueItem(
    'Dip Buyer 9',
    '2026-10-06',
    'Tesla fell the most in the last session and replaces Palantir, which has recovered.',
    [fill('PLTR', 'sell', 505, 186.4), fill('TSLA', 'buy', 520, 438.2)],
  ),
  leagueItem('Quiet Index', '2026-10-06', 'SPY drifted five points under its target, so it is topped up.', [
    fill('SPY', 'buy', 410, 671.25),
  ]),
  leagueItem('Earnings Hawk', '2026-10-06', 'Microsoft reports this week, so the position grows to its 15% limit.', [
    fill('MSFT', 'buy', 700, 512.3),
  ]),
  leagueItem('Cash Is A Position', '2026-10-05', 'No trend is up, so idle cash moves into Treasury bills.', [
    fill('SGOV', 'buy', 900, 100.42),
  ]),
  leagueItem('Barbell', '2026-10-05', 'The weekly rebalance moves part of the growth side into oil.', [
    fill('QQQ', 'sell', 380, 605.9),
    fill('USO', 'buy', 372, 71.3),
  ]),
  leagueItem(
    'Trend Follower v2',
    '2026-10-05',
    'Coinbase closed below its ten-day average, so the position is cut by half.',
    [fill('COIN', 'sell', 450, 318.6)],
  ),
].sort(feedOrder);

const LEAGUE_FEED_NAMES = ['feed-league', 'feed-league-early', 'feed-league-empty'] as const;
type LeagueFeedName = (typeof LEAGUE_FEED_NAMES)[number];

const LEAGUE_FEEDS: Record<LeagueFeedName, readonly FeedItem[]> = {
  'feed-league': LEAGUE_FEED_ITEMS,
  'feed-league-early': EARLY_FEED_ITEMS,
  'feed-league-empty': [],
};

/** The page fixture that shows production in its first week. Beside it the league feed is the early one. */
const LEAGUE_EARLY = 'league-early';

/** The one decision of the house agent whose page is /agents/semisrotatio, as its feed lists it. */
const HOUSE_AGENT_FEED_ITEMS: FeedItem[] = EARLY_FEED_ITEMS.filter((item) => item.agentId === EARLY_HOUSE_AGENT.id);

const NO_DELAY = { seconds: 0, gatingOn: false };
const ONE_DAY = { seconds: 86_400, gatingOn: true };

const SEASON = {
  id: 'seasonaaaaaa',
  number: 1,
  startsAt: '2026-09-28T00:00:00.000Z',
  endsAt: '2026-10-26T00:00:00.000Z',
};

/** The ranks of the house agents of the final results: in Open, the season leader and rank 4. */
const HOUSE_RANKS: Readonly<Record<string, readonly number[]>> = { a: [1, 4], b: [] };

function topRows(prefix: string, count: number): SeasonResultsResponse['divisions'][number]['top'] {
  return Array.from({ length: count }, (_, index) => ({
    rank: index + 1,
    agentId: `${prefix.repeat(11)}${String.fromCharCode(97 + index)}`,
    name: `${prefix === 'a' ? 'Open' : 'Pro'} Agent ${index + 1}`,
    seasonReturnBps: 1_850 - index * 210,
    maxDrawdownBps: 400 + index * 90,
    tradingDays: 20,
    house: (HOUSE_RANKS[prefix] ?? []).includes(index + 1),
  }));
}

const RESULTS_FINAL: SeasonResultsResponse = {
  season: SEASON,
  final: true,
  divisions: [
    {
      division: 'open',
      rankedCount: 48,
      top: topRows('a', 10),
      awards: [
        {
          kind: 'season_leader',
          division: 'open',
          agentId: 'aaaaaaaaaaaa',
          name: 'Open Agent 1',
          seasonReturnBps: 1_850,
          maxDrawdownBps: 400,
          house: true,
        },
        {
          kind: 'steadiest',
          division: 'open',
          agentId: 'aaaaaaaaaaac',
          name: 'Open Agent 3',
          seasonReturnBps: 1_430,
          maxDrawdownBps: 580,
          house: false,
        },
      ],
    },
    {
      division: 'pro',
      rankedCount: 12,
      top: topRows('b', 10),
      awards: [
        {
          kind: 'season_leader',
          division: 'pro',
          agentId: 'bbbbbbbbbbba',
          name: 'Pro Agent 1',
          seasonReturnBps: 1_850,
          maxDrawdownBps: 400,
          house: false,
        },
        {
          kind: 'steadiest',
          division: 'pro',
          agentId: 'bbbbbbbbbbbb',
          name: 'Pro Agent 2',
          seasonReturnBps: 1_640,
          maxDrawdownBps: 490,
          house: false,
        },
      ],
    },
  ],
  prize: 'none',
};

const RESULTS_NOT_FINAL: SeasonResultsResponse = {
  season: SEASON,
  final: false,
  divisions: [
    { division: 'open', rankedCount: 48, top: [], awards: [] },
    { division: 'pro', rankedCount: 12, top: [], awards: [] },
  ],
  prize: 'none',
};

const BOT = 'PrixLeagueBot';
const LINKED_AT = '2026-10-05T08:15:00.000Z';

const TELEGRAM = {
  linked: { available: true, linked: true, enabled: true, botUsername: BOT, linkedAt: LINKED_AT, delayed: false },
  notLinked: { available: true, linked: false, enabled: false, botUsername: BOT, linkedAt: null, delayed: false },
  paused: { available: true, linked: true, enabled: false, botUsername: BOT, linkedAt: LINKED_AT, delayed: false },
  delayed: { available: true, linked: true, enabled: true, botUsername: BOT, linkedAt: LINKED_AT, delayed: true },
  unavailable: { available: false, linked: false, enabled: false, botUsername: null, linkedAt: null, delayed: false },
} as const;

type TelegramName =
  | 'telegram-linked'
  | 'telegram-not-linked'
  | 'telegram-paused'
  | 'telegram-delayed'
  | 'telegram-unavailable';

const TELEGRAM_NAMES: Record<TelegramName, NotificationsResponse['telegram']> = {
  'telegram-linked': TELEGRAM.linked,
  'telegram-not-linked': TELEGRAM.notLinked,
  'telegram-paused': TELEGRAM.paused,
  'telegram-delayed': TELEGRAM.delayed,
  'telegram-unavailable': TELEGRAM.unavailable,
};

const ERROR_STATUS: Partial<Record<ApiErrorCode, number>> = {
  forbidden: 403,
  not_found: 404,
  rate_limited: 429,
  invalid_input: 409,
};

const ERROR_NAMES = new Map<string, { code: ApiErrorCode; field: string | null }>([
  ['follow-error-forbidden', { code: 'forbidden', field: null }],
  ['follow-error-not-found', { code: 'not_found', field: null }],
  ['follow-error-rate-limited', { code: 'rate_limited', field: null }],
  ['follow-error-follow-limit', { code: 'invalid_input', field: 'follows' }],
]);

const FEED_NAMES = ['feed-no-delay', 'feed-delayed', 'feed-empty'] as const;
const FOLLOW_NAMES = ['follows-three', 'follows-none', 'follows-full'] as const;
const RESULT_NAMES = ['results-final', 'results-not-final', 'results-none'] as const;

/** Every name `?fixture=` accepts for the follow client. */
export const FOLLOW_FIXTURE_NAMES: readonly string[] = [
  'follow-signed-in',
  'follow-signed-out',
  ...FOLLOW_NAMES,
  ...FEED_NAMES,
  ...LEAGUE_FEED_NAMES,
  ...Object.keys(TELEGRAM_NAMES),
  ...RESULT_NAMES,
  'follow-fail-reads',
  ...ERROR_NAMES.keys(),
];

interface Selection {
  signedIn: boolean;
  follows: FollowEntry[];
  feed: (typeof FEED_NAMES)[number];
  /** Null when no name of the league feed group was given: the page fixture then decides. */
  leagueFeed: LeagueFeedName | null;
  /** True when the page fixture is `league-early`. */
  early: boolean;
  telegram: NotificationsResponse['telegram'];
  results: (typeof RESULT_NAMES)[number];
  failReads: boolean;
  writeError: { code: ApiErrorCode; field: string | null } | null;
  unknown: string[];
}

function select(url: URL): Selection {
  const selection: Selection = {
    signedIn: true,
    follows: THREE_FOLLOWS,
    feed: 'feed-no-delay',
    leagueFeed: null,
    early: false,
    telegram: TELEGRAM.linked,
    results: 'results-final',
    failReads: false,
    writeError: null,
    unknown: [],
  };
  const names = (url.searchParams.get('fixture') ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
  for (const name of names) {
    const telegram = TELEGRAM_NAMES[name as TelegramName];
    const writeError = ERROR_NAMES.get(name);
    if (name === 'follow-signed-in') selection.signedIn = true;
    else if (name === 'follow-signed-out') selection.signedIn = false;
    else if (name === 'follows-three') selection.follows = THREE_FOLLOWS;
    else if (name === 'follows-none') selection.follows = [];
    else if (name === 'follows-full') selection.follows = fullFollows();
    else if ((FEED_NAMES as readonly string[]).includes(name)) selection.feed = name as Selection['feed'];
    else if ((LEAGUE_FEED_NAMES as readonly string[]).includes(name)) selection.leagueFeed = name as LeagueFeedName;
    else if (name === LEAGUE_EARLY) selection.early = true;
    else if (telegram) selection.telegram = telegram;
    else if ((RESULT_NAMES as readonly string[]).includes(name)) selection.results = name as Selection['results'];
    else if (name === 'follow-fail-reads') selection.failReads = true;
    else if (name === 'signed-out') selection.signedIn = false;
    else if (PAGE_FIXTURE_NAMES.includes(name))
      continue; // a name of the page transport: not ours
    else if (writeError) selection.writeError = writeError;
    else selection.unknown.push(name);
  }
  return selection;
}

const json = (status: number, body: unknown): Response => Response.json(body, { status });
const noContent = (): Response => new Response(null, { status: 204 });

function failure(code: ApiErrorCode, status: number, message: string, field: string | null = null): Response {
  const body: ApiError = { error: { code, message, field } };
  return json(status, body);
}

const SIGN_IN = (): Response => failure('unauthorized', 401, 'Sign in to continue.');
const NOT_FOUND = (): Response => failure('not_found', 404, 'Nothing exists at that address.');

/** One page of a list of feed items, with the cursor of the API: the tick and the agent of the last item. */
function pageOf(items: readonly FeedItem[], cursor: string | null, limit: number, delay: FeedPage['delay']): FeedPage {
  const start = cursor === null ? 0 : items.findIndex((item) => fixtureCursor(item) === cursor) + 1;
  const page = items.slice(start, start + limit);
  const last = page[page.length - 1];
  const more = start + limit < items.length;
  return { items: page, nextCursor: more && last ? fixtureCursor(last) : null, delay };
}

function feedPage(selection: Selection, cursor: string | null, limit: number): FeedPage {
  const items = selection.feed === 'feed-empty' ? [] : FEED_ITEMS;
  return pageOf(items, cursor, limit, selection.feed === 'feed-delayed' ? ONE_DAY : NO_DELAY);
}

/** The league feed is the same whoever asks, so the visitor group does not change it. */
function leagueFeedPage(selection: Selection, cursor: string | null, limit: number): LeagueFeedResponse {
  const name = selection.leagueFeed ?? (selection.early ? 'feed-league-early' : 'feed-league');
  return pageOf(LEAGUE_FEEDS[name], cursor, limit, NO_DELAY);
}

function pageQuery(url: URL): { cursor: string | null; limit: number } {
  const limit = Number(url.searchParams.get('limit') ?? 20);
  return { cursor: url.searchParams.get('cursor'), limit: Number.isInteger(limit) && limit > 0 ? limit : 20 };
}

/** The follow client's fixture transport. `url` is the page URL, which carries `?fixture=`. */
export function createFollowFixtureTransport(url: URL): FollowTransport {
  const selection = select(url);
  return async (call: FollowCall): Promise<Response> => {
    const target = new URL(call.path, 'https://fixtures.invalid');
    const path = target.pathname;
    if (selection.unknown.length > 0) {
      return failure('internal', 500, `Unknown fixture name: ${selection.unknown.join(', ')}`);
    }
    if (call.method === 'GET' && selection.failReads) return failure('internal', 500, 'Fixture: every read fails.');
    if (call.method !== 'GET' && selection.writeError) {
      const { code, field } = selection.writeError;
      return failure(code, ERROR_STATUS[code] ?? 500, 'Fixture: every write fails.', field);
    }
    const telegramOff = selection.telegram.available === false;

    if (call.method === 'GET' && path === '/api/push/key') {
      // A fixed public-looking key (65 zero bytes in base64url) so the control can be seen.
      return json(200, { key: `B${'A'.repeat(86)}` });
    }
    if (call.method === 'GET' && path === '/api/follows') {
      if (!selection.signedIn) return SIGN_IN();
      const body: FollowsResponse = { follows: selection.follows, limit: MAX_FOLLOWS_PER_WALLET };
      return json(200, body);
    }
    const follow = /^\/api\/follows\/([^/]+)$/.exec(path);
    if (follow) {
      if (!selection.signedIn) return SIGN_IN();
      const agentId = decodeURIComponent(follow[1] ?? '');
      if (call.method === 'DELETE') return noContent();
      if (call.method === 'PUT') {
        if (agentId === OWNED_BY_VIEWER) return failure('forbidden', 403, 'You cannot follow your own agent.');
        // Any agent a league fixture shows can be followed, so the control of every card answers.
        // The league the page shows is asked first: an id can name an agent in each of the two.
        const shown = selection.early
          ? (earlyAgent(agentId) ?? sampleAgent(agentId))
          : (sampleAgent(agentId) ?? earlyAgent(agentId));
        const agent = AGENTS.find((entry) => entry.id === agentId) ?? shown;
        if (!agent) return NOT_FOUND();
        const notify = (call.body as { notify?: boolean } | undefined)?.notify === true;
        const existing = selection.follows.some((entry) => entry.agentId === agentId);
        return json(existing ? 200 : 201, {
          follow: {
            agentId,
            name: agent.name,
            division: agent.division,
            notify,
            createdAt: '2026-10-06T12:00:00.000Z',
            house: agent.house,
          },
        });
      }
    }
    if (call.method === 'GET' && path === '/api/feed/league') {
      const { cursor, limit } = pageQuery(target);
      return json(200, leagueFeedPage(selection, cursor, limit));
    }
    const agentFeed = /^\/api\/agents\/([^/]+)\/feed$/.exec(path);
    if (call.method === 'GET' && agentFeed) {
      const agentId = decodeURIComponent(agentFeed[1] ?? '');
      if (agentId === EARLY_HOUSE_AGENT.id) {
        const { cursor, limit } = pageQuery(target);
        const body: AgentFeedResponse = {
          ...pageOf(HOUSE_AGENT_FEED_ITEMS, cursor, limit, NO_DELAY),
          agent: { id: EARLY_HOUSE_AGENT.id, name: EARLY_HOUSE_AGENT.name, division: EARLY_HOUSE_AGENT.division },
          followerCount: EARLY_HOUSE_AGENT_FOLLOWERS,
        };
        return json(200, body);
      }
      const agent = AGENTS.find((entry) => entry.id === agentId);
      if (!agent) return NOT_FOUND();
      const { cursor, limit } = pageQuery(target);
      // The agent's own items first, then the page, so that a page and its cursor hold only this agent.
      const items = (selection.feed === 'feed-empty' ? [] : FEED_ITEMS).filter((item) => item.agentId === agent.id);
      const mine = pageOf(items, cursor, limit, selection.feed === 'feed-delayed' ? ONE_DAY : NO_DELAY);
      const body: AgentFeedResponse = {
        ...mine,
        agent: { id: agent.id, name: agent.name, division: agent.division },
        followerCount: agent.id === AGENT_A ? 128 : 7,
      };
      return json(200, body);
    }
    if (call.method === 'GET' && path === '/api/feed') {
      if (!selection.signedIn) return SIGN_IN();
      const { cursor, limit } = pageQuery(target);
      const body: FollowingFeedResponse =
        selection.follows.length === 0
          ? { items: [], nextCursor: null, delay: selection.feed === 'feed-delayed' ? ONE_DAY : NO_DELAY }
          : feedPage(selection, cursor, limit);
      return json(200, body);
    }
    if (call.method === 'GET' && path === '/api/notifications') {
      if (!selection.signedIn) return SIGN_IN();
      const body: NotificationsResponse = { telegram: selection.telegram };
      return json(200, body);
    }
    if (path === '/api/notifications/telegram/link' && call.method === 'POST') {
      if (!selection.signedIn) return SIGN_IN();
      if (telegramOff) return NOT_FOUND();
      const body: TelegramLinkResponse = {
        url: `https://t.me/${BOT}?start=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
        expiresAt: '2026-10-06T12:15:00.000Z',
      };
      return json(201, body);
    }
    if (path === '/api/notifications/telegram') {
      if (!selection.signedIn) return SIGN_IN();
      if (telegramOff) return NOT_FOUND();
      if (call.method === 'DELETE') return noContent();
      if (call.method === 'PATCH') {
        if (!selection.telegram.linked) return NOT_FOUND();
        const enabled = (call.body as { enabled?: boolean } | undefined)?.enabled === true;
        const body: NotificationsResponse = { telegram: { ...selection.telegram, enabled } };
        return json(200, body);
      }
    }
    const results = /^\/api\/seasons\/([^/]+)\/results$/.exec(path);
    if (call.method === 'GET' && results) {
      if (selection.results === 'results-none' || !/^[1-9][0-9]{0,3}$/.test(results[1] ?? '')) return NOT_FOUND();
      return json(200, selection.results === 'results-final' ? RESULTS_FINAL : RESULTS_NOT_FINAL);
    }
    return NOT_FOUND();
  };
}
