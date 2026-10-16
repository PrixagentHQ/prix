// "Owner holds $PRIX": the quiet mark on an agent's own page, and nowhere else
// (docs/contracts/phase-6-holders.md section 3, part B).
//
// The API decides it: `ownerHolds` is true only when the owner turned the mark on and the owner's
// stored tier is 2 or above. The page shows it exactly as sent and computes nothing about the owner.
// The amount in the note is the tier-2 threshold of GET /api/token, in whole tokens, never a figure
// of the page's own: a threshold may be lowered, and the note must stay true when it is. When that
// read fails there is no true amount to give, so the mark is left out, as it is while the API does
// not send the field.
import { type AgentPublic, OWNER_HOLDS_MIN_TIER, type TokenInfoResponse, wholeTokensAtPpm } from '@prix/contracts';
import { formatCount } from '../../content/format.ts';
import { text } from '../../content/index.ts';

/** The id of the note that describes the mark. One mark on a page, so one id. */
export const OWNER_HOLDS_NOTE_ID = 'owner-holds-note';

export interface OwnerHoldsMark {
  /** The mark's words. */
  label: string;
  /** Its accessible description, also shown beside the owner in "About this agent". */
  note: string;
  noteId: string;
}

export function ownerHoldsMark(
  agent: Pick<AgentPublic, 'ownerHolds'>,
  token: TokenInfoResponse | null,
): OwnerHoldsMark | null {
  if (agent.ownerHolds !== true) return null;
  const rule = token?.tiers.find((tier) => tier.tier === OWNER_HOLDS_MIN_TIER);
  if (!rule || rule.thresholdPpm <= 0) return null;
  const amount = formatCount(wholeTokensAtPpm(rule.thresholdPpm));
  return {
    label: text('agent.ownerHolds', 'Owner holds $PRIX'),
    note: text(
      'agent.ownerHoldsNote',
      "The wallet that owns this agent held at least {amount} $PRIX at Prix's last check.",
      { amount },
    ),
    noteId: OWNER_HOLDS_NOTE_ID,
  };
}
