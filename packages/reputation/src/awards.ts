import type { Award, AwardCandidate, AwardsEngine, Division } from '@prix/contracts';

/**
 * Season awards. They are computed facts about a finished season, never a prize.
 *
 * Ordering rule, quotable on the page:
 * - season_leader: the candidate with rank 1 (if two share it, the lower agent id).
 * - steadiest: among candidates with a season return above zero, the lowest maximum drawdown;
 *   ties go to the higher season return, then to the lower agent id (plain string order).
 *
 * An award with no candidate is left out. The input is not mutated.
 */
function award(kind: Award['kind'], division: Division, c: AwardCandidate): Award {
  return {
    kind,
    division,
    agentId: c.agentId,
    name: c.name,
    seasonReturnBps: c.seasonReturnBps === 0 ? 0 : c.seasonReturnBps,
    maxDrawdownBps: c.maxDrawdownBps === 0 ? 0 : c.maxDrawdownBps,
  };
}

const byId = (a: AwardCandidate, b: AwardCandidate): number =>
  a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0;

export const awards: AwardsEngine = {
  computeAwards(division, candidates) {
    const out: Award[] = [];
    const leaders = candidates.filter((c) => c.rank === 1).sort(byId);
    if (leaders[0]) out.push(award('season_leader', division, leaders[0]));
    const steady = candidates
      .filter((c) => c.seasonReturnBps > 0)
      .sort((a, b) => a.maxDrawdownBps - b.maxDrawdownBps || b.seasonReturnBps - a.seasonReturnBps || byId(a, b));
    if (steady[0]) out.push(award('steadiest', division, steady[0]));
    return out;
  },
};
export const computeAwards = awards.computeAwards;
