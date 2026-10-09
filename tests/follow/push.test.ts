import type { DueNotice, PushSender, PushSubscriptionRow } from '@prix/contracts';
import { isAllowedPushEndpoint, pushSubscriptionInputSchema } from '@prix/contracts';
import { runDeliverStep } from '@prix/runtime/follow/deliver';
import { createPushSender } from '@prix/runtime/follow/push';
import { describe, expect, it } from 'vitest';

const FCM = 'https://fcm.googleapis.com/fcm/send/abc';
const NOW = new Date('2026-10-07T16:00:00.000Z');

describe('push endpoint allowlist', () => {
  it('accepts the allowed services', () => {
    for (const url of [
      FCM,
      'https://updates.push.services.mozilla.com/wpush/v2/x',
      'https://web.push.apple.com/Q',
      'https://wns2-par02p.notify.windows.com/w/?token=x',
    ]) {
      expect(isAllowedPushEndpoint(url), url).toBe(true);
    }
  });
  it('refuses everything else', () => {
    for (const url of [
      'http://fcm.googleapis.com/x',
      'https://example.com/x',
      'https://fcm.googleapis.com.evil.com/x',
      'https://evilfcm.googleapis.com/x',
      'https://evil-notify.windows.com/x',
      'https://notify.windows.com/x',
      'https://user:pw@fcm.googleapis.com/x',
      'https://fcm.googleapis.com:8443/x',
      `https://fcm.googleapis.com/${'a'.repeat(1000)}`,
      'not a url',
    ]) {
      expect(isAllowedPushEndpoint(url), url).toBe(false);
      expect(pushSubscriptionInputSchema.safeParse({ endpoint: url }).success).toBe(false);
    }
    expect(pushSubscriptionInputSchema.safeParse({ endpoint: FCM }).success).toBe(true);
  });
});

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

async function makeKeys() {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const privateBytes = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer);
  const pkcs8 = btoa(String.fromCharCode(...privateBytes));
  const publicKey = b64url(new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer));
  return { pair, pkcs8, publicKey };
}

function memoryStore(endpoints: string[]) {
  const rows = new Map<string, PushSubscriptionRow>(
    endpoints.map((endpoint) => [
      endpoint,
      { id: endpoint, address: '0xa', endpoint, createdAt: '2026-10-01T00:00:00.000Z', lastPushedAt: null },
    ]),
  );
  return {
    rows,
    listSubscriptions: async () => [...rows.values()],
    removeByEndpoint: async (endpoint: string) => void rows.delete(endpoint),
    markAccepted: async (endpoint: string, now: string) => {
      const row = rows.get(endpoint);
      if (row) row.lastPushedAt = now;
    },
  };
}

const decode = (v: string): Uint8Array<ArrayBuffer> => {
  const text = atob(v.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(text.length));
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i);
  return out;
};

describe('push sender', () => {
  it('signs a verifiable VAPID token, sends the right headers, reuses the token', async () => {
    const keys = await makeKeys();
    const store = memoryStore([FCM, 'https://fcm.googleapis.com/fcm/send/two']);
    const calls: { url: string; init: RequestInit }[] = [];
    const sender = createPushSender({
      store,
      publicKey: keys.publicKey,
      privateKey: keys.pkcs8,
      now: () => NOW,
      log: () => undefined,
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(null, { status: 201 });
      }) as unknown as typeof fetch,
    });
    const result = await sender.pushTo('0xa', 40);
    expect(result.delivered).toBe(2);
    const first = calls[0]?.init;
    const headers = first?.headers as Record<string, string>;
    expect(first?.method).toBe('POST');
    expect(first?.redirect).toBe('manual');
    expect(first?.body).toBeUndefined();
    expect(headers.TTL).toBe('3600');
    const match = /^vapid t=([^,]+), k=(.+)$/.exec(headers.Authorization ?? '');
    expect(match?.[2]).toBe(keys.publicKey);
    const [h, c, s] = (match?.[1] ?? '').split('.') as [string, string, string];
    expect(JSON.parse(new TextDecoder().decode(decode(h)))).toEqual({ typ: 'JWT', alg: 'ES256' });
    const claims = JSON.parse(new TextDecoder().decode(decode(c)));
    expect(claims.aud).toBe('https://fcm.googleapis.com');
    expect(claims.sub).toBe('mailto:support@prixagent.com');
    expect(claims.exp).toBe(Math.floor(NOW.getTime() / 1000) + 12 * 3600);
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      keys.pair.publicKey,
      decode(s),
      new TextEncoder().encode(`${h}.${c}`),
    );
    expect(ok).toBe(true);
    // The same token for the same service.
    const second = calls[1]?.init.headers as Record<string, string>;
    expect(second.Authorization).toBe(headers.Authorization);
  });

  it('removes a subscription on 410, keeps it on 500 and on a redirect, never follows a redirect', async () => {
    const keys = await makeKeys();
    const gone = 'https://fcm.googleapis.com/fcm/send/gone';
    const broken = 'https://fcm.googleapis.com/fcm/send/broken';
    const moved = 'https://fcm.googleapis.com/fcm/send/moved';
    const store = memoryStore([gone, broken, moved]);
    const urls: string[] = [];
    const sender = createPushSender({
      store,
      publicKey: keys.publicKey,
      privateKey: keys.pkcs8,
      now: () => NOW,
      log: () => undefined,
      fetch: (async (url: string) => {
        urls.push(url);
        if (url === gone) return new Response(null, { status: 410 });
        if (url === moved) return new Response(null, { status: 302, headers: { Location: 'https://evil.example/x' } });
        return new Response('x'.repeat(5000), { status: 500 });
      }) as unknown as typeof fetch,
    });
    const result = await sender.pushTo('0xa', 40);
    expect(result).toMatchObject({ delivered: 0, kept: 2 });
    expect([...store.rows.keys()].sort()).toEqual([broken, moved].sort());
    expect(urls).not.toContain('https://evil.example/x');
  });

  it('never fetches an address off the allowlist and drops it', async () => {
    const keys = await makeKeys();
    const bad = 'https://evil.example/push';
    const store = memoryStore([bad]);
    let fetched = 0;
    const sender = createPushSender({
      store,
      publicKey: keys.publicKey,
      privateKey: keys.pkcs8,
      now: () => NOW,
      log: () => undefined,
      fetch: (async () => {
        fetched += 1;
        return new Response(null, { status: 201 });
      }) as unknown as typeof fetch,
    });
    await sender.pushTo('0xa', 40);
    expect(fetched).toBe(0);
    expect(store.rows.size).toBe(0);
  });
});

describe('deliver step with push only', () => {
  const notice = (address: string, agentId: string): DueNotice => ({
    address,
    tickId: '2026-10-07T15:00Z',
    agentId,
    attempts: 0,
    chatId: 0,
    agentName: 'Alpha',
    fills: [{ symbol: 'TSLA', side: 'buy' }],
  });

  function run(push: PushSender | null) {
    const finished: { done: number; retry: number }[] = [];
    const deps = {
      store: {
        listDueNotices: async () => [notice('0xa', 'a1'), notice('0xb', 'a1')],
        finishNotices: async (done: readonly unknown[], retry: readonly unknown[]) => {
          finished.push({ done: done.length, retry: retry.length });
        },
        deleteChatById: async () => undefined,
      },
      telegram: null,
      push,
      entitlements: { entitlementsFor: async () => ({ feedDelaySeconds: 0 }) },
      siteOrigin: 'https://prixagent.com',
      log: () => undefined,
    };
    return { finished, report: runDeliverStep(deps as never, NOW) };
  }

  it('counts a note delivered when push accepted it, retries when kept, does nothing with no channel', async () => {
    const sender: PushSender = {
      pushTo: async (address) =>
        address === '0xa' ? { delivered: 1, kept: 0, requests: 2 } : { delivered: 0, kept: 1, requests: 2 },
    };
    const { report } = run(sender);
    expect(await report).toEqual({ sent: 1, dropped: 0, retried: 1, blocked: 0 });
    const none = run(null);
    expect(await none.report).toEqual({ sent: 0, dropped: 0, retried: 0, blocked: 0 });
    expect(none.finished).toEqual([]);
  });

  it('gives push only what is left of its 40 requests', async () => {
    const budgets: number[] = [];
    const sender: PushSender = {
      pushTo: async (_address, budget) => {
        budgets.push(budget);
        return { delivered: 1, kept: 0, requests: 30 };
      },
    };
    await run(sender).report;
    // The first push gets 40 minus the two statements before it; the second only what is left.
    expect(budgets).toEqual([38, 6]);
  });
});
