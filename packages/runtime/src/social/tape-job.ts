import type { FinalDay, SeasonMethod, SocialJob, SocialJobDeps, TapeCursor, UtcDay } from '@prix/contracts';
import { SOCIAL_CURSOR, utcDayOfTick } from '@prix/contracts';
import { addDays, dayField, guardSocialJob, logSafe, parseBody, utcDayOf } from './common.ts';
import { nextFinalDay } from './final-days.ts';

/**
 * The `rank_tape` job (docs/contracts/phase-6-social.md section 5.4). For each final day D, oldest
 * first and one per run, it tapes the official ranks of both divisions, built in SQL from
 * `portfolios.rank`, while those ranks are still the ones of D: in a v1 season no tick of a later day
 * exists; in a v2 season every division with a visible agent has `league_state.scoredDay` D, and a
 * division without one is recorded empty and holds nothing back. When a later day has already
 * moved them, D is recorded in the cursor as missed and never invented.
 *
 * `TapeCursor.tapedDay` is the last final day the tape has dealt with, taped or missed, so a missed
 * day is not looked at again; `missed` keeps the last ten of those that were not taped.
 */

/** Missed days kept in the cursor. */
const MISSED_KEPT = 10;
/** A v2 day still unscored this many days after it will not be scored any more: it is recorded as missed. */
const V2_SCORE_WAIT_DAYS = 2;

type Verdict = 'tape' | 'missed' | 'wait';

function readCursor(body: string | null): TapeCursor {
  const raw = parseBody(body);
  const missed = Array.isArray(raw.missed) ? raw.missed.map(dayField).filter((day): day is UtcDay => day !== null) : [];
  return { tapedDay: dayField(raw.tapedDay), missed: missed.slice(-MISSED_KEPT) };
}

export function createRankTapeJob(deps: SocialJobDeps): SocialJob {
  const name = 'rank_tape';
  const { store, social, reputation } = deps;

  async function verdict(final: FinalDay, method: SeasonMethod, now: Date): Promise<Verdict> {
    if (method === 'v1') {
      const latest = await store.getLatestTick();
      return latest !== null && utcDayOfTick(latest.id) > final.day ? 'missed' : 'tape';
    }
    let pending = false;
    for (const division of ['open', 'pro'] as const) {
      const state = await store.getLeagueState(final.seasonId, division);
      // A division without a visible agent has nothing to tape and holds nothing back: its tape row is
      // recorded empty. The scheduler writes a league state for a division without agents too, with
      // scoredDay null, so the state alone does not say that the division will ever be scored.
      if (state === null || state.agentCount === 0) continue;
      const scored = state.scoredDay ?? null;
      if (scored !== null && scored > final.day) return 'missed';
      // A division with agents that is not scored on D yet holds D back: the season_score job scores Open,
      // then Pro, so Open scored on D does not mean that Pro's ranks of D are published.
      if (scored !== final.day) pending = true;
    }
    if (!pending) return 'tape';
    return utcDayOf(now) >= addDays(final.day, V2_SCORE_WAIT_DAYS) ? 'missed' : 'wait';
  }

  return {
    name,
    run: (now) =>
      guardSocialJob(deps, name, now, async (skip) => {
        const nowIso = now.toISOString();
        const cursor = readCursor(await reputation.getJobState(SOCIAL_CURSOR.tape));
        const next = await nextFinalDay(social, cursor.tapedDay);
        if (next === null) return 'idle';
        const final = next.day;

        const { method } = await reputation.getSeasonMethod(final.seasonId);
        const decided = await verdict(final, method, now);
        if (decided === 'wait') return 'idle';
        if (await skip()) return 'idle';

        if (decided === 'tape') {
          const body: TapeCursor = { tapedDay: final.day, missed: cursor.missed };
          await social.writeTape(
            final.seasonId,
            final.day,
            method,
            { name: SOCIAL_CURSOR.tape, body: JSON.stringify(body) },
            nowIso,
          );
          logSafe(deps, 'rank_taped', { seasonId: final.seasonId, day: final.day, method });
        } else {
          const body: TapeCursor = { tapedDay: final.day, missed: [...cursor.missed, final.day].slice(-MISSED_KEPT) };
          await social.putCursor({ name: SOCIAL_CURSOR.tape, body: JSON.stringify(body) }, nowIso);
          logSafe(deps, 'rank_tape_missed', { seasonId: final.seasonId, day: final.day, method });
        }
        return next.more ? 'more' : 'done';
      }),
  };
}
