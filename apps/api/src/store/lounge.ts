import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import type { Address, IsoTime, LoungeDueMember, LoungeMemberRecord, LoungeStore, UtcDay } from '@prix/contracts';
import { loungeFullCountFrom } from '@prix/contracts';
import { changesOf, wholeNumber } from './room.ts';

/**
 * Phase 6.8, the holders' lounge (docs/contracts/phase-6-holders-2.md sections 4.2 and 4.3):
 * `createLoungeStore(db)` implements `LoungeStore` over infra/migrations/0019_holders_lounge.sql.
 *
 * Every method is one D1 statement or one D1 batch. Addresses are stored and compared in lower case;
 * times are ISO text as `toISOString()` writes them, and days are their first ten characters, so text
 * order is time order.
 *
 * The two reads of `notify_chats` (`chatWallet`, and `listDue`'s join) read the row whatever its
 * `enabled` says: a wallet whose notes are paused is still linked, and only a deleted row unlinks
 * (section 4.3). The feed's joins of apps/api/src/store/follow.ts ask `enabled = 1`; these do not.
 *
 * Its tests: apps/api/src/store/lounge.d1.test.ts, on a local D1
 * (`pnpm exec vitest run --config apps/api/vitest.workers.config.ts`).
 */

type Bound = string | number | null;

interface MemberSql {
  telegram_user_id: number;
  wallet: string;
  joined_at: string;
  checked_day: string;
}

interface DueSql extends MemberSql {
  linked_chat_id: number | null;
  holder_tier: number | null;
  holder_token: string | null;
  holder_checked_at: string | null;
}

function toMember(row: MemberSql): LoungeMemberRecord {
  return {
    telegramUserId: row.telegram_user_id,
    wallet: row.wallet,
    joinedAt: row.joined_at,
    checkedDay: row.checked_day,
  };
}

function toDue(row: DueSql): LoungeDueMember {
  const { holder_tier: tier, holder_token: tokenAddress, holder_checked_at: checkedAt } = row;
  return {
    ...toMember(row),
    linkedChatId: row.linked_chat_id,
    holder: tier === null || tokenAddress === null || checkedAt === null ? null : { tier, tokenAddress, checkedAt },
  };
}

const MEMBER_COLUMNS = 'telegram_user_id, wallet, joined_at, checked_day';

/** The wallet linked to a private chat: a seek of the unique index `notify_chats_chat`. ?1 chat id. */
const CHAT_WALLET = 'SELECT address FROM notify_chats WHERE chat_id = ?1';

const BY_USER = `SELECT ${MEMBER_COLUMNS} FROM holders_lounge_members WHERE telegram_user_id = ?1`;
const BY_WALLET = `SELECT ${MEMBER_COLUMNS} FROM holders_lounge_members WHERE wallet = ?1`;

/**
 * The rows `full` counts (section 4.4 step 6): joined at or after ?1, or marked on or after ?2. At most
 * LOUNGE_MEMBERS_MAX rows and a little more, so the walk of the table is bounded by the lounge's own cap.
 */
const FULL_COUNT = `
SELECT COUNT(*) AS n FROM holders_lounge_members
WHERE joined_at >= ?1 OR checked_day >= ?2`;

/**
 * A member stored: a new row, or this Telegram user's row with its wallet, its time and its day set
 * again. The unique index on `wallet` refuses a wallet another user's row holds, and the statement then
 * writes nothing. ?1 user, ?2 wallet, ?3 now, ?4 its day.
 */
const PUT_MEMBER = `
INSERT INTO holders_lounge_members (telegram_user_id, wallet, joined_at, checked_day) VALUES (?1, ?2, ?3, ?4)
ON CONFLICT (telegram_user_id) DO UPDATE SET
  wallet = excluded.wallet,
  joined_at = excluded.joined_at,
  checked_day = excluded.checked_day`;

const DELETE_MEMBER = 'DELETE FROM holders_lounge_members WHERE telegram_user_id = ?1';

/**
 * The sweep's list (section 4.6 step 2): the members whose day is before ?1, oldest day first and then by
 * user, at most ?2, through the index `holders_lounge_members_due`; each with its wallet's linked chat and
 * its stored token row, both joined by their primary or unique key. ?1 day, ?2 limit.
 */
const LIST_DUE = `
SELECT m.telegram_user_id, m.wallet, m.joined_at, m.checked_day,
  c.chat_id AS linked_chat_id,
  h.tier AS holder_tier, h.token_address AS holder_token, h.checked_at AS holder_checked_at
FROM holders_lounge_members AS m INDEXED BY holders_lounge_members_due
LEFT JOIN notify_chats AS c ON c.address = m.wallet
LEFT JOIN token_holders AS h ON h.address = m.wallet
WHERE m.checked_day < ?1
ORDER BY m.checked_day, m.telegram_user_id
LIMIT ?2`;

/**
 * The day of the members the sweep judged, in one statement. The ids travel as one JSON array, so the
 * statement has two parameters whatever the list's length. ?1 day, ?2 the ids.
 */
const MARK_CHECKED = `
UPDATE holders_lounge_members SET checked_day = ?1
WHERE telegram_user_id IN (SELECT value FROM json_each(?2))`;

/** A Telegram user's id: a positive whole number, or the call fails here before any statement. */
function userId(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('lounge store: a Telegram user id must be positive');
  return value;
}

/** Whether a thrown D1 error is the unique index on the wallet refusing a row. */
function isWalletTaken(error: unknown): boolean {
  const text = error instanceof Error ? `${error.message} ${String(error.cause ?? '')}` : String(error);
  return text.includes('UNIQUE') && text.includes('holders_lounge_members.wallet');
}

export function createLoungeStore(db: D1Database): LoungeStore {
  function prepare(statement: string, ...values: Bound[]): D1PreparedStatement {
    return db.prepare(statement).bind(...values);
  }
  const lower = (address: Address): Address => address.toLowerCase();

  return {
    async chatWallet(chatId) {
      const row = await prepare(CHAT_WALLET, chatId).first<{ address: string }>();
      return row === null ? null : row.address;
    },

    async members(telegramUserId, wallet, now: IsoTime) {
      const { joinedFrom, checkedFrom } = loungeFullCountFrom(now);
      const [byUser, byWallet, count] = await db.batch<MemberSql & { n: number }>([
        prepare(BY_USER, userId(telegramUserId)),
        prepare(BY_WALLET, lower(wallet)),
        prepare(FULL_COUNT, joinedFrom, checkedFrom),
      ]);
      const user = byUser?.results[0];
      const holder = byWallet?.results[0];
      return {
        byUser: user === undefined ? null : toMember(user),
        byWallet: holder === undefined ? null : toMember(holder),
        count: count?.results[0]?.n ?? 0,
      };
    },

    async putMember(telegramUserId, wallet, now) {
      try {
        await prepare(PUT_MEMBER, userId(telegramUserId), lower(wallet), now, now.slice(0, 10)).run();
        return 'stored';
      } catch (error) {
        if (isWalletTaken(error)) return 'wallet_taken';
        throw error;
      }
    },

    async deleteMember(telegramUserId) {
      return changesOf(await prepare(DELETE_MEMBER, userId(telegramUserId)).run()) > 0;
    },

    async listDue(day: UtcDay, limit: number) {
      const result = await prepare(LIST_DUE, day, wholeNumber(limit, 'limit')).all<DueSql>();
      return result.results.map(toDue);
    },

    async markChecked(telegramUserIds, day) {
      const ids = telegramUserIds.map(userId);
      if (ids.length === 0) return;
      await prepare(MARK_CHECKED, day, JSON.stringify(ids)).run();
    },
  };
}
