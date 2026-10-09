import type { AgentOwnerView, HoldsResponse, MeResponse, ModelKeyPublic, ProvidersResponse } from '@prix/contracts';
import { PROVIDERS } from '@prix/contracts';
import {
  KEY_FAILING_AGENT,
  KEY_FAILING_OWNER,
  KEY_FAILING_PROMPT,
  SLOW_COMPOUNDER,
  SLOW_COMPOUNDER_CREATED_AT,
  SLOW_COMPOUNDER_ID,
  SLOW_COMPOUNDER_OWNER,
  SLOW_COMPOUNDER_SUMMARY,
} from './agent.ts';
import { fixtureId, usd } from './league.ts';

/** What a signed-in wallet sees. The wallet is the owner of Slow Compounder. */

export const MODEL_KEY: ModelKeyPublic = {
  id: fixtureId('key openai'),
  provider: 'openai',
  model: 'gpt-4.1-mini',
  last4: 'x7Qd',
  createdAt: '2026-09-27T18:19:03.000Z',
};

export const OWNED_AGENT: AgentOwnerView = {
  id: SLOW_COMPOUNDER_ID,
  name: SLOW_COMPOUNDER.name,
  division: 'open',
  status: 'active',
  pausedReason: null,
  hidden: false,
  prompt:
    'Hold six to eight large, profitable companies. Add slowly to the ones that are working. Keep at least 10% in cash. Trade only when a weight has drifted more than two points from its target.',
  promptPublic: false,
  summary: SLOW_COMPOUNDER_SUMMARY,
  summaryStatus: 'ready',
  modelKeyId: null,
  createdAt: SLOW_COMPOUNDER_CREATED_AT,
  lastDecision: SLOW_COMPOUNDER.decisions[0] ?? null,
};

/** Gamma Scout's owner: the agent is paused with `key_failing` and its key is still stored. */
const FAILING_KEY: ModelKeyPublic = { ...MODEL_KEY, id: fixtureId('key failing') };
const FAILING_AGENT: AgentOwnerView = {
  id: KEY_FAILING_AGENT.id,
  name: KEY_FAILING_AGENT.name,
  division: 'pro',
  status: 'paused',
  pausedReason: 'key_failing',
  hidden: false,
  prompt: KEY_FAILING_PROMPT,
  promptPublic: false,
  summary: KEY_FAILING_AGENT.summary,
  summaryStatus: 'ready',
  modelKeyId: FAILING_KEY.id,
  createdAt: KEY_FAILING_AGENT.createdAt,
  lastDecision: KEY_FAILING_AGENT.decisions[0] ?? null,
};

export type MeFixture =
  | 'signed-out'
  | 'signed-in'
  | 'signed-in-agent'
  | 'signed-in-admin'
  | 'signed-in-key-failing'
  | 'signed-in-pro'
  | 'signed-in-paused-owner'
  | 'signed-in-paused-key-removed'
  | 'signed-in-paused-admin'
  | 'signed-in-paused-slot-limit'
  | 'signed-in-hidden'
  | 'signed-in-provider-rejected'
  | 'signed-in-skipped'
  | 'signed-in-three-keys';

const SAMPLE_ROW = SLOW_COMPOUNDER.decisions[0] ?? null;
const sampleRow = (status: 'no_decision' | 'skipped', code: string) =>
  SAMPLE_ROW ? { ...SAMPLE_ROW, status, code, reason: null, fills: [], costMicro: 0 } : null;

/** A Pro agent with its own key, active. The other variants below start from it or from the Open agent. */
const PRO_KEY: ModelKeyPublic = {
  ...MODEL_KEY,
  id: fixtureId('key pro'),
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
};
const PRO_AGENT: AgentOwnerView = { ...FAILING_AGENT, status: 'active', pausedReason: null, modelKeyId: PRO_KEY.id };

function variant(fixture: MeFixture): MeResponse | null {
  const owner = SLOW_COMPOUNDER_OWNER;
  const base = { address: owner, isAdmin: false };
  if (fixture === 'signed-in-pro') return { ...base, agent: PRO_AGENT, modelKeys: [PRO_KEY] };
  if (fixture === 'signed-in-paused-owner') {
    return { ...base, agent: { ...OWNED_AGENT, status: 'paused', pausedReason: 'owner' }, modelKeys: [MODEL_KEY] };
  }
  if (fixture === 'signed-in-paused-key-removed') {
    return {
      ...base,
      agent: { ...PRO_AGENT, status: 'paused', pausedReason: 'key_removed', modelKeyId: null },
      modelKeys: [],
    };
  }
  if (fixture === 'signed-in-paused-admin') {
    return { ...base, agent: { ...OWNED_AGENT, status: 'paused', pausedReason: 'admin' }, modelKeys: [MODEL_KEY] };
  }
  if (fixture === 'signed-in-paused-slot-limit') {
    return { ...base, agent: { ...OWNED_AGENT, status: 'paused', pausedReason: 'slot_limit' }, modelKeys: [MODEL_KEY] };
  }
  if (fixture === 'signed-in-hidden')
    return { ...base, agent: { ...OWNED_AGENT, hidden: true }, modelKeys: [MODEL_KEY] };
  if (fixture === 'signed-in-provider-rejected') {
    return {
      ...base,
      agent: { ...OWNED_AGENT, lastDecision: sampleRow('no_decision', 'provider_rejected') },
      modelKeys: [MODEL_KEY],
    };
  }
  if (fixture === 'signed-in-skipped') {
    return {
      ...base,
      agent: { ...OWNED_AGENT, lastDecision: sampleRow('skipped', 'allocation_exhausted') },
      modelKeys: [MODEL_KEY],
    };
  }
  if (fixture === 'signed-in-three-keys') {
    const keys = [
      MODEL_KEY,
      PRO_KEY,
      { ...MODEL_KEY, id: fixtureId('key third'), provider: 'google' as const, last4: 'k2Lm' },
    ];
    return { ...base, agent: OWNED_AGENT, modelKeys: keys };
  }
  return null;
}

/** Null for a visitor who is not signed in: the API then answers 401. */
export function meResponse(fixture: MeFixture): MeResponse | null {
  if (fixture === 'signed-out') return null;
  const other = variant(fixture);
  if (other) return other;
  if (fixture === 'signed-in') return { address: SLOW_COMPOUNDER_OWNER, isAdmin: false, agent: null, modelKeys: [] };
  if (fixture === 'signed-in-key-failing') {
    return { address: KEY_FAILING_OWNER, isAdmin: false, agent: FAILING_AGENT, modelKeys: [FAILING_KEY] };
  }
  return {
    address: SLOW_COMPOUNDER_OWNER,
    isAdmin: fixture === 'signed-in-admin',
    agent: OWNED_AGENT,
    modelKeys: [MODEL_KEY],
  };
}

/** One symbol held for review after a price that looks like a ten-for-one split. */
export const HOLDS: HoldsResponse = {
  holds: [
    {
      symbol: 'NFLX',
      priceMicro: usd(1_184.2),
      seenPriceMicro: usd(118.46),
      sinceTickId: '2026-10-05T14:00Z',
      releasedAt: null,
      createdAt: '2026-10-05T14:00:21.000Z',
    },
  ],
};

/** `holds-empty`: no symbol is held. */
export const HOLDS_EMPTY: HoldsResponse = { holds: [] };

/** `holds-released`: the sample hold after an administrator released it. */
export const HOLDS_RELEASED: HoldsResponse = {
  holds: HOLDS.holds.map((hold) => ({ ...hold, releasedAt: '2026-10-05T16:30:00.000Z' })),
};

export const PROVIDERS_RESPONSE: ProvidersResponse = {
  providers: PROVIDERS.map((provider) => ({ id: provider.id, label: provider.label })),
  houseModel: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
};
