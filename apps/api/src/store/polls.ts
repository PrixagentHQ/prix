import type { D1Database } from '@cloudflare/workers-types';
import type { Address, IsoTime, PollResultRecord, PollStore, PollVoter } from '@prix/contracts';
import { pollById, pollLeaders } from '@prix/contracts';

/**
 * The holders' poll's side of D1: `createPollStore(db)` implements `PollStore` over
 * infra/migrations/0018_polls.sql (docs/contracts/phase-6-holders.md section 4.2). The only code that writes
 * the poll tables.
 *
 * Every method is one D1 call or one D1 batch, and a batch is a transaction. The cap of voters is decided
 * inside the vote's own transaction, so two votes at once can never pass it together, and `poll_counts`
 * moves in the same transaction as the rows, so its sum always equals the poll's rows.
 */

/** `putVote`'s four statements, in the contract's order; ?1 poll, ?2 wallet, ?3 option, ?4 time, ?5 cap. */
export const PUT_VOTE_SQL = [
  'UPDATE poll_counts SET votes = votes - 1 WHERE poll_id = ?1 AND option_id = (SELECT option_id FROM poll_votes WHERE poll_id = ?1 AND wallet = ?2)',
  'UPDATE poll_votes SET option_id = ?3, created_at = ?4 WHERE poll_id = ?1 AND wallet = ?2',
  'INSERT INTO poll_votes (poll_id, wallet, option_id, created_at) SELECT ?1, ?2, ?3, ?4 WHERE NOT EXISTS (SELECT 1 FROM poll_votes WHERE poll_id = ?1 AND wallet = ?2) AND (SELECT COALESCE(SUM(votes), 0) FROM poll_counts WHERE poll_id = ?1) < ?5',
  'INSERT INTO poll_counts (poll_id, option_id, votes) SELECT ?1, ?3, 1 WHERE EXISTS (SELECT 1 FROM poll_votes WHERE poll_id = ?1 AND wallet = ?2) ON CONFLICT (poll_id, option_id) DO UPDATE SET votes = votes + 1',
] as const;

const GET_VOTE_SQL = 'SELECT option_id FROM poll_votes WHERE poll_id = ?1 AND wallet = ?2';
const CAST_COUNTS_SQL = 'SELECT option_id, votes FROM poll_counts WHERE poll_id = ?1';
const LIST_VOTERS_SQL =
  'SELECT wallet, option_id FROM poll_votes WHERE poll_id = ?1 AND wallet > ?2 AND created_at < ?3 ORDER BY wallet LIMIT ?4';
const GET_RESULTS_SQL =
  'SELECT poll_id, option_id, cast_votes, counted, counted_at, first_block, last_block FROM poll_results WHERE poll_id IN (SELECT value FROM json_each(?1))';
const PUT_RESULT_SQL =
  'INSERT INTO poll_results (poll_id, option_id, cast_votes, counted, counted_at, first_block, last_block) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT (poll_id, option_id) DO NOTHING';
const DELETE_VOTES_SQL =
  'DELETE FROM poll_votes WHERE poll_id = ?1 AND wallet IN (SELECT wallet FROM poll_votes WHERE poll_id = ?1 ORDER BY wallet LIMIT ?2)';
export const PRUNE_VOTERS_SQL = [
  'UPDATE poll_counts SET votes = votes - (SELECT COUNT(*) FROM poll_votes v WHERE v.poll_id = ?1 AND v.option_id = poll_counts.option_id AND v.wallet IN (SELECT value FROM json_each(?2))) WHERE poll_id = ?1',
  'DELETE FROM poll_votes WHERE poll_id = ?1 AND wallet IN (SELECT value FROM json_each(?2))',
] as const;

/** Below every lower-case 0x address, so that `wallet > ?` starts at the first wallet. */
const BEFORE_EVERY_WALLET = '';

interface ResultSql {
  poll_id: string;
  option_id: string;
  cast_votes: number;
  counted: number;
  counted_at: string;
  first_block: number;
  last_block: number;
}

function changes(result: { meta?: { changes?: number } } | undefined): number {
  const n = result?.meta?.changes;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

/** The options of a result in the poll's order when the poll is known, else in the order the counts name them. */
function optionOrder(pollId: string, ...counts: Readonly<Record<string, number>>[]): string[] {
  const poll = pollById(pollId);
  const named = new Set<string>();
  for (const record of counts) for (const id of Object.keys(record)) named.add(id);
  if (poll === null) return [...named].sort();
  const order = poll.options.map((option) => option.id);
  for (const id of [...named].sort()) if (!order.includes(id)) order.push(id);
  return order;
}

function toResults(rows: readonly ResultSql[], pollIds: readonly string[]): PollResultRecord[] {
  const out: PollResultRecord[] = [];
  for (const pollId of pollIds) {
    const own = rows.filter((row) => row.poll_id === pollId);
    const first = own[0];
    if (first === undefined) continue;
    const cast: Record<string, number> = {};
    const counted: Record<string, number> = {};
    for (const row of own) {
      cast[row.option_id] = row.cast_votes;
      counted[row.option_id] = row.counted;
    }
    // A poll the code no longer names keeps its leaders by the stored options, in id order.
    const poll = pollById(pollId) ?? {
      options: optionOrder(pollId, counted).map((id) => ({ id, name: id, agentId: '' })),
    };
    out.push({
      pollId,
      cast,
      counted,
      leaders: pollLeaders(poll, counted),
      countedAt: first.counted_at,
      firstBlock: first.first_block,
      lastBlock: first.last_block,
    });
  }
  return out;
}

export function createPollStore(db: D1Database): PollStore {
  return {
    async putVote(pollId: string, wallet: Address, option: string, at: IsoTime, maxVoters: number) {
      // D1 takes exactly as many values as a statement's highest ?N, so each statement gets its own.
      const values = [pollId, wallet, option, at, maxVoters] as const;
      const [down, update, insert, up] = PUT_VOTE_SQL;
      const results = await db.batch([
        db.prepare(down).bind(...values.slice(0, 2)),
        db.prepare(update).bind(...values.slice(0, 4)),
        db.prepare(insert).bind(...values),
        db.prepare(up).bind(...values.slice(0, 3)),
      ]);
      return changes(results[1]) === 0 && changes(results[2]) === 0 ? 'full' : 'stored';
    },

    async getVote(pollId: string, wallet: Address) {
      const row = await db.prepare(GET_VOTE_SQL).bind(pollId, wallet).first<{ option_id: string }>();
      return row?.option_id ?? null;
    },

    async castCounts(pollId: string) {
      const rows = await db.prepare(CAST_COUNTS_SQL).bind(pollId).all<{ option_id: string; votes: number }>();
      const out: Record<string, number> = {};
      for (const row of rows.results) out[row.option_id] = row.votes;
      return out;
    },

    async listVoters(pollId: string, after: Address | null, before: IsoTime, limit: number): Promise<PollVoter[]> {
      const rows = await db
        .prepare(LIST_VOTERS_SQL)
        .bind(pollId, after ?? BEFORE_EVERY_WALLET, before, limit)
        .all<{ wallet: string; option_id: string }>();
      return rows.results.map((row) => ({ wallet: row.wallet as Address, option: row.option_id }));
    },

    async getResults(pollIds: readonly string[]) {
      if (pollIds.length === 0) return [];
      const rows = await db.prepare(GET_RESULTS_SQL).bind(JSON.stringify(pollIds)).all<ResultSql>();
      return toResults(rows.results, pollIds);
    },

    async putResult(result: PollResultRecord) {
      const options = optionOrder(result.pollId, result.cast, result.counted);
      const statements = options.map((option) =>
        db
          .prepare(PUT_RESULT_SQL)
          .bind(
            result.pollId,
            option,
            result.cast[option] ?? 0,
            result.counted[option] ?? 0,
            result.countedAt,
            result.firstBlock,
            result.lastBlock,
          ),
      );
      if (statements.length === 0) return false;
      const results = await db.batch(statements);
      return results.every((r) => changes(r) === 1);
    },

    async deleteVotes(pollId: string, limit: number) {
      const result = await db.prepare(DELETE_VOTES_SQL).bind(pollId, limit).run();
      return changes(result);
    },

    async pruneVoters(pollId: string, wallets: readonly Address[]) {
      if (wallets.length === 0) return 0;
      const list = JSON.stringify(wallets);
      const [down, remove] = PRUNE_VOTERS_SQL;
      const results = await db.batch([db.prepare(down).bind(pollId, list), db.prepare(remove).bind(pollId, list)]);
      return changes(results[1]);
    },
  };
}
