import type {
  AgentSocialResponse,
  DnaAxis,
  DnaProfile,
  FamilyResponse,
  ForkSourceResponse,
  LineageAgent,
  ManagerDetailResponse,
  ManagerListResponse,
  ManagerRebalance,
  MyManagersResponse,
  RivalriesResponse,
  RivalryDetailResponse,
  RivalryEvent,
  RivalryPublic,
  SocialAgentRef,
  WarDay,
  WarDetailResponse,
  WarListResponse,
  WarModel,
  WarRow,
  WarStanding,
} from '@prix/contracts';
import { WAR_MODELS, WAR_RULES } from '@prix/contracts';
import { tapeAnswer } from '../tape/fixtures.ts';
import { roomAnswer } from './room/fixtures.ts';

/**
 * SAMPLE DATA. Used only when the site is built with PRIX_FIXTURES=1; a production build never
 * reaches this file. Every name, figure and day below is invented for reviewing the Phase 6 pages.
 *
 * `?fixture=` takes names separated by commas (the other groups of src/lib/fixtures keep theirs).
 * The Phase 6 group:
 *
 *   (none)            every read answers with the full sample: a ready strategy profile, a family of
 *                     four, two active rivalries and one that ended, one complete model war, three
 *                     paper managers, one of the visitor's in one of two slots.
 *   social-forming    the profile is forming (6 of 10 days); the agent is no fork and has no rivalry.
 *   social-empty      nothing yet: no profile, no family, no rivalry (6 ranked days recorded), no
 *                     model war, no paper manager.
 *   social-hidden     the parent and the root of the fork are hidden; one agent of a paper manager is
 *                     no longer public; the family's root is hidden.
 *   social-running    the model war is running (day 6 of 10), so it has no order yet.
 *   social-war-next   like the coming war: model war 2 is scheduled for 9 October with no war-day
 *                     yet, and model war 1 is running with three war-days; both with the four
 *                     Workers AI models and the 22 symbols.
 *   social-published  the parent's prompt is published, for the fork builder.
 *   social-pro        the parent is a Pro agent with a published prompt: the fork needs a model key.
 *   social-gone       the fork source answers 404.
 *   social-link-fails the fork is built and its link answers 429, so the builder offers to link again.
 *   social-link-closed the link answers 409 for the window that has passed.
 *   social-slots-full every paper manager slot of the visitor is in use.
 *   social-changed    the visitor's paper manager had its one change of today.
 *   social-probed     no model war, and three models that passed the check, for the admin form.
 *   social-forbidden  every admin write answers the generic 404 of the administrator check.
 *   social-error      every Phase 6 read and write fails with 500.
 *   social-off        the switch is off: every Phase 6 read answers 404.
 *
 * The Community chat has its own group, `social-room-<state>`, listed in ./room/fixtures.ts. With none
 * of its names the chat is on with a short sample; `social-off` and `social-error` take it with them.
 *
 * Detail reads answer 404 for an id the sample does not have.
 */

export type SocialFixtureAnswer =
  | { kind: 'data'; data: unknown }
  | { kind: 'error'; status: number; code: 'not_found' | 'internal'; message: string };

type State =
  | 'full'
  | 'forming'
  | 'empty'
  | 'hidden'
  | 'running'
  | 'next'
  | 'published'
  | 'pro'
  | 'gone'
  | 'link-fails'
  | 'link-closed'
  | 'slots-full'
  | 'changed'
  | 'probed'
  | 'forbidden'
  | 'error'
  | 'off';

const STATES: Record<string, State> = {
  'social-forming': 'forming',
  'social-empty': 'empty',
  'social-hidden': 'hidden',
  'social-running': 'running',
  'social-war-next': 'next',
  'social-published': 'published',
  'social-pro': 'pro',
  'social-gone': 'gone',
  'social-link-fails': 'link-fails',
  'social-link-closed': 'link-closed',
  'social-slots-full': 'slots-full',
  'social-changed': 'changed',
  'social-probed': 'probed',
  'social-forbidden': 'forbidden',
  'social-error': 'error',
  'social-off': 'off',
};

function stateOf(fixture: string | null): State {
  for (const name of (fixture ?? '').split(',')) {
    const state = STATES[name.trim()];
    if (state) return state;
  }
  return 'full';
}

/** An id made from a name, as src/lib/fixtures/league.ts makes them. */
function idOf(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z2-7]/g, '')
    .padEnd(12, 'a')
    .slice(0, 12);
}

const usd = (amount: number): number => Math.round(amount * 1_000_000);
const SEASON_ID = idOf('season one');

function ref(name: string, ownerShort: string, house = false): SocialAgentRef {
  return { id: idOf(name), name, ownerShort, house };
}

const SLOW = ref('Slow Compounder', '0x7a3f…c91e');
const PATIENT = ref('Patient Grower', '0x51d0…8e2b');
const LEDGER = ref('Quiet Ledger', '0xa04c…17f3');
const TIDE = ref('Tidewater', '0x2be9…44a0');
const MULE = ref('Momentum Mule', '0xd3c8…0b51');
const EQUAL = ref('Equal Weight', '0x9e14…6c2d', true);
const GAMMA = ref('Gamma Scout', '0x3f62…a9e7');
const MACRO = ref('Macro Tourist', '0xc5a1…20f8');

const lineageAgent = (agent: SocialAgentRef, createdAt: string, depth: number): LineageAgent => ({
  ...agent,
  createdAt,
  depth,
});

// --- the strategy profile ----------------------------------------------------------------------

const axis = (value: number | null, sample: number, note: DnaAxis['note'] = null): DnaAxis => ({
  value,
  sample,
  min: 10,
  note,
});

const READY: DnaProfile = {
  method: 'dna-v1',
  agentId: SLOW.id,
  status: 'ready',
  asOfDay: '2026-10-06',
  windowStartDay: '2026-08-25',
  strategySinceDay: '2026-08-20',
  pricedDays: 30,
  observedDays: 30,
  firstTickId: '2026-08-25T19:00Z',
  lastTickId: '2026-10-06T19:00Z',
  axes: {
    positionsMilli: axis(4180, 30),
    cashBps: axis(1240, 30),
    turnoverBps: axis(3150, 29),
    holdingDays: axis(23, 29),
    swingBps: axis(84, 29),
    deepestFallBps: axis(412, 30),
    momentumMilli: axis(-180, 30),
  },
  computedAt: '2026-10-08T00:13:04.000Z',
};

const FORMING: DnaProfile = {
  ...READY,
  status: 'forming',
  windowStartDay: '2026-09-28',
  strategySinceDay: '2026-09-28',
  pricedDays: 6,
  observedDays: 6,
  firstTickId: '2026-09-28T15:00Z',
  axes: {
    positionsMilli: axis(null, 6, 'not_enough_history'),
    cashBps: axis(null, 6, 'not_enough_history'),
    turnoverBps: axis(null, 5, 'not_enough_history'),
    holdingDays: axis(null, 5, 'not_enough_history'),
    swingBps: axis(null, 5, 'not_enough_history'),
    deepestFallBps: axis(null, 6, 'not_enough_history'),
    momentumMilli: axis(null, 0, 'needs_market_history'),
  },
};

// --- families ----------------------------------------------------------------------------------

const MEMBERS = [
  { ...lineageAgent(PATIENT, '2026-09-30T10:12:44.000Z', 1), parentId: SLOW.id },
  { ...lineageAgent(LEDGER, '2026-10-02T18:40:02.000Z', 1), parentId: SLOW.id },
  { ...lineageAgent(TIDE, '2026-10-05T07:03:51.000Z', 2), parentId: PATIENT.id },
];

function family(state: State, rootId: string, page: number): FamilyResponse | null {
  if (rootId !== SLOW.id) return null;
  if (state === 'empty' || state === 'forming' || page > 1) {
    return {
      rootId,
      root: lineageAgent(SLOW, '2026-09-28T09:00:00.000Z', 0),
      page,
      hasMore: false,
      memberCount: page > 1 ? MEMBERS.length : 0,
      members: [],
    };
  }
  if (state === 'hidden') {
    return {
      rootId,
      root: null,
      page,
      hasMore: false,
      memberCount: MEMBERS.length,
      members: MEMBERS.map((member) => (member.parentId === SLOW.id ? { ...member, parentId: null } : member)),
    };
  }
  return {
    rootId,
    root: lineageAgent(SLOW, '2026-09-28T09:00:00.000Z', 0),
    page,
    hasMore: false,
    memberCount: MEMBERS.length,
    members: MEMBERS,
  };
}

// --- rivalries ---------------------------------------------------------------------------------

function rivalry(
  a: SocialAgentRef,
  b: SocialAgentRef,
  over: Partial<RivalryPublic> & Pick<RivalryPublic, 'rankA' | 'rankB' | 'leader'>,
): RivalryPublic {
  const [lo, hi] = a.id < b.id ? [a, b] : [b, a];
  return {
    id: `${SEASON_ID}-${lo.id}-${hi.id}`,
    seasonId: SEASON_ID,
    division: 'open',
    status: 'active',
    formedDay: '2026-10-02',
    endedDay: null,
    endReason: null,
    agentA: lo,
    agentB: hi,
    leadChanges: 2,
    lastDay: '2026-10-07',
    ...over,
  };
}

const MULE_SLOW = rivalry(MULE, SLOW, { rankA: 4, rankB: 3, leader: SLOW.id, leadChanges: 3 });
const EQUAL_SLOW = rivalry(EQUAL, SLOW, {
  rankA: 2,
  rankB: 3,
  leader: EQUAL.id,
  formedDay: '2026-10-05',
  leadChanges: 1,
});
const GAMMA_MACRO = rivalry(GAMMA, MACRO, {
  rankA: 9,
  rankB: 6,
  leader: MACRO.id,
  status: 'ended',
  formedDay: '2026-09-30',
  endedDay: '2026-10-06',
  endReason: 'apart',
  lastDay: '2026-10-06',
  leadChanges: 2,
});

/** Mule (A) and Slow (B), one point per tape day; a null is a day one of them had no rank. */
const MULE_SLOW_SERIES: Array<[string, number | null, number | null]> = [
  ['2026-09-24', 6, 5],
  ['2026-09-25', 5, 6],
  ['2026-09-28', 5, 4],
  ['2026-09-29', 4, 5],
  ['2026-09-30', null, 4],
  ['2026-10-01', 5, 4],
  ['2026-10-02', 3, 4],
  ['2026-10-05', 4, 3],
  ['2026-10-06', 4, 3],
  ['2026-10-07', 4, 3],
];

function event(
  pair: RivalryPublic,
  day: string,
  kind: RivalryEvent['kind'],
  subject: string | null,
  rankA: number | null,
  rankB: number | null,
  detail: Record<string, number>,
): RivalryEvent {
  return {
    seasonId: pair.seasonId,
    agentA: pair.agentA.id,
    agentB: pair.agentB.id,
    day,
    seq: 1,
    kind,
    subject,
    rankA,
    rankB,
    detail,
  };
}

const MULE_SLOW_EVENTS: RivalryEvent[] = [
  event(MULE_SLOW, '2026-10-05', 'overtake', SLOW.id, 4, 3, { gap: 1 }),
  event(MULE_SLOW, '2026-10-02', 'formed', null, 3, 4, { gap: 1, closeDays: 8, swaps: 3, windowDays: 9 }),
];

function rivalriesList(state: State, division: string, page: number): RivalriesResponse {
  const base = {
    seasonId: SEASON_ID,
    division: division === 'pro' ? 'pro' : 'open',
    method: 'v1',
    page,
    hasMore: false,
  } as const;
  if (state === 'empty' || state === 'forming' || division === 'pro' || page > 1) {
    return { ...base, tapedDays: state === 'empty' || state === 'forming' ? 6 : 12, rivalries: [] };
  }
  return { ...base, tapedDays: 12, rivalries: [MULE_SLOW, EQUAL_SLOW, GAMMA_MACRO] };
}

function rivalryDetail(id: string): RivalryDetailResponse | null {
  if (id === MULE_SLOW.id) {
    return { rivalry: MULE_SLOW, method: 'v1', series: MULE_SLOW_SERIES, events: MULE_SLOW_EVENTS };
  }
  if (id === EQUAL_SLOW.id) {
    return {
      rivalry: EQUAL_SLOW,
      method: 'v1',
      series: [
        ['2026-09-29', 3, 2],
        ['2026-09-30', 2, 3],
        ['2026-10-01', 3, 2],
        ['2026-10-02', 2, 4],
        ['2026-10-05', 2, 3],
        ['2026-10-06', 2, 3],
        ['2026-10-07', 2, 3],
      ],
      events: [
        event(EQUAL_SLOW, '2026-10-05', 'formed', null, 2, 3, { gap: 1, closeDays: 6, swaps: 2, windowDays: 7 }),
      ],
    };
  }
  if (id === GAMMA_MACRO.id) {
    return {
      rivalry: GAMMA_MACRO,
      method: 'v1',
      series: [
        ['2026-09-29', 7, 8],
        ['2026-09-30', 8, 7],
        ['2026-10-01', 7, 8],
        ['2026-10-02', 8, 7],
        ['2026-10-05', 9, 6],
        ['2026-10-06', 9, 6],
      ],
      events: [
        event(GAMMA_MACRO, '2026-10-06', 'ended', null, 9, 6, { closeDays: 2, windowDays: 10 }),
        event(GAMMA_MACRO, '2026-10-01', 'overtake', GAMMA.id, 7, 8, { gap: 1 }),
        event(GAMMA_MACRO, '2026-09-30', 'formed', null, 8, 7, { gap: 1, closeDays: 5, swaps: 2, windowDays: 6 }),
      ],
    };
  }
  return null;
}

// --- the paper experiment ----------------------------------------------------------------------

const WAR_ID = idOf('war one');
const WAR_DAYS = [
  '2026-09-14',
  '2026-09-15',
  '2026-09-16',
  '2026-09-17',
  '2026-09-18',
  '2026-09-21',
  '2026-09-22',
  '2026-09-23',
  '2026-09-24',
  '2026-09-25',
];

const ENTRANTS = [
  {
    slot: 'A',
    modelId: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    provider: 'workers-ai',
    maker: 'Meta',
    family: 'Llama',
    label: 'Llama 3.3 70B',
    extra: {},
    input: 26_668,
    output: 204_805,
  },
  {
    slot: 'B',
    modelId: '@cf/google/gemma-4-26b-a4b-it',
    provider: 'workers-ai',
    maker: 'Google',
    family: 'Gemma',
    label: 'Gemma 4 26B A4B',
    extra: { chat_template_kwargs: { enable_thinking: false } },
    input: 9_091,
    output: 27_273,
  },
  {
    slot: 'C',
    modelId: '@cf/mistralai/mistral-small-3.1-24b-instruct',
    provider: 'workers-ai',
    maker: 'Mistral AI',
    family: 'Mistral',
    label: 'Mistral Small 3.1 24B',
    extra: {},
    input: 31_876,
    output: 50_488,
  },
  {
    slot: 'D',
    modelId: '@cf/zai-org/glm-4.7-flash',
    provider: 'workers-ai',
    maker: 'Z.ai',
    family: 'GLM',
    label: 'GLM-4.7-Flash',
    extra: { chat_template_kwargs: { enable_thinking: false } },
    input: 5_500,
    output: 36_400,
  },
] as const;

/** The universe of the coming war: the twenty Stock Tokens, and BTC and ETH (section 21). */
const UNIVERSE_22 = [
  'AAPL',
  'AMD',
  'AMZN',
  'COIN',
  'CRCL',
  'GME',
  'GOOGL',
  'INTC',
  'META',
  'MSFT',
  'MSTR',
  'MU',
  'NVDA',
  'PLTR',
  'QQQ',
  'SGOV',
  'SPCX',
  'SPY',
  'TSLA',
  'USO',
  'BTC',
  'ETH',
];

/** Each entrant's value at the end of each war-day, in USD. */
const VALUES: Record<string, number[]> = {
  A: [10_012.4, 10_061.9, 10_020.3, 10_118.7, 10_164.2, 10_131.0, 10_207.5, 10_244.1, 10_198.6, 10_262.9],
  B: [9_994.1, 9_971.6, 10_003.8, 10_041.2, 10_039.9, 10_066.4, 10_052.7, 10_090.3, 10_118.5, 10_104.6],
  C: [10_031.7, 10_082.3, 10_115.9, 10_064.0, 9_988.2, 9_942.6, 9_990.4, 10_021.8, 9_976.3, 9_958.1],
  D: [10_000.0, 9_982.5, 9_960.7, 9_973.2, 10_010.8, 10_025.4, 10_025.4, 10_001.9, 10_037.6, 10_049.3],
};

const PRICES: Record<string, number> = {
  AAPL: 227.48,
  MSFT: 431.2,
  NVDA: 181.2,
  SGOV: 100.42,
  SPY: 571.9,
  TSLA: 244.1,
  BTC: 121_345.67,
  ETH: 4_418.2,
};

function warDays(count: number): WarDay[] {
  return WAR_DAYS.slice(0, count).map((day, index) => ({
    tickId: `${day}T15:00Z`,
    takenAt: `${day}T15:00:04.000Z`,
    pricesMicro: Object.fromEntries(
      Object.entries(PRICES).map(([symbol, price]) => [symbol, usd(price * (1 + (index - 4) / 400))]),
    ),
    halted: index === 6 ? ['TSLA'] : [],
  }));
}

function warRows(count: number): WarRow[] {
  const rows: WarRow[] = [];
  WAR_DAYS.slice(0, count).forEach((day, index) => {
    for (const entrant of ENTRANTS) {
      const equity = usd(VALUES[entrant.slot]?.[index] ?? 10_000);
      const noDecision = entrant.slot === 'D' && index === 1;
      const skipped = entrant.slot === 'B' && index === 4;
      rows.push({
        warId: WAR_ID,
        slot: entrant.slot,
        tickId: `${day}T15:00Z`,
        status: noDecision ? 'no_decision' : skipped ? 'skipped' : 'decided',
        code: noDecision ? 'invalid_json' : skipped ? 'internal_error' : null,
        targetsBps: noDecision || skipped ? null : { NVDA: 3000, MSFT: 2500, SGOV: 2000 },
        reason:
          noDecision || skipped ? null : 'Keeps the largest names near their weights and holds a cash reserve in SGOV.',
        fills: [],
        halted: index === 6 ? ['TSLA'] : [],
        portfolio: { cashMicro: usd(2_000), holdings: { NVDA: 16_500_000, MSFT: 5_800_000, SGOV: 19_900_000 } },
        equityMicro: equity,
        costMicro: index === 0 ? usd(6.12) : 0,
        inputTokens: entrant.slot === 'C' ? 1_840 : 1_910,
        outputTokens: 96,
        neurons: 70.5,
        createdAt: `${day}T15:00:30.000Z`,
      });
    }
  });
  return rows;
}

function standings(count: number, complete: boolean): WarStanding[] {
  const figures: Record<string, { returnBps: number; maxDrawdownBps: number; trades: number; rank: number }> = {
    A: { returnBps: 263, maxDrawdownBps: 45, trades: 14, rank: 1 },
    B: { returnBps: 105, maxDrawdownBps: 23, trades: 9, rank: 2 },
    C: { returnBps: -42, maxDrawdownBps: 171, trades: 22, rank: 4 },
    D: { returnBps: 49, maxDrawdownBps: 39, trades: 7, rank: 3 },
  };
  const rows = ENTRANTS.map((entrant) => {
    const figure = figures[entrant.slot] ?? { returnBps: 0, maxDrawdownBps: 0, trades: 0, rank: 4 };
    return {
      slot: entrant.slot,
      modelId: entrant.modelId,
      provider: entrant.provider,
      label: entrant.label,
      maker: entrant.maker,
      rank: complete ? figure.rank : null,
      returnBps: complete ? figure.returnBps : Math.round(figure.returnBps / 2),
      maxDrawdownBps: figure.maxDrawdownBps,
      tradeCount: complete ? figure.trades : Math.round(figure.trades / 2),
      days: count,
      decided: count - (entrant.slot === 'B' || entrant.slot === 'D' ? 1 : 0),
      noDecision: entrant.slot === 'D' ? 1 : 0,
      skipped: entrant.slot === 'B' && count > 4 ? 1 : 0,
      codes: (entrant.slot === 'D' ? { invalid_json: 1 } : {}) as Record<string, number>,
      costMicro: usd(entrant.slot === 'C' ? 21.4 : 9.8),
      neurons: 705,
      v2: { n: count, meanMilliBps: 26_300, volMilliBps: 41_800, ratioMilli: 629, shrinkMilli: 500, scoreMilli: 315 },
      confidence: count >= 10 ? 'low' : 'insufficient',
      daily: WAR_DAYS.slice(0, count).map((day, index) => ({
        day,
        equityMicro: usd(VALUES[entrant.slot]?.[index] ?? 10_000),
      })),
    } satisfies WarStanding;
  });
  return complete ? [...rows].sort((a, b) => (a.rank ?? 9) - (b.rank ?? 9)) : rows;
}

const WAR_TITLE = 'Large caps with a cash floor';
const WAR_STRATEGY =
  'Hold four to six of the largest companies in the universe at roughly equal weights, keep at least 15% in SGOV, and trade only when a weight drifts more than five points from its target.';

/** The coming war of `social-war-next`: scheduled for Friday 9 October, no war-day yet. */
const NEXT_WAR_ID = idOf('war two');

function entrantsOf(warId: string, count: number, days: string[]) {
  return ENTRANTS.map((entrant) => ({
    warId,
    slot: entrant.slot,
    modelId: entrant.modelId,
    provider: entrant.provider,
    maker: entrant.maker,
    family: entrant.family,
    label: entrant.label,
    extra: entrant.extra,
    maxOutputTokens: 300,
    inputNeuronsPerMillion: entrant.input,
    outputNeuronsPerMillion: entrant.output,
    pricesReadOn: '2026-10-07',
    probedOn: '2026-10-08',
    lastTickId: count > 0 ? `${days[count - 1]}T15:00Z` : null,
    days: count,
  }));
}

function nextWar(): WarDetailResponse {
  return {
    war: {
      id: NEXT_WAR_ID,
      number: 2,
      title: 'Twenty-two symbols, one strategy',
      status: 'scheduled',
      stopReason: null,
      strategy: WAR_STRATEGY,
      strategySha256: '7c2e1f0a9b8d3c4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6',
      systemMessageSha256: null,
      promptVersion: null,
      rules: {
        startingCashMicro: usd(10_000),
        feeBps: 10,
        slippageBps: 5,
        maxWeightBps: 4000,
        minTradeBps: 50,
        universe: UNIVERSE_22,
        schedule: 'daily_tick',
      },
      startsOn: '2026-10-09',
      tradingDays: 10,
      deadlineDay: '2026-11-07',
      method: 'v1',
      createdAt: '2026-10-08T21:00:00.000Z',
      firstTickId: null,
      lastTickId: null,
      endedAt: null,
    },
    entrants: entrantsOf(NEXT_WAR_ID, 0, []),
    standings: [],
    days: [],
    rows: [],
  };
}

function warDetail(state: State, id: string): WarDetailResponse | null {
  if (state === 'empty') return null;
  if (state === 'next' && id === NEXT_WAR_ID) return nextWar();
  if (id !== WAR_ID) return null;
  const running = state === 'running' || state === 'next';
  const count = state === 'next' ? 3 : running ? 6 : 10;
  return {
    war: {
      id: WAR_ID,
      number: 1,
      title: WAR_TITLE,
      status: running ? 'running' : 'complete',
      stopReason: null,
      strategy: WAR_STRATEGY,
      strategySha256: '5f1c0d7a9b3e2f4c6d8a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e',
      systemMessageSha256: '9a41c3d2e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
      promptVersion: 'decision@9a41c3d2e5f6',
      rules: {
        startingCashMicro: usd(10_000),
        feeBps: 10,
        slippageBps: 5,
        maxWeightBps: 4000,
        minTradeBps: 50,
        universe: UNIVERSE_22,
        schedule: 'daily_tick',
      },
      startsOn: '2026-09-14',
      tradingDays: 10,
      deadlineDay: '2026-10-14',
      method: 'v1',
      createdAt: '2026-09-11T12:30:00.000Z',
      firstTickId: '2026-09-14T15:00Z',
      lastTickId: `${WAR_DAYS[count - 1]}T15:00Z`,
      endedAt: running ? null : '2026-09-25T15:01:12.000Z',
    },
    entrants: entrantsOf(WAR_ID, count, WAR_DAYS),
    standings: standings(count, !running),
    days: warDays(count),
    rows: warRows(count),
  };
}

function warList(state: State, page: number): WarListResponse {
  if (state === 'empty' || state === 'probed' || page > 1) return { page, hasMore: false, wars: [] };
  const running = state === 'running' || state === 'next';
  const entrants = ENTRANTS.map(({ slot, modelId, label, maker }) => ({ slot, modelId, label, maker }));
  const first = {
    id: WAR_ID,
    number: 1,
    title: WAR_TITLE,
    status: running ? 'running' : 'complete',
    startsOn: '2026-09-14',
    tradingDays: 10,
    daysDone: state === 'next' ? 3 : running ? 6 : 10,
    entrants,
  } as const;
  if (state !== 'next') return { page, hasMore: false, wars: [first] };
  const next = nextWar().war;
  return {
    page,
    hasMore: false,
    wars: [
      {
        id: next.id,
        number: next.number,
        title: next.title,
        status: 'scheduled',
        startsOn: next.startsOn,
        tradingDays: next.tradingDays,
        daysDone: 0,
        entrants,
      },
      first,
    ],
  };
}

// --- paper managers ----------------------------------------------------------------------------

const STEADY_ID = idOf('Three Steady');
const MIX_ID = idOf('Slow Mix');
const PAIR_ID = idOf('Open Pair');

const STEADY_DAILY = [
  ['2026-09-28', 10_000.0],
  ['2026-09-29', 10_031.2],
  ['2026-09-30', 10_066.9],
  ['2026-10-01', 10_012.5],
  ['2026-10-02', 10_088.1],
  ['2026-10-05', 10_141.7],
  ['2026-10-06', 10_183.4],
] as const;

function managerList(state: State, page: number): ManagerListResponse {
  if (state === 'empty' || page > 1) return { seasonId: SEASON_ID, page, hasMore: false, managers: [] };
  return {
    seasonId: SEASON_ID,
    page,
    hasMore: false,
    managers: [
      {
        id: MIX_ID,
        name: 'Slow Mix',
        status: 'active',
        schedule: 'hold',
        agentCount: 2,
        createdAt: '2026-10-05T21:10:00.000Z',
        season: null,
      },
      {
        id: STEADY_ID,
        name: 'Three Steady',
        status: 'active',
        schedule: 'weekly',
        agentCount: 3,
        createdAt: '2026-09-27T18:02:00.000Z',
        season: {
          seasonId: SEASON_ID,
          returnBps: 183,
          maxDrawdownBps: 54,
          volMilliBps: 41_600,
          valuedDays: 7,
          equityMicro: usd(10_183.4),
        },
      },
      {
        id: PAIR_ID,
        name: 'Open Pair',
        status: 'closed',
        schedule: 'weekly',
        agentCount: 2,
        createdAt: '2026-09-26T08:45:00.000Z',
        season: {
          seasonId: SEASON_ID,
          returnBps: -61,
          maxDrawdownBps: 98,
          volMilliBps: 52_300,
          valuedDays: 3,
          equityMicro: usd(9_939),
        },
      },
    ],
  };
}

const REBALANCES: ManagerRebalance[] = [
  {
    day: '2026-10-05',
    reason: 'scheduled',
    policyVersion: 1,
    targetsBps: { [SLOW.id]: 4000, [EQUAL.id]: 3000, [MULE.id]: 2000 },
    fills: [
      {
        agentId: MULE.id,
        side: 'sell',
        unitsMicro: 1_200_000,
        priceMicro: usd(1.0274),
        notionalMicro: usd(12.33),
        feeMicro: usd(0.01),
        slippageMicro: usd(0.01),
      },
      {
        agentId: SLOW.id,
        side: 'buy',
        unitsMicro: 1_150_000,
        priceMicro: usd(1.0512),
        notionalMicro: usd(12.09),
        feeMicro: usd(0.01),
        slippageMicro: usd(0.01),
      },
    ],
    exited: [],
    equityBeforeMicro: usd(10_141.72),
    equityAfterMicro: usd(10_141.7),
    costMicro: usd(0.04),
  },
  {
    day: '2026-09-28',
    reason: 'start',
    policyVersion: 1,
    targetsBps: { [SLOW.id]: 4000, [EQUAL.id]: 3000, [MULE.id]: 2000 },
    fills: [],
    exited: [],
    equityBeforeMicro: usd(10_000),
    equityAfterMicro: usd(10_000),
    costMicro: usd(13.5),
  },
];

function managerDetail(state: State, id: string): ManagerDetailResponse | null {
  if (state === 'empty') return null;
  if (id === STEADY_ID) {
    return {
      manager: {
        id: STEADY_ID,
        name: 'Three Steady',
        status: 'active',
        schedule: 'weekly',
        agentCount: 3,
        createdAt: '2026-09-27T18:02:00.000Z',
        season: {
          seasonId: SEASON_ID,
          returnBps: 183,
          maxDrawdownBps: 54,
          volMilliBps: 41_600,
          valuedDays: 7,
          equityMicro: usd(10_183.4),
        },
        policyVersion: 1,
      },
      allocation: [
        { agent: SLOW, targetBps: 4000, currentBps: 4110, state: 'valued' },
        { agent: EQUAL, targetBps: 3000, currentBps: 2960, state: 'valued' },
        state === 'hidden'
          ? { agent: null, targetBps: 2000, currentBps: 1930, state: 'no_point_today' }
          : { agent: MULE, targetBps: 2000, currentBps: 1930, state: 'no_point_today' },
      ],
      cashBps: 1000,
      lastRebalanceDay: '2026-10-05',
      daily: STEADY_DAILY.map(([day, value]) => ({ day, equityMicro: usd(value) })),
      rebalances: REBALANCES,
    };
  }
  if (id === MIX_ID) {
    return {
      manager: {
        id: MIX_ID,
        name: 'Slow Mix',
        status: 'active',
        schedule: 'hold',
        agentCount: 2,
        createdAt: '2026-10-05T21:10:00.000Z',
        season: null,
        policyVersion: 1,
      },
      allocation: [
        { agent: SLOW, targetBps: 4000, currentBps: 0, state: 'valued' },
        { agent: PATIENT, targetBps: 3500, currentBps: 0, state: 'valued' },
      ],
      cashBps: 10_000,
      lastRebalanceDay: null,
      daily: [],
      rebalances: [],
    };
  }
  if (id === PAIR_ID) {
    return {
      manager: {
        id: PAIR_ID,
        name: 'Open Pair',
        status: 'closed',
        schedule: 'weekly',
        agentCount: 2,
        createdAt: '2026-09-26T08:45:00.000Z',
        season: {
          seasonId: SEASON_ID,
          returnBps: -61,
          maxDrawdownBps: 98,
          volMilliBps: 52_300,
          valuedDays: 3,
          equityMicro: usd(9_939),
        },
        policyVersion: 2,
      },
      allocation: [
        { agent: GAMMA, targetBps: 4000, currentBps: 0, state: 'exited' },
        { agent: MACRO, targetBps: 4000, currentBps: 0, state: 'valued' },
      ],
      cashBps: 10_000,
      lastRebalanceDay: '2026-09-30',
      daily: [
        { day: '2026-09-28', equityMicro: usd(10_000) },
        { day: '2026-09-29', equityMicro: usd(9_968.5) },
        { day: '2026-09-30', equityMicro: usd(9_939) },
      ],
      rebalances: [],
    };
  }
  return null;
}

function myManagers(state: State): MyManagersResponse {
  if (state === 'empty') return { slots: { used: 0, max: 1 }, managers: [] };
  return {
    slots: { used: 1, max: state === 'slots-full' ? 1 : 2 },
    managers: [
      {
        id: STEADY_ID,
        name: 'Three Steady',
        status: 'active',
        schedule: 'weekly',
        agentCount: 3,
        createdAt: '2026-09-27T18:02:00.000Z',
        season: {
          seasonId: SEASON_ID,
          returnBps: 183,
          maxDrawdownBps: 54,
          volMilliBps: 41_600,
          valuedDays: 7,
          equityMicro: usd(10_183.4),
        },
        hidden: false,
        targetsBps: { [SLOW.id]: 4000, [EQUAL.id]: 3000, [MULE.id]: 2000 },
        changedToday: state === 'changed',
      },
    ],
  };
}

// --- the agent read ----------------------------------------------------------------------------

function agentSocial(state: State, agentId: string): AgentSocialResponse {
  const none = { depth: 0, parent: null, root: null, childCount: 0, children: [] };
  if (state === 'empty') {
    return { agentId, dna: null, dnaWindowDays: 40, dnaMinDays: 10, lineage: none, rivalries: [] };
  }
  if (state === 'forming') {
    return { agentId, dna: { ...FORMING, agentId }, dnaWindowDays: 40, dnaMinDays: 10, lineage: none, rivalries: [] };
  }
  // Every other agent of the sample is shown as Tidewater: a fork two levels down, in two rivalries.
  const isRoot = agentId === SLOW.id;
  const parent =
    state === 'hidden' ? ({ shown: false } as const) : lineageAgent(PATIENT, '2026-09-30T10:12:44.000Z', 1);
  const root = state === 'hidden' ? ({ shown: false } as const) : lineageAgent(SLOW, '2026-09-28T09:00:00.000Z', 0);
  return {
    agentId,
    dna: { ...READY, agentId },
    dnaWindowDays: 40,
    dnaMinDays: 10,
    lineage: isRoot
      ? {
          depth: 0,
          parent: null,
          root: null,
          childCount: 2,
          children: [
            lineageAgent(LEDGER, '2026-10-02T18:40:02.000Z', 1),
            lineageAgent(PATIENT, '2026-09-30T10:12:44.000Z', 1),
          ],
        }
      : { depth: 2, parent, root, childCount: 0, children: [] },
    rivalries: isRoot ? [MULE_SLOW, EQUAL_SLOW] : [MULE_SLOW],
  };
}

function forkSource(state: State, agentId: string): ForkSourceResponse | null {
  if (state === 'gone') return null;
  const published = state === 'published' || state === 'pro' || state === 'link-fails' || state === 'link-closed';
  return {
    parent: {
      ...SLOW,
      id: agentId,
      division: state === 'pro' ? 'pro' : 'open',
      createdAt: '2026-09-28T09:00:00.000Z',
      summary:
        'Holds six to eight large, liquid names, adds slowly to the ones that keep rising and keeps at least 10% in cash. Trades only when weights drift.',
      summaryStatus: 'ready',
      prompt: published
        ? 'Hold six to eight of the largest, most liquid names. Keep at least 10% in cash. Add slowly to names that keep rising and trade only when a weight drifts more than four points.'
        : null,
    },
    dna: state === 'empty' ? null : { ...READY, agentId },
    rootId: agentId,
    forkDepth: 1,
  };
}

// --- the answer --------------------------------------------------------------------------------

const ID = '([a-z2-7]{12})';

/** What the API would answer for `path` in the state that `fixture` names. */
export function socialAnswer(fixture: string | null, path: string): SocialFixtureAnswer {
  const state = stateOf(fixture);
  if (state === 'off') return { kind: 'error', status: 404, code: 'not_found', message: 'No route matches this path.' };
  if (state === 'error') {
    return { kind: 'error', status: 500, code: 'internal', message: 'Something went wrong on our side. Try again.' };
  }
  const url = new URL(path, 'https://fixture.invalid');
  const page = Number(url.searchParams.get('page') ?? '1') || 1;
  const route = url.pathname;
  // The holders' tape is on only while Phase 6 is; its own states are in ../tape/fixtures.ts.
  if (route === '/api/tape') return tapeAnswer(fixture);
  // The Community chat has a group of states of its own (./room/fixtures.ts lists them).
  if (route === '/api/social/room' || route.startsWith('/api/social/room/')) return roomAnswer(fixture, route);
  const notFound: SocialFixtureAnswer = {
    kind: 'error',
    status: 404,
    code: 'not_found',
    message: 'Nothing has this id. Check the link.',
  };
  const data = (value: unknown): SocialFixtureAnswer => (value === null ? notFound : { kind: 'data', data: value });

  if (route === '/api/social/status') return data({ on: true });
  if (route === '/api/social/me/managers') return data(myManagers(state));
  if (route === '/api/social/rivalries')
    return data(rivalriesList(state, url.searchParams.get('division') ?? 'open', page));
  if (route === '/api/social/wars') return data(warList(state, page));
  if (route === '/api/social/managers') return data(managerList(state, page));

  let match = new RegExp(`^/api/social/agents/${ID}$`).exec(route);
  if (match?.[1]) return data(agentSocial(state, match[1]));
  match = new RegExp(`^/api/social/agents/${ID}/fork-source$`).exec(route);
  if (match?.[1]) return data(forkSource(state, match[1]));
  match = new RegExp(`^/api/social/families/${ID}$`).exec(route);
  if (match?.[1]) return data(family(state, match[1], page));
  match = /^\/api\/social\/rivalries\/([a-z2-7-]+)$/.exec(route);
  if (match?.[1]) return data(rivalryDetail(match[1]));
  match = new RegExp(`^/api/social/wars/${ID}$`).exec(route);
  if (match?.[1]) return data(warDetail(state, match[1]));
  match = new RegExp(`^/api/social/managers/${ID}$`).exec(route);
  if (match?.[1]) return data(managerDetail(state, match[1]));
  return notFound;
}

/** The ids of the sample, for links in a review. */
export const SAMPLE_IDS = {
  root: SLOW.id,
  fork: TIDE.id,
  rivalry: MULE_SLOW.id,
  war: WAR_ID,
  manager: STEADY_ID,
} as const;

// --- the writes --------------------------------------------------------------------------------

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function refusal(status: number, code: string, message: string, field: string | null = null): Response {
  return json(status, { error: { code, message, field } });
}

function createdManager(id: string, name: string, schedule: unknown, targets: Record<string, number>) {
  const sum = Object.values(targets).reduce((total, bps) => total + bps, 0);
  return {
    manager: {
      id,
      name,
      status: 'active',
      schedule: schedule === 'hold' ? 'hold' : 'weekly',
      agentCount: Object.keys(targets).length,
      createdAt: '2026-10-08T09:00:00.000Z',
      season: null,
      policyVersion: 1,
    },
    allocation: [],
    cashBps: 10_000 - sum,
    lastRebalanceDay: null,
    daily: [],
    rebalances: [],
  };
}

function createdWar(body: unknown) {
  const input = (body ?? {}) as {
    title?: string;
    strategy?: string;
    startsOn?: string;
    tradingDays?: number;
    models?: string[];
  };
  const slots = ['A', 'B', 'C', 'D'] as const;
  const models = (input.models ?? [])
    .map((id) => WAR_MODELS.find((model) => model.id === id))
    .filter((model): model is WarModel => model !== undefined);
  const id = idOf('war two');
  return {
    war: {
      id,
      number: 2,
      title: input.title ?? 'A model war',
      status: 'scheduled',
      stopReason: null,
      strategy: input.strategy ?? '',
      strategySha256: '0'.repeat(64),
      systemMessageSha256: null,
      promptVersion: null,
      rules: { ...WAR_RULES, universe: ['SPY', 'QQQ'] },
      startsOn: input.startsOn ?? '2026-10-09',
      tradingDays: input.tradingDays ?? 10,
      deadlineDay: '2026-11-07',
      method: 'v1',
      createdAt: '2026-10-08T09:00:00.000Z',
      firstTickId: null,
      lastTickId: null,
      endedAt: null,
    },
    entrants: models.map((model, index) => ({
      warId: id,
      slot: slots[index] ?? 'A',
      modelId: model.id,
      provider: model.provider,
      maker: model.maker,
      family: model.family,
      label: model.label,
      extra: { ...model.extra },
      maxOutputTokens: 300,
      inputNeuronsPerMillion: model.inputNeuronsPerMillion,
      outputNeuronsPerMillion: model.outputNeuronsPerMillion,
      pricesReadOn: model.pricesReadOn,
      probedOn: '2026-10-07',
      lastTickId: null,
      days: 0,
    })),
    standings: [],
    days: [],
    rows: [],
  };
}

/** What the API would answer a Phase 6 write from a browser script, in the state that `fixture` names. */
export function socialWriteAnswer(
  fixture: string | null,
  call: { method: 'POST' | 'PATCH'; path: string; body?: unknown },
): Response {
  const state = stateOf(fixture);
  const route = call.path.split('?')[0] ?? '';
  const admin = route.startsWith('/api/social/admin/');
  if (state === 'error') return refusal(500, 'internal', 'Something went wrong on our side. Try again.');
  if ((state === 'forbidden' && admin) || (state === 'off' && !admin)) {
    return refusal(404, 'not_found', 'No route matches this path.');
  }

  const lineage = /^\/api\/social\/agents\/([a-z2-7]{12})\/lineage$/.exec(route);
  if (lineage?.[1]) {
    if (state === 'link-fails') return refusal(429, 'rate_limited', 'Too many requests.');
    if (state === 'link-closed') return refusal(409, 'invalid_input', 'The link window has passed.', 'parentId');
    const parent = { ...SLOW, createdAt: '2026-09-28T09:00:00.000Z', depth: 0 };
    return json(201, { agentId: lineage[1], lineage: { depth: 1, parent, root: parent, childCount: 0, children: [] } });
  }
  if (call.method === 'POST' && route === '/api/social/managers') {
    const input = (call.body ?? {}) as { name?: string; schedule?: unknown; targetsBps?: Record<string, number> };
    return json(201, createdManager(idOf('new mix'), input.name ?? 'New mix', input.schedule, input.targetsBps ?? {}));
  }
  const manager = /^\/api\/social\/managers\/([a-z2-7]{12})$/.exec(route);
  if (call.method === 'PATCH' && manager?.[1]) {
    const input = (call.body ?? {}) as { policy?: { schedule?: unknown; targetsBps: Record<string, number> } };
    return json(
      200,
      createdManager(manager[1], 'Three Steady', input.policy?.schedule, input.policy?.targetsBps ?? {}),
    );
  }
  if (call.method === 'POST' && route === '/api/social/admin/wars') return json(201, createdWar(call.body));
  if (call.method === 'POST' && /^\/api\/social\/admin\/wars\/[a-z2-7]{12}\/stop$/.test(route)) {
    return new Response(null, { status: 204 });
  }
  return refusal(404, 'not_found', 'Nothing has this id. Check the link.');
}

/**
 * The models the admin form offers in the sample. Under `social-probed` the first three of the
 * contract's list stand in as checked, so that the form can be seen; otherwise the contract's own
 * list, as in production.
 */
export function fixtureModels(fixture: string | null): WarModel[] {
  if (stateOf(fixture) === 'probed') {
    return WAR_MODELS.slice(0, 3).map((model) => ({ ...model, probe: { on: '2026-10-07', valid: 27, of: 27 } }));
  }
  return WAR_MODELS.filter((model) => model.probe !== null);
}
