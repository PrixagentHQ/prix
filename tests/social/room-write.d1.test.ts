import type {
  Address,
  RoomRefusalField,
  TokenChainReader,
  TokenConfig,
  TokenHolder,
  TokenStore,
} from '@prix/contracts';
import {
  API_WRITE_ROWS_PER_DAY,
  ROOM_MESSAGES_PER_DAY_DEFAULT,
  ROOM_MESSAGES_PER_DAY_MAX,
  ROOM_MESSAGES_PER_HOUR,
  ROOM_MESSAGES_PER_WALLET_PER_DAY,
  ROOM_POST_WRITE_ROWS,
  ROOM_REFUSALS,
  ROOM_SECONDS_BETWEEN,
  ROOM_TEXT_MAX,
  ROOM_TEXT_PROBLEMS,
  ROOM_WRITE_MIN_TOKENS,
  roomDayKey,
  roomHourKey,
  roomMeResponseSchema,
  roomPostResponseSchema,
  roomRetryAfterSeconds,
  TOKEN_CACHE_SECONDS,
  WALLET_WRITES_PER_DAY,
} from '@prix/contracts';
import { createTokenService, resetTokenMemory } from '@prix/runtime/token/service';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoomStore } from '../../apps/api/src/store/room.ts';
import type { Reply, RoomHarness, RoomLedger, RoomParts } from './api/harness.ts';
import { ADMIN, createRoomHarness, emptyRoomTables, errorOf, recordStatements, roomLedger } from './api/harness.ts';
import { db, storesOn } from './support/d1.ts';

/**
 * Writing a message (docs/contracts/phase-6-room.md section 5, at revision 7): the real routes behind
 * `createApp`, the real room store and the real counters of Phase 2 on a local D1.
 *
 * Who may write is revision 7's: a wallet that holds at least ROOM_WRITE_MIN_TOKENS whole $PRIX (one), by
 * `deps.holding`, and no tier. The harness answers a holding from a map of the test's own, and records
 * every asking of a holding and of a tier; the last part of this file puts the token service's own
 * `holdingOf` behind `deps.holding`, on a store and a chain of the test's own.
 *
 * The eight steps in their order. Each step is refused once, and after each refusal the test reads what was
 * left behind from the tables themselves (`roomLedger`) and what was written from the statements the stores
 * sent (`meteredDb`): steps 1 to 4 write nothing at all; step 5 leaves what `requireWriter` spent; step 6
 * leaves that and no turn; step 7 leaves that and the turn, and the room's counts as they were; a message
 * that fails at step 8 leaves the turn and the room's counts spent.
 */

const NOW = '2026-10-20T12:10:30.000Z';
const DAY = '2026-10-20';
const HOUR_KEY = roomHourKey(DAY, 12);
const DAY_KEY = roomDayKey(DAY);
/** 12:10:30 UTC: 49 minutes and 30 seconds to the hour, 11 hours more to 00:00 UTC. */
const TO_THE_HOUR = 49 * 60 + 30;
const TO_MIDNIGHT = 11 * 3_600 + TO_THE_HOUR;

const PRIX = '0xa74ac6e9f2f8493344923c23972d496364241044';
const OTHER_TOKEN = '0x1234567890abcdef1234567890abcdef12345678';
const HOLDER = '0x00000000000000000000000000000000000005b2';
const SECOND = '0x00000000000000000000000000000000000005b3';
const THIRD = '0x00000000000000000000000000000000000005b4';
const POOR = '0x00000000000000000000000000000000000005c0';
const LINE = 'the league looks good today';

const NOTHING: RoomLedger = { walletWrites: 0, dayRows: 0, turn: null, hour: 0, day: 0, messages: 0 };

const metered = recordStatements(db);

/** The room on the real stores, each statement counted. `wrap` puts a fault into a store before the routes get it. */
function world(
  options: Parameters<typeof createRoomHarness>[1] = {},
  wrap: (parts: RoomParts) => Partial<RoomParts> = () => ({}),
): RoomHarness {
  const parts: RoomParts = { ...storesOn(metered.db), room: createRoomStore(metered.db) };
  const h = createRoomHarness({ ...parts, ...wrap(parts) }, { now: NOW, prixAddress: PRIX, ...options });
  // One whole token each, and no tier: every wallet of this file is at tier 0 unless a test says otherwise.
  for (const holder of [HOLDER, SECOND, THIRD]) h.holdings.set(holder, ROOM_WRITE_MIN_TOKENS);
  return h;
}

/** A store with some of its methods replaced; every other method is the real one. */
function withFault<T extends object>(target: T, over: Partial<T>): T {
  return new Proxy(target, {
    get(real, name) {
      if (name in over) return Reflect.get(over, name);
      const value = Reflect.get(real, name) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(real) : value;
    },
  });
}

/** One write, with the meter started just before it: what it shows is this request's own statements. */
async function send(h: RoomHarness, cookie: string | undefined, text: unknown = LINE): Promise<Reply> {
  metered.reset();
  return h.fetch('POST', '/api/social/room', { cookie, body: { text } });
}

const writesSent = (): string[] => metered.meter.log.filter((sql) => /^(insert|update|delete|replace)\b/i.test(sql));
const ledger = (address: string, at: string = NOW): Promise<RoomLedger> => roomLedger(db, address, at);

/** A refusal of the room: `invalid_input`, a field of ROOM_REFUSALS and its status; `Retry-After` on a 429 and on nothing else. */
function expectRefusal(reply: Reply, field: RoomRefusalField): void {
  expect(reply.status, reply.text).toBe(ROOM_REFUSALS[field]);
  expect(errorOf(reply)).toMatchObject({ code: 'invalid_input', field });
  expect(reply.headers.get('Cache-Control')).toBe('no-store');
  if (ROOM_REFUSALS[field] === 429) expect(reply.headers.get('Retry-After')).toMatch(/^[1-9]\d*$/);
  else expect(reply.headers.get('Retry-After')).toBeNull();
}

async function seedWriter(
  address: string,
  row: { lastAt?: string | null; day?: string | null; count?: number; mutedAt?: string | null; cutAt?: string | null },
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO room_writers (address, last_at, day, count, muted_at, muted_by, cut_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)',
    )
    .bind(
      address.toLowerCase(),
      row.lastAt ?? null,
      row.day ?? null,
      row.count ?? 0,
      row.mutedAt ?? null,
      row.mutedAt === undefined || row.mutedAt === null ? null : ADMIN,
      row.cutAt ?? row.mutedAt ?? null,
    )
    .run();
}

async function seedCount(key: string, n: number): Promise<void> {
  await db
    .prepare(
      'INSERT INTO counters (key, n, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT (key) DO UPDATE SET n = excluded.n',
    )
    .bind(key, n, NOW)
    .run();
}

const ago = (seconds: number): string => new Date(Date.parse(NOW) - seconds * 1_000).toISOString();

beforeEach(async () => {
  await emptyRoomTables(db);
  metered.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a message that is written', () => {
  it('answers 201 with the stored message and what is left of the day, and spends in the order of section 5', async () => {
    const h = world();
    const cookie = await h.signIn(HOLDER);

    const reply = await send(h, cookie, `  gm \n\t all,   ${LINE}  `);

    expect(reply.status, reply.text).toBe(201);
    expect(reply.headers.get('Cache-Control')).toBe('no-store');
    const answer = roomPostResponseSchema.parse(reply.json);
    // The folded text is what is stored and answered; the author, the time and the id are the server's.
    expect(answer.message.text).toBe(`gm all, ${LINE}`);
    expect(answer.message.at).toBe(NOW);
    expect(answer.message.admin).toBe(false);
    expect(answer.left).toBe(ROOM_MESSAGES_PER_WALLET_PER_DAY - 1);
    expect(reply.text).not.toContain(HOLDER);
    const stored = await db.prepare('SELECT * FROM room_messages').all<Record<string, unknown>>();
    // Since migration 0013 the row has the columns of a picture too: a message of text has none of one.
    expect(stored.results).toEqual([
      {
        id: answer.message.id,
        at: NOW,
        author: HOLDER,
        text: `gm all, ${LINE}`,
        hidden_at: null,
        hidden_by: null,
        pic_type: null,
        pic_key: null,
        pic_bytes: null,
        pic_width: null,
        pic_height: null,
        pic_frames: null,
        pic_sha256: null,
        pic_state: null,
        pic_reports: 0,
        pic_decided_at: null,
        pic_decided_by: null,
        pic_gone_at: null,
      },
    ]);

    // What it spent: the wallet's write and the day's rows, one turn, one count of the hour and of the day.
    expect(await ledger(HOLDER)).toEqual({
      walletWrites: 1,
      dayRows: ROOM_POST_WRITE_ROWS,
      turn: { lastAt: NOW, day: DAY, count: 1, mutedAt: null, cutAt: null },
      hour: 1,
      day: 1,
      messages: 1,
    });
    // The limiter's `write` rule is asked at step 1 and once more by `requireWriter` at step 5.
    expect(h.limiter.writesAsked(HOLDER)).toBe(2);
    // The holding is the stored one: a stranger cannot make the Worker read the chain with every request.
    expect(h.holdingReads).toEqual([{ address: HOLDER, cachedOnly: true }]);
    // And no tier is asked.
    expect(h.tierReads).toEqual([]);
    // And in this order: the sender's own (the wallet's write, the day's rows, the turn) before the room's
    // counts, the hour before the day, the message last. Since Phase 6.4 the store's `putMessage` is one
    // batch of two: the insert, and the writer's `first_at` where it is null
    // (docs/contracts/phase-6-pictures.md section 19).
    expect(
      writesSent().map((sql) => /\b(users|api_writes|room_writers|counters|room_messages)\b/.exec(sql)?.[1]),
    ).toEqual(['users', 'api_writes', 'room_writers', 'counters', 'counters', 'room_messages', 'room_writers']);
    expect(
      (
        await db
          .prepare('SELECT first_at FROM room_writers WHERE address = ?1')
          .bind(HOLDER)
          .first<{ first_at: string }>()
      )?.first_at,
    ).toBe(NOW);
  });

  it('stores the author in lower case whatever case the session carries', async () => {
    const h = world();
    const upper = `0x${HOLDER.slice(2).toUpperCase()}`;
    h.holdings.set(upper.toLowerCase(), ROOM_WRITE_MIN_TOKENS);

    expect((await send(h, await h.signIn(upper))).status).toBe(201);

    expect((await db.prepare('SELECT author FROM room_messages').first<{ author: string }>())?.author).toBe(HOLDER);
    expect((await ledger(HOLDER)).turn?.count).toBe(1);
    // The holding is asked for the address in lower case, as the token service stores it.
    expect(h.holdingReads).toEqual([{ address: HOLDER, cachedOnly: true }]);
  });

  it('lets a wallet with one whole token write, and a wallet with any more', async () => {
    // The founder, 2026-10-11: one whole $PRIX is enough.
    expect(ROOM_WRITE_MIN_TOKENS).toBe(1);
    const h = world();
    for (const [address, tokens] of [
      [HOLDER, ROOM_WRITE_MIN_TOKENS],
      [SECOND, 2],
      [THIRD, Number.MAX_SAFE_INTEGER],
    ] as const) {
      h.holdings.set(address, tokens);
      expect((await send(h, await h.signIn(address))).status, `${tokens} tokens`).toBe(201);
    }
    expect(h.tierReads).toEqual([]);
  });
});

describe('step 1: from the site, a session, the limiter', () => {
  it('answers 401 without a session before anything is counted', async () => {
    const h = world();

    const reply = await send(h, undefined);

    expect(reply.status).toBe(401);
    expect(errorOf(reply).code).toBe('unauthorized');
    expect(h.limiter.writesAsked()).toBe(0);
    expect(h.holdingReads).toEqual([]);
    expect(metered.meter.writes).toBe(0);
    expect(await ledger(HOLDER)).toEqual(NOTHING);
  });

  it('refuses a request that is not from the site before it reads the session', async () => {
    const h = world();
    const cookie = await h.signIn(HOLDER);
    metered.reset();

    const foreign = await h.fetch('POST', '/api/social/room', {
      cookie,
      body: { text: LINE },
      origin: 'https://evil.example',
    });
    const form = await h.fetch('POST', '/api/social/room', { cookie, body: { text: LINE }, contentType: 'text/plain' });
    const noOrigin = await h.fetch('POST', '/api/social/room', { cookie, body: { text: LINE }, origin: null });

    for (const reply of [foreign, form, noOrigin]) {
      expect(reply.status).toBe(403);
      expect(errorOf(reply).code).toBe('forbidden');
    }
    expect(metered.meter.statements).toBe(0);
    expect(h.limiter.writesAsked()).toBe(0);
    expect(await ledger(HOLDER)).toEqual(NOTHING);
  });

  it("answers 429 `rate_limited` when the limiter's write rule refuses, before the text is judged", async () => {
    const h = world();
    const cookie = await h.signIn(HOLDER);
    h.limiter.writesAllowed = 0;

    const reply = await send(h, cookie, 'dm me at evil.io');

    expect(reply.status).toBe(429);
    expect(errorOf(reply).code).toBe('rate_limited');
    expect(h.limiter.writesAsked(HOLDER)).toBe(1);
    expect(h.holdingReads).toEqual([]);
    expect(metered.meter.writes).toBe(0);
    expect(await ledger(HOLDER)).toEqual(NOTHING);
  });
});

describe('step 2: the body, then the text', () => {
  const SAMPLES: Record<(typeof ROOM_TEXT_PROBLEMS)[number], string> = {
    empty: '  \n ',
    length: 'a'.repeat(ROOM_TEXT_MAX + 1),
    characters: '<b>gm</b>',
    address: `the real one is ${OTHER_TOKEN}`,
    cashtag: 'buy $DOGE',
    link: 'the list is on evil.io',
    number: 'call +62 812 3456 7890',
    bait: 'dm me for the list',
    spelled: 's c a m',
    words: 'easy money',
  };

  it('has a sample for each problem of the rule', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual([...ROOM_TEXT_PROBLEMS].sort());
  });

  for (const problem of ROOM_TEXT_PROBLEMS) {
    it(`refuses a text with the problem \`${problem}\` as 400 text_${problem}, and counts and writes nothing`, async () => {
      const h = world();
      const cookie = await h.signIn(HOLDER);

      const reply = await send(h, cookie, SAMPLES[problem]);

      expectRefusal(reply, `text_${problem}`);
      // Nothing of a later step: the holding is not read, and no statement names the room or the counters.
      expect(h.holdingReads).toEqual([]);
      expect(metered.meter.log.filter((sql) => /room_|counters/.test(sql))).toEqual([]);
      expect(metered.meter.writes).toBe(0);
      expect(h.limiter.writesAsked(HOLDER)).toBe(1);
      expect(await ledger(HOLDER)).toEqual(NOTHING);
    });
  }

  it('refuses an empty string as text_empty: the schema takes it, the rule does not', async () => {
    const h = world();

    expectRefusal(await send(h, await h.signIn(HOLDER), ''), 'text_empty');
    expect(await ledger(HOLDER)).toEqual(NOTHING);
  });

  it("refuses a text with markup in it, an admin's too", async () => {
    const h = world();
    const holder = await h.signIn(HOLDER);
    const admin = await h.signIn(ADMIN);
    for (const text of ['<script>alert(1)</script>', '<img src=x onerror=1>', 'gm </b>', '<a href=x>the table</a>']) {
      expectRefusal(await send(h, holder, text), 'text_characters');
      expectRefusal(await send(h, admin, text), 'text_characters');
    }
    expect((await ledger(HOLDER)).messages).toBe(0);
  });

  it("keeps the input reader's own answer for a body the schema refuses, and writes nothing", async () => {
    const h = world();
    const cookie = await h.signIn(HOLDER);
    const bodies: [string, Parameters<RoomHarness['fetch']>[2]][] = [
      ['no JSON', { rawBody: 'gm all' }],
      ['a field too many', { body: { text: LINE, admin: true } }],
      ['an author of its own', { body: { text: LINE, author: ADMIN } }],
      ['a time and an id of its own', { body: { text: LINE, at: '2020-01-01T00:00:00.000Z', id: 1 } }],
      ['an address of its own', { body: { text: LINE, prixAddress: OTHER_TOKEN } }],
      ['a text that is no string', { body: { text: 7 } }],
      ['a text longer than 2,000 characters', { body: { text: 'a'.repeat(2_001) } }],
      ['no text', { body: {} }],
    ];
    for (const [label, body] of bodies) {
      metered.reset();
      const reply = await h.fetch('POST', '/api/social/room', { cookie, ...body });
      expect(reply.status, label).toBe(400);
      expect(errorOf(reply).code, label).toBe('invalid_input');
      // Not a refusal of the text rule: the reader names the part of the body it refused, or nothing.
      expect(String(errorOf(reply).field), label).not.toMatch(/^text_/);
      expect(metered.meter.writes, label).toBe(0);
    }
    expect(h.holdingReads).toEqual([]);
    expect(await ledger(HOLDER)).toEqual(NOTHING);
  });

  it("takes the one address a message may hold from the token's config on the server", async () => {
    const h = world();
    const cookie = await h.signIn(HOLDER);

    expect((await send(h, cookie, `the only address is ${PRIX}`)).status).toBe(201);
    expectRefusal(await send(h, await h.signIn(SECOND), `the real one is ${OTHER_TOKEN}`), 'text_address');
    // While the token has no address, no address at all.
    h.token.address = null;
    expectRefusal(await send(h, await h.signIn(THIRD), `the only address is ${PRIX}`), 'text_address');
  });

  it("takes the one host a message may hold from the site's own origin", async () => {
    const h = world();

    expect((await send(h, await h.signIn(HOLDER), 'the table is on prix.test/league')).status).toBe(201);
    expectRefusal(await send(h, await h.signIn(SECOND), 'the table is on prixagent.com/league'), 'text_link');
  });

  it('judges the text before it asks who writes: a wallet that holds nothing learns the problem of its text', async () => {
    const h = world();

    expectRefusal(await send(h, await h.signIn(POOR), 'dm me'), 'text_bait');
    expect(h.holdingReads).toEqual([]);
  });
});

describe('step 3: who may write: one whole $PRIX, and no tier (revision 7)', () => {
  /**
   * A refusal of step 3 and what it leaves: the stored holding asked once and no tier, the limiter asked
   * once (step 1) and not a second time (step 5), no statement of the room or of a counter, nothing
   * written, nothing counted.
   */
  async function expectStoppedAtStep3(h: RoomHarness, reply: Reply, address: string, field: RoomRefusalField) {
    expectRefusal(reply, field);
    expect(h.holdingReads).toEqual([{ address, cachedOnly: true }]);
    expect(h.tierReads).toEqual([]);
    expect(metered.meter.log.filter((sql) => /room_|counters/.test(sql))).toEqual([]);
    expect(metered.meter.writes).toBe(0);
    expect(h.limiter.writesAsked(address)).toBe(1);
    expect(await ledger(address)).toEqual(NOTHING);
  }

  it('answers 403 gate_off to a holder while the token gate is off, from the stored holding, and leaves nothing', async () => {
    const h = world();
    const cookie = await h.signIn(HOLDER);
    h.gate.on = false;

    await expectStoppedAtStep3(h, await send(h, cookie), HOLDER, 'gate_off');
  });

  it('answers 403 not_holder to a wallet that holds nothing, from the stored holding, and leaves nothing', async () => {
    const h = world();
    const cookie = await h.signIn(POOR);

    await expectStoppedAtStep3(h, await send(h, cookie), POOR, 'not_holder');
  });

  it('names the gate before the holding: a wallet that holds nothing is gate_off while the gate is off', async () => {
    const h = world();
    const cookie = await h.signIn(POOR);
    h.gate.on = false;

    await expectStoppedAtStep3(h, await send(h, cookie), POOR, 'gate_off');
  });

  // The token service rounds a holding down to whole tokens, so less than one token reaches the room as 0
  // (the last part of this file shows that with the service itself). Whatever figure is below one, or is
  // no number at all, never writes.
  for (const tokens of [0, 0.5, 0.999999, -1, Number.NaN]) {
    it(`answers 403 not_holder to a holding of ${tokens}: less than one whole token, nothing counted, nothing written`, async () => {
      const h = world();
      h.holdings.set(POOR, tokens);
      const cookie = await h.signIn(POOR);

      await expectStoppedAtStep3(h, await send(h, cookie), POOR, 'not_holder');
    });
  }

  it('never asks a tier: the highest tier with no token is not_holder, and tier 0 with one token writes', async () => {
    const h = world();
    // A tier the token gate would grant to a large holding. The room does not look at it.
    h.tiers.set(POOR, 3);
    h.tiers.set(HOLDER, 0);

    await expectStoppedAtStep3(h, await send(h, await h.signIn(POOR)), POOR, 'not_holder');
    const written = await send(h, await h.signIn(HOLDER));

    expect(written.status, written.text).toBe(201);
    expect(h.tierReads).toEqual([]);
  });

  it('takes no holding from the request: a wallet that holds nothing cannot claim one', async () => {
    const h = world();
    const cookie = await h.signIn(POOR);
    metered.reset();

    // A query the route never reads.
    const query = await h.fetch('POST', '/api/social/room?tokens=1000000&tier=3&holding=1&gatingOn=true', {
      cookie,
      body: { text: LINE },
    });
    expectRefusal(query, 'not_holder');
    // A body that carries a holding or a tier is refused whole, by the reader, before step 3.
    for (const claim of [{ tokens: 1_000_000 }, { tier: 3 }, { holding: { gatingOn: true, tokens: 5 } }]) {
      const reply = await h.fetch('POST', '/api/social/room', { cookie, body: { text: LINE, ...claim } });
      expect(reply.status, JSON.stringify(claim)).toBe(400);
      expect(String(errorOf(reply).field), JSON.stringify(claim)).not.toMatch(/^text_/);
    }

    expect(h.holdingReads).toEqual([{ address: POOR, cachedOnly: true }]);
    expect(metered.meter.writes).toBe(0);
    expect(await ledger(POOR)).toEqual(NOTHING);
  });

  it("says in the refusal what writing takes: at least 1 $PRIX, with no tier, no hour's wait and no word to acquire the token", async () => {
    // Section 9: the sentence of `not_holder` names the one token, the quarter of an hour within which
    // Prix reads a new holding, and the Account page; no sentence of the room names a tier or asks
    // anyone to acquire the token.
    const problems = (sentence: string): string[] => [
      ...(sentence.includes(`at least ${ROOM_WRITE_MIN_TOKENS} $PRIX`) ? [] : ['does not name the one token']),
      ...(/Account page/.test(sentence) ? [] : ['does not name the Account page']),
      ...(sentence.includes(`${TOKEN_CACHE_SECONDS / 60} minutes`) || /quarter of an hour/.test(sentence)
        ? []
        : ['does not say when a new holding is read']),
      ...(/\btiers?\b|10,000|10000/i.test(sentence) ? ['names a tier'] : []),
      ...(/(?<!quarter of )an hour/i.test(sentence) ? ["names the hour's wait"] : []),
      ...(/\b(buy|purchase|acquire|get more|enough)\b/i.test(sentence) ? ['asks for more of the token'] : []),
    ];
    // The check itself, on the sentence of revisions 1 to 6: it finds what revision 7 took out.
    expect(
      problems(
        'This wallet does not hold enough $PRIX to write in the chat, or its holding is too new to count. A new holding counts after about an hour: load the page again then.',
      ),
    ).toEqual([
      'does not name the one token',
      'does not name the Account page',
      'does not say when a new holding is read',
      "names the hour's wait",
      'asks for more of the token',
    ]);
    const h = world();

    const reply = await send(h, await h.signIn(POOR));

    expectRefusal(reply, 'not_holder');
    expect(problems(errorOf(reply).message)).toEqual([]);
  });

  it('writes again at once when the holding is there, and no longer when it is gone', async () => {
    const h = world();
    const cookie = await h.signIn(POOR);
    expectRefusal(await send(h, cookie), 'not_holder');

    h.holdings.set(POOR, ROOM_WRITE_MIN_TOKENS);
    const written = await send(h, cookie);
    expect(written.status, written.text).toBe(201);

    h.holdings.set(POOR, 0);
    h.advance(ROOM_SECONDS_BETWEEN * 1_000);
    expectRefusal(await send(h, cookie, 'and one more line'), 'not_holder');
    expect((await ledger(POOR, h.now())).messages).toBe(1);
  });
});

describe('step 4: looked at, and not taken', () => {
  it('answers 403 muted to a muted holder, and it costs reads only', async () => {
    const h = world();
    const cookie = await h.signIn(HOLDER);
    await seedWriter(HOLDER, { mutedAt: ago(60) });
    const before = await ledger(HOLDER);

    const reply = await send(h, cookie);

    expectRefusal(reply, 'muted');
    expect(metered.meter.writes).toBe(0);
    // The room's counts are not even looked at, and `requireWriter` is not reached.
    expect(metered.meter.log.filter((sql) => /counters/.test(sql))).toEqual([]);
    expect(h.limiter.writesAsked(HOLDER)).toBe(1);
    expect(await ledger(HOLDER)).toEqual(before);
  });

  it('refuses a second message inside ROOM_SECONDS_BETWEEN as 429 too_soon, with what is left of the seconds', async () => {
    const h = world();
    const cookie = await h.signIn(HOLDER);
    expect((await send(h, cookie)).status).toBe(201);
    const afterFirst = await ledger(HOLDER);

    h.advance(5_000);
    const second = await send(h, cookie, 'and one more line');

    expectRefusal(second, 'too_soon');
    expect(second.headers.get('Retry-After')).toBe(String(ROOM_SECONDS_BETWEEN - 5));
    expect(metered.meter.writes).toBe(0);
    expect(h.limiter.writesAsked(HOLDER)).toBe(3);
    expect(await ledger(HOLDER)).toEqual(afterFirst);

    // One millisecond short of the seconds is still too soon; at the seconds the wallet writes again.
    h.setNow(new Date(Date.parse(NOW) + ROOM_SECONDS_BETWEEN * 1_000 - 1).toISOString());
    const third = await send(h, cookie, 'and one more line');
    expectRefusal(third, 'too_soon');
    expect(third.headers.get('Retry-After')).toBe('1');
    h.setNow(new Date(Date.parse(NOW) + ROOM_SECONDS_BETWEEN * 1_000).toISOString());
    const fourth = await send(h, cookie, 'and one more line');
    expect(fourth.status, fourth.text).toBe(201);
    expect(fourth.json.left).toBe(ROOM_MESSAGES_PER_WALLET_PER_DAY - 2);
  });

  it('lets a wallet write ROOM_MESSAGES_PER_WALLET_PER_DAY messages in a UTC day and refuses the next as 429 wallet_day until 00:00 UTC', async () => {
    const h = world();
    const cookie = await h.signIn(HOLDER);
    const start = Date.parse('2026-10-20T12:00:00.000Z');
    for (let n = 1; n <= ROOM_MESSAGES_PER_WALLET_PER_DAY; n += 1) {
      h.setNow(new Date(start + n * ROOM_SECONDS_BETWEEN * 1_000).toISOString());
      const reply = await send(h, cookie, `line number ${n} of the day`);
      expect(reply.status, `message ${n}: ${reply.text}`).toBe(201);
      expect(reply.json.left, `message ${n}`).toBe(ROOM_MESSAGES_PER_WALLET_PER_DAY - n);
    }

    h.setNow(NOW);
    const before = await ledger(HOLDER);
    const refused = await send(h, cookie, 'one over the day');

    expectRefusal(refused, 'wallet_day');
    expect(refused.headers.get('Retry-After')).toBe(String(TO_MIDNIGHT));
    expect(metered.meter.writes).toBe(0);
    expect(await ledger(HOLDER)).toEqual(before);
    expect(before.messages).toBe(ROOM_MESSAGES_PER_WALLET_PER_DAY);

    // The last second of the day is the same day; the next day starts the count again.
    h.setNow('2026-10-20T23:59:59.999Z');
    expectRefusal(await send(h, cookie, 'one over the day'), 'wallet_day');
    h.setNow('2026-10-21T00:00:00.000Z');
    const next = await send(h, cookie, 'a new day');
    expect(next.status, next.text).toBe(201);
    expect(next.json.left).toBe(ROOM_MESSAGES_PER_WALLET_PER_DAY - 1);
  });

  it('names the mute before the cap of the day, and the cap before the seconds', async () => {
    const full = { day: DAY, count: ROOM_MESSAGES_PER_WALLET_PER_DAY, lastAt: ago(1) };
    const h = world();
    await seedWriter(HOLDER, { ...full, mutedAt: ago(30) });
    await seedWriter(SECOND, full);

    expectRefusal(await send(h, await h.signIn(HOLDER)), 'muted');
    expectRefusal(await send(h, await h.signIn(SECOND)), 'wallet_day');
  });

  it('refuses a holder as 429 room_hour once the hour holds ROOM_MESSAGES_PER_HOUR, at the cost of reads only', async () => {
    const h = world();
    await seedCount(HOUR_KEY, ROOM_MESSAGES_PER_HOUR - 1);
    // The last message of the hour is taken by the real counter.
    expect((await send(h, await h.signIn(HOLDER))).status).toBe(201);
    const cookie = await h.signIn(SECOND);
    const before = await ledger(SECOND);
    expect(before.hour).toBe(ROOM_MESSAGES_PER_HOUR);

    const reply = await send(h, cookie);

    expectRefusal(reply, 'room_hour');
    expect(reply.headers.get('Retry-After')).toBe(String(TO_THE_HOUR));
    // No count, no turn, no write of the wallet: nothing but reads.
    expect(metered.meter.writes).toBe(0);
    expect(h.limiter.writesAsked(SECOND)).toBe(1);
    expect(await ledger(SECOND)).toEqual(before);
    expect(before).toMatchObject({ walletWrites: 0, turn: null });

    // The next hour has a count of its own.
    h.setNow('2026-10-20T13:00:00.000Z');
    expect((await send(h, cookie)).status).toBe(201);
  });

  it("refuses a holder as 429 room_day once the day holds the variable's cap, at the cost of reads only", async () => {
    const h = world({ dailyCap: '2' });
    expect((await send(h, await h.signIn(HOLDER))).status).toBe(201);
    expect((await send(h, await h.signIn(SECOND))).status).toBe(201);
    const cookie = await h.signIn(THIRD);
    const before = await ledger(THIRD);
    expect(before).toMatchObject({ hour: 2, day: 2, walletWrites: 0, turn: null });

    const reply = await send(h, cookie);

    expectRefusal(reply, 'room_day');
    expect(reply.headers.get('Retry-After')).toBe(String(TO_MIDNIGHT));
    expect(metered.meter.writes).toBe(0);
    expect(h.limiter.writesAsked(THIRD)).toBe(1);
    expect(await ledger(THIRD)).toEqual(before);

    // The next hour of the same day is still full; the next day is not.
    h.setNow('2026-10-20T13:00:00.000Z');
    expectRefusal(await send(h, cookie), 'room_day');
    h.setNow('2026-10-21T00:00:00.000Z');
    expect((await send(h, cookie)).status).toBe(201);
  });

  it('names the hour before the day when both are full', async () => {
    const h = world({ dailyCap: '40' });
    await seedCount(HOUR_KEY, ROOM_MESSAGES_PER_HOUR);
    await seedCount(DAY_KEY, 40);

    expectRefusal(await send(h, await h.signIn(HOLDER)), 'room_hour');
  });

  for (const [variable, cap] of [
    [undefined, ROOM_MESSAGES_PER_DAY_DEFAULT],
    ['not a number', ROOM_MESSAGES_PER_DAY_DEFAULT],
    ['250', 250],
    ['600', ROOM_MESSAGES_PER_DAY_MAX],
    ['999999', ROOM_MESSAGES_PER_DAY_MAX],
  ] as const) {
    it(`holds ${cap} messages a day while the variable is ${JSON.stringify(variable)}: the one before the cap passes, the next does not`, async () => {
      const h = world(variable === undefined ? {} : { dailyCap: variable });
      await seedCount(DAY_KEY, cap - 1);

      expect((await send(h, await h.signIn(HOLDER))).status).toBe(201);
      expect((await ledger(HOLDER)).day).toBe(cap);
      expectRefusal(await send(h, await h.signIn(SECOND)), 'room_day');
      expect((await ledger(HOLDER)).day).toBe(cap);
    });
  }

  it('never holds more than the ceiling of 600 a day, whatever the variable says', async () => {
    expect(ROOM_MESSAGES_PER_DAY_MAX).toBe(600);
    const h = world({ dailyCap: '100000' });
    await seedCount(DAY_KEY, 600);

    expectRefusal(await send(h, await h.signIn(HOLDER)), 'room_day');
    expect(metered.meter.writes).toBe(0);
  });

  it('is a room nobody but an admin writes in while the variable is "0"', async () => {
    const h = world({ dailyCap: '0' });

    expectRefusal(await send(h, await h.signIn(HOLDER)), 'room_day');
    expect(metered.meter.writes).toBe(0);
    expect((await send(h, await h.signIn(ADMIN))).status).toBe(201);
  });
});

describe('step 5: requireWriter', () => {
  it("keeps the limiter's own code when its second asking refuses, and leaves nothing", async () => {
    const h = world();
    const cookie = await h.signIn(HOLDER);
    h.limiter.writesAllowed = 1;

    const reply = await send(h, cookie);

    expect(reply.status).toBe(429);
    expect(errorOf(reply).code).toBe('rate_limited');
    expect(h.limiter.writesAsked(HOLDER)).toBe(2);
    expect(metered.meter.writes).toBe(0);
    expect(await ledger(HOLDER)).toEqual(NOTHING);
  });

  it("keeps `daily_limit` when the wallet's writes of the day are used up: no turn, no count, no message", async () => {
    const h = world();
    const cookie = await h.signIn(HOLDER);
    await db
      .prepare('UPDATE users SET write_day = ?2, write_count = ?3 WHERE address = ?1')
      .bind(HOLDER, DAY, WALLET_WRITES_PER_DAY)
      .run();

    const reply = await send(h, cookie);

    expect(reply.status).toBe(503);
    expect(errorOf(reply).code).toBe('daily_limit');
    expect(await ledger(HOLDER)).toEqual({ ...NOTHING, walletWrites: WALLET_WRITES_PER_DAY });
  });

  it("keeps `daily_limit` when the day's rows are used up, and leaves what requireWriter itself spent: the wallet's write", async () => {
    const h = world();
    const cookie = await h.signIn(HOLDER);
    await db.prepare('INSERT INTO api_writes (day, rows) VALUES (?1, ?2)').bind(DAY, API_WRITE_ROWS_PER_DAY).run();

    const reply = await send(h, cookie);

    expect(reply.status).toBe(503);
    expect(errorOf(reply).code).toBe('daily_limit');
    expect(await ledger(HOLDER)).toEqual({ ...NOTHING, walletWrites: 1, dayRows: API_WRITE_ROWS_PER_DAY });
  });

  it('books ROOM_POST_WRITE_ROWS rows for a message: one row short of the room is refused', async () => {
    const h = world();
    const cookie = await h.signIn(HOLDER);
    await db
      .prepare('INSERT INTO api_writes (day, rows) VALUES (?1, ?2)')
      .bind(DAY, API_WRITE_ROWS_PER_DAY - ROOM_POST_WRITE_ROWS + 1)
      .run();

    expect(errorOf(await send(h, cookie)).code).toBe('daily_limit');
    expect((await ledger(HOLDER)).messages).toBe(0);
  });
});

describe("step 6: the writer's turn", () => {
  /** The look of step 4 answers what the row held before another request of the wallet took its turn. */
  const staleLook = (parts: RoomParts): Partial<RoomParts> => ({
    room: withFault(parts.room, { getWriter: async () => null }),
  });

  it('refuses a turn that another request of the wallet took a moment ago as 429 too_soon with the whole wait, and leaves no turn and nothing of the room', async () => {
    const first = world();
    expect((await send(first, await first.signIn(HOLDER))).status).toBe(201);
    const afterFirst = await ledger(HOLDER);
    const h = world({}, staleLook);
    const cookie = await h.signIn(HOLDER);
    h.advance(1_000);

    const reply = await send(h, cookie, 'the second of two at once');

    expectRefusal(reply, 'too_soon');
    // Revision 4, step 6: the turn it lost was taken a moment ago, so the wait is the whole of the seconds.
    expect(reply.headers.get('Retry-After')).toBe(String(roomRetryAfterSeconds('too_soon', NOW, NOW)));
    expect(reply.headers.get('Retry-After')).toBe(String(ROOM_SECONDS_BETWEEN));
    // The wallet's write of the day and the day's rows are spent; the turn, the counts and the room are as they were.
    expect(await ledger(HOLDER)).toEqual({
      ...afterFirst,
      walletWrites: afterFirst.walletWrites + 1,
      dayRows: afterFirst.dayRows + ROOM_POST_WRITE_ROWS,
    });
    expect(writesSent().filter((sql) => /counters|room_messages/.test(sql))).toEqual([]);
  });

  it('refuses a writer muted between the look and the turn as 403 muted, with no turn and nothing of the room', async () => {
    await seedWriter(HOLDER, { mutedAt: ago(1) });
    const h = world({}, staleLook);
    const cookie = await h.signIn(HOLDER);
    const before = await ledger(HOLDER);

    const reply = await send(h, cookie);

    expectRefusal(reply, 'muted');
    expect(await ledger(HOLDER)).toEqual({ ...before, walletWrites: 1, dayRows: ROOM_POST_WRITE_ROWS });
  });

  it('refuses a wallet whose day filled between the look and the turn as 429 wallet_day', async () => {
    await seedWriter(HOLDER, { day: DAY, count: ROOM_MESSAGES_PER_WALLET_PER_DAY, lastAt: ago(3_600) });
    const h = world({}, staleLook);
    const cookie = await h.signIn(HOLDER);

    const reply = await send(h, cookie);

    expectRefusal(reply, 'wallet_day');
    expect(reply.headers.get('Retry-After')).toBe(String(TO_MIDNIGHT));
    expect(await ledger(HOLDER)).toMatchObject({ hour: 0, day: 0, messages: 0 });
  });

  it('counts one turn and stores one message when one wallet sends two at once', async () => {
    const h = world();
    const cookie = await h.signIn(HOLDER);

    const replies = await Promise.all([
      h.fetch('POST', '/api/social/room', { cookie, body: { text: 'the first of two at once' } }),
      h.fetch('POST', '/api/social/room', { cookie, body: { text: 'the second of two at once' } }),
    ]);

    expect(replies.map((reply) => reply.status).sort()).toEqual([201, 429]);
    const refused = replies.find((reply) => reply.status === 429);
    if (refused === undefined) throw new Error('one of the two is refused');
    expectRefusal(refused, 'too_soon');
    expect(await ledger(HOLDER)).toMatchObject({ turn: { count: 1 }, hour: 1, day: 1, messages: 1 });
  });
});

describe("step 7: the room's hour, then the room's day", () => {
  /** The look of step 4 answers what the counts held before the room filled. */
  const staleCounts = (parts: RoomParts): Partial<RoomParts> => ({
    room: withFault(parts.room, { getCounts: async () => ({ hour: 0, day: 0 }) }),
  });
  const TURN_SPENT = {
    walletWrites: 1,
    dayRows: ROOM_POST_WRITE_ROWS,
    turn: { lastAt: NOW, day: DAY, count: 1, mutedAt: null, cutAt: null },
    messages: 0,
  };

  it('refuses as 429 room_hour when the hour filled after the look: the turn is spent, the counts are as they were', async () => {
    const h = world({}, staleCounts);
    const cookie = await h.signIn(HOLDER);
    await seedCount(HOUR_KEY, ROOM_MESSAGES_PER_HOUR);
    await seedCount(DAY_KEY, 77);

    const reply = await send(h, cookie);

    expectRefusal(reply, 'room_hour');
    expect(reply.headers.get('Retry-After')).toBe(String(TO_THE_HOUR));
    expect(await ledger(HOLDER)).toEqual({ ...TURN_SPENT, hour: ROOM_MESSAGES_PER_HOUR, day: 77 });
  });

  it("refuses as 429 room_day when the day filled after the look, and gives the hour's count back", async () => {
    const h = world({ dailyCap: '5' }, staleCounts);
    const cookie = await h.signIn(HOLDER);
    await seedCount(HOUR_KEY, 3);
    await seedCount(DAY_KEY, 5);

    const reply = await send(h, cookie);

    expectRefusal(reply, 'room_day');
    expect(reply.headers.get('Retry-After')).toBe(String(TO_MIDNIGHT));
    // The turn is not given back; the hour's count is.
    expect(await ledger(HOLDER)).toEqual({ ...TURN_SPENT, hour: 3, day: 5 });
    // The wallet waits its seconds and has one message fewer today.
    h.advance(1_000);
    expectRefusal(await send(h, cookie), 'too_soon');
  });

  it("gives the hour's count back when the day's counter throws, and stores no message", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const h = world({}, (parts) => ({
      reputation: withFault(parts.reputation, {
        takeCounter: async (key, cap, day, now) => {
          if (key === DAY_KEY) throw new Error('the database failed on purpose');
          return parts.reputation.takeCounter(key, cap, day, now);
        },
      }),
    }));
    const cookie = await h.signIn(HOLDER);

    const reply = await send(h, cookie);

    expect(reply.status).toBe(500);
    expect(await ledger(HOLDER)).toEqual({ ...TURN_SPENT, hour: 0, day: 0 });
  });

  it('answers room_day all the same when the give-back fails, and its log line names no wallet and no text', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const h = world({ dailyCap: '5' }, (parts) => ({
      room: withFault(parts.room, { getCounts: async () => ({ hour: 0, day: 0 }) }),
      reputation: withFault(parts.reputation, {
        giveBackCounter: async () => {
          throw new Error(`could not give back for ${HOLDER}`);
        },
      }),
    }));
    const cookie = await h.signIn(HOLDER);
    await seedCount(DAY_KEY, 5);

    const reply = await send(h, cookie);

    expectRefusal(reply, 'room_day');
    // The hour's count stays spent until its hour ends.
    expect(await ledger(HOLDER)).toEqual({ ...TURN_SPENT, hour: 1, day: 5 });
    const logged = errors.mock.calls.flat().join('\n');
    expect(logged).not.toContain(HOLDER);
    expect(logged).not.toContain(LINE);
  });
});

describe('step 8: the message', () => {
  it("leaves the turn and the room's counts spent, and no message, when the message cannot be stored", async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const h = world({}, (parts) => ({
      room: withFault(parts.room, {
        putMessage: async () => {
          throw new Error('the database failed on purpose');
        },
      }),
    }));
    const cookie = await h.signIn(HOLDER);

    const reply = await send(h, cookie);

    expect(reply.status).toBe(500);
    expect(reply.text).not.toContain(LINE);
    expect(await ledger(HOLDER)).toEqual({
      walletWrites: 1,
      dayRows: ROOM_POST_WRITE_ROWS,
      turn: { lastAt: NOW, day: DAY, count: 1, mutedAt: null, cutAt: null },
      hour: 1,
      day: 1,
      messages: 0,
    });
    const logged = errors.mock.calls.flat().join('\n');
    expect(logged).not.toContain(HOLDER);
    expect(logged).not.toContain(LINE);
  });
});

describe('an admin', () => {
  it('writes while the gate is off and it holds nothing, and neither a holding nor a tier is read for it', async () => {
    const h = world();
    h.gate.on = false;

    const reply = await send(h, await h.signIn(ADMIN));

    expect(reply.status, reply.text).toBe(201);
    const answer = roomPostResponseSchema.parse(reply.json);
    expect(answer.message.admin).toBe(true);
    expect(answer.left).toBe(ROOM_MESSAGES_PER_WALLET_PER_DAY);
    expect(h.holdingReads).toEqual([]);
    expect(h.tierReads).toEqual([]);
    // It takes no turn and none of the room's counts. Since Phase 6.4 its stored message makes the
    // writer's row, for `first_at` (docs/contracts/phase-6-pictures.md section 2: "an admin takes no turn
    // and may have no row"): a row with no turn in it, no time of a last message and no count of the day.
    expect(await ledger(ADMIN)).toEqual({
      walletWrites: 1,
      dayRows: ROOM_POST_WRITE_ROWS,
      turn: { lastAt: null, day: null, count: 0, mutedAt: null, cutAt: null },
      hour: 0,
      day: 0,
      messages: 1,
    });
    expect(h.limiter.writesAsked(ADMIN)).toBe(2);
  });

  it('writes whatever the turn and the caps of the room say: three at once into a full hour and a full day', async () => {
    const h = world({ dailyCap: '5' });
    const cookie = await h.signIn(ADMIN);
    await seedWriter(ADMIN, { day: DAY, count: ROOM_MESSAGES_PER_WALLET_PER_DAY, lastAt: NOW });
    await seedCount(HOUR_KEY, ROOM_MESSAGES_PER_HOUR);
    await seedCount(DAY_KEY, 5);
    const before = await ledger(ADMIN);

    for (const text of ['the room is full for today', 'writing opens again at 00:00 UTC', 'thank you all']) {
      const reply = await send(h, cookie, text);
      expect(reply.status, reply.text).toBe(201);
      expect(reply.json.left).toBe(ROOM_MESSAGES_PER_WALLET_PER_DAY);
    }

    expect(await ledger(ADMIN)).toEqual({
      ...before,
      walletWrites: 3,
      dayRows: 3 * ROOM_POST_WRITE_ROWS,
      messages: 3,
    });
  });

  it('writes whatever its holding: none while the gate is on, a part of a token, or a holding that cannot be read', async () => {
    const h = world();
    const cookie = await h.signIn(ADMIN);

    for (const tokens of [0, 0.5, ROOM_WRITE_MIN_TOKENS]) {
      h.holdings.set(ADMIN, tokens);
      const reply = await send(
        h,
        cookie,
        `an admin that holds ${tokens === 0.5 ? 'half a token' : `${tokens} tokens`}`,
      );
      expect(reply.status, reply.text).toBe(201);
      expect(reply.json.message.admin).toBe(true);
    }
    // A token service that fails stops no admin: it is never asked.
    const broken = world({
      holding: async () => {
        throw new Error('the token service failed on purpose');
      },
    });
    const reply = await send(broken, await broken.signIn(ADMIN), 'the token service is down');
    expect(reply.status, reply.text).toBe(201);

    expect(h.holdingReads).toEqual([]);
    expect(broken.holdingReads).toEqual([]);
  });

  it('writes though its writer was muted before it became an admin', async () => {
    const h = world();
    await seedWriter(ADMIN, { mutedAt: ago(86_400) });

    expect((await send(h, await h.signIn(ADMIN))).status).toBe(201);
  });

  it('passes no text rule: its link, its address and its bait are refused all the same', async () => {
    const h = world();
    const cookie = await h.signIn(ADMIN);

    expectRefusal(await send(h, cookie, 'the new site is prix-chat.io'), 'text_link');
    expectRefusal(await send(h, cookie, 'see https://prix.test/league'), 'text_link');
    expectRefusal(await send(h, cookie, `send to ${OTHER_TOKEN}`), 'text_address');
    expectRefusal(await send(h, cookie, 'Prix support here, dm me'), 'text_bait');
    expectRefusal(await send(h, cookie, ''), 'text_empty');
    expect(metered.meter.writes).toBe(0);
    expect(await ledger(ADMIN)).toEqual(NOTHING);
  });

  it('does not pass the limiter', async () => {
    const h = world();
    const cookie = await h.signIn(ADMIN);
    h.limiter.writesAllowed = 0;

    const first = await send(h, cookie);
    expect(errorOf(first).code).toBe('rate_limited');
    h.limiter.writesAllowed = 2;
    const second = await send(h, cookie);

    expect(errorOf(second).code).toBe('rate_limited');
    expect(await ledger(ADMIN)).toEqual(NOTHING);
  });

  it('does not pass requireWriter: with its writes of the day used up it is refused, and nothing is stored', async () => {
    const h = world();
    const cookie = await h.signIn(ADMIN);
    await db
      .prepare('UPDATE users SET write_day = ?2, write_count = ?3 WHERE address = ?1')
      .bind(ADMIN, DAY, WALLET_WRITES_PER_DAY)
      .run();

    const reply = await send(h, cookie);

    expect(errorOf(reply).code).toBe('daily_limit');
    expect((await ledger(ADMIN)).messages).toBe(0);
  });

  it('is an admin by its address in lower case, however the list or the session spells it', async () => {
    const upper = `0x${ADMIN.slice(2).toUpperCase()}`;
    const listedUpper = world({ adminAddresses: [upper] });
    listedUpper.gate.on = false;
    const first = await send(listedUpper, await listedUpper.signIn(ADMIN));
    expect(first.status, first.text).toBe(201);
    expect(first.json.message.admin).toBe(true);

    await emptyRoomTables(db);
    const sessionUpper = world();
    sessionUpper.gate.on = false;
    const second = await send(sessionUpper, await sessionUpper.signIn(upper));
    expect(second.status, second.text).toBe(201);
    expect(second.json.message.admin).toBe(true);
  });

  it('is nobody else: a holder is not marked, and cannot type the mark', async () => {
    const h = world();
    const cookie = await h.signIn(HOLDER);

    const typed = await h.fetch('POST', '/api/social/room', { cookie, body: { text: LINE, admin: true } });
    expect(typed.status).toBe(400);
    const plain = await send(h, cookie);

    expect(plain.json.message.admin).toBe(false);
    expect((await ledger(HOLDER)).messages).toBe(1);
  });
});

describe('the switch', () => {
  it('answers the four public routes exactly as an unknown path while the room is off, and writes nothing', async () => {
    const h = world({ on: false });
    const cookie = await h.signIn(HOLDER);
    const seen = (reply: Reply) => ({
      status: reply.status,
      text: reply.text,
      headers: [...reply.headers.entries()].map(([name, value]) => `${name}: ${value}`).sort(),
    });
    const unknown = seen(await h.fetch('GET', '/api/social/no-such-path', { cookie }));
    expect(unknown.status).toBe(404);
    metered.reset();

    expect(seen(await h.fetch('GET', '/api/social/room/status'))).toEqual(unknown);
    expect(seen(await h.fetch('GET', '/api/social/room'))).toEqual(unknown);
    expect(seen(await h.fetch('GET', '/api/social/room/me', { cookie }))).toEqual(unknown);
    const unknownWrite = seen(await h.fetch('POST', '/api/social/no-such-path', { cookie, body: { text: LINE } }));
    expect(seen(await h.fetch('POST', '/api/social/room', { cookie, body: { text: LINE } }))).toEqual(unknownWrite);

    expect(metered.meter.log.filter((sql) => /room_/.test(sql))).toEqual([]);
    expect(metered.meter.writes).toBe(0);
    expect(await ledger(HOLDER)).toEqual(NOTHING);
  });
});

describe("the composer's own read, `me`", () => {
  const me = (h: RoomHarness, cookie?: string) => h.fetch('GET', '/api/social/room/me', { cookie });

  it('is for a session, and is never cached', async () => {
    const h = world();

    expect((await me(h)).status).toBe(401);
    const reply = await me(h, await h.signIn(HOLDER));
    expect(reply.status).toBe(200);
    expect(reply.headers.get('Cache-Control')).toBe('no-store');
  });

  it('answers the gate, then the holding, then the mute, then yes with what is left today', async () => {
    const h = world();
    await seedWriter(HOLDER, { mutedAt: ago(60) });
    await seedWriter(POOR, { mutedAt: ago(60) });
    const holder = await h.signIn(HOLDER);
    const poor = await h.signIn(POOR);
    const second = await h.signIn(SECOND);
    const read = async (cookie: string) => roomMeResponseSchema.parse((await me(h, cookie)).json);

    h.gate.on = false;
    expect(await read(holder)).toEqual({ write: 'gate_off', left: 0 });
    expect(await read(poor)).toEqual({ write: 'gate_off', left: 0 });
    h.gate.on = true;
    expect(await read(poor)).toEqual({ write: 'not_holder', left: 0 });
    expect(await read(holder)).toEqual({ write: 'muted', left: 0 });
    expect(await read(second)).toEqual({ write: 'yes', left: ROOM_MESSAGES_PER_WALLET_PER_DAY });

    expect((await send(h, second)).status).toBe(201);
    expect(await read(second)).toEqual({ write: 'yes', left: ROOM_MESSAGES_PER_WALLET_PER_DAY - 1 });
    h.setNow('2026-10-21T00:00:00.000Z');
    expect(await read(second)).toEqual({ write: 'yes', left: ROOM_MESSAGES_PER_WALLET_PER_DAY });
  });

  it("asks the wallet's holding without `cachedOnly`, asks no tier, and writes nothing", async () => {
    const h = world();
    const cookie = await h.signIn(HOLDER);
    metered.reset();

    await me(h, cookie);

    expect(h.holdingReads).toEqual([{ address: HOLDER, cachedOnly: false }]);
    expect(h.tierReads).toEqual([]);
    expect(metered.meter.writes).toBe(0);
  });

  it('answers not_holder below one whole token and yes from one, whatever the tier', async () => {
    const h = world();
    const cookie = await h.signIn(POOR);
    const read = async () => roomMeResponseSchema.parse((await me(h, cookie)).json);
    h.tiers.set(POOR, 3);

    for (const tokens of [0, 0.5, 0.999999, -1, Number.NaN]) {
      h.holdings.set(POOR, tokens);
      expect(await read(), `${tokens} tokens`).toEqual({ write: 'not_holder', left: 0 });
    }
    h.tiers.set(POOR, 0);
    h.holdings.set(POOR, ROOM_WRITE_MIN_TOKENS);
    expect(await read()).toEqual({ write: 'yes', left: ROOM_MESSAGES_PER_WALLET_PER_DAY });

    expect(h.tierReads).toEqual([]);
  });

  it('answers an admin yes with a whole day, whatever the gate, its holding and its row say', async () => {
    const h = world();
    h.gate.on = false;
    await seedWriter(ADMIN, { mutedAt: ago(60), day: DAY, count: ROOM_MESSAGES_PER_WALLET_PER_DAY });

    const reply = await me(h, await h.signIn(ADMIN));

    expect(roomMeResponseSchema.parse(reply.json)).toEqual({ write: 'yes', left: ROOM_MESSAGES_PER_WALLET_PER_DAY });
    expect(h.holdingReads).toEqual([]);
    expect(h.tierReads).toEqual([]);
  });
});

describe("the token service's own `holdingOf` behind `deps.holding`", () => {
  /** One whole $PRIX in base units: the token has 18 decimals. */
  const ONE_TOKEN = 10n ** 18n;
  /** A supply of one billion tokens, as $PRIX has: one token is far below tier 1 (10,000 tokens). */
  const SUPPLY = 10n ** 27n;

  /**
   * The room on the real token service, which stands on a store and a chain of this test: the store keeps
   * the rows the service writes, the chain answers the balances the test set and records who was asked.
   * A method of the store that the room's two calls have no business with throws.
   */
  function tokenWorld(config: Partial<TokenConfig> = {}) {
    resetTokenMemory();
    const rows = new Map<string, TokenHolder>();
    const chain = { balances: new Map<string, bigint>(), asked: [] as string[] };
    const stored: TokenConfig = {
      enabled: true,
      tokenAddress: PRIX as Address,
      thresholdsPpm: [10, 100, 1_000],
      buyUrl: null,
      activatedAt: '2026-10-08T18:37:00.000Z',
      updatedAt: '2026-10-08T18:37:00.000Z',
      updatedBy: 'test',
      ...config,
    };
    const store = new Proxy(
      {
        getConfig: async () => structuredClone(stored),
        getHolder: async (address: Address, token: Address) => {
          const row = rows.get(address);
          return row === undefined || row.tokenAddress !== token ? null : { ...row };
        },
        putHolders: async (put: readonly TokenHolder[]) => {
          for (const row of put) rows.set(row.address, { ...row });
        },
        applySlots: async () => ({ paused: 0, resumed: 0 }),
        countOwnerAgents: async () => ({ total: 0, pausedForSlots: 0 }),
      } as Partial<TokenStore> as TokenStore,
      {
        get(target, key, receiver) {
          if (!(key in target)) throw new Error(`unexpected use of the token store: ${String(key)}`);
          return Reflect.get(target, key, receiver);
        },
      },
    );
    const reader: TokenChainReader = {
      async readBalances(_token, wallets) {
        chain.asked.push(...wallets);
        return {
          totalSupply: SUPPLY,
          decimals: 18,
          balances: wallets.map((wallet) => chain.balances.get(wallet) ?? 0n),
          blockNumber: 1_000n,
        };
      },
    };
    const clock: { h: RoomHarness | null } = { h: null };
    const service = createTokenService({ store, chain: reader, now: () => new Date(clock.h?.now() ?? NOW) });
    const h = world({ holding: (address, read) => service.holdingOf(address, read) });
    clock.h = h;
    return { h, chain, rows };
  }

  const me = async (h: RoomHarness, cookie: string) =>
    roomMeResponseSchema.parse((await h.fetch('GET', '/api/social/room/me', { cookie })).json);

  it('refuses a holding Prix has not read without reading the chain, and lets one whole token write once `me` has read it', async () => {
    const { h, chain, rows } = tokenWorld();
    chain.balances.set(HOLDER, ONE_TOKEN);
    const cookie = await h.signIn(HOLDER);

    // The write asks the stored holding only: a stranger cannot make the Worker read the chain.
    expectRefusal(await send(h, cookie), 'not_holder');
    expect(chain.asked).toEqual([]);
    expect(await ledger(HOLDER)).toEqual(NOTHING);

    // The composer's read reads it, and the holding counts at the first read that shows it: no hour's wait.
    expect(await me(h, cookie)).toEqual({ write: 'yes', left: ROOM_MESSAGES_PER_WALLET_PER_DAY });
    expect(chain.asked).toEqual([HOLDER]);

    // Another isolate finds the stored row, and the write still reads no chain.
    resetTokenMemory();
    const written = await send(h, cookie);
    expect(written.status, written.text).toBe(201);
    expect(chain.asked).toEqual([HOLDER]);

    // One token of a billion is tier 0, and the room asked no tier.
    expect(rows.get(HOLDER)?.tier).toBe(0);
    expect(h.tierReads).toEqual([]);
  });

  it('refuses one base unit less than a whole token, at `me` and at the write, and counts and writes nothing', async () => {
    const { h, chain } = tokenWorld();
    chain.balances.set(POOR, ONE_TOKEN - 1n);
    const cookie = await h.signIn(POOR);

    expect(await me(h, cookie)).toEqual({ write: 'not_holder', left: 0 });
    expect(chain.asked).toEqual([POOR]);
    const reply = await send(h, cookie);

    expectRefusal(reply, 'not_holder');
    expect(metered.meter.writes).toBe(0);
    expect(await ledger(POOR)).toEqual(NOTHING);
  });

  it('refuses a wallet that holds nothing, at `me` and at the write', async () => {
    const { h } = tokenWorld();
    const cookie = await h.signIn(POOR);

    expect(await me(h, cookie)).toEqual({ write: 'not_holder', left: 0 });
    expectRefusal(await send(h, cookie), 'not_holder');
    expect(await ledger(POOR)).toEqual(NOTHING);
  });

  it('stops a holder who sold once `me` has read the holding again, TOKEN_CACHE_SECONDS after the last read', async () => {
    const { h, chain } = tokenWorld();
    chain.balances.set(HOLDER, ONE_TOKEN);
    const cookie = await h.signIn(HOLDER);
    expect(await me(h, cookie)).toEqual({ write: 'yes', left: ROOM_MESSAGES_PER_WALLET_PER_DAY });
    expect((await send(h, cookie)).status).toBe(201);

    chain.balances.set(HOLDER, 0n);
    h.advance(TOKEN_CACHE_SECONDS * 1_000);

    expect(await me(h, cookie)).toEqual({ write: 'not_holder', left: 0 });
    expect(chain.asked).toEqual([HOLDER, HOLDER]);
    expectRefusal(await send(h, cookie, 'and one more line'), 'not_holder');
    expect((await ledger(HOLDER, h.now())).messages).toBe(1);
  });

  it('answers gate_off to a holder while the token gate is off or there is no token, and an admin still writes', async () => {
    for (const config of [{ enabled: false }, { enabled: false, tokenAddress: null }] as const) {
      await emptyRoomTables(db);
      const { h, chain } = tokenWorld(config);
      chain.balances.set(HOLDER, 5n * ONE_TOKEN);
      const cookie = await h.signIn(HOLDER);

      expect(await me(h, cookie)).toEqual({ write: 'gate_off', left: 0 });
      expectRefusal(await send(h, cookie), 'gate_off');
      expect(chain.asked).toEqual([]);
      expect(await ledger(HOLDER)).toEqual(NOTHING);
      const admin = await send(h, await h.signIn(ADMIN));
      expect(admin.status, admin.text).toBe(201);
    }
  });
});
