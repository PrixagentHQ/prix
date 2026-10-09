import type { FollowApiDeps, NotificationsResponse, TelegramLinkResponse } from '@prix/contracts';
import {
  LINK_CODE_PATTERN,
  LINK_CODE_TTL_SECONDS,
  setTelegramInputSchema,
  TELEGRAM_LINKED_REPLY,
  TELEGRAM_SECRET_HEADER,
  TELEGRAM_STOPPED_REPLY,
  telegramLinkUrl,
  telegramUpdateSchema,
} from '@prix/contracts';
import type { Hono } from 'hono';
import { ApiFailure, json, noContent } from '../errors.ts';
import { requireSession, requireWriter } from '../guard.ts';
import { readInput } from '../input.ts';
import { hashLinkCode, newLinkCode, secretsEqual } from './link-code.ts';

const NOTIFY_WRITE_ROWS = 3;

const notConfigured = () => new ApiFailure('not_found', 'Telegram notes are not available yet. Check back later.');
const noLinkedChat = () =>
  new ApiFailure('not_found', 'No Telegram chat is linked to this wallet. Create a link and open it first.');

export function registerNotifyRoutes(routes: Hono, deps: FollowApiDeps): void {
  const { follow, telegram } = deps;

  async function status(address: string): Promise<NotificationsResponse> {
    if (telegram === null) {
      return {
        telegram: {
          available: false,
          linked: false,
          enabled: false,
          botUsername: null,
          linkedAt: null,
          delayed: false,
        },
      };
    }
    const [chat, entitlements] = await Promise.all([
      follow.getChat(address),
      deps.entitlements.entitlementsFor(address),
    ]);
    return {
      telegram: {
        available: true,
        linked: chat !== null,
        enabled: chat?.enabled ?? false,
        botUsername: telegram.config.botUsername,
        linkedAt: chat?.linkedAt ?? null,
        delayed: entitlements.gatingOn && entitlements.feedDelaySeconds > 0,
      },
    };
  }

  routes.get('/notifications', async (c) => {
    const session = await requireSession(deps, c.req.raw);
    return json(await status(session.address), 200, 'private');
  });

  routes.post('/notifications/telegram/link', async (c) => {
    if (telegram === null) throw notConfigured();
    const session = await requireWriter(deps, c.req.raw, NOTIFY_WRITE_ROWS + 1);
    const { code, hash } = await newLinkCode();
    const expiresAt = new Date(deps.now().getTime() + LINK_CODE_TTL_SECONDS * 1000).toISOString();
    await follow.putLinkCode(session.address, hash, expiresAt);
    return json<TelegramLinkResponse>(
      { url: telegramLinkUrl(telegram.config.botUsername, code), expiresAt },
      201,
      'private',
    );
  });

  routes.patch('/notifications/telegram', async (c) => {
    if (telegram === null) throw notConfigured();
    const session = await requireWriter(deps, c.req.raw, 1);
    const input = await readInput(setTelegramInputSchema, c.req.raw);
    if (!(await follow.setChatEnabled(session.address, input.enabled))) throw noLinkedChat();
    return json(await status(session.address), 200, 'private');
  });

  routes.delete('/notifications/telegram', async (c) => {
    if (telegram === null) throw notConfigured();
    const session = await requireWriter(deps, c.req.raw, NOTIFY_WRITE_ROWS);
    await follow.deleteChat(session.address);
    return noContent();
  });

  routes.post('/telegram/webhook', async (c) => {
    if (telegram === null) throw notConfigured();
    // The secret first, in constant time. A wrong or missing header is refused before the body is read.
    const header = c.req.header(TELEGRAM_SECRET_HEADER);
    if (header === undefined || !(await secretsEqual(header, telegram.config.webhookSecret))) {
      throw new ApiFailure('forbidden', 'This request was refused.');
    }
    const ok = () => json({ ok: true }, 200, 'private');
    try {
      const update = await readInput(telegramUpdateSchema, c.req.raw);
      const message = update.message;
      if (message === undefined || message.chat.type !== 'private' || message.text === undefined) return ok();
      const parts = message.text.trim().split(/\s+/);
      const command = (parts[0] ?? '').split('@')[0];
      const chatId = message.chat.id;
      if (command === '/start' && parts.length === 2) {
        const code = parts[1] ?? '';
        if (!LINK_CODE_PATTERN.test(code)) return ok();
        const result = await follow.redeemLinkCode(await hashLinkCode(code), chatId, deps.now().toISOString());
        if (result.result === 'linked') await telegram.port.sendMessage(chatId, TELEGRAM_LINKED_REPLY);
      } else if (command === '/stop' && parts.length === 1) {
        await follow.deleteChatById(chatId);
        await telegram.port.sendMessage(chatId, TELEGRAM_STOPPED_REPLY);
      }
    } catch {
      // An authenticated update is always answered 200 so that Telegram does not retry it.
      console.error(JSON.stringify({ event: 'telegram_webhook_error' }));
    }
    return ok();
  });
}
