import { env } from 'cloudflare:workers';
import type { ApiContext, Transport } from './api.ts';
import { serverRequest } from './server-request.ts';

/**
 * The server half of src/lib/api.ts: a call through the `API` service binding.
 * Only api.ts imports this file, and only on the server. A page never does.
 *
 * A call is built from nothing by `serverRequest` (src/lib/server-request.ts), which says what it
 * carries from the visitor's own request: the cookie, the connecting address, the Origin of a write,
 * and the country Cloudflare itself read (docs/CONTRACTS.md sections 15 and 24.3). No other header of
 * the visitor travels.
 */
export function createServerTransport(context: ApiContext): Transport {
  return (call) => env.API.fetch(serverRequest(context.request, context.url.origin, call));
}
