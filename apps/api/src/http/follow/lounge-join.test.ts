import { entitlementsOfTier, LOUNGE_MEMBERS_MAX, loungeDirectMessage } from '@prix/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BOT_TOKEN,
  CHAT_ID,
  joinUpdate,
  type LoungeHarness,
  loungeHarness,
  NOW,
  OTHER_USER,
  OTHER_WALLET,
  SITE,
  USER,
  WALLET,
} from './test-support-lounge.ts';

/**
 * Join requests to the lounge in the Telegram webhook (docs/contracts/phase-6-holders-2.md section 4.4): the
 * secret first, then each refusal in its order with the reads after it left unread, the direct message
 * before the decline, the row stored before the approval, and every update answered 200.
 */

let lines: string[] = [];
beforeEach(() => {
  lines = [];
  const keep = (...parts: unknown[]): void => {
    lines.push(parts.map(String).join(' '));
  };
  vi.spyOn(console, 'log').mockImplementation(keep);
  vi.spyOn(console, 'error').mockImplementation(keep);
  vi.spyOn(console, 'warn').mockImplementation(keep);
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const line of lines) {
    expect(line).not.toContain(BOT_TOKEN);
    expect(line).not.toContain(WALLET);
    expect(line).not.toContain(String(USER));
  }
});

/** A holder at tier 1, linked, with a fresh read. */
function holderReady(h: LoungeHarness): void {
  h.chats.set(USER, { wallet: WALLET, enabled: true });
  h.tiers.set(WALLET, entitlementsOfTier(1));
  h.checkedAt.set(WALLET, '2026-10-20T11:55:00.000Z');
}

function methods(h: LoungeHarness): string[] {
  return h.calls.map((call) => call.method);
}

describe('the webhook and a join request', () => {
  it('reads no body and calls nothing without the secret', async () => {
    const h = loungeHarness();
    holderReady(h);
    for (const secret of [null, 'wrong']) {
      const reply = await h.webhook(joinUpdate(USER), { secret });
      expect(reply.status).toBe(403);
    }
    expect(h.trace).toEqual([]);
  });

  it('does nothing for a request to another chat, or while the lounge is off', async () => {
    const h = loungeHarness();
    holderReady(h);
    expect((await h.webhook(joinUpdate(USER, { chatId: -1009999999999 }))).status).toBe(200);
    const off = loungeHarness({ lounge: false });
    holderReady(off);
    expect((await off.webhook(joinUpdate(USER))).status).toBe(200);
    expect(h.trace).toEqual([]);
    expect(off.trace).toEqual([]);
  });

  it('declines a bot with no direct message and reads nothing', async () => {
    const h = loungeHarness();
    holderReady(h);
    await h.webhook(joinUpdate(USER, { isBot: true }));
    expect(h.calls).toEqual([{ method: 'declineJoin', chatId: CHAT_ID, arg: USER }]);
    expect(h.trace).toEqual(['telegram.declineJoin']);
  });

  it('declines not_linked with its message first, and reads nothing after the link', async () => {
    const h = loungeHarness();
    await h.webhook(joinUpdate(USER));
    expect(h.calls).toEqual([
      { method: 'sendDirect', chatId: USER, arg: loungeDirectMessage('not_linked', SITE) },
      { method: 'declineJoin', chatId: CHAT_ID, arg: USER },
    ]);
    expect(h.trace).toEqual(['store.chatWallet', 'telegram.sendDirect', 'telegram.declineJoin']);
    expect(String(h.calls[0]?.arg)).toContain(`${SITE}/following`);
  });

  it('declines wallet_taken when another account holds the wallet', async () => {
    const h = loungeHarness();
    holderReady(h);
    h.members.set(OTHER_USER, { telegramUserId: OTHER_USER, wallet: WALLET, joinedAt: NOW, checkedDay: '2026-10-20' });
    await h.webhook(joinUpdate(USER));
    expect(h.calls.map((call) => [call.method, call.arg])).toEqual([
      ['sendDirect', loungeDirectMessage('wallet_taken', SITE)],
      ['declineJoin', USER],
    ]);
    expect(h.trace).not.toContain('entitlements:full');
  });

  it('declines gate_off before any freshness read', async () => {
    const h = loungeHarness();
    holderReady(h);
    h.gatingOn.value = false;
    await h.webhook(joinUpdate(USER));
    expect(h.calls.map((call) => call.arg)).toEqual([loungeDirectMessage('gate_off', SITE), USER]);
    expect(h.trace).not.toContain('token.holding');
  });

  it('declines below_tier on a fresh read, reading the tier without cachedOnly', async () => {
    const h = loungeHarness();
    holderReady(h);
    h.tiers.set(WALLET, entitlementsOfTier(0));
    await h.webhook(joinUpdate(USER));
    expect(h.calls.map((call) => call.arg)).toEqual([loungeDirectMessage('below_tier', SITE), USER]);
    expect(h.trace).toContain('entitlements:full');
    expect(h.trace).not.toContain('entitlements:cachedOnly');
  });

  it('declines full when the counted rows reach the cap and the account has none', async () => {
    const h = loungeHarness();
    holderReady(h);
    h.countExtra.value = LOUNGE_MEMBERS_MAX;
    await h.webhook(joinUpdate(USER));
    expect(h.calls.map((call) => call.arg)).toEqual([loungeDirectMessage('full', SITE), USER]);
    expect(h.members.has(USER)).toBe(false);
  });

  it('neither approves nor declines without a read inside TOKEN_CACHE_SECONDS', async () => {
    for (const checkedAt of [null, '2026-10-20T11:44:59.000Z', '2026-10-20T12:00:01.000Z']) {
      const h = loungeHarness();
      holderReady(h);
      h.checkedAt.set(WALLET, checkedAt);
      expect((await h.webhook(joinUpdate(USER))).status).toBe(200);
      expect(h.calls).toEqual([]);
      expect(h.members.size).toBe(0);
    }
    // Without the token read in the deps at all, nothing is ever fresh: ignored.
    const h = loungeHarness({ holding: false });
    holderReady(h);
    await h.webhook(joinUpdate(USER));
    expect(h.calls).toEqual([]);
  });

  it('declines even when the direct message fails', async () => {
    const h = loungeHarness();
    h.answers.sendDirect = { ok: false, reason: 'blocked', retryAfterSeconds: null };
    await h.webhook(joinUpdate(USER));
    expect(methods(h)).toEqual(['sendDirect', 'declineJoin']);
  });

  it('sends one direct message a user, a reason, a day', async () => {
    const h = loungeHarness();
    await h.webhook(joinUpdate(USER));
    await h.webhook(joinUpdate(USER));
    expect(methods(h)).toEqual(['sendDirect', 'declineJoin', 'declineJoin']);
    h.setNow('2026-10-21T00:00:01.000Z');
    await h.webhook(joinUpdate(USER));
    expect(methods(h)).toEqual(['sendDirect', 'declineJoin', 'declineJoin', 'sendDirect', 'declineJoin']);
  });

  it('stores the row before it approves', async () => {
    const h = loungeHarness();
    holderReady(h);
    await h.webhook(joinUpdate(USER));
    expect(h.trace.slice(-2)).toEqual(['store.putMember', 'telegram.approveJoin']);
    expect(h.calls).toEqual([{ method: 'approveJoin', chatId: CHAT_ID, arg: USER }]);
    expect(h.members.get(USER)?.wallet).toBe(WALLET);
    expect(lines.some((line) => line.includes('lounge_join_approved'))).toBe(true);
  });

  it('deletes the row when the approval is rejected, keeps it on retry, and logs each', async () => {
    const rejected = loungeHarness();
    holderReady(rejected);
    rejected.answers.approveJoin = { ok: false, reason: 'rejected', retryAfterSeconds: null };
    await rejected.webhook(joinUpdate(USER));
    expect(rejected.members.has(USER)).toBe(false);
    expect(rejected.trace.at(-1)).toBe('store.deleteMember');

    const retry = loungeHarness();
    holderReady(retry);
    retry.answers.approveJoin = { ok: false, reason: 'retry', retryAfterSeconds: 3 };
    await retry.webhook(joinUpdate(USER));
    expect(retry.members.has(USER)).toBe(true);
    expect(retry.trace).not.toContain('store.deleteMember');
    expect(lines.filter((line) => line.includes('lounge_join_failed'))).toHaveLength(2);
  });

  it('declines wallet_taken when the store refuses the row in a race', async () => {
    const h = loungeHarness();
    holderReady(h);
    h.putRace.value = true;
    await h.webhook(joinUpdate(USER));
    expect(h.calls.map((call) => [call.method, call.arg])).toEqual([
      ['sendDirect', loungeDirectMessage('wallet_taken', SITE)],
      ['declineJoin', USER],
    ]);
  });

  it('counts a chat whose notes are paused as linked', async () => {
    const h = loungeHarness();
    holderReady(h);
    h.chats.set(USER, { wallet: WALLET, enabled: false });
    await h.webhook(joinUpdate(USER));
    expect(methods(h)).toEqual(['approveJoin']);
  });

  it('answers 200 to every authenticated update, even one whose store throws', async () => {
    const h = loungeHarness();
    holderReady(h);
    h.chats.get = () => {
      throw new Error(`boom ${BOT_TOKEN}`);
    };
    expect((await h.webhook(joinUpdate(USER))).status).toBe(200);
    expect((await h.webhook({ update_id: 2 })).status).toBe(200);
  });

  it('a second wallet of the same account is never let in twice: the store keeps one row an account', async () => {
    const h = loungeHarness();
    holderReady(h);
    await h.webhook(joinUpdate(USER));
    h.chats.set(USER, { wallet: OTHER_WALLET, enabled: true });
    h.tiers.set(OTHER_WALLET, entitlementsOfTier(1));
    h.checkedAt.set(OTHER_WALLET, '2026-10-20T11:59:00.000Z');
    await h.webhook(joinUpdate(USER));
    expect([...h.members.values()].map((member) => member.wallet)).toEqual([OTHER_WALLET]);
  });
});
