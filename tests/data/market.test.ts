import { dataEnvelope, marketSnapshotResponseSchema, UNIVERSE_SIZE } from '@prix/contracts';
import { UNIVERSE } from '@prix/market/universe';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DataHarness } from './support/harness.ts';
import { createDataHarness, ENDPOINTS, testWallet } from './support/harness.ts';

/**
 * The market read of the data API and MCP with the crypto assets of docs/CONTRACTS.md section 21:
 * the prices of the latest tick are those of every symbol of the universe, the Stock Tokens and the
 * coins, and the API describes them that way (rule 8).
 */

const wallet = testWallet(521);
let h: DataHarness;
let key: string;

const market = ENDPOINTS.find((spec) => spec.id === 'market');

beforeAll(async () => {
  h = await createDataHarness();
  key = (await h.newKey(wallet)).secret;
});

describe('the data API market read with the crypto assets', () => {
  it('is in the registry', () => {
    expect(market).toBeDefined();
  });

  it('gives the price of every symbol of the universe at the latest tick, the coins included', async () => {
    const reply = await h.callEndpoint(market as NonNullable<typeof market>, key);
    expect(reply.status, reply.text.slice(0, 300)).toBe(200);
    const body = dataEnvelope(marketSnapshotResponseSchema).parse(reply.json);
    const symbols = (body.data.snapshot?.prices ?? []).map((point) => point.symbol);
    expect(symbols).toHaveLength(UNIVERSE_SIZE);
    expect([...symbols].sort()).toEqual(UNIVERSE.map((token) => token.symbol).sort());
    expect(symbols).toEqual(expect.arrayContaining(['BTC', 'ETH']));
  });

  it('describes the prices as those of the Stock Tokens and crypto assets, in the schema and the tool list', async () => {
    const schema = await h.send('GET', '/api/v1/schema');
    expect(schema.status).toBe(200);
    const endpoint = (schema.json.endpoints as { id: string; summary?: string; description?: string }[]).find(
      (entry) => entry.id === 'market',
    );
    expect(JSON.stringify(endpoint)).toMatch(/Stock Tokens and crypto assets/);

    const tools = await h.send('POST', '/api/v1/mcp', {
      key: null,
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    });
    expect(tools.status).toBe(200);
    const tool = (tools.json.result.tools as { name: string; description: string }[]).find(
      (entry) => entry.name === market?.mcpTool,
    );
    expect(tool?.description).toMatch(/Stock Tokens and crypto assets/);
    // No description of the data API still speaks of twenty tokens only.
    expect(JSON.stringify(tools.json)).not.toMatch(/\b(20|twenty) (Stock )?Tokens\b/i);
  });
});
