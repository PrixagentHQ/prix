import type { DnaCursor, DnaProfile, SocialJob, SocialJobDeps, UtcDay } from '@prix/contracts';
import {
  DNA_CHUNK_AGENTS,
  DNA_LAG_DAYS,
  DNA_METHOD,
  DNA_MOMENTUM_LOOKBACK_DAYS,
  DNA_WINDOW_DAYS,
  SOCIAL_CURSOR,
} from '@prix/contracts';
import { addDays, dayField, guardSocialJob, idField, logSafe, parseBody, utcDayOf } from './common.ts';

/**
 * The `strategy_dna` job (docs/contracts/phase-6-social.md section 5.1). A pass computes the profile of
 * every visible agent as of one day, `asOfDay`: the latest priced day at least DNA_LAG_DAYS back, so
 * every row it reads is past the feed delay. A run takes the next DNA_CHUNK_AGENTS agents by id: one
 * read of the day prices, one batch of end-of-day reads, the pure engine, and one batch that upserts
 * the profiles and moves the cursor. No model, no prompt, nothing but stored rows.
 *
 * Idle at two reads: the cursor, and the priced days after its day (none when nothing is new).
 */

/** Priced days the engine gets: the window and the momentum look-back before it. */
const PRICED_DAYS = DNA_WINDOW_DAYS + DNA_MOMENTUM_LOOKBACK_DAYS;
/** Calendar days read back to find PRICED_DAYS trading days, with room for holidays and a failed day. */
const PRICE_LOOKBACK_CALENDAR_DAYS = 110;
/** End-of-day rows per agent: the window and the prior state before it. */
const OBSERVATIONS = DNA_WINDOW_DAYS + 1;

function readCursor(body: string | null): DnaCursor | null {
  const raw = parseBody(body);
  const asOfDay = dayField(raw.asOfDay);
  if (raw.method !== DNA_METHOD || asOfDay === null) return null;
  return { method: DNA_METHOD, asOfDay, afterAgentId: idField(raw.afterAgentId), done: raw.done === true };
}

export function createStrategyDnaJob(deps: SocialJobDeps): SocialJob {
  const name = 'strategy_dna';
  const { social, reputation, dna } = deps;

  return {
    name,
    run: (now) =>
      guardSocialJob(deps, name, now, async (skip) => {
        const nowIso = now.toISOString();
        const lagDay = addDays(utcDayOf(now), -DNA_LAG_DAYS);
        const cursor = readCursor(await reputation.getJobState(SOCIAL_CURSOR.dna));

        // Which day this run computes, and from which agent.
        let asOfDay: UtcDay | null = null;
        let afterAgentId: string | null = null;
        if (cursor !== null && !cursor.done) {
          asOfDay = cursor.asOfDay;
          afterAgentId = cursor.afterAgentId;
        } else if (cursor !== null) {
          const newer = await reputation.listDayPrices(cursor.asOfDay, lagDay);
          const latest = newer.at(-1);
          if (latest === undefined) return 'idle';
          asOfDay = latest.day;
        }

        const target = asOfDay ?? lagDay;
        const prices = (await reputation.listDayPrices(addDays(target, -PRICE_LOOKBACK_CALENDAR_DAYS), target)).filter(
          (priced) => priced.day <= target,
        );
        if (asOfDay === null) {
          // A fresh pass, or a new method: the latest priced day at least DNA_LAG_DAYS back.
          const latest = prices.at(-1);
          if (latest === undefined) return 'idle';
          asOfDay = latest.day;
        }
        const pricedDays = prices.slice(-PRICED_DAYS);
        if (await skip()) return 'idle';

        const agents = await social.listDnaAgents(afterAgentId, DNA_CHUNK_AGENTS);
        const chunk = agents.slice(0, DNA_CHUNK_AGENTS);
        const observations =
          chunk.length > 0
            ? await social.listEndOfDay(
                chunk.map((agent) => agent.id),
                asOfDay,
                OBSERVATIONS,
              )
            : new Map();

        const profiles: DnaProfile[] = [];
        for (const agent of chunk) {
          try {
            profiles.push(
              dna.profile({
                agentId: agent.id,
                asOfDay,
                strategySinceDay: utcDayOf(agent.strategyChangedAt),
                observations: observations.get(agent.id) ?? [],
                pricedDays,
                computedAt: nowIso,
              }),
            );
          } catch {
            // The engine never throws; if it does, the agent keeps its last profile.
            logSafe(deps, 'dna_agent_failed', { agentId: agent.id, asOfDay });
          }
        }

        const done = chunk.length < DNA_CHUNK_AGENTS;
        const next: DnaCursor = {
          method: DNA_METHOD,
          asOfDay,
          afterAgentId: done ? null : (chunk.at(-1)?.id ?? null),
          done,
        };
        await social.putDnaProfiles(profiles, { name: SOCIAL_CURSOR.dna, body: JSON.stringify(next) }, nowIso);
        logSafe(deps, 'dna_chunk', { asOfDay, agents: chunk.length, profiles: profiles.length, done });
        return done ? 'done' : 'more';
      }),
  };
}
