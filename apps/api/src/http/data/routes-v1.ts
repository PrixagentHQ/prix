import type { Authenticator, DataDeps, EndpointResult, EndpointRunner } from '@prix/contracts';
import { DATA_ENDPOINTS } from '@prix/contracts';
import type { Hono } from 'hono';
import { dataFailures } from './errors.ts';
import { handleMcp } from './mcp.ts';
import { schemaDocument } from './schema-doc.ts';

/** Success headers of a keyed answer. Never cached by a browser or a proxy. */
export function successResponse(result: EndpointResult, cacheControl = 'private, no-store'): Response {
  return new Response(JSON.stringify(result.body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      ...result.headers,
      'Cache-Control': cacheControl,
    },
  });
}

/** Path parameters and query together. A `key` in the query string is dropped unread. */
function inputOf(request: Request, params: Record<string, string>): Record<string, string> {
  const input: Record<string, string> = {};
  for (const [name, value] of new URL(request.url).searchParams) {
    if (name === 'key') continue;
    if (Object.hasOwn(input, name)) throw dataFailures.invalid('A query parameter appears twice. Send each once.');
    input[name] = value;
  }
  return { ...input, ...params };
}

export function registerV1Routes(
  app: Hono,
  deps: DataDeps,
  parts: { authenticator: Authenticator; runner: EndpointRunner },
): void {
  app.get('/api/v1/schema', () => {
    return new Response(JSON.stringify(schemaDocument), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  });

  app.all('/api/v1/mcp', (c) => handleMcp(c.req.raw, deps, parts));

  for (const spec of DATA_ENDPOINTS) {
    app.get(`/api/v1${spec.path}`, async (c) => {
      // The key first (a missing key costs no D1 call), then the input, then the meter.
      const caller = await parts.authenticator.authenticate(c.req.raw);
      const result = await parts.runner.run(spec.id, inputOf(c.req.raw, c.req.param()), caller);
      return successResponse(result);
    });
  }
}
