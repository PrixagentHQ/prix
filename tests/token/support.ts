import type {
  Address,
  AgentRecord,
  TokenConfig,
  TokenConfigInput,
  TokenConfigOutcome,
  TokenHolder,
  TokenService,
  TokenStore,
} from '@prix/contracts';
import { TIER_RULES } from '@prix/contracts';
import { createTokenChainReader } from '@prix/market/token-balances';
import { encodeTokenResult } from '@prix/market/token-wire';
import { scoring } from '@prix/reputation';
import { createTokenService, resetTokenMemory } from '@prix/runtime/token/service';
import { sim } from '@prix/sim';
import { createApp } from '../../apps/api/src/http/index.ts';
import type { Api, Client as ClientType } from '../support/api.ts';
import { ADMIN_WALLET, Client, createApi, HOUSE_MODEL, NONCE_SECRET, SITE_ORIGIN } from '../support/api.ts';
import type { TestWallet } from '../support/eth.ts';
import { testAddress } from '../support/fixtures.ts';
import type { MemoryStore } from '../support/memory-store.ts';

/**
 * The fakes of the token tests: a chain that answers like the Multicall of Robinhood Chain
 * (built with `encodeTokenResult`, read by the real `createTokenChainReader`), a TokenStore that
 * lives in memory beside the MemoryStore, and the HTTP API wired to the real `createTokenService`.
 * Nothing here touches a network.
 */

export const TOKEN: Address = testAddress(0x70c) as Address;
export const OTHER_TOKEN: Address = testAddress(0xbad) as Address;
export const SUPPLY = 10n ** 27n;
export const DECIMALS = 18;
export const THRESHOLDS: readonly [number, number, number] = [10, 100, 1_000];
export const RPC_URL = 'https://rpc.token-test.invalid';

/** The balance, in base units, of exactly `ppm` parts per million of the supply. */
export function holding(ppm: number, supply: bigint = SUPPLY): bigint {
  return (BigInt(ppm) * supply) / 1_000_000n;
}

/** A balance that puts a wallet in the given tier with the default thresholds and supply. */
export const BALANCE_OF_TIER: Record<0 | 1 | 2 | 3, bigint> = {
  0: 0n,
  1: holding(10),
  2: holding(100),
  3: holding(1_000),
};

export type ChainMode = 'ok' | 'down';

interface ChainCall {
  wallets: string[];
  hasToken: boolean;
}

/** A fake RPC endpoint for one token. The balances are set by the test; anything else reads as 0. */
export class FakeChain {
  readonly balances = new Map<string, bigint>();
  /** Every `eth_call` that arrived, with the wallets asked about. */
  readonly calls: ChainCall[] = [];
  mode: ChainMode = 'ok';
  totalSupply = SUPPLY;

  constructor(readonly token: Address = TOKEN) {}

  setTier(wallet: string, tier: 0 | 1 | 2 | 3): void {
    this.balances.set(wallet.toLowerCase(), BALANCE_OF_TIER[tier]);
  }

  /** Every wallet that was ever sent to the chain, lower case. */
  askedWallets(): Set<string> {
    return new Set(this.calls.flatMap((call) => call.wallets));
  }

  readonly fetch: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body ?? '{}')) as {
      id?: unknown;
      method?: string;
      params?: { data?: string; input?: string }[];
    };
    if (this.mode === 'down') return new Response('unavailable', { status: 503 });
    const params = request.params?.[0] ?? {};
    const data = String(params.data ?? params.input ?? '0x').toLowerCase();
    // The wallets are the arguments of balanceOf(address) calls, in the order they were sent.
    const wallets = [...data.matchAll(/70a08231000000000000000000000000([0-9a-f]{40})/g)].map(
      (match) => `0x${match[1]}`,
    );
    const hasToken = data.includes(this.token.slice(2));
    this.calls.push({ wallets, hasToken });
    const result = encodeTokenResult({
      blockNumber: 1_000n,
      blockTimestamp: BigInt(Math.floor(Date.now() / 1000)),
      // A token the fake does not know reverts on every inner call, as an address with no code would.
      totalSupply: hasToken ? this.totalSupply : null,
      decimals: hasToken ? DECIMALS : null,
      balances: wallets.map((wallet) => (hasToken ? (this.balances.get(wallet) ?? 0n) : null)),
    });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id ?? 1, result }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

interface HolderEntry {
  row: TokenHolder;
  dirty: boolean;
}

function defaultConfig(): TokenConfig {
  return {
    enabled: false,
    tokenAddress: null,
    thresholdsPpm: [...THRESHOLDS],
    buyUrl: null,
    activatedAt: null,
    updatedAt: '2026-10-06T00:00:00.000Z',
    updatedBy: 'migration',
  };
}

/**
 * The TokenStore of the contract in memory. It mirrors the SQL of apps/api/src/store/token.ts:
 * a new holder or a holder whose slots changed is dirty; `applySlots` numbers each dirty owner's
 * agents by creation, pauses the active ones beyond the slots with `slot_limit`, resumes the
 * `slot_limit` ones that fit, and never touches an agent paused for another reason.
 */
export class MemoryTokenStore implements TokenStore {
  config: TokenConfig = defaultConfig();
  readonly holders = new Map<string, HolderEntry>();
  /** Counts of the writing methods, so a test can say "nothing was written". */
  writes = { putConfig: 0, putHolders: 0, applySlots: 0 };

  constructor(private readonly store: MemoryStore) {}

  async getConfig(): Promise<TokenConfig> {
    return structuredClone(this.config);
  }

  async putConfig(input: TokenConfigInput, now: string, by: string): Promise<TokenConfigOutcome> {
    this.writes.putConfig += 1;
    const current = this.config;
    if (current.activatedAt !== null) {
      const raised = input.thresholdsPpm.some((value, index) => value > (current.thresholdsPpm[index] ?? 0));
      if (input.tokenAddress !== current.tokenAddress || raised) return { kind: 'locked' };
    }
    this.config = {
      enabled: input.enabled,
      tokenAddress: input.tokenAddress,
      thresholdsPpm: input.thresholdsPpm,
      buyUrl: input.buyUrl,
      activatedAt: current.activatedAt ?? (input.enabled ? now : null),
      updatedAt: now,
      updatedBy: by,
    };
    if (!input.enabled) await this.releaseSlotPauses(now);
    return { kind: 'saved', config: structuredClone(this.config) };
  }

  async getHolder(address: Address, token: Address): Promise<TokenHolder | null> {
    const entry = this.holders.get(address);
    return entry === undefined || entry.row.tokenAddress !== token ? null : { ...entry.row };
  }

  async getHolders(addresses: readonly Address[], token: Address): Promise<TokenHolder[]> {
    return addresses.flatMap((address) => {
      const entry = this.holders.get(address);
      return entry === undefined || entry.row.tokenAddress !== token ? [] : [{ ...entry.row }];
    });
  }

  async putHolders(rows: readonly TokenHolder[]): Promise<void> {
    this.writes.putHolders += 1;
    for (const row of rows) {
      const old = this.holders.get(row.address);
      const dirty = old === undefined || old.dirty || old.row.maxAgents !== row.maxAgents;
      this.holders.set(row.address, { row: { ...row }, dirty });
    }
  }

  async listDueHolders(token: Address, checkedBefore: string, limit: number): Promise<Address[]> {
    return [...this.holders.values()]
      .filter(({ row }) => row.tier > 0 && row.tokenAddress === token && row.checkedAt < checkedBefore)
      .sort((a, b) => a.row.checkedAt.localeCompare(b.row.checkedAt) || a.row.address.localeCompare(b.row.address))
      .slice(0, limit)
      .map(({ row }) => row.address);
  }

  async applySlots(now: string): Promise<{ paused: number; resumed: number }> {
    this.writes.applySlots += 1;
    let paused = 0;
    let resumed = 0;
    for (const entry of this.holders.values()) {
      if (!entry.dirty) continue;
      const owned = [...this.store.agents.values()]
        .filter((agent) => agent.owner === entry.row.address)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      owned.forEach((agent, index) => {
        const withinSlots = index + 1 <= entry.row.maxAgents;
        if (!withinSlots && agent.status === 'active') {
          this.store.agents.set(agent.id, {
            ...agent,
            status: 'paused',
            pausedReason: 'slot_limit',
            updatedAt: now,
          });
          paused += 1;
        } else if (withinSlots && agent.pausedReason === 'slot_limit') {
          this.store.agents.set(agent.id, {
            ...agent,
            status: 'active',
            pausedReason: null,
            strategyChangedAt: now,
            updatedAt: now,
          });
          resumed += 1;
        }
      });
      entry.dirty = false;
    }
    return { paused, resumed };
  }

  async releaseSlotPauses(now: string): Promise<number> {
    let count = 0;
    for (const agent of this.store.agents.values()) {
      if (agent.pausedReason !== 'slot_limit') continue;
      this.store.agents.set(agent.id, {
        ...agent,
        status: 'active',
        pausedReason: null,
        strategyChangedAt: now,
        updatedAt: now,
      });
      count += 1;
    }
    return count;
  }

  async countOwnerAgents(owner: Address): Promise<{ total: number; pausedForSlots: number }> {
    const owned = [...this.store.agents.values()].filter((agent) => agent.owner === owner);
    return { total: owned.length, pausedForSlots: owned.filter((agent) => agent.pausedReason === 'slot_limit').length };
  }
}

export interface TokenHarness {
  api: Api;
  store: MemoryStore;
  tokenStore: MemoryTokenStore;
  chain: FakeChain;
  service: TokenService;
  /** A client for the API with the token routes mounted and the token service as the entitlements. */
  client(): ClientType;
  /** A client signed in with `wallet`. */
  signedIn(wallet: TestWallet): Promise<ClientType>;
  /** Moves the shared clock of the API, the service and the store. */
  advanceSeconds(seconds: number): void;
  /** Gives a wallet the tier on the chain and through the rise rule: two reads more than an hour apart. */
  grant(wallet: TestWallet, tier: 0 | 1 | 2 | 3): Promise<void>;
  /** Writes the configuration straight into the store, as another isolate would. */
  configure(input: Partial<TokenConfigInput>): Promise<void>;
  agentsOf(owner: string): AgentRecord[];
}

/** Builds the API with the real token service on top of the fakes. Memory of the isolate is cleared. */
export function createTokenHarness(): TokenHarness {
  resetTokenMemory();
  const base = createApi();
  const store = base.store;
  const tokenStore = new MemoryTokenStore(store);
  const chain = new FakeChain();
  const service = createTokenService({
    store: tokenStore,
    chain: createTokenChainReader([RPC_URL], chain.fetch),
    now: () => base.now(),
  });
  const app = createApp(
    {
      store,
      sim,
      scoring,
      sealer: base.vault.sealer,
      rateLimiter: base.limiter,
      config: {
        siteOrigin: SITE_ORIGIN,
        adminAddresses: [ADMIN_WALLET.address],
        houseModel: HOUSE_MODEL,
        nonceSecret: NONCE_SECRET,
      },
      now: () => base.now(),
      entitlements: service,
    },
    { token: { service } },
  );
  const api: Api = { ...base, app };
  let nextIp = 100;
  api.client = (ip) => {
    nextIp += 1;
    return new Client(api, ip ?? `198.51.100.${nextIp}`);
  };
  api.signedIn = async (wallet) => {
    const client = api.client();
    const reply = await client.signIn(wallet);
    if (reply.status !== 200) throw new Error(`sign-in failed: ${reply.text}`);
    return client;
  };
  return {
    api,
    store,
    tokenStore,
    chain,
    service,
    client: () => api.client(),
    signedIn: (wallet) => api.signedIn(wallet),
    advanceSeconds: (seconds) => base.advance(seconds * 1000),
    async grant(wallet, tier) {
      chain.setTier(wallet.address, tier);
      await service.entitlementsFor(wallet.address as Address);
      base.advance(61 * 60 * 1000);
      await service.entitlementsFor(wallet.address as Address);
      chain.calls.length = 0;
    },
    async configure(input) {
      const current = tokenStore.config;
      const next: TokenConfigInput = {
        enabled: input.enabled ?? current.enabled,
        tokenAddress: input.tokenAddress === undefined ? current.tokenAddress : input.tokenAddress,
        thresholdsPpm: input.thresholdsPpm ?? current.thresholdsPpm,
        buyUrl: input.buyUrl === undefined ? current.buyUrl : input.buyUrl,
      };
      const outcome = await tokenStore.putConfig(next, base.now().toISOString(), 'test');
      if (outcome.kind !== 'saved') throw new Error('the test configuration was refused');
    },
    agentsOf: (owner) =>
      [...store.agents.values()]
        .filter((agent) => agent.owner === owner)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
  };
}

/** The tier table has these slots; a test that hard-codes a number checks it against the contract here. */
export const SLOTS: Record<0 | 1 | 2 | 3, number> = {
  0: TIER_RULES[0]?.maxAgents ?? 0,
  1: TIER_RULES[1]?.maxAgents ?? 0,
  2: TIER_RULES[2]?.maxAgents ?? 0,
  3: TIER_RULES[3]?.maxAgents ?? 0,
};
