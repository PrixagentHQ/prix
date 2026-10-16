import type {
  CreateLoungeSweepJob,
  LoungeDueMember,
  LoungeSweepVerdict,
  RoomAuthorHolder,
  SocialJobName,
  SocialJobOutcome,
} from '@prix/contracts';
import {
  LOUNGE_SWEEP_CHECKS_PER_RUN,
  LOUNGE_SWEEP_REMOVALS_PER_RUN,
  loungeDirectMessage,
  loungeSweepHour,
  loungeSweepMarks,
  loungeSweepVerdict,
} from '@prix/contracts';
import { guardSocialJob, logSafe, utcDayOf } from './common.ts';

const JOB: SocialJobName = 'holders_lounge_sweep';

/**
 * The `holders_lounge_sweep` job (docs/contracts/phase-6-holders-2.md section 4.6): once a day it removes
 * from the Prix Community group a member the bot let in whose linked wallet fell below tier 1, or whose
 * Telegram account is no longer the wallet's linked chat. A member the bot did not let in has no row and is
 * never touched. In the entry's list it stands before `room_picture_sweep`; `room_prune` stays last.
 *
 * A run, in this order:
 * 1. `idle` with nothing read while the lounge's config, its port or `refreshHolders` is null, or before
 *    LOUNGE_SWEEP_FROM_HOUR_UTC; then one read of the gate, and `idle` while it is off.
 * 2. One `listDue(today, LOUNGE_SWEEP_CHECKS_PER_RUN)`; `idle` with none. Then the guard's skip gate, once,
 *    before anything is written.
 * 3. The listed members' wallets read again in one batched read (`refreshHolders`), and each member's
 *    `holder` set to that read's answer for its wallet (null when it gave none): nobody is judged on the row
 *    the list joined. A read that answers null or throws makes the run `idle` with nothing written: nobody is
 *    removed for Prix's own missing read.
 * 4. `loungeSweepVerdict` for each member in order. A removal is at most LOUNGE_SWEEP_REMOVALS_PER_RUN ban
 *    calls a run, whatever they answer; after the last, the members it would have removed stay unchecked.
 *    Ban ok: unban (one that is not ok logs `lounge_unban_failed` and goes on), delete the row, then one
 *    direct message whose failure is logged and ignored. Ban `retry` or `blocked`: no more bans this run,
 *    the member stays unchecked, `lounge_remove_refused`. Ban `rejected`: the row is kept and marked,
 *    `lounge_remove_refused`.
 * 5. One `markChecked(ids, today)` for the members `loungeSweepMarks` keeps and the rejected ones, when
 *    there are any.
 * 6. `more` when it judged LOUNGE_SWEEP_CHECKS_PER_RUN members and marked or removed one, or a member stayed
 *    unchecked for the removal cap; `idle` when it marked and removed nobody; `done` otherwise.
 *
 * At most 12 D1 statements (with the guard's), 15 Telegram calls and one chain read. Its log lines carry a
 * reason or an answer's kind and never a Telegram id, a wallet, a text or the token.
 */
export const createLoungeSweepJob: CreateLoungeSweepJob = (deps) => ({
  name: JOB,
  run: (now) =>
    guardSocialJob(deps, JOB, now, async (skip): Promise<SocialJobOutcome> => {
      const { config, port, refreshHolders } = deps;
      if (config === null || port === null || refreshHolders === null) return 'idle';
      if (!loungeSweepHour(now)) return 'idle';
      const gate = await deps.holdersGate();
      if (!gate.gatingOn || gate.token === null) return 'idle';

      const today = utcDayOf(now);
      const listed = (await deps.lounge.listDue(today, LOUNGE_SWEEP_CHECKS_PER_RUN)).slice(
        0,
        LOUNGE_SWEEP_CHECKS_PER_RUN,
      );
      if (listed.length === 0) return 'idle';
      if (await skip()) return 'idle';

      let read: ReadonlyMap<string, RoomAuthorHolder> | null;
      try {
        read = await refreshHolders(
          listed.map((member) => member.wallet),
          now,
        );
      } catch {
        read = null;
      }
      if (read === null) return 'idle';
      const answers = read;
      const judged: LoungeDueMember[] = listed.map((member) => ({
        ...member,
        holder: answers.get(member.wallet.toLowerCase()) ?? null,
      }));

      const nowIso = now.toISOString();
      const marked: number[] = [];
      let removed = 0;
      let banCalls = 0;
      let bansEnded = false;
      let capped = false;

      for (const member of judged) {
        const verdict: LoungeSweepVerdict = loungeSweepVerdict(member, gate, nowIso);
        if (verdict === 'keep') {
          if (loungeSweepMarks(member, gate, nowIso)) marked.push(member.telegramUserId);
          continue;
        }
        if (bansEnded) continue;
        if (banCalls >= LOUNGE_SWEEP_REMOVALS_PER_RUN) {
          capped = true;
          continue;
        }
        banCalls += 1;
        const userId = member.telegramUserId;
        const ban = await port.ban(config.chatId, userId);
        if (!ban.ok) {
          logSafe(deps, 'lounge_remove_refused', { reason: verdict, answer: ban.reason });
          if (ban.reason === 'rejected') marked.push(userId);
          else bansEnded = true;
          continue;
        }
        const unban = await port.unban(config.chatId, userId);
        if (!unban.ok) logSafe(deps, 'lounge_unban_failed', { answer: unban.reason });
        await deps.lounge.deleteMember(userId);
        removed += 1;
        const text = loungeDirectMessage(verdict, deps.siteOrigin);
        const direct = text === null ? null : await port.sendDirect(userId, text);
        logSafe(deps, 'lounge_member_removed', {
          reason: verdict,
          messaged: direct?.ok === true,
        });
      }

      if (marked.length > 0) await deps.lounge.markChecked(marked, today);

      if (marked.length === 0 && removed === 0) return 'idle';
      if (capped || listed.length >= LOUNGE_SWEEP_CHECKS_PER_RUN) return 'more';
      return 'done';
    }),
});
