import {
  ADVICE_WORDS,
  entitlementsOfTier,
  HOLDER_POLLS,
  HOLDERS_FORBIDDEN_WORDS,
  isSocialSafeText,
  POLL_REFUSALS,
  POLL_VOTE_WRITE_ROWS,
  pollMeResponseSchema,
  pollsResponseSchema,
  pollTallyOutcomeSchema,
  pollVoteResponseSchema,
} from '@prix/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN, createHarness, errorOf, HOLDER, HOUSE, OTHER, stepsOf } from './holders-test-support.ts';
import { POLL_SENTENCES } from './polls/index.ts';

describe('the refusals sentences', () => {
  it('has one for every refusal, each passing the words rules of the round', () => {
    expect(Object.keys(POLL_SENTENCES).sort()).toEqual(Object.keys(POLL_REFUSALS).sort());
    for (const sentence of Object.values(POLL_SENTENCES)) {
      expect(HOLDERS_FORBIDDEN_WORDS.test(sentence), sentence).toBe(false);
      expect(ADVICE_WORDS.test(sentence), sentence).toBe(false);
      expect(isSocialSafeText(sentence), sentence).toBe(true);
    }
  });
});

// The holders' poll's routes (docs/contracts/phase-6-holders.md sections 4.3 and 4.4).

const POLL = HOLDER_POLLS[0];
if (POLL === undefined) throw new Error('no poll');
const VOTE = `/api/polls/${POLL.id}/vote`;

let logs: string[] = [];
beforeEach(() => {
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => logs.push(String(line)));
  vi.spyOn(console, 'error').mockImplementation((line: string) => logs.push(String(line)));
});
afterEach(() => vi.restoreAllMocks());

function holderHarness() {
  const h = createHarness();
  h.tiers.set(HOLDER, entitlementsOfTier(1));
  h.tiers.set(OTHER, entitlementsOfTier(2));
  h.tiers.set(ADMIN, entitlementsOfTier(3));
  h.tiers.set(HOUSE, entitlementsOfTier(3));
  return h;
}

describe('POST /api/polls/:id/vote', () => {
  it('stores a vote of a tier-1 wallet in the order of section 4.3', async () => {
    const h = holderHarness();
    const cookie = await h.signIn(HOLDER);
    h.trace.length = 0;
    const reply = await h.fetch('POST', VOTE, { cookie, body: { option: 'index-core' } });
    expect(reply.status).toBe(200);
    expect(pollVoteResponseSchema.parse(reply.json)).toEqual({ pollId: POLL.id, option: 'index-core' });
    expect(reply.headers.get('cache-control')).toBe('no-store');
    expect(stepsOf(h.trace)).toEqual([
      `limiter:read:${HOLDER}`,
      'entitlements:full',
      `limiter:write:${HOLDER}`,
      'store.spendWalletWrite',
      `store.spendApiWrites:${POLL_VOTE_WRITE_ROWS}`,
      'polls.putVote:index-core',
    ]);
    expect(h.asked).toEqual([{ address: HOLDER, options: undefined }]);
  });

  it('a change and a change back keep the counts equal to the rows', async () => {
    const h = holderHarness();
    const cookie = await h.signIn(HOLDER);
    await h.fetch('POST', VOTE, { cookie, body: { option: 'index-core' } });
    await h.fetch('POST', VOTE, { cookie, body: { option: 'dip-buyer' } });
    expect(await h.polls.castCounts(POLL.id)).toEqual({ 'index-core': 0, 'dip-buyer': 1 });
    await h.fetch('POST', VOTE, { cookie, body: { option: 'index-core' } });
    expect(await h.polls.castCounts(POLL.id)).toEqual({ 'index-core': 1, 'dip-buyer': 0 });
  });

  it('refuses a request from another site before the session, and leaves nothing', async () => {
    const h = holderHarness();
    const cookie = await h.signIn(HOLDER);
    const before = h.ledger();
    h.trace.length = 0;
    const reply = await h.fetch('POST', VOTE, { cookie, body: { option: 'index-core' }, origin: 'https://evil.test' });
    expect(reply.status).toBe(403);
    expect(h.trace).not.toContain('store.getSession');
    expect(h.ledger()).toEqual(before);
  });

  it('answers 401 without a session, before the limiter', async () => {
    const h = holderHarness();
    h.limiter.denied.add('write');
    const reply = await h.fetch('POST', VOTE, { body: { option: 'index-core' } });
    expect(reply.status).toBe(401);
    expect(stepsOf(h.trace)).toEqual([]);
  });

  it('a wallet past the read rule gets 429 and causes no entitlement read', async () => {
    const h = holderHarness();
    const cookie = await h.signIn(HOLDER);
    h.trace.length = 0;
    h.limiter.denied.add('read');
    const reply = await h.fetch('POST', VOTE, { cookie, body: { option: 'index-core' } });
    expect(reply.status).toBe(429);
    expect(errorOf(reply).code).toBe('rate_limited');
    expect(h.asked).toEqual([]);
  });

  it('answers the generic 404 for an unknown poll, before the body is read', async () => {
    const h = holderHarness();
    const cookie = await h.signIn(HOLDER);
    const before = h.ledger();
    const reply = await h.fetch('POST', '/api/polls/no-such-poll/vote', { cookie, body: { option: 'index-core' } });
    expect(reply.status).toBe(404);
    expect(errorOf(reply).message).toBe('There is no such API route. Check the address and the method.');
    expect(h.asked).toEqual([]);
    expect(h.ledger()).toEqual(before);
  });

  it('keeps the reader own answer for a body the schema refuses', async () => {
    const h = holderHarness();
    const cookie = await h.signIn(HOLDER);
    const reply = await h.fetch('POST', VOTE, { cookie, body: { option: 'index-core', extra: 1 } });
    expect(reply.status).toBe(400);
    expect(errorOf(reply).field).not.toBe('poll_unknown_option');
    expect(h.asked).toEqual([]);
  });

  it('refuses an option that is not the poll own with 400 poll_unknown_option, leaving nothing', async () => {
    const h = holderHarness();
    const cookie = await h.signIn(HOLDER);
    const before = h.ledger();
    const reply = await h.fetch('POST', VOTE, { cookie, body: { option: 'crowd-favourites' } });
    expect(reply.status).toBe(POLL_REFUSALS.poll_unknown_option);
    expect(errorOf(reply)).toMatchObject({ code: 'invalid_input', field: 'poll_unknown_option' });
    expect(h.asked).toEqual([]);
    expect(h.ledger()).toEqual(before);
  });

  it('refuses before opensAt with 409 poll_not_open and at closesAt with 409 poll_closed', async () => {
    const h = holderHarness();
    const cookie = await h.signIn(HOLDER);
    const before = h.ledger();
    h.setNow(new Date(Date.parse(POLL.opensAt) - 1).toISOString());
    const early = await h.fetch('POST', VOTE, { cookie, body: { option: 'index-core' } });
    expect(early.status).toBe(409);
    expect(errorOf(early)).toMatchObject({ code: 'invalid_input', field: 'poll_not_open' });
    h.setNow(POLL.closesAt);
    const late = await h.fetch('POST', VOTE, { cookie, body: { option: 'index-core' } });
    expect(late.status).toBe(409);
    expect(errorOf(late)).toMatchObject({ code: 'invalid_input', field: 'poll_closed' });
    expect(h.asked).toEqual([]);
    expect(h.ledger()).toEqual(before);
  });

  it('refuses an admin wallet and a house owner at tier 3 with poll_not_holder and no entitlement read', async () => {
    const h = holderHarness();
    for (const wallet of [ADMIN, HOUSE]) {
      const cookie = await h.signIn(wallet);
      const reply = await h.fetch('POST', VOTE, { cookie, body: { option: 'index-core' } });
      expect(reply.status).toBe(403);
      expect(errorOf(reply)).toMatchObject({ code: 'invalid_input', field: 'poll_not_holder' });
    }
    expect(h.asked).toEqual([]);
    expect(h.spent).toEqual({ walletWrites: 0, rows: 0 });
  });

  it('refuses with gating off (poll_gate_off) and at tier 0 (poll_not_holder), spending no write', async () => {
    const h = holderHarness();
    h.tiers.set(HOLDER, { ...entitlementsOfTier(0), gatingOn: false });
    const cookie = await h.signIn(HOLDER);
    const off = await h.fetch('POST', VOTE, { cookie, body: { option: 'index-core' } });
    expect(off.status).toBe(403);
    expect(errorOf(off).field).toBe('poll_gate_off');
    h.tiers.set(HOLDER, entitlementsOfTier(0));
    const zero = await h.fetch('POST', VOTE, { cookie, body: { option: 'index-core' } });
    expect(zero.status).toBe(403);
    expect(errorOf(zero).field).toBe('poll_not_holder');
    expect(h.spent).toEqual({ walletWrites: 0, rows: 0 });
    expect(h.asked.every((entry) => entry.options === undefined)).toBe(true);
  });

  it('answers 409 poll_full when the store is at the cap, the rows booked', async () => {
    const h = holderHarness();
    h.polls.counts.set(`${POLL.id}|index-core`, 4_000);
    const cookie = await h.signIn(HOLDER);
    const reply = await h.fetch('POST', VOTE, { cookie, body: { option: 'dip-buyer' } });
    expect(reply.status).toBe(409);
    expect(errorOf(reply).field).toBe('poll_full');
    expect(h.spent.rows).toBe(POLL_VOTE_WRITE_ROWS);
  });

  it('spends the write rule once, at step 6, and its refusal keeps its own code', async () => {
    const h = holderHarness();
    h.limiter.denied.add('write');
    const cookie = await h.signIn(HOLDER);
    const reply = await h.fetch('POST', VOTE, { cookie, body: { option: 'index-core' } });
    expect(reply.status).toBe(429);
    expect(h.trace.filter((step) => step.startsWith('limiter:write:'))).toEqual([`limiter:write:${HOLDER}`]);
    expect(h.trace).toContain('entitlements:full');
    expect(h.polls.votes.size).toBe(0);
  });
});

describe('GET /api/polls', () => {
  it('lists the open poll with the votes cast and no per-wallet field, public for 30 seconds', async () => {
    const h = holderHarness();
    const cookie = await h.signIn(HOLDER);
    await h.fetch('POST', VOTE, { cookie, body: { option: 'momentum-five' } });
    const reply = await h.fetch('GET', '/api/polls');
    expect(reply.status).toBe(200);
    expect(reply.headers.get('cache-control')).toBe('public, max-age=30');
    const body = pollsResponseSchema.parse(reply.json);
    expect(body.minTokens).toBe(10_000);
    expect(body.polls).toHaveLength(1);
    expect(body.polls[0]).toMatchObject({ id: POLL.id, state: 'open', result: null });
    expect(body.polls[0]?.cast).toEqual({ 'big-tech-equal': 0, 'index-core': 0, 'momentum-five': 1, 'dip-buyer': 0 });
    expect(reply.text).not.toContain(HOLDER);
    expect(reply.text.toLowerCase()).not.toContain('0x');
  });

  it('never lists an upcoming poll', async () => {
    const h = holderHarness();
    h.setNow('2026-10-15T23:59:59.000Z');
    const body = pollsResponseSchema.parse((await h.fetch('GET', '/api/polls')).json);
    expect(body.polls).toEqual([]);
  });

  it('moves the state from open to counting, uncounted and closed', async () => {
    const h = holderHarness();
    h.setNow('2026-10-22T00:00:00.000Z');
    expect(pollsResponseSchema.parse((await h.fetch('GET', '/api/polls')).json).polls[0]?.state).toBe('counting');
    h.setNow('2026-10-29T00:00:00.000Z');
    expect(pollsResponseSchema.parse((await h.fetch('GET', '/api/polls')).json).polls[0]?.state).toBe('uncounted');
    h.polls.results.push({
      pollId: POLL.id,
      cast: { 'index-core': 3, 'dip-buyer': 3 },
      counted: { 'index-core': 2, 'dip-buyer': 2, 'big-tech-equal': 0, 'momentum-five': 0 },
      leaders: [],
      countedAt: '2026-10-21T20:30:00.000Z',
      firstBlock: 90,
      lastBlock: 90,
    });
    const closed = pollsResponseSchema.parse((await h.fetch('GET', '/api/polls')).json).polls[0];
    expect(closed?.state).toBe('closed');
    expect(closed?.cast).toBeNull();
    expect(closed?.result?.leaders).toEqual(['index-core', 'dip-buyer']);
    expect(closed?.result?.countedAt).toBe('2026-10-21T20:30:00.000Z');
  });

  it('answers the same body with a session cookie as without, and ignores a query', async () => {
    const h = holderHarness();
    const cookie = await h.signIn(HOLDER);
    await h.fetch('POST', VOTE, { cookie, body: { option: 'dip-buyer' } });
    const plain = await h.fetch('GET', '/api/polls');
    const signed = await h.fetch('GET', '/api/polls?wallet=me', { cookie });
    expect(signed.text).toBe(plain.text);
    expect(signed.headers.get('cache-control')).toBe('public, max-age=30');
  });
});

describe('GET /api/polls/me', () => {
  it('refuses without a session', async () => {
    const h = holderHarness();
    expect((await h.fetch('GET', '/api/polls/me')).status).toBe(401);
  });

  it('mirrors step 5 and names the wallet own choice, never cached', async () => {
    const h = holderHarness();
    const cookie = await h.signIn(HOLDER);
    await h.fetch('POST', VOTE, { cookie, body: { option: 'dip-buyer' } });
    h.asked.length = 0;
    const reply = await h.fetch('GET', '/api/polls/me', { cookie });
    expect(reply.headers.get('cache-control')).toBe('no-store');
    expect(pollMeResponseSchema.parse(reply.json)).toEqual({
      pollId: POLL.id,
      option: 'dip-buyer',
      canVote: true,
      refusal: null,
    });
    expect(h.asked).toEqual([{ address: HOLDER, options: undefined }]);

    const admin = await h.signIn(ADMIN);
    h.asked.length = 0;
    expect((await h.fetch('GET', '/api/polls/me', { cookie: admin })).json).toEqual({
      pollId: POLL.id,
      option: null,
      canVote: false,
      refusal: 'poll_not_holder',
    });
    expect(h.asked).toEqual([]);

    h.tiers.set(HOLDER, { ...entitlementsOfTier(0), gatingOn: false });
    expect((await h.fetch('GET', '/api/polls/me', { cookie })).json.refusal).toBe('poll_gate_off');
  });

  it('answers no poll when none is open', async () => {
    const h = holderHarness();
    const cookie = await h.signIn(HOLDER);
    h.setNow('2026-10-22T00:00:00.000Z');
    expect((await h.fetch('GET', '/api/polls/me', { cookie })).json).toEqual({
      pollId: null,
      option: null,
      canVote: false,
      refusal: null,
    });
  });

  it('never answers one wallet with another wallet body', async () => {
    const h = holderHarness();
    const first = await h.signIn(HOLDER);
    const second = await h.signIn(OTHER);
    await h.fetch('POST', VOTE, { cookie: first, body: { option: 'dip-buyer' } });
    expect((await h.fetch('GET', '/api/polls/me', { cookie: second })).json.option).toBeNull();
  });
});

describe('GET /api/polls/status and the switch', () => {
  it('answers on while the switch is on', async () => {
    const h = holderHarness();
    const reply = await h.fetch('GET', '/api/polls/status');
    expect(reply.status).toBe(200);
    expect(reply.json).toEqual({ on: true });
  });

  it('switched off, every path is the generic 404 but the admin tally', async () => {
    const h = createHarness({ pollsEnabled: false });
    const cookie = await h.signIn(HOLDER);
    for (const [method, path] of [
      ['GET', '/api/polls'],
      ['GET', '/api/polls/me'],
      ['GET', '/api/polls/status'],
      ['POST', VOTE],
    ] as const) {
      const reply = await h.fetch(method, path, {
        cookie,
        body: method === 'POST' ? { option: 'dip-buyer' } : undefined,
      });
      expect(reply.status, path).toBe(404);
      expect(errorOf(reply).message).toBe('There is no such API route. Check the address and the method.');
    }
    const admin = await h.signIn(ADMIN);
    const tally = await h.fetch('POST', `/api/admin/polls/${POLL.id}/tally`, { cookie: admin });
    expect(tally.status).toBe(200);
  });

  it('not given, nothing is mounted', async () => {
    const h = createHarness({ pollsGiven: false });
    expect((await h.fetch('GET', '/api/polls')).status).toBe(404);
  });
});

describe('POST /api/admin/polls/:id/tally', () => {
  it('runs the tally for an admin and answers its outcome as it is', async () => {
    const h = holderHarness();
    h.tally.outcome = { outcome: 'failed', step: 'block' };
    const admin = await h.signIn(ADMIN);
    const reply = await h.fetch('POST', `/api/admin/polls/${POLL.id}/tally`, { cookie: admin });
    expect(reply.status).toBe(200);
    expect(pollTallyOutcomeSchema.parse(reply.json)).toEqual({ outcome: 'failed', step: 'block' });
    expect(reply.headers.get('cache-control')).toBe('no-store');
    expect(h.tally.asked).toEqual([POLL.id]);
    expect(logs.join('\n')).not.toMatch(/0x[0-9a-f]{40}/i);
  });

  it('answers the generic 404 to anyone else, for an unknown poll and from another site', async () => {
    const h = holderHarness();
    const holder = await h.signIn(HOLDER);
    const admin = await h.signIn(ADMIN);
    const notAdmin = await h.fetch('POST', `/api/admin/polls/${POLL.id}/tally`, { cookie: holder });
    expect(notAdmin.status).toBe(404);
    const unknown = await h.fetch('POST', '/api/admin/polls/no-such-poll/tally', { cookie: admin });
    expect(unknown.status).toBe(404);
    const foreign = await h.fetch('POST', `/api/admin/polls/${POLL.id}/tally`, {
      cookie: admin,
      origin: 'https://evil.test',
    });
    expect(foreign.status).toBe(404);
    expect(h.tally.asked).toEqual([]);
  });

  it('never throws: a tally that throws answers failed at read, with no address logged', async () => {
    const h = holderHarness();
    h.tally.throws = true;
    const admin = await h.signIn(ADMIN);
    const reply = await h.fetch('POST', `/api/admin/polls/${POLL.id}/tally`, { cookie: admin });
    expect(reply.status).toBe(200);
    expect(reply.json).toEqual({ outcome: 'failed', step: 'read' });
    expect(logs.join('\n')).not.toMatch(/0x[0-9a-f]{40}/i);
  });
});
