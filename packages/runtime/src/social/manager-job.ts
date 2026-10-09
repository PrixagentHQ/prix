import type {
  AgentId,
  ManagerCursor,
  ManagerDayWrite,
  ManagerWork,
  SocialJob,
  SocialJobDeps,
  UtcDay,
} from '@prix/contracts';
import { MANAGER_CHUNK, SOCIAL_CURSOR, STARTING_CASH_MICRO } from '@prix/contracts';
import { dayField, guardSocialJob, idField, logSafe, parseBody } from './common.ts';
import { nextFinalDay } from './final-days.ts';

/**
 * The `manager_value` job (docs/contracts/phase-6-social.md section 5.5). For the next final day after
 * the cursor, it values the active, visible paper managers in chunks of MANAGER_CHUNK by id: one read of
 * the managers with their book and the policy in force, one read of the agents' daily points in SQL,
 * the pure engine, and one batch that writes the books, the rebalances and the cursor. A book is written
 * only while its last day is still the one read, so a retry never values a manager twice.
 *
 * Idle at two reads: the cursor, and the final days after it.
 */

function readCursor(body: string | null): ManagerCursor {
  const raw = parseBody(body);
  const work = typeof raw.work === 'object' && raw.work !== null ? (raw.work as Record<string, unknown>) : null;
  const day = dayField(work?.day);
  const seasonId = idField(work?.seasonId);
  return {
    valuedDay: dayField(raw.valuedDay),
    work: day !== null && seasonId !== null ? { day, seasonId, afterId: idField(work?.afterId) } : null,
  };
}

/** The most agent ids one `agentValuesOn` read takes (SocialStore). */
const AGENT_VALUES_MAX_IDS = 100;

/** The agents a manager holds or targets: the ones whose value of the day it needs. */
function agentsOf(work: ManagerWork): AgentId[] {
  return [...new Set([...Object.keys(work.book?.holdings ?? {}), ...Object.keys(work.policy.targetsBps)])];
}

function isDue(work: ManagerWork, day: UtcDay): boolean {
  return work.lastDay === null || work.lastDay < day;
}

/**
 * The managers of the chunk, in id order, up to the first whose agents would take the distinct agents of
 * the chunk past AGENT_VALUES_MAX_IDS, and those agents. The first manager
 * is always taken: it holds or targets at most 2 x MANAGER_MAX_AGENTS agents.
 */
function takeWithinAgents(listed: readonly ManagerWork[], day: UtcDay): { works: ManagerWork[]; ids: AgentId[] } {
  const works: ManagerWork[] = [];
  const ids = new Set<AgentId>();
  for (const work of listed) {
    const own = isDue(work, day) ? agentsOf(work) : [];
    const added = own.filter((id) => !ids.has(id)).length;
    if (works.length > 0 && ids.size + added > AGENT_VALUES_MAX_IDS) break;
    for (const id of own) ids.add(id);
    works.push(work);
  }
  return { works, ids: [...ids] };
}

export function createManagerValueJob(deps: SocialJobDeps): SocialJob {
  const name = 'manager_value';
  const { social, reputation, manager, scoringV2 } = deps;

  function volatility(daily: readonly { day: string; equityMicro: number }[]): number {
    return scoringV2.breakdownOf(scoringV2.momentsOf(scoringV2.dailyReturnsBps(STARTING_CASH_MICRO, daily)))
      .volMilliBps;
  }

  return {
    name,
    run: (now) =>
      guardSocialJob(deps, name, now, async (skip) => {
        const nowIso = now.toISOString();
        const cursor = readCursor(await reputation.getJobState(SOCIAL_CURSOR.managers));

        let day: UtcDay;
        let seasonId: string;
        let afterId: string | null;
        if (cursor.work !== null) {
          ({ day, seasonId, afterId } = cursor.work);
        } else {
          const next = await nextFinalDay(social, cursor.valuedDay);
          if (next === null) return 'idle';
          day = next.day.day;
          seasonId = next.day.seasonId;
          afterId = null;
        }

        if (await skip()) return 'idle';
        const listed = (await social.listManagersToValue(seasonId, day, afterId, MANAGER_CHUNK)).slice(
          0,
          MANAGER_CHUNK,
        );
        const { works, ids } = takeWithinAgents(listed, day);
        // A manager already valued for this day is left alone: its book is not written twice.
        const due = works.filter((work) => isDue(work, day));
        const values = ids.length > 0 ? await social.agentValuesOn(seasonId, day, ids) : {};

        const writes: ManagerDayWrite[] = [];
        for (const work of due) {
          try {
            const own: Record<AgentId, number | null> = {};
            for (const id of agentsOf(work)) own[id] = values[id] ?? null;
            const result = manager.day({ book: work.book, stats: work.stats, day, values: own, policy: work.policy });
            writes.push({
              managerId: work.manager.id,
              prevDay: work.lastDay,
              result,
              volMilliBps: volatility(result.stats.daily),
            });
          } catch {
            // The engine never throws; if it does, this manager is not valued today and the rest are.
            logSafe(deps, 'manager_failed', { managerId: work.manager.id, day });
          }
        }

        // The chunk is the last one of the day only when the list was short and every manager in it was taken.
        const done = listed.length < MANAGER_CHUNK && works.length === listed.length;
        const lastId = works.at(-1)?.manager.id ?? afterId;
        const next: ManagerCursor = done
          ? { valuedDay: day, work: null }
          : { valuedDay: cursor.valuedDay, work: { day, seasonId, afterId: lastId } };
        await social.applyManagerDays(
          seasonId,
          day,
          writes,
          { name: SOCIAL_CURSOR.managers, body: JSON.stringify(next) },
          nowIso,
        );
        logSafe(deps, 'managers_valued', { seasonId, day, managers: writes.length, done });
        return done ? 'done' : 'more';
      }),
  };
}
