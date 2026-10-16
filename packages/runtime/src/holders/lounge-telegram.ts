import type { CreateTelegramLoungePort, TelegramSend } from '@prix/contracts';
import { loungeDirectChatOk } from '@prix/contracts';

/**
 * The holders' lounge's calls to Telegram (docs/contracts/phase-6-holders-2.md section 4; the comment of
 * `TelegramLoungePort` in packages/contracts/src/phase6-holders2.ts). Five POST methods of the Bot API with a
 * JSON body, each answered as `TelegramPort.sendMessage` answers (packages/runtime/src/follow/telegram.ts):
 * 200 is ok; 429 is retry with Telegram's retry_after (1 second when it gives none); 403 is blocked; 5xx or no
 * answer is retry; anything else, a redirect included, is rejected. No redirect is followed, each call has
 * 5 seconds and an answer is read to at most 64 KB. It never throws and never logs.
 *
 * The bot token is in the URL path of the call and nowhere else: the URL is never logged, put in an error or
 * answered, and nothing Telegram or the fetch says is passed on but the status's meaning.
 *
 * `sendDirect` writes only to a user's private chat: a chat id that `loungeDirectChatOk` refuses (zero, a
 * group's negative id, a number that is not a safe integer) is answered rejected with no call, so the
 * lounge's own port never posts in the Community group (section 4.10).
 */

const TIMEOUT_MS = 5_000;
const MAX_BODY_BYTES = 64 * 1024;

const RETRY: TelegramSend = { ok: false, reason: 'retry', retryAfterSeconds: null };
const REJECTED: TelegramSend = { ok: false, reason: 'rejected', retryAfterSeconds: null };

/** Reads at most 64 KB of an answer. Null if it is longer or cannot be read. */
async function readCapped(response: Response): Promise<string | null> {
  const reader = response.body?.getReader();
  if (reader === undefined) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function retryAfter(response: Response): Promise<number | null> {
  const text = await readCapped(response);
  if (text === null) return null;
  try {
    const value: unknown = (JSON.parse(text) as { parameters?: { retry_after?: unknown } }).parameters?.retry_after;
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.ceil(value) : null;
  } catch {
    return null;
  }
}

export const createTelegramLoungePort: CreateTelegramLoungePort = (botToken, fetchFn = fetch) => {
  async function call(method: string, body: Record<string, string | number | boolean>): Promise<TelegramSend> {
    try {
      const response = await fetchFn(`https://api.telegram.org/bot${botToken}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const status = response.status;
      if (status === 200) {
        await response.body?.cancel().catch(() => undefined);
        return { ok: true };
      }
      if (status === 429) {
        const seconds = await retryAfter(response);
        return { ok: false, reason: 'retry', retryAfterSeconds: seconds ?? 1 };
      }
      await response.body?.cancel().catch(() => undefined);
      if (status === 403) return { ok: false, reason: 'blocked', retryAfterSeconds: null };
      if (status >= 500) return RETRY;
      return REJECTED;
    } catch {
      return RETRY;
    }
  }

  return {
    approveJoin: (chatId, userId) => call('approveChatJoinRequest', { chat_id: chatId, user_id: userId }),
    declineJoin: (chatId, userId) => call('declineChatJoinRequest', { chat_id: chatId, user_id: userId }),
    ban: (chatId, userId) => call('banChatMember', { chat_id: chatId, user_id: userId, revoke_messages: false }),
    unban: (chatId, userId) => call('unbanChatMember', { chat_id: chatId, user_id: userId, only_if_banned: true }),
    async sendDirect(chatId, text) {
      if (!loungeDirectChatOk(chatId)) return REJECTED;
      return call('sendMessage', { chat_id: chatId, text });
    },
  };
};
