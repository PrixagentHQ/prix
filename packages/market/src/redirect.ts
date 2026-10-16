/**
 * No chain read of this package follows a redirect. Every request is sent with `redirect: 'manual'`,
 * so a 3xx comes back as it is: one request and a failure of that endpoint, never a request to the
 * host it points at. Followed, every hop of a redirect chain would be one more subrequest of the
 * Worker's invocation ("Each subrequest in a redirect chain counts against this limit",
 * https://developers.cloudflare.com/workers/platform/limits/, read 2026-10-09; "If set to manual, the
 * 3xx redirect response will be returned to the caller as-is",
 * https://developers.cloudflare.com/workers/runtime-apis/request/, read 2026-10-09), and a listed host
 * could hand the question, and the answer, to a host that is not on the list.
 *
 * The snapshot's reads (`ethCall` in `./chain.ts`) and `createRpc` refuse every status but 200, so
 * they need only the option. This file is for the readers that look at an answer whatever its status.
 */

/**
 * True for a redirect that was not followed: a 3xx, or status 0 where a runtime hides the status of
 * one (an `opaqueredirect` response; a Worker returns the 3xx as it is). Its body is not an answer
 * and is never read. Pure.
 */
export function isRedirect(response: Pick<Response, 'status'>): boolean {
  return response.status === 0 || (response.status >= 300 && response.status < 400);
}

/** Thrown by a `fetch` of `withoutRedirects` when the endpoint answered with a redirect. Carries no URL. */
export class RedirectRefusedError extends Error {
  constructor() {
    super('The endpoint answered with a redirect.');
    this.name = 'RedirectRefusedError';
  }
}

/**
 * A `fetch` that sends every request with `redirect: 'manual'`, whatever the caller's options say,
 * and throws `RedirectRefusedError` when the answer is a redirect, with its body released unread. For
 * a client that builds its own requests and reads the body of an answer before it looks at the status
 * (viem's HTTP transport). The request is otherwise sent as given.
 */
export function withoutRedirects(fetchFn: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const response = await fetchFn(input, { ...init, redirect: 'manual' });
    if (!isRedirect(response)) return response;
    await response.body?.cancel().catch(() => undefined);
    throw new RedirectRefusedError();
  };
}
