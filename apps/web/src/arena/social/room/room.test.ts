// The Community chat's reads, as the site makes them: what the sample answers hold, when the status is
// asked, and how the contract's note on the token is filled (docs/contracts/phase-6-room.md, sections 6
// and 9). Run: pnpm exec vitest run --config apps/web/src/arena/vitest.config.ts
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ROOM_PAGE,
  ROOM_TEXT_MAX,
  ROOM_TOKEN_NOTE,
  ROOM_WRITE_MIN_TOKENS,
  roomFoldText,
  roomResponseSchema,
  roomStatusResponseSchema,
  roomTextProblem,
  roomWithPicturesResponseSchema,
  TOKEN_CACHE_SECONDS,
} from '@prix/contracts';
import { describe, expect, it } from 'vitest';
import { deck } from '../../../content/deck.ts';
import { minutesOf } from '../../../content/facts.ts';
import { socialAnswer } from '../fixtures.ts';
import { PROBE_FAILED_KEEP_MS, PROBE_KEEP_MS, type RoomProbeSlot, roomSwitch } from './client.ts';
import { ROOM_FIXTURES, roomAnswer, roomSample } from './fixtures.ts';
import { emptyRoomBody, tokenNoteParts } from './words.ts';

const READ = '/api/social/room';
const STATUS = '/api/social/room/status';
const WHOLE_ADDRESS = /0x[0-9a-fA-F]{40}/;

/** The states whose read answers messages, and the one whose texts the API itself would refuse. */
const WITH_MESSAGES = ROOM_FIXTURES.filter((name) => roomSample(name) !== null);
const AS_THE_API_ANSWERS = WITH_MESSAGES.filter((name) => name !== 'social-room-markup');

describe('the sample answers of the room', () => {
  it('names every state social-room-', () => {
    expect(ROOM_FIXTURES.length).toBeGreaterThan(0);
    for (const name of ROOM_FIXTURES) expect(name.startsWith('social-room-')).toBe(true);
  });

  it('answers the read in the shape of the contract, in every state that has one', () => {
    // The room's own schema for an answer before pictures; the schema of Phase 6.4 for every answer.
    expect(roomResponseSchema.safeParse(roomSample(null)).success).toBe(true);
    for (const name of WITH_MESSAGES) {
      const parsed = roomWithPicturesResponseSchema.safeParse(roomSample(name));
      expect(parsed.success, name).toBe(true);
    }
  });

  it('holds only texts the text rule lets through, folded as they are stored', () => {
    for (const name of [null, ...AS_THE_API_ANSWERS]) {
      const sample = roomSample(name);
      if (sample === null) throw new Error(`no sample for ${name}`);
      const allowed = { prixAddress: sample.prixAddress, siteHost: sample.siteHost };
      for (const message of sample.messages) {
        expect(roomTextProblem(message.text, allowed), `${name}: ${message.text}`).toBeNull();
        expect(roomFoldText(message.text), `${name}: ${message.text}`).toBe(message.text);
      }
    }
  });

  it('gives a writer as a short address and never a whole one', () => {
    for (const name of [null, ...WITH_MESSAGES]) {
      for (const message of roomSample(name)?.messages ?? []) {
        expect(WHOLE_ADDRESS.test(message.authorShort), `${name}: ${message.authorShort}`).toBe(false);
      }
    }
  });

  it('orders every page newest first, by id and by time', () => {
    for (const name of [null, ...WITH_MESSAGES]) {
      const messages = roomSample(name)?.messages ?? [];
      for (let index = 1; index < messages.length; index += 1) {
        const newer = messages[index - 1];
        const older = messages[index];
        if (!newer || !older) throw new Error('a hole in the sample');
        expect(newer.id, name ?? 'default').toBeGreaterThan(older.id);
        expect(Date.parse(newer.at), name ?? 'default').toBeGreaterThanOrEqual(Date.parse(older.at));
      }
    }
  });

  it('has an empty room, a full page, a message of an admin and a message at the longest length', () => {
    expect(roomSample('social-room-empty')?.messages).toEqual([]);
    expect(roomSample('social-room-full')?.messages.length).toBe(ROOM_PAGE);
    expect(roomSample('social-room-admin')?.messages.some((message) => message.admin)).toBe(true);
    expect(roomSample('social-room-admin')?.messages.some((message) => !message.admin)).toBe(true);
    const longest = roomSample('social-room-longest')?.messages ?? [];
    // One of a writer and one of an admin, so that the mark and a long text meet.
    expect(longest.some((message) => !message.admin && message.text.length === ROOM_TEXT_MAX)).toBe(true);
    expect(longest.some((message) => message.admin && message.text.length === ROOM_TEXT_MAX)).toBe(true);
  });

  it('has a room whose token has no address yet', () => {
    expect(roomSample('social-room-no-token')?.prixAddress).toBeNull();
    expect(roomSample(null)?.prixAddress).not.toBeNull();
  });

  it('answers 404 for the status and the read while the room is off, and only then', () => {
    for (const path of [STATUS, READ]) {
      expect(roomAnswer('social-room-off', path)).toMatchObject({ kind: 'error', status: 404 });
    }
    for (const name of [null, ...ROOM_FIXTURES.filter((fixture) => fixture !== 'social-room-off')]) {
      const status = roomAnswer(name, STATUS);
      expect(status.kind, name ?? 'default').toBe('data');
      if (status.kind === 'data') expect(roomStatusResponseSchema.safeParse(status.data).success).toBe(true);
    }
  });

  it('fails the read and keeps the status on in the error state', () => {
    expect(roomAnswer('social-room-error', STATUS).kind).toBe('data');
    expect(roomAnswer('social-room-error', READ)).toMatchObject({ kind: 'error', status: 500 });
  });

  it('reads no query: a path with one is answered as the path alone', () => {
    expect(roomAnswer('social-room-full', `${READ}?before=3&page=2`)).toEqual(roomAnswer('social-room-full', READ));
  });

  it('is what the Phase 6 fixtures answer for the room, and follows their switch', () => {
    expect(socialAnswer('social-room-empty', READ)).toEqual(roomAnswer('social-room-empty', READ));
    expect(socialAnswer(null, STATUS)).toEqual(roomAnswer(null, STATUS));
    for (const path of [STATUS, READ]) {
      expect(socialAnswer('social-off', path)).toMatchObject({ kind: 'error', status: 404 });
      expect(socialAnswer('social-error', path)).toMatchObject({ kind: 'error', status: 500 });
    }
    // The room off leaves the rest of Phase 6 on.
    expect(socialAnswer('social-room-off', '/api/social/status').kind).toBe('data');
  });
});

describe('the probe of the room', () => {
  const asked = (answers: Array<'on' | 'off' | 'failed'>) => {
    const calls = { count: 0 };
    const ask = async () => {
      const answer = answers[Math.min(calls.count, answers.length - 1)] ?? 'failed';
      calls.count += 1;
      return answer;
    };
    return { calls, ask };
  };

  it('asks the status once and keeps the answer for a minute', async () => {
    const slot: RoomProbeSlot = {};
    const { calls, ask } = asked(['on', 'off']);
    expect(await roomSwitch({ slot, now: 1_000, social: 'on', ask })).toBe('on');
    expect(await roomSwitch({ slot, now: 1_000 + PROBE_KEEP_MS - 1, social: 'on', ask })).toBe('on');
    expect(calls.count).toBe(1);
    expect(await roomSwitch({ slot, now: 1_000 + PROBE_KEEP_MS, social: 'on', ask })).toBe('off');
    expect(calls.count).toBe(2);
  });

  it('keeps an answer of off for the minute too, so a closed room costs one call a minute', async () => {
    const slot: RoomProbeSlot = {};
    const { calls, ask } = asked(['off']);
    for (const now of [0, 10_000, 30_000, PROBE_KEEP_MS - 1]) {
      expect(await roomSwitch({ slot, now, social: 'on', ask })).toBe('off');
    }
    expect(calls.count).toBe(1);
  });

  it('asks again sooner after a probe that failed', async () => {
    const slot: RoomProbeSlot = {};
    const { calls, ask } = asked(['failed', 'on']);
    expect(await roomSwitch({ slot, now: 0, social: 'on', ask })).toBe('failed');
    expect(await roomSwitch({ slot, now: PROBE_FAILED_KEEP_MS - 1, social: 'on', ask })).toBe('failed');
    expect(calls.count).toBe(1);
    expect(await roomSwitch({ slot, now: PROBE_FAILED_KEEP_MS, social: 'on', ask })).toBe('on');
    expect(calls.count).toBe(2);
  });

  it('never asks the room while Phase 6 itself is not on, and keeps nothing of that', async () => {
    const slot: RoomProbeSlot = {};
    const { calls, ask } = asked(['on']);
    expect(await roomSwitch({ slot, now: 0, social: 'off', ask })).toBe('off');
    expect(await roomSwitch({ slot, now: 1, social: 'failed', ask })).toBe('failed');
    expect(calls.count).toBe(0);
    expect(slot.kept).toBeUndefined();
    expect(await roomSwitch({ slot, now: 2, social: 'on', ask })).toBe('on');
    expect(calls.count).toBe(1);
  });
});

describe('the body of the empty room', () => {
  // The deck's own sentences, by their keys: read from the deck itself, so a missing key fails here. Not
  // through `text(`: the copy check reads every such call under src, and a draft there is a real sentence.
  const signedOut = deck['social.roomEmptyBody'] ?? '';
  const signedIn = deck['social.roomEmptyBodySignedIn'] ?? '';

  it('has both sentences in the deck, and they differ', () => {
    expect(signedOut.length).toBeGreaterThan(0);
    expect(signedIn.length).toBeGreaterThan(0);
    expect(signedIn).not.toBe(signedOut);
  });

  it('tells a visitor who is not signed in how to write', () => {
    expect(emptyRoomBody(false)).toBe(signedOut);
    expect(emptyRoomBody(false)).toMatch(/\bsign in\b/i);
  });

  it('never tells a signed-in visitor to sign in', () => {
    expect(emptyRoomBody(true)).toBe(signedIn);
    expect(emptyRoomBody(true)).not.toMatch(/\bsign(?:ed)? in\b/i);
  });

  it('leaves no unfilled slot in either sentence', () => {
    for (const body of [emptyRoomBody(false), emptyRoomBody(true)]) expect(body).not.toMatch(/[{}]/);
  });
});

describe('who may write, as this folder words it (revision 7 of the contract)', () => {
  // Section 9: "No sentence of the room names a tier". Writing takes a holding of whole $PRIX, and a new
  // holding counts at Prix's next read of the wallet, not after the hour a tier waits.
  const HERE = fileURLToPath(new URL('.', import.meta.url));
  const SOURCES = readdirSync(HERE).filter((name) => /\.(?:ts|astro|mjs)$/.test(name) && !name.endsWith('.test.ts'));
  const source = (name: string) => readFileSync(`${HERE}${name}`, 'utf8');

  it('names no tier in any file of the folder, as a word or as a constant', () => {
    expect(SOURCES).toContain('words.ts');
    for (const name of SOURCES) {
      const lines = source(name)
        .split('\n')
        .filter((line) => /\btiers?\b|_TIER\b/i.test(line));
      expect(lines, name).toEqual([]);
    }
  });

  it("keeps each draft of the empty room's body as the deck's own sentence", () => {
    const words = source('words.ts');
    for (const key of ['social.roomEmptyBody', 'social.roomEmptyBodySignedIn']) {
      const sentence = deck[key] ?? '';
      expect(sentence.length, key).toBeGreaterThan(0);
      expect(words.includes(`'${sentence}'`), `${key}: ${sentence}`).toBe(true);
    }
  });

  it('asks for the holding of the contract in the sentence a signed-out visitor reads', () => {
    expect(emptyRoomBody(false)).toContain(`at least ${ROOM_WRITE_MIN_TOKENS} $PRIX`);
  });

  it("gives the deck's wait for a new holding in the sample talk, and never the hour of a tier", () => {
    const wait = minutesOf(TOKEN_CACHE_SECONDS);
    expect(deck['social.roomRefusalNotHolder'] ?? '').toContain(wait);
    const talk = (roomSample(null)?.messages ?? []).map((message) => message.text);
    expect(talk.some((line) => line.includes(wait))).toBe(true);
    for (const name of [null, ...WITH_MESSAGES]) {
      for (const message of roomSample(name)?.messages ?? []) {
        expect(message.text, `${name}: ${message.text}`).not.toMatch(/\b(?:an|one|1) hour\b/i);
        expect(message.text, `${name}: ${message.text}`).not.toMatch(/\btiers?\b/i);
      }
    }
  });
});

describe('the note on the token', () => {
  const ADDRESS = '0xa74ac6e9f2f8493344923c23972d496364241044';

  it('is left out while the token has no address', () => {
    expect(tokenNoteParts(null)).toBeNull();
  });

  it("is the contract's sentence with the address in its place, as a piece of its own", () => {
    const parts = tokenNoteParts(ADDRESS);
    if (parts === null) throw new Error('no note');
    expect(parts.address).toBe(ADDRESS);
    expect(`${parts.before}${parts.address}${parts.after}`).toBe(ROOM_TOKEN_NOTE.replace('{address}', ADDRESS));
    expect(parts.before).not.toContain('{');
    expect(parts.after).not.toContain('}');
  });
});
