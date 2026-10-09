import type { PushSender, PushStore } from '@prix/contracts';
import {
  isAllowedPushEndpoint,
  PUSH_MAX_RESPONSE_BYTES,
  PUSH_TIMEOUT_MS,
  PUSH_TTL_SECONDS,
  VAPID_SUBJECT,
  VAPID_TOKEN_LIFETIME_SECONDS,
  VAPID_TOKEN_REFRESH_SECONDS,
} from '@prix/contracts';

/**
 * Sends an empty push, signed with VAPID (RFC 8292), to the subscriptions of a wallet. The address
 * of a subscription comes from a browser, so it is untrusted: nothing is fetched unless it is on
 * the allowlist of `isAllowedPushEndpoint`, a redirect is never followed, at most 1 KB of the
 * answer is read, and a request is given up after 5 seconds. No body, so nothing about a person
 * or an agent travels in a push.
 */

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64(value: string): ArrayBuffer {
  const text = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  const buffer = new ArrayBuffer(text.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i);
  return buffer;
}

export interface PushSenderConfig {
  store: Pick<PushStore, 'listSubscriptions' | 'removeByEndpoint' | 'markAccepted'>;
  /** The public key, the raw point in base64url. Sent as `k=` and never secret. */
  publicKey: string;
  /** The PKCS8 private key in base64. A Worker secret. */
  privateKey: string;
  now(): Date;
  fetch?: typeof fetch;
  log(event: string, data?: Record<string, string | number | boolean | null>): void;
}

async function readAtMost(response: Response, limit: number): Promise<void> {
  const body = response.body;
  if (body === null) return;
  const reader = body.getReader();
  let read = 0;
  try {
    while (read < limit) {
      const chunk = await reader.read();
      if (chunk.done) return;
      read += chunk.value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export function createPushSender(config: PushSenderConfig): PushSender {
  const doFetch = config.fetch ?? fetch;
  let keyPromise: Promise<CryptoKey> | null = null;
  const tokens = new Map<string, { token: string; expiresAt: number }>();

  const signingKey = (): Promise<CryptoKey> => {
    keyPromise ??= crypto.subtle.importKey(
      'pkcs8',
      fromBase64(config.privateKey),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign'],
    );
    return keyPromise;
  };

  /** One token for each push service, made once and reused until an hour before it ends. */
  async function tokenFor(origin: string): Promise<string> {
    const nowSeconds = Math.floor(config.now().getTime() / 1000);
    const cached = tokens.get(origin);
    if (cached !== undefined && cached.expiresAt - nowSeconds > VAPID_TOKEN_REFRESH_SECONDS) return cached.token;
    const expiresAt = nowSeconds + VAPID_TOKEN_LIFETIME_SECONDS;
    const header = base64url(encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
    const claims = base64url(encoder.encode(JSON.stringify({ aud: origin, exp: expiresAt, sub: VAPID_SUBJECT })));
    const input = `${header}.${claims}`;
    const signature = new Uint8Array(
      await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await signingKey(), encoder.encode(input)),
    );
    const token = `${input}.${base64url(signature)}`;
    tokens.set(origin, { token, expiresAt });
    return token;
  }

  return {
    async pushTo(address, budget) {
      let delivered = 0;
      let requests = 0;
      let kept = 0;
      try {
        requests += 1;
        const subscriptions = await config.store.listSubscriptions(address);
        for (const subscription of subscriptions) {
          const endpoint = subscription.endpoint;
          if (!isAllowedPushEndpoint(endpoint)) {
            // Never fetched. A row like this was not written by the API, so it is dropped.
            requests += 1;
            await config.store.removeByEndpoint(endpoint);
            config.log('push_endpoint_refused');
            continue;
          }
          if (requests + 2 > budget) {
            kept += 1;
            continue;
          }
          requests += 1;
          try {
            const token = await tokenFor(new URL(endpoint).origin);
            const response = await doFetch(endpoint, {
              method: 'POST',
              redirect: 'manual',
              headers: {
                Authorization: `vapid t=${token}, k=${config.publicKey}`,
                TTL: String(PUSH_TTL_SECONDS),
                'Content-Length': '0',
              },
              signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
            });
            await readAtMost(response, PUSH_MAX_RESPONSE_BYTES);
            const status = response.status;
            if (status === 200 || status === 201 || status === 204) {
              delivered += 1;
              requests += 1;
              await config.store.markAccepted(endpoint, config.now().toISOString());
            } else if (status === 404 || status === 410) {
              requests += 1;
              await config.store.removeByEndpoint(endpoint);
            } else {
              kept += 1;
              config.log('push_not_accepted', { status });
            }
          } catch {
            kept += 1;
            config.log('push_failed');
          }
        }
      } catch {
        kept += 1;
        config.log('push_failed');
      }
      return { delivered, kept, requests };
    },
  };
}
