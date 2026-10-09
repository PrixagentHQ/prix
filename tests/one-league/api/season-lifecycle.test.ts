import type { ReputationJobDeps, Season } from '@prix/contracts';
import { ONE_LEAGUE_ENDS_AT } from '@prix/contracts';
import { createSeasonLifecycleJob } from '@prix/runtime/reputation/season-jobs';
import { describe, expect, it } from 'vitest';
import { stubReputation } from '../../reputation/support.ts';

/**
 * D-109, docs/CONTRACTS.md section 19: season 1 ends at ONE_LEAGUE_ENDS_AT, so the rollover window of
 * `season_lifecycle` never opens and the job creates no next season and copies no agent.
 */
const SEASON_1: Season = {
  id: 'season-1',
  number: 1,
  startsAt: '2026-10-05T00:00:00.000Z',
  endsAt: ONE_LEAGUE_ENDS_AT,
};

function job(active: Season | null) {
  const calls = { putSeason: 0, rollover: 0, listSeasons: 0 };
  const store = {
    getActiveSeason: async () => active,
    listSeasons: async () => {
      calls.listSeasons += 1;
      return active === null ? [] : [active];
    },
  };
  const reputation = stubReputation({
    putSeason: async () => {
      calls.putSeason += 1;
      return true;
    },
    rolloverAgents: async () => {
      calls.rollover += 1;
      return { examined: 0, lastAgentId: null };
    },
    getJobState: async () => null,
    putJobState: async () => {},
  });
  const deps = { store, reputation, sim: {}, scoring: {} } as unknown as ReputationJobDeps;
  return { run: createSeasonLifecycleJob(deps).run, calls };
}

describe('season_lifecycle in one continuous league', () => {
  it('creates no next season and copies no agent, today or years from now', async () => {
    for (const now of ['2026-10-08T12:00:00.000Z', '2030-06-01T00:00:00.000Z', '2099-12-01T00:00:00.000Z']) {
      const j = job(SEASON_1);
      expect(await j.run(new Date(now))).toBe('idle');
      expect(j.calls).toEqual({ putSeason: 0, rollover: 0, listSeasons: 0 });
    }
  });

  it('is idle when there is no active season at all', async () => {
    const j = job(null);
    expect(await j.run(new Date('2026-10-08T12:00:00.000Z'))).toBe('idle');
    expect(j.calls.putSeason).toBe(0);
  });
});
