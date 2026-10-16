import {
  TELEGRAM_ALLOWED_UPDATES,
  TELEGRAM_WEBHOOK_URL,
  telegramLinkedReply,
  telegramWebhookAdminResponseSchema,
  telegramWebhookStateSchema,
} from '@prix/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN, createHarness, errorOf, type HarnessOptions, HOLDER } from './holders-test-support.ts';
import { shortAddress } from './views.ts';

// Part E of docs/contracts/phase-6-holders.md (section 7): the webhook's admin routes, the link route closed
// while the username is empty or the webhook's watch is marked, and the linked reply.

const SECRET = 'secret-of-the-webhook-0123456789abcdef';
const OURS = { url: TELEGRAM_WEBHOOK_URL, pendingUpdateCount: 0, lastErrorMessage: null };

let logs: string[] = [];
beforeEach(() => {
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => logs.push(String(line)));
  vi.spyOn(console, 'error').mockImplementation((line: string) => logs.push(String(line)));
});
afterEach(() => vi.restoreAllMocks());

function harness(
  telegram: HarnessOptions['telegram'] = { botUsername: 'PrixagentBot', setOk: true, info: OURS },
  more: HarnessOptions = {},
) {
  return createHarness({ followGiven: true, telegram, ...more });
}

describe('POST /api/admin/telegram/webhook', () => {
  it('sets the webhook with the contract own four fields and answers the three fields, no secret', async () => {
    const h = harness();
    const admin = await h.signIn(ADMIN);
    const reply = await h.fetch('POST', '/api/admin/telegram/webhook', { cookie: admin });
    expect(reply.status).toBe(200);
    expect(reply.headers.get('cache-control')).toBe('no-store');
    expect(telegramWebhookAdminResponseSchema.parse(reply.json)).toEqual(OURS);
    expect(h.telegramCalls.set).toEqual([
      {
        url: TELEGRAM_WEBHOOK_URL,
        secretToken: SECRET,
        allowedUpdates: TELEGRAM_ALLOWED_UPDATES,
        dropPendingUpdates: true,
      },
    ]);
    expect(reply.text).not.toContain(SECRET);
    expect(logs.join('\n')).not.toContain(SECRET);
  });

  it('asks Telegram for exactly TELEGRAM_ALLOWED_UPDATES, message and chat_join_request in that order (R1)', async () => {
    // Revision 6, R1 (HB1F-SEC-1): with ['message'] alone no join request would ever reach the lounge.
    const h = harness();
    const admin = await h.signIn(ADMIN);
    expect((await h.fetch('POST', '/api/admin/telegram/webhook', { cookie: admin })).status).toBe(200);
    expect(h.telegramCalls.set).toHaveLength(1);
    const sent = (h.telegramCalls.set[0] as { allowedUpdates: readonly string[] }).allowedUpdates;
    expect(sent).toStrictEqual(['message', 'chat_join_request']);
    expect(sent).toStrictEqual([...TELEGRAM_ALLOWED_UPDATES]);
  });

  it('works while the username is empty', async () => {
    const h = harness({ botUsername: '', setOk: true, info: OURS });
    const admin = await h.signIn(ADMIN);
    expect((await h.fetch('POST', '/api/admin/telegram/webhook', { cookie: admin })).status).toBe(200);
  });

  it('answers the generic 404 without an admin session and from another site', async () => {
    const h = harness();
    const holder = await h.signIn(HOLDER);
    const admin = await h.signIn(ADMIN);
    for (const cookie of [undefined, holder]) {
      const reply = await h.fetch('POST', '/api/admin/telegram/webhook', cookie === undefined ? {} : { cookie });
      expect(reply.status).toBe(404);
      expect(errorOf(reply).message).toBe('There is no such API route. Check the address and the method.');
    }
    const foreign = await h.fetch('POST', '/api/admin/telegram/webhook', {
      cookie: admin,
      origin: 'https://evil.test',
    });
    expect(foreign.status).toBe(404);
    expect(errorOf(foreign).message).toBe('There is no such API route. Check the address and the method.');
    expect(h.telegramCalls.set).toEqual([]);
  });

  it('answers the generic 404 while telegram is null', async () => {
    const h = harness(null);
    const admin = await h.signIn(ADMIN);
    const reply = await h.fetch('POST', '/api/admin/telegram/webhook', { cookie: admin });
    expect(reply.status).toBe(404);
    expect(errorOf(reply).message).toBe('There is no such API route. Check the address and the method.');
  });

  it('a Telegram failure logs a fixed reason and no URL', async () => {
    const h = harness({ botUsername: 'PrixagentBot', setOk: false, info: null });
    const admin = await h.signIn(ADMIN);
    const reply = await h.fetch('POST', '/api/admin/telegram/webhook', { cookie: admin });
    expect(reply.status).toBe(500);
    const text = logs.join('\n');
    expect(text).toContain('telegram_webhook_admin_failed');
    expect(text).not.toMatch(/https?:/);
    expect(text).not.toContain(SECRET);
  });

  it('clears the watch when the read-back url is ours, and not otherwise', async () => {
    const elsewhere = { url: 'https://evil.test/hook', pendingUpdateCount: 3, lastErrorMessage: 'x' };
    const moved = harness(
      { botUsername: 'PrixagentBot', setOk: true, info: elsewhere },
      { watchMovedAt: '2026-10-18T11:13:00.000Z' },
    );
    const admin = await moved.signIn(ADMIN);
    await moved.fetch('POST', '/api/admin/telegram/webhook', { cookie: admin });
    expect(moved.watch.cleared).toBe(0);
    const ours = harness(undefined, { watchMovedAt: '2026-10-18T11:13:00.000Z' });
    const admin2 = await ours.signIn(ADMIN);
    await ours.fetch('POST', '/api/admin/telegram/webhook', { cookie: admin2 });
    expect(ours.watch.cleared).toBe(1);
  });
});

describe('GET /api/admin/telegram/webhook', () => {
  it('answers the watch to an admin, never cached, and the generic 404 to anyone else', async () => {
    const h = harness(undefined, { watchMovedAt: '2026-10-18T11:13:00.000Z' });
    const admin = await h.signIn(ADMIN);
    const holder = await h.signIn(HOLDER);
    const reply = await h.fetch('GET', '/api/admin/telegram/webhook', { cookie: admin });
    expect(reply.status).toBe(200);
    expect(reply.headers.get('cache-control')).toBe('no-store');
    expect(telegramWebhookStateSchema.parse(reply.json)).toEqual({ moved: true, movedAt: '2026-10-18T11:13:00.000Z' });
    expect((await h.fetch('GET', '/api/admin/telegram/webhook', { cookie: holder })).status).toBe(404);
    expect((await h.fetch('GET', '/api/admin/telegram/webhook')).status).toBe(404);
  });

  it('answers not moved while the watch is not marked', async () => {
    const h = harness();
    const admin = await h.signIn(ADMIN);
    expect((await h.fetch('GET', '/api/admin/telegram/webhook', { cookie: admin })).json).toEqual({
      moved: false,
      movedAt: null,
    });
  });
});

describe('the link route and the status while the username is empty or the watch is marked', () => {
  const closedStatus = {
    telegram: { available: false, linked: false, enabled: false, botUsername: null, linkedAt: null, delayed: false },
  };

  for (const [label, telegram, movedAt] of [
    ['the username is empty', { botUsername: '', setOk: true, info: OURS }, null],
    ['the watch is marked', { botUsername: 'PrixagentBot', setOk: true, info: OURS }, '2026-10-18T11:13:00.000Z'],
  ] as const) {
    it(`answers as while telegram is null when ${label}`, async () => {
      const h = harness(telegram, { watchMovedAt: movedAt });
      const cookie = await h.signIn(HOLDER);
      const link = await h.fetch('POST', '/api/notifications/telegram/link', { cookie });
      expect(link.status).toBe(404);
      expect(errorOf(link).message).toBe('Telegram notes are not available yet. Check back later.');
      expect(h.trace).not.toContain('follow.putLinkCode');
      expect((await h.fetch('GET', '/api/notifications', { cookie })).json).toEqual(closedStatus);
    });
  }

  it('hands out a link while the username is set and the watch is clear', async () => {
    const h = harness();
    const cookie = await h.signIn(HOLDER);
    const link = await h.fetch('POST', '/api/notifications/telegram/link', { cookie });
    expect(link.status).toBe(201);
    expect(link.json.url).toMatch(/^https:\/\/t\.me\/PrixagentBot\?start=/);
  });
});

describe('the linked reply', () => {
  it('names the wallet in short form and the way out', async () => {
    const h = harness();
    const reply = await h.fetch('POST', '/api/telegram/webhook', {
      origin: null,
      body: { message: { text: `/start ${'a'.repeat(32)}`, chat: { id: 7, type: 'private' } } },
    });
    expect(reply.status).toBe(403);
    const ok = await h.fetch('POST', '/api/telegram/webhook', {
      origin: null,
      headers: { 'X-Telegram-Bot-Api-Secret-Token': SECRET },
      body: { message: { text: `/start ${'a'.repeat(32)}`, chat: { id: 7, type: 'private' } } },
    });
    expect(ok.status).toBe(200);
    expect(h.telegramCalls.sent).toEqual([{ chatId: 7, text: telegramLinkedReply(shortAddress(HOLDER)) }]);
  });
});
