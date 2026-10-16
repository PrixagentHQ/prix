import type {
  Address,
  LoungeDueMember,
  LoungeSweepJobDeps,
  RoomAuthorHolder,
  TelegramLoungePort,
  TelegramSend,
} from '@prix/contracts';
import {
  LOUNGE_DIRECT_MESSAGES,
  LOUNGE_SWEEP_CHECKS_PER_RUN,
  LOUNGE_SWEEP_REMOVALS_PER_RUN,
  LOUNGE_SWEEP_TELEGRAM_CALLS_MAX,
} from '@prix/contracts';
import { createLoungeSweepJob } from '@prix/runtime/social/index';
import { describe, expect, it } from 'vitest';

/**
 * Phase 6.8, G (docs/contracts/phase-6-holders-2.md section 4.6, qa case 7): the daily sweep, judged from the
 * contract alone with qa's own fakes. Removes only a row the bot wrote, only on a fresh read of the gate's
 * token, at most five ban calls a run whatever they answer, at most fifteen Telegram calls.
 */

const NOW = new Date('2026-10-20T03:00:00.000Z');
const TODAY = '2026-10-20';
const TOKEN = `0x${'a'.repeat(40)}` as Address;
const OTHER_TOKEN = `0x${'b'.repeat(40)}` as Address;
const CHAT = -1009876543210;
const SITE = 'https://prix.test';

const OK: TelegramSend = { ok: true };
const RETRY: TelegramSend = { ok: false, reason: 'retry', retryAfterSeconds: 2 };
const BLOCKED: TelegramSend = { ok: false, reason: 'blocked', retryAfterSeconds: null };
const REJECTED: TelegramSend = { ok: false, reason: 'rejected', retryAfterSeconds: null };

const wallet = (id: number): Address => `0x${id.toString(16).padStart(40, '0')}` as Address;
const read = (tier: number, token: Address = TOKEN, at = NOW.toISOString()): RoomAuthorHolder => ({
  tier,
  tokenAddress: token,
  checkedAt: at,
});

interface Member {
  id: number;
  /** The refresh's answer for this wallet; null: the refresh gives none. */
  refreshed: RoomAuthorHolder | null;
  linkedChatId?: number | null;
}

function harness(
  rows: Member[],
  options: {
    ban?: (index: number) => TelegramSend;
    unban?: TelegramSend;
    direct?: TelegramSend;
    refresh?: 'null' | 'throw';
    gateOn?: boolean;
    now?: Date;
    lounge?: boolean;
  } = {},
) {
  const table = new Map<number, Member>(rows.map((row) => [row.id, row]));
  const calls: { method: string; userId: number; text?: string }[] = [];
  const marks: number[][] = [];
  const deletes: number[] = [];
  const listed: number[] = [];
  const logs: string[] = [];
  let bans = 0;
  const port: TelegramLoungePort = {
    async approveJoin() {
      throw new Error('the sweep never approves');
    },
    async declineJoin() {
      throw new Error('the sweep never declines');
    },
    async ban(chatId, userId) {
      expect(chatId).toBe(CHAT);
      calls.push({ method: 'ban', userId });
      const answer = options.ban?.(bans) ?? OK;
      bans += 1;
      return answer;
    },
    async unban(chatId, userId) {
      expect(chatId).toBe(CHAT);
      calls.push({ method: 'unban', userId });
      return options.unban ?? OK;
    },
    async sendDirect(chatId, text) {
      calls.push({ method: 'sendDirect', userId: chatId, text });
      return options.direct ?? OK;
    },
  };
  const deps: LoungeSweepJobDeps = {
    lounge: {
      async chatWallet() {
        throw new Error('not the sweep');
      },
      async members() {
        throw new Error('not the sweep');
      },
      async putMember() {
        throw new Error('the sweep never stores a member');
      },
      async deleteMember(userId) {
        deletes.push(userId);
        return table.delete(userId);
      },
      async listDue(day, limit) {
        expect(day).toBe(TODAY);
        const due: LoungeDueMember[] = [...table.values()].slice(0, limit).map((row) => ({
          telegramUserId: row.id,
          wallet: wallet(row.id),
          joinedAt: '2026-10-01T00:00:00.000Z',
          checkedDay: '2026-10-19',
          linkedChatId: row.linkedChatId === undefined ? row.id : row.linkedChatId,
          // The listed row is an old tier 3 row: the sweep must never judge by it.
          holder: read(3, TOKEN, '2026-10-19T00:00:00.000Z'),
        }));
        listed.push(...due.map((member) => member.telegramUserId));
        return due;
      },
      async markChecked(ids, day) {
        expect(day).toBe(TODAY);
        if (ids.length > 0) marks.push([...ids]);
      },
    },
    config: options.lounge === false ? null : { chatId: CHAT, inviteUrl: 'https://t.me/+AbCdEfGh12345678' },
    port,
    async holdersGate() {
      return { gatingOn: options.gateOn ?? true, token: TOKEN };
    },
    async refreshHolders(wallets) {
      if (options.refresh === 'null') return null;
      if (options.refresh === 'throw') throw new Error('chain read failed');
      const answer = new Map<Address, RoomAuthorHolder>();
      for (const row of table.values()) {
        if (wallets.includes(wallet(row.id)) && row.refreshed !== null) answer.set(wallet(row.id), row.refreshed);
      }
      return answer;
    },
    siteOrigin: SITE,
    social: { async putCursor() {} } as unknown as LoungeSweepJobDeps['social'],
    reputation: {
      async getJobState() {
        return null;
      },
    } as unknown as LoungeSweepJobDeps['reputation'],
    now: () => options.now ?? NOW,
    log: (event, data) => {
      logs.push(`${event} ${JSON.stringify(data ?? {})}`);
    },
  };
  return {
    run: () => createLoungeSweepJob(deps).run(options.now ?? NOW),
    calls,
    marks,
    deletes,
    listed,
    logs,
    left: () => [...table.keys()],
    bans: () => calls.filter((call) => call.method === 'ban').length,
  };
}

const range = (from: number, count: number) => Array.from({ length: count }, (_, index) => from + index);

describe('case 7: the sweep removes only what the contract lets it', () => {
  it('a member whose wallet fell to tier 0 is banned, unbanned, deleted and messaged; a tier 1 member is kept and marked', async () => {
    const h = harness([
      { id: 10, refreshed: read(0) },
      { id: 11, refreshed: read(1) },
    ]);
    expect(await h.run()).toBe('done');
    expect(h.calls.map((call) => `${call.method}:${call.userId}`)).toEqual(['ban:10', 'unban:10', 'sendDirect:10']);
    expect(h.calls[2]?.text).toBe(LOUNGE_DIRECT_MESSAGES.remove_below_tier);
    expect(h.deletes).toEqual([10]);
    expect(h.marks).toEqual([[11]]);
    expect(h.left()).toEqual([11]);
  });

  it('judges by the fresh read, never by the old row the list joined', async () => {
    // The listed row says tier 3; the fresh read says 0.
    const h = harness([{ id: 12, refreshed: read(0) }]);
    await h.run();
    expect(h.deletes).toEqual([12]);
  });

  it('a member no longer the linked chat of its wallet is removed as remove_unlinked, with the link in the message', async () => {
    const h = harness([{ id: 13, refreshed: read(3), linkedChatId: 999 }]);
    await h.run();
    expect(h.deletes).toEqual([13]);
    expect(h.calls.at(-1)?.text).toBe(
      LOUNGE_DIRECT_MESSAGES.remove_unlinked.replace('{following}', `${SITE}/following`),
    );
  });

  it('a missing, stale or other-token read keeps the member unmarked, and such a run is idle', async () => {
    const h = harness([
      { id: 20, refreshed: null },
      { id: 21, refreshed: read(0, TOKEN, '2026-10-18T00:00:00.000Z') },
      { id: 22, refreshed: read(0, OTHER_TOKEN) },
    ]);
    expect(await h.run()).toBe('idle');
    expect(h.calls).toEqual([]);
    expect(h.marks).toEqual([]);
    expect(h.deletes).toEqual([]);
  });

  it('the gate off, the lounge off, and any hour before 02:00 UTC remove nobody and read no member', async () => {
    for (const options of [{ gateOn: false }, { lounge: false }, { now: new Date('2026-10-20T01:59:59.000Z') }]) {
      const h = harness([{ id: 30, refreshed: read(0) }], options);
      expect(await h.run()).toBe('idle');
      expect(h.listed).toEqual([]);
      expect(h.calls).toEqual([]);
    }
  });

  it('a refresh that fails or answers null makes the run idle with nothing written', async () => {
    for (const refresh of ['null', 'throw'] as const) {
      const h = harness([{ id: 31, refreshed: read(0) }], { refresh });
      expect(await h.run()).toBe('idle');
      expect(h.calls).toEqual([]);
      expect(h.marks).toEqual([]);
      expect(h.deletes).toEqual([]);
    }
  });
});

describe('case 7: the bounds of a run', () => {
  it('five rejected bans end the run with at most 15 Telegram calls, rejected rows kept and marked', async () => {
    const h = harness(
      range(100, 12).map((id) => ({ id, refreshed: read(0) })),
      { ban: () => REJECTED },
    );
    expect(await h.run()).toBe('more');
    expect(h.bans()).toBe(LOUNGE_SWEEP_REMOVALS_PER_RUN);
    expect(h.calls.length).toBeLessThanOrEqual(LOUNGE_SWEEP_TELEGRAM_CALLS_MAX);
    expect(h.deletes).toEqual([]);
    expect(h.marks).toEqual([range(100, 5)]);
    expect(h.logs.filter((line) => line.startsWith('lounge_remove_refused'))).toHaveLength(5);
  });

  it('removes at most five a run, at most 15 Telegram calls; the rest stay unchecked for the next run', async () => {
    const h = harness(range(200, 12).map((id) => ({ id, refreshed: read(0) })));
    expect(await h.run()).toBe('more');
    expect(h.deletes).toEqual(range(200, 5));
    expect(h.calls.length).toBe(15);
    expect(h.marks).toEqual([]);
    expect(h.left()).toEqual(range(205, 7));
  });

  for (const [label, answer] of [
    ['retry', RETRY],
    ['blocked', BLOCKED],
  ] as const) {
    it(`a ban that answers ${label} ends the run's bans with the member unchecked`, async () => {
      const h = harness(
        [
          { id: 40, refreshed: read(0) },
          { id: 41, refreshed: read(0) },
          { id: 42, refreshed: read(2) },
        ],
        { ban: () => answer },
      );
      await h.run();
      expect(h.bans()).toBe(1);
      expect(h.deletes).toEqual([]);
      expect(h.marks).toEqual([[42]]);
      expect(h.left()).toEqual([40, 41, 42]);
      expect(h.logs.some((line) => line.startsWith('lounge_remove_refused'))).toBe(true);
    });
  }

  it('an unban that fails still deletes the row and logs lounge_unban_failed; a failed message is ignored', async () => {
    const h = harness([{ id: 50, refreshed: read(0) }], { unban: RETRY, direct: BLOCKED });
    expect(await h.run()).toBe('done');
    expect(h.deletes).toEqual([50]);
    expect(h.logs.some((line) => line.startsWith('lounge_unban_failed'))).toBe(true);
  });

  it('reads at most 50 members a run: 60 stale members, each judged on a fresh read, the 61st on the next run', async () => {
    const rows = range(1000, 61).map((id) => ({ id, refreshed: read(1) }));
    const h = harness(rows);
    expect(await h.run()).toBe('more');
    expect(h.listed).toHaveLength(LOUNGE_SWEEP_CHECKS_PER_RUN);
    expect(h.marks[0]).toHaveLength(LOUNGE_SWEEP_CHECKS_PER_RUN);
  });

  it('no log line carries a Telegram id or a wallet', async () => {
    const h = harness(
      [
        { id: 7_777_777, refreshed: read(0) },
        { id: 8_888_888, refreshed: read(0) },
      ],
      { ban: (index) => (index === 0 ? OK : REJECTED), unban: RETRY },
    );
    await h.run();
    const all = h.logs.join('\n');
    for (const id of [7_777_777, 8_888_888]) {
      expect(all).not.toContain(String(id));
      expect(all.toLowerCase()).not.toContain(wallet(id).slice(2));
    }
  });
});
