import { HOLDERS_COPY, holdersBadgeValueShown, type TokenInfoResponse } from '@prix/contracts';
import { describe, expect, it } from 'vitest';
import { ownerHoldsOnOf } from './holders-reads.ts';
import { badgeValueShown, markTierOf, thresholdPpmOf } from './holders-view.ts';
import { mountOwnerHolds } from './token-client.ts';

/**
 * "Open to holders now" on /account/token and the mark's switch (docs/contracts/phase-6-holders.md sections 2
 * and 3): the owner-holds row and switch only while the route is there, the badge line cut to its first
 * sentence otherwise, the wallet's own column marked only while tiers are on.
 */

describe('whether the owner-holds route is there', () => {
  it('is 200 or 401, never 404, another status or a read that never reached the API', () => {
    expect(ownerHoldsOnOf({ ok: true, status: 200, data: { show: false } })).toBe(true);
    expect(ownerHoldsOnOf({ ok: false, status: 401, error: { code: 'unauthorized', message: '', field: null } })).toBe(
      true,
    );
    expect(ownerHoldsOnOf({ ok: false, status: 404, error: { code: 'not_found', message: '', field: null } })).toBe(
      false,
    );
    expect(ownerHoldsOnOf({ ok: false, status: 500, error: { code: 'internal', message: '', field: null } })).toBe(
      false,
    );
    expect(ownerHoldsOnOf({ ok: false, status: 502, error: { code: 'internal', message: '', field: null } })).toBe(
      false,
    );
    expect(ownerHoldsOnOf(null)).toBe(false);
  });
});

describe('the badge line', () => {
  it("is the contract's rule applied to the deck's string", () => {
    const whole = HOLDERS_COPY['token.holdersBadgeValue'];
    expect(badgeValueShown(whole, true)).toBe(holdersBadgeValueShown(true));
    expect(badgeValueShown(whole, false)).toBe(holdersBadgeValueShown(false));
    expect(badgeValueShown(whole, false)).not.toContain('Owner holds');
  });
});

describe("the wallet's column", () => {
  it('is its tier while tiers are on, and none while they are off', () => {
    expect(markTierOf({ gatingOn: true, tier: 0 })).toBe(0);
    expect(markTierOf({ gatingOn: true, tier: 3 })).toBe(3);
    expect(markTierOf({ gatingOn: false, tier: 2 })).toBeNull();
    expect(markTierOf({ gatingOn: true, tier: 7 })).toBeNull();
    expect(markTierOf(null)).toBeNull();
  });

  it("takes the tier-two amount from the API's own table", () => {
    const tiers: TokenInfoResponse['tiers'] = [
      { tier: 0, thresholdPpm: 0, maxAgents: 1, realtimeFeed: false, verifiedBadge: false, apiDailyQuota: 50 },
      { tier: 2, thresholdPpm: 70, maxAgents: 10, realtimeFeed: true, verifiedBadge: true, apiDailyQuota: 2000 },
    ];
    expect(thresholdPpmOf(tiers, 2)).toBe(70);
    expect(thresholdPpmOf(tiers, 3)).toBeNull();
  });
});

/** A form with one checkbox, enough of the DOM for the switch's script. */
function fakeForm(checked: boolean) {
  const listeners: Record<string, (event: { preventDefault(): void }) => unknown> = {};
  const box = {
    checked,
    disabled: false,
    focused: 0,
    addEventListener(name: string, listener: () => unknown) {
      listeners[`box:${name}`] = listener;
    },
    focus() {
      box.focused += 1;
    },
  };
  const attributes = new Map<string, string>();
  const form = {
    querySelector: (selector: string) => (selector === 'input[name="ownerHolds"]' ? box : null),
    addEventListener(name: string, listener: (event: { preventDefault(): void }) => unknown) {
      listeners[`form:${name}`] = listener;
    },
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    removeAttribute: (name: string) => attributes.delete(name),
  };
  return { box, form, attributes, change: () => listeners['box:change']?.({ preventDefault() {} }) };
}

describe('the switch', () => {
  it('shows what the server stored', async () => {
    const { box, form, change } = fakeForm(false);
    const asked: boolean[] = [];
    mountOwnerHolds(form as unknown as HTMLElement, async (show) => {
      asked.push(show);
      return { ok: true, status: 200, data: { show } };
    });
    box.checked = true;
    await change();
    expect(asked).toEqual([true]);
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(false);
  });

  it('goes back to what it was when the server refuses', async () => {
    const { box, form, change } = fakeForm(true);
    const shown: unknown[] = [];
    (globalThis as { document?: unknown }).document = {
      querySelector: () => null,
      activeElement: null,
    };
    const outlet = { replaceChildren: () => {}, dataset: {} as Record<string, string> };
    Object.assign(form, {
      querySelector: (selector: string) =>
        selector === 'input[name="ownerHolds"]' ? box : selector === '[data-outlet]' ? outlet : null,
      querySelectorAll: () => [],
      getAttribute: () => null,
    });
    mountOwnerHolds(form as unknown as HTMLElement, async () => {
      shown.push('asked');
      return { ok: false, status: 429, error: { code: 'rate_limited', message: '', field: null } };
    });
    box.checked = false;
    await change();
    expect(shown).toEqual(['asked']);
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(false);
    delete (globalThis as { document?: unknown }).document;
  });
});
