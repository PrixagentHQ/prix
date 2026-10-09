import { agentPublicSchema, BPS, dataEnvelope, leagueResponseSchema, tickIdFor } from '@prix/contracts';
import { describe, expect, it } from 'vitest';
import { makeAgent, makeRow, SEASON_1, startingPortfolio, startingStats, utc } from '../support/fixtures.ts';
import { createDataHarness, testWallet } from './support/harness.ts';

/**
 * The Phase 5 data API returns the league rows of the public API (docs/CONTRACTS.md section 17.2),
 * so a buyer of data gets the three largest holdings and the cash weight of every row too, valued
 * as the agent read values them.
 */

const BUYER = testWallet(82);

describe('the data API and the holdings of a league row', () => {
  it('gives every row its top holdings and its cash weight, equal to the agent read', async () => {
    const h = await createDataHarness();
    // The harness seeds agent 1 with a row at its 13:00 tick; agent 2 trades at the same tick.
    const agent = makeAgent({ n: 2 });
    expect(await h.api.store.createAgent(agent, SEASON_1.id, startingPortfolio(), startingStats(), 200)).toBe(
      'created',
    );
    const portfolio = {
      cashMicro: 3_000_000_000,
      holdings: { NVDA: 10_000_000, MSFT: 4_000_000, AAPL: 6_000_000, SPY: 1_000_000, GME: 9_000_000 },
    };
    const tickId = tickIdFor(utc('2026-10-06T13:00:00.000Z'));
    expect(await h.api.store.writeDecision(makeRow({ agent, tickId, portfolio }), startingStats(), 0)).toBe(true);

    const { secret } = await h.seedKey(BUYER.address);
    const league = await h.send('GET', '/api/v1/league', { key: secret });
    expect(league.status, league.text).toBe(200);
    const rows = dataEnvelope(leagueResponseSchema).parse(league.json).data.rows;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.topHoldings).toBeDefined();
      expect(row.cashWeightBps).toBeDefined();
    }
    expect(rows.find((row) => row.agentId === h.agentId)).toMatchObject({ topHoldings: [], cashWeightBps: BPS });

    const read = await h.send('GET', `/api/v1/agents/${agent.id}`, { key: secret });
    expect(read.status, read.text).toBe(200);
    const page = dataEnvelope(agentPublicSchema).parse(read.json).data;
    const row = rows.find((entry) => entry.agentId === agent.id);
    expect(row?.topHoldings).toHaveLength(3);
    expect(row?.topHoldings).toEqual(
      page.holdings.slice(0, 3).map((entry) => ({ symbol: entry.symbol, weightBps: entry.weightBps })),
    );
    expect(row?.cashWeightBps).toBe(page.cashWeightBps);
  });
});
