import {
  API_WRITE_ROWS_PER_DAY,
  entitlementsOfTier,
  ROOM_MESSAGES_PER_HOUR,
  ROOM_MESSAGES_PER_WALLET_PER_DAY,
  ROOM_PAGE,
  ROOM_POST_WRITE_ROWS,
  ROOM_REFUSALS,
  ROOM_SCAN,
  ROOM_SECONDS_BETWEEN,
  ROOM_TEXT_PROBLEMS,
  ROOM_WRITE_MIN_TOKENS,
  type RoomRefusalField,
  type RoomTextProblem,
  type RoomWaitField,
  roomDayKey,
  roomHourKey,
  roomMeResponseSchema,
  roomPostResponseSchema,
  roomResponseSchema,
  roomRetryAfterSeconds,
  roomStatusResponseSchema,
  roomTextProblem,
  TOKEN_CACHE_SECONDS,
  WALLET_WRITES_PER_DAY,
} from '@prix/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shortAddress } from '../../views.ts';
import {
  ADMIN,
  createHarness,
  DAY,
  errorOf,
  type Harness,
  HOLDER,
  OTHER,
  type Reply,
  SITE_HOST,
  START,
  STRANGER,
  stepsOf,
  TOKEN,
} from './test-support.ts';

/**
 * The room's public and writer routes against docs/contracts/phase-6-room.md: section 5 (the order of the
 * write and what each refusal leaves), section 3 (what an admin passes), section 6 (the reads) and section
 * 8 (the routes and the switch). A store in memory, no D1.
 */

const HOUR_KEY = roomHourKey(DAY, 12);
const DAY_KEY = roomDayKey(DAY);
const GOOD = 'Good morning to the whole league';

/** A refusal of the room: `invalid_input`, the field, and the status the contract puts beside it. */
function expectRefusal(reply: Reply, field: RoomRefusalField): void {
  expect(reply.status).toBe(ROOM_REFUSALS[field]);
  expect(errorOf(reply).code).toBe('invalid_input');
  expect(errorOf(reply).field).toBe(field);
  expect(errorOf(reply).message.length).toBeGreaterThan(20);
  expect(reply.headers.get('Cache-Control')).toBe('no-store');
  // The four 429s tell when to try again, in whole seconds; no other refusal ends by waiting.
  if (ROOM_REFUSALS[field] === 429) expect(reply.headers.get('Retry-After')).toMatch(/^[1-9]\d*$/);
  else expect(reply.headers.get('Retry-After')).toBeNull();
}

async function post(h: Harness, cookie: string | undefined, text: unknown = GOOD): Promise<Reply> {
  return h.fetch('POST', '/api/social/room', { body: { text }, ...(cookie === undefined ? {} : { cookie }) });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the switch (section 8)', () => {
  const paths: [string, string][] = [
    ['GET', '/api/social/room/status'],
    ['GET', '/api/social/room'],
    ['GET', '/api/social/room/me'],
    ['POST', '/api/social/room'],
  ];

  it.each([
    ['the entry does not hand the room over', { given: false }],
    ['the room is handed over with its switch off', { roomEnabled: false }],
  ])('answers the generic 404 on all four routes while %s', async (_name, options) => {
    const h = createHarness(options);
    const cookie = await h.signIn(HOLDER);
    const unknown = await h.fetch('GET', '/api/social/no-such-route');
    expect(unknown.status).toBe(404);
    for (const [method, path] of paths) {
      const reply = await h.fetch(method, path, { cookie, ...(method === 'POST' ? { body: { text: GOOD } } : {}) });
      expect(reply.status, `${method} ${path}`).toBe(404);
      expect(reply.text, `${method} ${path}`).toBe(unknown.text);
    }
    expect(h.room.messages).toEqual([]);
    expect(stepsOf(h.trace)).toEqual([]);
  });

  it('answers the status as a public read while the room is on', async () => {
    const h = createHarness();
    const reply = await h.fetch('GET', '/api/social/room/status');
    expect(reply.status).toBe(200);
    expect(roomStatusResponseSchema.parse(reply.json)).toEqual({ on: true });
    expect(reply.headers.get('Cache-Control')).toBe('public, max-age=30');
    expect(stepsOf(h.trace)).toEqual([]);
  });
});

describe('GET /api/social/room (section 6)', () => {
  it('answers the newest messages with the short address and never the whole one', async () => {
    const h = createHarness();
    h.room.seed(HOLDER, 'first line', '2026-10-20T11:00:00.000Z');
    h.room.seed(ADMIN, 'a word from an admin', '2026-10-20T11:01:00.000Z');
    const reply = await h.fetch('GET', '/api/social/room');
    expect(reply.status).toBe(200);
    const body = roomResponseSchema.parse(reply.json);
    expect(body.messages).toEqual([
      {
        id: 2,
        at: '2026-10-20T11:01:00.000Z',
        authorShort: shortAddress(ADMIN),
        admin: true,
        text: 'a word from an admin',
      },
      { id: 1, at: '2026-10-20T11:00:00.000Z', authorShort: shortAddress(HOLDER), admin: false, text: 'first line' },
    ]);
    expect(body.prixAddress).toBe(TOKEN);
    expect(body.siteHost).toBe(SITE_HOST);
    // The one whole address of the answer is the token's.
    expect(reply.text.match(/0x[0-9a-fA-F]{40}/g)).toEqual([TOKEN]);
    expect(reply.headers.get('Cache-Control')).toBe('public, max-age=30');
  });

  it('asks the store for ROOM_PAGE of the newest ROOM_SCAN ids, whatever the query says, and reads no session', async () => {
    const h = createHarness();
    const cookie = await h.signIn(HOLDER);
    for (const path of ['/api/social/room', '/api/social/room?before=1', '/api/social/room?limit=500&scan=9999']) {
      h.trace.length = 0;
      const reply = await h.fetch('GET', path, { cookie });
      expect(reply.status, path).toBe(200);
      expect(
        h.trace.filter((step) => step.startsWith('room.')),
        path,
      ).toEqual([`room.listNewest:${ROOM_PAGE}:${ROOM_SCAN}`]);
      expect(h.trace, path).not.toContain('store.getSession');
    }
  });

  it('marks an admin by the author in lower case, whatever the case of the configured address', async () => {
    const h = createHarness();
    h.room.seed(ADMIN.toUpperCase().replace('0X', '0x'), 'stored in another case', '2026-10-20T11:00:00.000Z');
    const body = roomResponseSchema.parse((await h.fetch('GET', '/api/social/room')).json);
    expect(body.messages[0]?.admin).toBe(true);
  });

  it('answers null for the token while it has no address', async () => {
    const h = createHarness({ prixAddress: null });
    const body = roomResponseSchema.parse((await h.fetch('GET', '/api/social/room')).json);
    expect(body.prixAddress).toBeNull();
    expect(body.messages).toEqual([]);
  });
});

describe('GET /api/social/room/me (section 6 and the schema)', () => {
  async function me(h: Harness, address: string): Promise<Reply> {
    return h.fetch('GET', '/api/social/room/me', { cookie: await h.signIn(address) });
  }

  it('is 401 without a session', async () => {
    const h = createHarness();
    const reply = await h.fetch('GET', '/api/social/room/me');
    expect(reply.status).toBe(401);
    expect(errorOf(reply).code).toBe('unauthorized');
    expect(stepsOf(h.trace)).toEqual([]);
  });

  it('answers yes with what is left of the wallet today, reads the holding without cachedOnly, and is never cached', async () => {
    const h = createHarness();
    h.room.setWriter(HOLDER, { lastAt: '2026-10-20T09:00:00.000Z', day: DAY, count: 4 });
    const reply = await me(h, HOLDER);
    expect(reply.status).toBe(200);
    expect(roomMeResponseSchema.parse(reply.json)).toEqual({
      write: 'yes',
      left: ROOM_MESSAGES_PER_WALLET_PER_DAY - 4,
    });
    expect(reply.headers.get('Cache-Control')).toBe('no-store');
    // One read of the holding, and not from the stored row only: it is this call that reads a new holding.
    expect(h.holding.asked).toHaveLength(1);
    expect(h.holding.asked[0]?.address).toBe(HOLDER);
    expect(h.holding.asked[0]?.options?.cachedOnly ?? false).toBe(false);
    expect(h.trace).toContain('holding:full');
    expect(h.entitlements.asked).toEqual([]);
  });

  it('answers yes to a wallet with ROOM_WRITE_MIN_TOKENS and not_holder to a wallet with less or with none', async () => {
    const h = createHarness();
    expect(ROOM_WRITE_MIN_TOKENS).toBe(1);
    h.holding.tokens.set(HOLDER, ROOM_WRITE_MIN_TOKENS);
    expect((await me(h, HOLDER)).json).toEqual({ write: 'yes', left: ROOM_MESSAGES_PER_WALLET_PER_DAY });
    h.holding.tokens.set(HOLDER, ROOM_WRITE_MIN_TOKENS - 1);
    expect((await me(h, HOLDER)).json).toEqual({ write: 'not_holder', left: 0 });
    // A wallet the token service has nothing for.
    expect((await me(h, STRANGER)).json).toEqual({ write: 'not_holder', left: 0 });
    expect(h.entitlements.asked).toEqual([]);
  });

  it('asks no tier: a wallet at tier 0 with one token is yes, a wallet at the highest tier with none is not', async () => {
    const h = createHarness();
    h.entitlements.value = entitlementsOfTier(0);
    expect((await me(h, HOLDER)).json).toEqual({ write: 'yes', left: ROOM_MESSAGES_PER_WALLET_PER_DAY });
    h.entitlements.value = entitlementsOfTier(3);
    expect((await me(h, STRANGER)).json).toEqual({ write: 'not_holder', left: 0 });
    expect(h.entitlements.asked).toEqual([]);
    expect(h.trace.filter((step) => step.startsWith('entitlements'))).toEqual([]);
  });

  it('asks the holding of the session’s own wallet, in lower case', async () => {
    const h = createHarness();
    const reply = await me(h, HOLDER.toUpperCase().replace('0X', '0x'));
    expect(roomMeResponseSchema.parse(reply.json).write).toBe('yes');
    expect(h.holding.asked.map((ask) => ask.address)).toEqual([HOLDER]);
  });

  it('answers not_holder for a holding that is no number', async () => {
    const h = createHarness();
    h.holding.tokens.set(HOLDER, Number.NaN);
    expect((await me(h, HOLDER)).json).toEqual({ write: 'not_holder', left: 0 });
  });

  it('counts a new day from the start, and a wallet that never wrote has the whole day', async () => {
    const h = createHarness();
    h.room.setWriter(HOLDER, { lastAt: '2026-10-19T09:00:00.000Z', day: '2026-10-19', count: 30 });
    expect((await me(h, HOLDER)).json).toEqual({ write: 'yes', left: ROOM_MESSAGES_PER_WALLET_PER_DAY });
    expect((await me(h, OTHER)).json).toEqual({ write: 'yes', left: ROOM_MESSAGES_PER_WALLET_PER_DAY });
  });

  it('answers yes with nothing left at the cap of the day', async () => {
    const h = createHarness();
    h.room.setWriter(HOLDER, { day: DAY, count: ROOM_MESSAGES_PER_WALLET_PER_DAY });
    expect((await me(h, HOLDER)).json).toEqual({ write: 'yes', left: 0 });
  });

  it('answers gate_off first, then not_holder, then muted, each with nothing left', async () => {
    const h = createHarness();
    h.room.setWriter(HOLDER, { mutedAt: START, mutedBy: ADMIN, cutAt: START });
    // The gate is judged by itself: a holding, however large, does not open a gate that is off.
    h.holding.gatingOn = false;
    h.holding.tokens.set(HOLDER, 5_000_000);
    expect((await me(h, HOLDER)).json).toEqual({ write: 'gate_off', left: 0 });
    h.holding.tokens.set(HOLDER, 0);
    expect((await me(h, HOLDER)).json).toEqual({ write: 'gate_off', left: 0 });
    h.holding.gatingOn = true;
    expect((await me(h, HOLDER)).json).toEqual({ write: 'not_holder', left: 0 });
    h.holding.tokens.set(HOLDER, ROOM_WRITE_MIN_TOKENS);
    expect((await me(h, HOLDER)).json).toEqual({ write: 'muted', left: 0 });
  });

  it('is never cached, whatever it answers: a refusal, a mute or an admin’s yes', async () => {
    const h = createHarness();
    const answers: [string, Reply][] = [];
    h.holding.gatingOn = false;
    answers.push(['gate_off', await me(h, HOLDER)]);
    h.holding.gatingOn = true;
    answers.push(['not_holder', await me(h, STRANGER)]);
    h.room.setWriter(OTHER, { mutedAt: START, mutedBy: ADMIN, cutAt: START });
    answers.push(['muted', await me(h, OTHER)]);
    answers.push(['yes', await me(h, ADMIN)]);
    for (const [write, reply] of answers) {
      expect(roomMeResponseSchema.parse(reply.json).write).toBe(write);
      expect(reply.headers.get('Cache-Control'), write).toBe('no-store');
    }
  });

  it('answers yes to an admin while the gate is off, without a read of a holding or a tier', async () => {
    const h = createHarness();
    h.holding.gatingOn = false;
    const reply = await me(h, ADMIN);
    expect(roomMeResponseSchema.parse(reply.json).write).toBe('yes');
    expect(h.holding.asked).toEqual([]);
    expect(h.entitlements.asked).toEqual([]);
  });

  it('answers yes with the whole day to an admin, whatever its writer’s row says', async () => {
    const h = createHarness();
    // Muted before it became an admin, and at the cap of the day.
    h.room.setWriter(ADMIN, {
      lastAt: START,
      day: DAY,
      count: ROOM_MESSAGES_PER_WALLET_PER_DAY,
      mutedAt: '2026-10-20T10:00:00.000Z',
      mutedBy: OTHER,
      cutAt: '2026-10-20T10:00:00.000Z',
    });
    const reply = await me(h, ADMIN);
    expect(roomMeResponseSchema.parse(reply.json)).toEqual({ write: 'yes', left: ROOM_MESSAGES_PER_WALLET_PER_DAY });
  });
});

describe('POST /api/social/room: the eight steps in order (section 5)', () => {
  it('runs the steps of a holder in the order of the contract and stores the folded text', async () => {
    const h = createHarness();
    const cookie = await h.signIn(HOLDER);
    h.trace.length = 0;
    const reply = await post(h, cookie, '  Good   morning\tto the \n whole league  ');
    expect(reply.status).toBe(201);
    const body = roomPostResponseSchema.parse(reply.json);
    expect(body).toEqual({
      message: { id: 1, at: START, authorShort: shortAddress(HOLDER), admin: false, text: GOOD },
      left: ROOM_MESSAGES_PER_WALLET_PER_DAY - 1,
    });
    expect(reply.headers.get('Cache-Control')).toBe('no-store');
    expect(reply.text).not.toContain(HOLDER);
    expect(stepsOf(h.trace)).toEqual([
      // 1: the limiter's `write` rule right after the session
      `limiter:write:${HOLDER}`,
      // 2: the text, with the token's address from the server
      'prixAddress',
      // 3: who may write, from the stored read of the wallet's holding
      'holding:cachedOnly',
      // 4: looked at and not taken: the writer's row, then the room's two counts in one call
      'room.getWriter',
      `room.getCounts:${HOUR_KEY}:${DAY_KEY}`,
      // 5: requireWriter: the limiter once more, the wallet's write of the day, the day's rows
      `limiter:write:${HOLDER}`,
      'store.spendWalletWrite',
      `store.spendApiWrites:${ROOM_POST_WRITE_ROWS}`,
      // 6: the writer's turn, the sender's own, before anything of the room is taken
      'room.takeTurn',
      // 7: the room's hour, then the room's day
      `counter.take:${HOUR_KEY}`,
      `counter.take:${DAY_KEY}`,
      // 8: the message
      'room.putMessage',
    ]);
    expect(h.room.messages).toEqual([{ id: 1, at: START, author: HOLDER, text: GOOD, hiddenAt: null, hiddenBy: null }]);
    expect(h.counters.get(HOUR_KEY)).toBe(1);
    expect(h.counters.get(DAY_KEY)).toBe(1);
    expect(h.spent).toEqual({ walletWrites: 1, rows: ROOM_POST_WRITE_ROWS });
  });

  it('reads the clock once, after step 3, and every later step stands on that one reading', async () => {
    const h = createHarness();
    const cookie = await h.signIn(HOLDER);
    // Every reading of the clock is in another hour, so a second reading by the route would show.
    h.clock.stepMs = 61 * 60_000;
    h.trace.length = 0;
    h.clock.reads.length = 0;
    const reply = await post(h, cookie);
    expect(reply.status).toBe(201);
    const allowed = h.trace.indexOf('holding:cachedOnly');
    expect(allowed).toBeGreaterThan(0);
    const looked = h.trace.indexOf('room.getWriter');
    // Nothing of the route reads the clock before who may write is settled; the session's own read is the guard's.
    expect(h.trace.slice(0, allowed).filter((step) => step === 'clock')).toHaveLength(1);
    expect(h.trace.slice(allowed + 1, looked)).toEqual(['clock']);
    const now = h.clock.reads[1] as string;
    const day = now.slice(0, 10);
    const hourKey = roomHourKey(day, new Date(now).getUTCHours());
    expect(hourKey).not.toBe(HOUR_KEY);
    expect(roomPostResponseSchema.parse(reply.json).message.at).toBe(now);
    expect(h.room.writers.get(HOLDER)).toMatchObject({ lastAt: now, day, count: 1 });
    expect(h.trace).toContain(`room.getCounts:${hourKey}:${roomDayKey(day)}`);
    expect([...h.counters.entries()].sort()).toEqual(
      [
        [hourKey, 1],
        [roomDayKey(day), 1],
      ].sort(),
    );
  });

  it('stores the author in lower case, whatever the case of the session', async () => {
    const h = createHarness();
    const reply = await post(h, await h.signIn(HOLDER.toUpperCase().replace('0X', '0x')));
    expect(reply.status).toBe(201);
    expect(h.room.messages[0]?.author).toBe(HOLDER);
    expect([...h.room.writers.keys()]).toEqual([HOLDER]);
  });

  describe('step 1: the site, the session, the limiter', () => {
    it('refuses a request that is not from the site before a session is read', async () => {
      const h = createHarness();
      const cookie = await h.signIn(HOLDER);
      const before = h.ledger();
      const reply = await h.fetch('POST', '/api/social/room', {
        body: { text: GOOD },
        cookie,
        origin: 'https://evil.test',
      });
      expect(reply.status).toBe(403);
      expect(errorOf(reply).code).toBe('forbidden');
      expect(h.trace).not.toContain('store.getSession');
      expect(stepsOf(h.trace)).toEqual([]);
      expect(h.ledger()).toEqual(before);
    });

    it('is 401 without a session, before anything is counted', async () => {
      const h = createHarness();
      const before = h.ledger();
      const reply = await post(h, undefined);
      expect(reply.status).toBe(401);
      expect(errorOf(reply).code).toBe('unauthorized');
      expect(stepsOf(h.trace)).toEqual([]);
      expect(h.ledger()).toEqual(before);
    });

    it('is 429 rate_limited when the limiter refuses the wallet, and reads nothing of the room', async () => {
      const h = createHarness();
      const cookie = await h.signIn(HOLDER);
      h.limiter.denied.add('write');
      const before = h.ledger();
      const reply = await post(h, cookie);
      expect(reply.status).toBe(429);
      expect(errorOf(reply).code).toBe('rate_limited');
      expect(stepsOf(h.trace)).toEqual([`limiter:write:${HOLDER}`]);
      expect(h.ledger()).toEqual(before);
    });
  });

  describe('step 2: the text, judged on the server', () => {
    const samples: Record<RoomTextProblem, string> = {
      empty: '   \n  ',
      length: 'word '.repeat(60),
      characters: 'café at noon',
      address: `send it to 0x${'9a'.repeat(20)}`,
      cashtag: '$DOGE looks lively',
      link: 'read example.org for more',
      number: 'ring +62 812 3456 7890',
      bait: 'is there an airdrop',
      spelled: 'h e l l o there',
      words: 'this is easy money',
    };

    it.each(ROOM_TEXT_PROBLEMS.map((problem) => [problem]))(
      'refuses a text with the problem `%s` by its own field and leaves nothing',
      async (problem) => {
        const h = createHarness();
        const cookie = await h.signIn(HOLDER);
        const text = samples[problem];
        // The sample is what the contract's own rule calls this problem.
        expect(roomTextProblem(text, { prixAddress: TOKEN, siteHost: SITE_HOST })).toBe(problem);
        const before = h.ledger();
        const reply = await post(h, cookie, text);
        expectRefusal(reply, `text_${problem}`);
        expect(stepsOf(h.trace)).toEqual([`limiter:write:${HOLDER}`, 'prixAddress']);
        // A refused text reads no holding: step 3 never runs for it.
        expect(h.holding.asked).toEqual([]);
        expect(h.ledger()).toEqual(before);
      },
    );

    it('answers an empty string as text_empty, like every other problem of a text', async () => {
      const h = createHarness();
      const cookie = await h.signIn(HOLDER);
      const before = h.ledger();
      expectRefusal(await post(h, cookie, ''), 'text_empty');
      expect(h.ledger()).toEqual(before);
    });

    it('keeps the answer of the input reader for a body the schema itself refuses, before the text is judged', async () => {
      const h = createHarness();
      const cookie = await h.signIn(HOLDER);
      const before = h.ledger();
      const bodies: unknown[] = [{}, { text: 7 }, { text: null }, { text: 'x'.repeat(2_001) }];
      bodies.push({ text: `the token is ${OTHER}`, prixAddress: OTHER });
      const replies = [];
      for (const body of bodies) replies.push(await h.fetch('POST', '/api/social/room', { body, cookie }));
      replies.push(await h.fetch('POST', '/api/social/room', { rawBody: '{', cookie }));
      for (const reply of replies) {
        expect(reply.status).toBe(400);
        expect(errorOf(reply).code).toBe('invalid_input');
        // Not a refusal of the room: the page shows its one general sentence for it.
        expect(Object.keys(ROOM_REFUSALS)).not.toContain(errorOf(reply).field);
      }
      // The token's address is never asked for a body that is not the schema: the text was not judged.
      expect(stepsOf(h.trace)).toEqual(replies.map(() => `limiter:write:${HOLDER}`));
      expect(h.ledger()).toEqual(before);
    });

    it('takes the one allowed address from the server: the token passes, and nothing passes while there is none', async () => {
      const h = createHarness();
      const cookie = await h.signIn(HOLDER);
      const text = `the token is ${TOKEN}`;
      expect((await post(h, cookie, text)).status).toBe(201);
      h.token.address = null;
      h.setNow('2026-10-20T12:05:00.000Z');
      expectRefusal(await post(h, cookie, text), 'text_address');
    });

    it("lets the site's own host through and no other", async () => {
      const h = createHarness();
      const cookie = await h.signIn(HOLDER);
      expect((await post(h, cookie, `the league is on ${SITE_HOST}`)).status).toBe(201);
    });
  });

  describe('step 3: who may write', () => {
    it('refuses everybody but an admin while the token gate is off, from the stored holding only', async () => {
      const h = createHarness();
      const cookie = await h.signIn(HOLDER);
      // The gate is judged by itself: a holding, however large, does not open a gate that is off.
      h.holding.gatingOn = false;
      h.holding.tokens.set(HOLDER, 5_000_000);
      const before = h.ledger();
      const reply = await post(h, cookie);
      expectRefusal(reply, 'gate_off');
      expect(stepsOf(h.trace)).toEqual([`limiter:write:${HOLDER}`, 'prixAddress', 'holding:cachedOnly']);
      expect(h.holding.asked).toEqual([{ address: HOLDER, options: { cachedOnly: true } }]);
      expect(h.ledger()).toEqual(before);
    });

    it('lets a wallet with ROOM_WRITE_MIN_TOKENS write, from the stored holding of the session’s own wallet', async () => {
      const h = createHarness();
      expect(ROOM_WRITE_MIN_TOKENS).toBe(1);
      h.holding.tokens.set(HOLDER, ROOM_WRITE_MIN_TOKENS);
      // The session spells its address in another case: the holding asked is the one in lower case.
      const reply = await post(h, await h.signIn(HOLDER.toUpperCase().replace('0X', '0x')));
      expect(reply.status).toBe(201);
      expect(h.holding.asked).toEqual([{ address: HOLDER, options: { cachedOnly: true } }]);
      expect(h.room.messages).toHaveLength(1);
    });

    it.each<[string, string, number | null]>([
      ['with one token less than ROOM_WRITE_MIN_TOKENS', HOLDER, ROOM_WRITE_MIN_TOKENS - 1],
      ['the token service has no holding for', STRANGER, null],
      ['whose holding is no number', HOLDER, Number.NaN],
    ])('refuses a wallet %s with not_holder, for one stored read and nothing else', async (_name, wallet, tokens) => {
      const h = createHarness();
      const cookie = await h.signIn(wallet);
      if (tokens !== null) h.holding.tokens.set(wallet, tokens);
      const before = h.ledger();
      const reply = await post(h, cookie);
      expectRefusal(reply, 'not_holder');
      expect(stepsOf(h.trace)).toEqual([`limiter:write:${wallet}`, 'prixAddress', 'holding:cachedOnly']);
      expect(h.holding.asked).toEqual([{ address: wallet, options: { cachedOnly: true } }]);
      expect(h.ledger()).toEqual(before);
    });

    it('asks no tier: a wallet at tier 0 with one token writes, a wallet at the highest tier with none does not', async () => {
      const h = createHarness();
      h.entitlements.value = entitlementsOfTier(0);
      expect((await post(h, await h.signIn(HOLDER))).status).toBe(201);
      h.entitlements.value = entitlementsOfTier(3);
      expectRefusal(await post(h, await h.signIn(STRANGER)), 'not_holder');
      expect(h.entitlements.asked).toEqual([]);
      expect(h.trace.filter((step) => step.startsWith('entitlements'))).toEqual([]);
    });

    it('is a fault, with nothing written, when the holding cannot be read', async () => {
      const h = createHarness();
      const cookie = await h.signIn(HOLDER);
      vi.spyOn(console, 'error').mockImplementation(() => {});
      h.holding.fail = true;
      const before = h.ledger();
      const reply = await post(h, cookie);
      expect(reply.status).toBe(500);
      expect(errorOf(reply).code).toBe('internal');
      expect(h.ledger()).toEqual(before);
    });

    it('says in the sentence of not_holder what writing takes and how a new holding is read, and names no tier', async () => {
      const h = createHarness();
      const reply = await post(h, await h.signIn(STRANGER));
      expectRefusal(reply, 'not_holder');
      const sentence = errorOf(reply).message;
      expect(sentence).toContain(`at least ${ROOM_WRITE_MIN_TOKENS} $PRIX`);
      expect(sentence).toContain(`${TOKEN_CACHE_SECONDS / 60} minutes`);
      expect(sentence).toContain('Account page');
      // Revision 7: no tier, no hour of waiting, and nobody is asked to acquire the token.
      expect(sentence).not.toMatch(/\btier|\bhour|\bbuy|\bget\b|\bacquire/i);
    });
  });

  describe('step 4: looked at and not taken, before anything is spent', () => {
    const looked = [`limiter:write:${HOLDER}`, 'prixAddress', 'holding:cachedOnly', 'room.getWriter'];
    const counted = [...looked, `room.getCounts:${HOUR_KEY}:${DAY_KEY}`];

    it.each<[RoomRefusalField, number, number]>([
      ['room_hour', ROOM_MESSAGES_PER_HOUR, 5],
      // Both are full: the hour is the one named.
      ['room_hour', ROOM_MESSAGES_PER_HOUR, 9],
      ['room_day', 3, 9],
      // Above the cap, as after the variable was lowered within a day.
      ['room_day', 3, 12],
    ])(
      'refuses a full room with %s (hour at %i, day at %i of 9) for reads and nothing else',
      async (field, hour, day) => {
        const h = createHarness({ roomDailyCap: 9 });
        const cookie = await h.signIn(HOLDER);
        h.counters.set(HOUR_KEY, hour);
        h.counters.set(DAY_KEY, day);
        const before = h.ledger();
        const reply = await post(h, cookie);
        expectRefusal(reply, field);
        expect(stepsOf(h.trace)).toEqual(counted);
        expect(h.ledger()).toEqual(before);
        expect(h.spent).toEqual({ walletWrites: 0, rows: 0 });
      },
    );

    it('lets a message through one below each cap, and it fills both', async () => {
      const h = createHarness({ roomDailyCap: 9 });
      h.counters.set(HOUR_KEY, ROOM_MESSAGES_PER_HOUR - 1);
      h.counters.set(DAY_KEY, 8);
      expect((await post(h, await h.signIn(HOLDER))).status).toBe(201);
      expect(h.counters.get(HOUR_KEY)).toBe(ROOM_MESSAGES_PER_HOUR);
      expect(h.counters.get(DAY_KEY)).toBe(9);
    });

    it('is a room nobody but an admin writes in at a cap of 0, and a holder’s try costs reads only', async () => {
      const h = createHarness({ roomDailyCap: 0 });
      const before = h.ledger();
      expectRefusal(await post(h, await h.signIn(HOLDER)), 'room_day');
      expect(h.ledger()).toEqual(before);
      expect(h.trace.some((step) => step.startsWith('counter.'))).toBe(false);
      expect((await post(h, await h.signIn(ADMIN))).status).toBe(201);
    });

    it.each<[RoomRefusalField, Parameters<Harness['room']['setWriter']>[1]]>([
      ['muted', { mutedAt: '2026-10-20T10:00:00.000Z', mutedBy: ADMIN, cutAt: '2026-10-20T10:00:00.000Z' }],
      [
        'too_soon',
        { lastAt: new Date(Date.parse(START) - (ROOM_SECONDS_BETWEEN - 1) * 1_000).toISOString(), day: DAY, count: 1 },
      ],
      ['wallet_day', { lastAt: '2026-10-20T09:00:00.000Z', day: DAY, count: ROOM_MESSAGES_PER_WALLET_PER_DAY }],
    ])('refuses with %s for a read and nothing else', async (field, row) => {
      const h = createHarness();
      const cookie = await h.signIn(HOLDER);
      h.room.setWriter(HOLDER, row);
      const before = h.ledger();
      const reply = await post(h, cookie);
      expectRefusal(reply, field);
      expect(stepsOf(h.trace)).toEqual(looked);
      expect(h.ledger()).toEqual(before);
      expect(h.spent).toEqual({ walletWrites: 0, rows: 0 });
    });

    it('lets a writer through once ROOM_SECONDS_BETWEEN have passed', async () => {
      const h = createHarness();
      const cookie = await h.signIn(HOLDER);
      h.room.setWriter(HOLDER, {
        lastAt: new Date(Date.parse(START) - ROOM_SECONDS_BETWEEN * 1_000).toISOString(),
        day: DAY,
        count: 1,
      });
      const reply = await post(h, cookie);
      expect(reply.status).toBe(201);
      expect(roomPostResponseSchema.parse(reply.json).left).toBe(ROOM_MESSAGES_PER_WALLET_PER_DAY - 2);
    });
  });

  describe('step 5: requireWriter, with its own codes', () => {
    it('keeps rate_limited for the second ask of the limiter, and spends nothing', async () => {
      const h = createHarness();
      const cookie = await h.signIn(HOLDER);
      h.limiter.writesAllowed = 1;
      const before = h.ledger();
      const reply = await post(h, cookie);
      expect(reply.status).toBe(429);
      expect(errorOf(reply).code).toBe('rate_limited');
      expect(stepsOf(h.trace).filter((step) => step.startsWith('limiter:write'))).toHaveLength(2);
      expect(h.ledger()).toEqual(before);
    });

    it('keeps daily_limit at the wallet’s writes of the day, and takes nothing of the room', async () => {
      const h = createHarness();
      const cookie = await h.signIn(HOLDER);
      h.limits.walletWritesLeft = 0;
      const before = h.ledger();
      const reply = await post(h, cookie);
      expect(reply.status).toBe(503);
      expect(errorOf(reply).code).toBe('daily_limit');
      expect(h.trace.some((step) => step.startsWith('counter.') || step === 'room.takeTurn')).toBe(false);
      expect(h.ledger()).toEqual(before);
    });

    it('keeps daily_limit at the day’s rows, and leaves what requireWriter itself spent', async () => {
      const h = createHarness();
      const cookie = await h.signIn(HOLDER);
      h.limits.rowsLeft = ROOM_POST_WRITE_ROWS - 1;
      const reply = await post(h, cookie);
      expect(reply.status).toBe(503);
      expect(errorOf(reply).code).toBe('daily_limit');
      expect(h.spent).toEqual({ walletWrites: 1, rows: 0 });
      expect(h.trace.some((step) => step.startsWith('counter.') || step === 'room.takeTurn')).toBe(false);
      expect(h.room.messages).toEqual([]);
      expect(h.room.writers.size).toBe(0);
    });

    it('asks for the rows of the contract and the limits of the API', () => {
      // The figures the budget of section 10 stands on.
      expect(ROOM_POST_WRITE_ROWS).toBeLessThanOrEqual(API_WRITE_ROWS_PER_DAY);
      expect(WALLET_WRITES_PER_DAY).toBeGreaterThanOrEqual(ROOM_MESSAGES_PER_WALLET_PER_DAY);
    });
  });

  describe('step 6: the turn decides what step 4 only looked at', () => {
    it.each<[RoomRefusalField, Parameters<Harness['room']['setWriter']>[1]]>([
      // Another request of the same wallet wins between the look and the turn.
      ['too_soon', { lastAt: START, day: DAY, count: 1 }],
      // An admin mutes the wallet between the two.
      ['muted', { mutedAt: START, mutedBy: ADMIN, cutAt: START }],
      ['wallet_day', { lastAt: '2026-10-20T09:00:00.000Z', day: DAY, count: ROOM_MESSAGES_PER_WALLET_PER_DAY }],
    ])(
      'refuses with %s from the turn: the wallet’s write and the rows stay spent, no turn, nothing of the room',
      async (field, row) => {
        const h = createHarness();
        const cookie = await h.signIn(HOLDER);
        h.room.beforeTurn = () => h.room.setWriter(HOLDER, row);
        const reply = await post(h, cookie);
        expectRefusal(reply, field);
        expect(h.spent).toEqual({ walletWrites: 1, rows: ROOM_POST_WRITE_ROWS });
        // No turn: the row is as the other request left it.
        expect(h.room.writers.get(HOLDER)).toEqual({
          address: HOLDER,
          lastAt: null,
          day: null,
          count: 0,
          mutedAt: null,
          mutedBy: null,
          cutAt: null,
          ...row,
        });
        // Nothing of the room was asked for, so there is nothing to give back.
        expect(h.trace.some((step) => step.startsWith('counter.'))).toBe(false);
        expect(h.counters.size).toBe(0);
        expect(h.trace).not.toContain('room.putMessage');
        expect(h.room.messages).toEqual([]);
      },
    );

    it('leaves the same when the turn throws: no turn and nothing of the room', async () => {
      const h = createHarness();
      const cookie = await h.signIn(HOLDER);
      vi.spyOn(console, 'error').mockImplementation(() => {});
      h.room.failTurn = true;
      const reply = await post(h, cookie);
      expect(reply.status).toBe(500);
      expect(errorOf(reply).code).toBe('internal');
      expect(h.spent).toEqual({ walletWrites: 1, rows: ROOM_POST_WRITE_ROWS });
      expect(h.room.writers.size).toBe(0);
      expect(h.trace.some((step) => step.startsWith('counter.'))).toBe(false);
      expect(h.counters.size).toBe(0);
      expect(h.room.messages).toEqual([]);
    });
  });

  describe('step 7: the room’s hour, then its day, after the turn', () => {
    /** What the turn of this request left in the writer's row. */
    const turned = { lastAt: START, day: DAY, count: 1 };

    it('refuses with room_hour when the hour filled after the look: the turn stays, the counts are as they were', async () => {
      const h = createHarness();
      const cookie = await h.signIn(HOLDER);
      h.counters.set(DAY_KEY, 5);
      // The room's hour fills between step 4 and step 7.
      h.room.beforeTurn = () => h.counters.set(HOUR_KEY, ROOM_MESSAGES_PER_HOUR);
      const reply = await post(h, cookie);
      expectRefusal(reply, 'room_hour');
      expect(h.spent).toEqual({ walletWrites: 1, rows: ROOM_POST_WRITE_ROWS });
      expect(h.room.writers.get(HOLDER)).toMatchObject(turned);
      expect(h.counters.get(HOUR_KEY)).toBe(ROOM_MESSAGES_PER_HOUR);
      expect(h.counters.get(DAY_KEY)).toBe(5);
      expect(h.trace).not.toContain(`counter.take:${DAY_KEY}`);
      expect(h.trace.some((step) => step.startsWith('counter.back'))).toBe(false);
      expect(h.trace).not.toContain('room.putMessage');
      expect(h.room.messages).toEqual([]);
    });

    it('refuses with room_day when the day filled after the look: the hour is given back, the turn never', async () => {
      const h = createHarness({ roomDailyCap: 9 });
      const cookie = await h.signIn(HOLDER);
      h.counters.set(HOUR_KEY, 3);
      h.counters.set(DAY_KEY, 8);
      h.room.beforeTurn = () => h.counters.set(DAY_KEY, 9);
      const reply = await post(h, cookie);
      expectRefusal(reply, 'room_day');
      expect(h.spent).toEqual({ walletWrites: 1, rows: ROOM_POST_WRITE_ROWS });
      expect(h.room.writers.get(HOLDER)).toMatchObject(turned);
      expect(h.counters.get(HOUR_KEY)).toBe(3);
      expect(h.counters.get(DAY_KEY)).toBe(9);
      expect(h.trace.filter((step) => step.startsWith('counter.'))).toEqual([
        `counter.take:${HOUR_KEY}`,
        `counter.take:${DAY_KEY}`,
        `counter.back:${HOUR_KEY}`,
      ]);
      expect(h.trace).not.toContain('room.putMessage');
      expect(h.room.messages).toEqual([]);
    });

    it('gives the hour back when the day’s count throws, and the turn stays', async () => {
      const h = createHarness();
      const cookie = await h.signIn(HOLDER);
      vi.spyOn(console, 'error').mockImplementation(() => {});
      h.faults.take.add(DAY_KEY);
      const reply = await post(h, cookie);
      expect(reply.status).toBe(500);
      expect(errorOf(reply).code).toBe('internal');
      expect(h.counters.get(HOUR_KEY)).toBe(0);
      expect(h.trace).toContain(`counter.back:${HOUR_KEY}`);
      expect(h.room.writers.get(HOLDER)).toMatchObject(turned);
      expect(h.room.messages).toEqual([]);
    });

    it('has nothing to give back when the hour’s count throws', async () => {
      const h = createHarness();
      const cookie = await h.signIn(HOLDER);
      vi.spyOn(console, 'error').mockImplementation(() => {});
      h.faults.take.add(HOUR_KEY);
      const reply = await post(h, cookie);
      expect(reply.status).toBe(500);
      expect(h.trace.filter((step) => step.startsWith('counter.'))).toEqual([`counter.take:${HOUR_KEY}`]);
      expect(h.room.writers.get(HOLDER)).toMatchObject(turned);
      expect(h.room.messages).toEqual([]);
    });

    it('answers the same when the hour cannot be given back, and the log line names no wallet', async () => {
      const lines: string[] = [];
      vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
        lines.push(String(line));
      });
      // The day refuses and the hour cannot be given back.
      const full = createHarness({ roomDailyCap: 9 });
      full.faults.giveBack = true;
      full.room.beforeTurn = () => full.counters.set(DAY_KEY, 9);
      expectRefusal(await post(full, await full.signIn(HOLDER)), 'room_day');
      expect(lines).toHaveLength(1);
      // The day throws and the hour cannot be given back: the fault is still the answer.
      const broken = createHarness();
      broken.faults.giveBack = true;
      broken.faults.take.add(DAY_KEY);
      const reply = await post(broken, await broken.signIn(HOLDER));
      expect(reply.status).toBe(500);
      expect(errorOf(reply).code).toBe('internal');
      expect(lines.join(' ').toLowerCase()).not.toContain(HOLDER);
    });

    it('counts the hour of the clock in UTC', async () => {
      const h = createHarness();
      h.setNow('2026-10-21T03:59:59.000Z');
      expect((await post(h, await h.signIn(HOLDER))).status).toBe(201);
      expect([...h.counters.keys()].sort()).toEqual([roomDayKey('2026-10-21'), roomHourKey('2026-10-21', 3)].sort());
    });
  });

  describe('step 8: the message', () => {
    it('leaves the turn and the room’s counts spent when the message fails', async () => {
      const h = createHarness();
      const cookie = await h.signIn(HOLDER);
      vi.spyOn(console, 'error').mockImplementation(() => {});
      h.room.failPut = true;
      const reply = await post(h, cookie);
      expect(reply.status).toBe(500);
      expect(h.counters.get(HOUR_KEY)).toBe(1);
      expect(h.counters.get(DAY_KEY)).toBe(1);
      expect(h.room.writers.get(HOLDER)?.count).toBe(1);
      expect(h.trace.some((step) => step.startsWith('counter.back'))).toBe(false);
      expect(h.room.messages).toEqual([]);
    });
  });
});

describe('Retry-After on the four 429s of the room (section 5)', () => {
  const AT = '2026-10-20T12:34:56.500Z';

  function secondsOf(reply: Reply): number {
    const header = reply.headers.get('Retry-After');
    expect(header).toMatch(/^[1-9]\d*$/);
    return Number(header);
  }

  it('tells a hurried wallet what is left of its seconds, not the whole of them', async () => {
    const h = createHarness();
    const cookie = await h.signIn(HOLDER);
    h.setNow(AT);
    const lastAt = new Date(Date.parse(AT) - 13_000).toISOString();
    h.room.setWriter(HOLDER, { lastAt, day: DAY, count: 1 });
    const reply = await post(h, cookie);
    expectRefusal(reply, 'too_soon');
    expect(secondsOf(reply)).toBe(ROOM_SECONDS_BETWEEN - 13);
    expect(secondsOf(reply)).toBe(roomRetryAfterSeconds('too_soon', AT, lastAt));
  });

  it('tells the time to 00:00 UTC at the wallet’s cap of the day', async () => {
    const h = createHarness();
    const cookie = await h.signIn(HOLDER);
    h.setNow(AT);
    h.room.setWriter(HOLDER, { lastAt: START, day: DAY, count: ROOM_MESSAGES_PER_WALLET_PER_DAY });
    const reply = await post(h, cookie);
    expectRefusal(reply, 'wallet_day');
    expect(secondsOf(reply)).toBe(roomRetryAfterSeconds('wallet_day', AT, START));
    expect(secondsOf(reply)).toBe(11 * 3_600 + 25 * 60 + 4);
  });

  it.each<[RoomWaitField, number]>([
    ['room_hour', 25 * 60 + 4],
    ['room_day', 11 * 3_600 + 25 * 60 + 4],
  ])('tells the time to the end of its span for %s, at the look and after the turn alike', async (field, seconds) => {
    expect(roomRetryAfterSeconds(field, AT, null)).toBe(seconds);
    const fill = (h: Harness): void => {
      if (field === 'room_hour') h.counters.set(HOUR_KEY, ROOM_MESSAGES_PER_HOUR);
      else h.counters.set(DAY_KEY, 9);
    };
    // Full at the look of step 4.
    const looked = createHarness({ roomDailyCap: 9 });
    looked.setNow(AT);
    fill(looked);
    const early = await post(looked, await looked.signIn(HOLDER));
    expectRefusal(early, field);
    expect(secondsOf(early)).toBe(seconds);
    // Filled between the look and step 7.
    const raced = createHarness({ roomDailyCap: 9 });
    raced.setNow(AT);
    raced.room.beforeTurn = () => fill(raced);
    const late = await post(raced, await raced.signIn(HOLDER));
    expectRefusal(late, field);
    expect(raced.trace).toContain('room.takeTurn');
    expect(secondsOf(late)).toBe(seconds);
  });

  it('bounds the wait of a turn refused at step 6 by the seconds between two messages', async () => {
    const h = createHarness();
    const cookie = await h.signIn(HOLDER);
    h.room.beforeTurn = () => h.room.setWriter(HOLDER, { lastAt: START, day: DAY, count: 1 });
    const reply = await post(h, cookie);
    expectRefusal(reply, 'too_soon');
    expect(secondsOf(reply)).toBeLessThanOrEqual(ROOM_SECONDS_BETWEEN);
  });
});

describe('what an admin passes, and what it does not (section 3)', () => {
  it('passes the gate, the holding, the turn and the room’s caps: steps 3, 4, 6 and 7 are not run', async () => {
    const h = createHarness({ roomDailyCap: 2 });
    const cookie = await h.signIn(ADMIN);
    // The gate is off and the admin wallet holds nothing: neither is asked.
    h.holding.gatingOn = false;
    expect(h.holding.tokens.has(ADMIN)).toBe(false);
    h.counters.set(HOUR_KEY, ROOM_MESSAGES_PER_HOUR);
    h.counters.set(DAY_KEY, 2);
    // A wallet that was muted before it became an admin, hurried and at its cap, writes all the same.
    const row = {
      lastAt: START,
      day: DAY,
      count: ROOM_MESSAGES_PER_WALLET_PER_DAY,
      mutedAt: '2026-10-20T10:00:00.000Z',
      mutedBy: OTHER,
      cutAt: '2026-10-20T10:00:00.000Z',
    };
    h.room.setWriter(ADMIN, row);
    h.trace.length = 0;
    const reply = await post(h, cookie, 'The chat is full for today');
    expect(reply.status).toBe(201);
    const body = roomPostResponseSchema.parse(reply.json);
    expect(body.message.admin).toBe(true);
    expect(body.message.authorShort).toBe(shortAddress(ADMIN));
    // An admin takes no turn, so its day is always whole.
    expect(body.left).toBe(ROOM_MESSAGES_PER_WALLET_PER_DAY);
    expect(h.room.writers.get(ADMIN)).toMatchObject(row);
    expect(stepsOf(h.trace)).toEqual([
      `limiter:write:${ADMIN}`,
      'prixAddress',
      `limiter:write:${ADMIN}`,
      'store.spendWalletWrite',
      `store.spendApiWrites:${ROOM_POST_WRITE_ROWS}`,
      'room.putMessage',
    ]);
    expect(h.holding.asked).toEqual([]);
    expect(h.entitlements.asked).toEqual([]);
    expect(h.counters.get(HOUR_KEY)).toBe(ROOM_MESSAGES_PER_HOUR);
    expect(h.counters.get(DAY_KEY)).toBe(2);
    expect(h.room.writers.get(ADMIN)?.count).toBe(ROOM_MESSAGES_PER_WALLET_PER_DAY);
  });

  it('is an admin whatever the case of the session’s address', async () => {
    const h = createHarness();
    h.holding.gatingOn = false;
    const reply = await post(h, await h.signIn(ADMIN.toUpperCase().replace('0X', '0x')));
    expect(reply.status).toBe(201);
    expect(h.room.messages[0]?.author).toBe(ADMIN);
  });

  it('does not pass the text rule: a stolen admin wallet posts no link', async () => {
    const h = createHarness();
    const before = h.ledger();
    expectRefusal(await post(h, await h.signIn(ADMIN), 'read example.org for more'), 'text_link');
    expect(h.ledger()).toEqual(before);
  });

  it('does not pass the limiter', async () => {
    const h = createHarness();
    const cookie = await h.signIn(ADMIN);
    h.limiter.denied.add('write');
    const reply = await post(h, cookie);
    expect(reply.status).toBe(429);
    expect(errorOf(reply).code).toBe('rate_limited');
    expect(h.room.messages).toEqual([]);
  });

  it('does not pass requireWriter', async () => {
    const h = createHarness();
    const cookie = await h.signIn(ADMIN);
    h.limits.walletWritesLeft = 0;
    const reply = await post(h, cookie);
    expect(reply.status).toBe(503);
    expect(errorOf(reply).code).toBe('daily_limit');
    expect(h.room.messages).toEqual([]);
  });
});

describe('no route of the room asks a tier (section 3, revision 7)', () => {
  it('runs all eight routes for a holder, a wallet with nothing and an admin without one call of entitlementsFor', async () => {
    const h = createHarness();
    const message = h.room.seed(OTHER, 'a line to moderate', '2026-10-20T11:00:00.000Z');
    const cookies = [await h.signIn(HOLDER), await h.signIn(STRANGER), await h.signIn(ADMIN)];
    const admin = cookies[2] as string;
    const statuses: number[] = [];
    const call = async (method: string, path: string, cookie?: string, body?: unknown): Promise<void> => {
      const reply = await h.fetch(method, path, {
        ...(cookie === undefined ? {} : { cookie }),
        ...(body === undefined ? {} : { body }),
      });
      statuses.push(reply.status);
    };
    await call('GET', '/api/social/room/status');
    await call('GET', '/api/social/room');
    for (const cookie of cookies) {
      await call('GET', '/api/social/room/me', cookie);
      await call('POST', '/api/social/room', cookie, { text: GOOD });
    }
    await call('GET', '/api/social/admin/room', admin);
    await call('PUT', `/api/social/admin/room/messages/${message.id}/mute`, admin);
    await call('DELETE', `/api/social/admin/room/messages/${message.id}/mute`, admin);
    await call('DELETE', `/api/social/admin/room/messages/${message.id}`, admin);
    // Each route ran: the holder and the admin wrote, the wallet with nothing was refused at step 3.
    expect(statuses).toEqual([200, 200, 200, 201, 200, 403, 200, 201, 200, 204, 204, 204]);
    expect(h.entitlements.asked).toEqual([]);
    expect(h.trace.filter((step) => step.startsWith('entitlements'))).toEqual([]);
    // The holding is asked by `me` and by step 3 of the write, and by no other route; never for an admin.
    expect(h.holding.asked).toEqual([
      { address: HOLDER, options: undefined },
      { address: HOLDER, options: { cachedOnly: true } },
      { address: STRANGER, options: undefined },
      { address: STRANGER, options: { cachedOnly: true } },
    ]);
  });
});

describe('what a log line of the room carries (section 7)', () => {
  it('logs no address and no text on a write, accepted or refused', async () => {
    const h = createHarness();
    const lines: string[] = [];
    for (const method of ['log', 'error', 'warn', 'info'] as const) {
      vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => {
        lines.push(parts.map(String).join(' '));
      });
    }
    const cookie = await h.signIn(HOLDER);
    expect((await post(h, cookie, 'a plain line about the league')).status).toBe(201);
    expectRefusal(await post(h, cookie, 'a second plain line'), 'too_soon');
    expectRefusal(await post(h, cookie, 'read example.org for more'), 'text_link');
    h.room.failPut = true;
    h.setNow('2026-10-20T12:10:00.000Z');
    expect((await post(h, cookie, 'a third plain line')).status).toBe(500);
    const all = lines.join('\n').toLowerCase();
    expect(all).not.toContain(HOLDER);
    expect(all).not.toContain('plain line');
    expect(all).not.toContain('example.org');
  });
});
