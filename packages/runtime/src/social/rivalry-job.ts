import type { Division, Rivalry, RivalryCursor, RivalryDayResult, SocialJob, SocialJobDeps } from '@prix/contracts';
import {
  MAX_AGENTS_OPEN,
  RIVALRY_MAX_ACTIVE_PER_AGENT,
  RIVALRY_WINDOW_TAPE_DAYS,
  SOCIAL_CURSOR,
} from '@prix/contracts';
import { dayField, guardSocialJob, logSafe, parseBody } from './common.ts';
import { nextFinalDay } from './final-days.ts';

/**
 * The `rivalry_match` job (docs/contracts/phase-6-social.md section 5.4). One run handles the next
 * final day D that the tape has dealt with: first it ends, with `season_end`, every active rivalry of
 * an earlier season at that season's last tape day; then, per division, it matches D over the last
 * RIVALRY_WINDOW_TAPE_DAYS tape days of the season. A division whose tape has no row for D (a missed
 * day) is left as it is. Everything lands in one batch with the cursor, so a retry repeats the day whole.
 *
 * The engine is pure; this job only reads, calls it and writes what it returns. It reads no score.
 */

/** Every active rivalry a division can hold: at most two per agent, so this covers two seasons in full. */
const ACTIVE_LIMIT = MAX_AGENTS_OPEN * RIVALRY_MAX_ACTIVE_PER_AGENT;
const DIVISIONS: readonly Division[] = ['open', 'pro'];

function merge(into: RivalryDayResult, from: RivalryDayResult): void {
  into.upserts.push(...from.upserts);
  into.events.push(...from.events);
}

export function createRivalryMatchJob(deps: SocialJobDeps): SocialJob {
  const name = 'rivalry_match';
  const { social, reputation, rivalry } = deps;

  return {
    name,
    run: (now) =>
      guardSocialJob(deps, name, now, async (skip) => {
        const nowIso = now.toISOString();
        const matchedDay = dayField(parseBody(await reputation.getJobState(SOCIAL_CURSOR.rivalry)).matchedDay);
        const tapedDay = dayField(parseBody(await reputation.getJobState(SOCIAL_CURSOR.tape)).tapedDay);
        if (tapedDay === null || (matchedDay !== null && matchedDay >= tapedDay)) return 'idle';

        const next = await nextFinalDay(social, matchedDay);
        if (next === null || next.day.day > tapedDay) return 'idle';
        const final = next.day;
        if (await skip()) return 'idle';

        const result: RivalryDayResult = { upserts: [], events: [] };
        for (const division of DIVISIONS) {
          const active = await social.listActiveRivalries(division, ACTIVE_LIMIT);
          const current: Rivalry[] = [];
          const earlier = new Map<string, Rivalry[]>();
          for (const item of active) {
            if (item.seasonId === final.seasonId) current.push(item);
            else earlier.set(item.seasonId, [...(earlier.get(item.seasonId) ?? []), item]);
          }

          // Earlier seasons first: their rivalries end at the ranks of their own last tape day.
          for (const [seasonId, group] of earlier) {
            const lastTape = (await social.listTape(seasonId, division, final.day, 1)).at(-1) ?? null;
            merge(result, rivalry.endSeason({ active: group, lastTape, day: final.day }));
          }

          const tape = await social.listTape(final.seasonId, division, final.day, RIVALRY_WINDOW_TAPE_DAYS);
          if (tape.at(-1)?.day !== final.day) continue;
          merge(result, rivalry.matchDay({ seasonId: final.seasonId, division, tape, active: current }));
        }

        const body: RivalryCursor = { matchedDay: final.day };
        await social.applyRivalryDay(result, { name: SOCIAL_CURSOR.rivalry, body: JSON.stringify(body) }, nowIso);
        logSafe(deps, 'rivalry_day', {
          seasonId: final.seasonId,
          day: final.day,
          upserts: result.upserts.length,
          events: result.events.length,
        });
        return next.more && next.day.day < tapedDay ? 'more' : 'done';
      }),
  };
}
