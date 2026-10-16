import type { TelegramLoungePort } from '@prix/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createTelegramLoungePort } from './lounge-telegram.ts';

/**
 * `createTelegramLoungePort` against docs/contracts/phase-6-holders-2.md section 4 and the comment of
 * `TelegramLoungePort` in packages/contracts/src/phase6-holders2.ts: five POST methods of the Bot API with a
 * JSON body, answers mapped as `TelegramPort.sendMessage` maps them, never a throw, the token in the URL and
 * nowhere else, and `sendDirect` refusing any chat that is not a user's with no call.
 *
 * Run it with `pnpm --filter @prix/runtime test`.
 */

const TOKEN = '123456789:AAFakeTokenForTestsOnly_abcdefghijklmn';
const GROUP = -1001234567890;
const USER = 424242;

interface Call {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: unknown;
}

function fake(answer: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method,
      headers: { ...(init?.headers as Record<string, string>) },
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
    });
    return answer();
  });
  return { calls, port: createTelegramLoungePort(TOKEN, fetchFn as unknown as typeof fetch) };
}

const ok = (): Response => new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });

type Method = keyof TelegramLoungePort;
const CASES: { name: Method; call: (port: TelegramLoungePort) => Promise<unknown>; api: string; body: unknown }[] = [
  {
    name: 'approveJoin',
    call: (port) => port.approveJoin(GROUP, USER),
    api: 'approveChatJoinRequest',
    body: { chat_id: GROUP, user_id: USER },
  },
  {
    name: 'declineJoin',
    call: (port) => port.declineJoin(GROUP, USER),
    api: 'declineChatJoinRequest',
    body: { chat_id: GROUP, user_id: USER },
  },
  {
    name: 'ban',
    call: (port) => port.ban(GROUP, USER),
    api: 'banChatMember',
    body: { chat_id: GROUP, user_id: USER, revoke_messages: false },
  },
  {
    name: 'unban',
    call: (port) => port.unban(GROUP, USER),
    api: 'unbanChatMember',
    body: { chat_id: GROUP, user_id: USER, only_if_banned: true },
  },
  {
    name: 'sendDirect',
    call: (port) => port.sendDirect(USER, 'Hello there.'),
    api: 'sendMessage',
    body: { chat_id: USER, text: 'Hello there.' },
  },
];

describe('createTelegramLoungePort', () => {
  it.each(CASES)('$name POSTs $api with a JSON body and answers ok on 200', async ({ call, api, body }) => {
    const { calls, port } = fake(ok);
    expect(await call(port)).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`https://api.telegram.org/bot${TOKEN}/${api}`);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers['content-type']).toBe('application/json');
    expect(calls[0]?.body).toEqual(body);
  });

  it('sends a direct message with no parse mode', async () => {
    const { calls, port } = fake(ok);
    await port.sendDirect(USER, 'Plain *text* <b>only</b>.');
    expect(calls[0]?.body).toEqual({ chat_id: USER, text: 'Plain *text* <b>only</b>.' });
    expect(Object.keys(calls[0]?.body as object)).not.toContain('parse_mode');
  });

  it.each([0, -1, GROUP, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2])(
    'refuses a direct message to chat %s with no call',
    async (chatId) => {
      const { calls, port } = fake(ok);
      expect(await port.sendDirect(chatId, 'x')).toEqual({ ok: false, reason: 'rejected', retryAfterSeconds: null });
      expect(calls).toHaveLength(0);
    },
  );

  it.each(CASES)('$name maps 429 to retry with its retry_after', async ({ call }) => {
    const { port } = fake(
      () => new Response(JSON.stringify({ ok: false, parameters: { retry_after: 7 } }), { status: 429 }),
    );
    expect(await call(port)).toEqual({ ok: false, reason: 'retry', retryAfterSeconds: 7 });
  });

  it('maps 429 with no retry_after to retry after 1 second', async () => {
    const { port } = fake(() => new Response('not json', { status: 429 }));
    expect(await port.ban(GROUP, USER)).toEqual({ ok: false, reason: 'retry', retryAfterSeconds: 1 });
  });

  it.each(CASES)('$name maps 403 to blocked, 5xx to retry and 400 to rejected', async ({ call }) => {
    expect(await call(fake(() => new Response('{}', { status: 403 })).port)).toEqual({
      ok: false,
      reason: 'blocked',
      retryAfterSeconds: null,
    });
    expect(await call(fake(() => new Response('{}', { status: 500 })).port)).toEqual({
      ok: false,
      reason: 'retry',
      retryAfterSeconds: null,
    });
    expect(await call(fake(() => new Response('{}', { status: 502 })).port)).toEqual({
      ok: false,
      reason: 'retry',
      retryAfterSeconds: null,
    });
    expect(await call(fake(() => new Response('{"ok":false}', { status: 400 })).port)).toEqual({
      ok: false,
      reason: 'rejected',
      retryAfterSeconds: null,
    });
  });

  it.each(CASES)('$name never throws when the fetch throws, and answers retry', async ({ call }) => {
    const { port } = fake(() => {
      throw new Error(`fetch failed for https://api.telegram.org/bot${TOKEN}/x`);
    });
    expect(await call(port)).toEqual({ ok: false, reason: 'retry', retryAfterSeconds: null });
  });

  it('puts the token in no answer and no console line, whatever Telegram or the fetch says', async () => {
    const lines: string[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(' '));
      }),
    );
    try {
      const answers: unknown[] = [];
      const makers: (() => Response)[] = [
        () => {
          throw new Error(`request to https://api.telegram.org/bot${TOKEN}/banChatMember failed`);
        },
        () =>
          new Response(JSON.stringify({ ok: false, description: `bot${TOKEN}`, parameters: { retry_after: 3 } }), {
            status: 429,
          }),
        () => new Response(JSON.stringify({ ok: false, description: `/bot${TOKEN}` }), { status: 400 }),
        () => new Response(`/bot${TOKEN}`, { status: 500 }),
      ];
      for (const make of makers) {
        for (const { call } of CASES) answers.push(await call(fake(make).port));
      }
      const text = JSON.stringify(answers) + lines.join('\n');
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain('/bot');
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('follows no redirect and gives each call a deadline', async () => {
    const inits: (RequestInit | undefined)[] = [];
    const port = createTelegramLoungePort(TOKEN, (async (_input: RequestInfo | URL, init?: RequestInit) => {
      inits.push(init);
      return ok();
    }) as typeof fetch);
    await port.ban(GROUP, USER);
    expect(inits[0]?.redirect).toBe('manual');
    expect(inits[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('answers rejected for a redirect, never ok', async () => {
    const { port } = fake(() => new Response(null, { status: 302, headers: { location: 'https://example.com' } }));
    expect(await port.approveJoin(GROUP, USER)).toEqual({ ok: false, reason: 'rejected', retryAfterSeconds: null });
  });
});
