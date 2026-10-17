import type { ApiDeps } from './api.ts';
import { API_WRITE_ROWS_PER_DAY } from './constants.ts';
import { type Entitlements, type EntitlementsPort, TIER_RULES, type Tier } from './entitlements.ts';
import type { TokenChainReader } from './phase4-token.ts';
import { MANAGER_SLOTS_BY_TIER, type SocialJob, type SocialJobOutcome } from './phase6-social.ts';
import type { Address, IsoTime, TickId, UtcDay } from './primitives.ts';
import { isoTimeSchema } from './primitives.ts';
import { z } from './zod.ts';

/**
 * Phase 6.7, the holders round (D-158): what holding $PRIX gives, said on the token page (A), the mark
 * "Owner holds $PRIX" on an agent's own page (B), the holders' poll (C), a daily league post in the
 * Telegram group (D), and the follow alerts' switch-on runbook (E, no code). The rules are in
 * docs/contracts/phase-6-holders.md; this file holds the shapes, the figures and the pure rules, and
 * `phase6-holders.check.mts` pins every one of them. Revision 2 (2026-10-16) takes the security reader's
 * twelve findings (H-SEC-1 to H-SEC-12); the document's section 15 lists each and where it went. Revision 3
 * (2026-10-16) takes the second look's findings (H2-SEC-1 to H2-SEC-10 of the security reader, HB-1 to HB-13
 * of the builder's reader); the document's section 16 lists each and where it went. Revision 4 (2026-10-16)
 * takes the third look's findings (H3-SEC-1 to H3-SEC-10, HB3-1 to HB3-10); the document's section 17 lists
 * each and where it went. Revision 5 (2026-10-16) takes the operator's decisions D1 to D5 on the design look of
 * the build (DC5-1 to DC5-4) and on the fix pass's three copy changes (HB-DC-4, HB-DC-6, HB-DC-7): the `badge`
 * row folds the tier table into "Open to holders now", `token.holdersColTier`, `token.holdersSwipe`,
 * `token.perkBadge`, the `{delay}` slot of `token.perkRealtime`, `token.holdersBadgeLabel` removed and
 * `polls.castNote` reworded; the document's section 18 lists each and where it went. Revision 6 (2026-10-16)
 * takes the operator's decisions R1 to R4 on the two looks of holders1b-final (HB1F-SEC-1 to HB1F-SEC-3, DC6-2 and
 * the owners' asks): the admin route sends TELEGRAM_ALLOWED_UPDATES and `TelegramPort.setWebhook` takes
 * `readonly TelegramUpdateKind[]`, `token.perkRealtime` reads "... not {delay} later", the delay's prop and the
 * phone clamp are named, and two conditions are added to POLLS_ENABLED and HOLDERS_LOUNGE; the document's
 * section 19 "Revision 6" lists each and where it went. Revision 7 (2026-10-16) takes the security look's
 * HB1F2-SEC-1 and HB1F2-SEC-2 on holders1b-fix-3: R4's conditions stand in sections 4.6, 5 and 12 gate 5
 * (`pollTallyStepAnswer`), the job's worst non-idle runs are booked in phase-6-holders-2.md section 8
 * (`POLL_TALLY_RUN_STATEMENTS_MAX`, `POLL_PRUNE_RUN_STATEMENTS_MAX`), the lounge's condition stands in that
 * document's gate 4, and `TelegramPort.setWebhook` takes a non-empty tuple; section 20 lists each. Revision 8
 * (2026-10-16) takes the operator's decisions R8-1 to R8-4 on the looks of holders-polls-1 (PT-G3-CPU, PT-FETCH-1,
 * PT-PURGE-1): the social step's CPU is booked against its Durable Object alarm (SOCIAL_STEP_CPU_MS 1,000,
 * POLL_TALLY_RUN_CPU_MS 500, the 0.7 ms a page rule gone), an endpoint that failed once in a run is not asked
 * again, the worst tally and prune runs with one endpoint down are one sum against the step's 50, which took
 * POLL_MAX_VOTERS to 3,600, POLL_PRUNE_AT to 3,200 and POLL_TALLY_MAX_FETCHES to 21, and the purge tries at
 * most POLL_PURGE_MAX_POLLS polls a run; section 21 lists each. Revision 8b (2026-10-16) takes the two readers'
 * findings on revision 8: the Free plan's CPU read as 10 ms with Prix's ceilings observed and not promised, and
 * POLL_TALLY_JOB as the remedy (R8-SEC-1); the clock fan-out and the token configuration's read in the one sum,
 * which took POLL_MAX_VOTERS to 3,200, POLL_PRUNE_AT to 2,800 and POLL_TALLY_MAX_FETCHES to 19 (R8-SEC-2,
 * R8B-1); the meter's timeout and answer cap (R8-SEC-3, R8-SEC-4); section 21 "Revision 8b" lists each.
 * Revision 8c (2026-10-16) takes the operator's decisions C1 to C3 on the confirming looks of revision 8b: the run's
 * seconds computed from the keyless endpoints' block window (POLL_TALLY_KEYLESS_STATE_BLOCKS,
 * POLL_TALLY_CHAIN_BLOCKS_PER_SECOND) at the kept margin of 50, which with the 429 case and the never-answering
 * case in the check's step down took POLL_MAX_VOTERS to 1,600, POLL_PRUNE_AT to 1,200 and POLL_TALLY_MAX_FETCHES
 * to 11 (CR8B-1); POLL_MAX_VOTERS as the remedy's lever (CR8B-2); the slow tail of a page's read in gate 3
 * (POLL_TALLY_TAIL_READS_MIN, POLL_TALLY_TAIL_P95_MAX_MS, C2); section 21 "Revision 8c" lists each.
 * Revision 8d (2026-10-16) takes the operator's decisions D1 to D6 on the confirming looks of revision 8c (R8C-SEC-1
 * to R8C-SEC-5, CR8C-1 to CR8C-8): POLL_TALLY_JOB "off" always brings POLLS_ENABLED "false" in the same deploy,
 * and the runbook has exactly three states (POLL_RUNBOOK_STATES, D1); a poll whose closesAt is 48 hours away while
 * POLLS_ENABLED is not "true" has its closesAt moved by a revision (pollCloseMoveDue, D2); the tail rule bounds the
 * largest read too (pollTallyTailHolds(p95Ms, maxMs), D3); an answer later than POLL_TALLY_SLOW_ANSWER_MS marks its
 * endpoint (D4); the step down never settles below POLL_MAX_VOTERS_FLOOR, and the count of tier-1 wallets stands
 * under half the cap (D5); section 23 "Revision 8d" lists each.
 * Revision 8e (2026-10-16) takes the operator's decisions F1 to F5 on the confirming looks of revision 8d (R8D-SEC-1 to
 * R8D-SEC-5, CR8D-1 to CR8D-6): the slow-answer mark applies only to an endpoint whose answer is taken alone, never
 * to a third party (pollTallySlowAnswerMarks(elapsedMs, takenAlone), F1), and the step down also fits the third
 * party's tail (pollTallyWorstReadMs thirdPartyTail); qa's window case with a head from an endpoint publicnode leads
 * (F2); while POLLS_ENABLED is not "true" a run that finds no voter for a closed poll writes no result
 * (PollTallyJobDeps.pollsEnabled, F3); the tier-1 count, the tail sample, the latency's revision
 * (pollTallyLatencyFromMeans), the close move's tree and moment (pollCloseMoveDue's pollsEnabledAtMoveTime) and the
 * three config states (F4); section 24 "Revision 8e" lists each.
 * Revision 8f (2026-10-17) takes every finding of revision 8e's two readers as worded (R8E-SEC-1 to R8E-SEC-4,
 * R8E-B1 to R8E-B5): the close move stays the rule whichever code production runs, and POLLS_ENABLED goes "true"
 * only while openPollAt(now) names the poll (R8E-SEC-1, R8E-B3); the move is one commit on main that also brings
 * every pin of the old date that the full check list runs (R8E-B1, R8E-SEC-2); a waiting answer of the job's choice
 * falls through to the next poll, the purge and the prune (R8E-SEC-3); a waiting run is booked at
 * POLL_TALLY_WAITING_STATEMENTS (R8E-SEC-4); isThirdPartyEndpoint from @prix/market/chain on the input URL
 * (R8E-B2); F3's waiting told from gating's by the run's chain read (R8E-B4); section 9's slow-mark row (R8E-B5);
 * section 25 "Revision 8f" lists each.
 * Revision 8g (2026-10-17) takes the operator's decisions H1 to H6 on revision 8f's readers (R8F-SEC-1 to R8F-SEC-3,
 * F8F-B1 to F8F-B3) and on the looks of holders-polls-integrated-5 (PF5-SEC-1 to PF5-SEC-3, POLL5-DC-1, POLL5-DC-2):
 * the close move's list of pins is the readers' whole list, with Model War 2's start named for a move past 2026-10-22
 * (H1); an answer outside 2xx has its body cancelled unread and the fetch rejects with the carry-nothing error (H2);
 * POLL_TALLY_IDLE_STATEMENTS_MAX (10) booked in the sweep's sum, 48 of 50, and the tally and prune runs behind
 * waiting polls (POLL_TALLY_RUN_STATEMENTS_BEHIND_WAITING_MAX, POLL_PRUNE_RUN_STATEMENTS_BEHIND_WAITING_MAX) (H3);
 * the fall-through takes the next poll of pollsToTallyAt(now) and only an F3 waiting made with no chain read falls
 * through (H4); qa's never-answering case at POLL_TALLY_QA_NEVER_ANSWERING_LATENCY_MS (250) a fetch (H5);
 * token.holdersNowTitle reads "The holders' poll is open" (H6); section 26 "Revision 8g" lists each.
 *
 * What $PRIX gives is access to features, never a return. Nothing here reads a price, shows a value of
 * the token, ranks or orders by a holding, or touches Prix Live.
 */

// --- A. what holding gives, in whole tokens --------------------------------------------------------

/** The token's fixed supply in whole tokens: 1,000,000,000 (the Pons launch, docs/STATUS.md). */
export const PRIX_SUPPLY_WHOLE = 1_000_000_000;

/**
 * Whole tokens at a share of the supply in parts per million, rounded up so that the amount a page shows
 * is always enough: 10 ppm is 10,000, 100 ppm 100,000, 1,000 ppm 1,000,000. The page takes the ppm from
 * `GET /api/token`'s `tiers` (thresholds may only ever be lowered) and never a figure of its own.
 */
export function wholeTokensAtPpm(ppm: number): number {
  if (!Number.isSafeInteger(ppm) || ppm < 0) return 0;
  return Math.ceil((ppm * PRIX_SUPPLY_WHOLE) / 1_000_000);
}

/** The three amounts of the default thresholds: 10,000, 100,000 and 1,000,000. */
export const HOLDER_TIER_TOKENS: readonly [number, number, number] = [
  wholeTokensAtPpm(TIER_RULES[1]?.thresholdPpm ?? 0),
  wholeTokensAtPpm(TIER_RULES[2]?.thresholdPpm ?? 0),
  wholeTokensAtPpm(TIER_RULES[3]?.thresholdPpm ?? 0),
];

/**
 * One row of "Open to holders now". `byTier` is the figure at tiers 0 to 3; `fromTier` a yes from that
 * tier; `fromTokens` a yes from that many whole tokens whatever the tier (the room's rule); `external`
 * a perk whose amounts are another product's and come from the editor's facts (FOREHEAD's).
 */
export type HolderPerk =
  | { key: HolderPerkKey; kind: 'byTier'; byTier: readonly [number, number, number, number] }
  | { key: HolderPerkKey; kind: 'fromTier'; fromTier: 1 | 2 | 3 }
  | { key: HolderPerkKey; kind: 'fromTokens'; fromTokens: number }
  | { key: HolderPerkKey; kind: 'external' };

export const HOLDER_PERK_KEYS = [
  'agents',
  'realtime',
  'badge',
  'apiCalls',
  'managers',
  'templates',
  'notes',
  'chat',
  'pictures',
  'forehead',
  'ownerHolds',
] as const;
export type HolderPerkKey = (typeof HOLDER_PERK_KEYS)[number];

function tierFigures(pick: (tier: Tier) => number): readonly [number, number, number, number] {
  return [pick(0), pick(1), pick(2), pick(3)];
}
function ruleOf(tier: Tier): (typeof TIER_RULES)[number] {
  const rule = TIER_RULES.find((entry) => entry.tier === tier);
  if (rule === undefined) throw new Error(`No tier rule ${tier}.`);
  return rule;
}

/** The first tier whose rule gives real-time fills and reasons (1). */
const REALTIME_FROM: 1 | 2 | 3 = 1;
/**
 * The first tier whose TIER_RULES rule has `verifiedBadge` (2): the `badge` row of "Open to holders now"
 * (revision 5, D1), which folds the tier table's badge column into the holders table. Read from the rules, so a
 * change of the rules moves the row; the check pins it to that rule.
 */
export const HOLDER_BADGE_MIN_TIER: 1 | 2 | 3 = (() => {
  const rule = TIER_RULES.find((entry) => entry.verifiedBadge);
  if (rule === undefined || rule.tier === 0) throw new Error('No tier above 0 gives the verified badge.');
  return rule.tier;
})();
/** The tier from which `deliver.ts` sends decision notes (tier 0 is dropped, Phase 3). */
const NOTES_FROM: 1 | 2 | 3 = 1;
/** The tier from which an agent's own page carries "Owner holds $PRIX" (B). */
export const OWNER_HOLDS_MIN_TIER: 2 = 2;
/**
 * The tier from which the Build page shows its eight holder templates (D-161, revision 4, HB3-6): BuildPage.astro
 * reads `entitlements.tier >= 1` (main 947d6df0). The `templates` row is pinned to it by the check; web-account
 * may import it in place of the literal.
 */
export const HOLDER_TEMPLATES_MIN_TIER: 1 = 1;
/** The room's own rule (phase6-room.ts ROOM_WRITE_MIN_TOKENS), repeated here and pinned by the check. */
export const HOLDER_CHAT_MIN_TOKENS = 1;

/** "Open to holders now", in the order the page lists it. Every figure is read from the rule that grants it. */
export const HOLDER_PERKS: readonly HolderPerk[] = [
  { key: 'agents', kind: 'byTier', byTier: tierFigures((tier) => ruleOf(tier).maxAgents) },
  { key: 'realtime', kind: 'fromTier', fromTier: REALTIME_FROM },
  { key: 'badge', kind: 'fromTier', fromTier: HOLDER_BADGE_MIN_TIER },
  { key: 'apiCalls', kind: 'byTier', byTier: tierFigures((tier) => ruleOf(tier).apiDailyQuota) },
  { key: 'managers', kind: 'byTier', byTier: tierFigures((tier) => MANAGER_SLOTS_BY_TIER[tier]) },
  { key: 'templates', kind: 'fromTier', fromTier: HOLDER_TEMPLATES_MIN_TIER },
  { key: 'notes', kind: 'fromTier', fromTier: NOTES_FROM },
  { key: 'chat', kind: 'fromTokens', fromTokens: HOLDER_CHAT_MIN_TOKENS },
  { key: 'pictures', kind: 'fromTokens', fromTokens: HOLDER_CHAT_MIN_TOKENS },
  { key: 'forehead', kind: 'external' },
  { key: 'ownerHolds', kind: 'fromTier', fromTier: OWNER_HOLDS_MIN_TIER },
];

/**
 * Rows of HOLDER_PERKS the page does not show yet (revision 2, H-SEC-9). `notes` is dropped until browser
 * push has been seen to arrive on production (Telegram delivery is off while `TELEGRAM_BOT_USERNAME` is
 * ""); bringing it back is a contract revision that empties this list.
 */
export const HOLDER_PERKS_HIDDEN: readonly HolderPerkKey[] = ['notes'];

/**
 * The rows "Open to holders now" shows, in order: HOLDER_PERKS without HOLDER_PERKS_HIDDEN, and without
 * `pictures` unless the room's public read answers `pictures: "on"` (revision 3, H2-SEC-10: pictures can be
 * switched off without a deploy, and the page then claims nothing about them), and without `ownerHolds` unless
 * `GET /api/token/me/owner-holds` answers 200 or 401, not 404 (revision 4, H3-SEC-1: the site ships before B's
 * API half, which waits for migration 0018; a route that answers 404 or fails is `false`).
 */
export function holderPerksShown(picturesOn: boolean, ownerHoldsOn: boolean): HolderPerk[] {
  return HOLDER_PERKS.filter(
    (perk) =>
      !HOLDER_PERKS_HIDDEN.includes(perk.key) &&
      (picturesOn || perk.key !== 'pictures') &&
      (ownerHoldsOn || perk.key !== 'ownerHolds'),
  );
}

/**
 * Whether the owner-holds route is there, from the status of `GET /api/token/me/owner-holds` (revision 4,
 * H3-SEC-1): 200 or 401 is there; 404, any other status and a failed request (null) are not. While it is not,
 * /token and /account/token show neither the `ownerHolds` row nor the mark's switch, and
 * `token.holdersBadgeValue` shows only its first sentence (`holdersBadgeValueShown`).
 */
export function ownerHoldsRouteOn(status: number | null): boolean {
  return status === 200 || status === 401;
}

// --- B. "Owner holds $PRIX" ------------------------------------------------------------------------

/**
 * `ownerHolds` of `GET /api/agents/:id` (B). `entitlements` is `entitlementsFor(owner, { cachedOnly: true })`,
 * so a public request never reads the chain. `shown` is the owner's own choice (revision 2, H-SEC-8):
 * `users.show_holds`, off by default, turned on from /account/token. False while it is off, for a house
 * agent, while gating is off, and below tier 2. The same answer for every viewer; never asked by the data
 * API, the league, the home board, a war, a card, a recap, a share image, an OG tag or a Live page.
 */
export function ownerHoldsOf(
  entitlements: Pick<Entitlements, 'gatingOn' | 'tier'>,
  house: boolean,
  shown: boolean,
): boolean {
  return shown && !house && entitlements.gatingOn && entitlements.tier >= OWNER_HOLDS_MIN_TIER;
}

/**
 * GET and PUT /api/token/me/owner-holds (revision 2, H-SEC-8): the signed-in wallet's choice to show the
 * mark on its agents' pages. GET is a session's read, never cached; PUT is a write (`requireWriter`, one
 * row booked) whose body is this shape and whose answer is the stored choice.
 */
export const ownerHoldsSettingSchema = z.strictObject({ show: z.boolean() });
export type OwnerHoldsSetting = z.infer<typeof ownerHoldsSettingSchema>;
/** Rows booked through `requireWriter` for one change of the choice: one column of the wallet's `users` row. */
export const OWNER_HOLDS_WRITE_ROWS = 1;

/** `apps/api/src/store/**` (platform) implements it on `users.show_holds` (migration 0018). */
export interface OwnerHoldsStore {
  /** The wallet's choice; false when it has no `users` row. One row read. */
  getShowHolds(wallet: Address): Promise<boolean>;
  /** Sets the choice on the wallet's `users` row (inserted with `created_at` now when absent). One row written. */
  setShowHolds(wallet: Address, show: boolean, at: IsoTime): Promise<void>;
}

// --- C. the holders' poll --------------------------------------------------------------------------

/** A poll's id: lower-case words joined by hyphens, 3 to 40 characters. Also the path segment. */
export const pollIdSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .min(3)
  .max(40);
/** An option's id within its poll, same alphabet, 2 to 32 characters. */
export const pollOptionIdSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .min(2)
  .max(32);

export interface HolderPollOption {
  id: string;
  /** The public name, as the league shows it. */
  name: string;
  /** The house agent whose strategy the option is; the page links to its own page. */
  agentId: string;
}

export interface HolderPoll {
  id: string;
  question: string;
  options: readonly HolderPollOption[];
  /** Votes are taken from this instant (inclusive) while `POLLS_ENABLED` is on. */
  opensAt: IsoTime;
  /** Votes are taken until this instant (exclusive). The tally runs after it. */
  closesAt: IsoTime;
}

/**
 * Every poll Prix has written, oldest first. A new poll is a contract revision and a deploy; there is no
 * admin form and no free text from anyone. No two polls' windows overlap (the check pins it), so one
 * poll at most is open at a time. An option never touches money, fees, the token, its supply, listings,
 * Prix Live or which model wins.
 *
 * The first poll's four options are house agents of the Open board read from production at 2026-10-16
 * 06:26 UTC (`GET /api/league?division=open`): four different ways to hold the Stock Tokens, chosen for
 * their difference and never for their figures.
 */
export const HOLDER_POLLS: readonly HolderPoll[] = [
  {
    id: 'model-war-2-strategy',
    question: 'Which strategy should Model War 2 run?',
    options: [
      { id: 'big-tech-equal', name: 'Big Tech Equal', agentId: 'qfoocl4nen6j' },
      { id: 'index-core', name: 'Index Core', agentId: '4nxdlbu3idgu' },
      { id: 'momentum-five', name: 'Momentum Five', agentId: '3w6inochcjno' },
      { id: 'dip-buyer', name: 'Dip Buyer', agentId: 'adiz4yeo5ams' },
    ],
    opensAt: '2026-10-16T00:00:00.000Z',
    closesAt: '2026-10-21T20:00:00.000Z',
  },
];

/** Wallets one page of the tally reads, and one chain read of `PollHoldingReader.tiersNow` takes (one Multicall3 call). */
export const POLL_TALLY_PAGE = 400;
/**
 * A guard against a runaway table, not a seat count (revision 2, H-SEC-1): a new wallet is refused
 * `poll_full` only while the poll's votes are at this figure after the last prune (revision 3, H2-SEC-1); a
 * voter may still change its vote. Revision 8 (R8-3, PT-FETCH-1): 4,000 less one POLL_TALLY_PAGE, because at
 * 4,000 the worst tally run and the worst prune run with one endpoint down passed the social step's 50
 * subrequests (docs/contracts/phase-6-holders-2.md section 8, whose check computes the step down). Revision 8b
 * (R8B-1, R8-SEC-2): one POLL_TALLY_PAGE more, because the sum also books the token configuration's read, and
 * at 3,600 it was 50 and 51. Revision 8c (CR8B-1, CR8B-2, C1): a literal, the first step down from 4,000 by
 * POLL_TALLY_PAGE at which the step's one sum (docs/contracts/phase-6-holders-2.md section 8), the 429 case and
 * the never-answering case (`pollTallyWorstReadMs`) all fit, which the check computes and pins; so no later change
 * of POLL_TALLY_PAGE moves the cap by formula. At 1,600 the tally is 4 reads of 400 wallets after one read at the
 * head. The window of the keyless endpoints binds it: the one sum alone would allow 3,200.
 */
export const POLL_MAX_VOTERS = 1_600;
/**
 * Revision 8d (D5, R8C-SEC-5): the check's step down never settles below this. When the operator's measured mean
 * latency (gate 3) needs a lower cap, the switch holds until a revision lowers POLL_TALLY_PAGE or
 * POLL_TALLY_FETCH_TIMEOUT_MS; a cap this low could be within reach of real tier-1 holders, and the prune deletes
 * only non-holders, so the vote would quietly become first come, first served.
 */
export const POLL_MAX_VOTERS_FLOOR = 1_200;
/**
 * Revision 8d (D5, R8C-SEC-5): before POLLS_ENABLED is "true" the operator reads the number of wallets at tier 1 or above
 * in `token_holders`; it must stand under half of POLL_MAX_VOTERS. True when that count holds the switch (a count at
 * or above half the cap, or one that is not a whole number of wallets).
 */
export function pollHolderCountHolds(tierOneWallets: number): boolean {
  return !(Number.isInteger(tierOneWallets) && tierOneWallets >= 0 && tierOneWallets < POLL_MAX_VOTERS / 2);
}
/**
 * Prune while open (revision 3, H2-SEC-1): while a poll is open and its votes are at least this many, the
 * job's run, at most once every POLL_PRUNE_EVERY_SECONDS, reads every voter at one block by the tally's own
 * path and deletes the votes of the voters below tier 1 or named by `pollWalletExcluded`. Revision 8 (R8-3):
 * it came down with POLL_MAX_VOTERS by one POLL_TALLY_PAGE, from 3,600 to 3,200; revision 8b (R8B-1) by one more,
 * to 2,800; revision 8c (CR8B-1, C1) with the cap to 1,200, one POLL_TALLY_PAGE under it, a literal the check pins.
 */
export const POLL_PRUNE_AT = 1_200;
export const POLL_PRUNE_EVERY_SECONDS = 3_600;
/**
 * "At most once every POLL_PRUNE_EVERY_SECONDS" with no state kept: only the run whose clock reads the first
 * five minutes of an hour (UTC) may prune, which is one run an hour of SOCIAL_CRON's five-minute period. An
 * hour whose run in that window is skipped has no prune.
 */
export function pollPruneDue(now: Date): boolean {
  return now.getUTCMinutes() < 5;
}
/** The least tier a vote needs, at the vote (by `entitlementsFor` without `cachedOnly`) and at the tally. */
export const POLL_MIN_TIER: 1 = 1;
/** Rows booked through `spendWrite` for one vote: a change writes three (the old count, the row, the new count). */
export const POLL_VOTE_WRITE_ROWS = 3;
/**
 * The prune's D1 writes a UTC day, at most (revision 4, H3-SEC-5): it deletes only rows votes inserted, at most
 * floor(API_WRITE_ROWS_PER_DAY / POLL_VOTE_WRITE_ROWS) = 13,333 vote rows, and 4 count rows a run (one an
 * option of the first poll) in at most 24 runs, 96. Written by the job, outside the API's 40,000; CONTRACTS.md
 * 18.4 books them.
 */
export const POLL_PRUNE_MAX_VOTE_ROWS_PER_DAY = Math.floor(API_WRITE_ROWS_PER_DAY / POLL_VOTE_WRITE_ROWS);
export const POLL_PRUNE_MAX_COUNT_ROWS_PER_DAY = 4 * 24;
/** Pages of the tally's one run: POLL_MAX_VOTERS / POLL_TALLY_PAGE, and one more page that finds the end. */
export const POLL_TALLY_MAX_PAGES = POLL_MAX_VOTERS / POLL_TALLY_PAGE + 1;
/**
 * `tiersNow` calls of the tally's worst run: one at the head that finds the run's block (revision 3,
 * H2-SEC-5), then one a page that holds voters, all at that block.
 */
export const POLL_TALLY_MAX_CHAIN_READS = POLL_MAX_VOTERS / POLL_TALLY_PAGE + 1;
/**
 * The run's block is the first answer's `blockNumber` less this margin (revision 3, H2-SEC-5), so that an
 * endpoint behind the other still answers at it. Revision 4 (HB3-5): the chain makes about 10 blocks a second
 * (D-098), so the margin is 50, about five seconds of chain.
 */
export const POLL_TALLY_BLOCK_MARGIN = 50;
/**
 * Revision 8c (CR8B-1): publicnode refuses eth_call for a block about this many behind its head, with HTTP 403
 * (read 2026-10-10).
 */
export const POLL_TALLY_KEYLESS_STATE_BLOCKS = 100;
/** Revision 8c (CR8B-1): D-098, about 10 blocks a second. */
export const POLL_TALLY_CHAIN_BLOCKS_PER_SECOND = 10;
/**
 * A tally or prune run whose reads pass this many seconds from its first read fails at `read` (revision 4,
 * HB3-5). Revision 8c (CR8B-1, C1): computed, (POLL_TALLY_KEYLESS_STATE_BLOCKS - POLL_TALLY_BLOCK_MARGIN) /
 * POLL_TALLY_CHAIN_BLOCKS_PER_SECOND, rounded down, so that the pinned block is still served by publicnode at the
 * run's last read: 5. It was 8, which let the pinned block age to about 130 blocks. The run's seconds are fixed by
 * the block window and are not raised.
 */
export const POLL_TALLY_MAX_RUN_SECONDS = Math.floor(
  (POLL_TALLY_KEYLESS_STATE_BLOCKS - POLL_TALLY_BLOCK_MARGIN) / POLL_TALLY_CHAIN_BLOCKS_PER_SECOND,
);
/**
 * `tallyPoll` counts its own outbound fetches, retries and fallbacks included, and fails at `read` before it
 * would pass this many (revision 3, H2-SEC-4). Revision 8 (R8-2, R8-3, PT-FETCH-1): within one run an endpoint
 * that failed or refused once is not asked again (`createPollFetchMeter`, packages/runtime/src/token/
 * poll-holding.ts), so with one endpoint down every read costs at most two fetches and the run pays one more
 * for the fetch that found the endpoint down: 2 x POLL_TALLY_MAX_CHAIN_READS + 1. The cap is that figure, so
 * that the meter itself holds the run to the one sum docs/contracts/phase-6-holders-2.md section 8 books
 * against the step's 50 whatever fails.
 */
export const POLL_TALLY_MAX_FETCHES = 2 * POLL_TALLY_MAX_CHAIN_READS + 1;
/**
 * Revision 8b (R8-SEC-3): the run's fetch meter aborts each fetch after this many milliseconds, joining
 * AbortSignal.timeout to the caller's signal, and an aborted fetch marks its endpoint. Revision 8c (R8C-2): the
 * milliseconds run from the call to the end of the clone's read; an answer whose headers came in time but whose
 * body is not read whole by then marks its endpoint, and the fetch rejects with the carry-nothing error. One endpoint that never
 * answers costs a run this once, where data-market's own TOKEN_RPC_TIMEOUT_MS (8,000) would cost the whole of
 * POLL_TALLY_MAX_RUN_SECONDS at the head read.
 */
export const POLL_TALLY_FETCH_TIMEOUT_MS = 1_500;
/**
 * Revision 8b (R8-SEC-3, R8B-5): the latency of each answered fetch on perf's fake chain for gate 3's wall-time
 * figure. 300 ms is the security reader's figure; the operator replaces it, before gate 3 is read, with a read of
 * publicnode and dRPC answering a 400-wallet tryBlockAndAggregate from a Worker. Revision 8c (CR8B-1): both worst
 * runs, the 429 case (POLL_TALLY_MAX_FETCHES x this) and the never-answering case (POLL_TALLY_FETCH_TIMEOUT_MS +
 * (POLL_TALLY_MAX_FETCHES - 1) x this), stay inside POLL_TALLY_MAX_RUN_SECONDS (`pollTallyWorstReadMs`); the
 * check computes them and steps POLL_MAX_VOTERS down until they fit. Revision 8e (CR8D-4, R8D-SEC-3): gate 3's read
 * gives one mean for publicnode and one for dRPC (a sample read that fails, is refused or is aborted counts as a read
 * of POLL_TALLY_FETCH_TIMEOUT_MS and is never dropped); the larger of the two, rounded up to the next 10 ms
 * (`pollTallyLatencyFromMeans`), becomes this constant in a revision of this file, whose checks then compute the step
 * down again and pin POLL_MAX_VOTERS, POLL_PRUNE_AT and the worst reads at that figure.
 */
export const POLL_TALLY_FETCH_LATENCY_MS = 300;
/**
 * Revision 8g (H5): the latency a fetch of qa's fake chain answers after in qa's never-answering case only
 * (tests/holders/poll-chain.test.ts), so that the full suite's CPU load cannot eat the case's margin: at
 * POLL_TALLY_FETCH_LATENCY_MS the case's pure waiting is 4,500 ms of the run's 5,000 and took 5,036 and 5,065 ms
 * under the suite's load at holders-polls-integrated-5; at this figure it is 4,000 ms. POLL_TALLY_FETCH_LATENCY_MS
 * stays 300 for the contract's figures, which the check computes, and gate 3's script keeps measuring at 300.
 */
export const POLL_TALLY_QA_NEVER_ANSWERING_LATENCY_MS = 250;
/**
 * Revision 8e (CR8D-4, R8D-SEC-3): the figure the revision writes as POLL_TALLY_FETCH_LATENCY_MS from gate 3's two
 * means: the larger, rounded up to the next 10 ms. NaN when either mean is not a finite number above 0.
 */
export function pollTallyLatencyFromMeans(publicnodeMeanMs: number, drpcMeanMs: number): number {
  if (!(Number.isFinite(publicnodeMeanMs) && publicnodeMeanMs > 0 && Number.isFinite(drpcMeanMs) && drpcMeanMs > 0)) {
    return Number.NaN;
  }
  return Math.ceil(Math.max(publicnodeMeanMs, drpcMeanMs) / 10) * 10;
}
/** Fetches of the chain in a tally or prune run at `maxVoters` with one endpoint down (R8-2): two a read and one more. */
export function pollTallyFetchesAt(maxVoters: number): number {
  return 2 * (maxVoters / POLL_TALLY_PAGE + 1) + 1;
}
/**
 * Revision 8d (D4, R8C-SEC-3): an answer that comes later than this many milliseconds after its call is used, and
 * marks its endpoint for the rest of the run (section 5, rule 2). Without it an endpoint that answers every call
 * just under POLL_TALLY_FETCH_TIMEOUT_MS is never marked, and its POLL_TALLY_MAX_CHAIN_READS answers alone pass
 * POLL_TALLY_MAX_RUN_SECONDS (5 x 1,499 ms against 5,000). Revision 8e (F1, R8D-SEC-1, CR8D-1, CR8D-3): only an
 * answer of an endpoint whose answer is taken alone (not `isThirdPartyEndpoint` of packages/market: the official
 * endpoint, or a set RPC_URL), measured like the timeout from the call to the end of the clone's read; a third
 * party's answer is never marked for its time alone, since its read needs the other third party to agree, and with
 * the official endpoint refusing Cloudflare (D-131) a mark would leave the run one endpoint and fail it at `read`;
 * its time is bounded by POLL_TALLY_FETCH_TIMEOUT_MS and the run's seconds. Revision 8f (R8E-B2):
 * `isThirdPartyEndpoint` is imported from `@prix/market/chain` (the root index does not export it) and called on
 * the input URL (the string, a URL's href or a Request's url), never on `endpointHost`'s host.
 */
export const POLL_TALLY_SLOW_ANSWER_MS = 750;
/**
 * Revision 8d (D4); revision 8e (F1, R8D-SEC-1, CR8D-1, CR8D-3): true when an answer that came `elapsedMs` after its
 * call marks its endpoint (a slow answer). `elapsedMs` runs from the call to the end of the clone's read. `takenAlone`
 * is true for an endpoint whose answer is taken alone (not `isThirdPartyEndpoint` of @prix/market: the official
 * endpoint, or a set RPC_URL) and false for a third party, which is never marked for its time alone.
 */
export function pollTallySlowAnswerMarks(elapsedMs: number, takenAlone: boolean): boolean {
  return takenAlone && !(elapsedMs <= POLL_TALLY_SLOW_ANSWER_MS);
}
/**
 * Revision 8c (CR8B-1, C1): the worst run's milliseconds of reads at `maxVoters`, at `latencyMs` a fetch
 * (POLL_TALLY_FETCH_LATENCY_MS unless the operator's measured mean is passed, revision 8d, D5). `rateLimited`: every
 * fetch answered, one endpoint refusing with 429 once (the fetches times the latency). `neverAnswering`: one endpoint
 * never answering, so the meter's timeout once, then every other fetch. `slowAnswering` (revision 8d, D4,
 * R8C-SEC-3): one endpoint answering correctly but later than POLL_TALLY_SLOW_ANSWER_MS; its answer, which comes
 * before POLL_TALLY_FETCH_TIMEOUT_MS or not at all, is used alone for its read and marks it, and every later read
 * costs two fetches of the others. The writer bounds that answer by the timeout, not by POLL_TALLY_SLOW_ANSWER_MS,
 * since an answer at 1,499 ms is the worst one that is still used. `thirdPartyTail` (revision 8e, F1, CR8D-1): every
 * fetch answered, with one third party's answer, never marked for its time, coming just under the timeout:
 * fetches x latencyMs + (POLL_TALLY_FETCH_TIMEOUT_MS - latencyMs), 4,500 ms at 1,600. More than one such answer in a
 * run is bounded by gate 3's tail read, and a run that passes POLL_TALLY_MAX_RUN_SECONDS fails at `read` and is
 * tried again by the next run.
 */
export function pollTallyWorstReadMs(
  maxVoters: number,
  latencyMs: number = POLL_TALLY_FETCH_LATENCY_MS,
): { rateLimited: number; neverAnswering: number; slowAnswering: number; thirdPartyTail: number } {
  const fetches = pollTallyFetchesAt(maxVoters);
  const reads = maxVoters / POLL_TALLY_PAGE + 1;
  return {
    rateLimited: fetches * latencyMs,
    neverAnswering: POLL_TALLY_FETCH_TIMEOUT_MS + (fetches - 1) * latencyMs,
    slowAnswering: POLL_TALLY_FETCH_TIMEOUT_MS + 2 * (reads - 1) * latencyMs,
    thirdPartyTail: fetches * latencyMs + (POLL_TALLY_FETCH_TIMEOUT_MS - latencyMs),
  };
}
/** Revision 8c (C2, CR8B-7): gate 3 reads at least this many full pages from each of publicnode and dRPC. */
export const POLL_TALLY_TAIL_READS_MIN = 20;
/**
 * Revision 8c (C2, CR8B-7): two thirds of POLL_TALLY_FETCH_TIMEOUT_MS, 1,000 ms. A 95th percentile (nearest rank,
 * revision 8d) of one page's read on publicnode or dRPC above it holds the switch until a revision lowers
 * POLL_TALLY_PAGE.
 */
export const POLL_TALLY_TAIL_P95_MAX_MS = Math.floor((2 * POLL_TALLY_FETCH_TIMEOUT_MS) / 3);
/**
 * True when gate 3's tail read holds the switch (C2; revision 8d, D3, CR8C-3, R8C-SEC-2): a 95th percentile
 * (nearest rank) above POLL_TALLY_TAIL_P95_MAX_MS, or a largest read at or above POLL_TALLY_FETCH_TIMEOUT_MS, which
 * the meter would have aborted.
 */
export function pollTallyTailHolds(p95Ms: number, maxMs: number): boolean {
  return !(p95Ms <= POLL_TALLY_TAIL_P95_MAX_MS && maxMs < POLL_TALLY_FETCH_TIMEOUT_MS);
}
/** Revision 8d (D3, CR8C-3): the nearest-rank percentile of `samples` (p in (0, 100]); NaN for no sample. */
export function pollTallyNearestRank(samples: readonly number[], p: number): number {
  if (samples.length === 0 || !(p > 0 && p <= 100)) return Number.NaN;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil((p / 100) * sorted.length) - 1] ?? Number.NaN;
}
/**
 * Revision 8b (R8-SEC-4): the meter reads a 2xx answer's clone up to this many bytes and no further; a longer
 * body, or a Content-Length above it, marks its endpoint and the fetch rejects with an error that carries
 * nothing. About twice the largest real answer (400 tryBlockAndAggregate results are roughly 130 KB of hex).
 */
export const POLL_TALLY_ANSWER_MAX_BYTES = 262_144;
/**
 * Revision 8b (R8B-1, R8-SEC-2): the token configuration read of a run. PollHoldingReader's config is the token
 * service's getConfig, one D1 statement whenever its TOKEN_CONFIG_CACHE_SECONDS (30) memory is cold, which it
 * is at every social run (the alarms are five minutes apart): at most one in a run of POLL_TALLY_MAX_RUN_SECONDS. Booked in both
 * statement bounds below.
 */
export const POLL_TALLY_RUN_CONFIG_READS = 1;
/**
 * CPU of the worst tally run and of the worst prune run, at most (revision 8, R8-1, PT-G3-CPU; it replaces
 * revision 3's 8 ms and its 0.7 ms a page): a ceiling Prix sets itself inside SOCIAL_STEP_CPU_MS, with no
 * documented headroom on the Free plan (revision 8b, R8-SEC-1). perf's figures (estimates from the laptop, the
 * method named) stand inside it for gate 3. At the first production run of poll_tally that reaches its reads,
 * an outcome other than ok, or a CPU time above it, takes poll_tally out of the social step (POLL_TALLY_JOB
 * "off" and a deploy) until a revision that lowers POLL_MAX_VOTERS (and POLL_PRUNE_AT with it), since a run reads
 * every voter (revision 8c, CR8B-2).
 */
export const POLL_TALLY_RUN_CPU_MS = 500;
/**
 * The social step's CPU, at most (revision 8, R8-1, PT-G3-CPU; revision 8b, R8-SEC-1). The step runs in the
 * alarm of its own Clock Durable Object (apps/api/src/index.ts, `runStep` "social", the fifth clock schedule).
 * Cloudflare's Durable Objects limits page (read 2026-10-16 at 21:12 UTC by the security reader) says that
 * Workers limits apply according to the Workers plan and that Durable Objects "have the same per invocation CPU
 * limits as any Workers do"; the Workers Free plan's CPU time is 10 ms. Its 30 seconds is a default the page
 * does not set against the Free plan's figure. On this account, alarms of 72 ms and 148 ms (another
 * Worker, 2026-10-15) and API requests of 23 ms have completed: observed, not promised. SOCIAL_STEP_CPU_MS (1,000) and
 * POLL_TALLY_RUN_CPU_MS (500) are Prix's own ceilings, with no documented headroom on the Free plan.
 */
export const SOCIAL_STEP_CPU_MS = 1_000;
/**
 * Revision 8b (R8-SEC-1): the Worker variable that keeps poll_tally in the social step, off unless exactly
 * "on" (`pollTallyJobOn`). Revision 8c (CR8B-3): off, only the social step's list changes: `poll_tally` is not in
 * it and `step_not_configured` is logged with what `poll_tally_job_off`; `PollApiDeps.tally` and the admin route
 * are unchanged. POLLS_ENABLED "false" alone does not stop the job. It is the remedy of the first production run
 * (section 5, "The CPU bound"). Revision 8c (R8C-1): POLLS_ENABLED "true" needs this "on"; platform's config test
 * fails any state of the runbook in which POLLS_ENABLED is "true" and this is not "on" (`pollsConfigConsistent`).
 */
export const POLL_TALLY_JOB_OFF_WHAT = 'poll_tally_job_off';
/** Revision 8c (R8C-1): the one state the config test refuses, POLLS_ENABLED "true" with POLL_TALLY_JOB not "on". */
export function pollsConfigConsistent(pollsEnabled: string | undefined, pollTallyJob: string | undefined): boolean {
  return !(pollsEnabled === 'true' && !pollTallyJobOn(pollTallyJob));
}
export const POLL_TALLY_JOB_VARIABLE = 'POLL_TALLY_JOB';
export function pollTallyJobOn(value: string | undefined): boolean {
  return value === 'on';
}
/**
 * Revision 8d (D1, CR8C-1): the runbook's three states of (POLLS_ENABLED, POLL_TALLY_JOB), exactly. Whenever
 * POLL_TALLY_JOB goes "off", the same deploy sets POLLS_ENABLED "false", whether a poll is open or closed and not
 * yet counted; no step passes through ("true", "off"), and the remedy goes from ("true", "on") to ("false", "off")
 * in one edit of apps/api/wrangler.jsonc. platform's config test runs the real file in exactly these.
 */
export const POLL_RUNBOOK_STATES = [
  ['false', 'on'],
  ['true', 'on'],
  ['false', 'off'],
] as const satisfies readonly (readonly [string, string])[];
/** Revision 8d (D1): true when the pair is one of POLL_RUNBOOK_STATES, exactly as written. */
export function pollRunbookState(pollsEnabled: string | undefined, pollTallyJob: string | undefined): boolean {
  return POLL_RUNBOOK_STATES.some(([polls, job]) => polls === pollsEnabled && job === pollTallyJob);
}
/**
 * Revision 8d (D2, R8C-SEC-1): production's poll_tally tallies a closed poll that has no voter and freezes its zero
 * result for good, whatever POLLS_ENABLED says. So if POLLS_ENABLED is not "true" in production this many hours
 * before a poll's closesAt, the operator writes a revision that moves that closesAt, deploys it before the old close,
 * and tells the founder the new date. Revision 8f (R8E-B1, R8E-SEC-2): the move is one commit on main, the tree production
 * runs: the edit of that poll's closesAt in HOLDER_POLLS and, in the same commit, every pin of the old date that
 * the full check list runs on main (CLOSES in tests/holders/support.ts), and nothing else of the
 * contract; the operator makes it on a branch of main and runs the full check list on it before the move's moment,
 * then deploys it chained to the whole list outside 14:30 to 16:15 UTC on a trading day. Revision 8e (F3,
 * R8D-SEC-5): the build writes no zero result while POLLS_ENABLED is not "true" (PollTallyJobDeps.pollsEnabled).
 * Revision 8f (R8E-SEC-1, R8E-B3): D2's move stays the rule whichever code production runs: F3 keeps a closed poll
 * with no voter uncounted only while the switch is off, and the first run after POLLS_ENABLED goes "true" freezes its
 * zero result, so a poll whose window would pass with the switch off is moved before its close, and POLLS_ENABLED
 * goes "true" only while openPollAt(now) names the poll it is switched on for.
 * Revision 8g (H1: F8F-B1, R8F-SEC-1, PF5-SEC-2; F8F-B2): a pin is any literal moment a test chose from the old
 * close, each moved by the same whole days as closesAt: at 821b1a11, CLOSES in tests/holders/support.ts and the
 * moments typed in tests/holders/poll-vote.d1.test.ts:93 and apps/api/src/http/holders-polls.test.ts:234, 236 and
 * 303; on the build's branch, the check's and the build branch's tests' pins too; for a move past 2026-10-22 the
 * rule that the poll closes before Model War 1 ends becomes the rule that it closes before Model War 2's start,
 * which the operator names in the same edit and tells the founder with the new date.
 */
export const POLL_CLOSE_MOVE_HOURS = 48;
/**
 * Revision 8d (D2): true when `poll`'s closesAt must be moved: POLLS_ENABLED not "true" in production at the moment of
 * the move and the close within 48 hours. Revision 8e (CR8D-5): `pollsEnabledAtMoveTime` is POLLS_ENABLED as it stood
 * in production at closesAt - POLL_CLOSE_MOVE_HOURS, not now; a switch turned on later, inside the 48 hours, does not
 * undo a move that was due.
 */
export function pollCloseMoveDue(
  poll: Pick<HolderPoll, 'closesAt'>,
  now: Date,
  pollsEnabledAtMoveTime: string | undefined,
): boolean {
  const closes = Date.parse(poll.closesAt);
  const at = now.getTime();
  return pollsEnabledAtMoveTime !== 'true' && at >= closes - POLL_CLOSE_MOVE_HOURS * 3_600_000 && at < closes;
}
/** The tally starts no earlier than this after the close, so that no vote read on the clock before the close is still being written. */
export const POLL_TALLY_SETTLE_SECONDS = 60;
/**
 * The tally's delay (revision 4, H3-SEC-3): a poll is tallied no earlier than closesAt +
 * POLL_TALLY_SETTLE_SECONDS + d, where d is the first two bytes of HMAC-SHA-256 over the poll's id, under a key
 * derived from NONCE_SECRET with the label POLL_TALLY_DELAY_LABEL, modulo POLL_TALLY_DELAY_MODULO_SECONDS. It is
 * kept nowhere and logged nowhere, so nobody outside Prix knows the tally's block in advance.
 */
export const POLL_TALLY_DELAY_LABEL = 'poll-tally';
export const POLL_TALLY_DELAY_MODULO_SECONDS = 3_600;
/** d from the HMAC's bytes: the first two bytes, big-endian, modulo 3,600. Throws on fewer than two bytes. */
export function pollTallyDelaySeconds(mac: Uint8Array): number {
  const first = mac[0];
  const second = mac[1];
  if (first === undefined || second === undefined) throw new Error('A tally delay needs two bytes of the HMAC.');
  return ((first << 8) | second) % POLL_TALLY_DELAY_MODULO_SECONDS;
}
/** True when `now` is at or after closesAt + POLL_TALLY_SETTLE_SECONDS + `delaySeconds` (d of the poll). */
export function pollTallyDueAt(poll: Pick<HolderPoll, 'closesAt'>, now: Date, delaySeconds: number): boolean {
  return now.getTime() >= Date.parse(poll.closesAt) + (POLL_TALLY_SETTLE_SECONDS + delaySeconds) * 1000;
}
/** The job tallies a poll by itself only within this many days of its close; after it the operator runs the admin tally. */
export const POLL_TALLY_LOOKBACK_DAYS = 7;
/**
 * The job reads a closed poll's state for this many days after its close (the tally, the expired log, the
 * purge of its votes) and is idle without a read after it. A poll not counted by then is a revision's
 * matter: the operator says in it what happens to its rows.
 */
export const POLL_WATCH_DAYS = 30;
/** `poll_votes` rows the job deletes in one run once a poll's result is frozen (revision 2, H-SEC-7). */
export const POLL_PURGE_PER_RUN = 100;
/**
 * Revision 8 (R8-4, PT-PURGE-1): the counted polls a run's purge tries, at most, oldest first, one
 * `deleteVotes` statement each. The first that deletes a row ends the run with `more`; one that deletes nothing
 * hands the run to the next; after this many tries the purge stops and the run goes on to the prune. The check
 * pins that no POLL_WATCH_DAYS window of HOLDER_POLLS holds more closes than this, so that no counted poll's
 * votes wait behind emptied ones.
 */
export const POLL_PURGE_MAX_POLLS = 3;
/** The public read is cached like every public read. */
export const POLL_READ_CACHE_SECONDS = 30;

export type PollState = 'upcoming' | 'open' | 'closed';

/**
 * Prix's own wallets do not vote (revision 2, H-SEC-6): a wallet of `ApiConfig.adminAddresses` or of
 * `ApiConfig.houseOwners` is refused `poll_not_holder` at the vote and is not counted at the tally. Compared
 * in lower case.
 */
export function pollWalletExcluded(
  wallet: string,
  adminAddresses: readonly string[],
  houseOwners: readonly string[] | undefined,
): boolean {
  const wanted = wallet.toLowerCase();
  const listed = (list: readonly string[] | undefined): boolean =>
    (list ?? []).some((entry) => entry.toLowerCase() === wanted);
  return listed(adminAddresses) || listed(houseOwners);
}

/** Where a poll stands at `now`, by the server's clock: open in [opensAt, closesAt). */
export function pollStateAt(poll: Pick<HolderPoll, 'opensAt' | 'closesAt'>, now: Date): PollState {
  const at = now.getTime();
  if (at < Date.parse(poll.opensAt)) return 'upcoming';
  return at < Date.parse(poll.closesAt) ? 'open' : 'closed';
}

/** The one open poll at `now`, or null. */
export function openPollAt(now: Date, polls: readonly HolderPoll[] = HOLDER_POLLS): HolderPoll | null {
  return polls.find((poll) => pollStateAt(poll, now) === 'open') ?? null;
}

/** A poll by its id, or null: an unknown id is the generic 404. */
export function pollById(id: string, polls: readonly HolderPoll[] = HOLDER_POLLS): HolderPoll | null {
  return polls.find((poll) => poll.id === id) ?? null;
}

/** The closed polls the tally may still count at `now`: closed at least POLL_TALLY_SETTLE_SECONDS ago, and less than the lookback ago. */
export function pollsToTallyAt(now: Date, polls: readonly HolderPoll[] = HOLDER_POLLS): HolderPoll[] {
  const at = now.getTime();
  const lookback = POLL_TALLY_LOOKBACK_DAYS * 86_400_000;
  return polls.filter((poll) => {
    const closes = Date.parse(poll.closesAt);
    return at >= closes + POLL_TALLY_SETTLE_SECONDS * 1000 && at < closes + lookback;
  });
}

/** The closed polls the job reads at `now`: closed at least POLL_TALLY_SETTLE_SECONDS ago and less than POLL_WATCH_DAYS ago. */
export function pollsWatchedAt(now: Date, polls: readonly HolderPoll[] = HOLDER_POLLS): HolderPoll[] {
  const at = now.getTime();
  const watch = POLL_WATCH_DAYS * 86_400_000;
  return polls.filter((poll) => {
    const closes = Date.parse(poll.closesAt);
    return at >= closes + POLL_TALLY_SETTLE_SECONDS * 1000 && at < closes + watch;
  });
}

/** True when a closed poll without a result is past the lookback at `now`: the job no longer counts it by itself. */
export function pollTallyExpired(poll: Pick<HolderPoll, 'closesAt'>, now: Date): boolean {
  return now.getTime() >= Date.parse(poll.closesAt) + POLL_TALLY_LOOKBACK_DAYS * 86_400_000;
}

/**
 * `poll_tally_expired` is logged at most once a UTC day (revision 2, H-SEC-4): only by the run whose clock
 * reads 00:00 to 00:04 UTC, the day's first run of SOCIAL_CRON (minute 3). No state is kept for it; a day
 * whose first run is skipped has no line.
 */
export function pollExpiredLogDue(now: Date): boolean {
  return now.getUTCHours() === 0 && now.getUTCMinutes() < 5;
}

/**
 * The state GET /api/polls gives a listed poll (revision 2, H-SEC-4): `open`; `counting` while closed with
 * no result and within the lookback; `uncounted` when closed with no result past the lookback (the page
 * never says "being counted" then); `closed` once the result is frozen. Null for an upcoming poll, which
 * is never listed.
 */
export function pollPublicStateAt(
  poll: Pick<HolderPoll, 'opensAt' | 'closesAt'>,
  now: Date,
  hasResult: boolean,
): 'open' | 'counting' | 'uncounted' | 'closed' | null {
  const state = pollStateAt(poll, now);
  if (state === 'upcoming') return null;
  if (state === 'open') return 'open';
  if (hasResult) return 'closed';
  return pollTallyExpired(poll, now) ? 'uncounted' : 'counting';
}

/**
 * The options with the most counted votes, in the poll's order. Empty when nothing was counted; two or
 * more is a tie, which the operator settles among them and says so (the page says "a tie between").
 */
export function pollLeaders(poll: Pick<HolderPoll, 'options'>, counted: Readonly<Record<string, number>>): string[] {
  let most = 0;
  for (const option of poll.options) most = Math.max(most, counted[option.id] ?? 0);
  if (most === 0) return [];
  return poll.options.filter((option) => (counted[option.id] ?? 0) === most).map((option) => option.id);
}

/** POST /api/polls/:id/vote. */
export const pollVoteBodySchema = z.strictObject({ option: pollOptionIdSchema });
export type PollVoteBody = z.infer<typeof pollVoteBodySchema>;

/**
 * The poll's refusals: each is `invalid_input` with this field and the status beside it, as the room's
 * are (no new error code). Not signed in is the session's own 401, an unknown poll the generic 404, too
 * many requests the limiter's own 429 `rate_limited`.
 */
export const POLL_REFUSALS = {
  poll_unknown_option: 400,
  poll_not_open: 409,
  poll_closed: 409,
  poll_gate_off: 403,
  poll_not_holder: 403,
  poll_full: 409,
} as const;
export type PollRefusal = keyof typeof POLL_REFUSALS;

/** The answer of a vote that was stored: 200. */
export const pollVoteResponseSchema = z.strictObject({ pollId: pollIdSchema, option: pollOptionIdSchema });
export type PollVoteResponse = z.infer<typeof pollVoteResponseSchema>;

const countsSchema = z.record(pollOptionIdSchema, z.number().int().nonnegative());

/** A closed poll's frozen result, written once by the tally. */
export const pollResultSchema = z.strictObject({
  /** Votes cast before the close, by option. */
  cast: countsSchema,
  /** Votes whose wallet held tier 1 or above at the tally's read, by option. */
  counted: countsSchema,
  /** The options with the most counted votes, in the poll's order (`pollLeaders`): empty, one, or a tie. */
  leaders: z.array(pollOptionIdSchema),
  countedAt: isoTimeSchema,
  /**
   * The chain's block the tally read at, first and last. Since revision 2 every read of a run is at one
   * block (H-SEC-3), so the two are equal; both stay so that the table and the shape do not change.
   */
  firstBlock: z.number().int().nonnegative(),
  lastBlock: z.number().int().nonnegative(),
});
export type PollResult = z.infer<typeof pollResultSchema>;

export const pollPublicSchema = z.strictObject({
  id: pollIdSchema,
  question: z.string(),
  options: z.array(z.strictObject({ id: pollOptionIdSchema, name: z.string(), agentId: z.string() })),
  opensAt: isoTimeSchema,
  closesAt: isoTimeSchema,
  /**
   * `counting`: closed and not tallied yet, within the lookback. `uncounted`: closed, not tallied, and past
   * the lookback (`pollPublicStateAt`, revision 2).
   */
  state: z.enum(['open', 'counting', 'uncounted', 'closed']),
  /** Votes cast so far by option, for an open or counting poll; null once the result is frozen. */
  cast: countsSchema.nullable(),
  /** The frozen result of a closed poll; null before it. */
  result: pollResultSchema.nullable(),
});
export type PollPublic = z.infer<typeof pollPublicSchema>;

/**
 * GET /api/polls: public, cached 30 seconds, no per-wallet data. The open poll first, then the closed
 * ones, newest close first. An upcoming poll is never listed.
 */
export const pollsResponseSchema = z.strictObject({
  polls: z.array(pollPublicSchema),
  /** The tier-1 amount in whole tokens as the configuration has it now, for the page's sentences. */
  minTokens: z.number().int().nonnegative(),
});
export type PollsResponse = z.infer<typeof pollsResponseSchema>;

/** GET /api/polls/me: a session, never cached. */
export const pollMeResponseSchema = z.strictObject({
  /** The open poll's id, or null when none is open. */
  pollId: pollIdSchema.nullable(),
  /** The wallet's current vote in that poll, or null. */
  option: pollOptionIdSchema.nullable(),
  /** True when a vote by this wallet would pass the holder step now. */
  canVote: z.boolean(),
  /** Why not, when no vote would pass: the gate is off, or the wallet is below tier 1. Null otherwise. */
  refusal: z.enum(['poll_gate_off', 'poll_not_holder']).nullable(),
});
export type PollMeResponse = z.infer<typeof pollMeResponseSchema>;

/** GET /api/polls/status: `{ on: true }` while POLLS_ENABLED is on; the generic 404 otherwise. */
export const pollStatusResponseSchema = z.strictObject({ on: z.literal(true) });

/** One voter as the tally reads it. */
export interface PollVoter {
  wallet: Address;
  option: string;
}

/** The frozen result as the store writes and reads it. */
export interface PollResultRecord extends PollResult {
  pollId: string;
}

/** `apps/api/src/store/polls.ts` implements it for D1 (migration 0018_polls.sql). The only code that writes the poll tables. */
export interface PollStore {
  /**
   * One D1 batch (section 4.2 of the document): the old count down, the row changed or inserted, the new
   * count up. A new wallet is inserted only while the poll's voters are below `maxVoters`; `full` when it
   * was not. `at` is the server's clock.
   */
  putVote(pollId: string, wallet: Address, option: string, at: IsoTime, maxVoters: number): Promise<'stored' | 'full'>;
  /** The wallet's current vote, or null. One row read. */
  getVote(pollId: string, wallet: Address): Promise<string | null>;
  /** Votes cast by option from `poll_counts`: one statement, one row an option. */
  castCounts(pollId: string): Promise<Record<string, number>>;
  /** Voters by wallet order after `after`, written before `before`, at most `limit`. */
  listVoters(pollId: string, after: Address | null, before: IsoTime, limit: number): Promise<PollVoter[]>;
  /** The frozen results of these polls; a poll with none is left out. One statement. */
  getResults(pollIds: readonly string[]): Promise<PollResultRecord[]>;
  /** Writes a result once, in one batch; false when one was there already (nothing changed). */
  putResult(result: PollResultRecord): Promise<boolean>;
  /**
   * Deletes at most `limit` of the poll's `poll_votes` rows, by wallet order, in one statement
   * (`DELETE FROM poll_votes WHERE poll_id = ?1 AND wallet IN (SELECT wallet FROM poll_votes WHERE poll_id = ?1
   * ORDER BY wallet LIMIT ?2)`), and answers how many it deleted. Called only for a poll whose result is frozen
   * (revision 2, H-SEC-7). `poll_counts` and `poll_results` are never deleted.
   */
  deleteVotes(pollId: string, limit: number): Promise<number>;
  /**
   * Prune while open (revision 3, H2-SEC-1): deletes the `poll_votes` rows of these wallets and takes each
   * from its option's `poll_counts`, so that the sum still equals the rows. One D1 batch, a transaction, of two
   * statements, the wallets bound once as a JSON array (at most POLL_MAX_VOTERS): `UPDATE poll_counts SET votes
   * = votes - (SELECT COUNT(*) FROM poll_votes v WHERE v.poll_id = ?1 AND v.option_id = poll_counts.option_id
   * AND v.wallet IN (SELECT value FROM json_each(?2))) WHERE poll_id = ?1`, then `DELETE FROM poll_votes WHERE
   * poll_id = ?1 AND wallet IN (SELECT value FROM json_each(?2))`. Answers the rows deleted.
   */
  pruneVoters(pollId: string, wallets: readonly Address[]): Promise<number>;
}

/** What the tally learns of a page of voters: a tier for each wallet in the same order, at one block. */
export interface PollTiersRead {
  /** False while gating is off or no token is configured: the tally then waits. */
  gatingOn: boolean;
  tiers: Tier[];
  /** The block every endpoint answered at: `atBlock` when one was passed. */
  blockNumber: number;
}

/**
 * The tally's one way to the chain: `packages/runtime/src/token/poll-holding.ts` (engine-runtime) builds
 * it from the token store's configuration and the `TokenChainReader`. One `readBalances` (one Multicall3
 * `eth_call`, under the two-endpoint agreement) for at most POLL_TALLY_PAGE wallets, each tier by
 * `computeTier` with the configured thresholds; the hold before a tier rises does not apply (a vote already
 * passed it) and no row of `token_holders` is written. `atBlock` null reads at the head; a number is passed
 * as the block tag of the read (revision 2, H-SEC-1 and H-SEC-3). A read that fails throws. Since revision 3
 * (HB-1) a read of more than TOKEN_SWEEP_BATCH wallets goes through data-market's lean `balanceOf` encoding
 * of `tryBlockAndAggregate`, with no viem ABI coder.
 */
export interface PollHoldingReader {
  tiersNow(wallets: readonly Address[], atBlock: number | null): Promise<PollTiersRead>;
}

/** The steps a failed tally names in `poll_tally_failed` and in the admin route's answer (revision 2, H-SEC-4). */
export const POLL_TALLY_FAIL_STEPS = ['results', 'list', 'read', 'block', 'write'] as const;
export type PollTallyFailStep = (typeof POLL_TALLY_FAIL_STEPS)[number];

/**
 * What one tally of one poll answers, from the job or from the admin route, which take the same path
 * (`tallyPoll` of poll-tally.ts): `done` (the result is frozen now), `already` (a result was there),
 * `waiting` (gating is off, or since revision 8e POLLS_ENABLED is not "true" and the poll has no voter: nothing
 * written), `open` (the poll has not closed POLL_TALLY_SETTLE_SECONDS
 * ago yet), `failed` (nothing written; `step` says where).
 */
export const pollTallyOutcomeSchema = z.strictObject({
  outcome: z.enum(['done', 'already', 'waiting', 'open', 'failed']),
  step: z.enum(POLL_TALLY_FAIL_STEPS).nullable(),
});
export type PollTallyOutcome = z.infer<typeof pollTallyOutcomeSchema>;

/**
 * What the job's run answers for a tally (revision 3, HB-5): `done` is `done`; `already`, `open` and
 * `waiting` are `idle`; `failed` logs `poll_tally_failed` and then throws an error named
 * POLL_TALLY_FAILED_ERROR, inside `guardSocialJob`, so that the guard counts it and skips the job after
 * SOCIAL_JOB_SKIP_AFTER_FAILURES runs a day. The purge is `more` when `deleteVotes` deleted a row and `idle`
 * when it deleted none; the prune is `done` when `pruneVoters` deleted a row and `idle` otherwise; the expired
 * line is `idle`.
 */
export const POLL_TALLY_JOB_OUTCOMES = {
  done: 'done',
  already: 'idle',
  open: 'idle',
  waiting: 'idle',
  failed: 'throw',
} as const satisfies Record<PollTallyOutcome['outcome'], 'done' | 'idle' | 'throw'>;
/** The name of the error the job throws for a failed tally or prune (revision 3, HB-5). */
export const POLL_TALLY_FAILED_ERROR = 'PollTallyFailed';

/**
 * Revision 7 (R4, HB1F-SEC-2, HB1F2-SEC-1): a precondition of POLLS_ENABLED "true". The social step returns
 * after the first job that answers `more` or `done` (runSocialStep), and a job that answers `idle` or
 * `failed` hands the same invocation's subrequests on to the jobs behind it. So a run of `poll_tally` that
 * has spent its reads must end the step. A run "has reached its reads" from the moment it calls
 * `PollStore.listVoters` for the first time: the tally's step 3 (`tallyPoll` past its own results read) or
 * the prune once `castCounts`' sum is at least POLL_PRUNE_AT. Such a run answers `done` to the step whatever
 * follows: the tally's `done`, an `already` from a `putResult` that answered false, `waiting`, a failure at
 * `list`, `read`, `block` or `write`; the prune's deleted rows, a prune that deleted none, `waiting`, a
 * failure at `list`, `read`, `block` or `write`. A failure is still logged `poll_tally_failed` and still
 * throws POLL_TALLY_FAILED_ERROR inside `guardSocialJob`, so the guard logs `social_job_failed` and counts
 * it as before; only the job's answer to the step is `done` in place of the guard's `failed`. Every other
 * run keeps its answer: `idle` with no read, `open`, an `already` at step 2, a failure at `results` or at
 * the delay's read (step 1), the expired line, the purge, a prune whose sum is below POLL_PRUNE_AT or whose
 * `castCounts` failed, and a run the guard's skip gate stopped. engine-runtime builds it in
 * `createPollTallyJob` (a flag set before the first `listVoters`, read after the guard answers). Revision 8e (F3,
 * R8D-SEC-5): one exception, a tally that answers `waiting` because `PollTallyJobDeps.pollsEnabled` is not true and
 * its first `listVoters` page held no voter has not reached its reads: the job passes false here, so the step goes on
 * to the jobs behind it. Revision 8g (H4: F8F-B3, R8F-SEC-3): only an F3 `waiting` made with no chain read falls
 * through, to the next poll of pollsToTallyAt(now) (within the lookback; a poll past it is never tallied by the job),
 * then the purge and the prune; gating's `waiting`, after a chain read, ends the run with `done` as before. The job
 * clears its flag at that F3 moment only: a later `listVoters` of the same run (the next poll's tally or the prune)
 * sets it again, and the run then answers `done` to the step.
 */
export const pollTallyStepAnswer = (guarded: SocialJobOutcome, reachedReads: boolean): SocialJobOutcome =>
  reachedReads && (guarded === 'idle' || guarded === 'failed') ? 'done' : guarded;

/**
 * The statements of the job's worst runs (sections 5 and 9, revision 3, HB-4 and H2-SEC-1), exported in
 * revision 7 so that docs/contracts/phase-6-holders-2.md section 8 books them: a tally run is the job's
 * results read, the skip gate, `tallyPoll`'s own results read, POLL_TALLY_MAX_PAGES pages and the result's 4
 * rows, with the guard's clear; a prune run is the skip gate, `castCounts`, the pages, the batch of 2 and the
 * clear. Revision 8 (R8-3, R8-4): computed from the constants, and the prune's worst run also books the job's
 * results read and POLL_PURGE_MAX_POLLS purge tries that deleted nothing ahead of it in the same run (a counted
 * poll watched while the open poll is pruned). Revision 8b (R8B-1): both also book the token configuration's
 * read (POLL_TALLY_RUN_CONFIG_READS). At POLL_MAX_VOTERS 1,600 (revision 8c) they are 14 and 15. The check computes both again.
 */
export const POLL_TALLY_RUN_STATEMENTS_MAX = 1 + 1 + 1 + POLL_TALLY_RUN_CONFIG_READS + POLL_TALLY_MAX_PAGES + 4 + 1;
export const POLL_PRUNE_RUN_STATEMENTS_MAX =
  1 + 1 + POLL_PURGE_MAX_POLLS + POLL_TALLY_RUN_CONFIG_READS + 1 + POLL_TALLY_MAX_PAGES + 2 + 1;
/**
 * Revision 8f (R8E-SEC-4): the D1 statements of a run of `poll_tally` that answers `idle` to the step from a
 * `waiting` tally (section 5 step 2, revision 8e F3): the job's results read, the skip gate, the tally's results
 * read, the configuration's read and the first `listVoters` page: 5. docs/contracts/phase-6-holders-2.md section 8
 * books the sweep's sum with it in place of SOCIAL_IDLE_READS_PER_JOB; perf counts a waiting run in its
 * Clock.alarm() drive.
 */
export const POLL_TALLY_WAITING_STATEMENTS = 1 + 1 + 1 + POLL_TALLY_RUN_CONFIG_READS + 1;
/**
 * Revision 8g (H3: R8F-SEC-2, PF5-SEC-3, F8F-B3 (iii)): each further waiting poll a run passes after the first costs
 * two statements, its own results read and its first `listVoters` page; the configuration's read happens once a run.
 */
export const POLL_TALLY_WAITING_POLL_STATEMENTS = 2;
/**
 * Revision 8g (H3, R8F-SEC-2): the worst run of `poll_tally` that answers `idle` to the step once a `waiting` answer
 * falls through (revision 8f, R8E-SEC-3) and the purge's empty tries and `castCounts` follow it: the job's results
 * read, the skip gate, the configuration's read, two statements for each waiting poll of at most POLL_PURGE_MAX_POLLS,
 * and castCounts (a counted poll's empty purge try takes a waiting poll's place under the check's three-closes rule):
 * 10. docs/contracts/phase-6-holders-2.md section 8 books the sweep's sum with it in place of two: 48 of 50.
 */
export const POLL_TALLY_IDLE_STATEMENTS_MAX =
  1 + 1 + POLL_TALLY_RUN_CONFIG_READS + POLL_TALLY_WAITING_POLL_STATEMENTS * POLL_PURGE_MAX_POLLS + 1;
/**
 * Revision 8g (H3, R8F-SEC-2, F8F-B3 (iii)): the worst tally run and the worst prune run with the waiting polls a run
 * may pass first. No POLL_WATCH_DAYS window holds more than POLL_PURGE_MAX_POLLS closes (the check pins it), so a
 * tally passes at most POLL_PURGE_MAX_POLLS - 1 waiting polls (two statements each), and a prune passes w waiting
 * polls and tries at most POLL_PURGE_MAX_POLLS - w counted ones (one more statement for each waiting poll): 18 and 18
 * at revision 8c's cap, which the one sum of docs/contracts/phase-6-holders-2.md section 8 books at 39 and 39 of 50.
 */
export const POLL_TALLY_RUN_STATEMENTS_BEHIND_WAITING_MAX =
  POLL_TALLY_RUN_STATEMENTS_MAX + POLL_TALLY_WAITING_POLL_STATEMENTS * (POLL_PURGE_MAX_POLLS - 1);
export const POLL_PRUNE_RUN_STATEMENTS_BEHIND_WAITING_MAX =
  POLL_PRUNE_RUN_STATEMENTS_MAX + (POLL_TALLY_WAITING_POLL_STATEMENTS - 1) * POLL_PURGE_MAX_POLLS;

/** What `createPollTallyJob(deps): SocialJob` of `packages/runtime/src/social/poll-tally.ts` takes. Its name is `poll_tally`. */
export interface PollTallyJobDeps {
  polls: PollStore;
  holding: PollHoldingReader;
  /** `ApiConfig.adminAddresses` and `ApiConfig.houseOwners`: never counted (`pollWalletExcluded`, H-SEC-6). */
  adminAddresses: readonly string[];
  houseOwners: readonly string[] | undefined;
  /**
   * d of a poll (revision 4, H3-SEC-3): `pollTallyDelaySeconds` of HMAC-SHA-256 over the poll's id, under a key
   * derived from NONCE_SECRET with HKDF-SHA-256 and the label POLL_TALLY_DELAY_LABEL, as feed-cursor.ts derives
   * its key. platform builds it in apps/api/src/index.ts; nothing stores or logs it. `tallyPoll` answers `open`
   * until `pollTallyDueAt(poll, now, d)`.
   */
  tallyDelaySeconds(pollId: string): Promise<number>;
  /**
   * Revision 8e (F3, R8D-SEC-5): `pollsSwitchOn(env.POLLS_ENABLED)` of the entry; absent counts as off. While it is
   * not true, a tally whose first `listVoters` page holds no voter writes no result, makes no chain read and answers
   * `waiting` (`poll_tally_waiting` logged with the poll's id), and the job answers `idle` to the social step: such a
   * run has not reached its reads (`pollTallyStepAnswer(guarded, false)`). The admin route's tally takes the same path.
   * A poll with voters is tallied as before whatever this says.
   */
  pollsEnabled?: boolean;
  /**
   * For `guardSocialJob`: the failure row and its upsert. Revision 4 (HB3-4): engine-runtime narrows
   * `guardSocialJob`'s first parameter in common.ts to `{ log; social: Pick<SocialStore, 'putCursor'>;
   * reputation: Pick<ReputationStore, 'getJobState'> }`, which every job's deps still satisfy.
   */
  social: { putCursor(cursor: { name: string; body: string }, at: IsoTime): Promise<void> };
  reputation: { getJobState(name: string): Promise<string | null> };
  now(): Date;
  /** Never an address. */
  log(event: string, data?: Record<string, string | number | boolean | null>): void;
}

/**
 * Revision 4 (HB3-4): the shapes platform reads by name from the runtime's namespaces, as it reads
 * `createRoomPictureSweepJob`, so that the entry compiles before the job lands. While any is undefined platform
 * logs `step_not_configured`, the job is not in the list, and `PollApiDeps.tally` answers
 * `{ outcome: 'failed', step: 'read' }`. `createPollTallyJob` and `tallyPoll` live in
 * packages/runtime/src/social/poll-tally.ts, `createPollHoldingReader` in packages/runtime/src/token/poll-holding.ts.
 */
export type CreatePollTallyJob = (deps: PollTallyJobDeps) => SocialJob;
/**
 * Revision 8b (R8B-8): poll-tally.ts exports `createPollTallyJobFor(deps, polls)` for its own test of the purge's
 * POLL_PURGE_MAX_POLLS tries, and `createPollTallyJob = (deps) => createPollTallyJobFor(deps, HOLDER_POLLS)`. The
 * helper is not re-exported from packages/runtime/src/social/index.ts or packages/runtime/src/index.ts,
 * PollTallyJobDeps does not change, and only poll-tally.test.ts calls it.
 */
export type CreatePollTallyJobFor = (deps: PollTallyJobDeps, polls: readonly HolderPoll[]) => SocialJob;
export type TallyPoll = (deps: PollTallyJobDeps, poll: HolderPoll) => Promise<PollTallyOutcome>;
export type CreatePollHoldingReader = (deps: {
  chain: TokenChainReader;
  config: () => Promise<{ token: Address | null; thresholdsPpm: readonly [number, number, number]; gatingOn: boolean }>;
}) => PollHoldingReader;

/** The routes' deps (`apps/api/src/http/polls/**`, api-core). */
export interface PollApiDeps extends ApiDeps {
  polls: PollStore;
  entitlements: EntitlementsPort;
  /** POLLS_ENABLED, exactly "true". */
  pollsEnabled: boolean;
  /** The tier-1 threshold in ppm from the token's configuration, for `minTokens`. */
  tierOnePpm(): Promise<number>;
  /**
   * POST /api/admin/polls/:id/tally (revision 2, H-SEC-4): the job's own `tallyPoll` for one poll, whatever
   * the lookback says. Admin session and same-origin; mounted whatever POLLS_ENABLED says, as every admin route.
   */
  tally(poll: HolderPoll): Promise<PollTallyOutcome>;
}

// --- E. the webhook's admin route ------------------------------------------------------------------

/**
 * The webhook prix-api's notify route answers, as mounted: `routes-notify.ts` registers `/telegram/webhook`
 * on the follow routes, which the app mounts under `/api`.
 */
export const TELEGRAM_WEBHOOK_URL = 'https://prixagent.com/api/telegram/webhook';

/**
 * POST /api/admin/telegram/webhook (revision 2, H-SEC-2): admin session, same-origin, no body. prix-api
 * calls `setWebhook` with its own secrets (TELEGRAM_BOT_TOKEN in the path, TELEGRAM_WEBHOOK_SECRET as
 * `secret_token`), `url` TELEGRAM_WEBHOOK_URL, `allowed_updates` TELEGRAM_ALLOWED_UPDATES (phase6-holders2.ts,
 * `["message", "chat_join_request"]`; revision 6, R1, HB1F-SEC-1: never `["message"]` alone, or no join request
 * of the holders' lounge would ever arrive) and `drop_pending_updates: true`, then `getWebhookInfo`, and answers
 * only these three fields, which are what the founder pastes back. Neither secret is ever in an answer or a log; a
 * failure logs a fixed reason only.
 */
export const telegramWebhookAdminResponseSchema = z.strictObject({
  url: z.string(),
  pendingUpdateCount: z.number().int().nonnegative(),
  lastErrorMessage: z.string().nullable(),
});
export type TelegramWebhookAdminResponse = z.infer<typeof telegramWebhookAdminResponseSchema>;

/**
 * The webhook's watch (revision 4, H3-SEC-8). Once an hour (prix-api's watchdog run at minute 13, platform)
 * calls `getWebhookInfo`; when it answers a `url` that is not TELEGRAM_WEBHOOK_URL it logs
 * `telegram_webhook_moved` with no URL and marks the cursor TELEGRAM_WEBHOOK_MOVED_CURSOR (job_state, body the
 * UTC time). While it is marked every route that hands out a link code or a link, and the status's
 * `botUsername`, answer exactly as while `botUsername` is "" (api-core), until an admin sets the webhook again
 * through `POST /api/admin/telegram/webhook`, which clears the mark when its read-back `url` is
 * TELEGRAM_WEBHOOK_URL. A null answer of `getWebhookInfo` changes nothing.
 */
export const TELEGRAM_WEBHOOK_MOVED_CURSOR = 'telegram:webhook_moved';
/** `GET /api/admin/telegram/webhook` (admin session, never cached): what /admin/holders shows of the watch. */
export const telegramWebhookStateSchema = z.strictObject({
  moved: z.boolean(),
  /** When the watch first saw the webhook moved; null while it is not. */
  movedAt: isoTimeSchema.nullable(),
});
export type TelegramWebhookState = z.infer<typeof telegramWebhookStateSchema>;
/** platform implements it on job_state; `FollowApiDeps.webhookWatch` (phase3-follow.ts) carries it to the routes. */
export interface TelegramWebhookWatch {
  /** The time the webhook was seen moved, or null. One row read; a read that fails answers null. */
  movedAt(): Promise<IsoTime | null>;
  /** Marks it moved at `at` unless already marked. One row written. */
  markMoved(at: IsoTime): Promise<void>;
  /** Clears the mark. One row written. */
  clear(): Promise<void>;
}

// --- D. the daily league post ----------------------------------------------------------------------

/** The first UTC minute of the post's window on a trading day (15:20) and the last (16:59). */
export const LEAGUE_POST_FIRST_MINUTE = 15 * 60 + 20;
export const LEAGUE_POST_LAST_MINUTE = 16 * 60 + 59;
/** The round the post is about: the daily round of 15:00 UTC. */
export const LEAGUE_POST_ROUND_HOUR = 15;
/** Places in the post. */
export const LEAGUE_POST_PLACES = 5;
/** What every agent that is not a house agent is called in the post, until the cards' admin approval ships. */
export const LEAGUE_POST_OTHER_NAME = 'An agent';
export const LEAGUE_POST_LINK = 'https://prixagent.com/league';
/**
 * Revision 4 (H3-SEC-9): an agent of the Open board may have its decisions traded with real money through
 * Prix Live, so the post no longer says that no real money moves.
 */
export const LEAGUE_POST_DISCLAIMER = 'The league is a paper-trading simulation. Not investment advice.';
/** The storage key of the day already attempted, in the bot's own Durable Object. */
export const LEAGUE_POST_STATE_KEY = 'league_post_day';

/**
 * True when the bot may try the post at `now`: a weekday, inside the window, and not tried today. The
 * league's state still has to be as of today's 15:00 round (`leaguePostRoundOf`).
 */
export function leaguePostDue(now: Date, lastDay: UtcDay | null): boolean {
  const weekday = now.getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (minute < LEAGUE_POST_FIRST_MINUTE || minute > LEAGUE_POST_LAST_MINUTE) return false;
  return lastDay !== now.toISOString().slice(0, 10);
}

/** The tick id of today's 15:00 round: the league's `state.tickId` must equal it. */
export function leaguePostRoundOf(now: Date): TickId {
  return `${now.toISOString().slice(0, 10)}T${String(LEAGUE_POST_ROUND_HOUR).padStart(2, '0')}:00Z`;
}

/**
 * The only reasons `league_post_failed` names (revision 2, H-SEC-11): the catch around `leaguePost()` logs
 * one of these and never an error's message, stack or a URL, because the bot token is in the path of every
 * Telegram URL. Revision 3 (HB-13): `leaguePost()` throws only a `LeaguePostError` whose `reason` is one of
 * these: `league_read` for a league read that throws or does not parse (a wrong round is not an error),
 * `state` for the Durable Object's storage, `send` for a `sendTelegram` that answered false (logged after the
 * day is marked). A wars read that fails only drops the war line and is never logged, so `wars_read` is gone.
 * The catch in index.ts logs the `reason` of a `LeaguePostError` and 'state' for anything else.
 */
export const LEAGUE_POST_FAILURE_REASONS = ['league_read', 'send', 'state'] as const;
export type LeaguePostFailureReason = (typeof LEAGUE_POST_FAILURE_REASONS)[number];

export interface LeaguePostRow {
  rank: number | null;
  name: string;
  /** Absent counts as false: only a row the API marks as a house agent keeps its name. */
  house?: boolean | undefined;
}

export interface LeaguePostInput {
  tickId: TickId;
  /** The Open board's rows as `GET /api/league?division=open` gives them. */
  rows: readonly LeaguePostRow[];
  /** The running Model War with the lowest number, or null. */
  war: { number: number; daysDone: number; tradingDays: number } | null;
}

/** A row's name in the post: a house agent's as it is, every other "An agent". */
export function leaguePostNameOf(row: Pick<LeaguePostRow, 'name' | 'house'>): string {
  return row.house === true ? row.name : LEAGUE_POST_OTHER_NAME;
}

/**
 * The post, plain text for Telegram's sendMessage with no parse mode, or null when there is nothing to
 * post (no ranked row). Ranked rows only, by rank, at most five, each "{place}. {name}" with no percent
 * (revision 2, H-SEC-10: no table of returns from the token's issuer in the token's group). No ticker, no
 * position, never $PRIX, no address, no price, no figure of a return.
 */
export function leaguePostCaption(input: LeaguePostInput): string | null {
  const ranked = input.rows
    .filter((row): row is LeaguePostRow & { rank: number } => row.rank !== null && Number.isSafeInteger(row.rank))
    .slice()
    .sort((a, b) => a.rank - b.rank)
    .slice(0, LEAGUE_POST_PLACES);
  if (ranked.length === 0) return null;
  const day = input.tickId.slice(0, 10);
  const lines = [
    'Prix league, Open division',
    `After the round of ${day} at 15:00 UTC, the top ${ranked.length} by place:`,
    '',
    ...ranked.map((row) => `${row.rank}. ${leaguePostNameOf(row)}`),
  ];
  if (input.war !== null) {
    lines.push('', `Model War ${input.war.number}: day ${input.war.daysDone} of ${input.war.tradingDays}.`);
  }
  lines.push('', `The whole board: ${LEAGUE_POST_LINK}`, '', LEAGUE_POST_DISCLAIMER);
  return lines.join('\n');
}

// --- the words -------------------------------------------------------------------------------------

/**
 * Every word a page of this round may say, by the editor's key. The editor puts them into the deck as
 * written (`token.*` and `agent.*` in deck.ts, `polls.*` in a deck file of its own); a change is a
 * contract revision. Slots in braces are filled by the page. The question and the options' names come
 * from HOLDER_POLLS, not from here. Since revision 5 (D4, HB-DC-4) `token.perkRealtime`'s `{delay}` is
 * `formatFeedDelay(feedDelaySeconds)` of `GET /api/token` (apps/web/src/site/token/feed-delay.ts), as
 * `token.siteFeedLate` has it; `token.holdersColTier`'s `{tier}` is the column's tier, 0 to 3 (D1); and
 * `token.holdersSwipe` is the edge cue of a table narrower than its columns (D2). Since revision 6 (R2, DC6-2)
 * `token.perkRealtime` reads "... not {delay} later", the slot still filled from formatFeedDelay, so that a
 * filled delay never reads "without the 24 hours delay"; HoldersTable takes it as `feedDelaySeconds` (R3).
 */
export const HOLDERS_COPY = {
  // A. /token and /account/token
  'token.holdersTitle': 'Open to holders now',
  'token.holdersIntro': 'What a wallet gets, by how much $PRIX it holds. Amounts are whole tokens.',
  'token.holdersColPerk': 'Feature',
  'token.holdersColBelow': 'Below {amount}',
  'token.holdersColFrom': 'From {amount}',
  'token.holdersColTier': 'Tier {tier}',
  'token.holdersSwipe': 'Swipe to see every tier',
  'token.holdersYes': 'Yes',
  'token.holdersNo': 'No',
  'token.perkAgents': 'Agents you can run',
  'token.perkRealtime': "Agents' fills and reasons as they are made, not {delay} later",
  'token.perkBadge': 'A verified badge on your listed on-chain agents',
  'token.perkApiCalls': 'Data API calls a day',
  'token.perkManagers': 'Paper-manager slots',
  'token.perkTemplates': 'Eight more starting strategies on the Build page',
  'token.perkNotes': 'Decision notes for the agents you follow, in your browser',
  'token.perkChat': 'Writing in the Community chat, from {amount} $PRIX',
  'token.perkPictures': "Pictures in the Community chat, under the chat's own rules",
  'token.perkForehead': 'Cosmetics in FOREHEAD, from {lower} and from {higher} $PRIX',
  'token.perkOwnerHolds': '"Owner holds $PRIX" on your agent\'s own page, if you turn it on',
  'token.holdersBadgeValue':
    'A listed on-chain agent keeps its badge as before. A paper agent\'s own page can say "Owner holds $PRIX" once its owner turns it on.',
  'token.holdersRiseNote':
    "A higher tier counts about an hour after Prix first sees the holding. A lower one counts at Prix's next check.",
  'token.ownerHoldsToggle': 'Show "Owner holds $PRIX" on my agents\' pages',
  'token.ownerHoldsToggleNote':
    'Off unless you turn it on. Anyone who sees the mark can tell that the wallet holds at least {amount} $PRIX.',
  'token.holdersLiveHeld':
    "The day's trades of an agent linked to Prix Live show at 20:00 UTC to everyone, holders included; only its owner sees them sooner.",
  'token.holdersLiveNothing': 'Holding $PRIX changes nothing in Prix Live.',
  'token.holdersAccess': 'What $PRIX gives is access to features, never a return.',
  'token.holdersNextTitle': 'Next for holders',
  'token.holdersNextCoach': "The Strategy Coach: help with writing and sharpening your agent's strategy. Not open yet.",
  'token.holdersNextPoll':
    "The holders' poll: wallets holding at least {amount} $PRIX choose between options Prix writes for its paper league.",
  'token.holdersNextPollLink': "See the holders' poll",
  // Revision 8 (POLL-DC-3): while the poll's switch is on, its line stands under this heading, not under
  // "Next for holders", which then names only what is not open yet.
  'token.holdersNowTitle': "The holders' poll is open",
  // B. the agent's own page
  'agent.ownerHolds': 'Owner holds $PRIX',
  'agent.ownerHoldsNote': "The wallet that owns this agent held at least {amount} $PRIX at Prix's last check.",
  // C. /polls
  'polls.title': "Holders' poll",
  'polls.lead':
    'Holders choose between options Prix writes for its paper league. A wallet has one vote, which it can change until the close, and it counts only if the wallet still holds at least {amount} $PRIX when Prix counts the votes after the close.',
  'polls.closesAt': 'Closes {time} UTC',
  'polls.closedAt': 'Closed {time} UTC',
  'polls.castCount': '{count} votes cast',
  'polls.castCountOne': '1 vote cast',
  'polls.castNote':
    'Votes cast so far. A vote counts only if its wallet still holds at least {amount} $PRIX when Prix counts the votes after the close. Once an hour, Prix may remove the votes of wallets that no longer hold it.',
  'polls.counting': 'Closed. The votes are being counted.',
  'polls.countFailed': 'The count could not be completed; Prix will say what happens.',
  'polls.prixWallets': "Prix's own wallets do not vote.",
  'polls.countedCount': '{count} counted',
  'polls.countedCountOne': '1 counted',
  'polls.countedNote':
    'Counted from wallets that still held at least {amount} $PRIX when Prix counted, after the close ({time} UTC).',
  'polls.chosen': 'Chosen: {option}',
  'polls.tie': 'A tie between {options}. Prix picks one of them and says which in its posts.',
  'polls.noneCounted': 'No vote was counted.',
  'polls.optionLink': 'See the agent',
  'polls.vote': 'Vote for this one',
  'polls.yourVote': 'Your vote',
  'polls.changeNote': 'You can change your vote until the poll closes.',
  'polls.signIn': 'Sign in to vote',
  'polls.needTokens':
    'Voting needs at least {amount} $PRIX in the signed-in wallet. A new holding counts about an hour after Prix first sees it.',
  'polls.gateOff': 'Voting opens when $PRIX tiers are on.',
  'polls.saved': 'Vote saved.',
  'polls.refusedClosed': 'This poll is closed.',
  'polls.refusedNotOpen': 'This poll is not open yet.',
  'polls.refusedFull': 'This poll is full for now. Try again in an hour.',
  'polls.refusedUnknownOption': 'That option is not part of this poll. Reload the page.',
  'polls.refusedRateLimited': 'Too many requests. Wait a minute and try again.',
  'polls.failed': 'Your vote was not saved. Try again.',
  'polls.notAdvice':
    'The options are strategies Prix wrote for a paper Model War. Nothing here is investment advice, and holding $PRIX gives access to features, never a return.',
  'polls.closedTitle': 'Closed polls',
  'polls.noneOpen': 'No poll is open right now.',
  'polls.loadFailed': 'The poll did not load. Reload the page to try again.',
  'polls.navLink': "Holders' poll",
} as const;
export type HoldersCopyKey = keyof typeof HOLDERS_COPY;

/**
 * `token.holdersBadgeValue` as the page shows it (revision 4, H3-SEC-1): whole while the owner-holds route is
 * there (`ownerHoldsRouteOn`), and only its first sentence otherwise. Since revision 5 (D5, HB-DC-6) it stands
 * as one plain sentence under the table, with no label: `token.holdersBadgeLabel` is gone.
 */
export function holdersBadgeValueShown(ownerHoldsOn: boolean): string {
  const whole = HOLDERS_COPY['token.holdersBadgeValue'];
  if (ownerHoldsOn) return whole;
  const end = whole.indexOf('. ');
  return end === -1 ? whole : whole.slice(0, end + 1);
}

/**
 * The privacy page's sentence on votes (revision 2, H-SEC-7; revision 4, H3-SEC-7), put by the editor into the
 * privacy page (`apps/web/src/content/pages/**`) exactly as written.
 */
export const HOLDERS_PRIVACY_SENTENCE =
  "A vote keeps the wallet's address and its choice until the poll's result is counted; then only the counts stay, apart from database backups, which are deleted within 30 days.";

/**
 * The one key whose words may say "verified" (revision 5, D1): `token.perkBadge` names the verified badge that
 * listed on-chain agents already carry (`TIER_RULES.verifiedBadge`), the tier table's badge column folded into
 * "Open to holders now". It is never the words of "Owner holds $PRIX", and every other word of this round
 * passes HOLDERS_FORBIDDEN_WORDS whole; this key passes it with the words "verified badge" taken out.
 */
export const HOLDERS_VERIFIED_BADGE_KEY = 'token.perkBadge' as const;

/**
 * Words no page, post or option of this round ever says, but "verified badge" in HOLDERS_VERIFIED_BADGE_KEY's
 * words (revision 5, D1).
 */
export const HOLDERS_FORBIDDEN_WORDS =
  /\b(governance|dao|vote on the token|verified|winner\w*|wins?|won|yield\w*|dividend\w*|earn\w*|reward\w*|apy|apr|profit\w*|returns? on (?:your )?holding|price\w*|moon\w*|pump\w*|airdrop\w*|staking|stake\w*)\b/i;
