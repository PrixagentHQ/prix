import type { TokenFacts } from '@prix/contracts';
import { DEVELOPER_LAUNCHES_MAX, TRUST_BLIND_SPOTS, TRUST_METHODS } from '@prix/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import { describeToken } from '../../apps/api/src/http/data/trust.ts';
import type { DataHarness } from './support/harness.ts';
import { basicsOf, createDataHarness, launchOf, lc, OTHER_ADDRESS, testWallet } from './support/harness.ts';

/** docs/contracts/phase-5-data.md section 8 item 5: a lookup is a list of facts. */

const TOKEN = `0x${'12'.repeat(20)}`;
const ZERO = `0x${'0'.repeat(40)}`;
const wallet = testWallet(901);

let h: DataHarness;
let key: string;

beforeAll(async () => {
  h = await createDataHarness();
  key = (await h.newKey(wallet)).secret;
  h.chain.launchesByDeployer.set(OTHER_ADDRESS, [launchOf(TOKEN, OTHER_ADDRESS)]);
});

/** Every key of every object in a JSON value. */
function keysOf(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) for (const item of value) keysOf(item, into);
  else if (value !== null && typeof value === 'object') {
    for (const [name, item] of Object.entries(value)) {
      into.push(name);
      keysOf(item, into);
    }
  }
  return into;
}
const SCORE_LIKE = /^(score|grade|rating|risk|riskscore|risk_score|trustscore|trust_score|rank_score)$/i;
const VERDICT_WORDS = /\b(safe|scam|rug|rugpull|risk score|trusted|trustworthy|legit)\b/i;

describe('every lookup states its method and its blind spots', () => {
  const lookups = [
    {
      kind: 'developer',
      path: `/trust/developers/${OTHER_ADDRESS}`,
      page: `/api/data/trust/developers/${OTHER_ADDRESS}`,
    },
    { kind: 'token', path: `/trust/tokens/${TOKEN}`, page: `/api/data/trust/tokens/${TOKEN}` },
    { kind: 'wallet', path: `/trust/wallets/${wallet.address}`, page: `/api/data/trust/wallets/${wallet.address}` },
  ] as const;

  for (const lookup of lookups) {
    it(`${lookup.kind}: keyed route and public page route carry TRUST_METHODS and TRUST_BLIND_SPOTS word for word`, async () => {
      const keyed = await h.send('GET', `/api/v1${lookup.path}`, { key });
      const page = await h.send('GET', lookup.page);
      for (const reply of [keyed, page]) {
        expect(reply.status, reply.text.slice(0, 300)).toBe(200);
        const data = reply.json.data;
        expect(data.method).toBe(TRUST_METHODS[lookup.kind]);
        expect(data.blindSpots).toEqual([...TRUST_BLIND_SPOTS[lookup.kind]]);
        expect(data.blindSpots.length).toBeGreaterThan(0);
        const names = keysOf(data);
        expect(names.filter((name) => SCORE_LIKE.test(name))).toEqual([]);
        for (const observation of data.observations as { text: string }[]) {
          expect(observation.text).not.toMatch(VERDICT_WORDS);
        }
      }
      expect(page.json.data).toEqual(keyed.json.data);
      expect(page.headers.get('Cache-Control')).toBe('public, max-age=60');
    });
  }

  it('the registry has no field named score, grade or risk anywhere in an answer', async () => {
    h.chain.basics.set(TOKEN, basicsOf({ owner: `0x${'77'.repeat(20)}`, hasMintSelector: true }));
    const everything = await Promise.all(lookups.map((lookup) => h.send('GET', `/api/v1${lookup.path}`, { key })));
    for (const reply of everything) {
      expect(keysOf(reply.json).filter((name) => /score|grade|risk/i.test(name))).toEqual([]);
    }
  });

  it('an address is lower-cased before it is sent to the chain', async () => {
    const mixed = `0x${'AbCd'.repeat(10)}`;
    h.chain.calls.length = 0;
    const reply = await h.send('GET', `/api/v1/trust/developers/${mixed}`, { key });
    expect(reply.status).toBe(200);
    expect(reply.json.data.address).toBe(lc(mixed));
    expect(h.chain.calls[0]?.args[0]).toBe(lc(mixed));
  });

  it('a malformed address is a 400 before any chain call', async () => {
    h.chain.calls.length = 0;
    const reply = await h.send('GET', '/api/v1/trust/tokens/0x1234', { key });
    expect(reply.status).toBe(400);
    expect(h.chain.calls).toHaveLength(0);
  });

  it('a developer with more than 50 launches is cut at 50 and says so', async () => {
    const many = `0x${'99'.repeat(20)}`;
    h.chain.launchesByDeployer.set(
      many,
      Array.from({ length: DEVELOPER_LAUNCHES_MAX + 5 }, (_, i) =>
        launchOf(`0x${(i + 1).toString(16).padStart(40, '0')}`, many, i + 1),
      ),
    );
    const reply = await h.send('GET', `/api/v1/trust/developers/${many}`, { key });
    expect(reply.json.data.launchCount).toBe(DEVELOPER_LAUNCHES_MAX + 5);
    expect(reply.json.data.launches).toHaveLength(DEVELOPER_LAUNCHES_MAX);
    expect(reply.json.data.observations.map((o: { code: string }) => o.code)).toContain('launches_truncated');
  });

  it('a developer with no launch says no_launches_found, and a wallet with no agent says no_agent_found', async () => {
    const none = await h.send('GET', `/api/v1/trust/developers/0x${'55'.repeat(20)}`, { key });
    expect(none.json.data.observations.map((o: { code: string }) => o.code)).toContain('no_launches_found');
    const stranger = await h.send('GET', `/api/v1/trust/wallets/0x${'56'.repeat(20)}`, { key });
    expect(stranger.json.data.agents).toEqual([]);
    expect(stranger.json.data.observations.map((o: { code: string }) => o.code)).toContain('no_agent_found');
  });

  it('a hidden agent is left out of the wallet lookup', async () => {
    const owner = h.agentOwner;
    const shown = await h.send('GET', `/api/v1/trust/wallets/${owner}`, { key });
    expect(shown.json.data.agents).toHaveLength(1);
    expect(await h.api.store.updateAgent(h.agentId, { hidden: true }, h.api.now().toISOString())).toBe('updated');
    const hidden = await h.send('GET', `/api/v1/trust/wallets/${owner}`, { key });
    expect(hidden.json.data.agents).toEqual([]);
  });
});

describe('describeToken produces the observations of each case', () => {
  const codes = (facts: TokenFacts): string[] => facts.observations.map((o) => o.code);
  const launch = launchOf(TOKEN, OTHER_ADDRESS);

  it('not a contract', () => {
    const facts = describeToken(
      basicsOf({ isContract: false, codeSizeBytes: 0, name: null, symbol: null, decimals: null, totalSupply: null }),
      null,
      TOKEN,
    );
    expect(codes(facts)).toContain('not_a_contract');
    expect(facts.isContract).toBe(false);
  });

  it('an owner that is set is named, and the zero address is a renounced owner shown as null', () => {
    const owner = `0x${'77'.repeat(20)}`;
    const set = describeToken(basicsOf({ owner }), null, TOKEN);
    expect(codes(set)).toContain('owner_set');
    expect(set.owner).toBe(owner);
    expect(set.observations.find((o) => o.code === 'owner_set')?.text).toContain(owner);

    const renounced = describeToken(basicsOf({ owner: ZERO }), null, TOKEN);
    expect(codes(renounced)).toContain('owner_renounced');
    expect(codes(renounced)).not.toContain('owner_set');
    expect(renounced.owner).toBeNull();
  });

  it('an upgradeable proxy', () => {
    const impl = `0x${'88'.repeat(20)}`;
    const facts = describeToken(basicsOf({ proxyImplementation: impl }), null, TOKEN);
    expect(codes(facts)).toContain('upgradeable_proxy');
    expect(facts.proxyImplementation).toBe(impl);
  });

  it('a mint selector, and a pause selector', () => {
    expect(codes(describeToken(basicsOf({ hasMintSelector: true }), null, TOKEN))).toContain('mint_selector_present');
    expect(codes(describeToken(basicsOf({ hasPauseSelector: true }), null, TOKEN))).toContain('pause_selector_present');
    expect(codes(describeToken(basicsOf(), null, TOKEN))).not.toContain('mint_selector_present');
  });

  it('a deployer that holds over 10 percent, and not at exactly 10 percent', () => {
    const over = describeToken(basicsOf({ totalSupply: '1000', holderBalance: '101' }), launch, TOKEN);
    expect(over.deployerHoldingBps).toBe(1010);
    expect(codes(over)).toContain('deployer_holds_over_10_percent');
    const exactly = describeToken(basicsOf({ totalSupply: '1000', holderBalance: '100' }), launch, TOKEN);
    expect(exactly.deployerHoldingBps).toBe(1000);
    expect(codes(exactly)).not.toContain('deployer_holds_over_10_percent');
  });

  it('a launch on Pons and a token that is not found there', () => {
    expect(codes(describeToken(basicsOf(), launch, TOKEN))).toContain('launched_on_pons');
    expect(codes(describeToken(basicsOf(), null, TOKEN))).toContain('not_found_on_pons');
  });

  it('fields that cannot be read', () => {
    expect(codes(describeToken(basicsOf({ name: null, symbol: null }), null, TOKEN))).toContain('fields_unreadable');
  });

  it('states its method and its blind spots, has chain 4663, and no verdict word or score key', () => {
    const facts = describeToken(basicsOf({ hasMintSelector: true, owner: `0x${'77'.repeat(20)}` }), launch, TOKEN);
    expect(facts.method).toBe(TRUST_METHODS.token);
    expect(facts.blindSpots).toEqual([...TRUST_BLIND_SPOTS.token]);
    expect(facts.chainId).toBe(4663);
    expect(keysOf(facts).filter((name) => SCORE_LIKE.test(name))).toEqual([]);
    for (const o of facts.observations) expect(o.text).not.toMatch(VERDICT_WORDS);
  });
});
