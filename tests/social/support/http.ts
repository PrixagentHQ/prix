import type { ApiError, Entitlements, SocialApiDeps } from '@prix/contracts';
import { OPEN_PREVIEW_ENTITLEMENTS, SESSION_COOKIE, SESSION_TTL_SECONDS } from '@prix/contracts';
import { scoring } from '@prix/reputation';
import { warStandings } from '@prix/reputation/war-standings';
import { sim } from '@prix/sim';
import { createApp } from '../../../apps/api/src/http/index.ts';
import { hashToken, newSessionToken } from '../../../apps/api/src/http/session.ts';
import { createTestVault, FakeRateLimiter } from '../../support/fakes.ts';
import { HOUSE_MODEL_ID, testAddress } from '../../support/fixtures.ts';
import type { Stores } from './d1.ts';

export const SITE_ORIGIN = 'https://prix.test';

/** Every error message the routes sent during this file's tests, for the test of the words Prix does not use. */
export const SENT_MESSAGES = new Set<string>();
/** The one admin wallet of the Phase 6 route tests (ADMIN_ADDRESSES). */
export const ADMIN_ADDRESS = testAddress(900);
/** The first sign-in `signIn` records for a wallet: long before any test clock, so a seasoned wallet. */
export const SEASONED_FIRST_SIGN_IN = '2020-01-01T00:00:00.000Z';

/**
 * The Phase 6 routes on the real stores of the local database, behind `createApp` itself: the rate
 * limit and the body-size guard first, the routes under /api, the generic 404 and the error handler.
 */

export interface Reply {
  status: number;
  headers: Headers;
  text: string;
  // biome-ignore lint/suspicious/noExplicitAny: a test reads whatever the API sent and then checks it against a schema
  json: any;
}

export interface RequestOptions {
  body?: unknown;
  rawBody?: string;
  cookie?: string;
  origin?: string | null;
  contentType?: string | null;
  /** The client address (CF-Connecting-IP); 203.0.113.9 unless a test needs another network. */
  ip?: string;
}

let nextNetwork = 0;
/**
 * A client address no request of this file has used yet: a network with its whole allowance of
 * manager creations (NEW_MANAGERS_PER_NETWORK_PER_DAY and _PER_PERIOD), for a test that checks
 * another rule and would otherwise meet the network caps first.
 */
export function freshNetwork(): string {
  nextNetwork += 1;
  return `10.${Math.floor(nextNetwork / 250) % 250}.${nextNetwork % 250}.1`;
}

export interface SocialHttp {
  deps: SocialApiDeps;
  limiter: FakeRateLimiter;
  entitlements: { value: Entitlements };
  groq: { configured: boolean };
  setNow(iso: string): void;
  fetch(method: string, path: string, options?: RequestOptions): Promise<Reply>;
  /** A session cookie for `address`, stored the way the sign-in route stores it. */
  signIn(address: string): Promise<string>;
  /** Every response so far: what a leak scan reads. */
  transcript: string[];
  /**
   * What the app handed to `waitUntil` of the request's execution context, in order. From Phase 6.4 on
   * every request of this harness carries a context that records it (docs/contracts/phase-6-pictures.md
   * section 5): the upload of a picture answers 500 with none.
   */
  waited: Promise<unknown>[];
}

export function createSocialHttp(
  stores: Stores,
  options: { on?: boolean; now?: string; adminAddresses?: string[]; houseOwners?: string[] } = {},
): SocialHttp {
  let now = new Date(options.now ?? '2026-10-20T12:00:00.000Z');
  const limiter = new FakeRateLimiter();
  const entitlements = { value: OPEN_PREVIEW_ENTITLEMENTS };
  const groq = { configured: false };
  const transcript: string[] = [];
  const waited: Promise<unknown>[] = [];
  /** A request's execution context that writes down what `waitUntil` was handed. */
  const context = {
    waitUntil: (promise: Promise<unknown>) => void waited.push(promise),
    passThroughOnException: () => undefined,
    props: {},
  };
  const deps = {
    store: stores.store,
    sim,
    scoring,
    sealer: createTestVault().sealer,
    rateLimiter: limiter,
    config: {
      siteOrigin: SITE_ORIGIN,
      adminAddresses: options.adminAddresses ?? [ADMIN_ADDRESS],
      houseModel: HOUSE_MODEL_ID,
      nonceSecret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      houseOwners: options.houseOwners ?? [],
    },
    now: () => new Date(now.getTime()),
    social: stores.social,
    reputation: stores.reputation,
    entitlements: { entitlementsFor: async () => entitlements.value },
    warStandings,
    get groqConfigured() {
      return groq.configured;
    },
  } as unknown as SocialApiDeps;

  // The app the Worker serves: createApp mounts the admin routes always, the public ones while the switch is on.
  const app = createApp(deps, {
    socialAdmin: deps,
    ...((options.on ?? true) ? { social: deps } : {}),
  });

  return {
    deps,
    limiter,
    entitlements,
    groq,
    transcript,
    waited,
    setNow(iso) {
      now = new Date(iso);
    },
    async fetch(method, path, request = {}) {
      const changes = method !== 'GET' && method !== 'HEAD';
      const headers = new Headers({ 'CF-Connecting-IP': request.ip ?? '203.0.113.9' });
      const origin = request.origin === undefined ? (changes ? SITE_ORIGIN : null) : request.origin;
      if (origin !== null) headers.set('Origin', origin);
      const type = request.contentType === undefined ? (changes ? 'application/json' : null) : request.contentType;
      if (type !== null) headers.set('Content-Type', type);
      if (request.cookie !== undefined) headers.set('Cookie', `${SESSION_COOKIE}=${request.cookie}`);
      const body = request.rawBody ?? (request.body === undefined ? undefined : JSON.stringify(request.body));
      const response = await app.fetch(
        new Request(`${SITE_ORIGIN}${path}`, { method, headers, body }),
        context as never,
      );
      const text = await response.text();
      let json: unknown = null;
      try {
        json = text === '' ? null : JSON.parse(text);
      } catch {
        json = null;
      }
      const message = (json as { error?: { message?: unknown } } | null)?.error?.message;
      if (typeof message === 'string') SENT_MESSAGES.add(message);
      const head = [...response.headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\n');
      transcript.push(`${method} ${path} -> ${response.status}\n${head}\n\n${text}`);
      return { status: response.status, headers: response.headers, text, json };
    },
    async signIn(address) {
      const token = newSessionToken();
      const at = now.toISOString();
      const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000).toISOString();
      await stores.store.putSession({ tokenHash: await hashToken(token), address, createdAt: at, expiresAt });
      // The sign-in route also writes the wallet's first sign-in (users.created_at, insert if absent).
      // Here it is long ago, so the wallet is seasoned (contract 6.1, WALLET_SEASONING_SECONDS); a test
      // of seasoning itself writes its own first sign-in before this, and this insert keeps it.
      await stores.store.touchUser(address, SEASONED_FIRST_SIGN_IN);
      return token;
    },
  };
}

export function errorOf(reply: Reply): ApiError['error'] {
  return (reply.json as ApiError).error;
}
