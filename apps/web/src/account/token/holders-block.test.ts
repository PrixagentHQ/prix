import { HOLDERS_COPY, holdersBadgeValueShown, type TokenInfoResponse } from '@prix/contracts';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { beforeAll, describe, expect, it } from 'vitest';
import HoldersBlock from './HoldersBlock.astro';
import { holdersTableShown } from './holders-view.ts';

/**
 * "Open to holders now" on /account/token as the server renders it, at revision 5 of
 * docs/contracts/phase-6-holders.md: the tier table folded into it while it shows (D1), the wallet's column
 * handed to the table for its opening scroll (D2), and the badge line as one plain sentence with no label (D5).
 */

const TIERS: TokenInfoResponse['tiers'] = [
  { tier: 0, thresholdPpm: 0, maxAgents: 1, realtimeFeed: false, verifiedBadge: false, apiDailyQuota: 50 },
  { tier: 1, thresholdPpm: 10, maxAgents: 3, realtimeFeed: true, verifiedBadge: false, apiDailyQuota: 500 },
  { tier: 2, thresholdPpm: 100, maxAgents: 10, realtimeFeed: true, verifiedBadge: true, apiDailyQuota: 2000 },
  { tier: 3, thresholdPpm: 1000, maxAgents: 25, realtimeFeed: true, verifiedBadge: true, apiDailyQuota: 5000 },
];

let container: AstroContainer;

beforeAll(async () => {
  container = await AstroContainer.create();
});

/** The block's HTML with the entities the words carry turned back into characters. */
async function render(props: Record<string, unknown>): Promise<string> {
  const html = await container.renderToString(HoldersBlock, {
    props: {
      tiers: TIERS,
      feedDelaySeconds: 86_400,
      picturesOn: true,
      ownerHoldsOn: true,
      ownerHoldsShow: false,
      markTier: null,
      ...props,
    },
    request: new Request('https://prixagent.com/account/token'),
  });
  return html.replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&amp;', '&');
}

describe('whether "Open to holders now" shows in place of the tier table (D1)', () => {
  it('shows when GET /api/token answered with the three amounts, and not otherwise', () => {
    expect(holdersTableShown({ tiers: TIERS })).toBe(true);
    expect(holdersTableShown({ tiers: TIERS.filter((rule) => rule.tier !== 3) })).toBe(false);
    expect(holdersTableShown({ tiers: [] })).toBe(false);
    expect(holdersTableShown(null)).toBe(false);
  });
});

describe('the block beneath the table', () => {
  it('says the badge line as one plain sentence with no label, in the contract order (D5)', async () => {
    const html = await render({});
    const badge = holdersBadgeValueShown(true);
    expect(html).toMatch(/<p class="small"[^>]*data-holders-badge[^>]*>A listed on-chain agent/);
    expect(html).toContain(badge);
    expect(html).not.toContain('Marks on your agents');
    expect(html).not.toMatch(/<dl\b/);
    const order = [
      HOLDERS_COPY['token.holdersRiseNote'],
      HOLDERS_COPY['token.holdersLiveHeld'],
      HOLDERS_COPY['token.holdersLiveNothing'],
      badge,
      HOLDERS_COPY['token.holdersAccess'],
    ].map((words) => html.indexOf(words));
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('keeps only the first sentence of the badge line while the owner-holds route is not there', async () => {
    const html = await render({ ownerHoldsOn: false, ownerHoldsShow: null });
    expect(html).toContain(holdersBadgeValueShown(false));
    expect(html).not.toContain('Owner holds $PRIX" once');
    expect(html).not.toContain('data-owner-holds-form');
  });
});

describe("the wallet's column (D2)", () => {
  it('is handed to the table, which opens at it on a narrow screen', async () => {
    for (const tier of [1, 2, 3] as const) {
      const html = await render({ markTier: tier });
      expect(html).toContain(`data-mark-tier="${tier}"`);
    }
  });

  it('is none while signed in with tiers off', async () => {
    const html = await render({ markTier: null });
    expect(html).not.toContain('data-mark-tier=');
  });
});
