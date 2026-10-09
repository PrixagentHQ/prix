import type { AgentRecord, AgentStats, ApiApp, ApiErrorCode, RowStatus, Season, StandingRow } from '@prix/contracts';
import { apiErrorSchema, MAX_AGENTS_OPEN, MAX_AGENTS_PRO, SESSION_COOKIE } from '@prix/contracts';
import { scoring } from '@prix/reputation';
import { sim } from '@prix/sim';
import { expect } from 'vitest';
import { createApp } from '../../apps/api/src/http/index.ts';
import type { TestWallet } from './eth.ts';
import { siweMessage, testWallet } from './eth.ts';
import { createTestVault, FakeRateLimiter } from './fakes.ts';
import { HOUSE_MODEL_ID, makeAgent, makeRow, SEASON_1, startingPortfolio, utc } from './fixtures.ts';
import type { MemoryStore } from './memory-store.ts';
import { createMemoryStore } from './memory-store.ts';

/**
 * The HTTP API under test, built with `createApp` from in-memory ports: the store, a rate
 * limiter that allows everything until told otherwise, a real AES-GCM sealer, the real
 * simulation and scoring engines, and a clock the test moves by hand. The configuration is
 * the one of revision 3: a bare lower-case origin and a secret that signs the sign-in nonces.
 */

export const SITE_ORIGIN = 'https://prix.test';
export const SITE_HOST = 'prix.test';
export const HOUSE_MODEL = HOUSE_MODEL_ID;

function fixtureSecret(step: number): string {
  return btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, index) => (index * step + 3) % 256)));
}
/** Fixture values for the Worker secret NONCE_SECRET: 32 fixed bytes in base64. They guard nothing real. */
export const NONCE_SECRET = fixtureSecret(7);
export const OTHER_NONCE_SECRET = fixtureSecret(11);
export const START_TIME = '2026-10-06T14:00:00.000Z';
/** The one admin wallet of the tests. */
export const ADMIN_WALLET = testWallet(900);

export interface Reply {
  status: number;
  headers: Headers;
  text: string;
  // biome-ignore lint/suspicious/noExplicitAny: a test reads whatever the API sent and then checks it against a schema
  json: any;
  setCookies: string[];
}

export interface SendOptions {
  body?: unknown;
  /** Sent as it is, instead of `body` as JSON. */
  rawBody?: string;
  /** `null` leaves the header out. The default for a request that changes state is the site origin. */
  origin?: string | null;
  /** `null` leaves the header out. The default for a request that changes state is application/json. */
  contentType?: string | null;
  headers?: Record<string, string>;
}

export interface Api {
  app: ApiApp;
  store: MemoryStore;
  limiter: FakeRateLimiter;
  vault: ReturnType<typeof createTestVault>;
  /** Every response the API sent in this test: status line, headers and body. */
  transcript: string[];
  now(): Date;
  setNow(iso: string): void;
  advance(ms: number): void;
  client(ip?: string): Client;
  /** A client that is already signed in with `wallet`. */
  signedIn(wallet: TestWallet): Promise<Client>;
  /** Puts an agent with a record straight into the store, for the league and admin tests. */
  seedAgent(options: SeedOptions): Promise<AgentRecord>;
}

export interface SeedOptions {
  n: number;
  division?: 'open' | 'pro';
  stats?: Partial<AgentStats>;
  /** The tick of the agent's latest row. Leave out for an agent with no row. */
  tickId?: string;
  status?: RowStatus;
  createdAt?: string;
  overrides?: Partial<AgentRecord>;
  owner?: string;
}

export class Client {
  cookie: string | null = null;

  constructor(
    private readonly api: Api,
    readonly ip: string,
  ) {}

  async send(method: string, path: string, options: SendOptions = {}): Promise<Reply> {
    const changesState = method !== 'GET' && method !== 'HEAD';
    const headers = new Headers(options.headers);
    headers.set('CF-Connecting-IP', this.ip);
    const origin = options.origin === undefined ? (changesState ? SITE_ORIGIN : null) : options.origin;
    if (origin !== null) headers.set('Origin', origin);
    const contentType =
      options.contentType === undefined ? (changesState ? 'application/json' : null) : options.contentType;
    if (contentType !== null) headers.set('Content-Type', contentType);
    if (this.cookie !== null) headers.set('Cookie', `${SESSION_COOKIE}=${this.cookie}`);

    const body = options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
    const response = await this.api.app.fetch(new Request(`${SITE_ORIGIN}${path}`, { method, headers, body }));
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    const setCookies = response.headers.getSetCookie();
    for (const line of setCookies) {
      const [pair = ''] = line.split(';');
      const [name, ...rest] = pair.split('=');
      if (name?.trim() !== SESSION_COOKIE) continue;
      const value = rest.join('=').trim();
      const cleared = value === '' || /max-age=0\b/i.test(line) || /expires=thu, 01 jan 1970/i.test(line);
      this.cookie = cleared ? null : value;
    }
    const headerText = [...response.headers.entries()].map(([name, value]) => `${name}: ${value}`).join('\n');
    this.api.transcript.push(`${method} ${path} -> ${response.status}\n${headerText}\n\n${text}`);
    return { status: response.status, headers: response.headers, text, json, setCookies };
  }

  get(path: string, options?: SendOptions): Promise<Reply> {
    return this.send('GET', path, options);
  }

  post(path: string, body?: unknown, options: SendOptions = {}): Promise<Reply> {
    return this.send('POST', path, { body, ...options });
  }

  patch(path: string, body?: unknown, options: SendOptions = {}): Promise<Reply> {
    return this.send('PATCH', path, { body, ...options });
  }

  delete(path: string, options: SendOptions = {}): Promise<Reply> {
    return this.send('DELETE', path, options);
  }

  /** Asks for a nonce, signs the message the server describes and sends it for verification. */
  async signIn(wallet: TestWallet, change: Partial<SignInChange> = {}): Promise<Reply> {
    const nonce = (await this.get('/api/siwe/nonce')).json as {
      nonce: string;
      domain: string;
      uri: string;
      chainId: number;
      statement: string;
    };
    change.afterNonce?.();
    const message =
      change.message ??
      siweMessage({
        domain: change.domain ?? nonce.domain,
        address: change.address ?? wallet.checksumAddress,
        statement: change.statement ?? nonce.statement,
        uri: change.uri ?? nonce.uri,
        version: change.version,
        chainId: change.chainId ?? nonce.chainId,
        nonce: change.nonce ?? nonce.nonce,
        issuedAt: change.issuedAt ?? this.api.now().toISOString(),
        expirationTime: change.expirationTime,
        notBefore: change.notBefore,
        requestId: change.requestId,
        resources: change.resources,
      });
    const signature = change.signature ?? (await (change.signer ?? wallet).signMessage(message));
    this.lastSignIn = { message, signature };
    return this.post('/api/siwe/verify', { message, signature });
  }

  /** The message and signature of the last `signIn`, for replay tests. */
  lastSignIn: { message: string; signature: string } | null = null;
}

export interface SignInChange {
  domain: string;
  address: string;
  statement: string;
  uri: string;
  version: string;
  chainId: number;
  nonce: string;
  issuedAt: string;
  expirationTime: string;
  notBefore: string;
  requestId: string;
  resources: readonly string[];
  message: string;
  signature: string;
  signer: TestWallet;
  /** Runs between the nonce request and the signature, for example to move the clock. */
  afterNonce: () => void;
}

export function createApi(
  options: {
    now?: string;
    seasons?: readonly Season[];
    store?: MemoryStore;
    vault?: ReturnType<typeof createTestVault>;
    nonceSecret?: string;
    /** `ApiConfig.houseOwners`: the wallets whose agents are house agents. Left out: there are none. */
    houseOwners?: readonly string[];
  } = {},
): Api {
  let now = utc(options.now ?? START_TIME);
  const store = options.store ?? createMemoryStore(options.seasons ?? [SEASON_1]);
  const limiter = new FakeRateLimiter();
  const vault = options.vault ?? createTestVault();
  const transcript: string[] = [];
  const app = createApp({
    store,
    sim,
    scoring,
    sealer: vault.sealer,
    rateLimiter: limiter,
    config: {
      siteOrigin: SITE_ORIGIN,
      adminAddresses: [ADMIN_WALLET.address],
      houseModel: HOUSE_MODEL,
      nonceSecret: options.nonceSecret ?? NONCE_SECRET,
      ...(options.houseOwners === undefined ? {} : { houseOwners: options.houseOwners }),
    },
    now: () => new Date(now.getTime()),
  });

  let nextIp = 10;
  const api: Api = {
    app,
    store,
    limiter,
    vault,
    transcript,
    now: () => new Date(now.getTime()),
    setNow(iso) {
      now = utc(iso);
    },
    advance(ms) {
      now = new Date(now.getTime() + ms);
    },
    client(ip) {
      nextIp += 1;
      return new Client(api, ip ?? `203.0.113.${nextIp}`);
    },
    async signedIn(wallet) {
      const client = api.client();
      const reply = await client.signIn(wallet);
      expect(reply.status, `sign-in failed: ${reply.text}`).toBe(200);
      expect(client.cookie, 'sign-in set no session cookie').not.toBeNull();
      return client;
    },
    async seedAgent(seed) {
      const agent = makeAgent({
        n: seed.n,
        division: seed.division ?? 'open',
        owner: seed.owner,
        modelKeyId: seed.division === 'pro' ? `key${'a'.repeat(9)}` : null,
        createdAt: seed.createdAt,
        overrides: seed.overrides,
      });
      const stats: AgentStats = { ...scoring.initialStats(), ...seed.stats };
      const created = await store.createAgent(
        agent,
        SEASON_1.id,
        startingPortfolio(),
        scoring.initialStats(),
        agent.division === 'pro' ? MAX_AGENTS_PRO : MAX_AGENTS_OPEN,
      );
      if (created !== 'created') throw new Error(`seedAgent: ${created}`);
      if (seed.tickId !== undefined) {
        const row = makeRow({
          agent,
          tickId: seed.tickId,
          status: seed.status ?? 'decided',
          equityMicro: stats.equityMicro,
        });
        if (!(await store.writeDecision(row, stats, 0))) throw new Error('seedAgent: the row was refused');
      }
      return agent;
    },
  };
  return api;
}

/** Checks that a reply is an error of the contract's shape, with the given status and code. */
export function expectError(reply: Reply, status: number, code: ApiErrorCode): void {
  expect(reply.status, `expected ${status} ${code}, got ${reply.status}: ${reply.text.slice(0, 300)}`).toBe(status);
  const parsed = apiErrorSchema.safeParse(reply.json);
  expect(parsed.success, `not an apiErrorSchema body: ${reply.text.slice(0, 300)}`).toBe(true);
  expect(reply.json.error.code).toBe(code);
  expectSafeMessage(reply);
}

/** An error message says what happened. It never carries a stack trace or an internal detail. */
export function expectSafeMessage(reply: Reply): void {
  const message = String(reply.json?.error?.message ?? '');
  expect(message.length).toBeGreaterThan(0);
  expect(message).not.toMatch(
    /\n\s+at\s|\bat\s+\S+\s+\(|node_modules|\.ts:\d+|MemoryStore|TypeError|ReferenceError|ZodError/,
  );
}

/** Checks a reply against a schema of `packages/contracts` and returns the parsed value. */
export function expectShape<T>(
  schema: { safeParse(value: unknown): { success: boolean; data?: T; error?: unknown } },
  reply: Reply,
  status = 200,
): T {
  expect(reply.status, `expected ${status}, got ${reply.status}: ${reply.text.slice(0, 300)}`).toBe(status);
  const parsed = schema.safeParse(reply.json);
  expect(
    parsed.success,
    `the body does not match the contract: ${JSON.stringify(parsed.error)}\n${reply.text.slice(0, 500)}`,
  ).toBe(true);
  return parsed.data as T;
}

/**
 * League rows as the reference ranking knows them: without the three fields of revision 5
 * (docs/CONTRACTS.md section 17) and the two holdings fields of section 17.2, which say what an
 * agent is and holds and nothing about where it stands.
 */
export function rankingOf(
  rows: readonly StandingRow[],
): Omit<
  StandingRow,
  'summary' | 'createdAt' | 'house' | 'topHoldings' | 'cashWeightBps' | 'scoreMilli' | 'confidence' | 'scoredDay'
>[] {
  return rows.map(
    ({
      summary: _summary,
      createdAt: _createdAt,
      house: _house,
      topHoldings: _topHoldings,
      cashWeightBps: _cashWeightBps,
      scoreMilli: _scoreMilli,
      confidence: _confidence,
      scoredDay: _scoredDay,
      ...ranking
    }) => ranking,
  );
}

export const PUBLIC_CACHE = 'public, max-age=30';

export function expectPublicCache(reply: Reply): void {
  expect(reply.headers.get('Cache-Control')).toBe(PUBLIC_CACHE);
}

export function expectNoStore(reply: Reply): void {
  expect(reply.headers.get('Cache-Control')).toBe('no-store');
}

/** A prompt that passes `promptSchema`. */
export const PROMPT = 'Hold the five largest companies in equal parts and change the portfolio at most once a week.';

/** A model key of a realistic shape. It is a fixture, not a secret: it opens nothing. */
export const TEST_API_KEY = 'fixture-key-Zq7Lm2Xv9Rt4Kp8Wn3Bc6Hy1Jd5Fg0As';
export const OTHER_API_KEY = 'fixture-key-Pw4Nc8Uy2Gh6Tr0Ev5Mk9Sx3Lb7Dj1Qz';

/** Fails if any of the given secrets appears in the text, also in base64 or URL-encoded form. */
export function expectNoSecret(text: string, secrets: readonly string[], where: string): void {
  for (const secret of secrets) {
    const forms = [secret, btoa(secret), encodeURIComponent(secret), secret.slice(0, 24), secret.slice(-24)];
    for (const form of forms) {
      expect(text.includes(form), `${where} contains a model key (ending ${secret.slice(-4)})`).toBe(false);
    }
  }
}
