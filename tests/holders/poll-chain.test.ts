import {
  type Address,
  HOLDER_POLLS,
  type HolderPoll,
  POLL_MAX_VOTERS,
  POLL_PRUNE_AT,
  POLL_TALLY_FETCH_LATENCY_MS,
  POLL_TALLY_MAX_FETCHES,
  POLL_TALLY_MAX_RUN_SECONDS,
  type PollTallyJobDeps,
  type PollTallyOutcome,
} from '@prix/contracts';
import { createPollTallyJobFor, tallyPoll } from '@prix/runtime/social/poll-tally';
import { describe, expect, it } from 'vitest';
import { pollHoldingFor } from '../../apps/api/src/poll-holding.ts';
import {
  DRPC_URL,
  type EndpointName,
  fakeChain,
  OFFICIAL_URL,
  type Plan,
  PUBLICNODE_URL,
  TEST_LATENCY_MS,
  voterWallet,
} from './chain-fake.ts';

/**
 * Revisions 8 to 8f of the holders' contract on a chain that answers as production's endpoints do
 * (docs/contracts/phase-6-holders.md section 25, qa rows (2) to (5) and (7)): the worst tally and prune runs of
 * `POLL_MAX_VOTERS` voters through the entry's own holding builder (`pollHoldingFor`: the run's meter, its
 * endpoint memory, its abort and its slow mark), on the real clock, against `POLL_TALLY_MAX_RUN_SECONDS`.
 */

const POLL = HOLDER_POLLS[0] as HolderPoll;
const TOKEN = '0x00000000000000000000000000000000000070c0' as Address;
const RUN_MS = POLL_TALLY_MAX_RUN_SECONDS * 1000;
const SLOW = 30_000;

interface Line {
  event: string;
  data: Record<string, unknown> | undefined;
}

/** A clock that runs at real time from `at`. */
function clockFrom(at: string): () => Date {
  const shift = Date.parse(at) - Date.now();
  return () => new Date(Date.now() + shift);
}

/** A poll store in memory with `voters` voters on `option`, written inside the poll's window. */
function pollStore(voters: number, option = 'index-core') {
  const rows = Array.from({ length: voters }, (_, i) => ({ wallet: voterWallet(0x10000 + i), option }));
  const written: unknown[] = [];
  const pruned: Address[][] = [];
  const store = {
    async listVoters(_poll: string, after: string | null, _before: string, limit: number) {
      return rows.filter((row) => after === null || row.wallet > after).slice(0, limit);
    },
    async getResults() {
      return [];
    },
    async putResult(result: unknown) {
      written.push(result);
      return true;
    },
    async castCounts() {
      return { [option]: rows.length };
    },
    async pruneVoters(_poll: string, wallets: readonly Address[]) {
      pruned.push([...wallets]);
      return wallets.length;
    },
    async deleteVotes() {
      return 0;
    },
  };
  return { store, rows, written, pruned };
}

function depsFor(
  chain: ReturnType<typeof fakeChain>,
  store: ReturnType<typeof pollStore>['store'],
  now: () => Date,
): { deps: PollTallyJobDeps; lines: Line[] } {
  const lines: Line[] = [];
  const holding = pollHoldingFor(
    [OFFICIAL_URL, PUBLICNODE_URL, DRPC_URL],
    async () => ({ token: TOKEN, thresholdsPpm: [10, 100, 1_000] as const, gatingOn: true }),
    chain.fetch,
  );
  const deps = {
    polls: store,
    holding,
    adminAddresses: [],
    houseOwners: [],
    tallyDelaySeconds: async () => 0,
    social: { async putCursor() {} },
    reputation: {
      async getJobState() {
        return null;
      },
    },
    pollsEnabled: true,
    now,
    log: (event: string, data?: Record<string, unknown>) => {
      lines.push({ event, data });
    },
  } as unknown as PollTallyJobDeps;
  return { deps, lines };
}

/**
 * A run that has not settled SETTLE_MS after its start fails the case at once, with the milliseconds it waited,
 * instead of holding the case to its timeout (PF5-SEC-1: a body outside 2xx that never ends used to hang the run).
 */
const SETTLE_MS = RUN_MS + 3_000;

async function settled<T>(run: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the run was still pending after ${SETTLE_MS} ms`)), SETTLE_MS);
  });
  try {
    return await Promise.race([run, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One tally of the first poll with POLL_MAX_VOTERS voters, two minutes after its close, on the real clock;
 * `latencyMs` is the fake chain's latency a fetch (absent, POLL_TALLY_FETCH_LATENCY_MS).
 */
async function tallyWith(
  plan: (endpoint: EndpointName, call: number) => Plan | undefined,
  window = true,
  latencyMs?: number,
) {
  const chain = fakeChain({ plan, window, ...(latencyMs === undefined ? {} : { latencyMs }) });
  const world = pollStore(POLL_MAX_VOTERS);
  const { deps, lines } = depsFor(
    chain,
    world.store,
    clockFrom(new Date(Date.parse(POLL.closesAt) + 120_000).toISOString()),
  );
  const started = Date.now();
  const outcome: PollTallyOutcome = await settled(tallyPoll(deps, POLL));
  const wall = Date.now() - started;
  return { outcome, wall, chain, world, lines };
}

/** One prune run of the open poll, in the first minute of an hour inside its window, POLL_MAX_VOTERS voters. */
async function pruneWith(plan: (endpoint: EndpointName, call: number) => Plan | undefined, latencyMs?: number) {
  const holdsNot = new Set<string>();
  for (let i = 0; i < POLL_MAX_VOTERS; i += 2) holdsNot.add(voterWallet(0x10000 + i).toLowerCase());
  const chain = fakeChain({
    plan,
    balanceOf: (w) => (holdsNot.has(w) ? 0n : 10n ** 23n),
    ...(latencyMs === undefined ? {} : { latencyMs }),
  });
  const world = pollStore(POLL_MAX_VOTERS);
  // The first minute of an hour inside the poll's window, read from its opensAt (36 hours and 20 s after it).
  const at = new Date(Date.parse(POLL.opensAt) + 36 * 3_600_000 + 20_000).toISOString();
  const { deps, lines } = depsFor(chain, world.store, clockFrom(at));
  const job = createPollTallyJobFor(deps, [POLL]);
  const started = Date.now();
  const answer = await settled(job.run(new Date(at)));
  const wall = Date.now() - started;
  return { answer, wall, chain, world, lines, holdsNot };
}

const official = (plan: Plan) => (endpoint: EndpointName) => (endpoint === 'official' ? plan : undefined);

function expectTallied(run: Awaited<ReturnType<typeof tallyWith>>) {
  expect(run.outcome).toEqual({ outcome: 'done', step: null });
  expect(run.world.written).toHaveLength(1);
  const line = run.lines.find((l) => l.event === 'poll_tallied');
  expect(line?.data).toMatchObject({ poll: POLL.id, voters: POLL_MAX_VOTERS, counted: POLL_MAX_VOTERS });
  expect(typeof line?.data?.readMs).toBe('number');
  expect(line?.data?.readMs as number).toBeLessThanOrEqual(RUN_MS);
  expect(run.chain.seen.length).toBeLessThanOrEqual(POLL_TALLY_MAX_FETCHES);
}

function expectPruned(run: Awaited<ReturnType<typeof pruneWith>>) {
  expect(run.answer).toBe('done');
  expect(run.world.pruned).toHaveLength(1);
  expect(new Set(run.world.pruned[0]?.map((w) => w.toLowerCase()))).toEqual(run.holdsNot);
  const line = run.lines.find((l) => l.event === 'poll_pruned');
  expect(line?.data).toMatchObject({ poll: POLL.id, deleted: POLL_MAX_VOTERS / 2 });
  expect(line?.data?.readMs as number).toBeLessThanOrEqual(RUN_MS);
  expect(JSON.stringify(run.lines)).not.toMatch(/0x[0-9a-f]{40}/i);
  expect(run.chain.seen.length).toBeLessThanOrEqual(POLL_TALLY_MAX_FETCHES);
}

describe('the fake chain itself (qa row (2))', () => {
  it('answers after the latency, moves its head 10 blocks a second, and refuses an old block at publicnode', async () => {
    const chain = fakeChain();
    const before = chain.headNow();
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    expect(chain.headNow() - before).toBeGreaterThanOrEqual(10);
    const call = (tag: number) =>
      chain.fetch(PUBLICNODE_URL, {
        method: 'POST',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_call',
          params: [{ data: '0x' }, `0x${tag.toString(16)}`],
        }),
      });
    const t0 = Date.now();
    expect((await call(chain.headNow() - 90)).status).toBe(200);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(POLL_TALLY_FETCH_LATENCY_MS - 5);
    expect((await call(chain.headNow() - 120)).status).toBe(403);
  });

  it('answers at the test latency it is given (revision 8g, H5)', async () => {
    const chain = fakeChain({ latencyMs: TEST_LATENCY_MS });
    const t0 = Date.now();
    const answer = await chain.fetch(DRPC_URL, {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ data: '0x' }, 'latest'] }),
    });
    const took = Date.now() - t0;
    expect(answer.status).toBe(200);
    expect(took).toBeGreaterThanOrEqual(TEST_LATENCY_MS - 5);
    expect(took).toBeLessThan(POLL_TALLY_FETCH_LATENCY_MS);
  });

  it('a stalled body outside 2xx (PF5-SEC-1): headers arrive, the body stays pending until the signal aborts', async () => {
    const chain = fakeChain({ plan: () => ({ kind: 'status', status: 429, stalledBody: true }) });
    const abort = new AbortController();
    const answer = await chain.fetch(OFFICIAL_URL, {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
      signal: abort.signal,
    });
    expect(answer.status).toBe(429);
    const text = answer.text();
    const raced = await Promise.race([
      text.then(
        () => 'ended',
        () => 'errored',
      ),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 500)),
    ]);
    expect(raced).toBe('pending');
    abort.abort();
    await expect(text).rejects.toThrow();
  });
});

describe('the worst tally runs of POLL_MAX_VOTERS voters (qa row (3))', { timeout: SLOW }, () => {
  it('the official endpoint answering 429 to every call: tallied within the run seconds, asked once', async () => {
    const run = await tallyWith(official({ kind: 'status', status: 429 }));
    expectTallied(run);
    expect(run.chain.of('official')).toHaveLength(1);
  });

  it('a JSON-RPC error inside a 200: tallied, the official endpoint asked once', async () => {
    const run = await tallyWith(official({ kind: 'rpcError' }));
    expectTallied(run);
    expect(run.chain.of('official')).toHaveLength(1);
  });

  // The cases below cost the meter's whole POLL_TALLY_FETCH_TIMEOUT_MS on their first fetch, so they run at the
  // test latency TEST_LATENCY_MS (revision 8g, H5): at 300 ms a fetch the run's margin to POLL_TALLY_MAX_RUN_SECONDS
  // is about 500 ms, which the full suite's load took (5,036 and 5,065 ms on holders-polls-integrated-5).
  it('the official endpoint never answering: aborted at the meter, tallied, asked once', async () => {
    const run = await tallyWith(official({ kind: 'never' }), true, TEST_LATENCY_MS);
    expectTallied(run);
    expect(run.chain.of('official')).toHaveLength(1);
  });

  it('200 headers with no whole body (R8C-2): the stalled body marks it, tallied, asked once', async () => {
    const run = await tallyWith(official({ kind: 'noBody' }), true, TEST_LATENCY_MS);
    expectTallied(run);
    expect(run.chain.of('official')).toHaveLength(1);
  });

  it('PF5-SEC-1: 429 headers with a body that never ends: refused at the meter, tallied, asked once', async () => {
    const run = await tallyWith(official({ kind: 'status', status: 429, stalledBody: true }), true, TEST_LATENCY_MS);
    expectTallied(run);
    expect(run.chain.of('official')).toHaveLength(1);
    expect(run.chain.of('official')[0]?.answered).toBe('429-stalled');
  });

  it('PF5-SEC-1: the official endpoint down and publicnode answering 503 with a body that never ends: the run ends at read in time', async () => {
    const run = await tallyWith(
      (endpoint, n) => {
        if (endpoint === 'official') return { kind: 'status', status: 429 };
        if (endpoint === 'publicnode' && n === 1) return { kind: 'status', status: 503, stalledBody: true };
        return undefined;
      },
      true,
      TEST_LATENCY_MS,
    );
    expect(run.chain.of('publicnode')[0]?.answered).toBe('503-stalled');
    // Marked by its status, publicnode is never asked again; dRPC alone cannot agree, so the run fails at read
    // inside its seconds and writes nothing, where today's meter left the run pending on that body.
    expect(run.chain.of('publicnode')).toHaveLength(1);
    expect(run.outcome).toEqual({ outcome: 'failed', step: 'read' });
    expect(run.wall).toBeLessThanOrEqual(RUN_MS + 1_000);
    expect(run.world.written).toHaveLength(0);
    expect(run.lines.find((l) => l.event === 'poll_tally_failed')?.data).toMatchObject({ poll: POLL.id, step: 'read' });
  });

  it('every call answered correctly after 1,400 ms (D4): the slow mark lets it answer once a run', async () => {
    const run = await tallyWith(official({ kind: 'answer', delayMs: 1_400 }));
    expectTallied(run);
    expect(run.chain.of('official')).toHaveLength(1);
  });
});

describe('F1: a third party is never marked for its time alone (qa row (4))', { timeout: SLOW }, () => {
  const down = (slowAt: EndpointName, call: number, delayMs: number) => (endpoint: EndpointName, n: number) => {
    if (endpoint === 'official') return { kind: 'status', status: 429 } as Plan;
    if (endpoint === slowAt && n === call) return { kind: 'answer', delayMs } as Plan;
    return undefined;
  };

  it('publicnode answering the head read after 1,000 ms', async () => {
    const run = await tallyWith(down('publicnode', 1, 1_000));
    expectTallied(run);
  });

  it("dRPC answering read 2's confirmation after 1,000 ms", async () => {
    const run = await tallyWith(down('drpc', 2, 1_000));
    expectTallied(run);
  });

  it('publicnode answering one read that is not the last after 1,400 ms', async () => {
    const run = await tallyWith(down('publicnode', 3, 1_400));
    expectTallied(run);
  });
});

describe('F2: the keyless window (qa row (5))', { timeout: SLOW }, () => {
  /** The official endpoint answers the run's first call alone, 30 blocks behind publicnode, then 429. */
  const behind = (endpoint: EndpointName, n: number): Plan | undefined => {
    if (endpoint !== 'official') return undefined;
    return n === 1 ? { kind: 'answer', headBehind: 30 } : { kind: 'status', status: 429 };
  };

  it('a pinned block that passes publicnode’s window fails the run at read, inside the run seconds', async () => {
    const run = await tallyWith(behind);
    expect(run.outcome).toEqual({ outcome: 'failed', step: 'read' });
    expect(run.world.written).toHaveLength(0);
    expect(run.wall).toBeLessThanOrEqual(RUN_MS + 1_000);
    expect(run.chain.of('publicnode').some((c) => c.answered === '403')).toBe(true);
    const failed = run.lines.find((l) => l.event === 'poll_tally_failed');
    expect(failed?.data).toMatchObject({ poll: POLL.id, step: 'read' });
    expect(typeof failed?.data?.readMs).toBe('number');
  });

  it('the same run is tallied when the 403 is taken out of the fake', async () => {
    const run = await tallyWith(behind, false);
    expectTallied(run);
  });
});

describe('the worst prune runs of POLL_MAX_VOTERS voters (qa rows (3) and (7))', { timeout: SLOW }, () => {
  it(`at least POLL_PRUNE_AT (${POLL_PRUNE_AT}) votes, the official endpoint answering 429: pruned in one batch`, async () => {
    const run = await pruneWith(official({ kind: 'status', status: 429 }));
    expectPruned(run);
    expect(run.chain.of('official')).toHaveLength(1);
  });

  it('the official endpoint never answering: pruned (at TEST_LATENCY_MS, revision 8g, H5)', async () => {
    const run = await pruneWith(official({ kind: 'never' }), TEST_LATENCY_MS);
    expectPruned(run);
  });

  it('PF5-SEC-1: 429 headers with a body that never ends: pruned, the official endpoint asked once', async () => {
    const run = await pruneWith(official({ kind: 'status', status: 429, stalledBody: true }), TEST_LATENCY_MS);
    expectPruned(run);
    expect(run.chain.of('official')).toHaveLength(1);
  });

  it('a JSON-RPC error inside a 200: pruned', async () => {
    const run = await pruneWith(official({ kind: 'rpcError' }));
    expectPruned(run);
  });

  it('every official call correctly after 1,400 ms: pruned, the official endpoint asked once', async () => {
    const run = await pruneWith(official({ kind: 'answer', delayMs: 1_400 }));
    expectPruned(run);
    expect(run.chain.of('official')).toHaveLength(1);
  });
});
