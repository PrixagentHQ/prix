import type { ApiDeps, TokenApiDeps, TokenInfoResponse } from '@prix/contracts';
import type { Hono } from 'hono';
import { json } from '../errors.ts';

/** GET /api/token: public, from the service's configuration only. Nothing in the request is read. */
export function registerTokenPublicRoutes(app: Hono, deps: ApiDeps & { token: TokenApiDeps }): void {
  const { service } = deps.token;
  app.get('/token', async () => json<TokenInfoResponse>(await service.info(), 200, 'public'));
}
