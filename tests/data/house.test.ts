import { agentPublicSchema, dataEnvelope, leagueResponseSchema } from '@prix/contracts';
import { describe, expect, it } from 'vitest';
import { testAddress } from '../support/fixtures.ts';
import { createDataHarness, testWallet } from './support/harness.ts';

/**
 * The Phase 5 data API returns the league rows and the agent read of the public API
 * (docs/CONTRACTS.md section 17), so a buyer of data sees `summary`, `createdAt` and `house` too.
 * The house wallets reach the handlers beside `DataDeps`, as the Worker entry hands them over.
 */

/** The owner of the one agent the harness seeds: agent 1 of the fixtures. */
const SEEDED_OWNER = testAddress(1001);
const BUYER = testWallet(81);

async function read(houseOwners: readonly string[] | undefined) {
  const h = await createDataHarness({ houseOwners });
  expect(h.agentOwner).toBe(SEEDED_OWNER);
  const { secret } = await h.seedKey(BUYER.address);
  const league = await h.send('GET', '/api/v1/league', { key: secret });
  expect(league.status, league.text).toBe(200);
  const agent = await h.send('GET', `/api/v1/agents/${h.agentId}`, { key: secret });
  expect(agent.status, agent.text).toBe(200);
  const rows = dataEnvelope(leagueResponseSchema).parse(league.json).data.rows;
  return { h, league, agent, rows, page: dataEnvelope(agentPublicSchema).parse(agent.json).data };
}

describe('the data API and the house mark', () => {
  it('marks a house agent on the league row and on the agent read, with its summary and creation time', async () => {
    const { h, league, agent, rows, page } = await read([`0x${SEEDED_OWNER.slice(2).toUpperCase()}`]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      agentId: h.agentId,
      house: true,
      summary: 'Holds the largest companies and trades rarely.',
      createdAt: '2026-10-05T08:00:00.000Z',
    });
    expect(page.house).toBe(true);
    // The mark is all a buyer learns about the wallet: its address is in neither answer.
    expect(league.text.toLowerCase()).not.toContain(SEEDED_OWNER.slice(2));
    expect(agent.text.toLowerCase()).not.toContain(SEEDED_OWNER.slice(2));
  });

  it('says house false when the agent is not of a house wallet, and when none is named', async () => {
    const other = await read([testAddress(4242)]);
    expect(other.rows[0]?.house).toBe(false);
    expect(other.page.house).toBe(false);
    const none = await read(undefined);
    expect(none.rows[0]).toMatchObject({ house: false, createdAt: '2026-10-05T08:00:00.000Z' });
    expect(none.page.house).toBe(false);
  });
});
