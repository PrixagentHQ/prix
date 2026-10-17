// "Open to holders now" and "Next for holders" (docs/contracts/phase-6-holders.md section 2). Pure helpers
// for HoldersTable.astro and the token page: which rows show, what each cell says, and the amounts in whole
// tokens. Every amount is `wholeTokensAtPpm` of the API's own tier table, never a figure typed here; every
// figure of a row is the contract's (`HOLDER_PERKS`, read from the rule that grants it). Nothing here reads a
// price, a value or a share of the supply in percent.
import { type HolderPerk, type TokenInfoResponse, wholeTokensAtPpm } from '@prix/contracts';
import { foreheadFacts, grouped } from '../../content/facts.ts';
import { text } from '../../content/index.ts';
import type { PollsRead, PollsSwitch } from '../polls/read-polls.ts';
import { formatFeedDelay } from './feed-delay.ts';

type TierRow = TokenInfoResponse['tiers'][number];

/** The tiers whose amounts head the columns: 1, 2 and 3. Tier 0 is "below" the first. */
const HOLDER_TIERS = [1, 2, 3] as const;

/**
 * The three amounts in whole tokens, from the API's tier table: `wholeTokensAtPpm(thresholdPpm)` of tiers
 * 1, 2 and 3. Null when the table lacks one of them, so the page shows no block rather than a guess.
 */
export function holderAmounts(tiers: readonly TierRow[]): readonly [number, number, number] | null {
  const amounts = HOLDER_TIERS.map((tier) => {
    const rule = tiers.find((entry) => entry.tier === tier);
    return rule ? wholeTokensAtPpm(rule.thresholdPpm) : null;
  });
  const [first, second, third] = amounts;
  if (first == null || second == null || third == null) return null;
  return [first, second, third];
}

/** The amount as the page writes it: whole tokens, grouped by thousands. */
export function wholeAmount(value: number): string {
  return grouped(value);
}

/** The headers of the four amount columns: below the first amount, then from each amount. */
export function amountColumnLabels(amounts: readonly [number, number, number]): [string, string, string, string] {
  const [first, second, third] = amounts;
  return [
    text('token.holdersColBelow', 'Below {amount}', { amount: wholeAmount(first) }),
    text('token.holdersColFrom', 'From {amount}', { amount: wholeAmount(first) }),
    text('token.holdersColFrom', 'From {amount}', { amount: wholeAmount(second) }),
    text('token.holdersColFrom', 'From {amount}', { amount: wholeAmount(third) }),
  ];
}

/**
 * The marked column's note: its amount, then the wallet's words on a line of their own beneath it, with no
 * middle dot (POLL-DC-4, after DC7-1). HoldersTable keeps the line feed and wraps no note line at any width
 * (`white-space: pre`), so "From {amount}" and the wallet's words each stay whole on their line.
 */
export function markedNote(amount: string, markLabel: string): string {
  return [amount, markLabel].join('\n');
}

/**
 * Whether the holders' poll is open now, for /token's "The holders' poll is open" (POLL-DC-3, H6): the status probe
 * answers on and GET /api/polls lists a poll in the API's own state `open`. Upcoming (never listed), none
 * open, a failed read or the switch off: false, and the poll's line stays under "Next for holders". The page
 * computes no state of its own.
 */
export function pollOpenNow(pollsSwitch: PollsSwitch, read: PollsRead | null): boolean {
  if (pollsSwitch !== 'on' || !read?.ok) return false;
  return read.data.polls.some((poll) => poll.state === 'open');
}

/**
 * The four amount columns of "Open to holders now" (revision 5, D1). Each header names its tier,
 * `token.holdersColTier`, and carries its amount in whole tokens on the note line beneath, a second line in
 * small text. The column a page marks as the wallet's own adds the page's words to that note line, so that
 * its header stays as short as the others and its figures stay in view on a phone (HB-DC-1).
 */
export function amountColumns(
  amountLabels: readonly [string, string, string, string],
  markTier: 0 | 1 | 2 | 3 | null,
  markLabel: string | undefined,
): { key: 't0' | 't1' | 't2' | 't3'; label: string; note: string; align: 'end' }[] {
  const keys = ['t0', 't1', 't2', 't3'] as const;
  return amountLabels.map((amount, index) => ({
    key: keys[index] ?? 't0',
    label: text('token.holdersColTier', 'Tier {tier}', { tier: index }),
    note: markTier === index && markLabel ? markedNote(amount, markLabel) : amount,
    align: 'end' as const,
  }));
}

/**
 * The column the table opens at on a screen narrower than it (revision 5, D2): the wallet's own, for tiers 1
 * to 3, so that it sits beside the sticky Feature column. At tier 0 that column is already there, and signed
 * out there is no mark: the table opens at its start.
 */
export function openColumn(markTier: 0 | 1 | 2 | 3 | null): 't1' | 't2' | 't3' | undefined {
  switch (markTier) {
    case 1:
      return 't1';
    case 2:
      return 't2';
    case 3:
      return 't3';
    default:
      return undefined;
  }
}

/**
 * Each tier's holding in whole tokens, tier 0 to 3, or null while the API's table lacks an amount. Kept for
 * /account/token's tier table where the holders table does not show; /token no longer reads it (revision 5,
 * D1: while the holders table shows, the tier table is folded into it).
 */
export function tierHoldingLabels(tiers: readonly TierRow[]): [string, string, string, string] | null {
  const amounts = holderAmounts(tiers);
  return amounts ? amountColumnLabels(amounts) : null;
}

/**
 * A row's name, or for a row of whole tokens or of another product, its whole sentence with its slots. The
 * `realtime` row's `{delay}` is GET /api/token's `feedDelaySeconds` in words (revision 5, D4), as the tier
 * table's `token.siteFeedLate` has it, never a figure typed here.
 */
export function perkLabel(perk: HolderPerk, feedDelaySeconds: number): string {
  switch (perk.key) {
    case 'agents':
      return text('token.perkAgents', 'Agents you can run');
    case 'realtime':
      return text('token.perkRealtime', "Agents' fills and reasons as they are made, not {delay} later", {
        delay: formatFeedDelay(feedDelaySeconds),
      });
    case 'badge':
      return text('token.perkBadge', 'A verified badge on your listed on-chain agents');
    case 'apiCalls':
      return text('token.perkApiCalls', 'Data API calls a day');
    case 'managers':
      return text('token.perkManagers', 'Paper-manager slots');
    case 'templates':
      return text('token.perkTemplates', 'Eight more starting strategies on the Build page');
    case 'notes':
      return text('token.perkNotes', 'Decision notes for the agents you follow, in your browser');
    case 'chat':
      return text('token.perkChat', 'Writing in the Community chat, from {amount} $PRIX', {
        amount: wholeAmount(perk.kind === 'fromTokens' ? perk.fromTokens : 1),
      });
    case 'pictures':
      return text('token.perkPictures', "Pictures in the Community chat, under the chat's own rules");
    case 'forehead':
      return text('token.perkForehead', 'Cosmetics in FOREHEAD, from {lower} and from {higher} $PRIX', {
        lower: wholeAmount(foreheadFacts.lowerTokens),
        higher: wholeAmount(foreheadFacts.higherTokens),
      });
    case 'ownerHolds':
      return text('token.perkOwnerHolds', '"Owner holds $PRIX" on your agent\'s own page, if you turn it on');
  }
}

/**
 * The cells of one row under the four amount columns (tiers 0 to 3), or null for a row that is one
 * sentence across them (`fromTokens` and `external`, revision 4, HB3-7).
 */
export function perkCells(perk: HolderPerk): [string, string, string, string] | null {
  const yes = text('token.holdersYes', 'Yes');
  const no = text('token.holdersNo', 'No');
  switch (perk.kind) {
    case 'byTier':
      return [
        wholeAmount(perk.byTier[0]),
        wholeAmount(perk.byTier[1]),
        wholeAmount(perk.byTier[2]),
        wholeAmount(perk.byTier[3]),
      ];
    case 'fromTier': {
      const at = (tier: number): string => (tier >= perk.fromTier ? yes : no);
      return [at(0), at(1), at(2), at(3)];
    }
    case 'fromTokens':
    case 'external':
      return null;
  }
}

/** Whether a row's cells are figures (aligned right) rather than words. */
export function perkIsFigure(perk: HolderPerk): boolean {
  return perk.kind === 'byTier';
}

/**
 * `token.holdersBadgeValue` as the page shows it: whole while the owner-holds route is there, and only its
 * first sentence otherwise. The same rule as the contract's `holdersBadgeValueShown`, applied to the deck's
 * string so that the words stay the editor's.
 */
export function badgeValueShown(whole: string, ownerHoldsOn: boolean): string {
  if (ownerHoldsOn) return whole;
  const end = whole.indexOf('. ');
  return end === -1 ? whole : whole.slice(0, end + 1);
}

/** The words of the badge line, by the rule above. */
export function badgeValue(ownerHoldsOn: boolean): string {
  return badgeValueShown(
    text(
      'token.holdersBadgeValue',
      'A listed on-chain agent keeps its badge as before. A paper agent\'s own page can say "Owner holds $PRIX" once its owner turns it on.',
    ),
    ownerHoldsOn,
  );
}
