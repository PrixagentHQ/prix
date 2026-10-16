import { entitlementsOfTier, LOUNGE_DIRECT_MESSAGES, LOUNGE_MEMBERS_MAX, TOKEN_CACHE_SECONDS } from '@prix/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BOT_TOKEN,
  CHAT_ID,
  joinUpdate,
  loungeHarness,
  NOW,
  OTHER_USER,
  OTHER_WALLET,
  USER,
  WALLET,
} from '../../apps/api/src/http/follow/test-support-lounge.ts';

/**
 * Phase 6.8, G (docs/contracts/phase-6-holders-2.md section 4.4, qa case 5): the webhook's join requests,
 * each refusal in its order, behind the real route of `createApp`. The store, the token reads and the
 * Telegram port are in memory and write to one trace, so the order of reads and calls is what is pinned.
 */

const FRESH = new Date(Date.parse(NOW) - 60_000).toISOString();

function capture() {
  const lines: string[] = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      lines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
    });
  }
  return lines;
}

afterEach(() => {
  vi.restoreAllMocks();
});

function linked(tier: 0 | 1 | 2 | 3, options: { enabled?: boolean; checkedAt?: string | null } = {}) {
  const h = loungeHarness();
  h.chats.set(USER, { wallet: WALLET, enabled: options.enabled ?? true });
  h.tiers.set(WALLET, entitlementsOfTier(tier));
  h.checkedAt.set(WALLET, options.checkedAt === undefined ? FRESH : options.checkedAt);
  return h;
}

const methods = (h: ReturnType<typeof loungeHarness>) => h.calls.map((call) => call.method);
const telegramSteps = (h: ReturnType<typeof loungeHarness>) => h.trace.filter((step) => step.startsWith('telegram.'));

describe('case 5: each refusal declines with exactly its message, the message first', () => {
  const cases: [string, () => ReturnType<typeof loungeHarness>, keyof typeof LOUNGE_DIRECT_MESSAGES][] = [
    ['not_linked', () => loungeHarness(), 'not_linked'],
    [
      'wallet_taken',
      () => {
        const h = linked(3);
        h.members.set(OTHER_USER, {
          telegramUserId: OTHER_USER,
          wallet: WALLET,
          joinedAt: NOW,
          checkedDay: NOW.slice(0, 10),
        });
        return h;
      },
      'wallet_taken',
    ],
    [
      'gate_off',
      () => {
        const h = linked(3);
        h.gatingOn.value = false;
        return h;
      },
      'gate_off',
    ],
    ['below_tier', () => linked(0), 'below_tier'],
    [
      'full',
      () => {
        const h = linked(3);
        h.countExtra.value = LOUNGE_MEMBERS_MAX;
        return h;
      },
      'full',
    ],
  ];

  for (const [label, make, reason] of cases) {
    it(`${label}: sendDirect to user_chat_id, then declineJoin, nothing stored, 200`, async () => {
      const h = make();
      const before = h.members.size;
      const reply = await h.webhook(joinUpdate(USER));
      expect(reply.status).toBe(200);
      expect(methods(h)).toEqual(['sendDirect', 'declineJoin']);
      expect(h.calls[0]?.chatId).toBe(USER);
      expect(String(h.calls[0]?.arg)).toBe(
        LOUNGE_DIRECT_MESSAGES[reason].replace('{following}', 'https://prix.test/following'),
      );
      expect(h.calls[1]?.chatId).toBe(CHAT_ID);
      expect(h.calls[1]?.arg).toBe(USER);
      expect(h.members.size).toBe(before);
      expect(h.trace).not.toContain('store.putMember');
    });
  }

  it('a direct message that fails still declines', async () => {
    for (const answer of [
      { ok: false as const, reason: 'blocked' as const, retryAfterSeconds: null },
      { ok: false as const, reason: 'retry' as const, retryAfterSeconds: 3 },
      { ok: false as const, reason: 'rejected' as const, retryAfterSeconds: null },
    ]) {
      const h = linked(0);
      h.answers.sendDirect = answer;
      expect((await h.webhook(joinUpdate(USER))).status).toBe(200);
      expect(methods(h)).toEqual(['sendDirect', 'declineJoin']);
    }
  });

  it('a second decline of the same user for the same reason on the same UTC day sends no message, the next day does', async () => {
    const h = linked(0);
    await h.webhook(joinUpdate(USER));
    await h.webhook(joinUpdate(USER));
    expect(methods(h)).toEqual(['sendDirect', 'declineJoin', 'declineJoin']);
    // Another reason the same day is a message of its own.
    h.chats.delete(USER);
    await h.webhook(joinUpdate(USER));
    expect(methods(h)).toEqual(['sendDirect', 'declineJoin', 'declineJoin', 'sendDirect', 'declineJoin']);
    // The next UTC day, the first reason sends again.
    h.chats.set(USER, { wallet: WALLET, enabled: true });
    h.setNow('2026-10-21T00:00:30.000Z');
    h.checkedAt.set(WALLET, '2026-10-21T00:00:00.000Z');
    h.calls.length = 0;
    await h.webhook(joinUpdate(USER));
    expect(methods(h)).toEqual(['sendDirect', 'declineJoin']);
  });
});

describe('case 5: a request with no fresh read is neither approved nor declined', () => {
  it('no read at all (the budget spent, the chain unreadable): nothing is called and nothing stored', async () => {
    const h = linked(3, { checkedAt: null });
    expect((await h.webhook(joinUpdate(USER))).status).toBe(200);
    expect(h.calls).toEqual([]);
    expect(h.members.size).toBe(0);
  });

  it('a read exactly TOKEN_CACHE_SECONDS old is not fresh; one a second younger is', async () => {
    const old = new Date(Date.parse(NOW) - TOKEN_CACHE_SECONDS * 1000).toISOString();
    const h = linked(3, { checkedAt: old });
    await h.webhook(joinUpdate(USER));
    expect(h.calls).toEqual([]);
    const young = new Date(Date.parse(NOW) - (TOKEN_CACHE_SECONDS - 1) * 1000).toISOString();
    const g = linked(3, { checkedAt: young });
    await g.webhook(joinUpdate(USER));
    expect(methods(g)).toEqual(['approveJoin']);
  });

  it('a tier dropped to 0 with a stale read is ignored, never approved on the old tier', async () => {
    const h = linked(1, { checkedAt: '2026-10-19T12:00:00.000Z' });
    await h.webhook(joinUpdate(USER));
    expect(methods(h)).not.toContain('approveJoin');
    expect(h.members.size).toBe(0);
  });
});

describe('case 5: a refusal leaves every later read unread', () => {
  it('not_linked reads no member row and no holding', async () => {
    const h = loungeHarness();
    await h.webhook(joinUpdate(USER));
    expect(h.trace.filter((step) => !step.startsWith('telegram.'))).toEqual(['store.chatWallet']);
  });

  it('wallet_taken reads no holding', async () => {
    const h = linked(3);
    h.members.set(OTHER_USER, { telegramUserId: OTHER_USER, wallet: WALLET, joinedAt: NOW, checkedDay: '2026-10-20' });
    await h.webhook(joinUpdate(USER));
    expect(h.trace.filter((step) => !step.startsWith('telegram.'))).toEqual(['store.chatWallet', 'store.members']);
  });

  it('gate_off reads the entitlements and not the holding time', async () => {
    const h = linked(3);
    h.gatingOn.value = false;
    await h.webhook(joinUpdate(USER));
    expect(h.trace.filter((step) => !step.startsWith('telegram.'))).toEqual([
      'store.chatWallet',
      'store.members',
      'entitlements:full',
    ]);
  });

  it('a bot reads nothing at all', async () => {
    const h = linked(3);
    await h.webhook(joinUpdate(USER, { isBot: true }));
    expect(h.trace).toEqual(['telegram.declineJoin']);
  });
});

describe('case 5: approval', () => {
  it('stores the row before it approves, reading the tier without cachedOnly', async () => {
    const lines = capture();
    const h = linked(1);
    expect((await h.webhook(joinUpdate(USER))).status).toBe(200);
    expect(h.trace).toEqual([
      'store.chatWallet',
      'store.members',
      'entitlements:full',
      'token.holding',
      'store.putMember',
      'telegram.approveJoin',
    ]);
    expect(h.members.get(USER)?.wallet).toBe(WALLET);
    expect(h.calls[0]).toEqual({ method: 'approveJoin', chatId: CHAT_ID, arg: USER });
    expect(lines.join('\n')).not.toContain(BOT_TOKEN);
    expect(lines.join('\n')).not.toContain(WALLET);
    expect(lines.join('\n')).not.toContain(String(USER));
  });

  it('a chat whose notes are paused (enabled false) still counts as linked', async () => {
    const h = linked(2, { enabled: false });
    await h.webhook(joinUpdate(USER));
    expect(methods(h)).toEqual(['approveJoin']);
  });

  it('an approval that answers rejected deletes the row and logs lounge_join_failed', async () => {
    const lines = capture();
    const h = linked(1);
    h.answers.approveJoin = { ok: false, reason: 'rejected', retryAfterSeconds: null };
    expect((await h.webhook(joinUpdate(USER))).status).toBe(200);
    expect(telegramSteps(h)).toEqual(['telegram.approveJoin']);
    expect(h.trace.slice(-2)).toEqual(['telegram.approveJoin', 'store.deleteMember']);
    expect(h.members.size).toBe(0);
    expect(lines.some((line) => line.includes('lounge_join_failed'))).toBe(true);
  });

  for (const reason of ['retry', 'blocked'] as const) {
    it(`an approval that answers ${reason} keeps the row and logs lounge_join_failed`, async () => {
      const lines = capture();
      const h = linked(1);
      h.answers.approveJoin = { ok: false, reason, retryAfterSeconds: null };
      expect((await h.webhook(joinUpdate(USER))).status).toBe(200);
      expect(h.trace).not.toContain('store.deleteMember');
      expect(h.members.get(USER)?.wallet).toBe(WALLET);
      expect(lines.some((line) => line.includes('lounge_join_failed'))).toBe(true);
    });
  }

  it('a race lost at putMember declines as wallet_taken and never approves', async () => {
    const h = linked(3);
    h.putRace.value = true;
    await h.webhook(joinUpdate(USER));
    expect(methods(h)).toEqual(['sendDirect', 'declineJoin']);
    expect(String(h.calls[0]?.arg)).toBe(LOUNGE_DIRECT_MESSAGES.wallet_taken);
  });

  it('a member asking again is not refused as full, and its own row is not wallet_taken', async () => {
    const h = linked(1);
    h.members.set(USER, { telegramUserId: USER, wallet: WALLET, joinedAt: NOW, checkedDay: '2026-10-20' });
    h.countExtra.value = LOUNGE_MEMBERS_MAX;
    await h.webhook(joinUpdate(USER));
    expect(methods(h)).toEqual(['approveJoin']);
  });

  it('a Telegram account linked to two wallets cannot be: the chat names one wallet, and a second account of that wallet is refused', async () => {
    const h = linked(3);
    // The other wallet was linked to another account and let it in.
    h.chats.set(OTHER_USER, { wallet: OTHER_WALLET, enabled: true });
    h.tiers.set(OTHER_WALLET, entitlementsOfTier(3));
    h.checkedAt.set(OTHER_WALLET, FRESH);
    await h.webhook(joinUpdate(USER));
    await h.webhook(joinUpdate(OTHER_USER));
    expect(h.members.get(USER)?.wallet).toBe(WALLET);
    expect(h.members.get(OTHER_USER)?.wallet).toBe(OTHER_WALLET);
    expect(methods(h)).toEqual(['approveJoin', 'approveJoin']);
  });
});

describe('case 5: every authenticated update answers 200', () => {
  it('a store that throws, a malformed join request and a plain group message each answer 200 and approve nothing', async () => {
    const lines = capture();
    const h = linked(3);
    h.answers.approveJoin = undefined;
    const broken = h as unknown as { members: Map<number, unknown> };
    // A store failure in the middle of the steps.
    const members = broken.members;
    const original = members.values.bind(members);
    members.values = () => {
      throw new Error('D1 down');
    };
    expect((await h.webhook(joinUpdate(USER))).status).toBe(200);
    members.values = original;
    expect(methods(h)).not.toContain('approveJoin');

    const malformed = { update_id: 2, chat_join_request: { chat: { id: CHAT_ID }, from: { id: 'x' } } };
    expect((await h.webhook(malformed)).status).toBe(200);
    const groupMessage = {
      update_id: 3,
      message: { message_id: 1, date: 1, chat: { id: CHAT_ID, type: 'supergroup' }, text: '/start abc' },
    };
    expect((await h.webhook(groupMessage)).status).toBe(200);
    expect(methods(h)).not.toContain('approveJoin');
    expect(lines.join('\n')).not.toContain(BOT_TOKEN);
  });
});
