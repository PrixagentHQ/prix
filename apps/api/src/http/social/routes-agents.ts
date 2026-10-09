import type {
  AgentRecord,
  AgentSocialResponse,
  FamilyResponse,
  ForkSourceResponse,
  Lineage,
  LineageRef,
  LinkForkResponse,
  RivalryPublic,
  SocialAgentRecord,
  SocialApiDeps,
} from '@prix/contracts';
import {
  agentNameKey,
  DNA_MIN_DAYS,
  DNA_WINDOW_DAYS,
  FORK_LINK_WINDOW_SECONDS,
  FORK_LINK_WRITE_ROWS,
  FORK_NAME_GUARD_MIN_KEY,
  FORKS_PER_PARENT_PER_DAY,
  idSchema,
  LINEAGE_CHILDREN_PREVIEW,
  linkForkInputSchema,
  RIVALRY_MAX_ACTIVE_PER_AGENT,
  SOCIAL_PAGE_SIZE,
  socialPageQuerySchema,
} from '@prix/contracts';
import type { Hono } from 'hono';
import { ApiFailure, failures, json, secondsToUtcMidnight } from '../errors.ts';
import { requireWriter } from '../guard.ts';
import { matches, readInput, readQuery } from '../input.ts';
import { currentSeason } from '../views.ts';
import { rivalryPublicOf } from './rivalry-views.ts';
import { conflict, dayOf, lineageAgentOf, refOf, socialFailures } from './shared.ts';

/** A visible agent, or 404 for an unknown, malformed or hidden id: a hidden agent does not exist for the public. */
async function visibleAgent(deps: SocialApiDeps, id: string | undefined): Promise<AgentRecord> {
  if (!matches(idSchema, id)) throw failures.agentNotFound();
  const agent = await deps.store.getAgent(id);
  if (agent === null || agent.hidden) throw failures.agentNotFound();
  return agent;
}

/**
 * The lineage of one agent: its parent and root (or `{shown: false}` when hidden), the number of
 * its children and the newest visible ones. No figure, no rank and no prompt, by design.
 */
export async function lineageOf(deps: SocialApiDeps, agentId: string): Promise<Lineage> {
  const { social } = deps;
  const [row, childCount, children] = await Promise.all([
    social.getLineage(agentId),
    social.countChildren(agentId),
    social.listChildren(agentId, LINEAGE_CHILDREN_PREVIEW, 0),
  ]);
  let parent: LineageRef | null = null;
  let root: LineageRef | null = null;
  if (row !== null) {
    const records = await social.listAgentRecords(
      row.parentId === row.rootId ? [row.rootId] : [row.parentId, row.rootId],
    );
    const shown = (id: string, depth: number): LineageRef => {
      const record = records.find((entry) => entry.id === id);
      return record === undefined || record.hidden ? { shown: false } : lineageAgentOf(deps, record, depth);
    };
    parent = shown(row.parentId, row.depth - 1);
    root = shown(row.rootId, 0);
  }
  return {
    depth: row?.depth ?? 0,
    parent,
    root,
    childCount,
    children: children
      .filter((member) => !member.agent.hidden)
      .map((member) => lineageAgentOf(deps, member.agent, member.depth)),
  };
}

/** GET /social/agents/:id, its fork source, the fork link and families. docs/contracts/phase-6-social.md section 5.2. */
export function registerAgentRoutes(app: Hono, deps: SocialApiDeps): void {
  const { store, social } = deps;

  app.get('/social/agents/:id', async (c) => {
    const agent = await visibleAgent(deps, c.req.param('id'));
    const season = await currentSeason(store, deps.now().toISOString());
    const [dna, lineage, rivalries] = await Promise.all([
      social.getDna(agent.id),
      lineageOf(deps, agent.id),
      season === null ? Promise.resolve([]) : social.listAgentRivalries(agent.id, season.id),
    ]);
    const active: RivalryPublic[] = rivalries
      .filter((view) => view.rivalry.status === 'active' && !view.agentA.hidden && !view.agentB.hidden)
      .slice(0, RIVALRY_MAX_ACTIVE_PER_AGENT)
      .map((view) => rivalryPublicOf(deps, view));
    return json<AgentSocialResponse>(
      {
        agentId: agent.id,
        dna,
        dnaWindowDays: DNA_WINDOW_DAYS,
        dnaMinDays: DNA_MIN_DAYS,
        lineage,
        rivalries: active,
      },
      200,
      'public',
    );
  });

  app.get('/social/agents/:id/fork-source', async (c) => {
    const agent = await visibleAgent(deps, c.req.param('id'));
    const [dna, row] = await Promise.all([social.getDna(agent.id), social.getLineage(agent.id)]);
    // A hidden root is named by nothing, not even its id: one more read,
    // only for an agent that has a root other than itself.
    let rootId: string | null = row?.rootId ?? agent.id;
    if (row !== null && row.rootId !== agent.id) {
      const root = (await social.listAgentRecords([row.rootId]))[0];
      if (root === undefined || root.hidden) rootId = null;
    }
    return json<ForkSourceResponse>(
      {
        parent: {
          ...refOf(deps, agent),
          division: agent.division,
          createdAt: agent.createdAt,
          summary: agent.summary,
          summaryStatus: agent.summaryStatus,
          // The only prompt a Phase 6 response carries, and only while its owner publishes it.
          prompt: agent.promptPublic ? agent.prompt : null,
        },
        dna,
        rootId,
        forkDepth: (row?.depth ?? 0) + 1,
      },
      200,
      'public',
    );
  });

  app.post('/social/agents/:id/lineage', async (c) => {
    // The rules of section 5.2, in order. The switch is the mount.
    const session = await requireWriter(deps, c.req.raw, FORK_LINK_WRITE_ROWS);
    const input = await readInput(linkForkInputSchema, c.req.raw);
    const childId = c.req.param('id');
    if (!matches(idSchema, childId)) throw failures.agentNotFound();
    const child = await store.getAgent(childId);
    if (child === null || child.hidden || child.owner !== session.address) throw failures.agentNotFound();

    const at = deps.now();
    if (at.getTime() - Date.parse(child.createdAt) > FORK_LINK_WINDOW_SECONDS * 1000) {
      return conflict(
        'A fork can be linked to its parent only in the first ten minutes after it is created.',
        'parentId',
      );
    }

    const parent = await store.getAgent(input.parentId);
    if (parent === null || parent.hidden || parent.id === child.id || !(parent.createdAt < child.createdAt)) {
      throw failures.agentNotFound();
    }

    const parentRow = await social.getLineage(parent.id);
    const rootId = parentRow?.rootId ?? parent.id;
    const depth = (parentRow?.depth ?? 0) + 1;
    const root: Pick<SocialAgentRecord, 'name'> | null =
      rootId === parent.id ? parent : ((await social.listAgentRecords([rootId]))[0] ?? null);
    const guarded = [parent.nameKey, root === null ? '' : agentNameKey(root.name)];
    if (guarded.some((key) => key.length >= FORK_NAME_GUARD_MIN_KEY && child.nameKey.includes(key))) {
      return conflict(
        'A fork’s name must not contain the name of its parent or of the first agent of its family. Rename the fork and link it again.',
        'name',
      );
    }
    if (parent.promptPublic && child.prompt === parent.prompt) {
      return conflict('Change the published strategy before you link the fork: make it yours.', 'prompt');
    }

    const now = at.toISOString();
    const key = `d:${dayOf(now)}:fork:${parent.id}`;
    if (!(await deps.reputation.takeCounter(key, FORKS_PER_PARENT_PER_DAY, dayOf(now), now))) {
      throw new ApiFailure(
        'rate_limited',
        'This agent has been forked as often as Prix allows in one day. Try again after 00:00 UTC.',
        'parentId',
        { 'Retry-After': String(secondsToUtcMidnight(at)) },
      );
    }
    let stored: 'stored' | 'exists';
    try {
      stored = await social.putLineage({ agentId: child.id, parentId: parent.id, rootId, depth, createdAt: now });
    } catch (error) {
      await deps.reputation.giveBackCounter(key);
      throw error;
    }
    if (stored === 'exists') {
      await deps.reputation.giveBackCounter(key);
      return conflict('This agent is already linked to a parent. A link cannot be changed.', 'parentId');
    }
    return json<LinkForkResponse>({ agentId: child.id, lineage: await lineageOf(deps, child.id) }, 201, 'private');
  });

  app.get('/social/families/:rootId', async (c) => {
    const rootId = c.req.param('rootId');
    if (!matches(idSchema, rootId)) throw socialFailures.familyNotFound();
    const { page } = readQuery(socialPageQuerySchema, c.req.url);
    const [records, memberCount, members] = await Promise.all([
      social.listAgentRecords([rootId]),
      social.countFamily(rootId),
      social.listFamily(rootId, SOCIAL_PAGE_SIZE + 1, (page - 1) * SOCIAL_PAGE_SIZE),
    ]);
    const root = records[0];
    // A hidden root is a path that names a hidden agent: the same 404 as an id nobody has
    //.
    if (root === undefined || root.hidden) throw socialFailures.familyNotFound();
    const shown = members.slice(0, SOCIAL_PAGE_SIZE).filter((member) => !member.agent.hidden);
    // A member's parent is named only while it is visible. The root is; a parent on this page is
    // known; any other is read, at most one read for the page.
    const known = new Map<string, boolean>([[root.id, true]]);
    for (const member of members) known.set(member.agent.id, !member.agent.hidden);
    const unknown = [...new Set(shown.map((member) => member.parentId))].filter(
      (id): id is string => id !== null && !known.has(id),
    );
    if (unknown.length > 0) {
      for (const record of await social.listAgentRecords(unknown)) known.set(record.id, !record.hidden);
    }
    return json<FamilyResponse>(
      {
        rootId,
        root: lineageAgentOf(deps, root, 0),
        page,
        hasMore: members.length > SOCIAL_PAGE_SIZE,
        memberCount,
        members: shown.map((member) => ({
          ...lineageAgentOf(deps, member.agent, member.depth),
          parentId: member.parentId !== null && known.get(member.parentId) === true ? member.parentId : null,
        })),
      },
      200,
      'public',
    );
  });
}
