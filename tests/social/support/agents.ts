import type { AgentRecord } from '@prix/contracts';
import { makeAgent, SEASON_1, startingPortfolio, startingStats } from '../../support/fixtures.ts';
import { db, type Stores } from './d1.ts';

export interface AddAgent {
  name?: string;
  owner?: string;
  createdAt?: string;
  prompt?: string;
  promptPublic?: boolean;
  hidden?: boolean;
  summary?: string | null;
  division?: 'open' | 'pro';
}

/** An agent in the database with its starting portfolio in season one. A wallet holds one: owners differ by default. */
export async function addAgent(stores: Stores, n: number, options: AddAgent = {}): Promise<AgentRecord> {
  const agent = makeAgent({
    n,
    name: options.name,
    owner: options.owner,
    createdAt: options.createdAt,
    prompt: options.prompt,
    division: options.division,
    modelKeyId: options.division === 'pro' ? 'keyaaaaaaaaa' : null,
    overrides: {
      promptPublic: options.promptPublic ?? false,
      hidden: options.hidden ?? false,
      ...(options.summary === undefined ? {} : { summary: options.summary }),
    },
  });
  const result = await stores.store.createAgent(agent, SEASON_1.id, startingPortfolio(), startingStats(), 1000, 1000);
  if (result !== 'created') throw new Error(`addAgent ${n}: ${result}`);
  if (options.hidden) await setHidden(agent.id, true);
  return agent;
}

export async function setHidden(agentId: string, hidden: boolean): Promise<void> {
  await db
    .prepare('UPDATE agents SET hidden = ?2 WHERE id = ?1')
    .bind(agentId, hidden ? 1 : 0)
    .run();
}

export async function setPromptPublic(agentId: string, value: boolean): Promise<void> {
  await db
    .prepare('UPDATE agents SET prompt_public = ?2 WHERE id = ?1')
    .bind(agentId, value ? 1 : 0)
    .run();
}

export async function counterValue(key: string): Promise<number> {
  const row = await db.prepare('SELECT n FROM counters WHERE key = ?1').bind(key).first<{ n: number }>();
  return row?.n ?? 0;
}
