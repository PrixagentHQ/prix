import type { AgentPublic } from '@prix/contracts';
import { containsAdviceWord, SHARE_DESCRIPTION_MAX, SHARE_TITLE_MAX } from '@prix/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import { formatPercentBps } from '../../apps/web/src/content/format.ts';
import { agentShare } from '../../apps/web/src/site/follow/share.ts';
import { baseAgentPublic } from './support.ts';

const SHORT = 'Zed';
const LONG = 'Northwind Momentum Desk Alpha 01'; // 32 characters
const NAMES = [SHORT, LONG];
const SIMULATION = 'Paper trading simulation.';
const NOT_ADVICE = 'Not investment advice.';

let base: AgentPublic;
beforeAll(async () => {
  base = await baseAgentPublic();
});

function agentWith(name: string, state: 'ranked' | 'unranked' | 'negative'): AgentPublic {
  const ranked = state !== 'unranked';
  return {
    ...base,
    name,
    rank: ranked ? 3 : null,
    unrankedReason: ranked ? null : 'min_decisions',
    stats: { ...base.stats, seasonReturnBps: state === 'negative' ? -1_234 : 2_468 },
  };
}

describe('agentShare', () => {
  it('has a 32 character name in the fixture', () => {
    expect(LONG).toHaveLength(32);
    expect(SHORT).toHaveLength(3);
  });

  for (const name of NAMES) {
    for (const state of ['ranked', 'unranked', 'negative'] as const) {
      it(`fits the limits and keeps the label for a ${name.length} character name, ${state}`, () => {
        const agent = agentWith(name, state);
        const share = agentShare(agent, 40);
        expect(share.title.length).toBeLessThanOrEqual(SHARE_TITLE_MAX);
        expect(share.description.length).toBeLessThanOrEqual(SHARE_DESCRIPTION_MAX);
        expect(share.title).toContain(name);
        expect(share.description).toContain(SIMULATION);
        expect(share.description).toContain(NOT_ADVICE);
        if (state !== 'unranked') {
          expect(share.title).toContain('3');
          expect(share.title).toContain('40');
          expect(share.title).toContain(formatPercentBps(agent.stats.seasonReturnBps));
        }
        expect(containsAdviceWord(`${share.title} ${share.description}`)).toBe(false);
      });
    }
  }

  it('shows the negative return as a negative number in text', () => {
    const share = agentShare(agentWith(SHORT, 'negative'), 40);
    expect(formatPercentBps(-1_234)).toMatch(/12\.34/);
    expect(share.title).toContain(formatPercentBps(-1_234));
    expect(share.title).not.toContain(formatPercentBps(2_468));
  });

  it('puts a neutral name in a preview instead of a name with an advice word', () => {
    const share = agentShare(agentWith('Should Win', 'ranked'), 40);
    expect(containsAdviceWord(`${share.title} ${share.description}`)).toBe(false);
  });
});
