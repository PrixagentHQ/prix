import { entitlementsOfTier, LOUNGE_DIRECT_MESSAGES, loungeResponseSchema } from '@prix/contracts';
import { createTelegramLoungePort } from '@prix/runtime/social/index';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BOT_TOKEN,
  CHAT_ID,
  joinUpdate,
  loungeHarness,
  NOW,
  OTHER_USER,
  USER,
  WALLET,
} from '../../apps/api/src/http/follow/test-support-lounge.ts';

/**
 * Phase 6.8, G (docs/contracts/phase-6-holders-2.md section 4.4, qa cases 5, 8 and 9): the join attacks
 * against the real webhook route behind `createApp`, with the store, the token reads and Telegram in memory.
 * An unlinked user, a user linked to a wallet under tier 1, a request after a tier drop, a link passed on,
 * a forged secret, and the bot token in no log line.
 */

const FRESH = '2026-10-20T11:55:00.000Z';

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

function linkedHolder(tier: 0 | 1 | 2 | 3, checkedAt: string | null = FRESH) {
  const h = loungeHarness();
  h.chats.set(USER, { wallet: WALLET, enabled: true });
  h.tiers.set(WALLET, entitlementsOfTier(tier));
  h.checkedAt.set(WALLET, checkedAt);
  return h;
}

const methods = (h: ReturnType<typeof loungeHarness>) => h.calls.map((call) => call.method);

describe('join requests that must not get in', () => {
  it('a user with no linked wallet is declined with the not_linked message, before any holding is read', async () => {
    const lines = capture();
    const h = loungeHarness();
    const reply = await h.webhook(joinUpdate(USER));
    expect(reply.status).toBe(200);
    expect(methods(h)).toEqual(['sendDirect', 'declineJoin']);
    expect(String(h.calls[0]?.arg)).toBe(
      LOUNGE_DIRECT_MESSAGES.not_linked.replace('{following}', 'https://prix.test/following'),
    );
    expect(h.trace).not.toContain('token.holding');
    expect(h.trace.some((step) => step.startsWith('entitlements'))).toBe(false);
    expect(h.members.size).toBe(0);
    expect(lines.join('\n')).not.toContain(BOT_TOKEN);
  });

  it('a user linked to a wallet under tier 1, read fresh, is declined below_tier and stores nothing', async () => {
    const h = linkedHolder(0);
    expect((await h.webhook(joinUpdate(USER))).status).toBe(200);
    expect(methods(h)).toEqual(['sendDirect', 'declineJoin']);
    expect(String(h.calls[0]?.arg)).toBe(LOUNGE_DIRECT_MESSAGES.below_tier);
    expect(h.members.size).toBe(0);
    // The holding is read without cachedOnly: a stored row cannot vouch for a holder.
    expect(h.trace).toContain('entitlements:full');
    expect(h.trace).not.toContain('entitlements:cachedOnly');
  });

  it('a request after a tier drop the token service has not read again yet is neither approved nor declined', async () => {
    const h = linkedHolder(1, '2026-10-20T10:00:00.000Z');
    expect((await h.webhook(joinUpdate(USER))).status).toBe(200);
    expect(h.calls).toEqual([]);
    expect(h.members.size).toBe(0);
  });

  it('a request after a tier drop the token service has read is declined below_tier', async () => {
    const h = linkedHolder(1);
    expect((await h.webhook(joinUpdate(USER))).status).toBe(200);
    expect(methods(h)).toEqual(['approveJoin']);
    // The holder sells; the next fresh read shows tier 0. Someone else asks with the same account later.
    h.members.clear();
    h.calls.length = 0;
    h.tiers.set(WALLET, entitlementsOfTier(0));
    expect((await h.webhook(joinUpdate(USER))).status).toBe(200);
    expect(methods(h)).toEqual(['sendDirect', 'declineJoin']);
    expect(h.members.size).toBe(0);
  });

  it('a link passed on: the wallet that let account A in is refused for account B with wallet_taken', async () => {
    const h = linkedHolder(2);
    expect((await h.webhook(joinUpdate(USER))).status).toBe(200);
    expect(h.members.get(USER)?.wallet).toBe(WALLET);
    // The wallet is relinked to account B on /following.
    h.chats.delete(USER);
    h.chats.set(OTHER_USER, { wallet: WALLET, enabled: true });
    h.calls.length = 0;
    expect((await h.webhook(joinUpdate(OTHER_USER))).status).toBe(200);
    expect(methods(h)).toEqual(['sendDirect', 'declineJoin']);
    expect(String(h.calls[0]?.arg)).toBe(LOUNGE_DIRECT_MESSAGES.wallet_taken);
    expect(h.members.has(OTHER_USER)).toBe(false);
  });

  it('a bot is declined with no message, and a request to another chat calls nothing', async () => {
    const h = linkedHolder(3);
    await h.webhook(joinUpdate(USER, { isBot: true }));
    expect(methods(h)).toEqual(['declineJoin']);
    h.calls.length = 0;
    await h.webhook(joinUpdate(USER, { chatId: CHAT_ID - 1 }));
    expect(h.calls).toEqual([]);
  });

  it('a forged or missing secret reads no body and calls nothing, even for a holder', async () => {
    const h = linkedHolder(3);
    for (const secret of [null, 'wrong-secret', `${'x'.repeat(33)}`]) {
      const reply = await h.webhook(joinUpdate(USER), { secret });
      expect(reply.status).not.toBe(200);
    }
    expect(h.calls).toEqual([]);
    expect(h.trace).toEqual([]);
    expect(h.members.size).toBe(0);
  });

  it('the lounge off: a holder request is ignored and /api/lounge is the generic 404', async () => {
    const h = loungeHarness({ lounge: false });
    h.chats.set(USER, { wallet: WALLET, enabled: true });
    h.tiers.set(WALLET, entitlementsOfTier(3));
    h.checkedAt.set(WALLET, FRESH);
    expect((await h.webhook(joinUpdate(USER))).status).toBe(200);
    expect(h.calls).toEqual([]);
    const cookie = await h.signIn(WALLET);
    expect((await h.get('/api/lounge', cookie)).status).toBe(404);
  });
});

describe('GET /api/lounge (case 9): the invite link only to a linked wallet at tier 1, never cached', () => {
  it('401 without a session; not_holder, link_telegram and open; the URL only in open', async () => {
    const h = loungeHarness();
    expect((await h.get('/api/lounge')).status).toBe(401);
    const cookie = await h.signIn(WALLET);

    const notHolder = await h.get('/api/lounge', cookie);
    const notHolderText = await notHolder.text();
    expect(JSON.parse(notHolderText).state).toBe('not_holder');
    expect(notHolderText).not.toContain('t.me');

    h.tiers.set(WALLET, entitlementsOfTier(1));
    const link = await h.get('/api/lounge', cookie);
    const linkText = await link.text();
    expect(JSON.parse(linkText).state).toBe('link_telegram');
    expect(linkText).not.toContain('t.me');

    h.chats.set(USER, { wallet: WALLET, enabled: false });
    const open = await h.get('/api/lounge', cookie);
    expect(loungeResponseSchema.parse(await open.json())).toEqual({ state: 'open', url: h.config.inviteUrl });
    expect(open.headers.get('Cache-Control') ?? '').toMatch(/private|no-store/);
    expect(open.headers.get('Cache-Control') ?? '').not.toMatch(/public|s-maxage/);
  });
});

describe('the lounge port (case 8): never posts to a group, never leaks the token', () => {
  const TOKEN = '987654:SECRET-BOT-TOKEN-QA';

  it('sendDirect refuses a negative or zero chat id with no fetch', async () => {
    const fetchFn = vi.fn(async () => new Response('{"ok":true}'));
    const port = createTelegramLoungePort(TOKEN, fetchFn as unknown as typeof fetch);
    for (const chatId of [0, -1, CHAT_ID]) {
      expect((await port.sendDirect(chatId, 'hello')).ok).toBe(false);
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('no captured console line and no answer carries the token or /bot, whatever the fetch does', async () => {
    const lines = capture();
    const throwing = async (input: RequestInfo | URL) => {
      throw new Error(`network down for ${String(input)}`);
    };
    const statuses = [429, 400, 500].map(
      (status) => async () =>
        new Response(
          JSON.stringify({ ok: false, error_code: status, description: 'nope', parameters: { retry_after: 3 } }),
          {
            status,
          },
        ),
    );
    const answers: unknown[] = [];
    for (const fetchFn of [throwing, ...statuses]) {
      const port = createTelegramLoungePort(TOKEN, fetchFn as unknown as typeof fetch);
      answers.push(await port.sendDirect(USER, 'hello'));
      answers.push(await port.ban(CHAT_ID, USER));
      answers.push(await port.unban(CHAT_ID, USER));
      answers.push(await port.approveJoin(CHAT_ID, USER));
      answers.push(await port.declineJoin(CHAT_ID, USER));
    }
    const all = `${lines.join('\n')}\n${JSON.stringify(answers)}`;
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain('/bot');
    for (const answer of answers) expect((answer as { ok: boolean }).ok).toBe(false);
  });

  it('the token travels only in the URL, never in the body', async () => {
    const seen: { url: string; body: string }[] = [];
    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), body: String(init?.body ?? '') });
      return new Response('{"ok":true,"result":true}');
    };
    const port = createTelegramLoungePort(TOKEN, fetchFn as unknown as typeof fetch);
    await port.ban(CHAT_ID, USER);
    await port.sendDirect(USER, 'hi');
    expect(seen).toHaveLength(2);
    for (const call of seen) {
      expect(call.url).toContain(TOKEN);
      expect(call.body).not.toContain(TOKEN);
    }
    expect(JSON.parse(seen[0]?.body ?? '{}')).toMatchObject({ revoke_messages: false });
  });
});

describe('the clock of the harness', () => {
  it('is the contract time', () => {
    expect(NOW).toBe('2026-10-20T12:00:00.000Z');
  });
});
