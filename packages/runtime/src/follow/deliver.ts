import {
  type DeliverDeps,
  type DeliverReport,
  formatNotice,
  type LiveLinkStore,
  liveHeldBack,
  liveRevealAt,
  NOTIFY_MAX_ATTEMPTS,
  NOTIFY_SENDS_PER_RUN,
  NOTIFY_STALE_AFTER_SECONDS,
  type NoticeKey,
  type PushSender,
  type TelegramPort,
} from '@prix/contracts';

/**
 * The deliver step's dependencies: Phase 3's, with Telegram optional (null when the bot is off)
 * and browser push optional. A `DeliverDeps` is a valid value of this type.
 *
 * `liveLinks` is the league's link store (docs/CONTRACTS.md 24.8): the agents linked to a Prix Live
 * wallet. A tick of day D of a linked agent is not sent to a follower before 20:00 UTC of D. Absent
 * or null means Prix Live is not wired into this step, and nothing is held back.
 */
export type PushDeliverDeps = Omit<DeliverDeps, 'telegram'> & {
  telegram: TelegramPort | null;
  push?: PushSender | null;
  liveLinks?: Pick<LiveLinkStore, 'linkedAgentIds'> | null;
};

/** Subrequests plus D1 statements the step may start before it stops new work. */
const WORK_LIMIT = 40;

/** Held notices stay in the outbox and come back every run: at most this many of a run's notices may be held. */
const HELD_PER_RUN = NOTIFY_SENDS_PER_RUN / 2;

const keyOf = (n: NoticeKey): NoticeKey => ({ address: n.address, tickId: n.tickId, agentId: n.agentId });

/**
 * A notice that has to wait for its reveal would be swept as stale first when the reveal is
 * NOTIFY_STALE_AFTER_SECONDS or more after its tick: it can only be dropped, never sent in time.
 */
function staleBeforeReveal(tickId: string): boolean {
  const tick = Date.parse(tickId);
  const reveal = Date.parse(liveRevealAt(tickId));
  return !Number.isFinite(tick) || !Number.isFinite(reveal) || reveal - tick >= NOTIFY_STALE_AFTER_SECONDS * 1000;
}

/**
 * Sends the due notices through every channel that is configured: Telegram, browser push, or both.
 * A note counts as delivered when one channel took it. With no channel it does nothing.
 * docs/contracts/phase-3-follow.md section 4.2. Never throws.
 * A log line holds an event name and counts only.
 *
 * Reading of the contract: a notice whose `chatId` is 0 has no Telegram chat (a push-only wallet).
 *
 * Prix Live's publication delay (docs/CONTRACTS.md 24.8): a notice of a tick of day D of a
 * Live-linked agent is never sent before 20:00 UTC of D (`liveHeldBack`). Until then it is left in
 * the outbox untouched and is sent by the first run at or after the reveal; one that would be swept
 * as stale before its reveal, and any beyond HELD_PER_RUN in one run, is dropped, with a log line.
 * When the links cannot be read, every notice whose reveal is still ahead waits: none is sent early.
 */
export const runDeliverStep = async (deps: PushDeliverDeps, now: Date): Promise<DeliverReport> => {
  const report: DeliverReport = { sent: 0, dropped: 0, retried: 0, blocked: 0 };
  const done: NoticeKey[] = [];
  const retry: NoticeKey[] = [];
  let work = 0;
  try {
    if (deps.telegram === null && (deps.push ?? null) === null) return report;
    work += 1;
    const notices = await deps.store.listDueNotices(NOTIFY_SENDS_PER_RUN);
    if (notices.length === 0) return report;

    // The agents linked to a Live wallet: one read a run, and only when a notice could be held at all.
    let linked: ReadonlySet<string> | 'unknown' | null = null;
    const links = deps.liveLinks ?? null;
    if (links !== null && notices.some((n) => liveHeldBack(n.tickId, now))) {
      work += 1;
      try {
        linked = new Set(await links.linkedAgentIds());
      } catch {
        deps.log('notify_live_links_failed');
        linked = 'unknown';
      }
    }
    let liveHeld = 0;
    let liveDropped = 0;

    const delayed = new Map<string, boolean>();
    let stopped = false;
    for (const notice of notices) {
      if (stopped || work >= WORK_LIMIT) break;

      if (linked !== null && liveHeldBack(notice.tickId, now)) {
        if (linked === 'unknown') {
          liveHeld += 1;
          continue;
        }
        if (linked.has(notice.agentId)) {
          if (staleBeforeReveal(notice.tickId) || liveHeld >= HELD_PER_RUN) {
            done.push(keyOf(notice));
            report.dropped += 1;
            liveDropped += 1;
          } else {
            liveHeld += 1;
          }
          continue;
        }
      }

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
    if (liveHeld > 0 || liveDropped > 0) deps.log('notify_live_held', { held: liveHeld, dropped: liveDropped });
    deps.log('notify_delivered', { ...report, work });
  } catch {
    deps.log('notify_deliver_failed');
  }
  return report;
};
