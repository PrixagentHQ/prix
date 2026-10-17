import { env as baseEnv } from 'cloudflare:workers';
import type { Address } from '@prix/contracts';
import {
  POLL_MAX_VOTERS,
  POLL_PRUNE_AT,
  POLL_TALLY_JOB_OFF_WHAT,
  POLL_TALLY_SETTLE_SECONDS,
  pollsResponseSchema,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  SOCIAL_CRON,
} from '@prix/contracts';
import { PUBLIC_RPC_URLS } from '@prix/market';
import { encodeTokenResult } from '@prix/market/token-wire';
import { resetTokenMemory } from '@prix/runtime/token/service';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashToken, newSessionToken } from '../../apps/api/src/http/session.ts';
import worker, { createTallyDelay, runCron } from '../../apps/api/src/index.ts';
import { createD1Store } from '../../apps/api/src/store/index.ts';
import { createPollStore } from '../../apps/api/src/store/polls.ts';
import { db, resetDb } from '../social/support/d1.ts';
import { ADMIN, AT_TIER, CLOSES, INSIDE, POLL, PRIX, pollTables, SUPPLY, wallet } from './support.ts';

/**
 * The holders' poll behind POLLS_ENABLED "true", end to end through the Worker's entry (docs/contracts/
 * phase-6-holders.md sections 4.3 to 4.6, 5 and 11 C, at revision 7): votes through `worker.fetch`, then the
 * tally, the purge and the prune through `runCron(SOCIAL_CRON)`, on the local D1 with every migration, the
 * entry's own token service and holding reader, and a chain answered at the fetch layer (each `balanceOf` of
 * the batched call answered from the test's balances, at the block tag asked).
 *
 * Revision 7 (R4, HB1F2-SEC-1): a `poll_tally` run that has reached its reads ends the social step, so the
 * room's two jobs behind it (`room_picture_sweep`, `room_prune`) send no statement in that invocation; an idle
 * run, or one that failed before its first `listVoters`, still lets them run.
 */

const ORIGIN = 'https://prix.test';
const NONCE_SECRET = btoa('n'.repeat(32));
const HEAD = 5_000_000;
const BALANCE_OF = '70a08231';
const VOTE = `/api/polls/${POLL}/vote`;
/** The SQL that only the room's prune sends in the social step, and the sweep's read of owed deletes. */
const ROOM_PRUNE_SQL = 'DELETE FROM room_picture_reports';
const PICTURE_SWEEP_SQL = 'room_messages_pic_owed';

const chain = {
  balances: new Map<string, bigint>(),
  down: false,
  rpcCalls: 0,
  /** How the official endpoint answers (revision 8, the run's endpoint memory). */
  official: 'ok' as 'ok' | '429' | 'rpcError',
  officialCalls: 0,
};
const OFFICIAL_RPC = (PUBLIC_RPC_URLS[0] as string).replace(/\/+$/, '');
const sql: string[] = [];
const logs: string[] = [];

/** The local D1 with every statement's text written down before it is prepared. */
function watched(fail: ((text: string) => boolean) | null = null): D1Database {
  return new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') {
        return (text: string) => {
          sql.push(text);
          if (fail?.(text) === true) throw new Error('d1 refused');
          return target.prepare(text);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function envWith(database: D1Database, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const pass = { limit: async () => ({ success: true }) };
  return {
    ...(baseEnv as unknown as Record<string, unknown>),
    DB: database,
    SITE_ORIGIN: ORIGIN,
    ADMIN_ADDRESSES: ADMIN,
    HOUSE_MODEL: '@cf/test/model',
    HOUSE_MODEL_INPUT_NEURONS: '1',
    HOUSE_MODEL_OUTPUT_NEURONS: '1',
    KEY_ENCRYPTION_KEY: btoa('k'.repeat(32)),
    NONCE_SECRET,
    RATE_SIGN_IN: pass,
    RATE_WRITE: pass,
    RATE_READ: pass,
    SOCIAL_ENABLED: 'true',
    POLLS_ENABLED: 'true',
    // Revision 8b (R8-SEC-1) and 8c (CR8B-3): `poll_tally` is in the social step only while POLL_TALLY_JOB is "on".
    POLL_TALLY_JOB: 'on',
    ...extra,
  };
}

/** Every JSON-RPC call answered as the token's batched read, from `chain.balances`, at the block asked. */
function stubChain(): void {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith('https://')) return new Response('not found', { status: 404 });
    chain.rpcCalls += 1;
    if (chain.down) return new Response('unavailable', { status: 503 });
    if (url.replace(/\/+$/, '') === OFFICIAL_RPC) {
      chain.officialCalls += 1;
      if (chain.official === '429') return new Response('rate limited', { status: 429 });
      if (chain.official === 'rpcError') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'limit' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    type Call = { id?: unknown; params?: unknown[] };
    let body: Call | Call[];
    try {
      body = JSON.parse(String(init?.body ?? '{}')) as Call | Call[];
    } catch {
      return new Response('not found', { status: 404 });
    }
    const calls = Array.isArray(body) ? body : [body];
    const answers = calls.map((call) => {
      const [tx, tag] = (call.params ?? []) as [{ data?: string }, string | undefined];
      const data = String(tx?.data ?? '').toLowerCase();
      const balances: bigint[] = [];
      for (let at = data.indexOf(BALANCE_OF); at >= 0; at = data.indexOf(BALANCE_OF, at + 8)) {
        const holder = `0x${data.slice(at + 8 + 24, at + 8 + 64)}`;
        balances.push(chain.balances.get(holder) ?? 0n);
      }
      return {
        jsonrpc: '2.0',
        id: call.id,
        result: encodeTokenResult({
          blockNumber: typeof tag === 'string' && tag.startsWith('0x') ? BigInt(tag) : BigInt(HEAD),
          blockTimestamp: BigInt(Math.floor(Date.now() / 1000)),
          totalSupply: SUPPLY,
          decimals: 18,
          balances,
        }),
      };
    });
    return new Response(JSON.stringify(Array.isArray(body) ? answers : answers[0]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => undefined };

async function call(env: Record<string, unknown>, path: string, init: RequestInit = {}) {
  const response = await worker.fetch(new Request(`${ORIGIN}${path}`, init) as never, env as never, ctx as never);
  await Promise.all(pending.splice(0));
  const text = await response.text();
  return { status: response.status, text, json: text === '' ? null : (JSON.parse(text) as unknown) };
}

async function signIn(address: Address): Promise<string> {
  const token = newSessionToken();
  const now = new Date();
  const store = createD1Store(db);
  await store.putSession({
    tokenHash: await hashToken(token),
    address,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + SESSION_TTL_SECONDS * 1000).toISOString(),
  });
  await store.touchUser(address, '2020-01-01T00:00:00.000Z');
  return token;
}

/** A stored tier read just now, as the token sweep leaves it, and the same balance on the chain. */
async function holds(address: Address, tier: 0 | 1 | 2 | 3): Promise<void> {
  chain.balances.set(address.toLowerCase(), AT_TIER[tier]);
  await db
    .prepare(
      `INSERT INTO token_holders (address, balance, total_supply, decimals, tier, max_agents, token_address, checked_at, slots_dirty)
       VALUES (?1, ?2, ?3, 18, ?4, 3, ?5, ?6, 0)`,
    )
    .bind(address.toLowerCase(), AT_TIER[tier].toString(), SUPPLY.toString(), tier, PRIX, new Date().toISOString())
    .run();
}

async function vote(env: Record<string, unknown>, cookie: string, option: string) {
  return call(env, VOTE, {
    method: 'POST',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json', Cookie: `${SESSION_COOKIE}=${cookie}` },
    body: JSON.stringify({ option }),
  });
}

/** One run of the social step at `at`; what the entry logged as the step, and whether the room's jobs ran. */
async function socialRun(env: Record<string, unknown>, at: Date) {
  vi.setSystemTime(at);
  sql.length = 0;
  logs.length = 0;
  await runCron(SOCIAL_CRON, env as never);
  const stepLine = logs
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((l) => l.event === 'social_step');
  return {
    step: stepLine === undefined ? null : { job: stepLine.job, outcome: stepLine.outcome },
    roomPrune: sql.some((text) => text.includes(ROOM_PRUNE_SQL)),
    pictureSweep: sql.some((text) => text.includes(PICTURE_SWEEP_SQL)),
    events: logs.map((line) => (JSON.parse(line) as { event?: string }).event),
  };
}

async function publicRead(env: Record<string, unknown>) {
  await caches.default.delete(`${ORIGIN}/api/polls`);
  const reply = await call(env, '/api/polls');
  expect(reply.status).toBe(200);
  return pollsResponseSchema.parse(reply.json).polls.find((p) => p.id === POLL);
}

beforeEach(async () => {
  await resetDb();
  await db
    .prepare(
      `UPDATE token_config SET enabled = 1, token_address = ?1, activated_at = '2026-10-08T18:37:00.000Z',
       updated_at = '2026-10-08T18:37:00.000Z', updated_by = 'test' WHERE id = 1`,
    )
    .bind(PRIX)
    .run();
  resetTokenMemory();
  chain.balances.clear();
  chain.down = false;
  chain.rpcCalls = 0;
  chain.official = 'ok';
  chain.officialCalls = 0;
  stubChain();
  const keep = (...args: unknown[]) => {
    for (const arg of args) if (typeof arg === 'string' && arg.startsWith('{')) logs.push(arg);
  };
  vi.spyOn(console, 'log').mockImplementation(keep);
  vi.spyOn(console, 'warn').mockImplementation(keep);
  vi.spyOn(console, 'error').mockImplementation(keep);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const A = wallet(0xa001);
const B = wallet(0xb002);
const C = wallet(0xc003);
const NOBODY = wallet(0xd004);

describe('POLLS_ENABLED "true": the vote, the tally and the purge through the entry', () => {
  it('votes, tallies after close + 60 s + d with the step ending at poll_tally, purges, then hands the step on', async () => {
    const env = envWith(watched());
    vi.setSystemTime(new Date(INSIDE));
    await holds(A, 1);
    await holds(B, 2);
    await holds(C, 1);
    await holds(NOBODY, 0);
    const [a, b, c, nobody] = await Promise.all([A, B, C, NOBODY].map((w) => signIn(w)));

    expect((await call(env, '/api/polls/status')).status).toBe(200);
    expect((await vote(env, a as string, 'index-core')).status).toBe(200);
    expect((await vote(env, b as string, 'dip-buyer')).status).toBe(200);
    expect((await vote(env, c as string, 'index-core')).status).toBe(200);
    const refused = await vote(env, nobody as string, 'index-core');
    expect(refused.status).toBe(403);
    expect(refused.text).toContain('poll_not_holder');
    const open = await publicRead(env);
    expect(open?.state).toBe('open');
    expect(open?.cast).toMatchObject({ 'index-core': 2, 'dip-buyer': 1 });
    expect(JSON.stringify(open)).not.toMatch(/0x[0-9a-f]{40}/i);

    // C sells before the tally's read: cast, never counted.
    chain.balances.set(C.toLowerCase(), 0n);
    const d = await createTallyDelay(NONCE_SECRET)(POLL);
    const due = Date.parse(CLOSES) + (POLL_TALLY_SETTLE_SECONDS + d) * 1000;

    // One run before the tally is due: idle, and the room's jobs run behind it.
    const early = await socialRun(env, new Date(due - 1000));
    expect(early.step === null || early.step.job !== 'poll_tally').toBe(true);
    expect(early.roomPrune).toBe(true);
    expect((await pollTables()).results).toEqual([]);

    // The tally: done, and nothing behind poll_tally sends a statement in that invocation.
    const tally = await socialRun(env, new Date(due + 5_000));
    expect(tally.step).toEqual({ job: 'poll_tally', outcome: 'done' });
    expect(tally.events).toContain('poll_tallied');
    expect(tally.roomPrune).toBe(false);
    expect(tally.pictureSweep).toBe(false);
    const closed = await publicRead(env);
    expect(closed?.state).toBe('closed');
    expect(closed?.result?.cast).toMatchObject({ 'index-core': 2, 'dip-buyer': 1 });
    expect(closed?.result?.counted).toMatchObject({ 'index-core': 1, 'dip-buyer': 1 });
    expect(logs.join('\n')).not.toMatch(/0x[0-9a-f]{40}/i);

    // The purge deletes the vote rows (more), then the job is idle and the room's prune runs again.
    const purge = await socialRun(env, new Date(due + 305_000));
    expect(purge.step).toEqual({ job: 'poll_tally', outcome: 'more' });
    expect(purge.roomPrune).toBe(false);
    expect((await pollTables()).votes).toEqual([]);
    const after = await socialRun(env, new Date(due + 605_000));
    expect(after.step === null || after.step.job !== 'poll_tally').toBe(true);
    expect(after.roomPrune).toBe(true);
  });

  it('a tally that failed at its chain read ends the step with done, logs the step and writes nothing', async () => {
    const env = envWith(watched());
    vi.setSystemTime(new Date(INSIDE));
    await holds(A, 1);
    expect((await vote(env, await signIn(A), 'index-core')).status).toBe(200);
    chain.down = true;
    const d = await createTallyDelay(NONCE_SECRET)(POLL);
    const run = await socialRun(env, new Date(Date.parse(CLOSES) + (POLL_TALLY_SETTLE_SECONDS + d + 5) * 1000));
    expect(run.step).toEqual({ job: 'poll_tally', outcome: 'done' });
    expect(run.events).toContain('poll_tally_failed');
    expect(run.events).toContain('social_job_failed');
    expect(run.roomPrune).toBe(false);
    expect((await pollTables()).results).toEqual([]);
  });

  it('a tally whose results read failed (before any listVoters) still lets the room’s jobs run', async () => {
    vi.setSystemTime(new Date(INSIDE));
    await holds(A, 1);
    expect((await vote(envWith(watched()), await signIn(A), 'index-core')).status).toBe(200);
    const env = envWith(watched((text) => /SELECT[\s\S]*FROM poll_results/i.test(text)));
    const d = await createTallyDelay(NONCE_SECRET)(POLL);
    const before = chain.rpcCalls;
    const run = await socialRun(env, new Date(Date.parse(CLOSES) + (POLL_TALLY_SETTLE_SECONDS + d + 5) * 1000));
    expect(run.step?.job === 'poll_tally' && run.step.outcome === 'done').toBe(false);
    expect(run.events).toContain('social_job_failed');
    expect(run.roomPrune).toBe(true);
    expect(chain.rpcCalls).toBe(before);
  });
});

describe('POLLS_ENABLED "true": the prune of the open poll through the entry', () => {
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
  const PRUNE_AT = new Date('2026-10-19T13:02:00.000Z');

  it('prunes the wallets that no longer hold, ending the step; a new honest vote is then stored', async () => {
    const env = envWith(watched());
    await fill(POLL_PRUNE_AT);
    const holder = wallet(7);
    chain.balances.set(holder, AT_TIER[1]);
    const run = await socialRun(env, PRUNE_AT);
    expect(run.step).toEqual({ job: 'poll_tally', outcome: 'done' });
    expect(run.roomPrune).toBe(false);
    const t = await pollTables();
    expect(t.votes.map((v) => v.wallet)).toEqual([holder]);
    expect(t.countsByOption).toEqual(t.groupedByOption);

    vi.setSystemTime(new Date(PRUNE_AT.getTime() + 60_000));
    await holds(A, 1);
    expect((await vote(env, await signIn(A), 'dip-buyer')).status).toBe(200);
    expect((await pollTables()).sum).toBe(2);
  });

  it('a prune that deleted none still ends the step (revision 7), and the hour after it hands the step on', async () => {
    // Prix's own wallets outside the filled range, so that every voter holds and none is pruned.
    const env = envWith(watched(), { ADMIN_ADDRESSES: wallet(0xffff1), HOUSE_OWNERS: wallet(0xffff2) });
    await fill(POLL_PRUNE_AT);
    for (let i = 1; i <= POLL_PRUNE_AT; i += 1) chain.balances.set(wallet(i), AT_TIER[1]);
    const run = await socialRun(env, PRUNE_AT);
    expect(run.step).toEqual({ job: 'poll_tally', outcome: 'done' });
    expect(run.roomPrune).toBe(false);
    expect((await pollTables()).votes).toHaveLength(POLL_PRUNE_AT);
    // Later in the hour the prune is not due: idle, and the room's prune runs.
    const later = await socialRun(env, new Date(PRUNE_AT.getTime() + 5 * 60_000));
    expect(later.step === null || later.step.job !== 'poll_tally').toBe(true);
    expect(later.roomPrune).toBe(true);
  });
});

/** A vote written straight into D1 inside the window, as the route stores it (the route is off with the switch). */
async function storedVote(voter: Address, option: string): Promise<void> {
  const answer = await createPollStore(db).putVote(POLL, voter, option, INSIDE, POLL_MAX_VOTERS);
  expect(answer).toBe('stored');
}

async function adminTally(env: Record<string, unknown>) {
  const token = await signIn(ADMIN as Address);
  return call(env, `/api/admin/polls/${POLL}/tally`, {
    method: 'POST',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json', Cookie: `${SESSION_COOKIE}=${token}` },
  });
}

describe('F3: a closed poll with no voter while polls are switched off (revisions 8e and 8f)', () => {
  it('writes no result, reads no chain, answers waiting, and room_prune runs in the same invocation', async () => {
    const env = envWith(watched(), { POLLS_ENABLED: 'false' });
    const d = await createTallyDelay(NONCE_SECRET)(POLL);
    const due = new Date(Date.parse(CLOSES) + (POLL_TALLY_SETTLE_SECONDS + d) * 1000);
    const run = await socialRun(env, due);
    expect(run.events).toContain('poll_tally_waiting');
    expect(run.step === null || run.step.job !== 'poll_tally').toBe(true);
    expect(run.roomPrune).toBe(true);
    expect(chain.rpcCalls).toBe(0);
    expect((await pollTables()).results).toEqual([]);

    // The admin's tally takes the same path: waiting, nothing frozen, no chain read.
    const admin = await adminTally(env);
    expect(admin.status, admin.text).toBe(200);
    expect(admin.json).toEqual({ outcome: 'waiting', step: null });
    expect(chain.rpcCalls).toBe(0);
    expect((await pollTables()).results).toEqual([]);

    // With POLLS_ENABLED "true" the zero result is written.
    const on = envWith(watched());
    const later = await socialRun(on, new Date(due.getTime() + 60_000));
    expect(later.step).toEqual({ job: 'poll_tally', outcome: 'done' });
    const results = (await pollTables()).results;
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((row) => Number(row.cast_votes) === 0 && Number(row.counted) === 0)).toBe(true);
  });

  it('a closed poll with voters is tallied while polls are switched off', async () => {
    const env = envWith(watched(), { POLLS_ENABLED: 'false' });
    chain.balances.set(A.toLowerCase(), AT_TIER[1]);
    await storedVote(A, 'index-core');
    const d = await createTallyDelay(NONCE_SECRET)(POLL);
    const due = new Date(Date.parse(CLOSES) + (POLL_TALLY_SETTLE_SECONDS + d) * 1000);
    const run = await socialRun(env, due);
    expect(run.step).toEqual({ job: 'poll_tally', outcome: 'done' });
    expect(run.events).not.toContain('poll_tally_waiting');
    expect(chain.rpcCalls).toBeGreaterThan(0);
    const row = (await pollTables()).results.find((r) => r.option_id === 'index-core');
    expect(Number(row?.counted)).toBe(1);
  });
});

describe('the run endpoint memory through the entry (revision 8, R8-2; qa row (3))', () => {
  for (const official of ['429', 'rpcError'] as const) {
    it(`the admin tally with the official endpoint answering ${official}: counted, the official endpoint asked once`, async () => {
      const env = envWith(watched());
      chain.official = official;
      for (const [i, w] of [A, B, C].entries()) {
        chain.balances.set(w.toLowerCase(), AT_TIER[1]);
        await storedVote(w, i === 1 ? 'dip-buyer' : 'index-core');
      }
      const d = await createTallyDelay(NONCE_SECRET)(POLL);
      vi.setSystemTime(new Date(Date.parse(CLOSES) + (POLL_TALLY_SETTLE_SECONDS + d) * 1000));
      const admin = await adminTally(env);
      expect(admin.status, admin.text).toBe(200);
      expect(admin.json).toEqual({ outcome: 'done', step: null });
      expect(chain.officialCalls).toBe(1);
      const t = await pollTables();
      expect(Number(t.results.find((r) => r.option_id === 'index-core')?.counted)).toBe(2);
    });

    it(`the job's tally with the official endpoint answering ${official}: counted, the official endpoint asked once`, async () => {
      const env = envWith(watched());
      chain.official = official;
      for (const w of [A, B]) {
        chain.balances.set(w.toLowerCase(), AT_TIER[2]);
        await storedVote(w, 'momentum-five');
      }
      const d = await createTallyDelay(NONCE_SECRET)(POLL);
      const run = await socialRun(env, new Date(Date.parse(CLOSES) + (POLL_TALLY_SETTLE_SECONDS + d) * 1000));
      expect(run.step).toEqual({ job: 'poll_tally', outcome: 'done' });
      expect(chain.officialCalls).toBe(1);
      expect(Number((await pollTables()).results.find((r) => r.option_id === 'momentum-five')?.counted)).toBe(2);
    });
  }
});

describe('POLL_TALLY_JOB "off" (revision 8b R8-SEC-1, 8c CR8B-3)', () => {
  it('drops poll_tally from the social step only: step_not_configured is logged, and the admin tally still counts', async () => {
    const env = envWith(watched(), { POLLS_ENABLED: 'false', POLL_TALLY_JOB: 'off' });
    chain.balances.set(A.toLowerCase(), AT_TIER[1]);
    await storedVote(A, 'index-core');
    const d = await createTallyDelay(NONCE_SECRET)(POLL);
    const due = new Date(Date.parse(CLOSES) + (POLL_TALLY_SETTLE_SECONDS + d) * 1000);
    const run = await socialRun(env, due);
    expect(run.step === null || run.step.job !== 'poll_tally').toBe(true);
    expect(run.events).not.toContain('poll_tallied');
    const off = logs
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((l) => l.event === 'step_not_configured' && l.what === POLL_TALLY_JOB_OFF_WHAT);
    expect(off).toBeDefined();
    expect((await pollTables()).results).toEqual([]);
    expect(run.roomPrune).toBe(true);

    const admin = await adminTally(env);
    expect(admin.status, admin.text).toBe(200);
    expect(admin.json).toEqual({ outcome: 'done', step: null });
    expect(Number((await pollTables()).results.find((r) => r.option_id === 'index-core')?.counted)).toBe(1);
  });
});
