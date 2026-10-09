import type { ApiDeps, NonceResponse, SessionResponse } from '@prix/contracts';
import { CHAIN_ID, SESSION_TTL_SECONDS, SIWE_STATEMENT, verifyInputSchema } from '@prix/contracts';
import type { Hono } from 'hono';
import { failures, json, noContent } from './errors.ts';
import { assertFromSite, enforceLimit, spendDay } from './guard.ts';
import { readInput } from './input.ts';
import { createNonceSigner } from './nonce.ts';
import { clearedSessionCookie, hashToken, newSessionToken, readSessionToken, sessionCookie } from './session.ts';
import { checkSignIn, siweTarget } from './siwe.ts';

/**
 * Sign-In with Ethereum. docs/CONTRACTS.md sections 11 and 15. A wallet is asked for one
 * signature over one message. Nothing here asks for, builds or relays a transaction.
 *
 * The `sign_in` rate limit runs before these handlers, in the app's first middleware.
 */
export function registerSessionRoutes(app: Hono, deps: ApiDeps): void {
  const { store } = deps;
  const target = siweTarget(deps.config.siteOrigin);
  const nonces = createNonceSigner(deps.config.nonceSecret);

  // Issuing a nonce reads nothing and writes nothing. The answer is `no-store`: a nonce that
  // two people received could be used by only one of them.
  app.get('/siwe/nonce', async () => {
    const { nonce, expiresAt } = await nonces.issue(deps.now());
    return json<NonceResponse>(
      { nonce, expiresAt, domain: target.domain, uri: target.origin, chainId: CHAIN_ID, statement: SIWE_STATEMENT },
      200,
      'private',
    );
  });

  app.post('/siwe/verify', async (c) => {
    assertFromSite(deps, c.req.raw);
    // The body shape is the one failure that says what was wrong. Every check after it is 401, with one sentence.
    const input = await readInput(verifyInputSchema, c.req.raw);
    const now = deps.now();
    const nowIso = now.toISOString();

    const signer = await checkSignIn(input.message, input.signature, target, nonces, now, () =>
      enforceLimit(deps, 'sign_in_global', 'all'),
    );
    if (signer === null) throw failures.signInFailed();
    // The day's budget for API writes, just before the first write: a sign-in costs 4 rows.
    await spendDay(deps, 4);
    // Last, and the first write: the nonce is spent. Only a message that carries this server's
    // nonce and the wallet's own signature gets this far, so nobody else can make this write.
    if (!(await store.useNonce(signer.nonce, signer.nonceExpiresAt))) throw failures.signInFailed();

    const token = newSessionToken();
    await store.touchUser(signer.address, nowIso);
    await store.putSession({
      tokenHash: await hashToken(token),
      address: signer.address,
      createdAt: nowIso,
      expiresAt: new Date(now.getTime() + SESSION_TTL_SECONDS * 1000).toISOString(),
    });
    return json<SessionResponse>({ address: signer.address }, 200, 'private', { 'Set-Cookie': sessionCookie(token) });
  });

  app.post('/siwe/logout', async (c) => {
    assertFromSite(deps, c.req.raw);
    const token = readSessionToken(c.req.raw);
    if (token !== null) await store.deleteSession(await hashToken(token));
    return noContent({ 'Set-Cookie': clearedSessionCookie() });
  });
}
