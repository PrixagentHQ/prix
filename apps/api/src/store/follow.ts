import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import type {
  ChatLink,
  DecisionRow,
  DueNotice,
  EmitCandidate,
  EmitState,
  FeedAgent,
  FeedRow,
  FeedStoreQuery,
  FollowEntry,
  FollowStore,
  NoticeKey,
} from '@prix/contracts';
import { isHouseOwner, MAX_FOLLOWS_PER_WALLET, tickIdFor } from '@prix/contracts';

/**
 * The D1 side of Phase 3, Follow (docs/contracts/phase-3-follow.md sections 2 and 4). Every method
 * is one D1 statement or one batch, and a batch is a transaction. The SQL of this phase lives
 * here, in one place, as `store/sql.ts` does for Phase 1 (`sql.ts` is not this task's file).
 * `?1`, `?2` are bound values; nothing is concatenated except fixed fragments.
 */

type Bound = string | number | null;

/** D1 allows 100 bound values a statement. A key row binds 4 values, so 25 rows is the most. */
const KEYS_PER_INSERT = 25;
/** A key in a delete or update binds 3 values. */
const KEYS_PER_STATEMENT = 25;

const flag = (value: boolean): number => (value ? 1 : 0);

// --- follows --------------------------------------------------------------------------------------

/** ?1 address, ?2 agent id. No row: the agent is unknown or hidden. */
const FOLLOW_FACTS = `
SELECT a.owner AS owner,
  (SELECT 1 FROM follows WHERE address = ?1 AND agent_id = ?2) AS followed,
  (SELECT COUNT(*) FROM follows WHERE address = ?1) AS total
FROM agents a WHERE a.id = ?2 AND a.hidden = 0`;

/**
 * The same conditions as FOLLOW_FACTS, decided again inside the insert, in the same
 * transaction. ?1 address, ?2 agent id, ?3 notify, ?4 now, ?5 limit.
 */
const PUT_FOLLOW = `
INSERT INTO follows (address, agent_id, notify, created_at)
SELECT ?1, ?2, ?3, ?4
WHERE EXISTS (SELECT 1 FROM agents WHERE id = ?2 AND hidden = 0 AND owner <> ?1)
  AND (EXISTS (SELECT 1 FROM follows WHERE address = ?1 AND agent_id = ?2)
    OR (SELECT COUNT(*) FROM follows WHERE address = ?1) < ?5)
ON CONFLICT (address, agent_id) DO UPDATE SET notify = excluded.notify`;

const DELETE_FOLLOW = 'DELETE FROM follows WHERE address = ?1 AND agent_id = ?2 RETURNING agent_id';

/** ?1 address, ?2 limit. */
const LIST_FOLLOWS = `
SELECT f.agent_id AS agent_id, a.name AS name, a.division AS division, a.owner AS owner, f.notify AS notify,
  f.created_at AS created_at
FROM follows f JOIN agents a ON a.id = f.agent_id
WHERE f.address = ?1 AND a.hidden = 0
ORDER BY f.created_at DESC, f.agent_id DESC LIMIT ?2`;

// --- feeds ----------------------------------------------------------------------------------------

const GET_FEED_AGENT = `
SELECT a.id AS id, a.name AS name, a.division AS division, a.owner AS owner, COALESCE(c.followers, 0) AS followers
FROM agents a LEFT JOIN follow_counts c ON c.agent_id = a.id
WHERE a.id = ?1 AND a.hidden = 0`;

// Every feed read returns the agent's owner beside its name, so that the read side can mark a
// house agent (docs/CONTRACTS.md section 17). The owner reaches no response.

/** ?1 agent id, ?2 not after, ?3 limit, then the cursor tick id (?4) if there is one. */
const AGENT_FEED_HEAD = `
SELECT a.name AS name, a.owner AS owner, d.body AS body
FROM agents a CROSS JOIN decisions d
WHERE a.id = ?1 AND a.hidden = 0 AND d.agent_id = a.id AND d.status = 'decided' AND d.created_at <= ?2`;
const AGENT_FEED_CURSOR = ' AND d.tick_id < ?4';
const AGENT_FEED_TAIL = ' ORDER BY d.tick_id DESC LIMIT ?3';

/** ?1 address, ?2 not after, ?3 limit, ?4 since tick id, then the cursor (?5 tick id, ?6 agent id). */
const FOLLOW_FEED_HEAD = `
SELECT a.name AS name, a.owner AS owner, d.body AS body
FROM follows f
JOIN agents a ON a.id = f.agent_id AND a.hidden = 0
JOIN decisions d ON d.agent_id = f.agent_id AND d.tick_id >= ?4
WHERE f.address = ?1 AND d.status = 'decided' AND d.created_at <= ?2`;
const FOLLOW_FEED_CURSOR = ' AND (d.tick_id, d.agent_id) < (?5, ?6)';
const FOLLOW_FEED_TAIL = ' ORDER BY d.tick_id DESC, d.agent_id DESC LIMIT ?3';

/**
 * The league feed: the decided rows of every agent that is not hidden, newest tick first and
 * then agent id descending. ?1 not after, ?2 limit, ?3 the tick of ?1, then the cursor (?4 tick
 * id, ?5 agent id).
 *
 * It is one read of the partial index `decisions_decided_by_tick (tick_id, agent_id) WHERE
 * status = 'decided'` (migration 0003), walked backwards: the index order is the ORDER BY, so
 * there is no sort and the walk stops at the limit. `INDEXED BY` makes the statement fail
 * rather than scan the table if that index can ever not be used, and `CROSS JOIN` keeps the
 * decisions on the outside, with one primary-key read of the agent for each row.
 *
 * `d.tick_id <= ?3` is where the walk starts. A row is written after its tick begins, so a row
 * of a later tick than the one that contains ?1 cannot have been written by ?1. Without that
 * bound a delay of a day would make every request read and discard the day's rows first.
 * What the walk still discards is small: the rows of the cut's own hour that were written after
 * the cut, and the rows of hidden agents.
 */
const LEAGUE_FEED_HEAD = `
SELECT a.name AS name, a.owner AS owner, d.body AS body
FROM decisions d INDEXED BY decisions_decided_by_tick
CROSS JOIN agents a ON a.id = d.agent_id
WHERE d.status = 'decided' AND d.tick_id <= ?3 AND d.created_at <= ?1 AND a.hidden = 0`;
const LEAGUE_FEED_CURSOR = ' AND (d.tick_id, d.agent_id) < (?4, ?5)';
const LEAGUE_FEED_TAIL = ' ORDER BY d.tick_id DESC, d.agent_id DESC LIMIT ?2';

/**
 * The two statements `listLeagueFeed` can run, for the test that reads their query plan in the
 * Workers runtime (tests/workers/league-feed.d1.test.ts). Nothing else reads this.
 */
export const LEAGUE_FEED_STATEMENTS = {
  firstPage: LEAGUE_FEED_HEAD + LEAGUE_FEED_TAIL,
  nextPage: LEAGUE_FEED_HEAD + LEAGUE_FEED_CURSOR + LEAGUE_FEED_TAIL,
} as const;

// --- chat link ------------------------------------------------------------------------------------

const PUT_LINK_CODE = `
INSERT INTO notify_link_codes (address, code_hash, expires_at) VALUES (?1, ?2, ?3)
ON CONFLICT (address) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at`;

/** ?1 code hash, ?2 now. */
const FIND_CODE = 'SELECT address FROM notify_link_codes WHERE code_hash = ?1 AND expires_at > ?2';
/** ?1 chat id. */
const FIND_CHAT_BY_ID = 'SELECT address FROM notify_chats WHERE chat_id = ?1';
/**
 * Links the chat to the code's wallet, unless the chat belongs to another wallet. A wallet's
 * earlier chat is replaced. ?1 code hash, ?2 now, ?3 chat id.
 */
const LINK_CHAT = `
INSERT INTO notify_chats (address, chat_id, enabled, linked_at)
SELECT k.address, ?3, 1, ?2 FROM notify_link_codes k
WHERE k.code_hash = ?1 AND k.expires_at > ?2
  AND NOT EXISTS (SELECT 1 FROM notify_chats c WHERE c.chat_id = ?3 AND c.address <> k.address)
ON CONFLICT (address) DO UPDATE SET chat_id = excluded.chat_id, enabled = 1, linked_at = excluded.linked_at`;
/** The code is spent only when the chat is linked to its wallet. ?1 code hash, ?2 now, ?3 chat id. */
const SPEND_CODE = `
DELETE FROM notify_link_codes
WHERE code_hash = ?1 AND expires_at > ?2
  AND EXISTS (SELECT 1 FROM notify_chats c WHERE c.address = notify_link_codes.address AND c.chat_id = ?3)`;

const GET_CHAT = 'SELECT address, chat_id, enabled, linked_at FROM notify_chats WHERE address = ?1';
const SET_CHAT_ENABLED = 'UPDATE notify_chats SET enabled = ?2 WHERE address = ?1 RETURNING address';
const DELETE_OUTBOX_OF_WALLET = 'DELETE FROM notify_outbox WHERE address = ?1';
const DELETE_CHAT = 'DELETE FROM notify_chats WHERE address = ?1 RETURNING address';
const DELETE_OUTBOX_OF_CHAT =
  'DELETE FROM notify_outbox WHERE address IN (SELECT address FROM notify_chats WHERE chat_id = ?1)';
const DELETE_CHAT_BY_ID = 'DELETE FROM notify_chats WHERE chat_id = ?1 RETURNING address';

// --- emitter and outbox ---------------------------------------------------------------------------

const GET_EMIT_STATE = `
SELECT done_tick_id, work_tick_id, after_agent_id, after_address, queue_day, queued_today
FROM notify_state WHERE id = 1`;
const LATEST_COMPLETE_TICK = "SELECT id FROM ticks WHERE status = 'complete' ORDER BY id DESC LIMIT 1";
const NEXT_COMPLETE_TICK = "SELECT id FROM ticks WHERE id > ?1 AND status = 'complete' ORDER BY id ASC LIMIT 1";

/** ?1 tick id, ?2 after agent id, ?3 after address, ?4 limit. The fills test reads the stored body. */
const LIST_EMIT_CANDIDATES = `
SELECT d.agent_id AS agent_id, f.address AS address
FROM decisions d
JOIN agents a ON a.id = d.agent_id AND a.hidden = 0
JOIN follows f ON f.agent_id = d.agent_id AND f.notify = 1
LEFT JOIN notify_chats c ON c.address = f.address AND c.enabled = 1
WHERE d.tick_id = ?1 AND d.status = 'decided'
  AND (c.address IS NOT NULL OR EXISTS (SELECT 1 FROM push_subscriptions p INDEXED BY push_subscriptions_address WHERE p.address = f.address))
  AND json_array_length(d.body, '$.fills') > 0
  AND (d.agent_id, f.address) > (?2, ?3)
ORDER BY d.agent_id ASC, f.address ASC LIMIT ?4`;

const UPDATE_EMIT_STATE = `
UPDATE notify_state SET done_tick_id = ?1, work_tick_id = ?2, after_agent_id = ?3, after_address = ?4,
  queue_day = ?5, queued_today = ?6 WHERE id = 1`;

/** ?1 limit. A notice is due while its chat, its follow and its agent are all still valid. */
const LIST_DUE_NOTICES = `
SELECT o.address AS address, o.tick_id AS tick_id, o.agent_id AS agent_id, o.attempts AS attempts,
  COALESCE(c.chat_id, 0) AS chat_id, a.name AS agent_name, d.body AS body
FROM notify_outbox o
LEFT JOIN notify_chats c ON c.address = o.address AND c.enabled = 1
JOIN follows f ON f.address = o.address AND f.agent_id = o.agent_id AND f.notify = 1
JOIN agents a ON a.id = o.agent_id AND a.hidden = 0
JOIN decisions d ON d.agent_id = o.agent_id AND d.tick_id = o.tick_id
WHERE (c.address IS NOT NULL OR EXISTS (SELECT 1 FROM push_subscriptions p INDEXED BY push_subscriptions_address WHERE p.address = o.address))
ORDER BY o.address ASC, o.tick_id ASC, o.agent_id ASC LIMIT ?1`;

const SWEEP_OUTBOX = `
DELETE FROM notify_outbox WHERE (address, tick_id, agent_id) IN (
  SELECT address, tick_id, agent_id FROM notify_outbox WHERE queued_at < ?1 LIMIT ?2)`;
const SWEEP_CODES = `
DELETE FROM notify_link_codes WHERE address IN (
  SELECT address FROM notify_link_codes WHERE expires_at < ?1 LIMIT ?2)`;

// --- rows -----------------------------------------------------------------------------------------

interface BodyJson {
  fills?: { symbol: string; side: 'buy' | 'sell' }[];
}

interface FeedRowSql {
  name: string;
  owner: string;
  body: string;
}

function toFeedRows(rows: FeedRowSql[]): FeedRow[] {
  return rows.map((row) => ({ agentName: row.name, owner: row.owner, row: JSON.parse(row.body) as DecisionRow }));
}

/** `(?, ?, ?), (?, ?, ?)` for `count` keys. */
function keyTuples(count: number): string {
  return Array.from({ length: count }, () => '(?, ?, ?)').join(', ');
}

function keyValues(keys: readonly NoticeKey[]): Bound[] {
  return keys.flatMap((key) => [key.address, key.tickId, key.agentId]);
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < items.length; at += size) out.push(items.slice(at, at + size));
  return out;
}

/** What the store needs beside the database. */
export interface FollowStoreOptions {
  /**
   * `ApiConfig.houseOwners`: a follow of an agent of one of these wallets says `house: true`
   * (docs/CONTRACTS.md section 17.1). The owner is read to set the mark and reaches no response.
   */
  houseOwners?: readonly string[];
}

export function createFollowStore(db: D1Database, options: FollowStoreOptions = {}): FollowStore {
  const prepare = (statement: string, ...values: Bound[]): D1PreparedStatement => db.prepare(statement).bind(...values);

  async function all<T>(statement: string, ...values: Bound[]): Promise<T[]> {
    return (await prepare(statement, ...values).all<T>()).results;
  }

  async function first<T>(statement: string, ...values: Bound[]): Promise<T | null> {
    return prepare(statement, ...values).first<T>();
  }

  return {
    async putFollow(address, agentId, notify, now, maxFollows) {
      const [facts] = await db.batch<{ owner: string; followed: number | null; total: number }>([
        prepare(FOLLOW_FACTS, address, agentId),
        prepare(PUT_FOLLOW, address, agentId, flag(notify), now, maxFollows),
      ]);
      const seen = facts?.results[0];
      if (!seen) return 'agent_unavailable';
      if (seen.owner === address) return 'own_agent';
      if (seen.followed === 1) return 'updated';
      if (seen.total >= maxFollows) return 'follow_limit_reached';
      return 'created';
    },

    async deleteFollow(address, agentId) {
      return (await all(DELETE_FOLLOW, address, agentId)).length === 1;
    },

    async listFollows(address) {
      const rows = await all<{
        agent_id: string;
        name: string;
        division: 'open' | 'pro';
        owner: string;
        notify: number;
        created_at: string;
      }>(LIST_FOLLOWS, address, MAX_FOLLOWS_PER_WALLET);
      return rows.map(
        (row): FollowEntry => ({
          agentId: row.agent_id,
          name: row.name,
          division: row.division,
          notify: row.notify === 1,
          createdAt: row.created_at,
          house: isHouseOwner(options.houseOwners, row.owner),
        }),
      );
    },

    async getFeedAgent(agentId) {
      const row = await first<{
        id: string;
        name: string;
        division: 'open' | 'pro';
        owner: string;
        followers: number;
      }>(GET_FEED_AGENT, agentId);
      return row ? ({ ...row } satisfies FeedAgent) : null;
    },

    async listAgentFeed(agentId, query: FeedStoreQuery) {
      const values: Bound[] = [agentId, query.notAfter, query.limit];
      let statement = AGENT_FEED_HEAD;
      if (query.before) {
        statement += AGENT_FEED_CURSOR;
        values.push(query.before.tickId);
      }
      statement += AGENT_FEED_TAIL;
      return toFeedRows(await all<FeedRowSql>(statement, ...values));
    },

    async listFollowFeed(address, query: FeedStoreQuery) {
      const values: Bound[] = [address, query.notAfter, query.limit, query.sinceTickId ?? ''];
      let statement = FOLLOW_FEED_HEAD;
      if (query.before) {
        statement += FOLLOW_FEED_CURSOR;
        values.push(query.before.tickId, query.before.agentId);
      }
      statement += FOLLOW_FEED_TAIL;
      return toFeedRows(await all<FeedRowSql>(statement, ...values));
    },

    async listLeagueFeed(query: FeedStoreQuery) {
      const values: Bound[] = [query.notAfter, query.limit, tickIdFor(new Date(query.notAfter))];
      if (!query.before) return toFeedRows(await all<FeedRowSql>(LEAGUE_FEED_STATEMENTS.firstPage, ...values));
      values.push(query.before.tickId, query.before.agentId);
      return toFeedRows(await all<FeedRowSql>(LEAGUE_FEED_STATEMENTS.nextPage, ...values));
    },

    async putLinkCode(address, codeHash, expiresAt) {
      await prepare(PUT_LINK_CODE, address, codeHash, expiresAt).run();
    },

    async redeemLinkCode(codeHash, chatId, now) {
      const results = await db.batch<{ address: string }>([
        prepare(FIND_CODE, codeHash, now),
        prepare(FIND_CHAT_BY_ID, chatId),
        prepare(LINK_CHAT, codeHash, now, chatId),
        prepare(SPEND_CODE, codeHash, now, chatId),
      ]);
      const code = results[0]?.results[0];
      if (!code) return { result: 'invalid' };
      const holder = results[1]?.results[0];
      if (holder && holder.address !== code.address) return { result: 'chat_in_use' };
      return { result: 'linked', address: code.address };
    },

    async getChat(address) {
      const row = await first<{ address: string; chat_id: number; enabled: number; linked_at: string }>(
        GET_CHAT,
        address,
      );
      if (!row) return null;
      return {
        address: row.address,
        chatId: row.chat_id,
        enabled: row.enabled === 1,
        linkedAt: row.linked_at,
      } satisfies ChatLink;
    },

    async setChatEnabled(address, enabled) {
      return (await all(SET_CHAT_ENABLED, address, flag(enabled))).length === 1;
    },

    async deleteChat(address) {
      const results = await db.batch([prepare(DELETE_OUTBOX_OF_WALLET, address), prepare(DELETE_CHAT, address)]);
      return (results[1]?.results.length ?? 0) === 1;
    },

    async deleteChatById(chatId) {
      const results = await db.batch([prepare(DELETE_OUTBOX_OF_CHAT, chatId), prepare(DELETE_CHAT_BY_ID, chatId)]);
      return (results[1]?.results.length ?? 0) === 1;
    },

    async getEmitState() {
      const row = await first<{
        done_tick_id: string | null;
        work_tick_id: string | null;
        after_agent_id: string;
        after_address: string;
        queue_day: string;
        queued_today: number;
      }>(GET_EMIT_STATE);
      if (!row) throw new Error('notify_state has no row: migration 0003 did not run.');
      return {
        doneTickId: row.done_tick_id,
        workTickId: row.work_tick_id,
        afterAgentId: row.after_agent_id,
        afterAddress: row.after_address,
        queueDay: row.queue_day,
        queuedToday: row.queued_today,
      } satisfies EmitState;
    },

    async latestCompleteTickId() {
      return (await first<{ id: string }>(LATEST_COMPLETE_TICK))?.id ?? null;
    },

    async nextCompleteTickAfter(tickId) {
      return (await first<{ id: string }>(NEXT_COMPLETE_TICK, tickId))?.id ?? null;
    },

    async listEmitCandidates(tickId, after, limit) {
      const rows = await all<{ agent_id: string; address: string }>(
        LIST_EMIT_CANDIDATES,
        tickId,
        after.agentId,
        after.address,
        limit,
      );
      return rows.map((row): EmitCandidate => ({ agentId: row.agent_id, address: row.address }));
    },

    async commitEmit(state, keys, queuedAt) {
      const statements = chunks(keys, KEYS_PER_INSERT).map((part) =>
        prepare(
          `INSERT OR IGNORE INTO notify_outbox (address, tick_id, agent_id, attempts, queued_at) VALUES ${part
            .map(() => '(?, ?, ?, 0, ?)')
            .join(', ')}`,
          ...part.flatMap((key) => [key.address, key.tickId, key.agentId, queuedAt]),
        ),
      );
      statements.push(
        prepare(
          UPDATE_EMIT_STATE,
          state.doneTickId,
          state.workTickId,
          state.afterAgentId,
          state.afterAddress,
          state.queueDay,
          state.queuedToday,
        ),
      );
      await db.batch(statements);
    },

    async listDueNotices(limit) {
      const rows = await all<{
        address: string;
        tick_id: string;
        agent_id: string;
        attempts: number;
        chat_id: number;
        agent_name: string;
        body: string;
      }>(LIST_DUE_NOTICES, limit);
      return rows.map(
        (row): DueNotice => ({
          address: row.address,
          tickId: row.tick_id,
          agentId: row.agent_id,
          attempts: row.attempts,
          chatId: row.chat_id,
          agentName: row.agent_name,
          fills: ((JSON.parse(row.body) as BodyJson).fills ?? []).map((fill) => ({
            symbol: fill.symbol,
            side: fill.side,
          })),
        }),
      );
    },

    async finishNotices(done, retry, maxAttempts) {
      const statements: D1PreparedStatement[] = [];
      for (const part of chunks(done, KEYS_PER_STATEMENT)) {
        statements.push(
          prepare(
            `DELETE FROM notify_outbox WHERE (address, tick_id, agent_id) IN (VALUES ${keyTuples(part.length)})`,
            ...keyValues(part),
          ),
        );
      }
      for (const part of chunks(retry, KEYS_PER_STATEMENT)) {
        const where = `(address, tick_id, agent_id) IN (VALUES ${keyTuples(part.length)})`;
        statements.push(
          prepare(`UPDATE notify_outbox SET attempts = attempts + 1 WHERE ${where}`, ...keyValues(part)),
          prepare(`DELETE FROM notify_outbox WHERE attempts >= ? AND ${where}`, maxAttempts, ...keyValues(part)),
        );
      }
      if (statements.length > 0) await db.batch(statements);
    },

    async sweep(now, staleBefore, limit) {
      await db.batch([prepare(SWEEP_OUTBOX, staleBefore, limit), prepare(SWEEP_CODES, now, limit)]);
    },
  };
}
