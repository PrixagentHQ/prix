import type { RivalryPublic, SocialApiDeps, StoredRivalryView } from '@prix/contracts';
import { rivalryId } from '@prix/contracts';
import { refOf } from './shared.ts';

/** A rivalry as the public sees it. The ranks are those of its latest tape day. */
export function rivalryPublicOf(deps: SocialApiDeps, view: StoredRivalryView): RivalryPublic {
  const { rivalry } = view;
  const last = rivalry.series.at(-1);
  return {
    id: rivalryId(rivalry.seasonId, rivalry.agentA, rivalry.agentB),
    seasonId: rivalry.seasonId,
    division: rivalry.division,
    status: rivalry.status,
    formedDay: rivalry.formedDay,
    endedDay: rivalry.endedDay,
    endReason: rivalry.endReason,
    agentA: refOf(deps, view.agentA),
    agentB: refOf(deps, view.agentB),
    leader: rivalry.leader,
    leadChanges: rivalry.leadChanges,
    lastDay: rivalry.lastDay,
    rankA: last?.[1] ?? null,
    rankB: last?.[2] ?? null,
  };
}
