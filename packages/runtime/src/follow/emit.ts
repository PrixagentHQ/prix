import {
  type EmitDeps,
  type EmitReport,
  type EmitState,
  NOTIFY_EMIT_PAIRS_PER_RUN,
  NOTIFY_QUEUE_PER_DAY,
  NOTIFY_STALE_AFTER_SECONDS,
  type NoticeKey,
  type RunEmitStep,
} from '@prix/contracts';

/**
 * Turns the rows of each finished tick into outbox keys, once and in order.
 * docs/contracts/phase-3-follow.md section 4.1. Never throws.
 */
export const runEmitStep: RunEmitStep = async (deps: EmitDeps, now: Date): Promise<EmitReport> => {
  const { store, log } = deps;
  try {
    const nowIso = now.toISOString();
    const today = nowIso.slice(0, 10);
    const state = await store.getEmitState();

    if (state.doneTickId === null && state.workTickId === null) {
      const latest = await store.latestCompleteTickId();
      if (latest === null) return { action: 'idle', tickId: null, queued: 0 };
      await store.commitEmit({ ...state, doneTickId: latest }, [], nowIso);
      log('notify_emit_initialised');
      return { action: 'initialised', tickId: latest, queued: 0 };
    }

    const tickId =
      state.workTickId ?? (state.doneTickId === null ? null : await store.nextCompleteTickAfter(state.doneTickId));
    if (tickId === null) {
      if (now.getUTCMinutes() === 2) {
        await store.sweep(nowIso, new Date(now.getTime() - NOTIFY_STALE_AFTER_SECONDS * 1000).toISOString(), 200);
      }
      return { action: 'idle', tickId: null, queued: 0 };
    }

    const queuedToday = state.queueDay === today ? state.queuedToday : 0;
    if (queuedToday >= NOTIFY_QUEUE_PER_DAY) {
      await store.commitEmit(
        { doneTickId: tickId, workTickId: null, afterAgentId: '', afterAddress: '', queueDay: today, queuedToday },
        [],
        nowIso,
      );
      log('notify_budget_reached', { queuedToday });
      return { action: 'budget_reached', tickId, queued: 0 };
    }

    const limit = Math.min(NOTIFY_EMIT_PAIRS_PER_RUN, NOTIFY_QUEUE_PER_DAY - queuedToday);
    const after =
      state.workTickId === null
        ? { agentId: '', address: '' }
        : { agentId: state.afterAgentId, address: state.afterAddress };
    const rows = await store.listEmitCandidates(tickId, after, limit);
    const tickDone = rows.length < limit;
    const last = rows[rows.length - 1];
    const next: EmitState = {
      doneTickId: tickDone ? tickId : state.doneTickId,
      workTickId: tickDone ? null : tickId,
      afterAgentId: tickDone || last === undefined ? '' : last.agentId,
      afterAddress: tickDone || last === undefined ? '' : last.address,
      queueDay: today,
      queuedToday: queuedToday + rows.length,
    };
    const keys: NoticeKey[] = rows.map((row) => ({ address: row.address, tickId, agentId: row.agentId }));
    await store.commitEmit(next, keys, nowIso);
    return { action: tickDone ? 'tick_done' : 'queued', tickId, queued: rows.length };
  } catch {
    log('notify_emit_failed');
    return { action: 'idle', tickId: null, queued: 0 };
  }
};
