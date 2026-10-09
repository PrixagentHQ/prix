import { buildSchemaDocument, DATA_NOTICE, dataEnvelope, schemaDocumentSchema } from '@prix/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DataHarness } from './support/harness.ts';
import { createDataHarness, ENDPOINTS, launchOf, OTHER_ADDRESS, testWallet } from './support/harness.ts';

/**
 * docs/SPEC.md section 12 and docs/contracts/phase-5-data.md section 8 item 1: every row of the
 * registry over HTTP and over MCP, the published schema, and the tool list.
 */

const wallet = testWallet(501);
let h: DataHarness;
let key: string;
let mcpId = 0;

async function mcp(method: string, params: Record<string, unknown> = {}, withKey: string | null = key) {
  mcpId += 1;
  return h.send('POST', '/api/v1/mcp', {
    key: withKey,
    body: { jsonrpc: '2.0', id: mcpId, method, params },
  });
}

beforeAll(async () => {
  h = await createDataHarness();
  h.chain.launchesByDeployer.set(OTHER_ADDRESS, [launchOf(`0x${'12'.repeat(20)}`, OTHER_ADDRESS)]);
  key = (await h.newKey(wallet)).secret;
});

describe('every endpoint of the registry over HTTP', () => {
  for (const spec of ENDPOINTS) {
    it(`${spec.id}: GET /api/v1${spec.path} answers an envelope that parses with the registry's schema`, async () => {
      const reply = await h.callEndpoint(spec, key);
      expect(reply.status, reply.text.slice(0, 300)).toBe(200);
      const parsed = dataEnvelope(spec.data).safeParse(reply.json);
      expect(parsed.success, JSON.stringify(parsed.error)).toBe(true);
      expect(reply.json.notice).toBe(DATA_NOTICE);
      expect(reply.headers.get('Cache-Control')).toBe('private, no-store');
      expect(reply.headers.get('Access-Control-Allow-Origin')).toBeNull();
    });
  }

  it('an unknown field in the input is a 400 invalid_input', async () => {
    for (const spec of ENDPOINTS) {
      const input = h.validInput(spec);
      let path = `/api/v1${spec.path}`;
      for (const [name, value] of Object.entries(input)) path = path.replace(`:${name}`, value);
      const url = `${path}${path.includes('?') ? '&' : '?'}surprise=1`;
      const reply = await h.send('GET', url, { key });
      expect(reply.status, `${spec.id}: ${reply.text.slice(0, 200)}`).toBe(400);
      expect(reply.json.error.code).toBe('invalid_input');
    }
  });
});

describe('every endpoint of the registry over MCP', () => {
  for (const spec of ENDPOINTS) {
    it(`${spec.id}: tools/call ${spec.mcpTool} returns the same envelope in content and structuredContent`, async () => {
      const reply = await mcp('tools/call', { name: spec.mcpTool, arguments: h.validInput(spec) });
      expect(reply.status, reply.text.slice(0, 300)).toBe(200);
      const result = reply.json.result;
      expect(result.isError).not.toBe(true);
      const parsed = dataEnvelope(spec.data).safeParse(result.structuredContent);
      expect(parsed.success, JSON.stringify(parsed.error)).toBe(true);
      expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
    });
  }

  it('an unknown field in the arguments is an isError result, not a transport error', async () => {
    for (const spec of ENDPOINTS) {
      const reply = await mcp('tools/call', {
        name: spec.mcpTool,
        arguments: { ...h.validInput(spec), surprise: 1 },
      });
      expect(reply.status).toBe(200);
      expect(reply.json.result.isError, spec.id).toBe(true);
      expect(reply.json.result.structuredContent.error.code).toBe('invalid_input');
    }
  });

  it('tools/call without a key is HTTP 401 with WWW-Authenticate', async () => {
    const reply = await mcp('tools/call', { name: 'get_seasons', arguments: {} }, null);
    expect(reply.status).toBe(401);
    expect(reply.headers.get('WWW-Authenticate')).toBe('Bearer');
  });
});

describe('the published schema and the tool list', () => {
  it('GET /api/v1/schema needs no key, is public, and lists every endpoint like the registry', async () => {
    const reply = await h.send('GET', '/api/v1/schema');
    expect(reply.status).toBe(200);
    expect(reply.headers.get('Cache-Control')).toBe('public, max-age=3600');
    const doc = schemaDocumentSchema.parse(reply.json);
    expect(doc).toEqual(buildSchemaDocument());
    expect(doc.endpoints.map((e) => e.id)).toEqual(ENDPOINTS.map((e) => e.id));
    for (const [index, spec] of ENDPOINTS.entries()) {
      const row = doc.endpoints[index];
      expect(row?.path).toBe(`/api/v1${spec.path}`);
      expect(row?.mcpTool).toBe(spec.mcpTool);
      expect(row?.metered).toBe(spec.metered);
      expect(row?.cacheSeconds).toBe(spec.cacheSeconds);
      expect(row?.input).toBeTypeOf('object');
      expect(row?.data).toBeTypeOf('object');
    }
  });

  it('the schema of an input is strict, and names the path parameters', async () => {
    const doc = buildSchemaDocument();
    for (const row of doc.endpoints) {
      expect(row.input.additionalProperties, row.id).toBe(false);
      const params = [...row.path.matchAll(/:(\w+)/g)].map((m) => m[1] as string);
      const properties = Object.keys((row.input.properties ?? {}) as Record<string, unknown>);
      for (const name of params) expect(properties, `${row.id}:${name}`).toContain(name);
    }
  });

  it('tools/list needs no key and returns exactly the registry tools with equal input schemas', async () => {
    const reply = await mcp('tools/list', {}, null);
    expect(reply.status).toBe(200);
    const tools = reply.json.result.tools as { name: string; description: string; inputSchema: unknown }[];
    expect(tools.map((t) => t.name)).toEqual(ENDPOINTS.map((e) => e.mcpTool));
    const doc = buildSchemaDocument();
    for (const [index, tool] of tools.entries()) {
      expect(tool.inputSchema).toEqual(doc.endpoints[index]?.input);
      expect(tool.description).toContain(DATA_NOTICE);
    }
  });

  it('a request without a key to a keyed route is missing_key', async () => {
    const reply = await h.send('GET', '/api/v1/seasons');
    expect(reply.status).toBe(401);
    expect(reply.json.error.code).toBe('missing_key');
  });
});
