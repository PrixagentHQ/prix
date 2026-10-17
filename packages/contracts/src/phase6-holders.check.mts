// The operator's check of the holders contract (phase6-holders.ts, docs/contracts/phase-6-holders.md), revision 8.
// It computes every figure of the document's section 9 from the constants and fails when the document's table
// prints a value it did not compute; it pins the perks to the rules that grant them, the polls' windows and
// options, the vote's refusals, the tally's bounds, `ownerHoldsOf`, the league post's window and caption on the
// production board of 2026-10-15, and every word of HOLDERS_COPY against the words this round never says.
// One line a case; exit 1 on any surprise.
// Usage: node --experimental-strip-types --no-warnings packages/contracts/src/phase6-holders.check.mts

import { API_WRITE_ROWS_PER_DAY } from './constants.ts';
import { entitlementsOfTier, TIER_RULES, type Tier } from './entitlements.ts';
import {
  containsAdviceWord,
  TELEGRAM_LINKED_REPLY_TEMPLATE,
  type TelegramPort,
  telegramLinkedReply,
} from './phase3-follow.ts';
import {
  HOLDER_BADGE_MIN_TIER,
  HOLDER_CHAT_MIN_TOKENS,
  HOLDER_PERK_KEYS,
  HOLDER_PERKS,
  HOLDER_PERKS_HIDDEN,
  HOLDER_POLLS,
  HOLDER_TEMPLATES_MIN_TIER,
  HOLDER_TIER_TOKENS,
  HOLDERS_COPY,
  HOLDERS_FORBIDDEN_WORDS,
  HOLDERS_PRIVACY_SENTENCE,
  HOLDERS_VERIFIED_BADGE_KEY,
  holderPerksShown,
  holdersBadgeValueShown,
  LEAGUE_POST_DISCLAIMER,
  LEAGUE_POST_FAILURE_REASONS,
  LEAGUE_POST_FIRST_MINUTE,
  LEAGUE_POST_LAST_MINUTE,
  LEAGUE_POST_OTHER_NAME,
  LEAGUE_POST_PLACES,
  leaguePostCaption,
  leaguePostDue,
  leaguePostNameOf,
  leaguePostRoundOf,
  OWNER_HOLDS_MIN_TIER,
  OWNER_HOLDS_WRITE_ROWS,
  openPollAt,
  ownerHoldsOf,
  ownerHoldsRouteOn,
  ownerHoldsSettingSchema,
  POLL_CLOSE_MOVE_HOURS,
  POLL_MAX_VOTERS,
  POLL_MAX_VOTERS_FLOOR,
  POLL_MIN_TIER,
  POLL_PRUNE_AT,
  POLL_PRUNE_EVERY_SECONDS,
  POLL_PRUNE_MAX_COUNT_ROWS_PER_DAY,
  POLL_PRUNE_MAX_VOTE_ROWS_PER_DAY,
  POLL_PRUNE_RUN_STATEMENTS_BEHIND_WAITING_MAX,
  POLL_PRUNE_RUN_STATEMENTS_MAX,
  POLL_PURGE_MAX_POLLS,
  POLL_PURGE_PER_RUN,
  POLL_READ_CACHE_SECONDS,
  POLL_REFUSALS,
  POLL_RUNBOOK_STATES,
  POLL_TALLY_ANSWER_MAX_BYTES,
  POLL_TALLY_BLOCK_MARGIN,
  POLL_TALLY_CHAIN_BLOCKS_PER_SECOND,
  POLL_TALLY_DELAY_LABEL,
  POLL_TALLY_DELAY_MODULO_SECONDS,
  POLL_TALLY_FAIL_STEPS,
  POLL_TALLY_FAILED_ERROR,
  POLL_TALLY_FETCH_LATENCY_MS,
  POLL_TALLY_FETCH_TIMEOUT_MS,
  POLL_TALLY_IDLE_STATEMENTS_MAX,
  POLL_TALLY_JOB_OFF_WHAT,
  POLL_TALLY_JOB_OUTCOMES,
  POLL_TALLY_JOB_VARIABLE,
  POLL_TALLY_KEYLESS_STATE_BLOCKS,
  POLL_TALLY_LOOKBACK_DAYS,
  POLL_TALLY_MAX_CHAIN_READS,
  POLL_TALLY_MAX_FETCHES,
  POLL_TALLY_MAX_PAGES,
  POLL_TALLY_MAX_RUN_SECONDS,
  POLL_TALLY_PAGE,
  POLL_TALLY_QA_NEVER_ANSWERING_LATENCY_MS,
  POLL_TALLY_RUN_CONFIG_READS,
  POLL_TALLY_RUN_CPU_MS,
  POLL_TALLY_RUN_STATEMENTS_BEHIND_WAITING_MAX,
  POLL_TALLY_RUN_STATEMENTS_MAX,
  POLL_TALLY_SETTLE_SECONDS,
  POLL_TALLY_SLOW_ANSWER_MS,
  POLL_TALLY_TAIL_P95_MAX_MS,
  POLL_TALLY_TAIL_READS_MIN,
  POLL_TALLY_WAITING_POLL_STATEMENTS,
  POLL_TALLY_WAITING_STATEMENTS,
  POLL_VOTE_WRITE_ROWS,
  POLL_WATCH_DAYS,
  PRIX_SUPPLY_WHOLE,
  pollById,
  pollCloseMoveDue,
  pollExpiredLogDue,
  pollHolderCountHolds,
  pollIdSchema,
  pollLeaders,
  pollOptionIdSchema,
  pollPruneDue,
  pollPublicStateAt,
  pollRunbookState,
  pollStateAt,
  pollsConfigConsistent,
  pollsToTallyAt,
  pollsWatchedAt,
  pollTallyDelaySeconds,
  pollTallyDueAt,
  pollTallyExpired,
  pollTallyFetchesAt,
  pollTallyJobOn,
  pollTallyLatencyFromMeans,
  pollTallyNearestRank,
  pollTallyOutcomeSchema,
  pollTallySlowAnswerMarks,
  pollTallyStepAnswer,
  pollTallyTailHolds,
  pollTallyWorstReadMs,
  pollVoteBodySchema,
  pollWalletExcluded,
  SOCIAL_STEP_CPU_MS,
  TELEGRAM_WEBHOOK_MOVED_CURSOR,
  TELEGRAM_WEBHOOK_URL,
  telegramWebhookAdminResponseSchema,
  telegramWebhookStateSchema,
  wholeTokensAtPpm,
} from './phase6-holders.ts';
import { TELEGRAM_ALLOWED_UPDATES, type TelegramUpdateKind } from './phase6-holders2.ts';
import { ROOM_WRITE_MIN_TOKENS } from './phase6-room.ts';
import {
  isSocialSafeText,
  MANAGER_SLOTS_BY_TIER,
  SOCIAL_JOB_MAX_STATEMENTS,
  socialJobNameSchema,
} from './phase6-social.ts';
import { idSchema } from './primitives.ts';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures += 1;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
}
const fmt = (n: number): string => n.toLocaleString('en-US');
const at = (iso: string): Date => new Date(iso);
const tiers: readonly Tier[] = [0, 1, 2, 3];

// --- A. the amounts and the perks -------------------------------------------------------------------------------

check('10 ppm is 10,000 whole tokens', wholeTokensAtPpm(10) === 10_000);
check('100 ppm is 100,000 whole tokens', wholeTokensAtPpm(100) === 100_000);
check('1,000 ppm is 1,000,000 whole tokens', wholeTokensAtPpm(1_000) === 1_000_000);
check('a lowered threshold of 7 ppm is 7,000', wholeTokensAtPpm(7) === 7_000);
check('a share that is no whole number of ppm is 0', wholeTokensAtPpm(1.5) === 0 && wholeTokensAtPpm(-1) === 0);
check(
  'HOLDER_TIER_TOKENS is 10,000, 100,000 and 1,000,000',
  HOLDER_TIER_TOKENS.join(',') === '10000,100000,1000000',
  HOLDER_TIER_TOKENS.join(','),
);
check(
  'every perk key is listed once, in the page order',
  HOLDER_PERKS.map((p) => p.key).join(',') === HOLDER_PERK_KEYS.join(','),
);
const perk = (key: string) => HOLDER_PERKS.find((p) => p.key === key);
const byTier = (key: string): string => {
  const found = perk(key);
  return found?.kind === 'byTier' ? found.byTier.join(',') : 'none';
};
check(
  'agents are 1, 3, 10, 25 and equal TIER_RULES',
  byTier('agents') === '1,3,10,25' && byTier('agents') === tiers.map((t) => entitlementsOfTier(t).maxAgents).join(','),
);
check(
  'data API calls are 50, 500, 2,000, 5,000 and equal TIER_RULES',
  byTier('apiCalls') === '50,500,2000,5000' && byTier('apiCalls') === TIER_RULES.map((r) => r.apiDailyQuota).join(','),
);
check(
  'paper-manager slots are 1, 2, 3, 5 and equal MANAGER_SLOTS_BY_TIER',
  byTier('managers') === '1,2,3,5' && byTier('managers') === tiers.map((t) => MANAGER_SLOTS_BY_TIER[t]).join(','),
);
const realtime = perk('realtime');
check(
  'fills and reasons without the delay from tier 1, as the tier rules give them',
  realtime?.kind === 'fromTier' &&
    realtime.fromTier === 1 &&
    entitlementsOfTier(0).feedDelaySeconds > 0 &&
    entitlementsOfTier(1).feedDelaySeconds === 0,
);
const badge = perk('badge');
const firstBadgeRule = TIER_RULES.find((rule) => rule.verifiedBadge);
check(
  'the badge row from the first tier whose rule has verifiedBadge, which is 2, right after realtime (D1)',
  badge?.kind === 'fromTier' &&
    badge.fromTier === firstBadgeRule?.tier &&
    HOLDER_BADGE_MIN_TIER === firstBadgeRule.tier &&
    HOLDER_BADGE_MIN_TIER === 2 &&
    tiers.every((t) => t >= HOLDER_BADGE_MIN_TIER === entitlementsOfTier(t).verifiedBadge) &&
    HOLDER_PERK_KEYS.indexOf('badge') === HOLDER_PERK_KEYS.indexOf('realtime') + 1,
  `fromTier ${badge?.kind === 'fromTier' ? badge.fromTier : 'none'}`,
);
const notes = perk('notes');
check('decision notes from tier 1', notes?.kind === 'fromTier' && notes.fromTier === 1);
check(
  "the chat and its pictures from 1 whole token, the room's own rule",
  HOLDER_CHAT_MIN_TOKENS === ROOM_WRITE_MIN_TOKENS &&
    ['chat', 'pictures'].every((key) => {
      const p = perk(key);
      return p?.kind === 'fromTokens' && p.fromTokens === 1;
    }),
);
check("FOREHEAD's amounts are the editor's facts, never the contract's", perk('forehead')?.kind === 'external');
const holdsPerk = perk('ownerHolds');
check(
  '"Owner holds $PRIX" from tier 2, which is 100,000',
  holdsPerk?.kind === 'fromTier' &&
    holdsPerk.fromTier === 2 &&
    OWNER_HOLDS_MIN_TIER === 2 &&
    wholeTokensAtPpm(TIER_RULES[2]?.thresholdPpm ?? 0) === 100_000,
);
check('no perk names Prix Live', !HOLDER_PERK_KEYS.some((key) => /live/i.test(key)));
const templatesPerk = perk('templates');
check(
  "the Build page's holder templates from tier 1, the tier the Build page reads (HB3-6)",
  templatesPerk?.kind === 'fromTier' &&
    templatesPerk.fromTier === HOLDER_TEMPLATES_MIN_TIER &&
    HOLDER_TEMPLATES_MIN_TIER === 1 &&
    HOLDER_PERK_KEYS.indexOf('templates') === HOLDER_PERK_KEYS.indexOf('managers') + 1,
);
check(
  'the notes row is hidden until push is seen on production (H-SEC-9)',
  HOLDER_PERKS_HIDDEN.join(',') === 'notes' &&
    holderPerksShown(true, true)
      .map((p) => p.key)
      .join(',') === 'agents,realtime,badge,apiCalls,managers,templates,chat,pictures,forehead,ownerHolds',
);
check(
  'pictures off hides the pictures row (H2-SEC-10)',
  holderPerksShown(false, true)
    .map((p) => p.key)
    .join(',') === 'agents,realtime,badge,apiCalls,managers,templates,chat,forehead,ownerHolds',
);
check(
  'the owner-holds route at 404 hides the ownerHolds row (H3-SEC-1)',
  holderPerksShown(true, false)
    .map((p) => p.key)
    .join(',') === 'agents,realtime,badge,apiCalls,managers,templates,chat,pictures,forehead',
);
check(
  'the owner-holds route is there at 200 or 401 only (H3-SEC-1)',
  ownerHoldsRouteOn(200) &&
    ownerHoldsRouteOn(401) &&
    !ownerHoldsRouteOn(404) &&
    !ownerHoldsRouteOn(500) &&
    !ownerHoldsRouteOn(null),
);
check(
  'the badge value shows its first sentence alone while the route is not there (H3-SEC-1)',
  holdersBadgeValueShown(false) === 'A listed on-chain agent keeps its badge as before.' &&
    holdersBadgeValueShown(true) === HOLDERS_COPY['token.holdersBadgeValue'],
  holdersBadgeValueShown(false),
);

// --- B. ownerHoldsOf ------------------------------------------------------------------------------------------------

check('tier 2 with gating on and the mark turned on holds', ownerHoldsOf({ gatingOn: true, tier: 2 }, false, true));
check('tier 3 with gating on and the mark turned on holds', ownerHoldsOf({ gatingOn: true, tier: 3 }, false, true));
check('tier 3 with the mark off does not (H-SEC-8)', !ownerHoldsOf({ gatingOn: true, tier: 3 }, false, false));
check('tier 1 does not', !ownerHoldsOf({ gatingOn: true, tier: 1 }, false, true));
check('tier 0 does not', !ownerHoldsOf({ gatingOn: true, tier: 0 }, false, true));
check('gating off never holds', !ownerHoldsOf({ gatingOn: false, tier: 3 }, false, true));
check('a house agent never holds', !ownerHoldsOf({ gatingOn: true, tier: 3 }, true, true));
check(
  'the mark setting takes { show } and nothing more',
  ownerHoldsSettingSchema.safeParse({ show: true }).success &&
    !ownerHoldsSettingSchema.safeParse({ show: 'yes' }).success &&
    !ownerHoldsSettingSchema.safeParse({ show: true, wallet: '0x1' }).success,
);
check('a change of the mark books one row', OWNER_HOLDS_WRITE_ROWS === 1);

// --- C. the polls -----------------------------------------------------------------------------------------------------

const first = HOLDER_POLLS[0];
check('the first poll exists', first !== undefined);
if (first !== undefined) {
  check('its id passes pollIdSchema', pollIdSchema.safeParse(first.id).success, first.id);
  check("its question is the operator's", first.question === 'Which strategy should Model War 2 run?');
  check('it has four options', first.options.length === 4);
  check(
    'every option id passes pollOptionIdSchema and is unique',
    first.options.every((o) => pollOptionIdSchema.safeParse(o.id).success) &&
      new Set(first.options.map((o) => o.id)).size === first.options.length,
  );
  check(
    'every option names an agent id',
    first.options.every((o) => idSchema.safeParse(o.agentId).success),
  );
  check(
    'the four options are Big Tech Equal, Index Core, Momentum Five and Dip Buyer',
    first.options.map((o) => o.name).join('|') === 'Big Tech Equal|Index Core|Momentum Five|Dip Buyer',
  );
  check('it closes 2026-10-21 at 20:00 UTC', first.closesAt === '2026-10-21T20:00:00.000Z');
  // Revision 8g (F8F-B2): a move of the close past 2026-10-22 replaces this rule, in the move's own edit, with the
  // rule that the poll closes before Model War 2's start, which the operator names and tells the founder with the new date.
  check(
    'it closes before Model War 1 ends on 2026-10-22',
    Date.parse(first.closesAt) < Date.parse('2026-10-22T00:00:00.000Z'),
  );
  check('upcoming before it opens', pollStateAt(first, at('2026-10-15T23:59:59.999Z')) === 'upcoming');
  check('open at its first instant', pollStateAt(first, at(first.opensAt)) === 'open');
  check('open one millisecond before the close', pollStateAt(first, at('2026-10-21T19:59:59.999Z')) === 'open');
  check('closed at the close itself', pollStateAt(first, at(first.closesAt)) === 'closed');
  check('openPollAt finds it on 2026-10-17', openPollAt(at('2026-10-17T12:00:00.000Z'))?.id === first.id);
  check('openPollAt finds none after the close', openPollAt(at('2026-10-21T20:00:00.000Z')) === null);
  check('pollById finds it and refuses another id', pollById(first.id) === first && pollById('model-war-3') === null);
  check('nothing to tally before the close', pollsToTallyAt(at('2026-10-21T19:59:59.999Z')).length === 0);
  check('nothing to tally in the minute after the close', pollsToTallyAt(at('2026-10-21T20:00:59.999Z')).length === 0);
  check(
    'the poll to tally a minute after the close',
    pollsToTallyAt(at('2026-10-21T20:01:00.000Z'))[0]?.id === first.id,
  );
  check('still to tally 6 days later', pollsToTallyAt(at('2026-10-27T19:59:59.999Z')).length === 1);
  check('no longer after 7 days', pollsToTallyAt(at('2026-10-28T20:00:00.000Z')).length === 0);
  check('leaders: one', pollLeaders(first, { 'big-tech-equal': 3, 'index-core': 5 }).join(',') === 'index-core');
  check(
    "leaders: a tie in the poll's order",
    pollLeaders(first, { 'dip-buyer': 2, 'big-tech-equal': 2, 'index-core': 1 }).join(',') ===
      'big-tech-equal,dip-buyer',
  );
  check(
    'leaders: none counted is none',
    pollLeaders(first, { 'index-core': 0 }).length === 0 && pollLeaders(first, {}).length === 0,
  );
  check(
    'an option name passes the social words',
    first.options.every((o) => isSocialSafeText(o.name)),
  );
}
let overlap = false;
for (let i = 0; i < HOLDER_POLLS.length; i += 1) {
  const poll = HOLDER_POLLS[i];
  if (poll === undefined) continue;
  if (!(Date.parse(poll.opensAt) < Date.parse(poll.closesAt))) overlap = true;
  for (let j = i + 1; j < HOLDER_POLLS.length; j += 1) {
    const other = HOLDER_POLLS[j];
    if (
      other !== undefined &&
      Date.parse(poll.opensAt) < Date.parse(other.closesAt) &&
      Date.parse(other.opensAt) < Date.parse(poll.closesAt)
    )
      overlap = true;
  }
}
check('no two polls are open at once, and each opens before it closes', !overlap);
check('poll ids are unique', new Set(HOLDER_POLLS.map((p) => p.id)).size === HOLDER_POLLS.length);
check('the vote body takes an option', pollVoteBodySchema.safeParse({ option: 'index-core' }).success);
check(
  'the vote body refuses a field more',
  !pollVoteBodySchema.safeParse({ option: 'index-core', wallet: '0x1' }).success,
);
check(
  'the vote body refuses an option with upper case or a space',
  !pollVoteBodySchema.safeParse({ option: 'Index Core' }).success,
);
check('the vote body refuses no option', !pollVoteBodySchema.safeParse({}).success);
check(
  'the refusals and their statuses',
  JSON.stringify(POLL_REFUSALS) ===
    '{"poll_unknown_option":400,"poll_not_open":409,"poll_closed":409,"poll_gate_off":403,"poll_not_holder":403,"poll_full":409}',
);
check('a vote needs tier 1', POLL_MIN_TIER === 1);
check('the tally reads every voter in one run', POLL_TALLY_PAGE * (POLL_TALLY_MAX_PAGES - 1) >= POLL_MAX_VOTERS);
check(
  'the cap is a guard of 1,600, read in 4 calls of 400 after one at the head (H-SEC-1, H2-SEC-5, R8-3, R8B-1, CR8B-1)',
  POLL_MAX_VOTERS === 1_600 && POLL_TALLY_PAGE === 400 && POLL_TALLY_MAX_CHAIN_READS === 5,
  `${POLL_MAX_VOTERS}, ${POLL_TALLY_MAX_CHAIN_READS} reads`,
);
check(
  'the prune runs from 1,200 votes, one page under the cap, at most once an hour (H2-SEC-1, R8-3, R8B-1, CR8B-1)',
  POLL_PRUNE_AT === POLL_MAX_VOTERS - POLL_TALLY_PAGE &&
    POLL_PRUNE_AT === 1_200 &&
    POLL_PRUNE_EVERY_SECONDS === 3_600 &&
    POLL_PRUNE_AT < POLL_MAX_VOTERS,
  String(POLL_PRUNE_AT),
);
check(
  'the prune is due only in the first five minutes of an hour',
  pollPruneDue(at('2026-10-17T13:03:10.000Z')) &&
    !pollPruneDue(at('2026-10-17T13:08:10.000Z')) &&
    !pollPruneDue(at('2026-10-17T13:58:10.000Z')),
);
check('the run reads 50 blocks behind the first head (H2-SEC-5, HB3-5, C1)', POLL_TALLY_BLOCK_MARGIN === 50);
// Revision 8c (CR8B-1, C1): the run's seconds come from publicnode's state window of about 100 blocks and the
// chain's 10 blocks a second, so that the pinned block, POLL_TALLY_BLOCK_MARGIN behind the first head, is still
// served at the run's last read.
check(
  "the run's seconds are the keyless window less the margin, at the chain's blocks a second: 5 (CR8B-1)",
  POLL_TALLY_KEYLESS_STATE_BLOCKS === 100 &&
    POLL_TALLY_CHAIN_BLOCKS_PER_SECOND === 10 &&
    POLL_TALLY_MAX_RUN_SECONDS ===
      Math.floor((POLL_TALLY_KEYLESS_STATE_BLOCKS - POLL_TALLY_BLOCK_MARGIN) / POLL_TALLY_CHAIN_BLOCKS_PER_SECOND) &&
    POLL_TALLY_MAX_RUN_SECONDS === 5 &&
    POLL_TALLY_BLOCK_MARGIN + POLL_TALLY_MAX_RUN_SECONDS * POLL_TALLY_CHAIN_BLOCKS_PER_SECOND <=
      POLL_TALLY_KEYLESS_STATE_BLOCKS,
  `${POLL_TALLY_MAX_RUN_SECONDS} s`,
);
{
  const closes = Date.parse('2026-10-21T20:00:00.000Z');
  const d = pollTallyDelaySeconds(new Uint8Array([0x12, 0x34, 0xff]));
  check(
    "the tally's delay is the HMAC's first two bytes modulo 3,600 (H3-SEC-3)",
    d === 0x1234 % 3_600 &&
      pollTallyDelaySeconds(new Uint8Array([0xff, 0xff])) === 65_535 % 3_600 &&
      POLL_TALLY_DELAY_MODULO_SECONDS === 3_600 &&
      POLL_TALLY_DELAY_LABEL === 'poll-tally',
    `${d}`,
  );
  const poll = { closesAt: new Date(closes).toISOString() };
  check(
    'a poll is tallied no earlier than the close + 60 s + d (H3-SEC-3)',
    !pollTallyDueAt(poll, new Date(closes + (60 + d) * 1000 - 1), d) &&
      pollTallyDueAt(poll, new Date(closes + (60 + d) * 1000), d) &&
      pollTallyDueAt(poll, new Date(closes + 60_000), 0),
  );
  let threw = false;
  try {
    pollTallyDelaySeconds(new Uint8Array([1]));
  } catch {
    threw = true;
  }
  check('a delay from fewer than two bytes throws', threw);
}
check(
  'the prune writes at most 13,333 vote rows and 96 count rows a day (H3-SEC-5)',
  POLL_PRUNE_MAX_VOTE_ROWS_PER_DAY === Math.floor(API_WRITE_ROWS_PER_DAY / POLL_VOTE_WRITE_ROWS) &&
    POLL_PRUNE_MAX_VOTE_ROWS_PER_DAY === 13_333 &&
    POLL_PRUNE_MAX_COUNT_ROWS_PER_DAY === 96 &&
    (first?.options.length ?? 0) * 24 === POLL_PRUNE_MAX_COUNT_ROWS_PER_DAY,
);
check(
  "the webhook's watch: its cursor and its admin read (H3-SEC-8)",
  TELEGRAM_WEBHOOK_MOVED_CURSOR === 'telegram:webhook_moved' &&
    telegramWebhookStateSchema.safeParse({ moved: false, movedAt: null }).success &&
    telegramWebhookStateSchema.safeParse({ moved: true, movedAt: '2026-10-16T13:13:00.000Z' }).success &&
    !telegramWebhookStateSchema.safeParse({ moved: true, movedAt: null, url: 'https://x' }).success,
);
// Revision 8 (R8-2): with one endpoint down every read costs at most two fetches after the one that found it
// down, and the cap is that figure, above two a chain read.
const oneDownFetches = 2 * POLL_TALLY_MAX_CHAIN_READS + 1;
check(
  "the tally's fetches are capped at two a chain read and one more, the one-endpoint-down figure (H2-SEC-4, R8-2, R8-3)",
  POLL_TALLY_MAX_FETCHES === oneDownFetches &&
    POLL_TALLY_MAX_FETCHES === 11 &&
    POLL_TALLY_MAX_FETCHES === pollTallyFetchesAt(POLL_MAX_VOTERS) &&
    2 * POLL_TALLY_MAX_CHAIN_READS <= POLL_TALLY_MAX_FETCHES,
  String(POLL_TALLY_MAX_FETCHES),
);
check(
  "the tally's CPU: a run at most 500 ms inside the step's 1,000 ms, Prix's own ceilings (R8-1, R8-SEC-1)",
  POLL_TALLY_RUN_CPU_MS === 500 && SOCIAL_STEP_CPU_MS === 1_000 && POLL_TALLY_RUN_CPU_MS < SOCIAL_STEP_CPU_MS,
);
// Revision 8b (R8-SEC-1): POLL_TALLY_JOB keeps the job in the step, off unless exactly "on".
check(
  'POLL_TALLY_JOB is off unless exactly "on" (R8-SEC-1)',
  POLL_TALLY_JOB_VARIABLE === 'POLL_TALLY_JOB' &&
    pollTallyJobOn('on') &&
    !pollTallyJobOn('off') &&
    !pollTallyJobOn('On') &&
    !pollTallyJobOn(' on') &&
    !pollTallyJobOn('true') &&
    !pollTallyJobOn(undefined),
);
// Revision 8c (CR8B-3): off, the step logs step_not_configured with what poll_tally_job_off.
check(
  'POLL_TALLY_JOB off is logged with what poll_tally_job_off (CR8B-3)',
  POLL_TALLY_JOB_OFF_WHAT === 'poll_tally_job_off',
);
// Revision 8c (R8C-1): POLLS_ENABLED "true" needs POLL_TALLY_JOB "on"; the other three states of the runbook hold.
check(
  'the config refuses POLLS_ENABLED "true" without POLL_TALLY_JOB "on", and holds the three other states (R8C-1, CR8B-3)',
  pollsConfigConsistent('false', 'on') &&
    pollsConfigConsistent('false', 'off') &&
    pollsConfigConsistent('false', undefined) &&
    pollsConfigConsistent('true', 'on') &&
    !pollsConfigConsistent('true', 'off') &&
    !pollsConfigConsistent('true', undefined) &&
    !pollsConfigConsistent('true', 'On'),
);
// Revision 8b (R8-SEC-3, R8B-5): the meter's own timeout, and the worst run's wall time on perf's fake chain with
// one endpoint never answering: the timeout once, then every other fetch at the set latency.
const worstReadMs = POLL_TALLY_FETCH_TIMEOUT_MS + (POLL_TALLY_MAX_FETCHES - 1) * POLL_TALLY_FETCH_LATENCY_MS;
// Revision 8c (CR8B-1): the 429 case too, every fetch answered at the set latency.
const rateLimitedReadMs = POLL_TALLY_MAX_FETCHES * POLL_TALLY_FETCH_LATENCY_MS;
check(
  "the worst run's reads with one endpoint never answering stay inside the run's seconds (R8-SEC-3, R8B-5, CR8B-1)",
  POLL_TALLY_FETCH_TIMEOUT_MS === 1_500 &&
    POLL_TALLY_FETCH_LATENCY_MS === 300 &&
    worstReadMs === pollTallyWorstReadMs(POLL_MAX_VOTERS).neverAnswering &&
    worstReadMs <= POLL_TALLY_MAX_RUN_SECONDS * 1_000,
  `${worstReadMs} ms of ${POLL_TALLY_MAX_RUN_SECONDS * 1_000}`,
);
check(
  "the worst run's reads in the 429 case stay inside the run's seconds (CR8B-1)",
  rateLimitedReadMs === pollTallyWorstReadMs(POLL_MAX_VOTERS).rateLimited &&
    rateLimitedReadMs <= POLL_TALLY_MAX_RUN_SECONDS * 1_000,
  `${rateLimitedReadMs} ms of ${POLL_TALLY_MAX_RUN_SECONDS * 1_000}`,
);
check(
  "revision 8b's 3,200 voters would pass the run's seconds in both cases (CR8B-1)",
  pollTallyWorstReadMs(3_200).rateLimited === 5_700 &&
    pollTallyWorstReadMs(3_200).neverAnswering === 6_900 &&
    pollTallyWorstReadMs(3_200).rateLimited > POLL_TALLY_MAX_RUN_SECONDS * 1_000,
);
// Revision 8c (C2, CR8B-7): gate 3's slow tail.
check(
  'gate 3 reads at least 20 full pages of each endpoint, and a 95th percentile above 1,000 ms holds the switch (C2)',
  POLL_TALLY_TAIL_READS_MIN === 20 &&
    POLL_TALLY_TAIL_P95_MAX_MS === 1_000 &&
    POLL_TALLY_TAIL_P95_MAX_MS <= (2 * POLL_TALLY_FETCH_TIMEOUT_MS) / 3 &&
    !pollTallyTailHolds(1_000, 1_200) &&
    pollTallyTailHolds(1_001, 1_200) &&
    pollTallyTailHolds(Number.NaN, 1_200) &&
    !pollTallyTailHolds(400, 600),
);
// Revision 8d (D3, CR8C-3, R8C-SEC-2): the largest read too, at or above the timeout, holds the switch.
check(
  'a largest read at or above the timeout holds the switch whatever the 95th percentile (D3, CR8C-3)',
  pollTallyTailHolds(900, 1_500) &&
    !pollTallyTailHolds(900, 1_499) &&
    pollTallyTailHolds(900, POLL_TALLY_FETCH_TIMEOUT_MS) &&
    pollTallyTailHolds(900, Number.NaN),
);
check(
  'the 95th percentile is the nearest rank: of 20 reads the 19th, so the largest is bounded apart (D3, CR8C-3)',
  pollTallyNearestRank(
    Array.from({ length: 20 }, (_, i) => (i + 1) * 10),
    95,
  ) === 190 &&
    pollTallyNearestRank([300], 95) === 300 &&
    Number.isNaN(pollTallyNearestRank([], 95)) &&
    pollTallyNearestRank([5, 1, 3, 2, 4], 100) === 5 &&
    !pollTallyTailHolds(pollTallyNearestRank([...Array.from({ length: 19 }, () => 400), 1_499], 95), 1_499) &&
    pollTallyTailHolds(pollTallyNearestRank([...Array.from({ length: 19 }, () => 400), 1_600], 95), 1_600),
);
// Revision 8d (D4, R8C-SEC-3): an answer later than 750 ms marks its endpoint; without the mark, an endpoint that
// answers every read just under the timeout passes the run's seconds alone.
check(
  'an answer taken alone later than POLL_TALLY_SLOW_ANSWER_MS marks its endpoint (D4, R8C-SEC-3)',
  POLL_TALLY_SLOW_ANSWER_MS === 750 &&
    !pollTallySlowAnswerMarks(750, true) &&
    pollTallySlowAnswerMarks(751, true) &&
    pollTallySlowAnswerMarks(1_400, true) &&
    pollTallySlowAnswerMarks(Number.NaN, true) &&
    !pollTallySlowAnswerMarks(300, true),
);
// Revision 8e (F1, R8D-SEC-1, CR8D-1): a third party's answer is never marked for its time alone.
check(
  "a third party's slow answer marks nothing; one taken alone does (F1, R8D-SEC-1, CR8D-1)",
  !pollTallySlowAnswerMarks(800, false) &&
    pollTallySlowAnswerMarks(800, true) &&
    !pollTallySlowAnswerMarks(750, true) &&
    !pollTallySlowAnswerMarks(1_499, false) &&
    !pollTallySlowAnswerMarks(Number.NaN, false),
);
check(
  "the third party's slow tail fits the run's seconds at the cap: 4,500 of 5,000 (F1, CR8D-1)",
  pollTallyWorstReadMs(POLL_MAX_VOTERS).thirdPartyTail ===
    POLL_TALLY_MAX_FETCHES * POLL_TALLY_FETCH_LATENCY_MS +
      (POLL_TALLY_FETCH_TIMEOUT_MS - POLL_TALLY_FETCH_LATENCY_MS) &&
    pollTallyWorstReadMs(POLL_MAX_VOTERS).thirdPartyTail === 4_500 &&
    pollTallyWorstReadMs(POLL_MAX_VOTERS).thirdPartyTail <= POLL_TALLY_MAX_RUN_SECONDS * 1_000,
  `${pollTallyWorstReadMs(POLL_MAX_VOTERS).thirdPartyTail} ms of ${POLL_TALLY_MAX_RUN_SECONDS * 1_000}`,
);
// Revision 8e (CR8D-4, R8D-SEC-3): the larger of the two means, rounded up to the next 10 ms.
check(
  'the latency the revision writes is the larger of the two means, rounded up to 10 ms (CR8D-4, R8D-SEC-3)',
  pollTallyLatencyFromMeans(412, 388) === 420 &&
    pollTallyLatencyFromMeans(388, 412) === 420 &&
    pollTallyLatencyFromMeans(300, 300) === 300 &&
    pollTallyLatencyFromMeans(300.5, 120) === 310 &&
    Number.isNaN(pollTallyLatencyFromMeans(Number.NaN, 300)) &&
    Number.isNaN(pollTallyLatencyFromMeans(300, 0)),
);
check(
  'unmarked, five answers just under the timeout pass the run seconds; marked, the slow case fits (D4, R8C-SEC-3)',
  POLL_TALLY_MAX_CHAIN_READS * (POLL_TALLY_FETCH_TIMEOUT_MS - 1) > POLL_TALLY_MAX_RUN_SECONDS * 1_000 &&
    pollTallyWorstReadMs(POLL_MAX_VOTERS).slowAnswering ===
      POLL_TALLY_FETCH_TIMEOUT_MS + 2 * (POLL_TALLY_MAX_CHAIN_READS - 1) * POLL_TALLY_FETCH_LATENCY_MS &&
    pollTallyWorstReadMs(POLL_MAX_VOTERS).slowAnswering <= POLL_TALLY_MAX_RUN_SECONDS * 1_000,
  `${pollTallyWorstReadMs(POLL_MAX_VOTERS).slowAnswering} ms of ${POLL_TALLY_MAX_RUN_SECONDS * 1_000}`,
);
// Revision 8d (D5, R8C-SEC-5): the floor of the cap, and the tier-1 count read before the switch.
check(
  'the cap never settles below 1,200, and fewer than 800 tier-1 wallets let the switch go on (D5, R8C-SEC-5)',
  POLL_MAX_VOTERS_FLOOR === 1_200 &&
    POLL_MAX_VOTERS >= POLL_MAX_VOTERS_FLOOR &&
    !pollHolderCountHolds(0) &&
    !pollHolderCountHolds(799) &&
    pollHolderCountHolds(800) &&
    pollHolderCountHolds(Number.NaN) &&
    pollHolderCountHolds(-1) &&
    pollHolderCountHolds(10.5),
);
// Revision 8d (D1, CR8C-1): the runbook's three states, exactly, and never ("true", "off").
check(
  'the runbook has exactly three states, each consistent, and ("true", "off") is none of them (D1, CR8C-1)',
  POLL_RUNBOOK_STATES.length === 3 &&
    pollRunbookState('false', 'on') &&
    pollRunbookState('true', 'on') &&
    pollRunbookState('false', 'off') &&
    !pollRunbookState('true', 'off') &&
    !pollRunbookState('false', undefined) &&
    !pollRunbookState(undefined, 'on') &&
    !pollRunbookState('True', 'on') &&
    POLL_RUNBOOK_STATES.every(([polls, job]) => pollsConfigConsistent(polls, job)),
);
// Revision 8d (D2, R8C-SEC-1): 48 hours before the close with POLLS_ENABLED not "true", the close moves.
{
  const first = HOLDER_POLLS[0];
  check(
    'the first poll moves its close from 2026-10-19 20:00 UTC while POLLS_ENABLED is not "true" (D2, R8C-SEC-1)',
    first !== undefined &&
      POLL_CLOSE_MOVE_HOURS === 48 &&
      first.closesAt === '2026-10-21T20:00:00.000Z' &&
      !pollCloseMoveDue(first, at('2026-10-19T19:59:59.999Z'), 'false') &&
      pollCloseMoveDue(first, at('2026-10-19T20:00:00.000Z'), 'false') &&
      pollCloseMoveDue(first, at('2026-10-21T19:59:59.999Z'), undefined) &&
      !pollCloseMoveDue(first, at('2026-10-20T12:00:00.000Z'), 'true') &&
      !pollCloseMoveDue(first, at('2026-10-21T20:00:00.000Z'), 'false'),
  );
  // Revision 8e (CR8D-5): the switch is read as it stood at the move's moment; a late switch does not undo the move.
  check(
    'a switch turned on inside the 48 hours does not undo a move that was due (CR8D-5)',
    first !== undefined && pollCloseMoveDue(first, at('2026-10-21T19:00:00.000Z'), 'false'),
  );
}
check(
  'the meter reads at most 256 KiB of an answer, about twice the largest real one (R8-SEC-4)',
  POLL_TALLY_ANSWER_MAX_BYTES === 262_144 && POLL_TALLY_ANSWER_MAX_BYTES >= 2 * 130_000,
);
check('the run reads the token configuration once (R8B-1)', POLL_TALLY_RUN_CONFIG_READS === 1);
// Revision 8 (R8-4): the purge tries at most three counted polls a run, and no POLL_WATCH_DAYS window of the
// polls holds more closes than that, so that no counted poll's votes wait behind emptied ones.
const watchMs = POLL_WATCH_DAYS * 86_400_000;
const closes = HOLDER_POLLS.map((poll) => Date.parse(poll.closesAt)).sort((a, b) => a - b);
const mostClosesInAWindow = closes.reduce(
  (most, start) => Math.max(most, closes.filter((close) => close >= start && close < start + watchMs).length),
  0,
);
check(
  'the purge tries at most 3 counted polls a run, and no 30-day window holds more closes (R8-4)',
  POLL_PURGE_MAX_POLLS === 3 && mostClosesInAWindow <= POLL_PURGE_MAX_POLLS,
  `${mostClosesInAWindow} close(s) in the busiest window`,
);
check(
  "the job's answer for each tally outcome (HB-5)",
  JSON.stringify(POLL_TALLY_JOB_OUTCOMES) ===
    '{"done":"done","already":"idle","open":"idle","waiting":"idle","failed":"throw"}' &&
    POLL_TALLY_FAILED_ERROR === 'PollTallyFailed',
);
check(
  'the linked reply names the wallet and the way out (H2-SEC-7)',
  telegramLinkedReply('0x1234…abcd').includes('wallet 0x1234…abcd. If that is not your wallet, send /stop.') &&
    !telegramLinkedReply('0x1234…abcd').includes('{ownerShort}') &&
    !containsAdviceWord(TELEGRAM_LINKED_REPLY_TEMPLATE),
);
check('the purge deletes at most 100 rows a run (H-SEC-7)', POLL_PURGE_PER_RUN === 100);
check(
  'the job watches a closed poll for 30 days',
  POLL_WATCH_DAYS === 30 && POLL_WATCH_DAYS > POLL_TALLY_LOOKBACK_DAYS,
);
check(
  "Prix's own wallets are excluded, in any case (H-SEC-6)",
  pollWalletExcluded('0xABCdef', ['0xabcdef'], undefined) &&
    pollWalletExcluded('0x1234', [], ['0x1234']) &&
    !pollWalletExcluded('0x9999', ['0xabcdef'], ['0x1234']),
);
check(
  'the fail steps of the tally',
  POLL_TALLY_FAIL_STEPS.join(',') === 'results,list,read,block,write' &&
    pollTallyOutcomeSchema.safeParse({ outcome: 'failed', step: 'block' }).success &&
    !pollTallyOutcomeSchema.safeParse({ outcome: 'failed', step: 'boom' }).success,
);
if (first !== undefined) {
  check('watched a minute after the close', pollsWatchedAt(at('2026-10-21T20:01:00.000Z')).length === 1);
  check('watched 29 days after', pollsWatchedAt(at('2026-11-19T19:59:59.999Z')).length === 1);
  check('not watched after 30 days', pollsWatchedAt(at('2026-11-20T20:00:00.000Z')).length === 0);
  check(
    'expired from 7 days after the close',
    !pollTallyExpired(first, at('2026-10-28T19:59:59.999Z')) && pollTallyExpired(first, at('2026-10-28T20:00:00.000Z')),
  );
  check(
    'the public state moves open, counting, uncounted, closed (H-SEC-4)',
    pollPublicStateAt(first, at('2026-10-15T00:00:00.000Z'), false) === null &&
      pollPublicStateAt(first, at('2026-10-17T00:00:00.000Z'), false) === 'open' &&
      pollPublicStateAt(first, at('2026-10-22T00:00:00.000Z'), false) === 'counting' &&
      pollPublicStateAt(first, at('2026-10-28T20:00:00.000Z'), false) === 'uncounted' &&
      pollPublicStateAt(first, at('2026-10-28T20:00:00.000Z'), true) === 'closed',
  );
}
check(
  'the expired line only in the first run of a UTC day',
  pollExpiredLogDue(at('2026-10-29T00:03:10.000Z')) &&
    !pollExpiredLogDue(at('2026-10-29T00:08:10.000Z')) &&
    !pollExpiredLogDue(at('2026-10-29T12:03:10.000Z')),
);
check(
  'the webhook is the notify route as mounted',
  TELEGRAM_WEBHOOK_URL === 'https://prixagent.com/api/telegram/webhook',
);
check(
  "the webhook route answers getWebhookInfo's three fields and nothing more (H-SEC-2)",
  telegramWebhookAdminResponseSchema.safeParse({
    url: TELEGRAM_WEBHOOK_URL,
    pendingUpdateCount: 0,
    lastErrorMessage: null,
  }).success &&
    !telegramWebhookAdminResponseSchema.safeParse({
      url: TELEGRAM_WEBHOOK_URL,
      pendingUpdateCount: 0,
      lastErrorMessage: null,
      secret: 'x',
    }).success,
);
// The job's results read, the skip gate, tallyPoll's own results read, the pages, the result's 4 rows (HB-4).
// Revision 8b (R8B-1): and the token configuration's read, cold at every social run.
const tallyStatements = 1 + 1 + 1 + POLL_TALLY_RUN_CONFIG_READS + POLL_TALLY_MAX_PAGES + 4;
// One more when the run clears a failure count of the guard (common.ts, putCount when known > 0).
const tallyStatementsWithClear = tallyStatements + 1;
// The prune (H2-SEC-1): the skip gate, castCounts, the pages, pruneVoters' one batch of two statements, the clear.
// Revision 8 (R8-4): ahead of it in the same run, the job's results read and the purge's tries that deleted
// nothing, whenever a counted poll is watched while the open poll is pruned.
const pruneStatementsWithClear =
  1 + 1 + POLL_PURGE_MAX_POLLS + POLL_TALLY_RUN_CONFIG_READS + 1 + POLL_TALLY_MAX_PAGES + 2 + 1;
check(
  'the exported statement bounds equal the computed worst runs (revision 7, R7-2; revision 8, R8-3, R8-4)',
  POLL_TALLY_RUN_STATEMENTS_MAX === tallyStatementsWithClear &&
    POLL_PRUNE_RUN_STATEMENTS_MAX === pruneStatementsWithClear,
  `${POLL_TALLY_RUN_STATEMENTS_MAX}/${tallyStatementsWithClear}, ${POLL_PRUNE_RUN_STATEMENTS_MAX}/${pruneStatementsWithClear}`,
);
check(
  "both worst runs stay within a social job's 25 statements",
  POLL_TALLY_RUN_STATEMENTS_MAX <= SOCIAL_JOB_MAX_STATEMENTS &&
    POLL_PRUNE_RUN_STATEMENTS_MAX <= SOCIAL_JOB_MAX_STATEMENTS,
);
// Revision 7 (R4, HB1F2-SEC-1): a run that reached its reads answers `done` to the step, whatever the guard
// answered; before its reads every answer is kept.
check(
  'a run that reached its reads answers done to the step: idle and failed become done (R7-1)',
  pollTallyStepAnswer('idle', true) === 'done' &&
    pollTallyStepAnswer('failed', true) === 'done' &&
    pollTallyStepAnswer('done', true) === 'done' &&
    pollTallyStepAnswer('more', true) === 'more',
);
check(
  'a run that did not reach its reads keeps its answer (R7-1)',
  (['idle', 'failed', 'done', 'more'] as const).every((answer) => pollTallyStepAnswer(answer, false) === answer),
);
check(
  "the tally's worst run stays inside a social job's statements",
  tallyStatementsWithClear <= SOCIAL_JOB_MAX_STATEMENTS,
  `${tallyStatementsWithClear} <= ${SOCIAL_JOB_MAX_STATEMENTS}`,
);
check(
  "the prune's worst run stays inside a social job's statements",
  pruneStatementsWithClear <= SOCIAL_JOB_MAX_STATEMENTS,
  `${pruneStatementsWithClear} <= ${SOCIAL_JOB_MAX_STATEMENTS}`,
);
check('poll_tally is a social job name', socialJobNameSchema.safeParse('poll_tally').success);

// --- D. the league post -------------------------------------------------------------------------------------------

check('due on Thursday 2026-10-15 at 15:20 UTC', leaguePostDue(at('2026-10-15T15:20:00.000Z'), null));
check('not due at 15:19', !leaguePostDue(at('2026-10-15T15:19:59.999Z'), null));
check('due at 16:59', leaguePostDue(at('2026-10-15T16:59:30.000Z'), null));
check('not due at 17:00', !leaguePostDue(at('2026-10-15T17:00:00.000Z'), null));
check('not due once tried today', !leaguePostDue(at('2026-10-15T15:40:00.000Z'), '2026-10-15'));
check('due the next day after a try', leaguePostDue(at('2026-10-16T15:40:00.000Z'), '2026-10-15'));
check('not due on a Saturday', !leaguePostDue(at('2026-10-17T15:30:00.000Z'), null));
check('not due on a Sunday', !leaguePostDue(at('2026-10-18T15:30:00.000Z'), null));
check('the round of the day', leaguePostRoundOf(at('2026-10-15T15:20:00.000Z')) === '2026-10-15T15:00Z');
check(
  'the failure reasons of the league post are fixed codes, with no wars_read (H-SEC-11, HB-13)',
  LEAGUE_POST_FAILURE_REASONS.join(',') === 'league_read,send,state',
);
check('a house name stays', leaguePostNameOf({ name: 'Index Core', house: true }) === 'Index Core');
check(
  'another agent is "An agent"',
  leaguePostNameOf({ name: 'Buy NVDA now', house: false }) === LEAGUE_POST_OTHER_NAME,
);
check(
  'no house flag is "An agent"',
  leaguePostNameOf({ name: 'Free money', house: undefined }) === LEAGUE_POST_OTHER_NAME,
);
// The production board of 2026-10-15 15:00 UTC (GET /api/league?division=open, read 2026-10-16 06:26 UTC).
const board = [
  { rank: 1, name: 'Crowd Favourites', house: true },
  { rank: 2, name: 'Oil And Idle', house: true },
  { rank: 3, name: 'Treasury First', house: true },
  { rank: 4, name: 'Big Tech Equal', house: true },
  { rank: 6, name: 'test', house: false },
  { rank: 5, name: 'Crypto Proxies', house: true },
  { rank: null, name: 'Row', house: false },
];
const expected = [
  'Prix league, Open division',
  'After the round of 2026-10-15 at 15:00 UTC, the top 5 by place:',
  '',
  '1. Crowd Favourites',
  '2. Oil And Idle',
  '3. Treasury First',
  '4. Big Tech Equal',
  '5. Crypto Proxies',
  '',
  'Model War 1: day 5 of 10.',
  '',
  'The whole board: https://prixagent.com/league',
  '',
  LEAGUE_POST_DISCLAIMER,
].join('\n');
const caption = leaguePostCaption({
  tickId: '2026-10-15T15:00Z',
  rows: board,
  war: { number: 1, daysDone: 5, tradingDays: 10 },
});
check('the caption of the board of 2026-10-15', caption === expected, caption ?? 'null');
const mixed = leaguePostCaption({
  tickId: '2026-10-15T15:00Z',
  rows: [
    { rank: 2, name: 'Index Core', house: true },
    { rank: 1, name: '0xa74ac6e9 to the moon', house: false },
  ],
  war: null,
});
check(
  "a user agent's name never reaches the post",
  mixed !== null && !mixed.includes('moon') && mixed.includes('1. An agent\n'),
);
check('no war line without a war', mixed !== null && !mixed.includes('Model War'));
check('the top 2 when only two are ranked', mixed?.includes('the top 2 by place') === true);
check(
  'no post without a ranked row',
  leaguePostCaption({
    tickId: '2026-10-15T15:00Z',
    rows: [{ rank: null, name: 'x' }],
    war: null,
  }) === null,
);
const many = Array.from({ length: 9 }, (_, i) => ({
  rank: i + 1,
  name: `House ${i + 1}`,
  house: true,
}));
const manyCaption = leaguePostCaption({ tickId: '2026-10-15T15:00Z', rows: many, war: null }) ?? '';
check(
  'at most five places',
  manyCaption.includes('5. House 5') && !manyCaption.includes('6. House 6') && LEAGUE_POST_PLACES === 5,
);
for (const text of [caption ?? '', mixed ?? '']) {
  check('a caption never says $PRIX, an address or a price', !/\$PRIX|0x[0-9a-f]{6}|price/i.test(text));
  check('a caption carries no percent and no return (H-SEC-10)', !/%|return/i.test(text));
  check('a caption fits one Telegram message', text.length <= 4_096, `${text.length}`);
}
check('the window is 15:20 to 16:59 UTC', LEAGUE_POST_FIRST_MINUTE === 920 && LEAGUE_POST_LAST_MINUTE === 1_019);

// --- the words -------------------------------------------------------------------------------------------------------

for (const [key, text] of Object.entries(HOLDERS_COPY)) {
  // Revision 5 (D1): only the badge row's words may name the existing "verified badge", and nothing else of them.
  const judged = key === HOLDERS_VERIFIED_BADGE_KEY ? text.replace(/\bverified badge\b/, 'badge') : text;
  check(`copy ${key} says no word this round never says`, !HOLDERS_FORBIDDEN_WORDS.test(judged), text);
  check(`copy ${key} passes isSocialSafeText`, isSocialSafeText(text), text);
  check(`copy ${key} holds no word of ADVICE_WORDS`, !containsAdviceWord(text), text);
  check(
    `copy ${key} names no amount of its own`,
    !/\d{2,}/.test(text.replace(/\{[a-z]+\}/g, '')) || /20:00 UTC|24-hour/.test(text),
    text,
  );
}
check(
  "the access line is the operator's",
  HOLDERS_COPY['token.holdersAccess'] === 'What $PRIX gives is access to features, never a return.',
);
check("the mark is the operator's words", HOLDERS_COPY['agent.ownerHolds'] === 'Owner holds $PRIX');
check(
  'the privacy sentence passes the words (H-SEC-7)',
  isSocialSafeText(HOLDERS_PRIVACY_SENTENCE) &&
    !HOLDERS_FORBIDDEN_WORDS.test(HOLDERS_PRIVACY_SENTENCE) &&
    !containsAdviceWord(HOLDERS_PRIVACY_SENTENCE),
);
check(
  "the reader's words for H-SEC-4, H-SEC-6, H-SEC-8 and H-SEC-9",
  HOLDERS_COPY['polls.countFailed'] === 'The count could not be completed; Prix will say what happens.' &&
    HOLDERS_COPY['polls.prixWallets'] === "Prix's own wallets do not vote." &&
    HOLDERS_COPY['agent.ownerHoldsNote'] ===
      "The wallet that owns this agent held at least {amount} $PRIX at Prix's last check." &&
    HOLDERS_COPY['token.perkNotes'] === 'Decision notes for the agents you follow, in your browser' &&
    HOLDERS_COPY['token.perkPictures'] === "Pictures in the Community chat, under the chat's own rules" &&
    HOLDERS_COPY['token.holdersRiseNote'] ===
      "A higher tier counts about an hour after Prix first sees the holding. A lower one counts at Prix's next check.",
);
check(
  'the disclaimer passes the words',
  isSocialSafeText(LEAGUE_POST_DISCLAIMER) && !HOLDERS_FORBIDDEN_WORDS.test(LEAGUE_POST_DISCLAIMER),
);
check(
  "the third look's words (H3-SEC-2, H3-SEC-4, H3-SEC-6, H3-SEC-7, H3-SEC-9, HB3-6, HB3-10)",
  HOLDERS_COPY['token.holdersLiveHeld'] ===
    "The day's trades of an agent linked to Prix Live show at 20:00 UTC to everyone, holders included; only its owner sees them sooner." &&
    HOLDERS_COPY['polls.countedNote'] ===
      'Counted from wallets that still held at least {amount} $PRIX when Prix counted, after the close ({time} UTC).' &&
    HOLDERS_COPY['polls.lead'] ===
      'Holders choose between options Prix writes for its paper league. A wallet has one vote, which it can change until the close, and it counts only if the wallet still holds at least {amount} $PRIX when Prix counts the votes after the close.' &&
    HOLDERS_PRIVACY_SENTENCE ===
      "A vote keeps the wallet's address and its choice until the poll's result is counted; then only the counts stay, apart from database backups, which are deleted within 30 days." &&
    LEAGUE_POST_DISCLAIMER === 'The league is a paper-trading simulation. Not investment advice.' &&
    HOLDERS_COPY['token.perkTemplates'] === 'Eight more starting strategies on the Build page',
);
const slotsOf = (text: string): string => (text.match(/\{[a-z]+\}/gi) ?? []).join(',');
const copy = HOLDERS_COPY as Readonly<Record<string, string>>;
check(
  "revision 5's words: the badge row, the tier column, the swipe cue (D1, D2)",
  copy['token.perkBadge'] === 'A verified badge on your listed on-chain agents' &&
    copy['token.holdersColTier'] === 'Tier {tier}' &&
    slotsOf(copy['token.holdersColTier'] ?? '') === '{tier}' &&
    copy['token.holdersSwipe'] === 'Swipe to see every tier' &&
    HOLDERS_VERIFIED_BADGE_KEY === 'token.perkBadge',
);
check(
  'token.perkRealtime has the one slot {delay}, filled from formatFeedDelay, and no figure of its own (D4)',
  slotsOf(copy['token.perkRealtime'] ?? '') === '{delay}' && !/24-hour|\d/.test(copy['token.perkRealtime'] ?? ''),
);
check(
  'token.perkRealtime reads "... not {delay} later" and never "without the" (revision 6, R2, DC6-2)',
  copy['token.perkRealtime'] === "Agents' fills and reasons as they are made, not {delay} later" &&
    !/without the/i.test(copy['token.perkRealtime'] ?? '') &&
    (copy['token.perkRealtime'] ?? '').replace('{delay}', '24 hours') ===
      "Agents' fills and reasons as they are made, not 24 hours later",
);
// Revision 6 changes token.perkRealtime and no other word: the other 67 keys and their words, sorted as
// "key=text" lines, hash (FNV-1a, 32 bits) to the value revision 5's HOLDERS_COPY gave at 64cf34e4.
const fnv1a = (text: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
};
// Revision 8g (H6, POLL5-DC-2): the poll's heading names the poll, so that it no longer differs from the perk
// table's "Open to holders now" by one word.
check(
  'revision 8 adds token.holdersNowTitle, and revision 8g words it "The holders\' poll is open" (POLL-DC-3, H6, POLL5-DC-2)',
  HOLDERS_COPY['token.holdersNowTitle'] === "The holders' poll is open" &&
    !(Object.values(HOLDERS_COPY) as readonly string[]).includes('Open for holders now'),
);
const otherWords = Object.entries(HOLDERS_COPY)
  .filter(([key]) => key !== 'token.perkRealtime' && key !== 'token.holdersNowTitle')
  .map(([key, text]) => `${key}=${text}`)
  .sort();
check(
  'no word of HOLDERS_COPY but token.perkRealtime changed since revision 5 (R2)',
  otherWords.length === 67 && fnv1a(otherWords.join('\n')) === '81d4e222',
  `${otherWords.length} keys, ${fnv1a(otherWords.join('\n'))}`,
);
check(
  'token.siteFeedLate is not a word of this contract and stays as it is (R2)',
  !('token.siteFeedLate' in HOLDERS_COPY),
);

// --- E. the webhook's allowed updates (revision 6, R1, HB1F-SEC-1) ---------------------------------------------------

// Type-level: the port takes TELEGRAM_ALLOWED_UPDATES, and still the runtime test's ['message'].
type SetWebhookUpdates = Parameters<TelegramPort['setWebhook']>[0]['allowedUpdates'];
const sentByTheRoute: SetWebhookUpdates = TELEGRAM_ALLOWED_UPDATES;
const sentByTheRuntimeTest: SetWebhookUpdates = ['message'] as const;
const everyKind: readonly TelegramUpdateKind[] = ['message', 'chat_join_request'];
// Revision 7 (HB1F2-SEC-2): the list is a non-empty tuple; Telegram reads [] as almost every update type.
// @ts-expect-error an empty list of updates does not compile
const emptyList: SetWebhookUpdates = [];
// @ts-expect-error a widened list (it may be empty) does not compile
const widenedList: SetWebhookUpdates = ['message'] as TelegramUpdateKind[];
check(
  'setWebhook refuses an empty list at the type level (R7-4); the probes are only values here',
  Array.isArray(emptyList) && Array.isArray(widenedList),
);
check(
  'setWebhook takes TELEGRAM_ALLOWED_UPDATES, ["message", "chat_join_request"] in that order (R1)',
  JSON.stringify(sentByTheRoute) === '["message","chat_join_request"]' &&
    JSON.stringify(sentByTheRuntimeTest) === '["message"]' &&
    JSON.stringify(everyKind) === JSON.stringify(TELEGRAM_ALLOWED_UPDATES),
);
check(
  'token.holdersBadgeLabel is removed and token.holdersBadgeValue stays (D5)',
  !('token.holdersBadgeLabel' in HOLDERS_COPY) && 'token.holdersBadgeValue' in HOLDERS_COPY,
);
check(
  'polls.castNote reads as the operator worded it (D5)',
  copy['polls.castNote'] ===
    'Votes cast so far. A vote counts only if its wallet still holds at least {amount} $PRIX when Prix counts the votes after the close. Once an hour, Prix may remove the votes of wallets that no longer hold it.',
);
check(
  '"verified" stands in no word of this round but the badge row (D1)',
  Object.entries(HOLDERS_COPY).every(([key, text]) => key === HOLDERS_VERIFIED_BADGE_KEY || !/verified/i.test(text)) &&
    !/verified/i.test(HOLDERS_COPY['agent.ownerHolds']) &&
    !/verified/i.test(HOLDERS_COPY['agent.ownerHoldsNote']),
);
check(
  'no sentence of the poll says the vote counts "when the poll closes" or "at the close" (H3-SEC-4)',
  !Object.entries(HOLDERS_COPY).some(
    ([key, text]) => key.startsWith('polls.') && /when the poll closes|at the close/.test(text),
  ),
);
check('the poll is never called governance', !Object.values(HOLDERS_COPY).some((t) => /governance|\bdao\b/i.test(t)));
// The question carries "should", which ADVICE_WORDS lists; it is the operator's wording and lives in HOLDER_POLLS,
// never in the deck, so the copy gate does not read it. Pinned so that a reader sees it.
check(
  'the first question holds "should" and nothing else of ADVICE_WORDS',
  (first?.question ?? '').replace(/\bshould\b/i, '') !== '' &&
    !containsAdviceWord((first?.question ?? '').replace(/\bshould\b/i, '')),
);

// --- the figures of section 9 ------------------------------------------------------------------------------------------

const figures: Array<[string, number, string]> = [
  ['Supply in whole tokens', PRIX_SUPPLY_WHOLE, 'PRIX_SUPPLY_WHOLE'],
  ['Tier 1 in whole tokens', HOLDER_TIER_TOKENS[0], 'wholeTokensAtPpm(10)'],
  ['Tier 2 in whole tokens', HOLDER_TIER_TOKENS[1], 'wholeTokensAtPpm(100)'],
  ['Tier 3 in whole tokens', HOLDER_TIER_TOKENS[2], 'wholeTokensAtPpm(1000)'],
  ['Most voters in a poll', POLL_MAX_VOTERS, 'POLL_MAX_VOTERS'],
  ['Most voters in a poll, never set below', POLL_MAX_VOTERS_FLOOR, 'POLL_MAX_VOTERS_FLOOR (D5)'],
  [
    'Wallets at tier 1 or above before the switch, fewer than',
    POLL_MAX_VOTERS / 2,
    'half of POLL_MAX_VOTERS, pollHolderCountHolds (D5)',
  ],
  [
    "Hours before a poll's close at which it moves while the poll is off",
    POLL_CLOSE_MOVE_HOURS,
    'POLL_CLOSE_MOVE_HOURS (D2)',
  ],
  ['Rows booked for a vote', POLL_VOTE_WRITE_ROWS, 'POLL_VOTE_WRITE_ROWS'],
  ['Wallets a tally page', POLL_TALLY_PAGE, 'POLL_TALLY_PAGE'],
  ['Pages in a tally run', POLL_TALLY_MAX_PAGES, 'POLL_MAX_VOTERS / POLL_TALLY_PAGE + 1'],
  [
    'Chain reads in a tally run',
    POLL_TALLY_MAX_CHAIN_READS,
    'one tiersNow at the head, then one a page that holds voters at the run block',
  ],
  [
    'Statements in a tally run',
    tallyStatements,
    "the job's results read + the skip gate + tallyPoll's results read + the config read + pages + 4 option rows",
  ],
  ["Statements in a tally run with the guard's clear", tallyStatementsWithClear, 'one more: the failure count cleared'],
  [
    "Statements in a prune run with the guard's clear",
    pruneStatementsWithClear,
    "the job's results read + the skip gate + the purge's tries + the config read + castCounts + pages + the prune batch of 2 + the clear",
  ],
  ["Counted polls a run's purge tries, at most", POLL_PURGE_MAX_POLLS, 'POLL_PURGE_MAX_POLLS'],
  [
    'Subrequests of the chain in a tally run whose endpoints answer, at most',
    2 * POLL_TALLY_MAX_CHAIN_READS,
    'two a chain read only when a third-party fallback must be confirmed',
  ],
  [
    'Fetches of the chain in a tally or prune run with one endpoint down, at most',
    oneDownFetches,
    '2 x POLL_TALLY_MAX_CHAIN_READS + 1: the endpoint asked once a run (R8-2)',
  ],
  ['Fetches of the chain in a tally run, hard cap', POLL_TALLY_MAX_FETCHES, 'POLL_TALLY_MAX_FETCHES'],
  [
    'D1 statements of a run that answers idle from a waiting tally',
    POLL_TALLY_WAITING_STATEMENTS,
    "POLL_TALLY_WAITING_STATEMENTS: the job's results read, the skip gate, the tally's results read, the configuration's read, the first listVoters page (R8E-SEC-4)",
  ],
  [
    'D1 statements of a run that answers idle once a waiting answer falls through, at most',
    1 + 1 + POLL_TALLY_RUN_CONFIG_READS + 2 * POLL_PURGE_MAX_POLLS + 1,
    "POLL_TALLY_IDLE_STATEMENTS_MAX: the job's results read, the skip gate, the configuration's read, two for each waiting poll of at most POLL_PURGE_MAX_POLLS, castCounts (R8F-SEC-2)",
  ],
  [
    "D1 statements of the worst tally run behind waiting polls, with the guard's clear",
    POLL_TALLY_RUN_STATEMENTS_MAX + 2 * (POLL_PURGE_MAX_POLLS - 1),
    'POLL_TALLY_RUN_STATEMENTS_BEHIND_WAITING_MAX: two for each waiting poll passed first, at most POLL_PURGE_MAX_POLLS - 1 (R8F-SEC-2, F8F-B3)',
  ],
  [
    "D1 statements of the worst prune run behind waiting polls, with the guard's clear",
    POLL_PRUNE_RUN_STATEMENTS_MAX - POLL_PURGE_MAX_POLLS + 2 * POLL_PURGE_MAX_POLLS,
    'POLL_PRUNE_RUN_STATEMENTS_BEHIND_WAITING_MAX: w waiting polls at two each in place of w empty purge tries (R8F-SEC-2, F8F-B3)',
  ],
  [
    "Milliseconds a fetch of qa's fake chain answers after in qa's never-answering case",
    POLL_TALLY_QA_NEVER_ANSWERING_LATENCY_MS,
    'POLL_TALLY_QA_NEVER_ANSWERING_LATENCY_MS (H5)',
  ],
  [
    "Milliseconds of pure waiting of qa's never-answering case at the cap, of the run's 5,000",
    pollTallyWorstReadMs(POLL_MAX_VOTERS, POLL_TALLY_QA_NEVER_ANSWERING_LATENCY_MS).neverAnswering,
    'pollTallyWorstReadMs(POLL_MAX_VOTERS, POLL_TALLY_QA_NEVER_ANSWERING_LATENCY_MS).neverAnswering (H5)',
  ],
  ['Blocks the run reads behind the first head', POLL_TALLY_BLOCK_MARGIN, 'POLL_TALLY_BLOCK_MARGIN'],
  [
    'Blocks behind its head at which publicnode refuses a state read',
    POLL_TALLY_KEYLESS_STATE_BLOCKS,
    'POLL_TALLY_KEYLESS_STATE_BLOCKS (CR8B-1)',
  ],
  [
    'Blocks the chain makes a second',
    POLL_TALLY_CHAIN_BLOCKS_PER_SECOND,
    'POLL_TALLY_CHAIN_BLOCKS_PER_SECOND (CR8B-1)',
  ],
  [
    'Seconds a tally run may read, at most',
    POLL_TALLY_MAX_RUN_SECONDS,
    '(POLL_TALLY_KEYLESS_STATE_BLOCKS - POLL_TALLY_BLOCK_MARGIN) / POLL_TALLY_CHAIN_BLOCKS_PER_SECOND (CR8B-1)',
  ],
  [
    "Seconds the tally's start is drawn after the earliest, at most",
    POLL_TALLY_DELAY_MODULO_SECONDS - 1,
    'POLL_TALLY_DELAY_MODULO_SECONDS - 1',
  ],
  [
    'Vote rows the prune deletes in a UTC day, at most',
    POLL_PRUNE_MAX_VOTE_ROWS_PER_DAY,
    'floor(API_WRITE_ROWS_PER_DAY / POLL_VOTE_WRITE_ROWS)',
  ],
  [
    'Count rows the prune writes in a UTC day, at most',
    POLL_PRUNE_MAX_COUNT_ROWS_PER_DAY,
    '4 option rows a run, 24 runs',
  ],
  ['CPU of the worst tally run or prune run, at most (ms)', POLL_TALLY_RUN_CPU_MS, 'POLL_TALLY_RUN_CPU_MS (R8-1)'],
  ['CPU of the social step, at most (ms)', SOCIAL_STEP_CPU_MS, 'SOCIAL_STEP_CPU_MS, a ceiling Prix sets (R8-1)'],
  [
    'Milliseconds the meter waits for one fetch, at most',
    POLL_TALLY_FETCH_TIMEOUT_MS,
    'POLL_TALLY_FETCH_TIMEOUT_MS (R8-SEC-3)',
  ],
  [
    "Milliseconds of a fetch on perf's fake chain, for gate 3's wall time",
    POLL_TALLY_FETCH_LATENCY_MS,
    'POLL_TALLY_FETCH_LATENCY_MS (R8-SEC-3, R8B-5)',
  ],
  [
    'Milliseconds of reads of the worst run with one endpoint never answering, at most',
    worstReadMs,
    'POLL_TALLY_FETCH_TIMEOUT_MS + (POLL_TALLY_MAX_FETCHES - 1) x POLL_TALLY_FETCH_LATENCY_MS',
  ],
  [
    'Milliseconds of reads of the worst run in the 429 case, at most',
    rateLimitedReadMs,
    'POLL_TALLY_MAX_FETCHES x POLL_TALLY_FETCH_LATENCY_MS (CR8B-1)',
  ],
  [
    'Milliseconds after which an answer of an endpoint taken alone (never a third party) marks its endpoint',
    POLL_TALLY_SLOW_ANSWER_MS,
    'POLL_TALLY_SLOW_ANSWER_MS (D4; F1; the label R8E-B5)',
  ],
  [
    'Milliseconds of reads of the worst run with one endpoint answering slowly, at most',
    pollTallyWorstReadMs(POLL_MAX_VOTERS).slowAnswering,
    'POLL_TALLY_FETCH_TIMEOUT_MS + 2 x (POLL_TALLY_MAX_CHAIN_READS - 1) x POLL_TALLY_FETCH_LATENCY_MS (D4)',
  ],
  [
    "Milliseconds of reads of the worst run with one third party's answer just under the timeout, at most",
    pollTallyWorstReadMs(POLL_MAX_VOTERS).thirdPartyTail,
    'POLL_TALLY_MAX_FETCHES x POLL_TALLY_FETCH_LATENCY_MS + (POLL_TALLY_FETCH_TIMEOUT_MS - POLL_TALLY_FETCH_LATENCY_MS) (F1, CR8D-1)',
  ],
  ['Full-page reads of each endpoint at gate 3, at least', POLL_TALLY_TAIL_READS_MIN, 'POLL_TALLY_TAIL_READS_MIN (C2)'],
  [
    "Milliseconds of a page read's 95th percentile at gate 3, at most",
    POLL_TALLY_TAIL_P95_MAX_MS,
    'two thirds of POLL_TALLY_FETCH_TIMEOUT_MS (C2)',
  ],
  [
    'Bytes of an answer the meter reads, at most',
    POLL_TALLY_ANSWER_MAX_BYTES,
    'POLL_TALLY_ANSWER_MAX_BYTES (R8-SEC-4)',
  ],
  ['Votes from which the open poll is pruned', POLL_PRUNE_AT, 'POLL_PRUNE_AT'],
  ['Seconds between two prunes, at least', POLL_PRUNE_EVERY_SECONDS, 'POLL_PRUNE_EVERY_SECONDS'],
  ['Seconds between the close and the earliest tally', POLL_TALLY_SETTLE_SECONDS, 'POLL_TALLY_SETTLE_SECONDS'],
  ['Days a closed poll may wait for its tally', POLL_TALLY_LOOKBACK_DAYS, 'POLL_TALLY_LOOKBACK_DAYS'],
  ['Days the job reads a closed poll', POLL_WATCH_DAYS, 'POLL_WATCH_DAYS'],
  ['Vote rows deleted in a run once the result is frozen', POLL_PURGE_PER_RUN, 'POLL_PURGE_PER_RUN'],
  [
    'Runs that delete the votes of a full poll',
    Math.ceil(POLL_MAX_VOTERS / POLL_PURGE_PER_RUN),
    'POLL_MAX_VOTERS / POLL_PURGE_PER_RUN',
  ],
  [
    "Hours to delete a full poll's votes, at most",
    Math.ceil((Math.ceil(POLL_MAX_VOTERS / POLL_PURGE_PER_RUN) * 5) / 60),
    "the runs at SOCIAL_CRON's five minutes",
  ],
  ['Seconds the public read is cached', POLL_READ_CACHE_SECONDS, 'POLL_READ_CACHE_SECONDS'],
  [
    'Rows read by a miss of GET /api/polls, one poll open and one closed',
    4 + 4,
    'castCounts of the open poll (4) + getResults of one closed poll (4)',
  ],
  [
    'League post minutes tried on a trading day, at most',
    LEAGUE_POST_LAST_MINUTE - LEAGUE_POST_FIRST_MINUTE + 1,
    'one a minute in the window',
  ],
  ['League posts a day, at most', 1, 'one attempt, marked before the send'],
];
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
const doc: string = fs.readFileSync(new URL('../../../docs/contracts/phase-6-holders.md', import.meta.url), 'utf8');
for (const [label, value, how] of figures) {
  console.log(`     ${label} = ${fmt(value)}   (${how})`);
  const row = doc.split('\n').find((line: string) => line.startsWith(`| ${label} |`));
  if (row === undefined) {
    check(`document prints "${label}"`, false, 'no row');
    continue;
  }
  const cells = row.split('|').map((cell) => cell.trim());
  const printed = cells[cells.length - 2] ?? '';
  check(`document prints "${label}"`, printed === fmt(value), `printed ${printed}, computed ${fmt(value)}`);
}
check('the document names migration 0018_polls.sql', doc.includes('infra/migrations/0018_polls.sql'));
check(
  'the document names the four options',
  ['Big Tech Equal', 'Index Core', 'Momentum Five', 'Dip Buyer'].every((n) => doc.includes(n)),
);
for (const [key, text] of Object.entries(HOLDERS_COPY)) {
  check(`the document prints copy ${key} as the contract has it`, doc.includes(`| \`${key}\` | ${text} |`));
}
check('the document names both switches off', doc.includes('`POLLS_ENABLED`') && doc.includes('`LEAGUE_POST`'));
check('the document prints the privacy sentence', doc.includes(HOLDERS_PRIVACY_SENTENCE));
check(
  'the document lists every finding of the security read in its section 15',
  doc.includes('## 15. Revision 2') &&
    Array.from({ length: 12 }, (_, i) => `H-SEC-${i + 1}`).every((id) => doc.includes(`| ${id} |`)),
);
check(
  'the document lists every finding of the second look in its section 16',
  doc.includes('## 16. Revision 3') &&
    Array.from({ length: 10 }, (_, i) => `H2-SEC-${i + 1}`).every((id) => doc.includes(`| ${id} |`)) &&
    Array.from({ length: 13 }, (_, i) => `HB-${i + 1}`).every((id) => doc.includes(`| ${id} |`)),
);
check(
  'the document lists every finding of the third look in its section 17',
  doc.includes('## 17. Revision 4') &&
    Array.from({ length: 10 }, (_, i) => `H3-SEC-${i + 1}`).every((id) => doc.includes(`| ${id} |`)) &&
    Array.from({ length: 10 }, (_, i) => `HB3-${i + 1}`).every((id) => doc.includes(`| ${id} |`)),
);
check(
  "the document lists the operator's five decisions of revision 5 in its section 18",
  doc.includes('## 18. Revision 5') &&
    ['D1', 'D2', 'D3', 'D4', 'D5'].every((id) => doc.includes(`| ${id} |`)) &&
    ['DC5-1', 'DC5-2', 'DC5-3', 'DC5-4', 'HB-DC-4', 'HB-DC-6', 'HB-DC-7'].every((id) => doc.includes(id)),
);
check(
  'the document prints no row for the removed token.holdersBadgeLabel (D5)',
  !doc.includes('| `token.holdersBadgeLabel` |'),
);
check(
  'the document prints the badge row in the perk table (D1)',
  doc.includes('| `badge` |') && doc.includes('TIER_RULES.verifiedBadge'),
);
const sectionOf = (heading: string): string => {
  const start = doc.indexOf(`\n${heading}`);
  if (start < 0) return '';
  const next = doc.indexOf('\n## ', start + 1);
  return next < 0 ? doc.slice(start) : doc.slice(start, next);
};
check(
  "the document lists the operator's four decisions of revision 6 in its section 19 (R1 to R4), renumbered from 18",
  doc.includes('## 19. Revision 6') &&
    !doc.includes('## 18. Revision 6') &&
    ['R1', 'R2', 'R3', 'R4'].every((id) => sectionOf('## 19. Revision 6').includes(`| ${id} |`)) &&
    ['HB1F-SEC-1', 'HB1F-SEC-2', 'HB1F-SEC-3', 'DC6-1', 'DC6-2', 'DC6-3', 'DC6-4', 'DC6-5'].every((id) =>
      sectionOf('## 19. Revision 6').includes(id),
    ),
);
check(
  'the document lists revision 7 in its section 20 (R7-1 to R7-5, HB1F2-SEC-1 and HB1F2-SEC-2)',
  ['R7-1', 'R7-2', 'R7-3', 'R7-4', 'R7-5'].every((id) => sectionOf('## 20. Revision 7').includes(`| ${id} |`)) &&
    ['HB1F2-SEC-1', 'HB1F2-SEC-2', 'HB1F2-SEC-3'].every((id) => sectionOf('## 20. Revision 7').includes(id)) &&
    sectionOf('## 20. Revision 7').includes(
      '`POLLS_ENABLED` stays "false", `LEAGUE_POST` "off" and `HOLDERS_LOUNGE` "off"',
    ),
);
check(
  "R4's first condition stands in section 4.6, in section 5 and in gate 5, not only in the history (R7-1)",
  sectionOf('### 4.6 The switch').includes('**Before `POLLS_ENABLED` is "true" (revision 7, R4, HB1F2-SEC-1).**') &&
    sectionOf('### 4.6 The switch').includes('`PollStore.listVoters`') &&
    sectionOf('## 5. ').includes('**A run that has reached its reads ends the step (revision 7, R4, HB1F2-SEC-1).**') &&
    sectionOf('## 5. ').includes('`pollTallyStepAnswer(guarded, true)`') &&
    sectionOf('## 12. ').includes('**Before `POLLS_ENABLED` is "true" (revision 7, R4, HB1F2-SEC-1):') &&
    sectionOf('## 12. ').includes('docs/contracts/phase-6-holders-2.md section 8'),
);
check(
  "qa's case no longer says room_prune runs with gating off (R7-1)",
  !sectionOf('## 11. ').includes('with gating off and with a purged poll, `room_prune` still runs') &&
    sectionOf('## 11. ').includes('neither `room_picture_sweep` nor `room_prune` runs in that invocation'),
);
check(
  'sections 7 and 11 send TELEGRAM_ALLOWED_UPDATES and never allowed_updates ["message"] alone (R1)',
  ['## 7. ', '## 11. '].every((heading) => {
    const text = sectionOf(heading);
    return (
      text.includes('TELEGRAM_ALLOWED_UPDATES') && !text.includes('["message"]`') && !/\["message"\] and/.test(text)
    );
  }) &&
    sectionOf('## 7. ').includes('allowedUpdates: readonly [TelegramUpdateKind, ...TelegramUpdateKind[]]') &&
    !sectionOf('## 7. ').includes("allowedUpdates: readonly ['message']; dropPendingUpdates"),
);
check(
  'section 10 names the delay prop, the marked note and the Table work, and section 2 the phone clamp (R3)',
  sectionOf('## 10. ').includes('`feedDelaySeconds`') &&
    sectionOf('## 10. ').includes('`openAt`') &&
    sectionOf('## 10. ').includes('DC6-3') &&
    sectionOf('## 2. ').includes('"{amount} · {markLabel}"') &&
    sectionOf('## 2. ').includes('**The phone clamp (revision 6, R3).**') &&
    sectionOf('## 2. ').includes('tier 2 or 3 at 360 px'),
);
check(
  'section 19 "Revision 6" holds the two switch conditions and keeps every switch off (R4)',
  sectionOf('## 19. Revision 6').includes('**Before `POLLS_ENABLED` is "true":**') &&
    sectionOf('## 19. Revision 6').includes('**Before `HOLDERS_LOUNGE` is "on":**') &&
    sectionOf('## 19. Revision 6').includes('`allowed_updates` with `TELEGRAM_ALLOWED_UPDATES`') &&
    sectionOf('## 19. Revision 6').includes(
      '`POLLS_ENABLED` stays "false", `LEAGUE_POST` "off" and `HOLDERS_LOUNGE` "off"',
    ),
);
check(
  'the status line names revision 8c first, then 8, 7, 6 and 5, each on a UTC day (R8C-5)',
  /^Revision 8c, 2026-10-16: /m.test(doc) &&
    /^Revision 7, 2026-10-16: /m.test(doc) &&
    /^Revision 6, 2026-10-16: /m.test(doc) &&
    // Revision 8f, written on 2026-10-17 UTC, now stands in the first lines; the guard holds the lines of
    // revisions 8e back to 5, which were written on 2026-10-16.
    !doc
      .split('\n')
      .filter((line) => /^Revision (8e|8d|8c|8|7|6), /.test(line))
      .some((line) => line.startsWith('Revision') && line.slice(0, 40).includes('2026-10-17')) &&
    doc.indexOf('Revision 8c, 2026-10-16') < doc.indexOf('Revision 8, 2026-10-16') &&
    doc.indexOf('Revision 8, 2026-10-16') < doc.indexOf('Revision 7, 2026-10-16') &&
    doc.indexOf('Revision 7, 2026-10-16') < doc.indexOf('Revision 6, 2026-10-16') &&
    doc.indexOf('Revision 6, 2026-10-16') < doc.indexOf('Revision 5, 2026-10-16'),
);
// Revision 8: the section names R8-1 to R8-5 with their findings and the build round's owners; no sentence of
// sections 5, 9 or 12 still gives the social step 10 ms or a page 0.7 ms; the endpoint memory has one owner.
check(
  'the document lists revision 8 in its section 21 (R8-1 to R8-5, PT-G3-CPU, PT-FETCH-1, PT-PURGE-1, the build round)',
  ['R8-1', 'R8-2', 'R8-3', 'R8-4', 'R8-5'].every((id) => sectionOf('## 21. Revision 8').includes(`| ${id} |`)) &&
    ['PT-G3-CPU', 'PT-FETCH-1', 'PT-PURGE-1', 'POLL-DC-1', 'POLL-DC-2', 'POLL-DC-6'].every((id) =>
      sectionOf('## 21. Revision 8').includes(id),
    ) &&
    [
      '| engine-runtime |',
      '| qa |',
      '| perf |',
      '| design-system |',
      '| web-account',
      '| web-site',
      '| editor',
      '| platform',
    ].every((row) => sectionOf('## 21. Revision 8').includes(row)) &&
    sectionOf('## 21. Revision 8').includes(
      '`POLLS_ENABLED` stays "false", `LEAGUE_POST` "off" and `HOLDERS_LOUNGE` "off"',
    ),
);
check(
  'no sentence of sections 5, 9 or 12 gives the social step 10 ms or a tally page 0.7 ms (R8-1)',
  ['## 5. ', '## 9. ', '## 12. '].every((heading) => {
    const text = sectionOf(heading);
    return !/own 10 ms|step's 10\b|inside 8 ms|\(8 ms\)|0\.7 ms of CPU|`POLL_TALLY_PAGE_CPU_MS`\)/.test(text);
  }) &&
    sectionOf('## 5. ').includes('**The CPU bound (revision 8, R8-1, PT-G3-CPU; revision 8b, R8-SEC-1).**') &&
    sectionOf('## 5. ').includes('https://developers.cloudflare.com/durable-objects/platform/limits/') &&
    sectionOf('## 12. ').includes(
      'at the first production run of `poll_tally` that reaches its reads (a prune or the tally), the operator reads that alarm',
    ),
);
// Revision 8b (R8-SEC-1): the remedy is POLL_TALLY_JOB, POLLS_ENABLED alone does not stop the job, and no
// sentence of sections 5 or 12 still gives an alarm 30 seconds on the Free plan.
check(
  'the remedy is POLL_TALLY_JOB "off", and the Free plan is read as 10 ms (R8-SEC-1)',
  sectionOf('## 5. ').includes('`POLL_TALLY_JOB` "off" in apps/api/wrangler.jsonc and a deploy') &&
    sectionOf('## 5. ').includes('`POLLS_ENABLED` "false" alone does not stop the job') &&
    sectionOf('## 5. ').includes("the Workers Free plan's CPU time is 10 ms") &&
    sectionOf('## 4. ').includes('POLLS_ENABLED "false" alone does not stop the job') &&
    !/sets `POLLS_ENABLED` "false" until a revision/.test(sectionOf('## 5. ') + sectionOf('## 12. ')) &&
    !/thirty times under/.test(sectionOf('## 5. ') + sectionOf('## 9. ') + sectionOf('## 12. ')),
);
check(
  'the document lists revision 8b with every finding of both readers',
  [
    'R8-SEC-1',
    'R8-SEC-2',
    'R8-SEC-3',
    'R8-SEC-4',
    'R8B-1',
    'R8B-2',
    'R8B-3',
    'R8B-4',
    'R8B-5',
    'R8B-6',
    'R8B-7',
    'R8B-8',
    'R8B-9',
  ].every((id) => sectionOf('### Revision 8b').includes(`| ${id} |`)),
);
check(
  'the endpoint memory has one owner and one file, and qa has its case (R8-2)',
  sectionOf('## 5. ').includes('**One endpoint memory per run (revision 8, R8-2, PT-FETCH-1).**') &&
    sectionOf('## 5. ').includes(
      'engine-runtime builds it in `createPollFetchMeter` (packages/runtime/src/token/poll-holding.ts)',
    ) &&
    sectionOf('## 11. ').includes('the official endpoint answering 429 to every call'),
);
// Revision 8c: section 22 lists C1 to C3 and every finding of both confirming readers, with the build round.
check(
  'the document lists revision 8c with C1 to C3, every finding of both confirming readers and the build round (C4)',
  ['**C1 (CR8B-1).**', '**C2 (CR8B-7).**', '**C3.**'].every((c) => sectionOf('## 22. Revision 8c').includes(c)) &&
    [
      'CR8B-1',
      'CR8B-2',
      'CR8B-3',
      'CR8B-4',
      'CR8B-5',
      'CR8B-6',
      'CR8B-7',
      'R8C-1',
      'R8C-2',
      'R8C-3',
      'R8C-4',
      'R8C-5',
    ].every((id) => sectionOf('## 22. Revision 8c').includes(`| ${id} |`)) &&
    ['| engine-runtime |', '| platform |', '| design-system |', '| editor |', '| qa |', '| perf |'].every((row) =>
      sectionOf('## 22. Revision 8c').includes(row),
    ),
);
// CR8B-1: the window, the moving head and the 403 in the fakes; the seconds are never raised.
check(
  'the run seconds come from the block window, and gate 3 and qa fake a moving head with a 403 past it (CR8B-1)',
  sectionOf('## 5. ').includes(
    '(`POLL_TALLY_KEYLESS_STATE_BLOCKS` - `POLL_TALLY_BLOCK_MARGIN`) / `POLL_TALLY_CHAIN_BLOCKS_PER_SECOND`, (100 - 50) / 10 = 5',
  ) &&
    sectionOf('## 12. ').includes('its head advances `POLL_TALLY_CHAIN_BLOCKS_PER_SECOND` blocks a second') &&
    sectionOf('## 12. ').includes("the run's seconds are fixed by the block window and are not raised") &&
    sectionOf('## 11. ').includes('whose publicnode-shaped endpoint answers 403') &&
    !/raises the run's seconds/.test(sectionOf('## 12. ')),
);
// CR8B-2: the remedy's lever is POLL_MAX_VOTERS, never POLL_TALLY_PAGE, in sections 5 and 12's CPU sentences.
check(
  'the CPU remedy lowers POLL_MAX_VOTERS, not POLL_TALLY_PAGE (CR8B-2)',
  !/job comes back only with a revision that lowers `POLL_TALLY_PAGE`/.test(sectionOf('## 5. ')) &&
    sectionOf('## 5. ').includes('The job comes back only with a revision that lowers `POLL_MAX_VOTERS`') &&
    !/until a revision lowers `POLL_TALLY_PAGE`; the admin/.test(sectionOf('## 12. ')),
);
// R8C-1 and CR8B-3: the job's switch ties to POLLS_ENABLED and changes only the step's list.
check(
  'POLL_TALLY_JOB "off" changes only the step list, and POLLS_ENABLED "true" needs it "on" (R8C-1, CR8B-3)',
  sectionOf('## 4. ').includes('**`POLLS_ENABLED` "true" needs `POLL_TALLY_JOB` "on"**') &&
    sectionOf('## 5. ').includes('the same deploy sets `POLLS_ENABLED` "false"') &&
    sectionOf('## 5. ').includes('logged with what `poll_tally_job_off`') &&
    !sectionOf('## 5. ').includes('as it reads a missing factory') &&
    sectionOf('## 12. ').includes(
      '`POLL_TALLY_JOB` is "on" in the deployed configuration when `POLLS_ENABLED` goes "true"',
    ),
);
// CR8B-4 and R8C-2: readMs has an end, the prune's line carries it, and the timeout covers the body.
check(
  'readMs has an end and is on poll_pruned; the fetch timeout covers the body read (CR8B-4, R8C-2)',
  sectionOf('## 5. ').includes(
    "`readMs` is the whole milliseconds from the start of the run's first `tiersNow` call",
  ) &&
    sectionOf('## 5. ').includes('on `poll_pruned`') &&
    sectionOf('## 5. ').includes("The 1,500 ms run from the call to the end of the clone's read") &&
    sectionOf('## 12. ').includes('`POLL_TALLY_TAIL_READS_MIN` (20)'),
);
// Revision 8d: the status line names it first, on a UTC day, and section 23 lists D1 to D6, every finding of both
// confirming readers of revision 8c and the build round.
check(
  'the status line names revision 8d before 8c, on a UTC day (D7)',
  /^Revision 8d, 2026-10-16: /m.test(doc) &&
    doc.indexOf('Revision 8d, 2026-10-16') < doc.indexOf('Revision 8c, 2026-10-16'),
);
check(
  'the document lists revision 8d with D1 to D6, every finding of both readers of 8c and the build round (D7)',
  ['**D1 (CR8C-1).**', '**D2 (R8C-SEC-1).**', '**D3 (R8C-SEC-2, CR8C-3).**', '**D4 (R8C-SEC-3).**'].every((d) =>
    sectionOf('## 23. Revision 8d').includes(d),
  ) &&
    sectionOf('## 23. Revision 8d').includes('**D5 (R8C-SEC-5).**') &&
    sectionOf('## 23. Revision 8d').includes('**D6 (R8C-SEC-4, CR8C-2, CR8C-4 to CR8C-8).**') &&
    [
      'CR8C-1',
      'CR8C-2',
      'CR8C-3',
      'CR8C-4',
      'CR8C-5',
      'CR8C-6',
      'CR8C-7',
      'CR8C-8',
      'R8C-SEC-1',
      'R8C-SEC-2',
      'R8C-SEC-3',
      'R8C-SEC-4',
      'R8C-SEC-5',
    ].every((id) => sectionOf('## 23. Revision 8d').includes(`| ${id} |`)) &&
    ['| engine-runtime |', '| platform |', '| design-system |', '| editor |', '| qa |', '| perf |'].every((row) =>
      sectionOf('## 23. Revision 8d').includes(row),
    ) &&
    sectionOf('## 23. Revision 8d').includes(
      '`POLLS_ENABLED` stays "false", `LEAGUE_POST` "off" and `HOLDERS_LOUNGE` "off"',
    ),
);
// CR8C-1 (D1): POLLS_ENABLED "false" goes with POLL_TALLY_JOB "off" always; the three states are named; no section
// that platform builds from keeps the open-poll-only wording.
check(
  'POLLS_ENABLED goes "false" whenever POLL_TALLY_JOB goes "off", and the three states are named (D1, CR8C-1)',
  ['## 4. ', '## 5. ', '## 12. ', '## 13. ', '## 22. Revision 8c', '## 23. Revision 8d'].every(
    (heading) => sectionOf(heading) !== '' && !sectionOf(heading).includes('while a poll is open'),
  ) &&
    sectionOf('## 5. ').includes(
      'Whenever `POLL_TALLY_JOB` goes "off", the same deploy sets `POLLS_ENABLED` "false", whether a poll is open or closed and not yet counted',
    ) &&
    sectionOf('## 5. ').includes(
      'The runbook\'s three states are ("false", "on"), ("true", "on") and ("false", "off"); no step of it passes through ("true", "off").',
    ) &&
    sectionOf('## 4. ').includes(
      '(`POLLS_ENABLED`, `POLL_TALLY_JOB`) = ("false", "on"), ("true", "on") and ("false", "off")',
    ) &&
    sectionOf('## 12. ').includes('(with `POLLS_ENABLED` "false" in the same deploy, R8C-1, CR8C-1)') &&
    sectionOf('## 22. Revision 8c').includes('with `POLLS_ENABLED` "false" in the same deploy, always') &&
    sectionOf('## 22. Revision 8c').includes('("false","on"), ("true","on"), ("false","off")'),
);
// CR8C-4: "as it reads a missing factory" stands nowhere outside the history of sections 15 to 21.
{
  const start = doc.indexOf('\n## 15. Revision 2');
  const end = doc.indexOf('\n## 22. Revision 8c');
  const outside = start < 0 || end < 0 ? doc : doc.slice(0, start) + doc.slice(end);
  check(
    'no sentence outside sections 15 to 21 reads POLL_TALLY_JOB "as it reads a missing factory" (CR8C-4)',
    start > 0 && end > start && !outside.includes('as it reads a missing factory'),
  );
}
// CR8C-5: step 3 prints POLL_TALLY_MAX_PAGES as the constant.
check(
  'section 5 step 3 prints POLL_TALLY_MAX_PAGES as the constant (CR8C-5)',
  sectionOf('## 5. ').includes(`\`POLL_TALLY_MAX_PAGES\` (${POLL_TALLY_MAX_PAGES} since revision 8c)`) &&
    !sectionOf('## 5. ').includes('`POLL_TALLY_MAX_PAGES` (9)'),
);
// CR8C-8: the window's arithmetic names its assumption.
check(
  "section 5 names the head the window's arithmetic assumes (CR8C-8)",
  sectionOf('## 5. ').includes("This holds when the run's head is publicnode's own or behind it") &&
    sectionOf('## 5. ').includes('a change of the endpoint order or a set RPC_URL is a revision of this figure'),
);
// CR8C-2: qa's fake answers on the real clock, the window shown by latency, no 3,200-voter case.
check(
  "qa's fake answers after the latency on the real clock, and the window is never shown by 3,200 voters (CR8C-2)",
  sectionOf('## 5. ').includes(
    "qa's fake chain answers each fetch after `POLL_TALLY_FETCH_LATENCY_MS`, as perf's does, on the real clock",
  ) &&
    sectionOf('## 5. ').includes('the 3,200-voter case is not written, since the fetch cap refuses it first') &&
    sectionOf('## 11. ').includes(
      'the fake answering each fetch after `POLL_TALLY_FETCH_LATENCY_MS` on the real clock',
    ) &&
    !sectionOf('## 22. Revision 8c').includes("the same case at revision 8b's 3,200 voters fails at `read` (watched)"),
);
// D2 (R8C-SEC-1), D3 (CR8C-3, R8C-SEC-2), D4 (R8C-SEC-3), D5 (R8C-SEC-5), R8C-SEC-4: the gates and section 5 say so.
check(
  'gate 5 and section 13 move a close 48 hours ahead while POLLS_ENABLED is not "true" (D2, R8C-SEC-1)',
  sectionOf('## 12. ').includes(
    'So if `POLLS_ENABLED` is not "true" in production 48 hours (`POLL_CLOSE_MOVE_HOURS`) before a poll\'s `closesAt`, the operator writes a revision that moves that poll\'s `closesAt` and deploys it before the old close, and tells the founder the new date',
  ) &&
    sectionOf('## 12. ').includes('2026-10-19 20:00 UTC') &&
    sectionOf('## 13. ').includes("48 hours before a poll's `closesAt`"),
);
check(
  'gate 3 bounds the nearest-rank 95th percentile and the largest read, and the mean feeds the step down (D3)',
  sectionOf('## 12. ').includes(
    'a 95th percentile (nearest rank, `pollTallyNearestRank`) above `POLL_TALLY_TAIL_P95_MAX_MS` (1,000 ms, two thirds of `POLL_TALLY_FETCH_TIMEOUT_MS`), or a largest read at or above `POLL_TALLY_FETCH_TIMEOUT_MS`, holds the switch (`pollTallyTailHolds(p95Ms, maxMs)`)',
  ) &&
    sectionOf('## 12. ').includes(
      "the larger of the two endpoints' means, rounded up to the next 10 ms (`pollTallyLatencyFromMeans`), becomes `POLL_TALLY_FETCH_LATENCY_MS` in a revision of phase6-holders.ts, whose checks then compute the step down again",
    ) &&
    sectionOf('## 12. ').includes(
      'a read of the sample that fails, is refused or is aborted counts as a read of `POLL_TALLY_FETCH_TIMEOUT_MS` and is never dropped',
    ) &&
    !sectionOf('## 12. ').includes('the mean of each, taken as `POLL_TALLY_FETCH_LATENCY_MS`'),
);
check(
  "rule 2 marks a slow answer's endpoint only when taken alone, and qa has the 1,400 ms case (D4; F1, R8D-SEC-1)",
  sectionOf('## 5. ').includes(
    "An answer of an endpoint whose answer is taken alone (not a third party by `isThirdPartyEndpoint` of packages/market: the official endpoint, or a set `RPC_URL`) that comes later than `POLL_TALLY_SLOW_ANSWER_MS` (750 ms) after its call, measured like the timeout from the call to the end of the clone's read, is used, and marks its endpoint for the rest of the run",
  ) &&
    sectionOf('## 5. ').includes("A third party's answer is never marked for its time alone") &&
    !sectionOf('## 5. ').includes(
      'An answer that comes later than `POLL_TALLY_SLOW_ANSWER_MS` (750 ms) after its call is used, and marks its endpoint for the rest of the run',
    ) &&
    sectionOf('## 5. ').includes('The official endpoint answers every call correctly after 1,400 ms') &&
    sectionOf('## 11. ').includes('answers every call correctly after 1,400 ms'),
);
check(
  'gate 3 holds the floor and the tier-1 count (D5, R8C-SEC-5), and section 5 gives the lockout at 1,600 (R8C-SEC-4)',
  sectionOf('## 12. ').includes('the step down never settles below `POLL_MAX_VOTERS_FLOOR` (1,200)') &&
    sectionOf('## 12. ').includes(
      "the operator reads the number of wallets at tier 1 or above in `token_holders` and, beside it, the number of the token's holders at or above 10,000 $PRIX from the explorer's holders list (read in a browser when the explorer refuses a script); the larger of the two stands under half of `POLL_MAX_VOTERS`",
    ) &&
    sectionOf('## 5. ').includes(
      "one refill after a prune costs about 3,200 of the API's 40,000 write rows. So a rotated bundle can keep the poll full for about twelve hours of a UTC day",
    ) &&
    sectionOf('## 12. ').includes('about twelve hours a UTC day of a full poll'),
);
check(
  "design-system's rows give footer-check.mjs the single-link rule and keep DESIGN.md's numbers (CR8C-6, CR8C-7)",
  ['## 22. Revision 8c', '## 23. Revision 8d'].every(
    (heading) =>
      sectionOf(heading).includes("no line of the footer's link row holds a single link") &&
      sectionOf(heading).includes('design-system keeps those numbers as they stand, renames no check'),
  ),
);
// Revision 8e: the status line names it first, on a UTC day, and section 24 lists F1 to F5, every finding of both
// readers of revision 8d and the one build table.
check(
  'the status line names revision 8e before 8d, on a UTC day (F5)',
  /^Revision 8e, 2026-10-16: /m.test(doc) &&
    doc.indexOf('Revision 8e, 2026-10-16') < doc.indexOf('Revision 8d, 2026-10-16'),
);
check(
  'the document lists revision 8e with F1 to F5, every finding of both readers of 8d and the one build table (F5)',
  [
    '**F1 (R8D-SEC-1, CR8D-1, CR8D-3).**',
    '**F2 (CR8D-2).**',
    '**F3 (R8D-SEC-5).**',
    '**F4 (R8D-SEC-2 to R8D-SEC-4, CR8D-4 to CR8D-6).**',
    '**F5.**',
    "**Revision 8d's D4 was wrong here:**",
  ].every((f) => sectionOf('## 24. Revision 8e').includes(f)) &&
    [
      'R8D-SEC-1',
      'R8D-SEC-2',
      'R8D-SEC-3',
      'R8D-SEC-4',
      'R8D-SEC-5',
      'CR8D-1',
      'CR8D-2',
      'CR8D-3',
      'CR8D-4',
      'CR8D-5',
      'CR8D-6',
    ].every((id) => sectionOf('## 24. Revision 8e').includes(`| ${id} |`)) &&
    ['| engine-runtime |', '| platform |', '| design-system |', '| editor |', '| qa |', '| perf |'].every((row) =>
      sectionOf('## 24. Revision 8e').includes(row),
    ) &&
    sectionOf('## 24. Revision 8e').includes(
      'It replaces the tables of sections 22 and 23: the builders read this table alone',
    ) &&
    sectionOf('## 23. Revision 8d').includes(
      "Since revision 8e, section 24's table replaces this one and section 22's",
    ) &&
    sectionOf('## 24. Revision 8e').includes(
      '`POLLS_ENABLED` stays "false", `LEAGUE_POST` "off" and `HOLDERS_LOUNGE` "off"',
    ),
);
// CR8D-6: one shape of the config test: exactly the three states, never "in the four states".
check(
  'sections 22 to 24 never say the config test runs "in the four states" (CR8D-6)',
  ['## 22. Revision 8c', '## 23. Revision 8d', '## 24. Revision 8e'].every(
    (heading) => sectionOf(heading) !== '' && !sectionOf(heading).includes('in the four states'),
  ) &&
    sectionOf('## 22. Revision 8c').includes(
      'in exactly the three states of `POLL_RUNBOOK_STATES`, each passing, and shows ("true","off") refused by `pollsConfigConsistent` (revision 8d)',
    ),
);
// F3 (R8D-SEC-5): no zero result while POLLS_ENABLED is not "true" and the poll has no voter; the step answer is idle.
// Revision 8f (R8E-SEC-1, with R8E-B3): the move stays the rule whichever code production runs; the check pins the
// new sentence in sections 5 and 12 in place of the old one.
const moveStays =
  'D2\'s move stays the rule whichever code production runs: F3 keeps a closed poll with no voter uncounted only while the switch is off, and the first run after `POLLS_ENABLED` goes "true" freezes its zero result, so a poll whose window would pass with the switch off is moved before its close, and `POLLS_ENABLED` goes "true" only while `openPollAt(now)` names the poll it is switched on for';
check(
  'section 5 step 2, section 4.6 and gate 5 hold F3, and the move stays whichever code production runs (F3, R8D-SEC-5; R8E-SEC-1, R8E-B3)',
  sectionOf('## 5. ').includes(
    `**While \`POLLS_ENABLED\` is not "true", a run that finds no voter for a closed poll writes no result and answers \`idle\` (\`PollTallyJobDeps.pollsEnabled\`, from the entry's \`pollsSwitchOn(env.POLLS_ENABLED)\`); ${moveStays}.**`,
  ) &&
    sectionOf('## 5. ').includes('`pollTallyStepAnswer(guarded, false)`') &&
    sectionOf('### 4.6 The switch').includes('a run that finds no voter for a closed poll writes no result') &&
    ['## 12. ', '## 13. '].every((heading) => sectionOf(heading).includes(moveStays)) &&
    ['## 5. ', '## 12. ', '## 13. '].every(
      (heading) =>
        !sectionOf(heading).includes("for production's code until this build is deployed") &&
        !sectionOf(heading).includes("D2's move remains for production's code"),
    ) &&
    sectionOf('## 11. ').includes("revision 8e's closed poll with no voter while `pollsEnabled` is false"),
);
// R8E-SEC-1: the switch goes on only while the poll is open, in gate 5's list and platform's runbook row.
check(
  "gate 5 and platform's row read openPollAt(now) before the switch (R8E-SEC-1)",
  sectionOf('## 12. ').includes(
    'and the operator reads, before the switch, that `openPollAt(now)` names the poll it is switched on for (revision 8f, R8E-SEC-1)',
  ) &&
    sectionOf('## 25. Revision 8f').includes(
      '`POLLS_ENABLED` goes "true" only while `openPollAt(now)` names the poll it is switched on for (R8E-SEC-1)',
    ),
);
// R8E-SEC-3: a waiting answer of (a) falls through; engine-runtime's and qa's case.
check(
  "a waiting answer of the job's choice falls through to the next poll, (b), (c) and (d) (R8E-SEC-3); since revision 8g only F3's, to the next poll of pollsToTallyAt(now) (R8F-SEC-3, F8F-B3)",
  sectionOf('## 5. ').includes(
    "in the job's run, an F3 `waiting` answer of (a), made with no chain read, does not end the run's choice (gating's `waiting`, after a chain read, ends the run with `done` as before): the run goes on to the next poll of `pollsToTallyAt(now)` without a result (within the lookback; a poll past it is never tallied by the job), then to (b), (c) and (d), as if (a) had not applied",
  ) &&
    !sectionOf('## 5. ').includes("a `waiting` answer of (a) does not end the run's choice") &&
    !sectionOf('## 5. ').includes('the run goes on to the next watched poll without a result') &&
    ['## 5. ', '## 11. '].every((heading) =>
      sectionOf(heading).includes('watched failing with the fall-through removed'),
    ) &&
    sectionOf('## 25. Revision 8f')
      .split('\n')
      .filter((line) => line.startsWith('| engine-runtime |') || line.startsWith('| qa |'))
      .every((line) => line.includes('where the purge deletes in the same run')),
);
// R8E-B4: F3's waiting told from gating's by the run's chain read.
check(
  "F3's waiting is told from gating's by the run's chain read, with a case for engine-runtime and qa (R8E-B4)",
  sectionOf('## 5. ').includes(
    "The job tells F3's `waiting` from gating's by whether the run made a chain read, never by `pollsEnabled` and the outcome alone",
  ) &&
    sectionOf('## 25. Revision 8f')
      .split('\n')
      .filter((line) => line.startsWith('| engine-runtime |') || line.startsWith('| qa |'))
      .every((line) =>
        line.includes(
          'the tally answers `waiting` after its chain read and the job answers `done` to the step (R8E-B4)',
        ),
      ),
);
// R8E-B2: isThirdPartyEndpoint from @prix/market/chain on the input URL; qa's endpoints at PUBLIC_RPC_URLS.
check(
  "engine-runtime imports isThirdPartyEndpoint from @prix/market/chain on the input URL, and qa's fake serves PUBLIC_RPC_URLS (R8E-B2)",
  sectionOf('## 25. Revision 8f').includes(
    "an answer whose input URL (the string, a URL's href or a Request's url, never `endpointHost`'s host) is not a third party by `isThirdPartyEndpoint`, imported from `@prix/market/chain` (the root index does not export it; packages/runtime already depends on @prix/market)",
  ) &&
    sectionOf('## 25. Revision 8f').includes(
      'its three endpoints answer at the URLs of `PUBLIC_RPC_URLS`, so that `isThirdPartyEndpoint` and the agreement see them as production does',
    ) &&
    !sectionOf('## 25. Revision 8f').includes('an answer of a host that is not a third party'),
);
// R8E-B5: section 9's row names the endpoint taken alone.
check(
  "section 9's slow-mark row names the endpoint taken alone, and the old label is gone (R8E-B5)",
  sectionOf('## 9. ').includes(
    '| Milliseconds after which an answer of an endpoint taken alone (never a third party) marks its endpoint |',
  ) && !sectionOf('## 9. ').includes('| Milliseconds after which an answer marks its endpoint |'),
);
// R8E-SEC-4: a waiting run's statements, from their parts.
check(
  "a waiting run's statements are the job's results read, the skip gate, the tally's results read, the configuration's read and the first listVoters page (R8E-SEC-4)",
  POLL_TALLY_WAITING_STATEMENTS === 1 + 1 + 1 + POLL_TALLY_RUN_CONFIG_READS + 1 && POLL_TALLY_WAITING_STATEMENTS === 5,
);
// F2 (CR8D-2): the window case takes its head from an endpoint publicnode leads, never from raised latency.
check(
  "qa's window case takes a head 30 blocks behind publicnode's, never raised latency (F2, CR8D-2)",
  ['## 5. ', '## 11. ', '## 24. Revision 8e'].every((heading) =>
    sectionOf(heading).includes('with a head 30 blocks behind publicnode'),
  ) &&
    sectionOf('## 5. ').includes('the fake judges a block tag against its head when it receives the request') &&
    !sectionOf('## 5. ').includes("the fake's latency raised until") &&
    !sectionOf('## 11. ').includes("raising the fake's latency until") &&
    !sectionOf('## 24. Revision 8e').includes("the fake's latency raised until"),
);
// F1 (R8D-SEC-1, CR8D-1): qa's slow third parties, in sections 5, 11 and 24.
check(
  "qa has the slow third parties' cases, watched failing with the mark applied to third parties (F1)",
  ['## 5. ', '## 11. ', '## 24. Revision 8e'].every(
    (heading) =>
      sectionOf(heading).includes('head read after 1,000 ms') &&
      sectionOf(heading).includes('the slow mark applied to third parties'),
  ),
);
// R8D-SEC-4; revision 8f (R8E-B1, with R8E-SEC-2): the move's tree is one commit on main that also brings every pin
// of the old date that the full check list runs, made and checked on a branch before the move's moment; in gate 5,
// section 13 and platform's row; revision 8e's "one edit ... and nothing else of the contract" sentence is gone there.
const moveCommit =
  "The move is one commit on main, the tree production runs: the edit of that poll's `closesAt` in `HOLDER_POLLS` and, in the same commit, every pin of the old date that the full check list runs on main (at 9e9f4e31: `CLOSES` in tests/holders/support.ts, read by tests/holders/poll-vote.d1.test.ts and poll-tally.d1.test.ts), written by qa or by the operator under this sentence's exception, and nothing else of the contract; the operator makes that commit on a branch of main and runs the full check list on it before 2026-10-19 20:00 UTC, so that the move's moment only deploys it; the full check list passes on it, chained to the deploy of prix-api outside 14:30 to 16:15 UTC on a trading day";
// Revision 8g (H1: F8F-B1, R8F-SEC-1, PF5-SEC-2; F8F-B2): the move's list of pins is the readers' whole list, and
// its build-branch clause names the build branch's tests, the full check list and Model War 2's start; section 25's
// row keeps revision 8f's words as its history, and section 26's platform row carries 8g's.
const moveCommit8g = moveCommit.replace(
  '(at 9e9f4e31: `CLOSES` in tests/holders/support.ts, read by tests/holders/poll-vote.d1.test.ts and poll-tally.d1.test.ts)',
  '(at 821b1a11: `CLOSES` in tests/holders/support.ts, read by tests/holders/poll-vote.d1.test.ts and poll-tally.d1.test.ts, and the moments after the close typed in tests/holders/poll-vote.d1.test.ts:93 and apps/api/src/http/holders-polls.test.ts:234, 236 and 303; a pin is any literal moment a test chose from the old close, each moved by the same whole days as `closesAt`; the new `closesAt` is the old one plus whole days, named in the same edit)',
);
const moveBuildBranch8g =
  "where every pin of the first poll's dates in phase6-holders.check.mts and in the build branch's tests (apps/api/src/http/holders-polls.test.ts among them) is brought to the new date, and the check and the full check list pass; the rule that the poll closes before Model War 1 ends (2026-10-22) is replaced, for a move past that day, by the rule that it closes before Model War 2's start, which the operator names in the same edit and tells the founder with the new date";
check(
  "gate 5, section 13 and platform's row name the move's one commit with its date pins and its deploy window (R8D-SEC-4, R8E-B1, R8E-SEC-2; revision 8g, H1: F8F-B1, R8F-SEC-1, PF5-SEC-2, F8F-B2)",
  moveCommit8g !== moveCommit &&
    ['## 12. ', '## 13. '].every(
      (heading) =>
        sectionOf(heading).includes(moveCommit8g) &&
        sectionOf(heading).includes(moveBuildBranch8g) &&
        !sectionOf(heading).includes('(at 9e9f4e31:') &&
        !sectionOf(heading).includes(
          "where every pin of the first poll's dates in phase6-holders.check.mts is brought to the new date and the check passes",
        ) &&
        !sectionOf(heading).includes("The move is one edit of that poll's `closesAt`") &&
        !sectionOf(heading).includes("where the check's pinned move moment is brought to the new date"),
    ) &&
    sectionOf('## 26. Revision 8g').includes(moveCommit8g.replace('The move is', 'the move is')) &&
    sectionOf('## 26. Revision 8g').includes(moveBuildBranch8g) &&
    sectionOf('## 25. Revision 8f').includes(moveCommit.replace('The move is', 'the move is')) &&
    sectionOf('## 25. Revision 8f').includes(
      "tests/holders/support.ts takes `OPENS` and `CLOSES` from `HOLDER_POLLS[0]`, never typed, so that a move of the close is one edit on the build's branch (R8E-B1)",
    ),
);
// Revision 8f: the status line names it first, on a UTC day, and section 25 lists G1 to G4, every finding of both
// readers of revision 8e, which wording was taken where two readers worded one point, and the one build table.
check(
  'the status line names revision 8f before 8e, on a UTC day (G4)',
  /^Revision 8f, 2026-10-17: /m.test(doc) &&
    doc.indexOf('Revision 8f, 2026-10-17') < doc.indexOf('Revision 8e, 2026-10-16'),
);
check(
  'the document lists revision 8f with G1 to G4, every finding of both readers of 8e, the fuller wording named and the one build table (G4)',
  [
    '**G1 (R8E-SEC-1 and R8E-B3, one point).**',
    "R8E-SEC-1's wording is the fuller",
    '**G2 (R8E-B1 and R8E-SEC-2, one point).**',
    "R8E-B1's wording is the fuller",
    '**G3 (R8E-SEC-3, R8E-SEC-4, R8E-B2, R8E-B4, R8E-B5).**',
    '**G4.**',
    'the operator adds no rule of its own this time',
  ].every((f) => sectionOf('## 25. Revision 8f').includes(f)) &&
    ['R8E-SEC-1', 'R8E-SEC-2', 'R8E-SEC-3', 'R8E-SEC-4', 'R8E-B1', 'R8E-B2', 'R8E-B3', 'R8E-B4', 'R8E-B5'].every((id) =>
      sectionOf('## 25. Revision 8f').includes(`| ${id} |`),
    ) &&
    [
      '| engine-runtime |',
      '| platform |',
      '| design-system |',
      '| editor |',
      '| web-account |',
      '| qa |',
      '| perf |',
    ].every((row) => sectionOf('## 25. Revision 8f').includes(row)) &&
    sectionOf('## 25. Revision 8f').includes(
      'It replaces the tables of sections 22, 23 and 24: the builders read this table alone',
    ) &&
    sectionOf('## 24. Revision 8e').includes("Since revision 8f, section 25's table replaces this one") &&
    sectionOf('## 25. Revision 8f').includes(
      '`POLLS_ENABLED` stays "false", `LEAGUE_POST` "off" and `HOLDERS_LOUNGE` "off"',
    ) &&
    sectionOf('## 25. Revision 8f').includes('counted in that drive against `POLL_TALLY_WAITING_STATEMENTS` (5)'),
);
check(
  "section 25's table points at section 26's (revision 8g)",
  sectionOf('## 25. Revision 8f').includes("Since revision 8g, section 26's table replaces this one"),
);

// --- Revision 8g (H1 to H6) ----------------------------------------------------------------------------------------
// H2 (PF5-SEC-1): an answer outside 2xx has its body cancelled unread and the fetch rejects with the carry-nothing
// error; engine-runtime's and qa's rows carry the look's fix and cases.
check(
  'section 5 rule 2: an answer outside 2xx has its body cancelled unread and the fetch rejects with the carry-nothing error (H2, PF5-SEC-1)',
  sectionOf('## 5. ').includes(
    "when its answer's HTTP status is not 2xx (429 among them); such an answer's body is cancelled unread and the fetch rejects with the carry-nothing error, so no body outside 2xx is read by anyone",
  ) &&
    sectionOf('## 26. Revision 8g')
      .split('\n')
      .some(
        (line) =>
          line.startsWith('| engine-runtime |') &&
          line.includes('`response.body?.cancel().catch(() => undefined); return refuse();`') &&
          line.includes('a 429 whose body never ends rejects within `POLL_TALLY_FETCH_TIMEOUT_MS` and marks its host'),
      ) &&
    sectionOf('## 26. Revision 8g')
      .split('\n')
      .some(
        (line) =>
          line.startsWith('| qa |') &&
          line.includes("a 'status' plan with a stalled body") &&
          line.includes('the official endpoint answers 429 with a stalled body'),
      ) &&
    ['## 5. ', '## 11. '].every((heading) => sectionOf(heading).includes('with a stalled body')),
);
// H3 (R8F-SEC-2, PF5-SEC-3, F8F-B3 (iii)): the worst idle run and the runs behind waiting polls, from their parts.
check(
  'the worst idle run once a waiting answer falls through is 10, and the tally and prune runs behind waiting polls 18 and 18 (H3, R8F-SEC-2)',
  POLL_TALLY_WAITING_POLL_STATEMENTS === 2 &&
    POLL_TALLY_IDLE_STATEMENTS_MAX === 1 + 1 + POLL_TALLY_RUN_CONFIG_READS + 2 * POLL_PURGE_MAX_POLLS + 1 &&
    POLL_TALLY_IDLE_STATEMENTS_MAX === 10 &&
    POLL_TALLY_RUN_STATEMENTS_BEHIND_WAITING_MAX === POLL_TALLY_RUN_STATEMENTS_MAX + 2 * (POLL_PURGE_MAX_POLLS - 1) &&
    POLL_TALLY_RUN_STATEMENTS_BEHIND_WAITING_MAX === 18 &&
    POLL_PRUNE_RUN_STATEMENTS_BEHIND_WAITING_MAX === POLL_PRUNE_RUN_STATEMENTS_MAX + POLL_PURGE_MAX_POLLS &&
    POLL_PRUNE_RUN_STATEMENTS_BEHIND_WAITING_MAX === 18 &&
    [
      POLL_TALLY_IDLE_STATEMENTS_MAX,
      POLL_TALLY_RUN_STATEMENTS_BEHIND_WAITING_MAX,
      POLL_PRUNE_RUN_STATEMENTS_BEHIND_WAITING_MAX,
    ].every((n) => n <= SOCIAL_JOB_MAX_STATEMENTS),
);
check(
  "section 5 and section 26 book the worst idle run at 10 and the sweep's sum at 48 of 50; perf drives three waiting polls and an open poll (H3)",
  sectionOf('## 5. ').includes(
    "its worst is `POLL_TALLY_IDLE_STATEMENTS_MAX` (10), which that section 8 books in the sweep's sum, 48 of 50",
  ) &&
    sectionOf('## 26. Revision 8g')
      .split('\n')
      .some(
        (line) =>
          line.startsWith('| perf |') &&
          line.includes('three waiting polls and an open poll in the first five minutes of an hour') &&
          line.includes('48 of 50'),
      ),
);
// H4 (R8F-SEC-3, F8F-B3): the flag set again by a later listVoters; engine-runtime's and qa's cases.
check(
  "the reached-reads flag is cleared at the F3 moment only and set again by a later listVoters; engine-runtime's and qa's cases (H4, F8F-B3, R8F-SEC-3)",
  sectionOf('## 5. ').includes(
    "the job clears its reached-reads flag at that moment only: a later `listVoters` of the same run (the next poll's tally or the prune) sets it again, and the run then answers `done` to the step",
  ) &&
    ['## 5. ', '## 11. '].every(
      (heading) =>
        sectionOf(heading).includes('watched failing with the flag set once a run') &&
        sectionOf(heading).includes('a poll past its lookback that has voters'),
    ) &&
    sectionOf('## 26. Revision 8g')
      .split('\n')
      .filter((line) => line.startsWith('| engine-runtime |') || line.startsWith('| qa |'))
      .every(
        (line) =>
          line.includes('a waiting poll with no voter beside a later closed poll with voters') &&
          line.includes('a waiting poll beside a poll past its lookback that has voters'),
      ),
);
// H4: pollsToTallyAt bounds the fall-through by the lookback.
{
  const past = {
    ...HOLDER_POLLS[0],
    id: 'past-lookback',
    opensAt: '2026-09-01T00:00:00.000Z',
    closesAt: '2026-09-08T20:00:00.000Z',
  } as (typeof HOLDER_POLLS)[number];
  const now = at('2026-09-20T00:00:00.000Z');
  check(
    'a poll past its lookback is watched and never in pollsToTallyAt (H4, R8F-SEC-3)',
    pollsWatchedAt(now, [past]).length === 1 && pollsToTallyAt(now, [past]).length === 0,
  );
}
// H5: qa's never-answering case at 250 ms a fetch; the contract's figure stays 300.
check(
  "qa's never-answering case runs at 250 ms a fetch, 4,000 ms of pure waiting of 5,000; POLL_TALLY_FETCH_LATENCY_MS stays 300 (H5)",
  POLL_TALLY_QA_NEVER_ANSWERING_LATENCY_MS === 250 &&
    POLL_TALLY_FETCH_LATENCY_MS === 300 &&
    pollTallyWorstReadMs(POLL_MAX_VOTERS, POLL_TALLY_QA_NEVER_ANSWERING_LATENCY_MS).neverAnswering === 4_000 &&
    pollTallyWorstReadMs(POLL_MAX_VOTERS).neverAnswering === 4_500 &&
    POLL_TALLY_MAX_RUN_SECONDS * 1_000 -
      pollTallyWorstReadMs(POLL_MAX_VOTERS, POLL_TALLY_QA_NEVER_ANSWERING_LATENCY_MS).neverAnswering ===
      1_000 &&
    sectionOf('## 26. Revision 8g')
      .split('\n')
      .some(
        (line) =>
          line.startsWith('| qa |') &&
          line.includes('`POLL_TALLY_QA_NEVER_ANSWERING_LATENCY_MS` (250 ms) a fetch') &&
          line.includes(
            "every other case keeps `POLL_TALLY_FETCH_LATENCY_MS` (300), which stays the contract's figure and gate 3's",
          ),
      ) &&
    ['## 5. ', '## 11. '].every((heading) =>
      sectionOf(heading).includes('`POLL_TALLY_QA_NEVER_ANSWERING_LATENCY_MS` (250'),
    ),
);
// H5: the operator's gate-3 tail read on the real endpoints, 04:13 UTC on 2026-10-17, does not hold the switch.
check(
  "the operator's tail read of 2026-10-17 04:13 UTC holds nothing: publicnode p95 315, largest 378; dRPC p95 189, largest 295 (H5)",
  !pollTallyTailHolds(315, 378) &&
    !pollTallyTailHolds(189, 295) &&
    sectionOf('## 26. Revision 8g').includes('publicnode p95 315 ms, largest 378; dRPC p95 189 ms, largest 295'),
);
// H6 in the document's section 8 and section 26's editor and web-site rows.
check(
  "section 8 prints token.holdersNowTitle as \"The holders' poll is open\", and the editor's and web-site's rows follow (H6)",
  doc.includes("| `token.holdersNowTitle` | The holders' poll is open |") &&
    !doc.includes('| `token.holdersNowTitle` | Open for holders now |') &&
    ['| editor |', '| web-site |'].every((row) =>
      sectionOf('## 26. Revision 8g')
        .split('\n')
        .some((line) => line.startsWith(row) && line.includes("The holders' poll is open")),
    ),
);
check(
  'the status line names revision 8g before 8f, on a UTC day',
  /^Revision 8g, 2026-10-17: /m.test(doc) &&
    doc.indexOf('Revision 8g, 2026-10-17') < doc.indexOf('Revision 8f, 2026-10-17'),
);
check(
  'the document lists revision 8g with H1 to H6, every finding of the readers and the looks, and the one build table',
  [
    '**H1 (F8F-B1 medium, R8F-SEC-1, PF5-SEC-2; with F8F-B2).**',
    '**H2 (PF5-SEC-1 medium).**',
    '**H3 (R8F-SEC-2, PF5-SEC-3; with F8F-B3 (iii)).**',
    '**H4 (R8F-SEC-3, F8F-B3 (i) and (ii)).**',
    "**H5 (the integration's failure).**",
    '**H6 (POLL5-DC-2).**',
    'It replaces the tables of sections 22 to 25: the builders read this table alone',
    '`POLLS_ENABLED` stays "false", `LEAGUE_POST` "off" and `HOLDERS_LOUNGE` "off"',
  ].every((f) => sectionOf('## 26. Revision 8g').includes(f)) &&
    [
      'F8F-B1',
      'R8F-SEC-1',
      'PF5-SEC-2',
      'F8F-B2',
      'PF5-SEC-1',
      'R8F-SEC-2',
      'PF5-SEC-3',
      'R8F-SEC-3',
      'F8F-B3',
      'POLL5-DC-1',
      'POLL5-DC-2',
    ].every((id) => sectionOf('## 26. Revision 8g').includes(`| ${id} |`)) &&
    ['| engine-runtime |', '| qa |', '| perf |', '| platform |', '| editor |', '| web-account |', '| web-site |'].every(
      (row) => sectionOf('## 26. Revision 8g').includes(row),
    ),
);

console.log(failures === 0 ? 'ALL OK' : `${failures} FAILED`);
runtime?.exit(failures === 0 ? 0 : 1);
