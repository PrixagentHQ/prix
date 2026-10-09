import type { ApiApp, DataDeps } from '@prix/contracts';
import { Hono } from 'hono';
import { assertBodyDeclaredSmall, clientSubject } from '../guard.ts';
import { createDataCache } from './cache.ts';
import { dataErrorResponse, dataFailures, toDataFailure } from './errors.ts';
import { createDataHandlers } from './handlers.ts';
import { createAuthenticator } from './keys.ts';
import { createDataMeter } from './meter.ts';
import { createPaymentService } from './payments.ts';
import { registerDataAccountRoutes } from './routes-account.ts';
import { registerV1Routes } from './routes-v1.ts';
import { createEndpointRunner } from './run.ts';

/** True for /api/v1 and /api/data and everything under them. */
export function isDataPath(pathname: string): boolean {
  return (
    pathname === '/api/v1' ||
    pathname.startsWith('/api/v1/') ||
    pathname === '/api/data' ||
    pathname.startsWith('/api/data/')
  );
}

/**
 * The keyed read API, the key and payment routes of the site, and MCP. docs/contracts/phase-5-data.md
 * section 3. Switched off, every route answers 404 like an unknown one. No CORS header is sent.
 */
export function createDataApp(deps: DataDeps): ApiApp {
  const authenticator = createAuthenticator(deps);
  const meter = createDataMeter(deps);
  const cache = createDataCache();
  const handlers = createDataHandlers(deps);
  const runner = createEndpointRunner(deps, { handlers, meter, cache });
  const payments = createPaymentService(deps);

  const app = new Hono();

  app.use('*', async (c, next) => {
    if (!deps.config.enabled) throw dataFailures.notFound();
    if (!(await deps.rateLimiter.allow('read', clientSubject(c.req.raw)))) throw dataFailures.rateLimited();
    assertBodyDeclaredSmall(c.req.raw);
    await next();
  });

  registerV1Routes(app, deps, { authenticator, runner });
  registerDataAccountRoutes(app, deps, { runner, payments });

  app.notFound(() => dataErrorResponse(dataFailures.notFound()));
  app.onError((error) => dataErrorResponse(toDataFailure(error), deps.now()));

  return { fetch: async (request) => app.fetch(request) };
}
