// The operator's check of the holders' second wave (phase6-holders2.ts, docs/contracts/phase-6-holders-2.md),
// revision 5 (Phase 6.8). It pins every pure rule of the file with its cases, computes every figure of the document's
// section 8 from the constants and fails when the table prints a value it did not compute, and runs every
// sentence of the wave (the page words, the direct messages, the lounge's description) through
// `isSocialSafeText` and the wave's own word rules. One line a case; exit 1 on any surprise.
// Usage: node --experimental-strip-types --no-warnings packages/contracts/src/phase6-holders2.check.mts

import { TIER_RULES } from './entitlements.ts';
import { TOKEN_CACHE_SECONDS, TOKEN_STALE_GRACE_SECONDS, type TokenService } from './phase4-token.ts';
import {
  POLL_MAX_VOTERS,
  POLL_MAX_VOTERS_FLOOR,
  POLL_PRUNE_AT,
  POLL_PRUNE_RUN_STATEMENTS_BEHIND_WAITING_MAX,
  POLL_PRUNE_RUN_STATEMENTS_MAX,
  POLL_PURGE_MAX_POLLS,
  POLL_TALLY_FETCH_LATENCY_MS,
  POLL_TALLY_IDLE_STATEMENTS_MAX,
  POLL_TALLY_MAX_CHAIN_READS,
  POLL_TALLY_MAX_FETCHES,
  POLL_TALLY_MAX_RUN_SECONDS,
  POLL_TALLY_PAGE,
  POLL_TALLY_RUN_CONFIG_READS,
  POLL_TALLY_RUN_STATEMENTS_BEHIND_WAITING_MAX,
  POLL_TALLY_RUN_STATEMENTS_MAX,
  POLL_TALLY_WAITING_POLL_STATEMENTS,
  POLL_TALLY_WAITING_STATEMENTS,
  pollTallyStepAnswer,
  pollTallyWorstReadMs,
} from './phase6-holders.ts';
import {
  CLOCK_ALARM_FANOUT_CALLS,
  D1_FREE_QUERIES_PER_INVOCATION,
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
  POLL_TALLY_JOBS_AHEAD,
  POLL_TALLY_RUN_DO_CALLS,
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
  WORKERS_FREE_SUBREQUESTS_PER_INVOCATION,
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
// Revision 5f (with revision 8f of phase-6-holders.md, R8E-SEC-4): a run of poll_tally that answers idle from a
// waiting tally (F3) made POLL_TALLY_WAITING_STATEMENTS statements, which the sweep's sum books in place of two.
// Revision 5g (with revision 8g of phase-6-holders.md, H3, R8F-SEC-2): since the fall-through, the worst idle run
// passes up to POLL_PURGE_MAX_POLLS waiting polls (two statements each, the configuration's read once a run), the
// purge's empty tries taking a waiting poll's place, and castCounts: POLL_TALLY_IDLE_STATEMENTS_MAX, booked in
// place of two.
const idleRunMax = 1 + 1 + POLL_TALLY_RUN_CONFIG_READS + 2 * POLL_PURGE_MAX_POLLS + 1;
const stepSubrequestsBehindWaiting =
  sweepSubrequests + (LOUNGE_SWEEP_JOBS_AHEAD - 1) * SOCIAL_IDLE_READS_PER_JOB + POLL_TALLY_IDLE_STATEMENTS_MAX;
check(
  "a waiting poll_tally run's statements: the job's results read, the skip gate, the tally's results read, the configuration's read and the first listVoters page (R8E-SEC-4)",
  POLL_TALLY_WAITING_STATEMENTS === 1 + 1 + 1 + POLL_TALLY_RUN_CONFIG_READS + 1 && POLL_TALLY_WAITING_STATEMENTS === 5,
  true,
);
check(
  "the worst idle poll_tally run once a waiting answer falls through: the job's results read, the skip gate, the configuration's read, two for each waiting poll of at most POLL_PURGE_MAX_POLLS, castCounts (R8F-SEC-2)",
  [POLL_TALLY_IDLE_STATEMENTS_MAX, idleRunMax, POLL_TALLY_WAITING_POLL_STATEMENTS],
  [10, 10, 2],
);
check(
  'the step subrequests when the sweep runs behind the worst idle poll_tally, 48 within 50 (R8F-SEC-2, PF5-SEC-3)',
  [stepSubrequestsBehindWaiting, stepSubrequestsBehindWaiting <= SOCIAL_STEP_SUBREQUESTS_MAX],
  [48, true],
);
check('job name is the last of the schema', socialJobNameSchema.options.at(-1), 'holders_lounge_sweep');
// Revision 4 (with revision 7 of phase-6-holders.md, R4, HB1F2-SEC-1): poll_tally's worst non-idle runs. A run
// that reached its reads answers done, so the step ends with it and nothing behind it runs in that invocation.
// Revision 5 (revision 8 of phase-6-holders.md, R8-2 and R8-3): ONE sum for each worst run with one endpoint down,
// D1 statements (the idle jobs ahead and the run's own), Durable Object calls and fetches; nothing for the jobs
// behind, which do not run in that invocation. The sums are computed at any cap of voters, so that the step down
// from revision 7's 4,000 is the check's and not a hand sum.
const pollIdleAhead = POLL_TALLY_JOBS_AHEAD * SOCIAL_IDLE_READS_PER_JOB;
const pollJobsBehind = 0;
// Revision 5b (R8-SEC-2, R8B-1): the whole alarm invocation, from the entry of Clock.alarm(): the clock fan-out's
// Durable Object calls ahead of the step and the token configuration's read inside the run's statements.
const pollSumsAt = (maxVoters: number, fanout: number = CLOCK_ALARM_FANOUT_CALLS) => {
  const pages = maxVoters / POLL_TALLY_PAGE + 1;
  const reads = maxVoters / POLL_TALLY_PAGE + 1;
  // R8-2: two fetches a read, and one for the fetch that found the endpoint down.
  const fetches = 2 * reads + 1;
  // The job's results read, the skip gate, tallyPoll's results read, the config read, the pages, 4 result rows,
  // the clear.
  const tallyStatements = 1 + 1 + 1 + POLL_TALLY_RUN_CONFIG_READS + pages + 4 + 1;
  // The job's results read, the skip gate, the purge's tries, the config read, castCounts, the pages, the batch
  // of 2, the clear.
  const pruneStatements = 1 + 1 + POLL_PURGE_MAX_POLLS + POLL_TALLY_RUN_CONFIG_READS + 1 + pages + 2 + 1;
  const tally = fanout + pollIdleAhead + tallyStatements + POLL_TALLY_RUN_DO_CALLS + fetches + pollJobsBehind;
  const prune = fanout + pollIdleAhead + pruneStatements + POLL_TALLY_RUN_DO_CALLS + fetches + pollJobsBehind;
  // Revision 5g (revision 8g of phase-6-holders.md, H3, R8F-SEC-2, F8F-B3 (iii)): the same runs behind the waiting
  // polls a run may pass first. No POLL_WATCH_DAYS window holds more than POLL_PURGE_MAX_POLLS closes, so a tally
  // passes at most POLL_PURGE_MAX_POLLS - 1 waiting polls (two statements each), and a prune passes w waiting polls
  // and tries at most POLL_PURGE_MAX_POLLS - w counted ones (worst at w = POLL_PURGE_MAX_POLLS).
  let tallyStatementsBehindWaiting = 0;
  for (let w = 0; w <= POLL_PURGE_MAX_POLLS - 1; w += 1) {
    tallyStatementsBehindWaiting = Math.max(tallyStatementsBehindWaiting, tallyStatements + 2 * w);
  }
  let pruneStatementsBehindWaiting = 0;
  for (let w = 0; w <= POLL_PURGE_MAX_POLLS; w += 1) {
    const counted = POLL_PURGE_MAX_POLLS - w;
    pruneStatementsBehindWaiting = Math.max(
      pruneStatementsBehindWaiting,
      pruneStatements - POLL_PURGE_MAX_POLLS + counted + 2 * w,
    );
  }
  const tallyBehindWaiting =
    fanout + pollIdleAhead + tallyStatementsBehindWaiting + POLL_TALLY_RUN_DO_CALLS + fetches + pollJobsBehind;
  const pruneBehindWaiting =
    fanout + pollIdleAhead + pruneStatementsBehindWaiting + POLL_TALLY_RUN_DO_CALLS + fetches + pollJobsBehind;
  return {
    tally,
    prune,
    fetches,
    tallyStatements,
    pruneStatements,
    tallyStatementsBehindWaiting,
    pruneStatementsBehindWaiting,
    tallyBehindWaiting,
    pruneBehindWaiting,
  };
};
const atCap = pollSumsAt(POLL_MAX_VOTERS);
const atRevision7 = pollSumsAt(4_000);
const atRevision8 = pollSumsAt(3_600);
// R8-3: from 4,000, POLL_MAX_VOTERS and POLL_PRUNE_AT come down by POLL_TALLY_PAGE until both sums fit.
// Revision 8c (CR8B-1, C1): and until the 429 case and the never-answering case fit the run's seconds.
const sumsFit = (cap: number, fanout: number) =>
  pollSumsAt(cap, fanout).tally <= SOCIAL_STEP_SUBREQUESTS_MAX &&
  pollSumsAt(cap, fanout).prune <= SOCIAL_STEP_SUBREQUESTS_MAX;
// Revision 5d (revision 8d of phase-6-holders.md, D4, R8C-SEC-3): and the slow-answering case; the latency is the
// constant unless the operator's measured mean is passed (D5, R8C-SEC-2).
const timeFits = (cap: number, latencyMs: number = POLL_TALLY_FETCH_LATENCY_MS) =>
  pollTallyWorstReadMs(cap, latencyMs).rateLimited <= POLL_TALLY_MAX_RUN_SECONDS * 1_000 &&
  pollTallyWorstReadMs(cap, latencyMs).neverAnswering <= POLL_TALLY_MAX_RUN_SECONDS * 1_000 &&
  pollTallyWorstReadMs(cap, latencyMs).slowAnswering <= POLL_TALLY_MAX_RUN_SECONDS * 1_000 &&
  // Revision 5e (revision 8e of phase-6-holders.md, F1, CR8D-1): and a third party's slow tail.
  pollTallyWorstReadMs(cap, latencyMs).thirdPartyTail <= POLL_TALLY_MAX_RUN_SECONDS * 1_000;
// Revision 5d (D5, R8C-SEC-5): the step down never settles below POLL_MAX_VOTERS_FLOOR; null when no step at or
// above it fits, which holds the switch.
// Revision 5g (H3, R8F-SEC-2): the cap that decides also needs the runs behind waiting polls to fit 50.
const waitingFits = (cap: number, fanout: number) =>
  pollSumsAt(cap, fanout).tallyBehindWaiting <= SOCIAL_STEP_SUBREQUESTS_MAX &&
  pollSumsAt(cap, fanout).pruneBehindWaiting <= SOCIAL_STEP_SUBREQUESTS_MAX;
const fitFrom = (fanout: number, withTime: boolean, latencyMs: number = POLL_TALLY_FETCH_LATENCY_MS): number => {
  let cap = 4_000;
  while (cap > 0 && (!sumsFit(cap, fanout) || (withTime && (!timeFits(cap, latencyMs) || !waitingFits(cap, fanout))))) {
    cap -= POLL_TALLY_PAGE;
  }
  return cap;
};
const fitAtFloor = (latencyMs: number = POLL_TALLY_FETCH_LATENCY_MS): number | null => {
  const cap = fitFrom(CLOCK_ALARM_FANOUT_CALLS, true, latencyMs);
  return cap >= POLL_MAX_VOTERS_FLOOR ? cap : null;
};
const fitted = fitAtFloor();
const fittedBySumAlone = fitFrom(CLOCK_ALARM_FANOUT_CALLS, false);
const fittedWithFanout = fitFrom(4, false);
check(
  'a step at or above POLL_MAX_VOTERS_FLOOR fits (D5, R8C-SEC-5)',
  fitted !== null && fitted >= POLL_MAX_VOTERS_FLOOR,
  true,
);
check(
  'at a measured mean of 450 ms a fetch no step at or above the floor fits, so the switch holds (D5, R8C-SEC-5)',
  [fitAtFloor(450), fitFrom(CLOCK_ALARM_FANOUT_CALLS, true, 450), fitAtFloor(437)],
  [null, 800, 1_200],
);
check(
  'the slow-answering case fits at the cap and binds no lower than the never-answering case (D4, R8C-SEC-3)',
  [
    pollTallyWorstReadMs(POLL_MAX_VOTERS).slowAnswering,
    pollTallyWorstReadMs(POLL_MAX_VOTERS).slowAnswering <= pollTallyWorstReadMs(POLL_MAX_VOTERS).neverAnswering,
  ],
  [3_900, true],
);
check(
  "a third party's slow tail fits at the cap, 4,500 of 5,000, and the step down fits it (F1, CR8D-1)",
  [
    pollTallyWorstReadMs(POLL_MAX_VOTERS).thirdPartyTail,
    POLL_TALLY_MAX_RUN_SECONDS * 1_000,
    timeFits(POLL_MAX_VOTERS),
    // The sum is the never-answering case's at every latency, so it binds no lower than that case.
    [300, 350, 437, 450].every(
      (latencyMs) =>
        pollTallyWorstReadMs(POLL_MAX_VOTERS, latencyMs).thirdPartyTail ===
        pollTallyWorstReadMs(POLL_MAX_VOTERS, latencyMs).neverAnswering,
    ),
  ],
  [4_500, 5_000, true, true],
);
check('the social alarm makes no Durable Object call ahead of the step (R8-SEC-2)', CLOCK_ALARM_FANOUT_CALLS, 0);
check(
  'the cap by the one sum alone if the social alarm still started the four other clocks (R8-SEC-2)',
  fittedWithFanout,
  2_800,
);
check('the cap by the one sum alone (CR8B-1: the window binds below it)', fittedBySumAlone, 3_200);
check(
  'the worst reads at the cap: the 429 case and the never-answering case, of the run milliseconds (CR8B-1)',
  [
    pollTallyWorstReadMs(POLL_MAX_VOTERS).rateLimited,
    pollTallyWorstReadMs(POLL_MAX_VOTERS).neverAnswering,
    POLL_TALLY_MAX_RUN_SECONDS * 1_000,
  ],
  [3_300, 4_500, 5_000],
);
check(
  'poll_tally sits behind five jobs, the sweep behind those five and poll_tally',
  POLL_TALLY_JOBS_AHEAD === LOUNGE_SWEEP_JOBS_AHEAD - 1,
  true,
);
check('a poll_tally run that reached its reads ends the step', pollTallyStepAnswer('idle', true), 'done');
check('a poll_tally run that failed after its reads ends the step', pollTallyStepAnswer('failed', true), 'done');
check('a poll_tally run before its reads keeps idle', pollTallyStepAnswer('idle', false), 'idle');
check(
  'the one sum uses the exported statements and fetch cap (R8-2, R8-3)',
  atCap.tallyStatements === POLL_TALLY_RUN_STATEMENTS_MAX &&
    atCap.pruneStatements === POLL_PRUNE_RUN_STATEMENTS_MAX &&
    atCap.fetches === POLL_TALLY_MAX_FETCHES &&
    atCap.fetches === 2 * POLL_TALLY_MAX_CHAIN_READS + 1,
  true,
);
check('the worst tally step with one endpoint down', atCap.tally, 35);
check('the worst prune step with one endpoint down', atCap.prune, 36);
check(
  'the worst tally and prune runs behind waiting polls, their statements from the exported constants and their one sums, 39 and 39 within 50 (R8F-SEC-2, F8F-B3)',
  [
    atCap.tallyStatementsBehindWaiting,
    POLL_TALLY_RUN_STATEMENTS_BEHIND_WAITING_MAX,
    atCap.pruneStatementsBehindWaiting,
    POLL_PRUNE_RUN_STATEMENTS_BEHIND_WAITING_MAX,
    atCap.tallyBehindWaiting,
    atCap.pruneBehindWaiting,
    waitingFits(POLL_MAX_VOTERS, CLOCK_ALARM_FANOUT_CALLS),
  ],
  [18, 18, 18, 18, 39, 39, true],
);
check(
  'both within the step 50',
  atCap.tally <= SOCIAL_STEP_SUBREQUESTS_MAX && atCap.prune <= SOCIAL_STEP_SUBREQUESTS_MAX,
  true,
);
check('at revision 7 4,000 voters the sums are over 50', [atRevision7.tally, atRevision7.prune], [53, 54]);
check('at revision 8 3,600 voters the sums are 50 and 51 (R8B-1)', [atRevision8.tally, atRevision8.prune], [50, 51]);
check(
  'R8-3, CR8B-1, CR8B-2: the cap is the first step down from 4,000 at which both sums and both worst reads fit, and the prune one page below it',
  [fitted, POLL_MAX_VOTERS, POLL_PRUNE_AT, POLL_MAX_VOTERS - POLL_TALLY_PAGE],
  [1_600, 1_600, 1_200, 1_200],
);
check('the run calls no Durable Object', POLL_TALLY_RUN_DO_CALLS, 0);
const d1Statements = pollIdleAhead + Math.max(POLL_TALLY_RUN_STATEMENTS_MAX, POLL_PRUNE_RUN_STATEMENTS_MAX);
check(
  'for information: fetches against Workers "Subrequests per invocation" (50, Free), D1 statements against D1 "Queries per Worker invocation" (50, Free)',
  [atCap.fetches <= WORKERS_FREE_SUBREQUESTS_PER_INVOCATION, d1Statements <= D1_FREE_QUERIES_PER_INVOCATION],
  [true, true],
);
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
  'Statements of a poll_tally run that answers idle from a waiting tally': String(POLL_TALLY_WAITING_STATEMENTS),
  'Statements of a poll_tally run that answers idle once a waiting answer falls through, at most': String(idleRunMax),
  'Subrequests of the social step when the sweep runs behind a waiting poll_tally, at most':
    String(stepSubrequestsBehindWaiting),
  "Statements of poll_tally's worst tally run behind waiting polls with the guard's clear": String(
    atCap.tallyStatementsBehindWaiting,
  ),
  "Statements of poll_tally's worst prune run behind waiting polls with the guard's clear": String(
    atCap.pruneStatementsBehindWaiting,
  ),
  'Subrequests of the social step when poll_tally tallies behind waiting polls with one endpoint down, at most': String(
    atCap.tallyBehindWaiting,
  ),
  'Subrequests of the social step when poll_tally prunes behind waiting polls with one endpoint down, at most': String(
    atCap.pruneBehindWaiting,
  ),
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
  'Jobs ahead of poll_tally, each idle': String(POLL_TALLY_JOBS_AHEAD),
  'Idle reads of the jobs ahead of poll_tally, booked': String(pollIdleAhead),
  "Statements of poll_tally's worst tally run with the guard's clear": String(POLL_TALLY_RUN_STATEMENTS_MAX),
  "Statements of poll_tally's worst prune run with the guard's clear": String(POLL_PRUNE_RUN_STATEMENTS_MAX),
  'Durable Object calls of a poll_tally run': String(POLL_TALLY_RUN_DO_CALLS),
  "Durable Object calls of the social clock's alarm ahead of the step": String(CLOCK_ALARM_FANOUT_CALLS),
  'Token configuration reads of a poll_tally run, in its statements': String(POLL_TALLY_RUN_CONFIG_READS),
  'Fetches of the chain in a poll_tally run with one endpoint down, at most': String(atCap.fetches),
  'Subrequests of the social step when poll_tally tallies with one endpoint down, at most': String(atCap.tally),
  'Subrequests of the social step when poll_tally prunes with one endpoint down, at most': String(atCap.prune),
  "Subrequests left to room_picture_sweep and room_prune after poll_tally's worst tally run, unused": String(
    SOCIAL_STEP_SUBREQUESTS_MAX - atCap.tally,
  ),
  "Subrequests left to room_picture_sweep and room_prune after poll_tally's worst prune run, unused": String(
    SOCIAL_STEP_SUBREQUESTS_MAX - atCap.prune,
  ),
  "The same two sums at revision 7's 4,000 voters, tally and prune": `${atRevision7.tally}, ${atRevision7.prune}`,
  "The same two sums at revision 8's 3,600 voters, tally and prune": `${atRevision8.tally}, ${atRevision8.prune}`,
  'The cap of voters by the one sum alone if the social alarm still started the four other clocks':
    grouped(fittedWithFanout),
  'The cap of voters by the one sum alone': grouped(fittedBySumAlone),
  "Milliseconds of reads of poll_tally's worst run at the cap, the 429 case and never answering, of the run's": `${grouped(pollTallyWorstReadMs(POLL_MAX_VOTERS).rateLimited)}, ${grouped(pollTallyWorstReadMs(POLL_MAX_VOTERS).neverAnswering)} of ${grouped(POLL_TALLY_MAX_RUN_SECONDS * 1_000)}`,
  "Milliseconds of reads of poll_tally's worst run at the cap with one endpoint answering slowly, of the run's": `${grouped(pollTallyWorstReadMs(POLL_MAX_VOTERS).slowAnswering)} of ${grouped(POLL_TALLY_MAX_RUN_SECONDS * 1_000)}`,
  "Milliseconds of reads of poll_tally's worst run at the cap with one third party's answer just under the timeout, of the run's": `${grouped(pollTallyWorstReadMs(POLL_MAX_VOTERS).thirdPartyTail)} of ${grouped(POLL_TALLY_MAX_RUN_SECONDS * 1_000)}`,
  'The cap of voters, never settled below': grouped(POLL_MAX_VOTERS_FLOOR),
  'Fetches of poll_tally\'s worst run against the Workers limit "Subrequests per invocation" (Free), for information': `${atCap.fetches} of ${WORKERS_FREE_SUBREQUESTS_PER_INVOCATION}`,
  'D1 statements of the invocation with poll_tally\'s worst run against the D1 limit "Queries per Worker invocation" (Free), for information': `${d1Statements} of ${D1_FREE_QUERIES_PER_INVOCATION}`,
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
// Revision 5: the booking prints the one sum of each worst run, says they fit, and holds POLLS_ENABLED until
// perf's figures stand inside it; revision 4's figures at the old fetch cap are gone; gate 4 holds the lounge's
// two conditions.
check(
  'the document prints the one sum of each worst run and holds POLLS_ENABLED on it (R8-3)',
  doc.includes(
    `**The worst tally run is then ${atCap.tally} and the worst prune run ${atCap.prune}, inside the step's 50.**`,
  ) &&
    doc.includes(
      '**The one sum (revision 5, with revision 8 of docs/contracts/phase-6-holders.md, R8-2 and R8-3, PT-FETCH-1).**',
    ) &&
    doc.includes('`POLLS_ENABLED` stays "false" until perf\'s figures') &&
    !doc.includes('at the fetch cap, at most |') &&
    !doc.includes('and the endpoints answer, at most |'),
  true,
);
check(
  "gate 4 holds the lounge's two conditions (R4, HB1F-SEC-3), and the document is at revision 5",
  doc.includes('**Before `HOLDERS_LOUNGE` is "on" (revision 4,') &&
    doc.includes('compares `allowed_updates` with `TELEGRAM_ALLOWED_UPDATES`, not only the url') &&
    doc.includes('## 14. Revision 4') &&
    doc.includes('## 15. Revision 5') &&
    doc.startsWith("# Phase 6.8: the holders' second wave (contract, revision 5)"),
  true,
);
check(
  "section 8 books the worst idle poll_tally run at POLL_TALLY_IDLE_STATEMENTS_MAX in the sweep's sum, 48 of 50, in place of revision 5f's sentence, and the header names revisions 5f and 5g (R8F-SEC-2)",
  doc.includes(
    "and when it answers `idle` from a `waiting` tally (phase-6-holders.md section 5 step 2, revision 8e F3) at `POLL_TALLY_IDLE_STATEMENTS_MAX` (10), the worst idle run once a `waiting` answer falls through (revision 8f, R8E-SEC-3) and the purge's empty tries and `castCounts` follow it, which the sweep's sum books in place of two: 48 of 50",
  ) &&
    !doc.includes(
      "at `POLL_TALLY_WAITING_STATEMENTS` (the job's results read, the skip gate, the tally's results read, the configuration's read and the first `listVoters` page: 5), which the sweep's sum books in place of two",
    ) &&
    doc.includes('**Revision 5g (with revision 8g of phase-6-holders.md, H3: R8F-SEC-2, PF5-SEC-3, F8F-B3 (iii))') &&
    doc.includes('revision 5f on 2026-10-17, with revision 8f of docs/contracts/phase-6-holders.md') &&
    doc.includes('revision 5g on 2026-10-17, with revision 8g of docs/contracts/phase-6-holders.md'),
  true,
);

console.log(failures === 0 ? 'ALL OK' : `${failures} FAILED`);
runtime?.exit(failures === 0 ? 0 : 1);
