import type { AgentRecord } from '@prix/contracts';
import {
  createManagerValueJob,
  createModelWarJob,
  createRankTapeJob,
  createRivalryMatchJob,
  createStrategyDnaJob,
} from '@prix/runtime/social/index';
import { decisionJson } from '../../support/fakes.ts';
import { testAddress } from '../../support/fixtures.ts';
import { db, jobDeps, resetDb, SEASON_1, type Stores, storesOn, warWorld } from './d1.ts';
import { createSocialHttp, type SocialHttp } from './http.ts';
import { dayAt, League } from './league.ts';
import { createWar, GEMMA, GPT_OSS, LLAMA, WAR_ID } from './war.ts';

/** Strings that must never leave the server, and the one that may leave only through a fork source. */
export const PRIVATE = (n: number): string => `PRIVATE-STRATEGY-${n}-MARKER`;
export const PUBLISHED = 'PUBLISHED-STRATEGY-MARKER';

export interface Rich {
  stores: Stores;
  http: SocialHttp;
  league: League;
  /** Agents 1 to 4 (Open) and 5 (Pro). */
  agents: AgentRecord[];
  managerIds: string[];
  warId: string;
  owners: string[];
}

const ok = (neurons: number) => ({
  ok: true as const,
  text: decisionJson({ NVDA: 20, MSFT: 20 }, 'Holds two large companies in equal parts.'),
  inputTokens: 1500,
  outputTokens: 60,
  neurons,
});

/**
 * A database with something of everything Phase 6 shows: a league of five agents with private prompts and
 * one published prompt, a rivalry in its first week, Strategy DNA, a war two days into its run, two paper
 * managers with a book, and a small family tree. Everything but the managers' creation is made by the
 * real jobs on real rows.
 */
export async function richWorld(): Promise<Rich> {
  await resetDb([{ season: SEASON_1, method: null }]);
  // Manager creation counts per rolling period (D-109) on the real store, which takes `p:` keys.
  const stores = storesOn(db);
  const league = new League(stores, { agents: 4, pros: 1, seed: 17 });
  await league.addAgents();
  for (const [index, agent] of league.agents.entries()) {
    const published = index === 1;
    await db
      .prepare('UPDATE agents SET prompt = ?2, prompt_public = ?3 WHERE id = ?1')
      .bind(
        agent.id,
        published ? `${PUBLISHED} hold two companies` : `${PRIVATE(index + 1)} hold the largest`,
        published ? 1 : 0,
      )
      .run();
  }
  const agents = league.agents;
  const [a, b, f] = [agents[0], agents[1], agents[2]] as [AgentRecord, AgentRecord, AgentRecord];

  await createWar(stores, [LLAMA, GEMMA, GPT_OSS], { startsOn: dayAt(0), deadlineDay: dayAt(40), tradingDays: 10 });
  const models = warWorld({ [LLAMA]: () => ok(20), [GEMMA]: () => ok(6), [GPT_OSS]: () => ok(0) });
  const world = jobDeps(stores, { now: `${dayAt(0)}T21:00:00.000Z`, war: models.deps });
  const jobs = {
    war: createModelWarJob(world.deps),
    tape: createRankTapeJob(world.deps),
    rivalry: createRivalryMatchJob(world.deps),
    dna: createStrategyDnaJob(world.deps),
    managers: createManagerValueJob(world.deps),
  };

  // Two managers made before the first final day, over the first three agents.
  const http = createSocialHttp(stores, { now: `${dayAt(0)}T09:00:00.000Z` });
  const owners = [testAddress(8001), testAddress(8002)];
  const managerIds: string[] = [];
  for (const [k, owner] of owners.entries()) {
    const cookie = await http.signIn(owner);
    const made = await http.fetch('POST', '/api/social/managers', {
      cookie,
      body: {
        name: k === 0 ? 'Calm Basket' : 'Steady Basket',
        schedule: k === 0 ? 'weekly' : 'hold',
        targetsBps: { [a.id]: 3000, [b.id]: 2500, [f.id]: 2000 },
      },
    });
    if (made.status !== 201) throw new Error(`richWorld: manager ${k}: ${made.text}`);
    managerIds.push(made.json.manager.id);
  }

  for (let i = 0; i < 6; i++) {
    await league.playTick(i);
    await league.closeDay(i);
    // The ranks of the rivalry example: a and b trade the first places, f sits at 5.
    const ranks =
      i === 1 || i === 5
        ? { [b.id]: 1, [a.id]: 2, [f.id]: 5 }
        : i >= 6
          ? { [a.id]: 1, [b.id]: 4, [f.id]: 5 }
          : { [a.id]: 1, [b.id]: 2, [f.id]: 5 };
    await db.prepare('UPDATE portfolios SET rank = NULL').run();
    for (const [id, rank] of Object.entries(ranks)) {
      await db.prepare('UPDATE portfolios SET rank = ?1 WHERE agent_id = ?2').bind(rank, id).run();
    }
    const at = new Date(`${dayAt(i)}T21:00:00.000Z`);
    for (const job of [jobs.war, jobs.tape, jobs.rivalry, jobs.managers]) {
      for (let run = 0; run < 4; run++) if ((await job.run(at)) === 'idle') break;
    }
  }
  // DNA is two days behind the latest priced day.
  const later = new Date(`${dayAt(8)}T01:00:00.000Z`);
  for (let run = 0; run < 4; run++) if ((await jobs.dna.run(later)) === 'idle') break;

  // A small family: agent 3 is a fork of agent 1, agent 4 a fork of agent 3.
  await stores.social.putLineage({
    agentId: f.id,
    parentId: a.id,
    rootId: a.id,
    depth: 1,
    createdAt: '2026-10-06T10:00:00.000Z',
  });
  await stores.social.putLineage({
    agentId: (agents[3] as AgentRecord).id,
    parentId: f.id,
    rootId: a.id,
    depth: 2,
    createdAt: '2026-10-06T11:00:00.000Z',
  });

  http.setNow(`${dayAt(6)}T12:00:00.000Z`);
  return { stores, http, league, agents, managerIds, warId: WAR_ID, owners };
}
