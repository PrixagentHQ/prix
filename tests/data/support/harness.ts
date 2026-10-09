import type {
  Address,
  AgentListing,
  DataChainPort,
  DataConfig,
  DataDeps,
  DataEndpointSpec,
  DataRecordsPort,
  Entitlements,
  EntitlementsPort,
  LaunchScan,
  PaymentFacts,
  PonsLaunch,
  TokenBasics,
} from '@prix/contracts';
import {
  ChainUnavailableError,
  DATA_ENDPOINTS,
  OPEN_PREVIEW_ENTITLEMENTS,
  PONS_FACTORIES,
  SESSION_COOKIE,
  tickIdFor,
  USDG_ADDRESS,
} from '@prix/contracts';
import { expect } from 'vitest';
import { createDataApp } from '../../../apps/api/src/http/data/app.ts';
import { generateApiKey, hashApiKey } from '../../../apps/api/src/http/data/keys.ts';
import { hashToken } from '../../../apps/api/src/http/session.ts';
import type { Api, Client } from '../../support/api.ts';
import { ADMIN_WALLET, createApi, SITE_ORIGIN } from '../../support/api.ts';
import type { TestWallet } from '../../support/eth.ts';
import { testWallet } from '../../support/eth.ts';
import { makeTick, SEASON_1, utc } from '../../support/fixtures.ts';
import { MemoryDataStore } from './memory-data-store.ts';

export { ADMIN_WALLET, MemoryDataStore, SITE_ORIGIN };

/** The address that receives USDG in the tests. It belongs to nobody. */
export const PAYMENT_ADDRESS: Address = `0x${'ab'.repeat(20)}`;
export const OTHER_ADDRESS: Address = `0x${'cd'.repeat(20)}`;
export const OTHER_CONTRACT: Address = `0x${'ee'.repeat(20)}`;
export const HEAD_BLOCK = 5_000;
/** A hash made of one repeated letter, so a test can write it in upper case. */
export const TX_A = `0x${'a1'.repeat(32)}`;
export const TX_B = `0x${'b2'.repeat(32)}`;

export const lc = (value: string): string => value.toLowerCase();

export const baseConfig: DataConfig = {
  enabled: true,
  paymentsEnabled: true,
  paymentAddress: PAYMENT_ADDRESS,
  siteOrigin: SITE_ORIGIN,
  adminAddresses: [ADMIN_WALLET.address],
  apiDailyCeiling: 10_000,
  pageDailyCeiling: 2_000,
  paidDailyCap: 5_000,
  callPriceMicro: 1_000,
  minPaymentMicro: 1_000_000,
  confirmations: 20,
};

// --- fakes for the ports ----------------------------------------------------------------------

export function notFoundFacts(): PaymentFacts {
  return { found: false, success: null, blockNumber: null, headBlock: HEAD_BLOCK, transfers: [], decimalsOk: true };
}

/** A payment as the chain reader would report it: only USDG transfers are in `transfers`. */
export function paidFacts(
  from: string,
  valueMicro: string | number,
  change: Partial<PaymentFacts> & { to?: string } = {},
): PaymentFacts {
  const { to, ...rest } = change;
  return {
    found: true,
    success: true,
    blockNumber: HEAD_BLOCK - 100,
    headBlock: HEAD_BLOCK,
    decimalsOk: true,
    transfers: [{ from: lc(from), to: lc(to ?? PAYMENT_ADDRESS), valueMicro: String(valueMicro) }],
    ...rest,
  };
}

export function basicsOf(change: Partial<TokenBasics> = {}): TokenBasics {
  return {
    isContract: true,
    codeSizeBytes: 4_000,
    name: 'Fixture',
    symbol: 'FIX',
    decimals: 18,
    totalSupply: '1000000000000000000000000',
    owner: null,
    proxyImplementation: null,
    hasMintSelector: false,
    hasPauseSelector: false,
    holderBalance: null,
    readAtBlock: HEAD_BLOCK,
    ...change,
  };
}

export function launchOf(token: string, deployer: string, n = 1): PonsLaunch {
  return {
    factory: (PONS_FACTORIES[0] as { address: Address }).address,
    token: lc(token),
    deployer: lc(deployer),
    blockNumber: 1_000 + n,
    txHash: `0x${n.toString(16).padStart(64, '0')}`,
    logIndex: n,
  };
}

export class FakeDataChain implements DataChainPort {
  fail = false;
  readonly facts = new Map<string, PaymentFacts>();
  readonly launchesByDeployer = new Map<string, PonsLaunch[]>();
  readonly launchOfToken = new Map<string, PonsLaunch>();
  readonly basics = new Map<string, TokenBasics>();
  /** Every call, with the arguments the server sent, so a test can check the address case. */
  readonly calls: { method: string; args: unknown[] }[] = [];

  private guard(method: string, args: unknown[]): void {
    this.calls.push({ method, args });
    if (this.fail) throw new ChainUnavailableError();
  }

  async readLaunchesByDeployer(deployer: Address, limit: number): Promise<LaunchScan> {
    this.guard('readLaunchesByDeployer', [deployer, limit]);
    const all = this.launchesByDeployer.get(deployer) ?? [];
    return {
      launches: all.slice(0, limit),
      total: all.length,
      scannedFromBlock: 0,
      scannedToBlock: HEAD_BLOCK,
    };
  }

  async readLaunchOfToken(token: Address): Promise<PonsLaunch | null> {
    this.guard('readLaunchOfToken', [token]);
    return this.launchOfToken.get(token) ?? null;
  }

  async readTokenBasics(token: Address, holder: Address | null): Promise<TokenBasics> {
    this.guard('readTokenBasics', [token, holder]);
    return this.basics.get(token) ?? basicsOf();
  }

  async readPaymentFacts(txHash: string): Promise<PaymentFacts> {
    this.guard('readPaymentFacts', [txHash]);
    return this.facts.get(txHash) ?? notFoundFacts();
  }
}

export class FakeRecords implements DataRecordsPort {
  readonly listings = new Map<string, AgentListing[]>();
  async listingsOf(wallet: Address): Promise<readonly AgentListing[]> {
    return this.listings.get(wallet) ?? [];
  }
}

/** Entitlements that give one wallet a different quota or delay, and everyone else the open preview. */
export class FakeEntitlements implements EntitlementsPort {
  readonly overrides = new Map<string, Partial<Entitlements>>();
  async entitlementsFor(address: Address | null): Promise<Entitlements> {
    const change = address === null ? undefined : this.overrides.get(address);
    return { ...OPEN_PREVIEW_ENTITLEMENTS, ...change };
  }
}

// --- the harness ------------------------------------------------------------------------------

export interface DataReply {
  status: number;
  headers: Headers;
  text: string;
  // biome-ignore lint/suspicious/noExplicitAny: a test reads whatever the API sent and then checks it against a schema
  json: any;
}

export interface SendInit {
  key?: string | null;
  cookie?: string | null;
  body?: unknown;
  headers?: Record<string, string>;
  origin?: string | null;
  ip?: string;
}

export interface DataHarness {
  api: Api;
  data: MemoryDataStore;
  chain: FakeDataChain;
  records: FakeRecords;
  entitlements: FakeEntitlements;
  config: DataConfig;
  deps: DataDeps;
  app: { fetch(request: Request): Promise<Response> };
  /** Every request and response of the data API, as text. */
  transcript: string[];
  agentId: string;
  agentOwner: string;
  send(method: string, path: string, init?: SendInit): Promise<DataReply>;
  /** A signed-in session cookie for the wallet. */
  login(wallet: TestWallet): Promise<string>;
  /** A session stored directly, the way a finished sign-in leaves one. Costs no request. */
  seedSession(wallet: TestWallet): Promise<string>;
  /** Creates a key through the site route, as the account page does. Returns the secret. */
  newKey(wallet: TestWallet, label?: string): Promise<{ secret: string; id: string; cookie: string }>;
  /** A call to a keyed endpoint of the registry with valid input. */
  callEndpoint(spec: DataEndpointSpec, key: string): Promise<DataReply>;
  validInput(spec: DataEndpointSpec): Record<string, string>;
  /** Puts a key for the wallet straight into the store, bypassing the routes. Returns the secret. */
  seedKey(owner: string, createdAt?: string): Promise<{ secret: string; id: string }>;
}

/**
 * The data API under test: the real `createDataApp`, over the Phase 1 in-memory store (seeded with
 * one agent that has a tick), the in-memory `DataStore`, and fakes for the chain and the listings.
 * The clock is the one of `createApi` and only the test moves it.
 */
export async function createDataHarness(
  options: {
    config?: Partial<DataConfig>;
    data?: MemoryDataStore;
    /** `ApiConfig.houseOwners`, as the Worker entry hands it to the data handlers. */
    houseOwners?: readonly string[];
  } = {},
): Promise<DataHarness> {
  const api = createApi({ now: '2026-10-06T14:00:00.000Z' });
  const tickAt = utc('2026-10-06T13:00:00.000Z');
  await api.store.createTick(makeTick(tickAt, { daily: true, status: 'complete' }));
  const agent = await api.seedAgent({ n: 1, tickId: tickIdFor(tickAt) });
  const data = options.data ?? new MemoryDataStore();
  const chain = new FakeDataChain();
  const records = new FakeRecords();
  const entitlements = new FakeEntitlements();
  const config: DataConfig = { ...baseConfig, ...options.config };
  const { sim } = await import('@prix/sim');
  const { scoring } = await import('@prix/reputation');
  const deps: DataDeps = {
    ...(options.houseOwners === undefined ? {} : { houseOwners: options.houseOwners }),
    store: api.store,
    data,
    chain,
    records,
    entitlements,
    sim,
    scoring,
    rateLimiter: api.limiter,
    config,
    now: () => api.now(),
  };
  const app = createDataApp(deps);
  const transcript: string[] = [];
  let nextIp = 40;

  const harness: DataHarness = {
    api,
    data,
    chain,
    records,
    entitlements,
    config,
    deps,
    app,
    transcript,
    agentId: agent.id,
    agentOwner: agent.owner,
    async send(method, path, init = {}) {
      const changesState = method !== 'GET' && method !== 'HEAD';
      const headers = new Headers(init.headers);
      nextIp += 1;
      headers.set('CF-Connecting-IP', init.ip ?? `198.51.100.${nextIp % 250}`);
      if (init.key !== undefined && init.key !== null) headers.set('Authorization', `Bearer ${init.key}`);
      if (init.cookie !== undefined && init.cookie !== null) headers.set('Cookie', `${SESSION_COOKIE}=${init.cookie}`);
      const origin = init.origin === undefined ? (changesState ? SITE_ORIGIN : null) : init.origin;
      if (origin !== null) headers.set('Origin', origin);
      if (changesState && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
      const body = init.body === undefined ? undefined : JSON.stringify(init.body);
      const response = await app.fetch(new Request(`${SITE_ORIGIN}${path}`, { method, headers, body }));
      const text = await response.text();
      let json: unknown = null;
      try {
        json = text.length > 0 ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      const headerText = [...response.headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\n');
      transcript.push(`${method} ${path} -> ${response.status}\n${headerText}\n\n${text}`);
      return { status: response.status, headers: response.headers, text, json };
    },
    async login(wallet) {
      const client: Client = await api.signedIn(wallet);
      return client.cookie as string;
    },
    async seedSession(wallet) {
      const token = 'T'.repeat(42) + String(wallet.address.length % 10);
      const now = api.now();
      await api.store.putSession({
        tokenHash: await hashToken(token),
        address: wallet.address,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
      });
      return token;
    },
    async newKey(wallet, label = 'test key') {
      const cookie = await harness.login(wallet);
      const reply = await harness.send('POST', '/api/data/keys', { cookie, body: { label } });
      expect(reply.status, reply.text).toBe(201);
      return { secret: reply.json.secret as string, id: reply.json.key.id as string, cookie };
    },
    validInput(spec): Record<string, string> {
      switch (spec.id) {
        case 'agent':
        case 'agent_decisions':
          return { id: agent.id };
        case 'developer':
        case 'token':
          return { address: OTHER_ADDRESS };
        case 'wallet':
          return { address: agent.owner };
        default:
          return {};
      }
    },
    async callEndpoint(spec, key) {
      const input = harness.validInput(spec);
      let path = `/api/v1${spec.path}`;
      const query = new URLSearchParams();
      for (const [name, value] of Object.entries(input)) {
        if (path.includes(`:${name}`)) path = path.replace(`:${name}`, encodeURIComponent(value));
        else query.set(name, value);
      }
      const qs = query.toString();
      return harness.send('GET', qs === '' ? path : `${path}?${qs}`, { key });
    },
    async seedKey(owner, createdAt = '2026-10-06T10:00:00.000Z') {
      const { id, secret } = generateApiKey();
      const result = await data.createKey(
        {
          id,
          owner,
          keyHash: await hashApiKey(secret),
          prefix: secret.slice(0, 12),
          label: 'seeded',
          createdAt,
          lastUsedDay: null,
          revokedAt: null,
        },
        { maxActive: 100, maxCreatesToday: 100, maxCreatesAllToday: 10_000, dayStart: '2026-10-06T00:00:00.000Z' },
      );
      expect(result).toBe('created');
      return { secret, id };
    },
  };
  return harness;
}

/** The registry rows, so a test file does not import the contract just for the list. */
export const ENDPOINTS = DATA_ENDPOINTS;
export { SEASON_1, testWallet, USDG_ADDRESS };
