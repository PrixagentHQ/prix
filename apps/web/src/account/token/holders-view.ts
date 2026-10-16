import type { TokenInfoResponse } from '@prix/contracts';
import { holderAmounts } from '../../site/token/holders.ts';

/**
 * Pure helpers of "Open to holders now" on /account/token (docs/contracts/phase-6-holders.md section 2). No
 * word is written here; no amount is typed here.
 */

/**
 * `token.holdersBadgeValue` as the page shows it (revision 4, H3-SEC-1): whole while the owner-holds route is
 * there, and only its first sentence otherwise. The contract's `holdersBadgeValueShown` applied to the deck's
 * string, so that the words stay the editor's.
 */
export function badgeValueShown(whole: string, ownerHoldsOn: boolean): string {
  if (ownerHoldsOn) return whole;
  const end = whole.indexOf('. ');
  return end === -1 ? whole : whole.slice(0, end + 1);
}

/** The column the signed-in wallet's tier marks: its tier while tiers are on, none while they are off. */
export function markTierOf(me: { gatingOn: boolean; tier: number } | null): 0 | 1 | 2 | 3 | null {
  if (!me?.gatingOn) return null;
  return me.tier === 0 || me.tier === 1 || me.tier === 2 || me.tier === 3 ? me.tier : null;
}

/**
 * Whether "Open to holders now" shows (revision 5, D1): GET /api/token answered and its tier table holds the
 * three amounts the table's columns are headed by. While it shows, the tier table ("What each tier unlocks") is
 * folded into it and not shown on its own; where it does not show, the tier table stays as it is.
 */
export function holdersTableShown(info: Pick<TokenInfoResponse, 'tiers'> | null): boolean {
  return info !== null && holderAmounts(info.tiers) !== null;
}

/** The ppm of tier `tier` in the API's own tier table, or null when the table lacks it. */
export function thresholdPpmOf(tiers: TokenInfoResponse['tiers'], tier: 1 | 2 | 3): number | null {
  return tiers.find((entry) => entry.tier === tier)?.thresholdPpm ?? null;
}
