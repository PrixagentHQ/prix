import {
  type DeliverDeps,
  type DeliverReport,
  formatNotice,
  NOTIFY_MAX_ATTEMPTS,
  NOTIFY_SENDS_PER_RUN,
  type NoticeKey,
  type PushSender,
  type TelegramPort,
} from '@prix/contracts';

/**
 * The deliver step's dependencies: Phase 3's, with Telegram optional (null when the bot is off)
 * and browser push optional. A `DeliverDeps` is a valid value of this type.
 */
export type PushDeliverDeps = Omit<DeliverDeps, 'telegram'> & {
  telegram: TelegramPort | null;
  push?: PushSender | null;
};

/** Subrequests plus D1 statements the step may start before it stops new work. */
const WORK_LIMIT = 40;

const keyOf = (n: NoticeKey): NoticeKey => ({ address: n.address, tickId: n.tickId, agentId: n.agentId });

/**
 * Sends the due notices through every channel that is configured: Telegram, browser push, or both.
 * A note counts as delivered when one channel took it. With no channel it does nothing.
 * docs/contracts/phase-3-follow.md section 4.2. Never throws.
 * A log line holds an event name and counts only.
 *
 * Reading of the contract: a notice whose `chatId` is 0 has no Telegram chat (a push-only wallet).
 */
export const runDeliverStep = async (deps: PushDeliverDeps, _now: Date): Promise<DeliverReport> => {
  const report: DeliverReport = { sent: 0, dropped: 0, retried: 0, blocked: 0 };
  const done: NoticeKey[] = [];
  const retry: NoticeKey[] = [];
  let work = 0;
  try {
    if (deps.telegram === null && (deps.push ?? null) === null) return report;
    work += 1;
    const notices = await deps.store.listDueNotices(NOTIFY_SENDS_PER_RUN);
    if (notices.length === 0) return report;

    const delayed = new Map<string, boolean>();
    let stopped = false;
    for (const notice of notices) {
      if (stopped || work >= WORK_LIMIT) break;

      let isDelayed = delayed.get(notice.address);
      if (isDelayed === undefined) {
        work += 1;
        try {
          const entitlements = await deps.entitlements.entitlementsFor(notice.address, { cachedOnly: true });
          isDelayed = entitlements.feedDelaySeconds > 0;
        } catch {
          deps.log('notify_entitlements_failed');
          retry.push(keyOf(notice));
          report.retried += 1;
          continue;
        }
        delayed.set(notice.address, isDelayed);
      }
      if (isDelayed) {
        done.push(keyOf(notice));
        report.dropped += 1;
        continue;
      }
      if (work >= WORK_LIMIT) break;

      // Telegram, when it is configured and the wallet has a chat. Then browser push, when it is
      // configured and Telegram did not already take the note.
      let telegramReason: 'ok' | 'blocked' | 'retry' | 'rejected' | 'none' = 'none';
      if (deps.telegram !== null && notice.chatId !== 0) {
        work += 1;
        const text = formatNotice({
          agentName: notice.agentName,
          tickId: notice.tickId,
          fills: notice.fills,
          link: `${deps.siteOrigin}/agents/${notice.agentId}`,
        });
        const result = await deps.telegram.sendMessage(notice.chatId, text);
        telegramReason = result.ok ? 'ok' : result.reason;
        if (!result.ok && result.reason === 'retry' && result.retryAfterSeconds !== null) stopped = true;
        if (!result.ok && result.reason === 'blocked') {
          work += 1;
          try {
            await deps.store.deleteChatById(notice.chatId);
          } catch {
            deps.log('notify_chat_delete_failed');
          }
        }
      }
      let pushDelivered = false;
      let pushKept = 0;
      if (deps.push != null && telegramReason !== 'ok' && work < WORK_LIMIT) {
        const pushed = await deps.push.pushTo(notice.address, WORK_LIMIT - work);
        work += pushed.requests;
        pushDelivered = pushed.delivered > 0;
        pushKept = pushed.kept;
      }

      if (telegramReason === 'ok' || pushDelivered) {
        done.push(keyOf(notice));
        report.sent += 1;
      } else if (telegramReason === 'retry' || pushKept > 0) {
        retry.push(keyOf(notice));
        report.retried += 1;
      } else if (telegramReason === 'blocked') {
        done.push(keyOf(notice));
        report.blocked += 1;
      } else {
        if (telegramReason === 'rejected') deps.log('notify_rejected');
        done.push(keyOf(notice));
        report.dropped += 1;
      }
      // Write each send's result before the next send, so a run cut short never repeats a note.
      work += 1;
      await deps.store.finishNotices(done.splice(0), retry.splice(0), NOTIFY_MAX_ATTEMPTS);
    }

    await deps.store.finishNotices(done, retry, NOTIFY_MAX_ATTEMPTS);
    deps.log('notify_delivered', { ...report, work });
  } catch {
    deps.log('notify_deliver_failed');
  }
  return report;
};
