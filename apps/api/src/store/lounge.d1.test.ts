import { env } from 'cloudflare:workers';
import { LOUNGE_FULL_JOINED_DAYS, LOUNGE_FULL_MARKED_DAYS, LOUNGE_SWEEP_CHECKS_PER_RUN } from '@prix/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { createLoungeStore } from './lounge.ts';

/**
 * The lounge's D1 store (docs/contracts/phase-6-holders-2.md sections 4.2 and 4.3) on a local D1 database,
 * inside the Workers runtime, over migration 0019 as it stands.
 * Run: pnpm exec vitest run --config apps/api/vitest.workers.config.ts
 */
const db = (env as unknown as { DB: D1Database }).DB;

const W1 = '0x00000000000000000000000000000000000000a1';
const W2 = '0x00000000000000000000000000000000000000b2';
const W3 = '0x00000000000000000000000000000000000000c3';
const TOKEN = '0xa74ac6e9f2f8493344923c23972d496364241044';
const NOW = '2026-10-16T10:00:00.000Z';
const DAY = '2026-10-16';

interface Asked {
  statements: string[];
  batches: number;
}

/** The database, with every statement and every batch written down. */
function watched(): { db: D1Database; asked: Asked } {
  const asked: Asked = { statements: [], batches: 0 };
  const proxy = new Proxy(db, {
    get(target, name) {
      if (name === 'prepare') {
        return (sql: string) => {
          asked.statements.push(sql);
          return target.prepare(sql);
        };
      }
      if (name === 'batch') {
        return (list: D1PreparedStatement[]) => {
          asked.batches += 1;
          return target.batch(list);
        };
      }
      const value = Reflect.get(target, name) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { db: proxy, asked };
}

async function link(address: string, chatId: number, enabled = 1): Promise<void> {
  await db
    .prepare('INSERT INTO notify_chats (address, chat_id, enabled, linked_at) VALUES (?1, ?2, ?3, ?4)')
    .bind(address, chatId, enabled, NOW)
    .run();
}

async function holder(address: string, tier: number, checkedAt: string, token = TOKEN): Promise<void> {
  await db
    .prepare(
      `INSERT INTO token_holders (address, balance, total_supply, decimals, tier, max_agents, token_address, checked_at, slots_dirty)
       VALUES (?1, '0', '1000000000000000000000000000', 18, ?2, 1, ?3, ?4, 0)`,
    )
    .bind(address, tier, token, checkedAt)
    .run();
}

async function member(userId: number, wallet: string, joinedAt: string, checkedDay: string): Promise<void> {
  await db
    .prepare(
      'INSERT INTO holders_lounge_members (telegram_user_id, wallet, joined_at, checked_day) VALUES (?1, ?2, ?3, ?4)',
    )
    .bind(userId, wallet, joinedAt, checkedDay)
    .run();
}

async function rows(): Promise<{ telegram_user_id: number; wallet: string; joined_at: string; checked_day: string }[]> {
  const result = await db
    .prepare(
      'SELECT telegram_user_id, wallet, joined_at, checked_day FROM holders_lounge_members ORDER BY telegram_user_id',
    )
    .all<{ telegram_user_id: number; wallet: string; joined_at: string; checked_day: string }>();
  return result.results;
}

beforeEach(async () => {
  await db.batch([
    db.prepare('DELETE FROM holders_lounge_members'),
    db.prepare('DELETE FROM notify_chats'),
    db.prepare('DELETE FROM token_holders'),
  ]);
});

describe('migration 0019', () => {
  it('refuses a Telegram user id that is not positive, and a wallet that is not lower case or not 42 long', async () => {
    await expect(member(0, W1, NOW, DAY)).rejects.toThrow();
    await expect(member(-5, W1, NOW, DAY)).rejects.toThrow();
    await expect(member(5, W1.toUpperCase().replace('0X', '0x'), NOW, DAY)).rejects.toThrow();
    await expect(member(5, '0x1234', NOW, DAY)).rejects.toThrow();
    expect(await rows()).toEqual([]);
  });

  it('lets one wallet in for one Telegram account', async () => {
    await member(5, W1, NOW, DAY);
    await expect(member(6, W1, NOW, DAY)).rejects.toThrow(/UNIQUE/);
  });
});

describe('chatWallet', () => {
  it("answers the wallet linked to a private chat, whatever its notes' switch says, and null for none", async () => {
    await link(W1, 101, 1);
    await link(W2, 202, 0);
    const store = createLoungeStore(db);

    expect(await store.chatWallet(101)).toBe(W1);
    expect(await store.chatWallet(202)).toBe(W2);
    expect(await store.chatWallet(303)).toBeNull();
  });

  it('is one statement', async () => {
    const { db: seen, asked } = watched();
    await createLoungeStore(seen).chatWallet(101);
    expect(asked).toEqual({ statements: [expect.any(String)], batches: 0 });
  });
});

describe('members', () => {
  it('answers the row of the user, the row of the wallet and the count `full` takes, in one batch of three', async () => {
    await member(5, W1, NOW, DAY);
    await member(6, W2, NOW, DAY);
    const { db: seen, asked } = watched();

    const read = await createLoungeStore(seen).members(6, W1, NOW);

    expect(read).toEqual({
      byUser: { telegramUserId: 6, wallet: W2, joinedAt: NOW, checkedDay: DAY },
      byWallet: { telegramUserId: 5, wallet: W1, joinedAt: NOW, checkedDay: DAY },
      count: 2,
    });
    expect(asked.batches).toBe(1);
    expect(asked.statements).toHaveLength(3);
  });

  it('answers null for a user and a wallet with no row', async () => {
    expect(await createLoungeStore(db).members(7, W3, NOW)).toEqual({ byUser: null, byWallet: null, count: 0 });
  });

  it('reads the wallet in lower case', async () => {
    await member(5, W1, NOW, DAY);
    const read = await createLoungeStore(db).members(9, W1.toUpperCase().replace('0X', '0x'), NOW);
    expect(read.byWallet?.telegramUserId).toBe(5);
  });

  it('counts a row joined within 90 days or marked within 7 days, and no other', async () => {
    const day = 86_400_000;
    const at = Date.parse(NOW);
    const iso = (ms: number): string => new Date(ms).toISOString();
    // Joined just inside 90 days, never marked since.
    await member(1, W1, iso(at - LOUNGE_FULL_JOINED_DAYS * day), '2026-07-18');
    // Joined long ago, marked just inside 7 days.
    await member(2, W2, '2025-01-01T00:00:00.000Z', iso(at - LOUNGE_FULL_MARKED_DAYS * day).slice(0, 10));
    // Joined long ago and marked eight days ago: a member who left and keeps a row.
    await member(3, W3, '2025-01-01T00:00:00.000Z', iso(at - (LOUNGE_FULL_MARKED_DAYS + 1) * day).slice(0, 10));

    expect((await createLoungeStore(db).members(9, W1, NOW)).count).toBe(2);
  });
});

describe('putMember', () => {
  it('stores a new member with its time and its day', async () => {
    expect(await createLoungeStore(db).putMember(5, W1, NOW)).toBe('stored');
    expect(await rows()).toEqual([{ telegram_user_id: 5, wallet: W1, joined_at: NOW, checked_day: DAY }]);
  });

  it("updates the user's own row: its wallet, its time and its day", async () => {
    await member(5, W1, '2026-10-01T00:00:00.000Z', '2026-10-01');
    expect(await createLoungeStore(db).putMember(5, W2, NOW)).toBe('stored');
    expect(await rows()).toEqual([{ telegram_user_id: 5, wallet: W2, joined_at: NOW, checked_day: DAY }]);
  });

  it("answers wallet_taken when another user's row holds the wallet, and writes nothing", async () => {
    await member(5, W1, '2026-10-01T00:00:00.000Z', '2026-10-01');
    await member(6, W2, '2026-10-01T00:00:00.000Z', '2026-10-01');
    const before = await rows();

    const store = createLoungeStore(db);
    expect(await store.putMember(7, W1, NOW)).toBe('wallet_taken');
    expect(await store.putMember(6, W1, NOW)).toBe('wallet_taken');
    expect(await rows()).toEqual(before);
  });

  it('stores the wallet in lower case', async () => {
    await createLoungeStore(db).putMember(5, W1.toUpperCase().replace('0X', '0x'), NOW);
    expect((await rows())[0]?.wallet).toBe(W1);
  });
});

describe('deleteMember', () => {
  it('deletes the row and answers whether there was one', async () => {
    await member(5, W1, NOW, DAY);
    const store = createLoungeStore(db);
    expect(await store.deleteMember(5)).toBe(true);
    expect(await store.deleteMember(5)).toBe(false);
    expect(await rows()).toEqual([]);
  });
});

describe('listDue', () => {
  it('answers the members not judged on that day, oldest day first then by user, with the two joins', async () => {
    await member(30, W3, NOW, '2026-10-14');
    await member(10, W1, NOW, '2026-10-15');
    await member(20, W2, NOW, '2026-10-14');
    await member(40, '0x00000000000000000000000000000000000000d4', NOW, DAY);
    await link(W1, 10, 0);
    await link(W2, 999);
    await holder(W1, 1, '2026-10-16T09:00:00.000Z');
    await holder(W3, 0, '2026-10-15T09:00:00.000Z', '0x0000000000000000000000000000000000000001');

    const due = await createLoungeStore(db).listDue(DAY, LOUNGE_SWEEP_CHECKS_PER_RUN);

    expect(due).toEqual([
      {
        telegramUserId: 20,
        wallet: W2,
        joinedAt: NOW,
        checkedDay: '2026-10-14',
        linkedChatId: 999,
        holder: null,
      },
      {
        telegramUserId: 30,
        wallet: W3,
        joinedAt: NOW,
        checkedDay: '2026-10-14',
        linkedChatId: null,
        holder: {
          tier: 0,
          tokenAddress: '0x0000000000000000000000000000000000000001',
          checkedAt: '2026-10-15T09:00:00.000Z',
        },
      },
      {
        telegramUserId: 10,
        wallet: W1,
        joinedAt: NOW,
        checkedDay: '2026-10-15',
        linkedChatId: 10,
        holder: { tier: 1, tokenAddress: TOKEN, checkedAt: '2026-10-16T09:00:00.000Z' },
      },
    ]);
  });

  it('answers at most `limit`, in one statement', async () => {
    for (let id = 1; id <= 5; id += 1) {
      await member(id, `0x${id.toString(16).padStart(40, '0')}`, NOW, '2026-10-01');
    }
    const { db: seen, asked } = watched();
    const due = await createLoungeStore(seen).listDue(DAY, 3);
    expect(due.map((m) => m.telegramUserId)).toEqual([1, 2, 3]);
    expect(asked).toEqual({ statements: [expect.any(String)], batches: 0 });
  });

  it('reads through the index of the due rows', async () => {
    const { db: seen, asked } = watched();
    await createLoungeStore(seen).listDue(DAY, 3);
    const plan = await db
      .prepare(`EXPLAIN QUERY PLAN ${asked.statements[0] ?? ''}`)
      .bind(DAY, 3)
      .all<{ detail: string }>();
    const details = plan.results.map((row) => row.detail).join('\n');
    expect(details).toContain('holders_lounge_members_due');
    expect(details).not.toMatch(/SCAN (notify_chats|token_holders)/);
  });
});

describe('markChecked', () => {
  it('sets the day of these members only, in one statement', async () => {
    await member(1, W1, NOW, '2026-10-14');
    await member(2, W2, NOW, '2026-10-14');
    await member(3, W3, NOW, '2026-10-14');
    const { db: seen, asked } = watched();

    await createLoungeStore(seen).markChecked([1, 3], DAY);

    expect((await rows()).map((row) => [row.telegram_user_id, row.checked_day])).toEqual([
      [1, DAY],
      [2, '2026-10-14'],
      [3, DAY],
    ]);
    expect(asked).toEqual({ statements: [expect.any(String)], batches: 0 });
  });

  it('writes nothing for an empty list', async () => {
    const { db: seen, asked } = watched();
    await createLoungeStore(seen).markChecked([], DAY);
    expect(asked).toEqual({ statements: [], batches: 0 });
  });

  it('refuses an id that is not a positive whole number before any statement', async () => {
    const { db: seen, asked } = watched();
    await expect(createLoungeStore(seen).markChecked([1, 1.5], DAY)).rejects.toThrow();
    await expect(createLoungeStore(seen).markChecked([-1], DAY)).rejects.toThrow();
    expect(asked.statements).toEqual([]);
  });
});
