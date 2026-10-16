import { POLL_MAX_VOTERS, POLL_PRUNE_AT } from '@prix/contracts';
import { createPollTallyJob } from '@prix/runtime/social/poll-tally';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, resetDb } from '../social/support/d1.ts';
import { AT_TIER, blockChain, POLL, pollTables, tallyDeps, wallet } from './support.ts';

/**
 * Prune while open (docs/contracts/phase-6-holders.md section 5, revision 3 H2-SEC-1, and 11 C): one bundle
 * passed through POLL_MAX_VOTERS wallets fills the poll; the job's prune, in the first five minutes of an hour,
 * reads every voter at one block and leaves only the wallet that holds there; a new honest voter is then stored.
 * The 4,000 rows are a fixture written by one statement, as the store's batch would have left them.
 */

const HEAD = 7_000;
const PRUNE_AT = new Date('2026-10-19T13:02:00.000Z');
const LATE_IN_HOUR = new Date('2026-10-19T13:06:00.000Z');

async function fill(n: number) {
  await db
    .prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2)
       INSERT INTO poll_votes (poll_id, wallet, option_id, created_at)
       SELECT ?1, printf('0x%040x', i), 'index-core', '2026-10-17T00:00:00.000Z' FROM n`,
    )
    .bind(POLL, n)
    .run();
  await db
    .prepare("INSERT INTO poll_counts (poll_id, option_id, votes) VALUES (?1, 'index-core', ?2)")
    .bind(POLL, n)
    .run();
}

async function runJob(job: ReturnType<typeof createPollTallyJob>, now: Date): Promise<unknown> {
  try {
    return await job.run(now);
  } catch (error) {
    return error;
  }
}

beforeEach(async () => {
  await resetDb();
});

describe('the prune of the open poll', () => {
  it('a full poll refuses a new wallet; the prune leaves only the holder at its block; a new honest voter is then stored', async () => {
    await fill(POLL_MAX_VOTERS);
    const chain = blockChain(HEAD);
    const holder = wallet(POLL_MAX_VOTERS);
    chain.set(holder, AT_TIER[1]);
    const { deps, logText } = tallyDeps(chain.reader, { now: () => PRUNE_AT });
    expect(await deps.polls.putVote(POLL, wallet(0xabcdef), 'dip-buyer', PRUNE_AT.toISOString(), POLL_MAX_VOTERS)).toBe(
      'full',
    );

    const job = createPollTallyJob(deps);
    expect(await runJob(job, PRUNE_AT)).toBe('done');
    const t = await pollTables();
    expect(t.votes.map((v) => v.wallet)).toEqual([holder]);
    expect(t.countsByOption).toEqual(t.groupedByOption);
    expect(t.sum).toBe(1);
    // Every read of the prune at one block, the head less the margin after the first.
    const blocks = new Set(chain.calls.slice(1).map((call) => Number(call.atBlock)));
    expect(blocks.size).toBe(1);
    expect(logText()).not.toMatch(/0x[0-9a-f]{40}/i);

    expect(await deps.polls.putVote(POLL, wallet(0xabcdef), 'dip-buyer', PRUNE_AT.toISOString(), POLL_MAX_VOTERS)).toBe(
      'stored',
    );
  });

  it('runs only from POLL_PRUNE_AT votes and only in the first five minutes of an hour', async () => {
    await fill(POLL_PRUNE_AT - 1);
    const chain = blockChain(HEAD);
    const { deps } = tallyDeps(chain.reader, { now: () => PRUNE_AT });
    const job = createPollTallyJob(deps);
    expect(await runJob(job, PRUNE_AT)).toBe('idle');
    expect(chain.calls).toEqual([]);
    await db
      .prepare("UPDATE poll_counts SET votes = votes + 1 WHERE poll_id = ?1 AND option_id = 'index-core'")
      .bind(POLL)
      .run();
    await db
      .prepare("INSERT INTO poll_votes VALUES (?1, ?2, 'index-core', '2026-10-17T00:00:00.000Z')")
      .bind(POLL, wallet(POLL_PRUNE_AT))
      .run();
    expect(await runJob(job, LATE_IN_HOUR)).toBe('idle');
    expect(chain.calls).toEqual([]);
    expect((await pollTables()).votes).toHaveLength(POLL_PRUNE_AT);
    expect(await runJob(job, PRUNE_AT)).toBe('done');
    expect((await pollTables()).votes).toHaveLength(0);
  });

  it('a read that answers another block fails the prune and deletes nothing', async () => {
    await fill(POLL_MAX_VOTERS);
    const chain = blockChain(HEAD);
    chain.state.answerBlock = (call, asked) => (call === 4 ? asked - 1 : asked);
    const { deps } = tallyDeps(chain.reader, { now: () => PRUNE_AT });
    const outcome = await runJob(createPollTallyJob(deps), PRUNE_AT);
    expect(outcome).not.toBe('done');
    const t = await pollTables();
    expect(t.votes).toHaveLength(POLL_MAX_VOTERS);
    expect(t.sum).toBe(POLL_MAX_VOTERS);
  });
});
