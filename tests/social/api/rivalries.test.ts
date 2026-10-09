import type { Rivalry } from '@prix/contracts';
import {
  agentSocialResponseSchema,
  rivalriesResponseSchema,
  rivalryDetailResponseSchema,
  rivalryId,
} from '@prix/contracts';
import { describe, expect, it } from 'vitest';
import { SEASON_1 } from '../../support/fixtures.ts';
import { createHarness, type Harness, START } from './harness.ts';
import { promptKeys } from './scan.ts';

async function pair(h: Harness, status: Rivalry['status'] = 'active') {
  const a = await h.seedAgent(1);
  const b = await h.seedAgent(2);
  const [lo, hi] = a.id < b.id ? [a, b] : [b, a];
  const rivalry: Rivalry = {
    seasonId: SEASON_1.id,
    division: 'open',
    agentA: lo.id,
    agentB: hi.id,
    status,
    formedDay: '2026-10-16',
    endedDay: status === 'ended' ? '2026-10-19' : null,
    endReason: status === 'ended' ? 'apart' : null,
    leader: lo.id,
    leadChanges: 2,
    lastDay: '2026-10-19',
    series: [
      ['2026-10-16', 4, 3],
      ['2026-10-19', 3, 4],
    ],
  };
  h.social.rivalries.push(rivalry);
  h.social.events.push({
    seasonId: SEASON_1.id,
    agentA: lo.id,
    agentB: hi.id,
    day: '2026-10-19',
    seq: 0,
    kind: 'overtake',
    subject: lo.id,
    rankA: 3,
    rankB: 4,
    detail: { gap: 1 },
  });
  h.social.tapeDays.set(`${SEASON_1.id}|open`, 11);
  return { lo, hi, rivalry, id: rivalryId(SEASON_1.id, lo.id, hi.id) };
}

describe('GET /api/social/rivalries', () => {
  it('lists the rivalries of the current season with the latest ranks, cached 30 s', async () => {
    const h = createHarness();
    const { lo, hi, id } = await pair(h);
    const reply = await h.fetch('GET', '/api/social/rivalries');
    expect(reply.headers.get('cache-control')).toBe('public, max-age=30');
    const body = rivalriesResponseSchema.parse(reply.json);
    expect(body).toMatchObject({ seasonId: SEASON_1.id, division: 'open', method: 'v1', tapedDays: 11, page: 1 });
    expect(body.hasMore).toBe(false);
    expect(body.rivalries).toHaveLength(1);
    expect(body.rivalries[0]).toMatchObject({ id, rankA: 3, rankB: 4, agentA: { id: lo.id }, agentB: { id: hi.id } });
    expect(reply.text).not.toContain(lo.owner);
    expect(promptKeys(reply.json)).toEqual([]);
  });

  it('says the season method, takes a division and refuses unknown query fields', async () => {
    const h = createHarness();
    await pair(h);
    h.methods.set(SEASON_1.id, 'v2');
    const pro = rivalriesResponseSchema.parse((await h.fetch('GET', '/api/social/rivalries?division=pro')).json);
    expect(pro).toMatchObject({ division: 'pro', method: 'v2', tapedDays: 0, rivalries: [] });
    expect((await h.fetch('GET', '/api/social/rivalries?sort=score')).status).toBe(400);
  });

  it('leaves out a rivalry with a hidden agent', async () => {
    const h = createHarness();
    const { hi } = await pair(h);
    await h.store.updateAgent(hi.id, { hidden: true }, START);
    const body = rivalriesResponseSchema.parse((await h.fetch('GET', '/api/social/rivalries')).json);
    expect(body.rivalries).toEqual([]);
  });
});

describe('GET /api/social/rivalries/:id', () => {
  it('shows one rivalry with its series and events', async () => {
    const h = createHarness();
    const { id, rivalry } = await pair(h, 'ended');
    const reply = await h.fetch('GET', `/api/social/rivalries/${id}`);
    expect(reply.headers.get('cache-control')).toBe('public, max-age=30');
    const body = rivalryDetailResponseSchema.parse(reply.json);
    expect(body.rivalry).toMatchObject({ id, status: 'ended', endReason: 'apart' });
    expect(body.series).toEqual(rivalry.series);
    expect(body.events).toHaveLength(1);
    expect(body.method).toBe('v1');
  });

  it('answers 404 for a malformed, unknown, reversed or hidden rivalry', async () => {
    const h = createHarness();
    const { lo, hi, id } = await pair(h);
    expect((await h.fetch('GET', '/api/social/rivalries/nope')).status).toBe(404);
    expect((await h.fetch('GET', `/api/social/rivalries/${SEASON_1.id}-${hi.id}-${lo.id}`)).status).toBe(404);
    expect((await h.fetch('GET', `/api/social/rivalries/${SEASON_1.id}-${lo.id}-agentzzzzzzz`)).status).toBe(404);
    await h.store.updateAgent(lo.id, { hidden: true }, START);
    expect((await h.fetch('GET', `/api/social/rivalries/${id}`)).status).toBe(404);
  });
});

describe('rivalries on the agent read', () => {
  it('shows the active rivalries of the current season', async () => {
    const h = createHarness();
    const { lo, id } = await pair(h);
    const body = agentSocialResponseSchema.parse((await h.fetch('GET', `/api/social/agents/${lo.id}`)).json);
    expect(body.rivalries.map((r) => r.id)).toEqual([id]);
  });
});
