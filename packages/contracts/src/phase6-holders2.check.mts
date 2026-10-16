// The operator's check of the holders' second wave (phase6-holders2.ts, docs/contracts/phase-6-holders-2.md),
// revision 3 (Phase 6.8). It pins every pure rule of the file with its cases, computes every figure of the document's
// section 8 from the constants and fails when the table prints a value it did not compute, and runs every
// sentence of the wave (the page words, the direct messages, the lounge's description) through
// `isSocialSafeText` and the wave's own word rules. One line a case; exit 1 on any surprise.
// Usage: node --experimental-strip-types --no-warnings packages/contracts/src/phase6-holders2.check.mts

import { TIER_RULES } from './entitlements.ts';
import { TOKEN_CACHE_SECONDS, TOKEN_STALE_GRACE_SECONDS, type TokenService } from './phase4-token.ts';
import {
  HOLDERS2_MIN_TIER,
  HOLDERS2_PAGE_WORDS,
  type HoldersGate,
  LOUNGE_DESCRIPTION,
  LOUNGE_DIRECT_MEMORY_MAX,
  LOUNGE_DIRECT_MESSAGES,
  LOUNGE_FULL_JOINED_DAYS,
  LOUNGE_FULL_MARKED_DAYS,
  LOUNGE_GROUP_REQUESTS_DAY_MAX,
  LOUNGE_JOIN_WRITE_ROWS,
  LOUNGE_LOG_EVENTS,
  LOUNGE_MARK_WRITE_ROWS_PER_MEMBER,
  LOUNGE_MEMBERS_MAX,
  LOUNGE_SLOW_MODE_SECONDS,
  LOUNGE_SWEEP_CHECKS_PER_RUN,
  LOUNGE_SWEEP_FROM_HOUR_UTC,
  LOUNGE_SWEEP_JOBS_AHEAD,
  LOUNGE_SWEEP_REMOVALS_PER_RUN,
  LOUNGE_SWEEP_STATEMENTS_MAX,
  LOUNGE_SWEEP_SUBREQUESTS_MAX,
  LOUNGE_SWEEP_TELEGRAM_CALLS_MAX,
  type LoungeDueMember,
  type LoungeJoinFacts,
  loungeAccountAnswer,
  loungeConfig,
  loungeDirectChatOk,
  loungeDirectMessage,
  loungeFullCountFrom,
  loungeJoinDecision,
  loungeReadFresh,
  loungeResponseSchema,
  loungeStoredRowCurrent,
  loungeSweepHour,
  loungeSweepMarks,
  loungeSweepVerdict,
  ROOM_WALLET_DAY_CAP_BY_TIER,
  type RoomHoldingWithTier,
  roomHolderMark,
  roomHoldersOn,
  roomLeftToday,
  roomWalletDayCap,
  SOCIAL_IDLE_READS_PER_JOB,
  SOCIAL_STEP_SUBREQUESTS_MAX,
  storedTierOf,
  TAPE_CACHE_SECONDS,
  TAPE_ROWS,
  tapeCacheKey,
  tapeEnabled,
  tapeQuerySchema,
  tapeResponseSchema,
  tapeViewOf,
  telegramUpdateWithJoinSchema,
} from './phase6-holders2.ts';
import {
  ROOM_MESSAGES_PER_DAY_DEFAULT,
  ROOM_MESSAGES_PER_WALLET_PER_DAY,
  type RoomWriterRecord,
  roomMeResponseSchema,
  roomMessageSchema,
  roomTurnRefusal,
} from './phase6-room.ts';
import { roomMeWithPicturesResponseSchema, roomPictureTurnRefusal } from './phase6-room-pictures.ts';
import { isSocialSafeText, SOCIAL_JOB_MAX_STATEMENTS, socialJobNameSchema } from './phase6-social.ts';

let failures = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`ok    ${name}: ${a}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${name}: got ${a}, expected ${e}`);
  }
}
function grouped(value: number): string {
  return value.toLocaleString('en-US');
}

const TOKEN = '0xa74ac6e9f2f8493344923c23972d496364241044';
const OTHER = '0x1111111111111111111111111111111111111111';
const WALLET = '0x2222222222222222222222222222222222222222';
const NOW = '2026-10-16T10:00:00.000Z';
const DAY = '2026-10-16';
const ON: HoldersGate = { gatingOn: true, token: TOKEN };
const OFF: HoldersGate = { gatingOn: false, token: TOKEN };
const graceMs = TOKEN_STALE_GRACE_SECONDS * 1_000;
const at = (ms: number): string => new Date(Date.parse(NOW) - ms).toISOString();

// --- F: caps by tier --------------------------------------------------------------------------------------
check('caps by tier', ROOM_WALLET_DAY_CAP_BY_TIER, [30, 60, 90, 120]);
check('tier 0 cap is the room’s old cap', ROOM_WALLET_DAY_CAP_BY_TIER[0], ROOM_MESSAGES_PER_WALLET_PER_DAY);
check('cap tier 0', roomWalletDayCap({ gatingOn: true, tier: 0 }, true), 30);
check('cap tier 1', roomWalletDayCap({ gatingOn: true, tier: 1 }, true), 60);
check('cap tier 2', roomWalletDayCap({ gatingOn: true, tier: 2 }, true), 90);
check('cap tier 3', roomWalletDayCap({ gatingOn: true, tier: 3 }, true), 120);
check('cap tier 3, switch off', roomWalletDayCap({ gatingOn: true, tier: 3 }, false), 30);
check('cap tier 3, gate off', roomWalletDayCap({ gatingOn: false, tier: 3 }, true), 30);
// Revision 2, H1: a holding without `tier` (an old fake, `TokenService.holdingOf` before engine-runtime's change) is tier 0.
check('cap without tier', roomWalletDayCap({ gatingOn: true }, true), 30);
const tokenHolding: Awaited<ReturnType<TokenService['holdingOf']>> = { gatingOn: true, tokens: 20_000, tier: 1 };
const roomHolding: RoomHoldingWithTier = tokenHolding;
check('holdingOf answers a RoomHoldingWithTier without a cast', roomWalletDayCap(roomHolding, true), 60);
check(
  'me answers dayCap while on',
  roomMeResponseSchema.safeParse({ write: 'yes', left: 50, dayCap: 60 }).success,
  true,
);
check('me without dayCap (off)', roomMeResponseSchema.safeParse({ write: 'yes', left: 30 }).success, true);
check(
  'me with pictures carries dayCap',
  roomMeWithPicturesResponseSchema.safeParse({ write: 'yes', left: 90, dayCap: 120, picture: 'yes' }).success,
  true,
);

const writer = (count: number, day = DAY): RoomWriterRecord => ({
  address: WALLET,
  lastAt: at(60_000),
  day,
  count,
  mutedAt: null,
  mutedBy: null,
  cutAt: null,
});
check('turn: default cap unchanged at 30', roomTurnRefusal(writer(30), NOW, DAY), 'day');
check('turn: 30 written under 60', roomTurnRefusal(writer(30), NOW, DAY, 60), null);
check('turn: 59 written under 60', roomTurnRefusal(writer(59), NOW, DAY, 60), null);
check('turn: 60 written under 60', roomTurnRefusal(writer(60), NOW, DAY, 60), 'day');
check('turn: 120 written yesterday under 60', roomTurnRefusal(writer(120, '2026-10-15'), NOW, DAY, 60), null);
check('turn: muted before day', roomTurnRefusal({ ...writer(60), mutedAt: at(1) }, NOW, DAY, 60), 'muted');
check('turn: too soon after the day', roomTurnRefusal({ ...writer(10), lastAt: at(5_000) }, NOW, DAY, 60), 'too_soon');
const pictureWriter = {
  ...writer(30),
  firstAt: at(7_200_000),
  picturesDay: null,
  picturesCount: 0,
  reportsDay: null,
  reportsCount: 0,
  reportStrikes: 0,
  reportedOpen: 0,
};
check('picture turn: 30 written, default cap', roomPictureTurnRefusal(pictureWriter, NOW, DAY), 'day');
check('picture turn: 30 written under 60', roomPictureTurnRefusal(pictureWriter, NOW, DAY, 60), null);
check('left: 25 of 60', roomLeftToday(writer(35), DAY, 60), 25);
check('left: none written', roomLeftToday(null, DAY, 90), 90);
check('left: yesterday counts nothing', roomLeftToday(writer(50, '2026-10-15'), DAY, 30), 30);
check('left: never below 0', roomLeftToday(writer(70), DAY, 60), 0);

// --- F: the stored tier and the mark ------------------------------------------------------------------------
const row = (tier: number, checkedAgoMs = 60_000, token = TOKEN) => ({
  tier,
  tokenAddress: token,
  checkedAt: at(checkedAgoMs),
});
check('stored: no row', storedTierOf(null, ON, NOW), 0);
check('stored: undefined', storedTierOf(undefined, ON, NOW), 0);
check('stored: tier 2', storedTierOf(row(2), ON, NOW), 2);
check('stored: gate off', storedTierOf(row(2), OFF, NOW), 0);
check('stored: no token', storedTierOf(row(2), { gatingOn: true, token: null }, NOW), 0);
check('stored: another token', storedTierOf(row(2, 60_000, OTHER), ON, NOW), 0);
check(
  'stored: upper-case row token',
  storedTierOf(row(1, 60_000, TOKEN.toUpperCase().replace('0X', '0x')), ON, NOW),
  1,
);
check('stored: one ms inside the grace', storedTierOf(row(3, graceMs - 1), ON, NOW), 3);
check('stored: at the grace', storedTierOf(row(3, graceMs), ON, NOW), 0);
check('stored: bad time', storedTierOf({ tier: 2, tokenAddress: TOKEN, checkedAt: 'yesterday' }, ON, NOW), 0);
check('stored: tier 4', storedTierOf(row(4), ON, NOW), 0);
check('stored: tier 1.5', storedTierOf(row(1.5), ON, NOW), 0);
check('mark: tier 1', roomHolderMark(false, 1), true);
check('mark: tier 0', roomHolderMark(false, 0), false);
check('mark: admin at tier 3', roomHolderMark(true, 3), false);
check(
  'message schema takes holder',
  roomMessageSchema.safeParse({ id: 1, at: NOW, authorShort: '0x22…2222', admin: false, text: 'hi', holder: true })
    .success,
  true,
);
check(
  'message schema without holder',
  roomMessageSchema.safeParse({ id: 1, at: NOW, authorShort: '0x22…2222', admin: false, text: 'hi' }).success,
  true,
);
check('switch ROOM_HOLDERS "true"', roomHoldersOn(' TRUE '), true);
check('switch ROOM_HOLDERS "on"', roomHoldersOn('on'), false);

// --- G: config --------------------------------------------------------------------------------------------
const CHAT = '-1001234567890';
const URL_OK = 'https://t.me/+AbCdEf_12345';
check('config: on', loungeConfig({ on: 'on', chatId: CHAT, inviteUrl: URL_OK }), {
  chatId: -1001234567890,
  inviteUrl: URL_OK,
});
check('config: " ON "', loungeConfig({ on: ' ON ', chatId: CHAT, inviteUrl: URL_OK }) !== null, true);
check('config: "true" is not on', loungeConfig({ on: 'true', chatId: CHAT, inviteUrl: URL_OK }), null);
check('config: off', loungeConfig({ on: 'off', chatId: CHAT, inviteUrl: URL_OK }), null);
check('config: unset', loungeConfig({}), null);
check('config: a user id', loungeConfig({ on: 'on', chatId: '12345678', inviteUrl: URL_OK }), null);
check('config: plain group id', loungeConfig({ on: 'on', chatId: '-12345678', inviteUrl: URL_OK }), null);
check('config: public link', loungeConfig({ on: 'on', chatId: CHAT, inviteUrl: 'https://t.me/prixholders' }), null);
check('config: http link', loungeConfig({ on: 'on', chatId: CHAT, inviteUrl: 'http://t.me/+AbCdEf_12345' }), null);
check('config: link with a path', loungeConfig({ on: 'on', chatId: CHAT, inviteUrl: `${URL_OK}/x` }), null);
check(
  'config: the longest id is exact',
  loungeConfig({ on: 'on', chatId: '-1009999999999999', inviteUrl: URL_OK })?.chatId,
  -1009999999999999,
);
check(
  'config: 14 digits after -100',
  loungeConfig({ on: 'on', chatId: '-10099999999999999', inviteUrl: URL_OK }),
  null,
);

// --- G: join decisions ------------------------------------------------------------------------------------
const config = loungeConfig({ on: 'on', chatId: CHAT, inviteUrl: URL_OK });
const USER = 555_000_111;
const member = (telegramUserId: number, wallet = WALLET) => ({
  telegramUserId,
  wallet,
  joinedAt: NOW,
  checkedDay: DAY,
});
const facts = (over: Partial<LoungeJoinFacts> = {}): LoungeJoinFacts => ({
  config,
  request: { chat: { id: -1001234567890, type: 'supergroup' }, from: { id: USER, is_bot: false } },
  linkedWallet: WALLET,
  members: { byUser: null, byWallet: null, count: 3 },
  entitlements: { gatingOn: true, tier: 1 },
  holdingCheckedAt: new Date(Date.parse(NOW) - 60_000).toISOString(),
  now: NOW,
  ...over,
});
check('join: approve', loungeJoinDecision(facts()), { action: 'approve' });
// Revision 3, security L1: the approval needs a read that succeeded within TOKEN_CACHE_SECONDS; otherwise the
// request is ignored (neither approved nor declined) and waits in Telegram.
const cacheMs = TOKEN_CACHE_SECONDS * 1_000;
check('join: no successful read is ignored', loungeJoinDecision(facts({ holdingCheckedAt: null })), {
  action: 'ignore',
});
check(
  'join: a read at the cache age is ignored',
  loungeJoinDecision(facts({ holdingCheckedAt: new Date(Date.parse(NOW) - cacheMs).toISOString() })),
  { action: 'ignore' },
);
check(
  'join: a read one ms inside the cache age approves',
  loungeJoinDecision(facts({ holdingCheckedAt: new Date(Date.parse(NOW) - cacheMs + 1).toISOString() })),
  { action: 'approve' },
);
check(
  'join: a stale read below tier is ignored, not declined',
  loungeJoinDecision(facts({ entitlements: { gatingOn: true, tier: 0 }, holdingCheckedAt: null })),
  { action: 'ignore' },
);
check(
  'join: gate off is declined before freshness',
  loungeJoinDecision(facts({ entitlements: { gatingOn: false, tier: 0 }, holdingCheckedAt: null })),
  { action: 'decline', reason: 'gate_off' },
);
check('read fresh: future time', loungeReadFresh(new Date(Date.parse(NOW) + 1_000).toISOString(), NOW), false);
check('read fresh: bad time', loungeReadFresh('yesterday', NOW), false);
check('full count from', loungeFullCountFrom('2026-10-16T12:00:00.000Z'), {
  joinedFrom: '2026-07-18T12:00:00.000Z',
  checkedFrom: '2026-10-09',
});
check('join: lounge off', loungeJoinDecision(facts({ config: null })), { action: 'ignore' });
check(
  'join: another chat',
  loungeJoinDecision(
    facts({ request: { chat: { id: -1009999999, type: 'supergroup' }, from: { id: USER, is_bot: false } } }),
  ),
  { action: 'ignore' },
);
check(
  'join: a bot',
  loungeJoinDecision(
    facts({ request: { chat: { id: -1001234567890, type: 'supergroup' }, from: { id: USER, is_bot: true } } }),
  ),
  { action: 'decline', reason: 'bot' },
);
check('join: not linked', loungeJoinDecision(facts({ linkedWallet: null, members: null, entitlements: null })), {
  action: 'decline',
  reason: 'not_linked',
});
check(
  'join: wallet held by another account',
  loungeJoinDecision(facts({ members: { byUser: null, byWallet: member(999), count: 3 } })),
  { action: 'decline', reason: 'wallet_taken' },
);
check(
  'join: wallet taken comes before the tier',
  loungeJoinDecision(facts({ members: { byUser: null, byWallet: member(999), count: 3 }, entitlements: null })),
  { action: 'decline', reason: 'wallet_taken' },
);
check(
  'join: own row again (left and came back)',
  loungeJoinDecision(facts({ members: { byUser: member(USER), byWallet: member(USER), count: 3 } })),
  { action: 'approve' },
);
check('join: gate off', loungeJoinDecision(facts({ entitlements: { gatingOn: false, tier: 0 } })), {
  action: 'decline',
  reason: 'gate_off',
});
check('join: entitlements unread', loungeJoinDecision(facts({ entitlements: null })), {
  action: 'decline',
  reason: 'gate_off',
});
check('join: tier 0 after a drop', loungeJoinDecision(facts({ entitlements: { gatingOn: true, tier: 0 } })), {
  action: 'decline',
  reason: 'below_tier',
});
check('join: tier 3', loungeJoinDecision(facts({ entitlements: { gatingOn: true, tier: 3 } })), { action: 'approve' });
check(
  'join: full',
  loungeJoinDecision(facts({ members: { byUser: null, byWallet: null, count: LOUNGE_MEMBERS_MAX } })),
  { action: 'decline', reason: 'full' },
);
check(
  'join: one under full',
  loungeJoinDecision(facts({ members: { byUser: null, byWallet: null, count: LOUNGE_MEMBERS_MAX - 1 } })),
  { action: 'approve' },
);
check(
  'join: full, but the user has a row',
  loungeJoinDecision(facts({ members: { byUser: member(USER, OTHER), byWallet: null, count: LOUNGE_MEMBERS_MAX } })),
  { action: 'approve' },
);
check('join: members unread at the end', loungeJoinDecision(facts({ members: null })), {
  action: 'decline',
  reason: 'full',
});

// --- G: the sweep -----------------------------------------------------------------------------------------
const due = (over: Partial<LoungeDueMember> = {}): LoungeDueMember => ({
  ...member(USER),
  checkedDay: '2026-10-15',
  linkedChatId: USER,
  holder: row(1),
  ...over,
});
check('sweep: keep a holder', loungeSweepVerdict(due(), ON, NOW), 'keep');
check('sweep: tier dropped', loungeSweepVerdict(due({ holder: row(0) }), ON, NOW), 'remove_below_tier');
check('sweep: a removal is not marked', loungeSweepMarks(due({ holder: row(0) }), ON, NOW), false);
check('sweep: keep a holder and mark it', loungeSweepMarks(due(), ON, NOW), true);
// Revision 2, M8: a missing, stale or other-token row never removes; it is kept and left unchecked.
check('sweep: no stored row keeps', loungeSweepVerdict(due({ holder: null }), ON, NOW), 'keep');
check('sweep: no stored row is not marked', loungeSweepMarks(due({ holder: null }), ON, NOW), false);
check('sweep: stored row at the grace keeps', loungeSweepVerdict(due({ holder: row(0, graceMs) }), ON, NOW), 'keep');
check('sweep: stale row is not marked', loungeSweepMarks(due({ holder: row(2, graceMs) }), ON, NOW), false);
check(
  'sweep: stale tier-0 row one ms inside the grace removes',
  loungeSweepVerdict(due({ holder: row(0, graceMs - 1) }), ON, NOW),
  'remove_below_tier',
);
check(
  'sweep: other-token tier-0 row keeps',
  loungeSweepVerdict(due({ holder: row(0, 60_000, OTHER) }), ON, NOW),
  'keep',
);
check('sweep: other-token row is not marked', loungeSweepMarks(due({ holder: row(3, 60_000, OTHER) }), ON, NOW), false);
check('row current: fresh', loungeStoredRowCurrent(row(0), ON, NOW), true);
check('row current: none', loungeStoredRowCurrent(null, ON, NOW), false);
check('row current: gate off', loungeStoredRowCurrent(row(1), OFF, NOW), false);
check(
  'row current: bad time',
  loungeStoredRowCurrent({ tier: 1, tokenAddress: TOKEN, checkedAt: 'yesterday' }, ON, NOW),
  false,
);
check('sweep: unlinked (/stop)', loungeSweepVerdict(due({ linkedChatId: null }), ON, NOW), 'remove_unlinked');
check('sweep: link passed on', loungeSweepVerdict(due({ linkedChatId: 777 }), ON, NOW), 'remove_unlinked');
check(
  'sweep: unlinked before tier',
  loungeSweepVerdict(due({ linkedChatId: null, holder: null }), ON, NOW),
  'remove_unlinked',
);
check('sweep: gate off keeps all', loungeSweepVerdict(due({ linkedChatId: null, holder: null }), OFF, NOW), 'keep');
check('sweep hour 01:59', loungeSweepHour(new Date('2026-10-16T01:59:59.999Z')), false);
check('sweep hour 02:00', loungeSweepHour(new Date('2026-10-16T02:00:00.000Z')), true);
check('sweep hour 23:58', loungeSweepHour(new Date('2026-10-16T23:58:00.000Z')), true);
check('job name', socialJobNameSchema.safeParse('holders_lounge_sweep').success, true);

// --- G: direct chats, messages, the account answer ----------------------------------------------------------
check('direct: a user', loungeDirectChatOk(USER), true);
check('direct: the lounge', loungeDirectChatOk(-1001234567890), false);
check('direct: zero', loungeDirectChatOk(0), false);
check('direct: fraction', loungeDirectChatOk(1.5), false);
check('message: bot', loungeDirectMessage('bot', 'https://prixagent.com'), null);
check('message: keep', loungeDirectMessage('keep', 'https://prixagent.com'), null);
check(
  'message: not linked fills the link',
  loungeDirectMessage('not_linked', 'https://prixagent.com/')?.includes('https://prixagent.com/following,'),
  true,
);
check(
  'message: removed unlinked names /following',
  loungeDirectMessage('remove_unlinked', 'https://prixagent.com')?.includes('https://prixagent.com/following '),
  true,
);
check(
  'messages: none names /account',
  Object.values(LOUNGE_DIRECT_MESSAGES).some((text) => text.includes('{account}') || text.includes('/account')),
  false,
);
check(
  'message: no placeholder left',
  loungeDirectMessage('remove_unlinked', 'https://prixagent.com')?.includes('{'),
  false,
);
const configNonNull = config ?? { chatId: 0, inviteUrl: '' };
check('account: gate off', loungeAccountAnswer(configNonNull, { gatingOn: false, tier: 3 }, true), {
  state: 'not_holder',
  url: null,
});
check('account: tier 0', loungeAccountAnswer(configNonNull, { gatingOn: true, tier: 0 }, true), {
  state: 'not_holder',
  url: null,
});
check('account: not linked', loungeAccountAnswer(configNonNull, { gatingOn: true, tier: 1 }, false), {
  state: 'link_telegram',
  url: null,
});
check('account: open', loungeAccountAnswer(configNonNull, { gatingOn: true, tier: 1 }, true), {
  state: 'open',
  url: URL_OK,
});
check(
  'account schema: url only when open',
  loungeResponseSchema.safeParse({ state: 'not_holder', url: URL_OK }).success,
  false,
);
check('account schema: open without url', loungeResponseSchema.safeParse({ state: 'open', url: null }).success, false);
check('account schema: open', loungeResponseSchema.safeParse({ state: 'open', url: URL_OK }).success, true);
const joinUpdate = telegramUpdateWithJoinSchema.safeParse({
  update_id: 1,
  chat_join_request: {
    chat: { id: -1001234567890, type: 'supergroup', title: 'Prix Holders' },
    from: { id: USER, is_bot: false, first_name: 'A' },
    user_chat_id: USER,
    date: 1_760_000_000,
    invite_link: { invite_link: URL_OK },
  },
});
check('update: a join request parses', joinUpdate.success, true);
check(
  'update: unknown fields dropped',
  joinUpdate.success && !('invite_link' in (joinUpdate.data.chat_join_request ?? {})),
  true,
);
check(
  'update: a message still parses',
  telegramUpdateWithJoinSchema.safeParse({ message: { text: '/stop', chat: { id: USER, type: 'private' } } }).success,
  true,
);

// --- H: the tape ------------------------------------------------------------------------------------------
check('tape view: no delay', tapeViewOf({ feedDelaySeconds: 0 }), 'live');
check('tape view: the delay', tapeViewOf({ feedDelaySeconds: 86_400 }), 'delayed');
check('tape key live', tapeCacheKey('https://prixagent.com/', 'live'), 'https://prixagent.com/__cache/tape/live');
check(
  'tape key delayed',
  tapeCacheKey('https://prixagent.com', 'delayed'),
  'https://prixagent.com/__cache/tape/delayed',
);
check('tape query: none', tapeQuerySchema.safeParse({}).success, true);
check('tape query: a parameter', tapeQuerySchema.safeParse({ view: 'live' }).success, false);
check('tape query: a cursor', tapeQuerySchema.safeParse({ cursor: 'x' }).success, false);
check('tape switch', [tapeEnabled('true'), tapeEnabled('on'), tapeEnabled(undefined)], [true, false, false]);
check(
  'tape answer: too many rows refused',
  tapeResponseSchema.safeParse({
    view: 'live',
    delay: { seconds: 0, gatingOn: true },
    items: new Array(TAPE_ROWS + 1).fill({}),
    asOf: NOW,
  }).success,
  false,
);

// --- the words --------------------------------------------------------------------------------------------
const sentences: [string, string][] = [
  ...Object.entries(HOLDERS2_PAGE_WORDS),
  ...Object.entries(LOUNGE_DIRECT_MESSAGES).filter(([, text]) => text !== ''),
  ['LOUNGE_DESCRIPTION', LOUNGE_DESCRIPTION],
];
const WAVE_WORDS = /\b(verified|governance|dao|vote on the token|return|yield|profit|earn\w*|reward\w*)\b|%/i;
for (const [key, text] of sentences) {
  check(`words safe: ${key}`, isSocialSafeText(text) && !WAVE_WORDS.test(text), true);
}
check('the mark is one word', HOLDERS2_PAGE_WORDS['social.roomHolderMark'], 'Holder');
// Revision 3, security M1: the lounge is the Community group (D-163); no sentence says every member holds,
// that the bot never posts there, or that Prix never writes first.
check(
  'description: the group as D-163 makes it',
  LOUNGE_DESCRIPTION.startsWith('Prix Community.') &&
    LOUNGE_DESCRIPTION.includes('says nothing about anyone') &&
    !/never posts|never write to anyone first|Prix Holders/.test(LOUNGE_DESCRIPTION),
  true,
);
check(
  'no sentence names the old group',
  sentences.some(([, text]) => text.includes('Prix Holders')),
  false,
);
check('no key that no page shows (tape.nav removed, revision 2)', 'tape.nav' in HOLDERS2_PAGE_WORDS, false);
const tier1Tokens = ((TIER_RULES[HOLDERS2_MIN_TIER]?.thresholdPpm ?? 0) * 1_000_000_000) / 1_000_000;
check('tier 1 in whole tokens', tier1Tokens, 10_000);
for (const [key, text] of sentences) {
  if (/10,000/.test(text) || key.startsWith('lounge.') || key.startsWith('tape.view')) {
    check(`figure where named: ${key}`, !/\b(10000|10k|1%)\b/i.test(text), true);
  }
}

// --- the figures of the document's section 8 --------------------------------------------------------------
// Revision 3, security H1: the sweep reads its members' wallets again (one chain read, two statements).
const sweepSubrequests = LOUNGE_SWEEP_STATEMENTS_MAX + LOUNGE_SWEEP_TELEGRAM_CALLS_MAX + 1;
const idleReadsAhead = LOUNGE_SWEEP_JOBS_AHEAD * SOCIAL_IDLE_READS_PER_JOB;
const stepSubrequests = sweepSubrequests + idleReadsAhead;
const runsForFullLounge = Math.ceil(LOUNGE_MEMBERS_MAX / LOUNGE_SWEEP_CHECKS_PER_RUN);
const markRowsADay = LOUNGE_MEMBERS_MAX * LOUNGE_MARK_WRITE_ROWS_PER_MEMBER;
check('sweep statements within a social job', LOUNGE_SWEEP_STATEMENTS_MAX <= SOCIAL_JOB_MAX_STATEMENTS, true);
check('sweep statements with the guard and the read again', LOUNGE_SWEEP_STATEMENTS_MAX, 12);
check('sweep subrequests: the constant equals the sum', LOUNGE_SWEEP_SUBREQUESTS_MAX, sweepSubrequests);
check('sweep subrequests of its own', sweepSubrequests, 28);
check('step subrequests with the jobs ahead', stepSubrequests, 40);
check('the config log line is named', LOUNGE_LOG_EVENTS.includes('lounge_config_invalid'), true);
check(
  'step subrequests with the idle jobs ahead within 50',
  stepSubrequests <= SOCIAL_STEP_SUBREQUESTS_MAX && SOCIAL_STEP_SUBREQUESTS_MAX === 50,
  true,
);
check('job name is the last of the schema', socialJobNameSchema.options.at(-1), 'holders_lounge_sweep');
const figures: Record<string, string> = {
  'Messages a day by tier': ROOM_WALLET_DAY_CAP_BY_TIER.join(', '),
  "The room's cap of a day, unchanged": grouped(ROOM_MESSAGES_PER_DAY_DEFAULT),
  'Tier 1 in whole $PRIX': grouped(tier1Tokens),
  LOUNGE_MEMBERS_MAX: grouped(LOUNGE_MEMBERS_MAX),
  LOUNGE_SWEEP_FROM_HOUR_UTC: String(LOUNGE_SWEEP_FROM_HOUR_UTC),
  LOUNGE_SWEEP_CHECKS_PER_RUN: String(LOUNGE_SWEEP_CHECKS_PER_RUN),
  LOUNGE_SWEEP_REMOVALS_PER_RUN: String(LOUNGE_SWEEP_REMOVALS_PER_RUN),
  'D1 statements of a sweep run at most': String(LOUNGE_SWEEP_STATEMENTS_MAX),
  'Telegram calls of a sweep run at most': String(LOUNGE_SWEEP_TELEGRAM_CALLS_MAX),
  'Subrequests of a sweep run at most': String(sweepSubrequests),
  'Idle reads of the jobs ahead of the sweep, booked': String(idleReadsAhead),
  'Subrequests of the social step when the sweep runs, at most': String(stepSubrequests),
  'Sweep runs for a full lounge': String(runsForFullLounge),
  'D1 rows a join writes': String(LOUNGE_JOIN_WRITE_ROWS),
  "D1 rows of a day's marks at the cap": grouped(markRowsADay),
  TAPE_ROWS: String(TAPE_ROWS),
  TAPE_CACHE_SECONDS: String(TAPE_CACHE_SECONDS),
  'Stale grace of a stored tier, seconds': grouped(TOKEN_STALE_GRACE_SECONDS),
  'Fresh read a join needs, seconds': grouped(TOKEN_CACHE_SECONDS),
  LOUNGE_DIRECT_MEMORY_MAX: grouped(LOUNGE_DIRECT_MEMORY_MAX),
  LOUNGE_FULL_JOINED_DAYS: String(LOUNGE_FULL_JOINED_DAYS),
  LOUNGE_FULL_MARKED_DAYS: String(LOUNGE_FULL_MARKED_DAYS),
  'Slow Mode in the Community group, seconds': String(LOUNGE_SLOW_MODE_SECONDS),
  "The group's requests of prix-api a day before the switch goes back off": grouped(LOUNGE_GROUP_REQUESTS_DAY_MAX),
};
/** Node's own process and file reader, reached without Node's types (the package has none), as phase6-coach.check.mts does. */
const runtime = (
  globalThis as unknown as {
    process?: {
      exit(code: number): never;
      getBuiltinModule?(name: string): { readFileSync(path: URL, encoding: 'utf8'): string } | undefined;
    };
  }
).process;
const fs = runtime?.getBuiltinModule?.('node:fs');
if (fs === undefined) throw new Error('Run this script with Node 22.3 or later.');
const doc: string = fs.readFileSync(new URL('../../../docs/contracts/phase-6-holders-2.md', import.meta.url), 'utf8');
const table = new Map<string, string>();
for (const line of doc.split(/\r?\n/)) {
  const match = /^\| (.+?) \| `?([^|`]+?)`? \|$/.exec(line.trim());
  if (match?.[1] !== undefined && match[2] !== undefined) table.set(match[1].replace(/`/g, ''), match[2]);
}
for (const [name, value] of Object.entries(figures)) {
  check(`document figure: ${name}`, table.get(name) ?? '(missing)', value);
}
for (const [key, text] of Object.entries(HOLDERS2_PAGE_WORDS)) {
  check(`document prints ${key}`, doc.includes(`\`${key}\``) && doc.includes(text), true);
}

console.log(failures === 0 ? 'ALL OK' : `${failures} FAILED`);
runtime?.exit(failures === 0 ? 0 : 1);
