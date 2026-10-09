import { formatAddress } from '../content/format.ts';
import { type ApiContext, createApi } from './api.ts';
import { PRIVATE_CACHE_CONTROL, readSessionCookie } from './session.ts';

/** What the shared layout shows for a signed-in wallet: the `account` prop of design/Layout.astro. */
export interface PageAccount {
  /** The address, shortened for the masthead. */
  short: string;
  address: string;
  isAdmin: boolean;
}

/** What `readAccount` needs. The Astro global fits. */
export interface AccountContext extends ApiContext {
  response: { headers: Headers };
}

const FIXTURES = typeof __PRIX_FIXTURES__ !== 'undefined' && __PRIX_FIXTURES__;

/**
 * The signed-in wallet for the masthead, or null. Every page calls it once and passes the
 * result to the layout: `<Layout account={await readAccount(Astro)} ...>`.
 *
 * A request without the session cookie costs no API call, and its page is the same for
 * everyone. So does a request whose cookie cannot be a session token: the API would refuse
 * it, so it is not asked. A request with the cookie is answered for that person only, so its
 * page is `private, no-store` (docs/CONTRACTS.md section 15).
 *
 * That header is set in two places. src/middleware.ts sets it on every response to a request
 * that carries the cookie, and that is the one that counts: Astro copies the headers of a
 * page when the route file has run, so a header set here by a component that has already
 * awaited something arrives too late. It is set here as well so that a page rendered without
 * the middleware is still marked.
 *
 * The answer is null whenever the API does not confirm the session: signed out, expired, or
 * the API could not be reached. The masthead then offers "Sign in".
 *
 * This only decides what the masthead shows. It grants nothing: every protected action is
 * checked by the API against the session.
 */
export async function readAccount(context: AccountContext): Promise<PageAccount | null> {
  if (!FIXTURES) {
    const cookie = readSessionCookie(context.request);
    if (!cookie.present) return null;
    context.response.headers.set('Cache-Control', PRIVATE_CACHE_CONTROL);
    if (!cookie.wellFormed) return null;
  }
  // A read is made once per request, so a page that also asks for `me()` shares this call.
  const me = await createApi(context).me();
  if (!me.ok) return null;
  const { address, isAdmin } = me.data;
  return { address, isAdmin, short: formatAddress(address) };
}
