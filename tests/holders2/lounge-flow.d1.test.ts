import type {
  Address,
  HoldersGate,
  LoungeJoinFacts,
  LoungeSweepJobDeps,
  RoomAuthorHolder,
  TelegramLoungePort,
  TelegramSend,
} from '@prix/contracts';
import { LOUNGE_DIRECT_MESSAGES, loungeJoinDecision } from '@prix/contracts';
import { createLoungeSweepJob } from '@prix/runtime/social/index';
import { beforeEach, describe, expect, it } from 'vitest';
import { createLoungeStore } from '../../apps/api/src/store/lounge.ts';
import { db } from '../social/support/d1.ts';

/**
 * Phase 6.8, G (docs/contracts/phase-6-holders-2.md sections 4.2 to 4.6, qa cases 6 and 7): the lounge's real
 * store on a local D1 with the real migrations (0019 among them), the real sweep job, and Telegram and the
 * token service's fresh read in memory. The join is judged by the contract's own `loungeJoinDecision` on
 * facts the real store reads, in the route's order.
 *
 * What this file holds that the owners' tests do not: the store and the sweep together on one database, a
 * link passed on from one Telegram account to another end to end, and members the bot never let in (the founder,
 * admins, anyone added by hand) who have no row and are never touched.
 */

const CHAT = -1001234567890;
const CONFIG = { chatId: CHAT, inviteUrl: 'https://t.me/+AbCdEfGh12345678' };
const TOKEN = `0x${'7'.repeat(40)}` as Address;
const SITE = 'https://prixagent.com';
const W = '0x00000000000000000000000000000000000000b1' as Address;
const W2 = '0x00000000000000000000000000000000000000b2' as Address;
const A = 111_111;
const B = 222_222;
const HAND_ADDED = 333_333;
const JOIN_AT = '2026-10-19T12:00:00.000Z';
const SWEEP_AT = new Date('2026-10-20T03:00:00.000Z');

async function link(wallet: Address, chatId: number, enabled = 1): Promise<void> {
  await db.prepare('DELETE FROM notify_chats WHERE address = ?1 OR chat_id = ?2').bind(wallet, chatId).run();
  await db
    .prepare('INSERT INTO notify_chats (address, chat_id, enabled, linked_at) VALUES (?1, ?2, ?3, ?4)')
    .bind(wallet, chatId, enabled, JOIN_AT)
    .run();
}

/** The facts of a join, read by the real store in the route's order (section 4.4 steps 3 to 5). */
async function judge(userId: number, tier: number, now: string, checkedAt: string = now) {
  const store = createLoungeStore(db);
  const linkedWallet = await store.chatWallet(userId);
  const members = linkedWallet === null ? null : await store.members(userId, linkedWallet, now);
  const facts: LoungeJoinFacts = {
    config: CONFIG,
    request: {
      chat: { id: CHAT, type: 'supergroup' },
      from: { id: userId, is_bot: false, first_name: 'x' },
    } as LoungeJoinFacts['request'],
    linkedWallet,
    members,
    entitlements: { gatingOn: true, tier: tier as 0 | 1 | 2 | 3 },
    holdingCheckedAt: checkedAt,
    now,
  };
  return { decision: loungeJoinDecision(facts), linkedWallet, store };
}

/** Approve as section 4.4 step 7 does: the row first. */
async function approve(userId: number, now: string): Promise<'stored' | 'wallet_taken' | 'refused'> {
  const { decision, linkedWallet, store } = await judge(userId, 1, now);
  if (decision.action !== 'approve' || linkedWallet === null) return 'refused';
  return store.putMember(userId, linkedWallet, now);
}

function sweepWorld(chainTiers: Map<Address, number>, gate: HoldersGate = { gatingOn: true, token: TOKEN }) {
  const calls: { method: string; userId: number; text?: string }[] = [];
  const state = new Map<string, string>();
  const lines: string[] = [];
  const answer = (): TelegramSend => ({ ok: true });
  const port: TelegramLoungePort = {
    approveJoin: async (_c, userId) => (calls.push({ method: 'approveJoin', userId }), answer()),
    declineJoin: async (_c, userId) => (calls.push({ method: 'declineJoin', userId }), answer()),
    ban: async (chatId, userId) => {
      expect(chatId).toBe(CHAT);
      calls.push({ method: 'ban', userId });
      return answer();
    },
    unban: async (_c, userId) => (calls.push({ method: 'unban', userId }), answer()),
    sendDirect: async (chatId, text) => (calls.push({ method: 'sendDirect', userId: chatId, text }), answer()),
  };
  const deps: LoungeSweepJobDeps = {
    lounge: createLoungeStore(db),
    config: CONFIG,
    port,
    holdersGate: async () => gate,
    refreshHolders: async (wallets, now) => {
      const out = new Map<Address, RoomAuthorHolder>();
      for (const wallet of wallets) {
        out.set(wallet, { tier: chainTiers.get(wallet) ?? 0, tokenAddress: TOKEN, checkedAt: now.toISOString() });
      }
      return out;
    },
    siteOrigin: SITE,
    social: {
      putCursor: async (cursor: { name: string; body: string }) => {
        state.set(cursor.name, cursor.body);
      },
    } as unknown as LoungeSweepJobDeps['social'],
    reputation: {
      getJobState: async (name: string) => state.get(name) ?? null,
    } as unknown as LoungeSweepJobDeps['reputation'],
    now: () => SWEEP_AT,
    log: (event, data) => {
      lines.push(`${event} ${JSON.stringify(data)}`);
    },
  };
  return { calls, lines, run: () => createLoungeSweepJob(deps).run(SWEEP_AT) };
}

async function memberIds(): Promise<number[]> {
  const rows = await db
    .prepare('SELECT telegram_user_id AS id FROM holders_lounge_members ORDER BY telegram_user_id')
    .all<{ id: number }>();
  return rows.results.map((row) => row.id);
}

beforeEach(async () => {
  await db.prepare('DELETE FROM holders_lounge_members').run();
  await db.prepare('DELETE FROM notify_chats').run();
});

describe('case 6: a link passed on', () => {
  it('A is let in by W; W relinked to B is wallet_taken; the sweep removes A as unlinked; then B is let in', async () => {
    await link(W, A);
    expect(await approve(A, JOIN_AT)).toBe('stored');
    expect(await memberIds()).toEqual([A]);

    // W is relinked to account B on /following: notify_chats holds one chat per wallet.
    await link(W, B);
    const refused = await judge(B, 1, JOIN_AT);
    expect(refused.decision).toEqual({ action: 'decline', reason: 'wallet_taken' });
    // Even a race past the decision is refused by the unique index.
    expect(await createLoungeStore(db).putMember(B, W, JOIN_AT)).toBe('wallet_taken');
    expect(await memberIds()).toEqual([A]);

    const world = sweepWorld(new Map([[W, 1]]));
    await world.run();
    expect(world.calls.map((call) => `${call.method}:${call.userId}`)).toEqual([
      `ban:${A}`,
      `unban:${A}`,
      `sendDirect:${A}`,
    ]);
    expect(world.calls[2]?.text).toBe(
      LOUNGE_DIRECT_MESSAGES.remove_unlinked.replace('{following}', `${SITE}/following`),
    );
    expect(await memberIds()).toEqual([]);

    expect(await approve(B, '2026-10-20T04:00:00.000Z')).toBe('stored');
    expect(await memberIds()).toEqual([B]);
  });
});

describe('case 7 on D1: a tier drop, and members the bot did not let in', () => {
  it('removes a member whose wallet fell below tier 1, keeps and marks one at tier 1, never touches a hand-added member', async () => {
    await link(W, A);
    await link(W2, B);
    expect(await approve(A, JOIN_AT)).toBe('stored');
    expect(await approve(B, JOIN_AT)).toBe('stored');
    // HAND_ADDED is in the group (the founder added them by hand) and linked to no wallet: no row, ever.

    const world = sweepWorld(
      new Map([
        [W, 0],
        [W2, 1],
      ]),
    );
    await world.run();
    expect(world.calls.filter((call) => call.method === 'ban').map((call) => call.userId)).toEqual([A]);
    expect(world.calls.some((call) => call.userId === HAND_ADDED)).toBe(false);
    expect(await memberIds()).toEqual([B]);
    const kept = await db
      .prepare('SELECT checked_day AS day FROM holders_lounge_members WHERE telegram_user_id = ?1')
      .bind(B)
      .first<{ day: string }>();
    expect(kept?.day).toBe('2026-10-20');
    // Logs carry no Telegram id and no wallet.
    const logged = world.lines.join('\n');
    expect(logged).not.toContain(String(A));
    expect(logged).not.toContain(W);
  });

  it('a member whose notes are paused is still linked and kept', async () => {
    await link(W, A, 0);
    expect(await approve(A, JOIN_AT)).toBe('stored');
    const world = sweepWorld(new Map([[W, 2]]));
    await world.run();
    expect(world.calls).toEqual([]);
    expect(await memberIds()).toEqual([A]);
  });

  it('the gate off removes nobody', async () => {
    await link(W, A);
    expect(await approve(A, JOIN_AT)).toBe('stored');
    const world = sweepWorld(new Map([[W, 0]]), { gatingOn: false, token: TOKEN });
    await world.run();
    expect(world.calls).toEqual([]);
    expect(await memberIds()).toEqual([A]);
  });

  it('an unlinked Telegram user is never stored, and a stale read is never approved', async () => {
    expect((await judge(A, 3, JOIN_AT)).decision).toEqual({ action: 'decline', reason: 'not_linked' });
    await link(W, A);
    expect((await judge(A, 0, JOIN_AT)).decision).toEqual({ action: 'decline', reason: 'below_tier' });
    expect((await judge(A, 3, JOIN_AT, '2026-10-19T10:00:00.000Z')).decision).toEqual({ action: 'ignore' });
    expect(await memberIds()).toEqual([]);
  });
});
