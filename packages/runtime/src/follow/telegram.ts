import type { CreateTelegramPort, TelegramSend, TelegramWebhookAdminResponse } from '@prix/contracts';
import { telegramWebhookAdminResponseSchema } from '@prix/contracts';

const TIMEOUT_MS = 5_000;
const MAX_BODY_BYTES = 64 * 1024;

const RETRY: TelegramSend = { ok: false, reason: 'retry', retryAfterSeconds: null };

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

/**
 * One call of the Bot API whose answer must be `{ ok: true, result }`: the `result`, or undefined on any
 * failure (a throw, a status other than 200, a body over 64 KB, not JSON, `ok` not true). The token is in
 * the path, so nothing here logs, and no error leaves it.
 */
async function callBotApi(
  fetchFn: typeof fetch,
  botToken: string,
  method: 'setWebhook' | 'getWebhookInfo',
  body: Record<string, unknown> | null,
): Promise<unknown> {
  try {
    const response = await fetchFn(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    }
    const text = await readCapped(response);
    if (text === null) return undefined;
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null) return undefined;
    const answer = value as { ok?: unknown; result?: unknown };
    return answer.ok === true ? answer.result : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Telegram's `getWebhookInfo` result reduced to the three fields the founder pastes back (docs/contracts/
 * phase-6-holders.md section 7), or null when it does not have their shape.
 */
function webhookInfoOf(result: unknown): TelegramWebhookAdminResponse | null {
  if (typeof result !== 'object' || result === null) return null;
  const info = result as { url?: unknown; pending_update_count?: unknown; last_error_message?: unknown };
  const lastError = info.last_error_message;
  const parsed = telegramWebhookAdminResponseSchema.safeParse({
    url: info.url,
    pendingUpdateCount: info.pending_update_count,
    lastErrorMessage: typeof lastError === 'string' && lastError !== '' ? lastError : null,
  });
  return parsed.success ? parsed.data : null;
}

/**
 * The outgoing calls of the follow phase. The token is in the URL path, so the URL is never
 * logged or put in an error. Plain text, no parse mode, no redirect, 5 seconds, 64 KB. Never throws.
 * Phase 6.7 (holders contract section 7, revision 3, HB-2) adds `setWebhook` and `getWebhookInfo`, which
 * prix-api's admin route and its watchdog call: each answers false or null on any failure and logs nothing.
 */
export const createTelegramPort: CreateTelegramPort = (botToken, fetchFn = fetch) => ({
  async setWebhook(input) {
    const result = await callBotApi(fetchFn, botToken, 'setWebhook', {
      url: input.url,
      secret_token: input.secretToken,
      allowed_updates: [...input.allowedUpdates],
      drop_pending_updates: input.dropPendingUpdates,
    });
    return result === true;
  },
  async getWebhookInfo() {
    return webhookInfoOf(await callBotApi(fetchFn, botToken, 'getWebhookInfo', null));
  },
  async sendMessage(chatId, text) {
    try {
      const response = await fetchFn(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
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
      return { ok: false, reason: 'rejected', retryAfterSeconds: null };
    } catch {
      return RETRY;
    }
  },
});
