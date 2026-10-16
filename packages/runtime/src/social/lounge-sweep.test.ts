import type {
  Address,
  HoldersGate,
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
  SOCIAL_JOB_SKIP_AFTER_FAILURES,
  socialFailureCursor,
  TOKEN_STALE_GRACE_SECONDS,
} from '@prix/contracts';
import { describe, expect, it } from 'vitest';
import { createLoungeSweepJob } from './lounge-sweep.ts';

/**
 * The `holders_lounge_sweep` job against docs/contracts/phase-6-holders-2.md section 4.6 and the comments of
 * `LoungeSweepJobDeps`, `loungeSweepVerdict` and `loungeSweepMarks`: idle while off, before 02:00 UTC or with
 * the gate off; one `listDue(today, 50)`; the guard's gate after the list; the members' wallets read again
 * before any is judged; at most five ban calls a run whatever they answer; ban, unban, delete and one direct
 * message for a removal; the marks; its outcomes; and no id, wallet or token in a log line.
 *
 * Run it with `pnpm --filter @prix/runtime test`.
 */

const NOW = new Date('2026-10-16T03:10:00.000Z');
const TODAY = '2026-10-16';
const TOKEN = `0x${'7'.repeat(40)}` as Address;
const OTHER_TOKEN = `0x${'9'.repeat(40)}` as Address;
const CHAT = -1001234567890;
const SITE = 'https://prixagent.com';
const FAILURES = socialFailureCursor('holders_lounge_sweep');

const OK: TelegramSend = { ok: true };
const RETRY: TelegramSend = { ok: false, reason: 'retry', retryAfterSeconds: 3 };
const BLOCKED: TelegramSend = { ok: false, reason: 'blocked', retryAfterSeconds: null };
const REJECTED: TelegramSend = { ok: false, reason: 'rejected', retryAfterSeconds: null };

/** A fake that holds the given methods only: any other use throws, so the test sees it as a failed run. */
function only<T extends object>(label: string, methods: Partial<T>): T {
  return new Proxy(methods as T, {
    get(target, key, receiver) {
      if (!(key in target)) throw new Error(`unexpected use of ${label}.${String(key)}`);
      return Reflect.get(target, key, receiver);
    },
  });
}

const walletOf = (id: number): Address => `0x${id.toString(16).padStart(40, 'a')}` as Address;

/** A fresh read's answer for a wallet: the tier, the gate's token, read at the run's time. */
const fresh = (tier: number, token: Address = TOKEN, checkedAt = NOW.toISOString()): RoomAuthorHolder => ({
  tier,
  tokenAddress: token,
  checkedAt,
});

interface MemberSpec {
  id: number;
  /** The wallet's tier as the refresh answers it; null leaves the wallet out of the answer. */
  tier?: number | null;
  /** The refresh's answer in full, in place of `tier`. */
  holder?: RoomAuthorHolder;
  /** The linked chat; the member's own id by default. Null: the wallet has no linked chat. */
  linkedChatId?: number | null;
  /** The stored row the list joined (the old one); never what the sweep judges by. */
  listedHolder?: RoomAuthorHolder | null;
}

interface Options {
  members?: MemberSpec[];
  gate?: HoldersGate;
  config?: LoungeSweepJobDeps['config'];
  noPort?: boolean;
  noRefresh?: boolean;
  refreshFails?: 'null' | 'throw';
  failuresToday?: number;
  ban?: (userId: number, index: number) => TelegramSend;
  unban?: (userId: number) => TelegramSend;
  direct?: (userId: number) => TelegramSend;
  now?: Date;
}

function harness(options: Options = {}) {
  const members = new Map<number, LoungeDueMember & { refreshed: RoomAuthorHolder | null }>();
  for (const spec of options.members ?? []) {
    const refreshed =
      spec.holder !== undefined ? spec.holder : spec.tier === null || spec.tier === undefined ? null : fresh(spec.tier);
    members.set(spec.id, {
      telegramUserId: spec.id,
      wallet: walletOf(spec.id),
      joinedAt: '2026-10-01T10:00:00.000Z',
      checkedDay: '2026-10-15',
      linkedChatId: spec.linkedChatId === undefined ? spec.id : spec.linkedChatId,
      holder: spec.listedHolder === undefined ? fresh(1, TOKEN, '2026-10-14T00:00:00.000Z') : spec.listedHolder,
      refreshed: spec.tier === undefined && spec.holder === undefined ? fresh(1) : refreshed,
    });
  }
  const state = new Map<string, string>();
  if (options.failuresToday !== undefined) {
    state.set(FAILURES, JSON.stringify({ day: TODAY, failures: options.failuresToday }));
  }

  const order: string[] = [];
  const lists: { day: string; limit: number }[] = [];
  const marks: { ids: number[]; day: string }[] = [];
  const deletes: number[] = [];
  const bans: number[] = [];
  const unbans: number[] = [];
  const directs: { chatId: number; text: string }[] = [];
  const refreshes: Address[][] = [];
  const lines: { event: string; data: unknown }[] = [];
  let gateReads = 0;
  let telegramCalls = 0;

  const port = only<TelegramLoungePort>('port', {
    async ban(chatId, userId) {
      telegramCalls += 1;
      order.push('ban');
      expect(chatId).toBe(CHAT);
      bans.push(userId);
      return options.ban?.(userId, bans.length - 1) ?? OK;
    },
    async unban(chatId, userId) {
      telegramCalls += 1;
      order.push('unban');
      expect(chatId).toBe(CHAT);
      unbans.push(userId);
      return options.unban?.(userId) ?? OK;
    },
    async sendDirect(chatId, text) {
      telegramCalls += 1;
      order.push('direct');
      directs.push({ chatId, text });
      return options.direct?.(chatId) ?? OK;
    },
  });

  const deps: LoungeSweepJobDeps = {
    lounge: only<LoungeSweepJobDeps['lounge']>('lounge', {
      async listDue(day, limit) {
        order.push('list');
        lists.push({ day, limit });
        return [...members.values()].slice(0, limit).map(({ refreshed: _refreshed, ...member }) => ({ ...member }));
      },
      async markChecked(ids, day) {
        order.push('mark');
        marks.push({ ids: [...ids], day });
      },
      async deleteMember(id) {
        order.push('delete');
        deletes.push(id);
        return members.delete(id);
      },
    }),
    config: options.config === undefined ? { chatId: CHAT, inviteUrl: 'https://t.me/+AbCdEfGh1234' } : options.config,
    port: options.noPort ? null : port,
    holdersGate: async () => {
      gateReads += 1;
      order.push('gate-config');
      return options.gate ?? { gatingOn: true, token: TOKEN };
    },
    refreshHolders: options.noRefresh
      ? null
      : async (wallets) => {
          order.push('refresh');
          refreshes.push([...wallets]);
          if (options.refreshFails === 'null') return null;
          if (options.refreshFails === 'throw') throw new Error(`chain read failed for ${wallets[0]}`);
          const answer = new Map<Address, RoomAuthorHolder>();
          for (const member of members.values()) {
            if (wallets.includes(member.wallet) && member.refreshed !== null)
              answer.set(member.wallet, member.refreshed);
          }
          return answer;
        },
    siteOrigin: SITE,
    social: only<LoungeSweepJobDeps['social']>('social', {
      async putCursor(cursor) {
        order.push('count');
        state.set(cursor.name, cursor.body);
      },
    }),
    reputation: only<LoungeSweepJobDeps['reputation']>('reputation', {
      async getJobState(name) {
        order.push('skip-gate');
        return state.get(name) ?? null;
      },
    }),
    now: () => options.now ?? NOW,
    log: (event, data) => {
      lines.push({ event, data });
    },
  };
  const run = () => createLoungeSweepJob(deps).run(options.now ?? NOW);
  return {
    deps,
    run,
    order,
    lists,
    marks,
    deletes,
    bans,
    unbans,
    directs,
    refreshes,
    lines,
    left: () => [...members.keys()],
    gateReads: () => gateReads,
    telegramCalls: () => telegramCalls,
  };
}

const range = (from: number, count: number): number[] => Array.from({ length: count }, (_, index) => from + index);

describe('the holders_lounge_sweep job', () => {
  it('is named holders_lounge_sweep', () => {
    expect(createLoungeSweepJob(harness().deps).name).toBe('holders_lounge_sweep');
  });

  it.each([
    ['the lounge is off', { config: null }],
    ['the bot is not configured', { noPort: true }],
    ['the token service has no refreshHolders', { noRefresh: true }],
  ] as const)('is idle and touches nothing while %s', async (_name, extra) => {
    const h = harness({ members: [{ id: 101, tier: 0 }], ...extra });
    expect(await h.run()).toBe('idle');
    expect(h.order).toEqual([]);
  });

  it('is idle and touches nothing before 02:00 UTC, and runs from 02:00 UTC', async () => {
    const early = harness({ members: [{ id: 101, tier: 0 }], now: new Date('2026-10-16T01:59:59.999Z') });
    expect(await early.run()).toBe('idle');
    expect(early.order).toEqual([]);

    const at2 = harness({ members: [{ id: 101, tier: 0 }], now: new Date('2026-10-16T02:00:00.000Z') });
    expect(await at2.run()).toBe('done');
  });

  it('is idle with the gate off after one read of it, and removes nobody', async () => {
    for (const gate of [
      { gatingOn: false, token: TOKEN },
      { gatingOn: true, token: null },
    ]) {
      const h = harness({ members: [{ id: 101, tier: 0 }], gate });
      expect(await h.run()).toBe('idle');
      expect(h.order).toEqual(['gate-config']);
      expect(h.bans).toEqual([]);
    }
  });

  it('lists once, for today and LOUNGE_SWEEP_CHECKS_PER_RUN, and is idle with no member', async () => {
    const h = harness();
    expect(await h.run()).toBe('idle');
    expect(h.lists).toEqual([{ day: TODAY, limit: LOUNGE_SWEEP_CHECKS_PER_RUN }]);
    expect(h.order).toEqual(['gate-config', 'list']);
  });

  it('asks the guard once, after the list and before the read again, and stops there once it failed too often', async () => {
    const h = harness({ members: [{ id: 101, tier: 0 }], failuresToday: SOCIAL_JOB_SKIP_AFTER_FAILURES });
    expect(await h.run()).toBe('idle');
    expect(h.order).toEqual(['gate-config', 'list', 'skip-gate']);
    expect(h.bans).toEqual([]);
  });

  it('reads every listed wallet again in one call before it judges anyone', async () => {
    const h = harness({ members: [{ id: 101 }, { id: 102, tier: 0 }, { id: 103 }] });
    await h.run();
    expect(h.refreshes).toEqual([[walletOf(101), walletOf(102), walletOf(103)]]);
    expect(h.order.slice(0, 4)).toEqual(['gate-config', 'list', 'skip-gate', 'refresh']);
  });

  it.each(['null', 'throw'] as const)(
    'is idle and writes nothing when the read again fails (%s)',
    async (refreshFails) => {
      const h = harness({
        members: [
          { id: 101, tier: 0 },
          { id: 102, tier: 1 },
          { id: 103, tier: 1, linkedChatId: null },
        ],
        refreshFails,
      });
      expect(await h.run()).toBe('idle');
      expect(h.bans).toEqual([]);
      expect(h.marks).toEqual([]);
      expect(h.deletes).toEqual([]);
    },
  );

  it('keeps and marks a member at tier 1, with no call to Telegram', async () => {
    const h = harness({
      members: [
        { id: 101, tier: 1 },
        { id: 102, tier: 3 },
      ],
    });
    expect(await h.run()).toBe('done');
    expect(h.marks).toEqual([{ ids: [101, 102], day: TODAY }]);
    expect(h.telegramCalls()).toBe(0);
  });

  it('removes a member whose wallet fell below tier 1: ban, unban, delete, then one direct message', async () => {
    const h = harness({ members: [{ id: 101, tier: 0 }] });
    expect(await h.run()).toBe('done');
    expect(h.order.slice(-4)).toEqual(['ban', 'unban', 'delete', 'direct']);
    expect(h.bans).toEqual([101]);
    expect(h.unbans).toEqual([101]);
    expect(h.deletes).toEqual([101]);
    expect(h.directs).toEqual([{ chatId: 101, text: LOUNGE_DIRECT_MESSAGES.remove_below_tier }]);
    expect(h.marks).toEqual([]);
    expect(h.left()).toEqual([]);
  });

  it.each([
    ['no linked chat', null],
    ['a chat of another account', 999],
  ])('removes a member whose wallet has %s as remove_unlinked', async (_name, linkedChatId) => {
    const h = harness({ members: [{ id: 101, tier: 3, linkedChatId }] });
    expect(await h.run()).toBe('done');
    expect(h.deletes).toEqual([101]);
    expect(h.directs).toEqual([
      { chatId: 101, text: LOUNGE_DIRECT_MESSAGES.remove_unlinked.replace('{following}', `${SITE}/following`) },
    ]);
  });

  it('judges on the read again, never on the row the list joined', async () => {
    const h = harness({
      members: [
        { id: 101, tier: 0, listedHolder: fresh(3, TOKEN, '2026-10-16T03:00:00.000Z') },
        { id: 102, tier: 1, listedHolder: fresh(0, TOKEN, '2026-10-16T03:00:00.000Z') },
        { id: 103, tier: 0, listedHolder: null },
      ],
    });
    await h.run();
    expect(h.deletes).toEqual([101, 103]);
    expect(h.marks).toEqual([{ ids: [102], day: TODAY }]);
  });

  it('keeps a member the read again did not answer, or answered for another token or stale, unmarked', async () => {
    const stale = new Date(NOW.getTime() - TOKEN_STALE_GRACE_SECONDS * 1000).toISOString();
    const h = harness({
      members: [
        { id: 101, tier: null },
        { id: 102, holder: fresh(0, OTHER_TOKEN) },
        { id: 103, holder: fresh(0, TOKEN, stale) },
      ],
    });
    expect(await h.run()).toBe('idle');
    expect(h.bans).toEqual([]);
    expect(h.marks).toEqual([]);
    expect(h.deletes).toEqual([]);
  });

  it('makes at most five ban calls a run; the members it would have removed after them stay unchecked', async () => {
    const h = harness({ members: [...range(101, 8).map((id) => ({ id, tier: 0 })), { id: 200, tier: 1 }] });
    expect(await h.run()).toBe('more');
    expect(h.bans).toEqual(range(101, LOUNGE_SWEEP_REMOVALS_PER_RUN));
    expect(h.deletes).toEqual(range(101, 5));
    expect(h.marks).toEqual([{ ids: [200], day: TODAY }]);
    expect(h.left().sort()).toEqual([106, 107, 108, 200]);
    expect(h.telegramCalls()).toBeLessThanOrEqual(LOUNGE_SWEEP_TELEGRAM_CALLS_MAX);
  });

  it('counts a rejected ban as one of the five, keeps and marks its row, and logs lounge_remove_refused', async () => {
    const h = harness({ members: range(101, 7).map((id) => ({ id, tier: 0 })), ban: () => REJECTED });
    expect(await h.run()).toBe('more');
    expect(h.bans).toEqual(range(101, 5));
    expect(h.unbans).toEqual([]);
    expect(h.deletes).toEqual([]);
    expect(h.directs).toEqual([]);
    expect(h.marks).toEqual([{ ids: range(101, 5), day: TODAY }]);
    expect(h.lines.filter((line) => line.event === 'lounge_remove_refused')).toHaveLength(5);
    expect(h.telegramCalls()).toBeLessThanOrEqual(LOUNGE_SWEEP_TELEGRAM_CALLS_MAX);
  });

  it.each([
    ['retry', RETRY],
    ['blocked', BLOCKED],
  ] as const)('ends the run’s bans at a ban that answers %s, leaving the member unchecked', async (_name, answer) => {
    const h = harness({
      members: [
        { id: 101, tier: 0 },
        { id: 102, tier: 0 },
        { id: 103, tier: 0 },
        { id: 104, tier: 1 },
      ],
      ban: (_userId, index) => (index === 1 ? answer : OK),
    });
    expect(await h.run()).toBe('done');
    expect(h.bans).toEqual([101, 102]);
    expect(h.deletes).toEqual([101]);
    expect(h.marks).toEqual([{ ids: [104], day: TODAY }]);
    expect(h.left().sort()).toEqual([102, 103, 104]);
    expect(h.lines.map((line) => line.event)).toContain('lounge_remove_refused');
  });

  it('still deletes the row when the unban does not answer ok, and logs lounge_unban_failed', async () => {
    const h = harness({ members: [{ id: 101, tier: 0 }], unban: () => RETRY });
    expect(await h.run()).toBe('done');
    expect(h.deletes).toEqual([101]);
    expect(h.directs).toHaveLength(1);
    expect(h.lines.map((line) => line.event)).toContain('lounge_unban_failed');
  });

  it('ignores a direct message that fails, after logging it', async () => {
    const h = harness({
      members: [
        { id: 101, tier: 0 },
        { id: 102, tier: 0 },
      ],
      direct: () => BLOCKED,
    });
    expect(await h.run()).toBe('done');
    expect(h.deletes).toEqual([101, 102]);
    expect(h.lines.filter((line) => line.event === 'lounge_member_removed')).toHaveLength(2);
  });

  it('answers more when it judged LOUNGE_SWEEP_CHECKS_PER_RUN members and marked one, and lists no more than that', async () => {
    const h = harness({ members: range(1, LOUNGE_SWEEP_CHECKS_PER_RUN + 10).map((id) => ({ id, tier: 1 })) });
    expect(await h.run()).toBe('more');
    expect(h.refreshes[0]).toHaveLength(LOUNGE_SWEEP_CHECKS_PER_RUN);
    expect(h.marks[0]?.ids).toHaveLength(LOUNGE_SWEEP_CHECKS_PER_RUN);
  });

  it('answers idle when it judged fifty and marked and removed nobody', async () => {
    const h = harness({ members: range(1, LOUNGE_SWEEP_CHECKS_PER_RUN).map((id) => ({ id, tier: null })) });
    expect(await h.run()).toBe('idle');
    expect(h.marks).toEqual([]);
  });

  it('makes no more than LOUNGE_SWEEP_TELEGRAM_CALLS_MAX Telegram calls whatever Telegram answers', async () => {
    const answers = [OK, REJECTED, OK, RETRY];
    for (const ban of answers) {
      for (const unban of answers) {
        const h = harness({
          members: range(101, 12).map((id) => ({ id, tier: 0 })),
          ban: () => ban,
          unban: () => unban,
          direct: () => RETRY,
        });
        await h.run();
        expect(h.telegramCalls()).toBeLessThanOrEqual(LOUNGE_SWEEP_TELEGRAM_CALLS_MAX);
        expect(h.bans.length).toBeLessThanOrEqual(LOUNGE_SWEEP_REMOVALS_PER_RUN);
      }
    }
  });

  it('reads the gate once and asks Telegram neither to approve nor to decline', async () => {
    const h = harness({
      members: [
        { id: 101, tier: 0 },
        { id: 102, tier: 1 },
      ],
    });
    await h.run();
    expect(h.gateReads()).toBe(1);
  });

  it('puts no Telegram id, wallet or token in a log line', async () => {
    const h = harness({
      members: [
        { id: 7_654_321, tier: 0 },
        { id: 7_654_322, tier: 0, linkedChatId: null },
        { id: 7_654_323, tier: 0 },
      ],
      ban: (_userId, index) => (index === 2 ? REJECTED : OK),
      unban: () => RETRY,
      direct: () => BLOCKED,
    });
    await h.run();
    const text = JSON.stringify(h.lines);
    expect(h.lines.length).toBeGreaterThan(0);
    expect(text).not.toContain('765432');
    expect(text.toLowerCase()).not.toContain(walletOf(7_654_321).slice(2));
    expect(text.toLowerCase()).not.toContain(TOKEN.slice(2));
  });

  it('answers failed and counts the failure when the store throws, after logging only the error’s name', async () => {
    const h = harness({ members: [{ id: 101, tier: 0 }] });
    h.deps.lounge.deleteMember = async () => {
      throw new Error(`D1 failed for ${walletOf(101)}`);
    };
    expect(await h.run()).toBe('failed');
    expect(JSON.stringify(h.lines).toLowerCase()).not.toContain(walletOf(101).slice(2));
    expect(h.order).toContain('count');
  });
});
