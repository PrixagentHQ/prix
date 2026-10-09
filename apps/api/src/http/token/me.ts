import type { ApiDeps, TokenApiDeps, TokenMeResponse } from '@prix/contracts';
import type { Hono } from 'hono';
import { failures, json } from '../errors.ts';
import { requireSession, requireWriter } from '../guard.ts';

/**
 * The signed-in wallet's tier. The address is the session's and nothing else: no field, header
 * or cookie other than the session cookie reaches the service.
 */
export function registerTokenMeRoutes(app: Hono, deps: ApiDeps & { token: TokenApiDeps }): void {
  const { service } = deps.token;

  app.get('/token/me', async (c) => {
    const session = await requireSession(deps, c.req.raw);
    const status = await service.statusOf(session.address, false);
    // `too_soon` only answers a refresh.
    if (status === 'too_soon') throw failures.internal();
    return json<TokenMeResponse>(status, 200, 'private');
  });

  app.post('/token/refresh', async (c) => {
    // A refresh stores one holder row, which the index writes twice.
    const session = await requireWriter(deps, c.req.raw, 2);
    const status = await service.statusOf(session.address, true);
    if (status === 'too_soon') throw failures.rateLimited(30);
    return json<TokenMeResponse>(status, 200, 'private');
  });
}
