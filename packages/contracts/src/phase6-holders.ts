import type { ApiDeps } from './api.ts';
import { API_WRITE_ROWS_PER_DAY } from './constants.ts';
import { type Entitlements, type EntitlementsPort, TIER_RULES, type Tier } from './entitlements.ts';
import type { TokenChainReader } from './phase4-token.ts';
import { MANAGER_SLOTS_BY_TIER, type SocialJob } from './phase6-social.ts';
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
 * section 18 "Revision 6" lists each and where it went.
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

/**
 * A guard against a runaway table, not a seat count (revision 2, H-SEC-1): a new wallet is refused
 * `poll_full` only while the poll's votes are at this figure after the last prune (revision 3, H2-SEC-1); a
 * voter may still change its vote. At 4,000 the tally is 10 reads of 400 wallets after one read at the head.
 */
export const POLL_MAX_VOTERS = 4_000;
/**
 * Prune while open (revision 3, H2-SEC-1): while a poll is open and its votes are at least this many, the
 * job's run, at most once every POLL_PRUNE_EVERY_SECONDS, reads every voter at one block by the tally's own
 * path and deletes the votes of the voters below tier 1 or named by `pollWalletExcluded`.
 */
export const POLL_PRUNE_AT = 3_600;
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
/** Wallets one page of the tally reads, and one chain read of `PollHoldingReader.tiersNow` takes (one Multicall3 call). */
export const POLL_TALLY_PAGE = 400;
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
 * A tally or prune run whose reads pass this many seconds from its first read fails at `read` (revision 4,
 * HB3-5), so that the pinned block stays inside a keyless endpoint's window of about 100 blocks.
 */
export const POLL_TALLY_MAX_RUN_SECONDS = 8;
/**
 * `tallyPoll` counts its own outbound fetches, retries and fallbacks included, and fails at `read` before it
 * would pass this many (revision 3, H2-SEC-4), so that the jobs after it in the same social step keep their
 * share of the 50 subrequests.
 */
export const POLL_TALLY_MAX_FETCHES = 30;
/**
 * CPU of one `tiersNow` of POLL_TALLY_PAGE wallets on the fake chain, at most (revision 3, HB-1): perf
 * measures it before engine-runtime builds poll-tally.ts; above it, a contract revision lowers POLL_TALLY_PAGE
 * and POLL_MAX_VOTERS until the worst run stays inside POLL_TALLY_RUN_CPU_MS.
 */
export const POLL_TALLY_PAGE_CPU_MS = 0.7;
/** CPU of the tally's worst run, at most (revision 3, HB-1 and HB-12), inside SOCIAL_CRON's own 10 ms. */
export const POLL_TALLY_RUN_CPU_MS = 8;
/** SOCIAL_CRON's CPU budget of one step, as phase-6-social.md has it; the tally's run stays inside it. */
export const SOCIAL_STEP_CPU_MS = 10;
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
 * `waiting` (gating is off: nothing written), `open` (the poll has not closed POLL_TALLY_SETTLE_SECONDS
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
