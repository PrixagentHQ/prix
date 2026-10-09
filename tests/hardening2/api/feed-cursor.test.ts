import {
  agentFeedResponseSchema,
  feedCursorBase,
  feedCursorSchema,
  followingFeedResponseSchema,
  formatFeedCursor,
  leagueFeedResponseSchema,
  parseFeedCursor,
} from '@prix/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createFeedCursorSigner } from '../../../apps/api/src/http/follow/feed-cursor.ts';
import type { Harness } from '../../follow/support.ts';
import { createHarness, followAgent, readAll, TICK_IDS, wallet } from '../../follow/support.ts';
import { expectError, expectShape, NONCE_SECRET, OTHER_NONCE_SECRET, type Reply } from '../../support/api.ts';

/**
 * Signed feed cursors (docs/CONTRACTS.md section 20; security review of 2026-10-08, the newest reads,
 * finding 3). Every feed issues only cursors it signed, and answers any other with 400 `invalid_input`
 * on the field `cursor` before it reads anything: no agent, no session, no row.
 */

const VIEWER = wallet(71);
const LEAGUE = '/api/feed/league';

/** Counts every read of the feed store, so a test can say that a refused cursor read nothing. */
function countReads(h: Harness): () => number {
  const spy = vi.spyOn(h.feedStore as unknown as { page: (...args: unknown[]) => unknown }, 'page');
  return () => spy.mock.calls.length;
}

function expectCursorRefused(reply: Reply): void {
  expectError(reply, 400, 'invalid_input');
  expect(reply.json.error.field).toBe('cursor');
  expect(reply.headers.get('Cache-Control')).toBe('no-store');
}

/** A cursor of a real row, signed by the API's secret. */
async function signedCursorOf(h: Harness): Promise<string> {
  const first = expectShape(leagueFeedResponseSchema, await h.anonymous().get(`${LEAGUE}?limit=1`));
  expect(first.nextCursor).not.toBeNull();
  return first.nextCursor as string;
}

describe('the feed cursor signer', () => {
  it('signs as `<tickId>~<agentId>~<16 base32>` and accepts only what it signed', async () => {
    const signer = createFeedCursorSigner(NONCE_SECRET);
    const cursor = { tickId: '2026-10-06T15:00Z', agentId: 'abcdefghijkl' };
    const text = await signer.sign(cursor);
    expect(feedCursorSchema.safeParse(text).success).toBe(true);
    expect(text.startsWith(`${feedCursorBase(cursor)}~`)).toBe(true);
    // The same cursor always gets the same text, so a page boundary is one cache key.
    expect(await signer.sign(cursor)).toBe(text);
    expect(await signer.verify(text)).toEqual(cursor);
  });

  it('refuses a cursor of another secret, a changed tick or agent, and text that is no cursor', async () => {
    const signer = createFeedCursorSigner(NONCE_SECRET);
    const other = createFeedCursorSigner(OTHER_NONCE_SECRET);
    const cursor = { tickId: '2026-10-06T15:00Z', agentId: 'abcdefghijkl' };
    const text = await signer.sign(cursor);
    expect(await signer.verify(await other.sign(cursor))).toBeNull();
    const parsed = parseFeedCursor(text);
    expect(parsed).not.toBeNull();
    const signature = parsed?.signature as string;
    expect(await signer.verify(formatFeedCursor({ ...cursor, tickId: '2026-10-06T16:00Z' }, signature))).toBeNull();
    expect(await signer.verify(formatFeedCursor({ ...cursor, agentId: 'abcdefghijkm' }, signature))).toBeNull();
    const flipped = `${signature.slice(0, 15)}${signature[15] === 'a' ? 'b' : 'a'}`;
    expect(await signer.verify(formatFeedCursor(cursor, flipped))).toBeNull();
    for (const junk of ['', 'x', feedCursorBase(cursor), `${text}~`, text.toUpperCase()]) {
      expect(await signer.verify(junk), junk).toBeNull();
    }
  });

  it('derives its key from the secret and never uses the secret itself as the key', async () => {
    // HMAC under NONCE_SECRET itself over the base would let a sign-in nonce MAC stand in for a cursor MAC.
    const signer = createFeedCursorSigner(NONCE_SECRET);
    const cursor = { tickId: '2026-10-06T15:00Z', agentId: 'abcdefghijkl' };
    const raw = Uint8Array.from(atob(NONCE_SECRET), (char) => char.charCodeAt(0));
    const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const direct = new Uint8Array(
      await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(feedCursorBase(cursor))),
    );
    const parsed = parseFeedCursor(await signer.sign(cursor));
    const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
    let bits = '';
    for (const byte of direct.slice(0, 10)) bits += byte.toString(2).padStart(8, '0');
    let directText = '';
    for (let i = 0; i < 80; i += 5) directText += alphabet[Number.parseInt(bits.slice(i, i + 5), 2)];
    expect(parsed?.signature).not.toBe(directText);
  });
});

describe('GET /api/feed/league with a cursor', () => {
  it('issues signed cursors and walks every item with them', async () => {
    const h = createHarness();
    await h.seedAgent(1);
    await h.seedAgent(2);
    const client = h.anonymous();
    const first = expectShape(leagueFeedResponseSchema, await client.get(`${LEAGUE}?limit=5`));
    const last = first.items[4] as { tickId: string; agentId: string };
    expect(first.nextCursor).not.toBeNull();
    const verified = await createFeedCursorSigner(NONCE_SECRET).verify(first.nextCursor as string);
    expect(verified).toEqual({ tickId: last.tickId, agentId: last.agentId });
    const all = await readAll(client, LEAGUE, 5);
    expect(all).toHaveLength(TICK_IDS.length * 2);
  });

  it('answers a cursor it did not sign with 400 on the field cursor, and reads nothing', async () => {
    const h = createHarness();
    const agent = await h.seedAgent(1);
    const real = await signedCursorOf(h);
    const parsed = parseFeedCursor(real);
    const reads = countReads(h);
    const forged = [
      // The shape of a cursor before section 20: no signature.
      `${TICK_IDS[3]}~${agent.id}`,
      // A well-shaped cursor with an invented signature.
      formatFeedCursor({ tickId: TICK_IDS[3] as string, agentId: agent.id }, 'aaaaaaaaaaaaaaaa'),
      // A real signature moved to another tick.
      formatFeedCursor({ tickId: TICK_IDS[3] as string, agentId: agent.id }, parsed?.signature as string),
      // A cursor signed under another secret.
      await createFeedCursorSigner(OTHER_NONCE_SECRET).sign({ tickId: TICK_IDS[3] as string, agentId: agent.id }),
    ];
    for (const cursor of forged) {
      expectCursorRefused(await h.anonymous().get(`${LEAGUE}?cursor=${encodeURIComponent(cursor)}`));
    }
    expect(reads()).toBe(0);
    // The real one still works.
    expectShape(leagueFeedResponseSchema, await h.anonymous().get(`${LEAGUE}?cursor=${encodeURIComponent(real)}`));
    expect(reads()).toBe(1);
  });
});

describe('GET /api/agents/:id/feed with a cursor', () => {
  it('refuses a forged cursor before it looks the agent up', async () => {
    const h = createHarness();
    const agent = await h.seedAgent(1);
    const lookups = vi.fn();
    const store = h.feedStore as unknown as { agents: Map<string, unknown> };
    const original = store.agents.get.bind(store.agents);
    store.agents.get = (id: string) => {
      lookups(id);
      return original(id);
    };
    const reads = countReads(h);
    const forged = formatFeedCursor({ tickId: TICK_IDS[2] as string, agentId: agent.id }, 'bbbbbbbbbbbbbbbb');
    // An unknown agent too: 400 for the cursor, not 404, because nothing was looked up.
    for (const id of [agent.id, 'zzzzzzzzzzzz']) {
      expectCursorRefused(await h.anonymous().get(`/api/agents/${id}/feed?cursor=${encodeURIComponent(forged)}`));
    }
    expect(lookups).not.toHaveBeenCalled();
    expect(reads()).toBe(0);
  });

  it('pages with the cursors it signs', async () => {
    const h = createHarness();
    const agent = await h.seedAgent(1);
    const client = h.anonymous();
    const first = expectShape(agentFeedResponseSchema, await client.get(`/api/agents/${agent.id}/feed?limit=3`));
    expect(await createFeedCursorSigner(NONCE_SECRET).verify(first.nextCursor as string)).not.toBeNull();
    const items = await readAll(client, `/api/agents/${agent.id}/feed`, 3);
    expect(items.map((item) => item.tickId)).toEqual([...TICK_IDS].reverse());
  });
});

describe('GET /api/feed with a cursor', () => {
  it('refuses a forged cursor before it reads the session', async () => {
    const h = createHarness();
    const agent = await h.seedAgent(1);
    const forged = formatFeedCursor({ tickId: TICK_IDS[2] as string, agentId: agent.id }, 'cccccccccccccccc');
    const getSession = vi.spyOn(h.api.store, 'getSession');
    // Not signed in: still 400 for the cursor, because the session is never read.
    expectCursorRefused(await h.anonymous().get(`/api/feed?cursor=${encodeURIComponent(forged)}`));
    expect(getSession).not.toHaveBeenCalled();
    const client = await h.as(VIEWER);
    followAgent(h, VIEWER.address, agent.id);
    getSession.mockClear();
    expectCursorRefused(await client.get(`/api/feed?cursor=${encodeURIComponent(forged)}`));
    expect(getSession).not.toHaveBeenCalled();
  });

  it('pages with the cursors it signs', async () => {
    const h = createHarness();
    const agent = await h.seedAgent(1);
    const client = await h.as(VIEWER);
    followAgent(h, VIEWER.address, agent.id);
    const first = expectShape(followingFeedResponseSchema, await client.get('/api/feed?limit=4'));
    expect(await createFeedCursorSigner(NONCE_SECRET).verify(first.nextCursor as string)).not.toBeNull();
    const items = await readAll(client, '/api/feed', 4);
    expect(items).toHaveLength(TICK_IDS.length);
  });
});
