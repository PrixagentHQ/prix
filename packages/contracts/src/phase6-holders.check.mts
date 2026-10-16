// The operator's check of the holders contract (phase6-holders.ts, docs/contracts/phase-6-holders.md), revision 6.
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
  POLL_MAX_VOTERS,
  POLL_MIN_TIER,
  POLL_PRUNE_AT,
  POLL_PRUNE_EVERY_SECONDS,
  POLL_PRUNE_MAX_COUNT_ROWS_PER_DAY,
  POLL_PRUNE_MAX_VOTE_ROWS_PER_DAY,
  POLL_PURGE_PER_RUN,
  POLL_READ_CACHE_SECONDS,
  POLL_REFUSALS,
  POLL_TALLY_BLOCK_MARGIN,
  POLL_TALLY_DELAY_LABEL,
  POLL_TALLY_DELAY_MODULO_SECONDS,
  POLL_TALLY_FAIL_STEPS,
  POLL_TALLY_FAILED_ERROR,
  POLL_TALLY_JOB_OUTCOMES,
  POLL_TALLY_LOOKBACK_DAYS,
  POLL_TALLY_MAX_CHAIN_READS,
  POLL_TALLY_MAX_FETCHES,
  POLL_TALLY_MAX_PAGES,
  POLL_TALLY_MAX_RUN_SECONDS,
  POLL_TALLY_PAGE,
  POLL_TALLY_PAGE_CPU_MS,
  POLL_TALLY_RUN_CPU_MS,
  POLL_TALLY_SETTLE_SECONDS,
  POLL_VOTE_WRITE_ROWS,
  POLL_WATCH_DAYS,
  PRIX_SUPPLY_WHOLE,
  pollById,
  pollExpiredLogDue,
  pollIdSchema,
  pollLeaders,
  pollOptionIdSchema,
  pollPruneDue,
  pollPublicStateAt,
  pollStateAt,
  pollsToTallyAt,
  pollsWatchedAt,
  pollTallyDelaySeconds,
  pollTallyDueAt,
  pollTallyExpired,
  pollTallyOutcomeSchema,
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
  'the cap is a guard of 4,000, read in 10 calls of 400 after one at the head (H-SEC-1, H2-SEC-5)',
  POLL_MAX_VOTERS === 4_000 && POLL_TALLY_PAGE === 400 && POLL_TALLY_MAX_CHAIN_READS === 11,
);
check(
  'the prune runs from 3,600 votes, at most once an hour, below the cap (H2-SEC-1)',
  POLL_PRUNE_AT === 3_600 && POLL_PRUNE_EVERY_SECONDS === 3_600 && POLL_PRUNE_AT < POLL_MAX_VOTERS,
);
check(
  'the prune is due only in the first five minutes of an hour',
  pollPruneDue(at('2026-10-17T13:03:10.000Z')) &&
    !pollPruneDue(at('2026-10-17T13:08:10.000Z')) &&
    !pollPruneDue(at('2026-10-17T13:58:10.000Z')),
);
check(
  'the run reads 50 blocks behind the first head and reads for at most 8 seconds (H2-SEC-5, HB3-5)',
  POLL_TALLY_BLOCK_MARGIN === 50 && POLL_TALLY_MAX_RUN_SECONDS === 8,
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
check(
  "the tally's fetches are capped at 30, above two a chain read (H2-SEC-4, HB-12)",
  POLL_TALLY_MAX_FETCHES === 30 && 2 * POLL_TALLY_MAX_CHAIN_READS <= POLL_TALLY_MAX_FETCHES,
);
check(
  "the tally's CPU: a page at most 0.7 ms, the run at most 8 ms, inside the step's 10 (HB-1, HB-12)",
  POLL_TALLY_PAGE_CPU_MS === 0.7 &&
    POLL_TALLY_RUN_CPU_MS === 8 &&
    POLL_TALLY_PAGE_CPU_MS * POLL_TALLY_MAX_CHAIN_READS <= POLL_TALLY_RUN_CPU_MS &&
    POLL_TALLY_RUN_CPU_MS < SOCIAL_STEP_CPU_MS,
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
const tallyStatements = 1 + 1 + 1 + POLL_TALLY_MAX_PAGES + 4;
// One more when the run clears a failure count of the guard (common.ts, putCount when known > 0).
const tallyStatementsWithClear = tallyStatements + 1;
// The prune (H2-SEC-1): the skip gate, castCounts, the pages, pruneVoters' one batch of two statements, the clear.
const pruneStatementsWithClear = 1 + 1 + POLL_TALLY_MAX_PAGES + 2 + 1;
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
const otherWords = Object.entries(HOLDERS_COPY)
  .filter(([key]) => key !== 'token.perkRealtime')
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
    "the job's results read + the skip gate + tallyPoll's results read + pages + 4 option rows",
  ],
  ["Statements in a tally run with the guard's clear", tallyStatementsWithClear, 'one more: the failure count cleared'],
  [
    "Statements in a prune run with the guard's clear",
    pruneStatementsWithClear,
    'the skip gate + castCounts + pages + the prune batch of 2 + the clear',
  ],
  [
    'Subrequests of the chain in a tally run whose endpoints answer, at most',
    2 * POLL_TALLY_MAX_CHAIN_READS,
    'two a chain read only when a third-party fallback must be confirmed',
  ],
  ['Fetches of the chain in a tally run, hard cap', POLL_TALLY_MAX_FETCHES, 'POLL_TALLY_MAX_FETCHES'],
  ['Blocks the run reads behind the first head', POLL_TALLY_BLOCK_MARGIN, 'POLL_TALLY_BLOCK_MARGIN'],
  ['Seconds a tally run may read, at most', POLL_TALLY_MAX_RUN_SECONDS, 'POLL_TALLY_MAX_RUN_SECONDS'],
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
  ['CPU of one tally page, at most (ms)', POLL_TALLY_PAGE_CPU_MS, 'POLL_TALLY_PAGE_CPU_MS'],
  ['CPU of the worst tally run, at most (ms)', POLL_TALLY_RUN_CPU_MS, "POLL_TALLY_RUN_CPU_MS, inside the step's 10"],
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
  "the document lists the operator's four decisions of revision 6 in its section 18 (R1 to R4)",
  doc.includes('## 18. Revision 6') &&
    ['R1', 'R2', 'R3', 'R4'].every((id) => sectionOf('## 18. Revision 6').includes(`| ${id} |`)) &&
    ['HB1F-SEC-1', 'HB1F-SEC-2', 'HB1F-SEC-3', 'DC6-1', 'DC6-2', 'DC6-3', 'DC6-4', 'DC6-5'].every((id) =>
      sectionOf('## 18. Revision 6').includes(id),
    ),
);
check(
  'sections 7 and 11 send TELEGRAM_ALLOWED_UPDATES and never allowed_updates ["message"] alone (R1)',
  ['## 7. ', '## 11. '].every((heading) => {
    const text = sectionOf(heading);
    return (
      text.includes('TELEGRAM_ALLOWED_UPDATES') && !text.includes('["message"]`') && !/\["message"\] and/.test(text)
    );
  }) &&
    sectionOf('## 7. ').includes('allowedUpdates: readonly TelegramUpdateKind[]') &&
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
  'section 18 "Revision 6" holds the two switch conditions and keeps every switch off (R4)',
  sectionOf('## 18. Revision 6').includes('**Before `POLLS_ENABLED` is "true":**') &&
    sectionOf('## 18. Revision 6').includes('**Before `HOLDERS_LOUNGE` is "on":**') &&
    sectionOf('## 18. Revision 6').includes('`allowed_updates` with `TELEGRAM_ALLOWED_UPDATES`') &&
    sectionOf('## 18. Revision 6').includes(
      '`POLLS_ENABLED` stays "false", `LEAGUE_POST` "off" and `HOLDERS_LOUNGE` "off"',
    ),
);
check(
  'the status line names revision 6 first',
  /^Revision 6, 2026-10-16: /m.test(doc) &&
    doc.indexOf('Revision 6, 2026-10-16') < doc.indexOf('Revision 5, 2026-10-16'),
);

console.log(failures === 0 ? 'ALL OK' : `${failures} FAILED`);
runtime?.exit(failures === 0 ? 0 : 1);
