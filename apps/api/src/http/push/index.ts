import type { PushApiDeps } from '@prix/contracts';
import { MAX_PUSH_SUBSCRIPTIONS_PER_WALLET, pushSubscriptionInputSchema } from '@prix/contracts';
import { Hono } from 'hono';
import { ApiFailure, json, noContent } from '../errors.ts';
import { requireWriter } from '../guard.ts';
import { readInput } from '../input.ts';

/** A row, an index entry and at most one replaced row: what one change may write, for the day's budget. */
const PUSH_WRITE_ROWS = 4;

const notConfigured = () => new ApiFailure('not_found', 'Browser notes are not available yet. Check back later.');

/**
 * The browser push routes, with the `/api` prefix removed. No route returns an endpoint.
 * The writes go through `requireWriter`: the same origin check, session, wallet and daily budgets as every other write.
 */
export function createPushRoutes(deps: PushApiDeps): Hono {
  const routes = new Hono();
  const configured = deps.vapidPublicKey !== null && deps.vapidPublicKey !== '';

  routes.get('/push/key', () => {
    if (!configured) throw notConfigured();
    return json({ key: deps.vapidPublicKey }, 200, 'private');
  });

  routes.post('/push/subscriptions', async (c) => {
    if (!configured) throw notConfigured();
    const session = await requireWriter(deps, c.req.raw, PUSH_WRITE_ROWS);
    const input = await readInput(pushSubscriptionInputSchema, c.req.raw);
    await deps.push.addSubscription(
      session.address,
      input.endpoint,
      deps.now().toISOString(),
      MAX_PUSH_SUBSCRIPTIONS_PER_WALLET,
    );
    return json({ subscribed: true }, 201, 'private');
  });

  routes.delete('/push/subscriptions', async (c) => {
    const session = await requireWriter(deps, c.req.raw, PUSH_WRITE_ROWS);
    const input = await readInput(pushSubscriptionInputSchema, c.req.raw);
    await deps.push.removeSubscription(session.address, input.endpoint);
    return noContent();
  });

  return routes;
}
