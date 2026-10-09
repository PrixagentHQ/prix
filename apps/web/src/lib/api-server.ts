import { env } from 'cloudflare:workers';
import type { ApiContext, Transport } from './api.ts';

/**
 * The server half of src/lib/api.ts: a call through the `API` service binding.
 * Only api.ts imports this file, and only on the server. A page never does.
 *
 * A call is built from nothing and carries four things from the visitor's own request, as
 * the visitor sent them (docs/CONTRACTS.md section 15):
 *
 * - `Cookie`, whole. The API reads the session from it with its own parser, so the site and
 *   the API can never disagree about which session a request carries.
 * - `CF-Connecting-IP`. Cloudflare sets it on the visitor's request, and the API counts its
 *   rate limits by it. Without it the API refuses, which is the safe side.
 * - `Origin`, on a request that changes state. The API accepts such a request only from the
 *   site's own origin. The header is passed on and never made up here: a write that some other
 *   site caused, or one attempted while rendering an ordinary page view, reaches the API
 *   without the right origin and is refused.
 *
 * No other header of the visitor travels.
 */
export function createServerTransport(context: ApiContext): Transport {
  return (call) => {
    const visitor = context.request.headers;
    const headers = new Headers({ accept: 'application/json' });
    const cookie = visitor.get('cookie');
    if (cookie) headers.set('cookie', cookie);
    const address = visitor.get('cf-connecting-ip');
    if (address) headers.set('cf-connecting-ip', address);
    if (call.method !== 'GET') {
      // The API requires this of every request that changes state, with or without a body.
      headers.set('content-type', 'application/json');
      const origin = visitor.get('origin');
      if (origin) headers.set('origin', origin);
    }
    const request = new Request(new URL(call.path, context.url.origin), {
      method: call.method,
      headers,
      body: call.body === undefined ? undefined : JSON.stringify(call.body),
    });
    return env.API.fetch(request);
  };
}
