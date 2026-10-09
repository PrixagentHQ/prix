import {
  ADVICE_WORDS,
  agentSocialResponseSchema,
  familyResponseSchema,
  forkSourceResponseSchema,
  isSocialSafeText,
  managerDetailResponseSchema,
  managerListResponseSchema,
  myManagersResponseSchema,
  rivalriesResponseSchema,
  rivalryDetailResponseSchema,
  SOCIAL_FORBIDDEN_WORDS,
  warDetailResponseSchema,
  warListResponseSchema,
} from '@prix/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import { setHidden } from './support/agents.ts';
import { SENT_MESSAGES } from './support/http.ts';
import { dayAt } from './support/league.ts';
import { PRIVATE, PUBLISHED, type Rich, richWorld } from './support/world.ts';

/**
 * The public reads of Phase 6 over a database that holds a little of everything: shapes, caching, what
 * never leaves the server (a private prompt, an owner's address, a key), and hidden agents.
 */

let w: Rich;
const ids = () => w.agents.map((a) => a.id);
const [A, B, F, G] = [0, 1, 2, 3] as const;

beforeAll(async () => {
  w = await richWorld();
}, 120_000);

describe('every read answers its schema, with the cache policy of its kind', () => {
  it('the agent read: Strategy DNA, lineage and rivalries', async () => {
    const reply = await w.http.fetch('GET', `/api/social/agents/${ids()[A]}`);
    expect(reply.status, reply.text).toBe(200);
    expect(reply.headers.get('Cache-Control')).toBe('public, max-age=30');
    const body = agentSocialResponseSchema.parse(reply.json);
    expect(body).toMatchObject({ agentId: ids()[A], dnaWindowDays: 40, dnaMinDays: 10 });
    expect(body.dna).toMatchObject({ method: 'dna-v1', agentId: ids()[A], status: 'forming' });
    expect(body.lineage).toMatchObject({ depth: 0, childCount: 1, parent: null });
    expect(body.rivalries).toHaveLength(1);
    expect(body.rivalries[0]).toMatchObject({ status: 'active', leadChanges: 1, leader: ids()[B] });
    // Agent 4 is a fork of a fork: depth two, root agent 1.
    const deep = agentSocialResponseSchema.parse((await w.http.fetch('GET', `/api/social/agents/${ids()[G]}`)).json);
    expect(deep.lineage).toMatchObject({ depth: 2 });
    expect(deep.lineage.root).toMatchObject({ id: ids()[A] });
    expect(deep.rivalries).toEqual([]);
  });

  it('rivalries: the list, the detail and the days recorded', async () => {
    const list = await w.http.fetch('GET', '/api/social/rivalries');
    expect(list.headers.get('Cache-Control')).toBe('public, max-age=30');
    const body = rivalriesResponseSchema.parse(list.json);
    expect(body).toMatchObject({ division: 'open', method: 'v1', tapedDays: 6, page: 1, hasMore: false });
    expect(body.rivalries).toHaveLength(1);
    const first = body.rivalries[0];
    expect(first).toMatchObject({ formedDay: dayAt(4), status: 'active', rankA: 2, rankB: 1 });
    const detail = rivalryDetailResponseSchema.parse(
      (await w.http.fetch('GET', `/api/social/rivalries/${first?.id}`)).json,
    );
    expect(detail.series).toHaveLength(6);
    expect(detail.events.map((e) => e.kind)).toEqual(['overtake', 'formed']);
    expect(detail.method).toBe('v1');
    // The pro table has no rivalry yet but it has a tape.
    const pro = rivalriesResponseSchema.parse((await w.http.fetch('GET', '/api/social/rivalries?division=pro')).json);
    expect(pro).toMatchObject({ division: 'pro', rivalries: [], tapedDays: 6 });
    // The agent ids in a rivalry link are the agents that the table names.
    expect([first?.agentA.id, first?.agentB.id].sort()).toEqual([ids()[A], ids()[B]].sort());
  });

  it('wars: the list and the detail, with every war-day, the standings not yet ranked, and no stored model output', async () => {
    const list = warListResponseSchema.parse((await w.http.fetch('GET', '/api/social/wars')).json);
    expect(list.wars).toHaveLength(1);
    expect(list.wars[0]).toMatchObject({ id: w.warId, number: 1, status: 'running', daysDone: 6 });
    const reply = await w.http.fetch('GET', `/api/social/wars/${w.warId}`);
    expect(reply.headers.get('Cache-Control')).toBe('public, max-age=30');
    const detail = warDetailResponseSchema.parse(reply.json);
    expect(detail.war.status).toBe('running');
    expect(detail.entrants.map((e) => e.slot)).toEqual(['A', 'B', 'C']);
    expect(detail.days).toHaveLength(6);
    // A war-day carries the prices of the universe the war froze, and of nothing else (section 21).
    for (const day of detail.days) {
      expect(Object.keys(day.pricesMicro).sort()).toEqual([...detail.war.rules.universe].sort());
    }
    expect(detail.rows).toHaveLength(18);
    // While the war runs, no one is ranked: it is no live leaderboard.
    expect(detail.standings.map((s) => s.rank)).toEqual([null, null, null]);
    expect(detail.standings.map((s) => s.slot)).toEqual(['A', 'B', 'C']);
    // An entrant shows no portfolio, no stats and no count of rejected days.
    for (const entrant of detail.entrants) {
      expect(Object.keys(entrant)).not.toContain('portfolio');
      expect(Object.keys(entrant)).not.toContain('stats');
      expect(Object.keys(entrant)).not.toContain('rejectedDays');
    }
    for (const row of detail.rows) {
      expect(Object.keys(row)).not.toContain('text');
      expect(Object.keys(row)).not.toContain('raw');
    }
  });

  it('managers: the list, the detail and the owner’s own list', async () => {
    const list = managerListResponseSchema.parse((await w.http.fetch('GET', '/api/social/managers')).json);
    expect(list.managers.map((m) => m.name).sort()).toEqual(['Calm Basket', 'Steady Basket']);
    for (const m of list.managers) {
      expect(m.season?.valuedDays).toBe(5);
      expect(m.agentCount).toBe(3);
    }
    const detail = managerDetailResponseSchema.parse(
      (await w.http.fetch('GET', `/api/social/managers/${w.managerIds[0]}`)).json,
    );
    expect(detail.allocation).toHaveLength(3);
    expect(detail.daily).toHaveLength(5);
    expect(detail.rebalances.length).toBeGreaterThan(0);
    const cookie = await w.http.signIn(w.owners[0] as string);
    const mine = await w.http.fetch('GET', '/api/social/me/managers', { cookie });
    expect(mine.headers.get('Cache-Control')).toBe('no-store');
    expect(myManagersResponseSchema.parse(mine.json).managers.map((m) => m.id)).toEqual([w.managerIds[0]]);
  });

  it('families and fork sources', async () => {
    const family = familyResponseSchema.parse((await w.http.fetch('GET', `/api/social/families/${ids()[A]}`)).json);
    expect(family.members.map((m) => m.id)).toEqual([ids()[F], ids()[G]]);
    const source = forkSourceResponseSchema.parse(
      (await w.http.fetch('GET', `/api/social/agents/${ids()[A]}/fork-source`)).json,
    );
    expect(source.dna).toMatchObject({ method: 'dna-v1' });
    expect(source.parent.prompt).toBeNull();
  });
});

describe('what never leaves the server', () => {
  async function sweep(): Promise<string> {
    const w2 = w;
    const paths: string[] = [
      '/api/social/status',
      '/api/social/rivalries',
      '/api/social/rivalries?division=pro',
      '/api/social/wars',
      '/api/social/managers',
    ];
    for (const id of ids())
      paths.push(`/api/social/agents/${id}`, `/api/social/agents/${id}/fork-source`, `/api/social/families/${id}`);
    for (const id of w2.managerIds) paths.push(`/api/social/managers/${id}`);
    paths.push(`/api/social/wars/${w2.warId}`);
    const list = await w2.http.fetch('GET', '/api/social/rivalries');
    for (const r of list.json.rivalries) paths.push(`/api/social/rivalries/${r.id}`);
    const texts: string[] = [];
    for (const path of paths) {
      const reply = await w2.http.fetch('GET', path);
      texts.push(reply.text);
    }
    for (const owner of w2.owners) {
      texts.push((await w2.http.fetch('GET', '/api/social/me/managers', { cookie: await w2.http.signIn(owner) })).text);
    }
    return texts.join('\n');
  }

  it('no response of Phase 6 carries a private prompt, whoever asks', async () => {
    const everything = await sweep();
    for (let n = 1; n <= 5; n++) {
      if (n === 2) continue;
      expect(everything, `private prompt ${n}`).not.toContain(PRIVATE(n));
    }
    expect(everything).not.toContain('marker-');
    // The strategy of a war is Prix's own public text, not an agent's.
    expect(everything).toContain('Hold a few large companies');
  });

  it('a published prompt leaves in a fork source and nowhere else', async () => {
    const source = await w.http.fetch('GET', `/api/social/agents/${ids()[B]}/fork-source`);
    expect(source.text).toContain(PUBLISHED);
    expect(forkSourceResponseSchema.parse(source.json).parent.prompt).toContain(PUBLISHED);
    const others: string[] = [];
    for (const path of [
      `/api/social/agents/${ids()[B]}`,
      `/api/social/families/${ids()[B]}`,
      '/api/social/rivalries',
      `/api/social/managers/${w.managerIds[0]}`,
    ]) {
      others.push((await w.http.fetch('GET', path)).text);
    }
    expect(others.join('\n')).not.toContain(PUBLISHED);
  });

  it('no response carries the full address of an owner, a manager’s owner or a model key', async () => {
    const everything = (await sweep()).toLowerCase();
    for (const agent of w.agents) {
      expect(everything, agent.owner).not.toContain(agent.owner.slice(2).toLowerCase());
    }
    for (const owner of w.owners) expect(everything).not.toContain(owner.slice(2).toLowerCase());
    expect(everything).not.toContain('keyaaaaaaaaa');
    // Only the short form of an owner is used.
    expect(everything).toMatch(/"ownersshort"|"ownershort"/i);
  });

  it('no key of a Phase 6 response is a prompt, a key, a secret or an owner except the fork-source prompt', async () => {
    const forbidden = /^(owner|prompt|apiKey|key|secret|token|signature|modelKeyId|ownerAddress)$/i;
    const seen: string[] = [];
    const walk = (value: unknown, where: string): void => {
      if (Array.isArray(value)) {
        for (const [i, v] of value.entries()) walk(v, `${where}[${i}]`);
      } else if (value !== null && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) {
          if (forbidden.test(k) && !(k === 'prompt' && where.endsWith('.parent'))) seen.push(`${where}.${k}`);
          walk(v, `${where}.${k}`);
        }
      }
    };
    for (const path of [
      `/api/social/agents/${ids()[A]}`,
      `/api/social/agents/${ids()[A]}/fork-source`,
      `/api/social/families/${ids()[A]}`,
      '/api/social/rivalries',
      '/api/social/wars',
      `/api/social/wars/${w.warId}`,
      '/api/social/managers',
      `/api/social/managers/${w.managerIds[0]}`,
    ]) {
      walk((await w.http.fetch('GET', path)).json, path);
    }
    expect(seen).toEqual([]);
  });
});

describe('hidden agents', () => {
  it('are unknown on every path that names them, left out of every list, and back when shown again', async () => {
    const b = ids()[B] as string;
    const rivalryId = (await w.http.fetch('GET', '/api/social/rivalries')).json.rivalries[0].id as string;
    await setHidden(b, true);

    for (const path of [
      `/api/social/agents/${b}`,
      `/api/social/agents/${b}/fork-source`,
      `/api/social/rivalries/${rivalryId}`,
    ]) {
      expect((await w.http.fetch('GET', path)).status, path).toBe(404);
    }
    // The rivalry is left out of the list and of the page of the agent beside it.
    expect(rivalriesResponseSchema.parse((await w.http.fetch('GET', '/api/social/rivalries')).json).rivalries).toEqual(
      [],
    );
    expect(
      agentSocialResponseSchema.parse((await w.http.fetch('GET', `/api/social/agents/${ids()[A]}`)).json).rivalries,
    ).toEqual([]);
    // A manager that holds the agent shows a line with no name, id or figure.
    const manager = await w.http.fetch('GET', `/api/social/managers/${w.managerIds[0]}`);
    expect(manager.text).not.toContain(b);
    expect(manager.text).not.toContain(w.agents[B]?.name);
    expect(
      managerDetailResponseSchema.parse(manager.json).allocation.filter((line) => line.agent === null),
    ).toHaveLength(1);

    await setHidden(b, false);
    expect((await w.http.fetch('GET', `/api/social/agents/${b}`)).status).toBe(200);
    expect(
      rivalriesResponseSchema.parse((await w.http.fetch('GET', '/api/social/rivalries')).json).rivalries,
    ).toHaveLength(1);
    expect(
      agentSocialResponseSchema.parse((await w.http.fetch('GET', `/api/social/agents/${ids()[A]}`)).json).rivalries,
    ).toHaveLength(1);
    expect((await w.http.fetch('GET', `/api/social/rivalries/${rivalryId}`)).status).toBe(200);
  });

  it('a hidden Strategy DNA row is kept and never served', async () => {
    const g = ids()[G] as string;
    expect(
      agentSocialResponseSchema.parse((await w.http.fetch('GET', `/api/social/agents/${g}`)).json).dna,
    ).not.toBeNull();
    await setHidden(g, true);
    expect((await w.http.fetch('GET', `/api/social/agents/${g}`)).status).toBe(404);
    expect((await w.stores.social.getDna(g)) === null).toBe(true);
    await setHidden(g, false);
    expect(
      agentSocialResponseSchema.parse((await w.http.fetch('GET', `/api/social/agents/${g}`)).json).dna,
    ).not.toBeNull();
  });
});

describe('queries and ids are strict', () => {
  it('refuses an unknown query key, a bad division and a bad page, and answers a malformed id with 404', async () => {
    for (const path of [
      '/api/social/rivalries?division=chain',
      '/api/social/rivalries?division=open&extra=1',
      '/api/social/rivalries?page=0',
      '/api/social/wars?page=abc',
      '/api/social/wars?x=1',
      '/api/social/managers?page=101',
      `/api/social/families/${ids()[A]}?page=-1`,
    ]) {
      const reply = await w.http.fetch('GET', path);
      expect(reply.status, path).toBe(400);
      expect(reply.json.error.code).toBe('invalid_input');
    }
    for (const path of [
      '/api/social/agents/short',
      '/api/social/rivalries/not-a-rivalry',
      '/api/social/rivalries/seasononeaaa-aaaaaaaaaaab-aaaaaaaaaaac',
      '/api/social/wars/short',
      '/api/social/wars/aaaaaaaaaaab',
      '/api/social/managers/short',
    ]) {
      expect((await w.http.fetch('GET', path)).status, path).toBe(404);
    }
    // Rate limits apply like everywhere: a denied read is a 429.
    w.http.limiter.denied.add('read');
    expect((await w.http.fetch('GET', '/api/social/wars')).status).toBe(429);
    w.http.limiter.denied.delete('read');
  });
});

describe('the words Prix does not use', () => {
  it('appear in no error message the routes sent, and the scanner does catch them', () => {
    expect(SENT_MESSAGES.size).toBeGreaterThan(3);
    const bad = [...SENT_MESSAGES].filter((m) => SOCIAL_FORBIDDEN_WORDS.test(m) || ADVICE_WORDS.test(m));
    expect(bad).toEqual([]);
    for (const probe of ['the best model', 'a winner', 'you beat it', 'a fund', 'place a bet', 'the odds', 'a prize']) {
      expect(isSocialSafeText(probe), probe).toBe(false);
    }
  });
});
