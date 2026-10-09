import type { Address } from './primitives.ts';

/**
 * What a wallet may do, decided on the server and nowhere else.
 *
 * This file is the one seam between the phases. Phase 3 (the feed delay), Phase 2 (the
 * verified badge), Phase 5 (the API quota) and the agent builder (the number of agents) ask an
 * `EntitlementsPort`. Phase 4 supplies the implementation that reads the token balance from
 * the chain. Until the token exists and the gating flag is on, the port in use answers
 * `OPEN_PREVIEW_ENTITLEMENTS` for everyone.
 */
export type Tier = 0 | 1 | 2 | 3;

export interface TierRule {
  tier: Tier;
  /** The share of the total supply a wallet must hold, in parts per million. */
  thresholdPpm: number;
  /** How many agents the wallet may own. */
  maxAgents: number;
  /** Whether decisions of followed agents are shown without the delay. */
  realtimeFeed: boolean;
  /** Whether a listed on-chain agent of this wallet may carry the verified badge. */
  verifiedBadge: boolean;
  /** Calls a day to the public API, across all keys of the wallet. */
  apiDailyQuota: number;
}

/** The defaults of docs/SPEC.md section 11. Thresholds are config, and may only ever be lowered. */
export const TIER_RULES: readonly TierRule[] = [
  { tier: 0, thresholdPpm: 0, maxAgents: 1, realtimeFeed: false, verifiedBadge: false, apiDailyQuota: 50 },
  { tier: 1, thresholdPpm: 10, maxAgents: 3, realtimeFeed: true, verifiedBadge: false, apiDailyQuota: 500 },
  { tier: 2, thresholdPpm: 100, maxAgents: 10, realtimeFeed: true, verifiedBadge: true, apiDailyQuota: 2_000 },
  { tier: 3, thresholdPpm: 1_000, maxAgents: 25, realtimeFeed: true, verifiedBadge: true, apiDailyQuota: 5_000 },
];

/** How long a decision is held back from a viewer without the real-time feed, once gating is on. */
export const FEED_DELAY_SECONDS = 86_400;

export interface Entitlements {
  tier: Tier;
  maxAgents: number;
  /** Zero means no delay. */
  feedDelaySeconds: number;
  verifiedBadge: boolean;
  apiDailyQuota: number;
  /** False while the token does not exist or the gating flag is off: the site then says "preview". */
  gatingOn: boolean;
}

/**
 * Before the token exists: everyone sees decisions without delay, owns one agent, and has the
 * free API quota. docs/SPEC.md section 10.
 */
export const OPEN_PREVIEW_ENTITLEMENTS: Entitlements = {
  tier: 0,
  maxAgents: 1,
  feedDelaySeconds: 0,
  verifiedBadge: false,
  apiDailyQuota: 50,
  gatingOn: false,
};

/** What a tier gives once gating is on. */
export function entitlementsOfTier(tier: Tier): Entitlements {
  const rule = TIER_RULES.find((entry) => entry.tier === tier) ?? TIER_RULES[0];
  if (rule === undefined) return OPEN_PREVIEW_ENTITLEMENTS;
  return {
    tier: rule.tier,
    maxAgents: rule.maxAgents,
    feedDelaySeconds: rule.realtimeFeed ? 0 : FEED_DELAY_SECONDS,
    verifiedBadge: rule.verifiedBadge,
    apiDailyQuota: rule.apiDailyQuota,
    gatingOn: true,
  };
}

export interface EntitlementsReadOptions {
  /**
   * For scheduled work with a small subrequest budget (the notice delivery of Phase 3). The port
   * must not read the chain: it answers from its memory or from the stored read of the wallet, of any
   * age up to its stale grace, and with tier 0 when it has none. A caller that sets it accepts a tier
   * that is up to a day old. Default false.
   */
  cachedOnly?: boolean;
}

export interface EntitlementsPort {
  /** Null is a visitor who is not signed in. Never trusts anything the client says about a balance. */
  entitlementsFor(address: Address | null, options?: EntitlementsReadOptions): Promise<Entitlements>;
}

/** The port in use until Phase 4 is switched on. */
export const openPreviewEntitlements: EntitlementsPort = {
  entitlementsFor: async () => OPEN_PREVIEW_ENTITLEMENTS,
};
