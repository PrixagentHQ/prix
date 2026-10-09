import type { AgentSocialResponse, FamilyResponse } from '@prix/contracts';
import type { Context, Read } from './client.ts';
import { fetchAgentSocial, fetchFamily, pageOf } from './client.ts';

/**
 * The reads of a family page, shared by the route file (which sets the status) and the page
 * (which renders it). Both ask; each read is made once per request.
 *
 * The address names an agent. Its family is the one under its first agent: the agent itself
 * when it is not a fork, else the root its lineage names. A hidden root has no id in the
 * lineage, so that family cannot be listed: `family` is then null and the page says why.
 */
export interface FamilyView {
  social: Read<AgentSocialResponse>;
  /** The first agent of the family, when it is known. */
  rootId: string | null;
  family: Read<FamilyResponse> | null;
  page: number;
}

export async function loadFamily(context: Context, agentId: string): Promise<FamilyView> {
  const page = pageOf(context.url);
  const social = await fetchAgentSocial(context, agentId);
  if (!social.ok) return { social, rootId: null, family: null, page };
  const { lineage } = social.data;
  const root = lineage.root !== null && 'id' in lineage.root ? lineage.root : null;
  const rootId = lineage.depth === 0 ? agentId : (root?.id ?? null);
  const family = rootId ? await fetchFamily(context, rootId, page) : null;
  return { social, rootId, family, page };
}

/** The status of the page: the API's 404 and failures are the page's own. */
export function familyStatus(view: FamilyView): number {
  const failed = !view.social.ok ? view.social : view.family && !view.family.ok ? view.family : null;
  if (!failed) return 200;
  return failed.status >= 400 ? failed.status : 500;
}
