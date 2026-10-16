import { TELEGRAM_WEBHOOK_URL } from '@prix/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTelegramPort } from './telegram.ts';

/**
 * The webhook calls of `TelegramPort` (docs/contracts/phase-6-holders.md section 7, revision 3, HB-2):
 * `setWebhook` and `getWebhookInfo` never throw, send the token only in the path, and put no URL in an
 * error or a log. Run with `pnpm --filter @prix/runtime test`.
 */

const TOKEN = '123456:FAKE-token-for-tests_only';
const SECRET = 'a'.repeat(64);

interface Seen {
  url: string;
  method: string | undefined;
  body: unknown;
}

function fakeFetch(answer: () => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({
      url: String(input),
      method: init?.method,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
    });
    return answer();
  }) as typeof fetch;
  return { fetchFn, seen };
}

const json = (status: number, value: unknown): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

const INPUT = {
  url: TELEGRAM_WEBHOOK_URL,
  secretToken: SECRET,
  allowedUpdates: ['message'] as const,
  dropPendingUpdates: true as const,
};

afterEach(() => {
  vi.restoreAllMocks();
});

/** Every console line the port might write during a call, to show none holds the URL or a secret. */
function watchConsole(): string[] {
  const lines: string[] = [];
  for (const method of ['log', 'warn', 'error', 'info', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
  }
  return lines;
}

describe('setWebhook', () => {
  it('posts the four fields to setWebhook with the token in the path only', async () => {
    const { fetchFn, seen } = fakeFetch(() => json(200, { ok: true, result: true }));
    const port = createTelegramPort(TOKEN, fetchFn);
    expect(await port.setWebhook(INPUT)).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(`https://api.telegram.org/bot${TOKEN}/setWebhook`);
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.body).toEqual({
      url: TELEGRAM_WEBHOOK_URL,
      secret_token: SECRET,
      allowed_updates: ['message'],
      drop_pending_updates: true,
    });
  });

  it('is false when Telegram answers ok false, a non-200 status, a body that is not JSON, or a long body', async () => {
    const answers: (() => Response)[] = [
      () => json(200, { ok: false, description: 'Bad Request' }),
      () => json(400, { ok: false }),
      () => json(500, { ok: true }),
      () => new Response('not json', { status: 200 }),
      () => new Response(`{"ok":true,"pad":"${'x'.repeat(70_000)}"}`, { status: 200 }),
    ];
    for (const answer of answers) {
      const port = createTelegramPort(TOKEN, fakeFetch(answer).fetchFn);
      expect(await port.setWebhook(INPUT)).toBe(false);
    }
  });

  it('never throws and logs nothing when the fetch throws an error that names the URL', async () => {
    const lines = watchConsole();
    const fetchFn = (async (input: RequestInfo | URL) => {
      throw new Error(`connect failed ${String(input)}`);
    }) as typeof fetch;
    const port = createTelegramPort(TOKEN, fetchFn);
    await expect(port.setWebhook(INPUT)).resolves.toBe(false);
    expect(lines.join('\n')).not.toContain(TOKEN);
    expect(lines).toHaveLength(0);
  });
});

describe('getWebhookInfo', () => {
  it('answers the three fields the founder pastes back and nothing else', async () => {
    const { fetchFn, seen } = fakeFetch(() =>
      json(200, {
        ok: true,
        result: {
          url: TELEGRAM_WEBHOOK_URL,
          has_custom_certificate: false,
          pending_update_count: 0,
          max_connections: 40,
          ip_address: '203.0.113.9',
          allowed_updates: ['message'],
        },
      }),
    );
    const port = createTelegramPort(TOKEN, fetchFn);
    expect(await port.getWebhookInfo()).toEqual({
      url: TELEGRAM_WEBHOOK_URL,
      pendingUpdateCount: 0,
      lastErrorMessage: null,
    });
    expect(seen[0]?.url).toBe(`https://api.telegram.org/bot${TOKEN}/getWebhookInfo`);
  });

  it('carries the last error message when Telegram has one', async () => {
    const port = createTelegramPort(
      TOKEN,
      fakeFetch(() =>
        json(200, {
          ok: true,
          result: { url: '', pending_update_count: 3, last_error_message: 'Wrong response from the webhook' },
        }),
      ).fetchFn,
    );
    expect(await port.getWebhookInfo()).toEqual({
      url: '',
      pendingUpdateCount: 3,
      lastErrorMessage: 'Wrong response from the webhook',
    });
  });

  it('is null for ok false, a bad status, a wrong shape, a body that is not JSON, and a fetch that throws', async () => {
    const lines = watchConsole();
    const answers: (() => Response)[] = [
      () => json(200, { ok: false }),
      () => json(401, { ok: false }),
      () => json(200, { ok: true, result: { url: 7, pending_update_count: 0 } }),
      () => json(200, { ok: true, result: { url: '', pending_update_count: -1 } }),
      () => json(200, { ok: true }),
      () => new Response('<html>', { status: 200 }),
    ];
    for (const answer of answers) {
      expect(await createTelegramPort(TOKEN, fakeFetch(answer).fetchFn).getWebhookInfo()).toBeNull();
    }
    const throwing = (async (input: RequestInfo | URL) => {
      throw new Error(`timeout ${String(input)}`);
    }) as typeof fetch;
    await expect(createTelegramPort(TOKEN, throwing).getWebhookInfo()).resolves.toBeNull();
    expect(lines).toHaveLength(0);
  });
});
