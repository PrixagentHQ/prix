import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';
import type {
  Address,
  Tier,
  TokenConfig,
  TokenConfigInput,
  TokenConfigOutcome,
  TokenHolder,
  TokenStore,
} from '@prix/contracts';
import { TOKEN_UPSERT_ROWS_PER_STATEMENT } from '@prix/contracts';

/**
 * The D1 implementation of `TokenStore`. The schema is infra/migrations/0004_token.sql and this
 * file is the only code that writes the token tables or touches agents for slots
 * (docs/contracts/phase-4-token.md section 6, rules 7 and 8).
 */

type Bound = string | number | null;

interface ConfigRow {
  enabled: number;
  token_address: string | null;
  threshold_1_ppm: number;
  threshold_2_ppm: number;
  threshold_3_ppm: number;
  buy_url: string | null;
  activated_at: string | null;
  updated_at: string;
  updated_by: string;
}

interface HolderRow {
  address: string;
  balance: string;
  total_supply: string;
  decimals: number;
  tier: number;
  max_agents: number;
  token_address: string;
  checked_at: string;
  rise_tier: number | null;
  rise_since: string | null;
}

const CONFIG_SELECT =
  'enabled, token_address, threshold_1_ppm, threshold_2_ppm, threshold_3_ppm, buy_url, activated_at, updated_at, updated_by';

const GET_CONFIG = `SELECT ${CONFIG_SELECT} FROM token_config WHERE id = 1`;

/** ?1 enabled, ?2 address, ?3..?5 thresholds, ?6 buy url, ?7 now, ?8 by. The trigger aborts a locked change. */
const PUT_CONFIG = `
UPDATE token_config SET
  enabled = ?1,
  token_address = ?2,
  threshold_1_ppm = ?3,
  threshold_2_ppm = ?4,
  threshold_3_ppm = ?5,
  buy_url = ?6,
  activated_at = CASE WHEN activated_at IS NULL AND ?1 = 1 THEN ?7 ELSE activated_at END,
  updated_at = ?7,
  updated_by = ?8
WHERE id = 1`;

/** ?1 now. Resumes every agent paused for slots, but only while gating is off (the same batch as the config write). */
const RELEASE_IF_OFF = `
UPDATE agents INDEXED BY agents_slot_paused
SET status = 'active', paused_reason = NULL, strategy_changed_at = ?1, updated_at = ?1
WHERE paused_reason = 'slot_limit' AND (SELECT enabled FROM token_config WHERE id = 1) = 0`;

/** ?1 now. */
const RELEASE_ALL = `
UPDATE agents INDEXED BY agents_slot_paused
SET status = 'active', paused_reason = NULL, strategy_changed_at = ?1, updated_at = ?1
WHERE paused_reason = 'slot_limit'
RETURNING id`;

const GET_HOLDER = `
SELECT address, balance, total_supply, decimals, tier, max_agents, token_address, checked_at, rise_tier, rise_since
FROM token_holders WHERE address = ?1 AND token_address = ?2`;

/** ?1 token, ?2 checked before, ?3 limit. Index token_holders_due. */
const LIST_DUE = `
SELECT address FROM token_holders INDEXED BY token_holders_due
WHERE tier > 0 AND checked_at < ?2 AND token_address = ?1
ORDER BY checked_at, address LIMIT ?3`;

/**
 * Each agent of a dirty owner, numbered in creation order, with the owner's slots. The window
 * covers every agent of the owner, so an agent paused for another reason keeps its number.
 * ?1 is now in the two UPDATEs below.
 */
const NUMBERED = `
SELECT id, status, paused_reason, rn, max_agents FROM (
  SELECT a.id AS id, a.status AS status, a.paused_reason AS paused_reason,
         h.max_agents AS max_agents,
         ROW_NUMBER() OVER (PARTITION BY a.owner ORDER BY a.created_at, a.id) AS rn
  FROM token_holders h INDEXED BY token_holders_dirty
  CROSS JOIN agents a INDEXED BY agents_owner_created
  WHERE h.slots_dirty = 1 AND a.owner = h.address
)`;

/** The same numbering for every holder, not only dirty ones: an owner who resumed agents by hand is caught too. */
const NUMBERED_ALL = NUMBERED.replace(' INDEXED BY token_holders_dirty', '').replace('h.slots_dirty = 1 AND ', '');

const PAUSE_BEYOND = `
UPDATE agents
SET status = 'paused', paused_reason = 'slot_limit', updated_at = ?1
WHERE status = 'active' AND id IN (SELECT id FROM (${NUMBERED_ALL}) WHERE rn > max_agents AND status = 'active')
RETURNING id`;

const RESUME_FITTING = `
UPDATE agents
SET status = 'active', paused_reason = NULL, strategy_changed_at = ?1, updated_at = ?1
WHERE paused_reason = 'slot_limit'
  AND id IN (SELECT id FROM (${NUMBERED}) WHERE rn <= max_agents AND paused_reason = 'slot_limit')
RETURNING id`;

const CLEAR_DIRTY = 'UPDATE token_holders INDEXED BY token_holders_dirty SET slots_dirty = 0 WHERE slots_dirty = 1';

const COUNT_OWNER = `
SELECT count(*) AS total,
       coalesce(sum(CASE WHEN paused_reason = 'slot_limit' THEN 1 ELSE 0 END), 0) AS paused_for_slots
FROM agents INDEXED BY agents_owner_created WHERE owner = ?1`;

const HOLDER_COLUMNS =
  'address, balance, total_supply, decimals, tier, max_agents, token_address, checked_at, rise_tier, rise_since, slots_dirty';
const ROW_PLACEHOLDERS = '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)';

/** A multi-row upsert of `count` rows. A new row, or one whose slots changed, is marked dirty. */
function upsertHolders(count: number): string {
  const values = Array.from({ length: count }, () => ROW_PLACEHOLDERS).join(', ');
  return `
INSERT INTO token_holders (${HOLDER_COLUMNS}) VALUES ${values}
ON CONFLICT (address) DO UPDATE SET
  balance = excluded.balance,
  total_supply = excluded.total_supply,
  decimals = excluded.decimals,
  tier = excluded.tier,
  token_address = excluded.token_address,
  checked_at = excluded.checked_at,
  rise_tier = excluded.rise_tier,
  rise_since = excluded.rise_since,
  slots_dirty = CASE WHEN token_holders.max_agents <> excluded.max_agents THEN 1 ELSE token_holders.slots_dirty END,
  max_agents = excluded.max_agents`;
}

function toConfig(row: ConfigRow): TokenConfig {
  const thresholds: [number, number, number] = [row.threshold_1_ppm, row.threshold_2_ppm, row.threshold_3_ppm];
  return {
    enabled: row.enabled === 1,
    tokenAddress: row.token_address as Address | null,
    thresholdsPpm: thresholds,
    buyUrl: row.buy_url,
    activatedAt: row.activated_at,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

function toHolder(row: HolderRow): TokenHolder {
  return {
    address: row.address as Address,
    balance: row.balance,
    totalSupply: row.total_supply,
    decimals: row.decimals,
    tier: row.tier as Tier,
    maxAgents: row.max_agents,
    tokenAddress: row.token_address as Address,
    checkedAt: row.checked_at,
    riseTier: row.rise_tier as Tier | null,
    riseSince: row.rise_since,
  };
}

function rowsOf<T>(results: D1Result<unknown>[], index: number): T[] {
  const result = results[index];
  if (result === undefined) throw new Error(`token store: the batch returned no result for statement ${index}`);
  return result.results as T[];
}

function isLocked(error: unknown): boolean {
  return error instanceof Error && error.message.includes('token configuration is locked');
}

export function createTokenStore(db: D1Database): TokenStore {
  return {
    async getConfig(): Promise<TokenConfig> {
      const row = await db.prepare(GET_CONFIG).first<ConfigRow>();
      if (row === null) throw new Error('token store: the configuration row is missing');
      return toConfig(row);
    },

    async putConfig(input: TokenConfigInput, now: string, by: string): Promise<TokenConfigOutcome> {
      const [one, two, three] = input.thresholdsPpm;
      const statements: D1PreparedStatement[] = [
        db.prepare(PUT_CONFIG).bind(input.enabled ? 1 : 0, input.tokenAddress, one, two, three, input.buyUrl, now, by),
        db.prepare(RELEASE_IF_OFF).bind(now),
        db.prepare(GET_CONFIG),
      ];
      try {
        const results = await db.batch(statements);
        const row = rowsOf<ConfigRow>(results, 2)[0];
        if (row === undefined) throw new Error('token store: the configuration row is missing');
        return { kind: 'saved', config: toConfig(row) };
      } catch (error) {
        if (isLocked(error)) return { kind: 'locked' };
        throw error;
      }
    },

    async getHolder(address: Address, token: Address): Promise<TokenHolder | null> {
      const row = await db.prepare(GET_HOLDER).bind(address, token).first<HolderRow>();
      return row === null ? null : toHolder(row);
    },

    async getHolders(addresses: readonly Address[], token: Address): Promise<TokenHolder[]> {
      if (addresses.length === 0) return [];
      const marks = addresses.map((_, index) => `?${index + 2}`).join(', ');
      const result = await db
        .prepare(
          `SELECT address, balance, total_supply, decimals, tier, max_agents, token_address, checked_at, rise_tier, rise_since
FROM token_holders WHERE token_address = ?1 AND address IN (${marks})`,
        )
        .bind(token, ...addresses)
        .all<HolderRow>();
      return result.results.map(toHolder);
    },

    async putHolders(rows: readonly TokenHolder[]): Promise<void> {
      if (rows.length === 0) return;
      const statements: D1PreparedStatement[] = [];
      for (let start = 0; start < rows.length; start += TOKEN_UPSERT_ROWS_PER_STATEMENT) {
        const chunk = rows.slice(start, start + TOKEN_UPSERT_ROWS_PER_STATEMENT);
        const bound: Bound[] = [];
        for (const row of chunk) {
          bound.push(
            row.address,
            row.balance,
            row.totalSupply,
            row.decimals,
            row.tier,
            row.maxAgents,
            row.tokenAddress,
            row.checkedAt,
            row.riseTier ?? null,
            row.riseSince ?? null,
          );
        }
        statements.push(db.prepare(upsertHolders(chunk.length)).bind(...bound));
      }
      await db.batch(statements);
    },

    async listDueHolders(token: Address, checkedBefore: string, limit: number): Promise<Address[]> {
      if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('token store: limit must be a whole number');
      const result = await db.prepare(LIST_DUE).bind(token, checkedBefore, limit).all<{ address: string }>();
      return result.results.map((row) => row.address as Address);
    },

    async applySlots(now: string): Promise<{ paused: number; resumed: number }> {
      const results = await db.batch([
        db.prepare(PAUSE_BEYOND).bind(now),
        db.prepare(RESUME_FITTING).bind(now),
        db.prepare(CLEAR_DIRTY),
      ]);
      return { paused: rowsOf<unknown>(results, 0).length, resumed: rowsOf<unknown>(results, 1).length };
    },

    async releaseSlotPauses(now: string): Promise<number> {
      const result = await db.prepare(RELEASE_ALL).bind(now).all<{ id: string }>();
      return result.results.length;
    },

    async countOwnerAgents(owner: Address): Promise<{ total: number; pausedForSlots: number }> {
      const row = await db.prepare(COUNT_OWNER).bind(owner).first<{ total: number; paused_for_slots: number }>();
      return { total: row?.total ?? 0, pausedForSlots: row?.paused_for_slots ?? 0 };
    },
  };
}
