import type { ApiDeps, HoldsResponse, SessionRecord } from '@prix/contracts';
import { idSchema, SCORING_METHOD, setHiddenInputSchema, symbolSchema } from '@prix/contracts';
import type { Hono } from 'hono';
import { failures, json, noContent } from './errors.ts';
import { requireSession, requireWriter } from './guard.ts';
import { matches, readInput } from './input.ts';
import { currentSeason } from './views.ts';

/**
 * The admin routes. An admin is a wallet whose address is in `config.adminAddresses`, checked
 * on the server on every request. Nothing a client sends can make a wallet an admin.
 */
export function registerAdminRoutes(app: Hono, deps: ApiDeps, admins: ReadonlySet<string>): void {
  const { store } = deps;

  function requireAdmin(session: SessionRecord): SessionRecord {
    if (!admins.has(session.address)) throw failures.notAdmin();
    return session;
  }

  /** Who did what to what. An address, an action name and an id or a symbol: nothing private. */
  function audit(session: SessionRecord, action: string, target: string): void {
    console.log(JSON.stringify({ event: 'admin_action', admin: session.address, action, target }));
  }

  app.post('/admin/agents/:id/hidden', async (c) => {
    const session = requireAdmin(await requireWriter(deps, c.req.raw, 2));
    const id = c.req.param('id');
    if (!matches(idSchema, id)) throw failures.agentNotFound();
    const input = await readInput(setHiddenInputSchema, c.req.raw);
    const agent = await store.getAgent(id);
    if (agent === null) throw failures.agentNotFound();

    const now = deps.now().toISOString();
    // Hidden is its own flag. This route sets it and nothing else: not the status, not the pause
    // reason, not the key. A hidden agent is not scheduled and not shown, and unhiding it gives
    // back exactly the agent it was.
    if (agent.hidden !== input.hidden) {
      if ((await store.updateAgent(agent.id, { hidden: input.hidden }, now)) === 'not_found') {
        throw failures.agentNotFound();
      }
      audit(session, input.hidden ? 'hide_agent' : 'unhide_agent', agent.id);
    }

    // Publish the table again at the tick it stands at, so a hidden agent leaves it at once and
    // the ranks below close up. It runs even when the flag was already set, so a second request
    // repairs a table whose first ranking failed. Before the division's first ranking there is
    // nothing to redo.
    const season = await currentSeason(store, now);
    const state = season === null ? null : await store.getLeagueState(season.id, agent.division);
    if (state !== null) await store.rerank(state.seasonId, agent.division, state.tickId, now, SCORING_METHOD);
    return noContent();
  });

  app.get('/admin/holds', async (c) => {
    requireAdmin(await requireSession(deps, c.req.raw));
    return json<HoldsResponse>({ holds: await store.listSymbolHolds() }, 200, 'private');
  });

  app.post('/admin/holds/:symbol/release', async (c) => {
    const session = requireAdmin(await requireWriter(deps, c.req.raw, 2));
    const symbol = c.req.param('symbol');
    if (!matches(symbolSchema, symbol)) throw failures.holdNotFound();
    // The row stays, marked as released. At the next tick the scheduler takes the feed's price
    // for the symbol without comparing it, then deletes the row. False for a symbol that is not
    // held or was released before.
    if (!(await store.releaseSymbolHold(symbol, deps.now().toISOString()))) throw failures.holdNotFound();
    audit(session, 'release_hold', symbol);
    return noContent();
  });
}
