import type { ApiError, FollowApiDeps, FollowResponse, FollowsResponse } from '@prix/contracts';
import { idSchema, MAX_FOLLOWS_PER_WALLET, putFollowInputSchema } from '@prix/contracts';
import type { Hono } from 'hono';
import { ApiFailure, failures, json, noContent } from '../errors.ts';
import { requireSession, requireWriter } from '../guard.ts';
import { matches, readInput } from '../input.ts';

/** A follow row, an index entry and a count row: what one change may write, for the day's budget. */
const FOLLOW_WRITE_ROWS = 3;

export function registerFollowRoutes(routes: Hono, deps: FollowApiDeps): void {
  routes.get('/follows', async (c) => {
    const session = await requireSession(deps, c.req.raw);
    const follows = await deps.follow.listFollows(session.address);
    return json<FollowsResponse>({ follows, limit: MAX_FOLLOWS_PER_WALLET }, 200, 'private');
  });

  routes.put('/follows/:agentId', async (c) => {
    const agentId = c.req.param('agentId');
    if (!matches(idSchema, agentId)) throw failures.agentNotFound();
    const session = await requireWriter(deps, c.req.raw, FOLLOW_WRITE_ROWS);
    const input = await readInput(putFollowInputSchema, c.req.raw);
    const now = deps.now().toISOString();
    const result = await deps.follow.putFollow(session.address, agentId, input.notify, now, MAX_FOLLOWS_PER_WALLET);
    if (result === 'agent_unavailable') throw failures.agentNotFound();
    if (result === 'own_agent') {
      throw new ApiFailure(
        'forbidden',
        'An agent cannot be followed by the wallet that owns it. Follow another agent.',
      );
    }
    if (result === 'follow_limit_reached') {
      // The contract wants 409 with code invalid_input, and `errorResponse` maps that code to 400, so the answer is built here.
      const body: ApiError = {
        error: {
          code: 'invalid_input',
          message: `This wallet already follows ${MAX_FOLLOWS_PER_WALLET} agents, which is the most it may. Unfollow one, then follow this agent.`,
          field: 'follows',
        },
      };
      return json<ApiError>(body, 409, 'private');
    }
    const follow = (await deps.follow.listFollows(session.address)).find((entry) => entry.agentId === agentId);
    if (follow === undefined) throw failures.internal();
    return json<FollowResponse>({ follow }, result === 'created' ? 201 : 200, 'private');
  });

  routes.delete('/follows/:agentId', async (c) => {
    const agentId = c.req.param('agentId');
    if (!matches(idSchema, agentId)) throw failures.agentNotFound();
    const session = await requireWriter(deps, c.req.raw, FOLLOW_WRITE_ROWS);
    await deps.follow.deleteFollow(session.address, agentId);
    return noContent();
  });
}
