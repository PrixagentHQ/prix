import {
  HOLDER_POLLS,
  POLL_REFUSALS,
  POLL_VOTE_WRITE_ROWS,
  pollMeResponseSchema,
  pollsResponseSchema,
  pollVoteResponseSchema,
  TOKEN_RISE_HOLD_SECONDS,
} from '@prix/contracts';
import { tallyPoll } from '@prix/runtime/social/poll-tally';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb } from '../social/support/d1.ts';
import {
  ADMIN,
  AT_TIER,
  blockChain,
  CLOSES,
  createPollHarness,
  errorOf,
  HOUSE,
  OPENS,
  POLL,
  pollTables,
  tallyDeps,
  tokenWorld,
  wallet,
} from './support.ts';

/**
 * The holders' poll's vote and its attacks (docs/contracts/phase-6-holders.md sections 4.3, 4.4 and 11 C):
 * the real routes behind `createApp`, the real poll store on a local D1, a recording limiter and entitlements
 * port, and in the last part the real token service. Every refusal is followed by a read of the tables.
 */

const VOTE = `/api/polls/${POLL}/vote`;
const HOLDER = wallet(0xb1);
const SECOND = wallet(0xb2);
const POOR = wallet(0xc0);

function refused(reply: { status: number; json: unknown; text: string }, field: keyof typeof POLL_REFUSALS) {
  expect(reply.status, reply.text).toBe(POLL_REFUSALS[field]);
  expect(errorOf(reply as never)).toMatchObject({ code: 'invalid_input', field });
}

beforeEach(async () => {
  await resetDb();
});

describe('the vote, refused at every step, and what each refusal leaves', () => {
  it('answers 401 without a session before the limiter is asked, and writes nothing', async () => {
    const h = createPollHarness();
    const reply = await h.fetch('POST', VOTE, { body: { option: 'index-core' } });
    expect(reply.status).toBe(401);
    // The app's own read rule by IP runs for every request; no rule is asked for an address, and no write.
    expect(h.limiter.asked.filter((ask) => ask.subject.startsWith('0x'))).toEqual([]);
    expect(h.limiter.asks('write')).toBe(0);
    expect(h.tierReads).toEqual([]);
    expect((await pollTables()).votes).toEqual([]);
  });

  it('refuses a vote from another site and one with no Origin, with a session, and writes nothing', async () => {
    const h = createPollHarness();
    h.tiers.set(HOLDER, 3);
    const cookie = await h.signIn(HOLDER);
    for (const origin of ['https://evil.test', null]) {
      const reply = await h.fetch('POST', VOTE, { cookie, origin, body: { option: 'index-core' } });
      expect(reply.status, String(origin)).toBe(403);
    }
    expect(h.tierReads).toEqual([]);
    expect(h.limiter.asks('write')).toBe(0);
    expect((await pollTables()).votes).toEqual([]);
  });

  it('answers the generic 404 for a poll no one wrote, and 400 poll_unknown_option for an option not in the poll', async () => {
    const h = createPollHarness();
    h.tiers.set(HOLDER, 3);
    const cookie = await h.signIn(HOLDER);
    const unknown = await h.fetch('POST', '/api/polls/not-a-poll/vote', { cookie, body: { option: 'index-core' } });
    expect(unknown.status).toBe(404);
    refused(await h.fetch('POST', VOTE, { cookie, body: { option: 'crowd-favourites' } }), 'poll_unknown_option');
    expect(h.tierReads).toEqual([]);
    expect(h.limiter.asks('write')).toBe(0);
    expect((await pollTables()).votes).toEqual([]);
  });

  it('answers 409 poll_not_open before opensAt and 409 poll_closed at closesAt and after, with no tier read', async () => {
    const h = createPollHarness({ now: '2026-10-15T23:59:59.999Z' });
    h.tiers.set(HOLDER, 3);
    const cookie = await h.signIn(HOLDER);
    refused(await h.fetch('POST', VOTE, { cookie, body: { option: 'index-core' } }), 'poll_not_open');
    h.setNow(CLOSES);
    refused(await h.fetch('POST', VOTE, { cookie, body: { option: 'index-core' } }), 'poll_closed');
    h.setNow('2026-10-22T08:00:00.000Z');
    refused(await h.fetch('POST', VOTE, { cookie, body: { option: 'index-core' } }), 'poll_closed');
    expect(h.tierReads).toEqual([]);
    expect(h.limiter.asks('write')).toBe(0);
    expect((await pollTables()).votes).toEqual([]);
    // One millisecond before the close still takes a vote.
    h.setNow(new Date(Date.parse(CLOSES) - 1).toISOString());
    expect((await h.fetch('POST', VOTE, { cookie, body: { option: 'index-core' } })).status).toBe(200);
    // And from opensAt itself.
    h.setNow(OPENS);
    expect((await h.fetch('POST', VOTE, { cookie, body: { option: 'dip-buyer' } })).status).toBe(200);
  });

  it('refuses a wallet under tier 1 and while gating is off, with the write rule never asked', async () => {
    const h = createPollHarness();
    h.tiers.set(POOR, 0);
    const cookie = await h.signIn(POOR);
    refused(await h.fetch('POST', VOTE, { cookie, body: { option: 'index-core' } }), 'poll_not_holder');
    // The vote reads the tier without cachedOnly, so the hour before a rise applies.
    expect(h.tierReads).toEqual([{ address: POOR, cachedOnly: false }]);
    h.gate.on = false;
    refused(await h.fetch('POST', VOTE, { cookie, body: { option: 'index-core' } }), 'poll_gate_off');
    expect(h.limiter.asks('write')).toBe(0);
    expect((await pollTables()).votes).toEqual([]);
  });

  it('refuses an admin wallet and a house owner at tier 3 as poll_not_holder, with no entitlement read', async () => {
    const h = createPollHarness();
    for (const prix of [ADMIN, HOUSE]) {
      h.tiers.set(prix, 3);
      const cookie = await h.signIn(prix);
      refused(await h.fetch('POST', VOTE, { cookie, body: { option: 'index-core' } }), 'poll_not_holder');
    }
    expect(h.tierReads).toEqual([]);
    expect((await pollTables()).votes).toEqual([]);
  });

  it('spends the write rule once a stored vote, at step 6, and never on a refusal', async () => {
    const h = createPollHarness();
    h.tiers.set(HOLDER, 1);
    const cookie = await h.signIn(HOLDER);
    const before = h.limiter.asks('write');
    const reply = await h.fetch('POST', VOTE, { cookie, body: { option: 'index-core' } });
    expect(reply.status, reply.text).toBe(200);
    expect(pollVoteResponseSchema.parse(reply.json)).toEqual({ pollId: POLL, option: 'index-core' });
    expect(h.limiter.asks('write') - before).toBe(1);
    // A refusal at step 6 keeps the limiter's own code and writes nothing more.
    h.limiter.denied.add('write');
    const limited = await h.fetch('POST', VOTE, { cookie, body: { option: 'dip-buyer' } });
    expect(limited.status).toBe(429);
    expect((await pollTables()).votes.map((v) => v.option_id)).toEqual(['index-core']);
    expect(POLL_VOTE_WRITE_ROWS).toBe(3);
  });

  it('refuses votes past the read rule with 429 and no chain read, for a tier-0 wallet', async () => {
    const h = createPollHarness();
    const cookie = await h.signIn(POOR);
    h.limiter.denied.add('read');
    const reply = await h.fetch('POST', VOTE, { cookie, body: { option: 'index-core' } });
    expect(reply.status).toBe(429);
    expect(h.tierReads).toEqual([]);
  });
});

describe('voting twice, changing, and the counts beside the rows', () => {
  it('a vote, the same vote again, a change and a change back keep one row and poll_counts equal to the group-by', async () => {
    const h = createPollHarness();
    h.tiers.set(HOLDER, 2);
    h.tiers.set(SECOND, 1);
    const one = await h.signIn(HOLDER);
    const two = await h.signIn(SECOND);
    const steps: [string, string][] = [
      [one, 'index-core'],
      [one, 'index-core'],
      [two, 'index-core'],
      [one, 'dip-buyer'],
      [one, 'index-core'],
      [two, 'momentum-five'],
    ];
    for (const [cookie, option] of steps) {
      const reply = await h.fetch('POST', VOTE, { cookie, body: { option } });
      expect(reply.status, reply.text).toBe(200);
      const t = await pollTables();
      expect(t.countsByOption).toEqual(t.groupedByOption);
      expect(t.sum).toBe(t.votes.length);
    }
    const t = await pollTables();
    expect(t.votes.map((v) => [v.wallet, v.option_id])).toEqual([
      [HOLDER, 'index-core'],
      [SECOND, 'momentum-five'],
    ]);
  });

  it('GET /api/polls shows cast counts with no address and no per-wallet field, and the same body with a session', async () => {
    const h = createPollHarness();
    h.tiers.set(HOLDER, 1);
    const cookie = await h.signIn(HOLDER);
    await h.fetch('POST', VOTE, { cookie, body: { option: 'index-core' } });
    const anonymous = await h.fetch('GET', '/api/polls');
    expect(anonymous.status).toBe(200);
    const read = pollsResponseSchema.parse(anonymous.json);
    expect(read.polls[0]).toMatchObject({ state: 'open', result: null });
    expect(read.polls[0]?.cast).toMatchObject({ 'index-core': 1 });
    expect(anonymous.text).not.toMatch(/0x[0-9a-f]{40}/i);
    const signed = await h.fetch('GET', '/api/polls', { cookie });
    expect(signed.text).toBe(anonymous.text);
  });

  it('GET /api/polls/me refuses without a session and mirrors step 5 for each wallet apart', async () => {
    const h = createPollHarness();
    expect((await h.fetch('GET', '/api/polls/me')).status).toBe(401);
    h.tiers.set(HOLDER, 1);
    const holder = await h.signIn(HOLDER);
    const poor = await h.signIn(POOR);
    const admin = await h.signIn(ADMIN);
    await h.fetch('POST', VOTE, { cookie: holder, body: { option: 'dip-buyer' } });
    expect(pollMeResponseSchema.parse((await h.fetch('GET', '/api/polls/me', { cookie: holder })).json)).toEqual({
      pollId: POLL,
      option: 'dip-buyer',
      canVote: true,
      refusal: null,
    });
    const other = pollMeResponseSchema.parse((await h.fetch('GET', '/api/polls/me', { cookie: poor })).json);
    expect(other).toMatchObject({ pollId: POLL, option: null, canVote: false, refusal: 'poll_not_holder' });
    expect(pollMeResponseSchema.parse((await h.fetch('GET', '/api/polls/me', { cookie: admin })).json)).toMatchObject({
      canVote: false,
      refusal: 'poll_not_holder',
    });
  });
});

describe('the cap, under a change and under concurrency (section 4.2)', () => {
  it('stores the last voter at the cap, answers full to the next new wallet, and still lets a voter change', async () => {
    const h = createPollHarness();
    const cap = 3;
    for (let i = 1; i <= cap; i += 1) {
      expect(await h.polls.putVote(POLL, wallet(i), 'index-core', '2026-10-17T00:00:00.000Z', cap)).toBe('stored');
    }
    expect(await h.polls.putVote(POLL, wallet(99), 'index-core', '2026-10-17T00:00:01.000Z', cap)).toBe('full');
    expect(await h.polls.putVote(POLL, wallet(2), 'dip-buyer', '2026-10-17T00:00:02.000Z', cap)).toBe('stored');
    const t = await pollTables();
    expect(t.votes).toHaveLength(cap);
    expect(t.countsByOption).toEqual({ 'dip-buyer': 1, 'index-core': 2 });
    expect(t.countsByOption).toEqual(t.groupedByOption);
  });

  it('stores one of two concurrent new votes one below the cap', async () => {
    const h = createPollHarness();
    const cap = 2;
    await h.polls.putVote(POLL, wallet(1), 'index-core', '2026-10-17T00:00:00.000Z', cap);
    const answers = await Promise.all([
      h.polls.putVote(POLL, wallet(2), 'index-core', '2026-10-17T00:00:01.000Z', cap),
      h.polls.putVote(POLL, wallet(3), 'dip-buyer', '2026-10-17T00:00:01.000Z', cap),
    ]);
    expect(answers.filter((a) => a === 'stored')).toHaveLength(1);
    expect(answers.filter((a) => a === 'full')).toHaveLength(1);
    const t = await pollTables();
    expect(t.votes).toHaveLength(cap);
    expect(t.sum).toBe(cap);
  });
});

describe('the switch', () => {
  it('off, the vote and the three reads are the generic 404, and the admin tally is still mounted', async () => {
    const h = createPollHarness({ on: false });
    h.tiers.set(HOLDER, 3);
    const cookie = await h.signIn(HOLDER);
    expect((await h.fetch('POST', VOTE, { cookie, body: { option: 'index-core' } })).status).toBe(404);
    for (const path of ['/api/polls', '/api/polls/me', '/api/polls/status']) {
      expect((await h.fetch('GET', path, { cookie })).status, path).toBe(404);
    }
    // A stranger gets the generic 404 at the admin route too; an admin's session reaches the tally.
    expect((await h.fetch('POST', `/api/admin/polls/${POLL}/tally`, { cookie })).status).toBe(404);
    const admin = await h.signIn(ADMIN);
    const tally = await h.fetch('POST', `/api/admin/polls/${POLL}/tally`, { cookie: admin });
    expect(tally.status, tally.text).toBe(200);
    expect(h.tallied).toEqual([POLL]);
    // From another site the admin's session is refused.
    const cross = await h.fetch('POST', `/api/admin/polls/${POLL}/tally`, {
      cookie: admin,
      origin: 'https://evil.test',
    });
    expect(cross.status).not.toBe(200);
    expect(h.tallied).toEqual([POLL]);
  });
});

describe('on the real token service (step 5)', () => {
  it('refuses a tier that rose under the hold, takes the vote after the hour, and reads no chain for a wallet at the read rule', async () => {
    let world: ReturnType<typeof tokenWorld> | null = null;
    const h = createPollHarness({
      entitlements: (now) => {
        world = tokenWorld(now);
        return world.service;
      },
    });
    const w = world as unknown as ReturnType<typeof tokenWorld>;
    w.chain.balances.set(HOLDER, AT_TIER[1]);
    const cookie = await h.signIn(HOLDER);
    // The first read sees tier 1 and holds it for an hour: the vote is refused and nothing of the poll is written.
    refused(await h.fetch('POST', VOTE, { cookie, body: { option: 'index-core' } }), 'poll_not_holder');
    expect((await pollTables()).votes).toEqual([]);
    // What the refusal left is the service's own row, nothing of the poll.
    expect(w.rows.get(HOLDER)).toBeDefined();
    h.advance((TOKEN_RISE_HOLD_SECONDS + 1) * 1000);
    const stored = await h.fetch('POST', VOTE, { cookie, body: { option: 'index-core' } });
    expect(stored.status, stored.text).toBe(200);
    expect(h.tierReads.every((read) => read.cachedOnly === false)).toBe(true);
  });
});

describe('the same tokens passed between wallets before the close, and the count at the close', () => {
  it('counts a bundle that voted from two wallets once, at the tally block after the close', async () => {
    const h = createPollHarness();
    // A holds tier 1 and votes, then passes the tokens to B, which votes too: both rows are cast.
    h.tiers.set(HOLDER, 1);
    const a = await h.signIn(HOLDER);
    expect((await h.fetch('POST', VOTE, { cookie: a, body: { option: 'dip-buyer' } })).status).toBe(200);
    h.tiers.set(HOLDER, 0);
    h.tiers.set(SECOND, 1);
    const b = await h.signIn(SECOND);
    expect((await h.fetch('POST', VOTE, { cookie: b, body: { option: 'dip-buyer' } })).status).toBe(200);
    expect((await pollTables()).sum).toBe(2);

    // At the tally's block the tokens sit in B alone.
    const chain = blockChain(5_000);
    chain.set(HOLDER, AT_TIER[1], 100);
    chain.set(HOLDER, 0n, 200);
    chain.set(SECOND, AT_TIER[1], 200);
    const after = new Date(Date.parse(CLOSES) + 61_000);
    const { deps, logText } = tallyDeps(chain.reader, { now: () => after });
    const poll = HOLDER_POLLS[0];
    if (poll === undefined) throw new Error('no poll');
    expect(await tallyPoll(deps, poll)).toEqual({ outcome: 'done', step: null });
    const results = await deps.polls.getResults([POLL]);
    expect(results).toHaveLength(1);
    expect(results[0]?.cast).toMatchObject({ 'dip-buyer': 2 });
    expect(results[0]?.counted).toMatchObject({ 'dip-buyer': 1 });
    expect(logText()).not.toMatch(/0x[0-9a-f]{40}/i);
    // And the public read now shows the counted result, frozen.
    h.setNow(after.toISOString());
    const read = pollsResponseSchema.parse((await h.fetch('GET', '/api/polls')).json);
    expect(read.polls[0]).toMatchObject({ state: 'closed', cast: null });
    expect(read.polls[0]?.result?.counted).toMatchObject({ 'dip-buyer': 1 });
  });
});
