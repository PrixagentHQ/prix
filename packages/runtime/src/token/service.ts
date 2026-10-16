import {
  type Address,
  computeTier,
  type Entitlements,
  type EntitlementsReadOptions,
  entitlementsOfTier,
  FEED_DELAY_SECONDS,
  holdingPpm,
  type IsoTime,
  LOUNGE_SWEEP_CHECKS_PER_RUN,
  OPEN_PREVIEW_ENTITLEMENTS,
  type SaveConfigResult,
  type Tier,
  TOKEN_CACHE_SECONDS,
  TOKEN_CONFIG_CACHE_SECONDS,
  TOKEN_EXPLORER_URL_PREFIX,
  TOKEN_REFRESH_MIN_SECONDS,
  TOKEN_RISE_HOLD_SECONDS,
  TOKEN_STALE_GRACE_SECONDS,
  TOKEN_SWEEP_BATCH,
  TOKEN_SWEEP_DUE_SECONDS,
  type TokenChainReader,
  type TokenConfig,
  type TokenConfigInput,
  type TokenHolder,
  type TokenInfoResponse,
  type TokenMeResponse,
  type TokenProbeResponse,
  TokenReadError,
  type TokenService,
  type TokenStepReport,
  type TokenStore,
  tierTable,
} from '@prix/contracts';

export interface TokenServiceDeps {
  store: TokenStore;
  chain: TokenChainReader;
  now(): Date;
  log?(event: string, data: Record<string, string | number | boolean | null>): void;
}

const WALLET_MEMORY_SECONDS = 30;
const WALLET_MEMORY_MAX = 500;
/** A tier 0 wallet with no stored row is kept in memory this long instead of being written. */
const UNSTORED_MEMORY_SECONDS = 900;
/** A stored tier 0 row is refreshed on demand only after this long (the holder can press refresh). */
const TIER0_STORED_SECONDS = 6 * 3600;
/** On-demand chain reads per isolate per UTC day; when spent, answers come from the stored row or tier 0. */
const ON_DEMAND_READS_PER_DAY = 3000;

/** What `holdingOf` answers: `tier` and `checkedAt` are always set (Phase 6.8). */
interface Holding {
  gatingOn: boolean;
  tokens: number;
  tier: Tier;
  checkedAt: IsoTime | null;
}

/** What `refreshHolders` answers for each wallet it read. */
interface RefreshedHolder {
  tier: Tier;
  tokenAddress: Address;
  checkedAt: IsoTime;
}

interface WalletMemory {
  tier: Tier;
  token: Address;
  at: number;
  ttl: number;
  row?: TokenHolder;
}

// Memory of one Worker isolate, shared by every service built in it.
let configMemory: { value: TokenConfig; at: number } | null = null;
const walletMemory = new Map<string, WalletMemory>();
const inFlight = new Map<string, Promise<TokenHolder>>();
let onDemand = { day: '', count: 0 };

/** For tests: clears the isolate's configuration and wallet memory. */
export function resetTokenMemory(): void {
  configMemory = null;
  walletMemory.clear();
  inFlight.clear();
  onDemand = { day: '', count: 0 };
}

function ageSeconds(iso: string, nowMs: number): number {
  return (nowMs - Date.parse(iso)) / 1000;
}

/**
 * The tier a wallet is granted from one read (finding 12). A fall applies at once. A rise waits
 * until two reads at least TOKEN_RISE_HOLD_SECONDS apart both show it, and then grants the lower
 * of what they showed, so a holding passed on to the next wallet never gives the tier within the hour.
 */
export function settleTier(
  previous: TokenHolder | null,
  readTier: Tier,
  now: Date,
): { tier: Tier; riseTier: Tier | null; riseSince: string | null } {
  const held: Tier = previous?.tier ?? 0;
  if (readTier <= held) return { tier: readTier, riseTier: null, riseSince: null };
  const since = previous?.riseSince ?? null;
  const pending: Tier = previous?.riseTier ?? readTier;
  if (since !== null && (now.getTime() - Date.parse(since)) / 1000 >= TOKEN_RISE_HOLD_SECONDS) {
    const granted = Math.max(held, Math.min(readTier, pending)) as Tier;
    return granted < readTier
      ? { tier: granted, riseTier: readTier, riseSince: now.toISOString() }
      : { tier: granted, riseTier: null, riseSince: null };
  }
  return {
    tier: held,
    riseTier: since === null ? readTier : (Math.min(pending, readTier) as Tier),
    riseSince: since ?? now.toISOString(),
  };
}

const MAX_WHOLE_TOKENS = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * The whole tokens of one read: base units divided by ten to the token's decimals, rounded down and
 * capped at Number.MAX_SAFE_INTEGER. A balance or decimals that are not plain numbers count as 0.
 */
export function wholeTokens(balance: string, decimals: number): number {
  if (!/^\d{1,78}$/.test(balance) || !Number.isInteger(decimals) || decimals < 0 || decimals > 77) return 0;
  const whole = BigInt(balance) / 10n ** BigInt(decimals);
  return whole > MAX_WHOLE_TOKENS ? Number.MAX_SAFE_INTEGER : Number(whole);
}

function errorCode(error: unknown): string {
  return error instanceof TokenReadError ? error.code : 'error';
}

export function createTokenService(deps: TokenServiceDeps): TokenService {
  const { store, chain } = deps;
  const nowMs = (): number => deps.now().getTime();
  const nowIso = (): string => deps.now().toISOString();
  const log = (event: string, data: Record<string, string | number | boolean | null>): void => {
    deps.log?.(event, data);
  };

  async function getConfig(): Promise<TokenConfig> {
    const now = nowMs();
    if (configMemory !== null && (now - configMemory.at) / 1000 < TOKEN_CONFIG_CACHE_SECONDS) {
      return configMemory.value;
    }
    const value = await store.getConfig();
    configMemory = { value, at: now };
    return value;
  }

  /** Takes one on-demand read from the day's budget; false when it is spent. */
  function takeOnDemand(): boolean {
    const day = nowIso().slice(0, 10);
    if (onDemand.day !== day) onDemand = { day, count: 0 };
    if (onDemand.count >= ON_DEMAND_READS_PER_DAY) return false;
    onDemand.count += 1;
    return true;
  }

  function remember(address: string, tier: Tier, token: Address, ttl = WALLET_MEMORY_SECONDS, row?: TokenHolder): void {
    walletMemory.delete(address);
    walletMemory.set(
      address,
      row === undefined ? { tier, token, at: nowMs(), ttl } : { tier, token, at: nowMs(), ttl, row },
    );
    while (walletMemory.size > WALLET_MEMORY_MAX) {
      const oldest = walletMemory.keys().next();
      if (oldest.done === true) break;
      walletMemory.delete(oldest.value);
    }
  }

  /** One chain read for one wallet, stored; slots are matched only when they changed. In-flight reads share a promise. */
  function readAndStore(
    config: TokenConfig,
    token: Address,
    address: Address,
    previous: TokenHolder | null,
  ): Promise<TokenHolder> {
    const key = `${token}:${address}`;
    const existing = inFlight.get(key);
    if (existing !== undefined) return existing;
    const run = (async (): Promise<TokenHolder> => {
      const read = await chain.readBalances(token, [address]);
      const balance = read.balances[0];
      if (balance === undefined) throw new TokenReadError('invalid_answer');
      const readTier = computeTier(balance, read.totalSupply, config.thresholdsPpm);
      const settled = settleTier(previous, readTier, deps.now());
      const tier = settled.tier;
      const maxAgents = entitlementsOfTier(tier).maxAgents;
      const row: TokenHolder = {
        address,
        balance: balance.toString(),
        totalSupply: read.totalSupply.toString(),
        decimals: read.decimals,
        tier,
        maxAgents,
        tokenAddress: token,
        checkedAt: nowIso(),
        riseTier: settled.riseTier,
        riseSince: settled.riseSince,
      };
      if (tier === 0 && previous === null && readTier === 0 && wholeTokens(row.balance, row.decimals) < 1) {
        // No row for a wallet that holds less than one whole token: memory only, so throwaway wallets cost
        // no D1 rows. One whole token is stored: `holdingOf` with `cachedOnly` finds it in any isolate.
        remember(address, tier, token, UNSTORED_MEMORY_SECONDS, row);
        return row;
      }
      await store.putHolders([row]);
      remember(address, tier, token);
      if (maxAgents !== (previous?.maxAgents ?? 1)) await store.applySlots(nowIso());
      return row;
    })();
    inFlight.set(key, run);
    const clear = (): void => {
      inFlight.delete(key);
    };
    run.then(clear, clear);
    return run;
  }

  async function entitlementsFor(address: Address | null, options?: EntitlementsReadOptions): Promise<Entitlements> {
    const config = await getConfig();
    const token = config.tokenAddress;
    if (!config.enabled || token === null) return OPEN_PREVIEW_ENTITLEMENTS;
    if (address === null) return entitlementsOfTier(0);
    const wallet = address.toLowerCase() as Address;
    const now = nowMs();
    const mem = walletMemory.get(wallet);
    if (mem !== undefined && mem.token === token && (now - mem.at) / 1000 < mem.ttl) {
      return entitlementsOfTier(mem.tier);
    }
    const row = await store.getHolder(wallet, token);
    const freshSeconds =
      row !== null && row.tier === 0 && (row.riseSince ?? null) === null ? TIER0_STORED_SECONDS : TOKEN_CACHE_SECONDS;
    if (row !== null && ageSeconds(row.checkedAt, now) < freshSeconds) {
      remember(wallet, row.tier, token);
      return entitlementsOfTier(row.tier);
    }
    const usable = row !== null && ageSeconds(row.checkedAt, now) < TOKEN_STALE_GRACE_SECONDS;
    if (options?.cachedOnly === true) return entitlementsOfTier(usable ? row.tier : 0);
    if (!takeOnDemand()) {
      log('token_on_demand_spent', {});
      return entitlementsOfTier(usable ? row.tier : 0);
    }
    try {
      const fresh = await readAndStore(config, token, wallet, row);
      return entitlementsOfTier(fresh.tier);
    } catch (error) {
      log('token_read_failed', { code: errorCode(error) });
      const tier: Tier = usable ? row.tier : 0;
      remember(wallet, tier, token);
      return entitlementsOfTier(tier);
    }
  }

  /**
   * A wallet's holding in whole tokens, from its stored row and never from a request (the room asks it).
   * No tier is asked of `entitlementsFor` and the hold before a tier rises does not apply to `tokens`: the
   * row's balance counts as read. A read it makes goes through `readAndStore`, so the wallet's tier row is
   * settled by the same read.
   *
   * Phase 6.8 (docs/contracts/phase-6-holders-2.md 2.2 and 4.4 step 5): `tier` is the tier column of the
   * row `tokens` came from (the settled tier, so the hour before a rise holds), and `checkedAt` that row's
   * read time; tier 0 and null when the answer rests on no row. The memory-only read under one whole token
   * answers tier 0 and the time of that read.
   */
  async function holdingOf(address: Address, options?: EntitlementsReadOptions): Promise<Holding> {
    const config = await getConfig();
    const token = config.tokenAddress;
    if (!config.enabled || token === null) return { gatingOn: false, tokens: 0, tier: 0, checkedAt: null };
    const wallet = address.toLowerCase() as Address;
    const now = nowMs();
    const row = await store.getHolder(wallet, token);
    const answer = (held: TokenHolder | null): Holding => ({
      gatingOn: true,
      tokens: held === null ? 0 : wholeTokens(held.balance, held.decimals),
      tier: held === null ? 0 : held.tier,
      checkedAt: held === null ? null : held.checkedAt,
    });
    const usable = row !== null && ageSeconds(row.checkedAt, now) < TOKEN_STALE_GRACE_SECONDS ? row : null;
    if (options?.cachedOnly === true) return answer(usable);
    if (row !== null && ageSeconds(row.checkedAt, now) < TOKEN_CACHE_SECONDS) return answer(row);
    if (row === null) {
      // A read this isolate made within the cache time and did not store: less than one whole token.
      const memory = walletMemory.get(wallet);
      if (memory?.row !== undefined && memory.token === token && (now - memory.at) / 1000 < memory.ttl) {
        return answer(memory.row);
      }
    }
    if (!takeOnDemand()) {
      log('token_on_demand_spent', {});
      return answer(usable);
    }
    try {
      return answer(await readAndStore(config, token, wallet, row));
    } catch (error) {
      log('token_read_failed', { code: errorCode(error) });
      return answer(usable);
    }
  }

  /**
   * Phase 6.8, revision 3 (security H1; docs/contracts/phase-6-holders-2.md 4.6 step 3): the lounge sweep's
   * read of its members' wallets again, through the token sweep's own path. At most
   * LOUNGE_SWEEP_CHECKS_PER_RUN distinct wallets in lower case: one chain read (one subrequest), one read of
   * their previous rows and one batch that stores them (two D1 statements), with the tier `settleTier` gives,
   * so the hour before a rise holds and a fall applies at once. A wallet with no row that holds less than one
   * whole token and reads tier 0 is answered but not stored, as `readAndStore` leaves it. It calls no
   * `applySlots`: a row whose slots changed is marked dirty by `putHolders`, and the next token sweep's
   * `applySlots` matches it. The isolate's memory of every wallet it read is dropped, so the next
   * `entitlementsFor` reads the new row. Null while the gate is off, and null with nothing written when the
   * read or the store fails; the log line carries a code and nothing else.
   */
  async function refreshHolders(
    wallets: readonly Address[],
    now: Date,
  ): Promise<ReadonlyMap<Address, RefreshedHolder> | null> {
    const config = await getConfig();
    const token = config.tokenAddress;
    if (!config.enabled || token === null) return null;
    const asked = [...new Set(wallets.map((wallet) => wallet.toLowerCase() as Address))].slice(
      0,
      LOUNGE_SWEEP_CHECKS_PER_RUN,
    );
    const answers = new Map<Address, RefreshedHolder>();
    if (asked.length === 0) return answers;
    try {
      const read = await chain.readBalances(token, asked);
      if (read.balances.length !== asked.length) throw new TokenReadError('invalid_answer');
      const previousRows = new Map((await store.getHolders(asked, token)).map((held) => [held.address, held]));
      const checkedAt = now.toISOString();
      const rows: TokenHolder[] = [];
      asked.forEach((address, index) => {
        const balance = read.balances[index];
        if (balance === undefined) throw new TokenReadError('invalid_answer');
        const previous = previousRows.get(address) ?? null;
        const readTier = computeTier(balance, read.totalSupply, config.thresholdsPpm);
        const settled = settleTier(previous, readTier, now);
        answers.set(address, { tier: settled.tier, tokenAddress: token, checkedAt });
        const unstored =
          previous === null &&
          settled.tier === 0 &&
          readTier === 0 &&
          wholeTokens(balance.toString(), read.decimals) < 1;
        if (unstored) return;
        rows.push({
          address,
          balance: balance.toString(),
          totalSupply: read.totalSupply.toString(),
          decimals: read.decimals,
          tier: settled.tier,
          maxAgents: entitlementsOfTier(settled.tier).maxAgents,
          tokenAddress: token,
          checkedAt,
          riseTier: settled.riseTier,
          riseSince: settled.riseSince,
        });
      });
      if (rows.length > 0) await store.putHolders(rows);
      for (const address of asked) walletMemory.delete(address);
      return answers;
    } catch (error) {
      log('token_refresh_failed', { code: errorCode(error) });
      return null;
    }
  }

  async function info(): Promise<TokenInfoResponse> {
    const config = await getConfig();
    const token = config.tokenAddress;
    return {
      gatingOn: config.enabled && token !== null,
      tokenAddress: token,
      explorerUrl: token === null ? null : `${TOKEN_EXPLORER_URL_PREFIX}${token}`,
      buyUrl: token === null ? null : config.buyUrl,
      tiers: tierTable(config.thresholdsPpm),
      feedDelaySeconds: FEED_DELAY_SECONDS,
    };
  }

  async function statusOf(address: Address, refresh: boolean): Promise<TokenMeResponse | 'too_soon'> {
    const config = await getConfig();
    const token = config.tokenAddress;
    const wallet = address.toLowerCase() as Address;
    const counts = await store.countOwnerAgents(wallet);
    if (!config.enabled || token === null) {
      return {
        gatingOn: false,
        tokenAddress: token,
        tier: 0,
        entitlements: OPEN_PREVIEW_ENTITLEMENTS,
        balance: null,
        totalSupply: null,
        decimals: null,
        holdingPpm: null,
        nextTier: null,
        slots: {
          used: counts.total,
          max: OPEN_PREVIEW_ENTITLEMENTS.maxAgents,
          pausedForSlots: counts.pausedForSlots,
        },
        checkedAt: null,
        stale: false,
      };
    }
    const now = nowMs();
    let row = await store.getHolder(wallet, token);
    const memory = walletMemory.get(wallet);
    if (
      row === null &&
      !refresh &&
      memory?.row !== undefined &&
      memory.token === token &&
      (now - memory.at) / 1000 < memory.ttl
    ) {
      row = memory.row;
    }
    if (refresh && row !== null && ageSeconds(row.checkedAt, now) < TOKEN_REFRESH_MIN_SECONDS) return 'too_soon';
    let stale = false;
    const freshSeconds = row !== null && row.tier === 0 && !refresh ? TIER0_STORED_SECONDS : TOKEN_CACHE_SECONDS;
    const unstored = row !== null && memory?.row === row;
    if (refresh || row === null || (!unstored && ageSeconds(row.checkedAt, now) >= freshSeconds)) {
      if (!refresh && !takeOnDemand()) {
        log('token_on_demand_spent', {});
        stale = true;
        if (row !== null && ageSeconds(row.checkedAt, now) >= TOKEN_STALE_GRACE_SECONDS) row = null;
      } else
        try {
          row = await readAndStore(config, token, wallet, row);
        } catch (error) {
          log('token_read_failed', { code: errorCode(error) });
          stale = true;
          if (row !== null && ageSeconds(row.checkedAt, now) >= TOKEN_STALE_GRACE_SECONDS) row = null;
        }
    }
    const tier: Tier = row?.tier ?? 0;
    const entitlements = entitlementsOfTier(tier);
    const ppm = row === null ? null : holdingPpm(BigInt(row.balance), BigInt(row.totalSupply));
    const nextThreshold = tier === 3 ? undefined : config.thresholdsPpm[tier];
    const nextTier =
      nextThreshold === undefined || ppm === null
        ? null
        : { tier: (tier + 1) as Tier, thresholdPpm: nextThreshold, missingPpm: Math.max(1, nextThreshold - ppm) };
    return {
      gatingOn: true,
      tokenAddress: token,
      tier,
      entitlements,
      balance: row?.balance ?? null,
      totalSupply: row?.totalSupply ?? null,
      decimals: row?.decimals ?? null,
      holdingPpm: ppm,
      nextTier,
      slots: { used: counts.total, max: entitlements.maxAgents, pausedForSlots: counts.pausedForSlots },
      checkedAt: row?.checkedAt ?? null,
      stale,
    };
  }

  async function probe(wallet: Address): Promise<TokenProbeResponse> {
    const config = await store.getConfig();
    const token = config.tokenAddress;
    if (token === null) throw new TokenReadError('invalid_token');
    const lower = wallet.toLowerCase() as Address;
    const read = await chain.readBalances(token, [lower]);
    const balance = read.balances[0];
    if (balance === undefined) throw new TokenReadError('invalid_answer');
    return {
      wallet: lower,
      tokenAddress: token,
      tier: computeTier(balance, read.totalSupply, config.thresholdsPpm),
      balance: balance.toString(),
      totalSupply: read.totalSupply.toString(),
      decimals: read.decimals,
      holdingPpm: holdingPpm(balance, read.totalSupply),
      blockNumber: Number(read.blockNumber),
      readAt: nowIso(),
    };
  }

  async function saveConfig(input: TokenConfigInput, by: Address): Promise<SaveConfigResult> {
    const current = await store.getConfig();
    const addressChanged = input.tokenAddress !== current.tokenAddress;
    if (addressChanged && input.tokenAddress !== null) {
      try {
        // The token's own address as the wallet: any address proves totalSupply and decimals answer.
        await chain.readBalances(input.tokenAddress, [input.tokenAddress]);
      } catch (error) {
        const code = errorCode(error);
        log('token_verify_failed', { code });
        return {
          ok: false,
          reason: code === 'invalid_token' || code === 'invalid_answer' ? 'token_invalid' : 'chain_unavailable',
        };
      }
    }
    if (current.activatedAt !== null) {
      if (addressChanged) return { ok: false, reason: 'address_locked' };
      if (input.thresholdsPpm.some((value, index) => value > (current.thresholdsPpm[index] ?? 0))) {
        return { ok: false, reason: 'thresholds_locked' };
      }
    }
    const outcome = await store.putConfig(input, nowIso(), by);
    resetTokenMemory();
    if (outcome.kind === 'locked')
      return { ok: false, reason: addressChanged ? 'address_locked' : 'thresholds_locked' };
    return { ok: true, config: outcome.config };
  }

  async function sweep(now: Date): Promise<TokenStepReport> {
    const report: TokenStepReport = { action: 'off', read: 0, paused: 0, resumed: 0 };
    try {
      const config = await store.getConfig();
      const token = config.tokenAddress;
      if (!config.enabled || token === null) return report;
      const due = await store.listDueHolders(
        token,
        new Date(now.getTime() - TOKEN_SWEEP_DUE_SECONDS * 1000).toISOString(),
        TOKEN_SWEEP_BATCH,
      );
      if (due.length === 0) return { ...report, action: 'idle' };
      const read = await chain.readBalances(token, due);
      const checkedAt = now.toISOString();
      const previousRows = new Map((await store.getHolders(due, token)).map((held) => [held.address, held]));
      const rows: TokenHolder[] = due.map((address, index) => {
        const balance = read.balances[index];
        if (balance === undefined) throw new TokenReadError('invalid_answer');
        const settled = settleTier(
          previousRows.get(address) ?? null,
          computeTier(balance, read.totalSupply, config.thresholdsPpm),
          now,
        );
        const tier = settled.tier;
        return {
          address,
          balance: balance.toString(),
          totalSupply: read.totalSupply.toString(),
          decimals: read.decimals,
          tier,
          maxAgents: entitlementsOfTier(tier).maxAgents,
          tokenAddress: token,
          checkedAt,
          riseTier: settled.riseTier,
          riseSince: settled.riseSince,
        };
      });
      await store.putHolders(rows);
      // The store marks a row dirty only when its slots changed, and the due list carries no old
      // values, so one applySlots batch runs after every successful sweep (cheap when nothing is dirty).
      const applied = await store.applySlots(checkedAt);
      walletMemory.clear();
      return { action: 'swept', read: rows.length, paused: applied.paused, resumed: applied.resumed };
    } catch (error) {
      log('token_sweep_failed', { code: errorCode(error) });
      return { ...report, action: 'failed' };
    }
  }

  return { entitlementsFor, holdingOf, refreshHolders, getConfig, info, statusOf, probe, saveConfig, sweep };
}
