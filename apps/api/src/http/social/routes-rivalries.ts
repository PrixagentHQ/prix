import type { RivalriesResponse, RivalryDetailResponse, SocialApiDeps } from '@prix/contracts';
import {
  RIVALRY_EVENTS_SHOWN,
  rivalriesQuerySchema,
  rivalryIdSchema,
  SCORING_METHOD,
  SOCIAL_PAGE_SIZE,
  seasonMethodSchema,
} from '@prix/contracts';
import type { Hono } from 'hono';
import { json } from '../errors.ts';
import { matches, readQuery } from '../input.ts';
import { currentSeason } from '../views.ts';
import { rivalryPublicOf } from './rivalry-views.ts';
import { socialFailures } from './shared.ts';

/** The method the rivalries of a season were taped under, so the page can word the ranks. */
async function methodOf(deps: SocialApiDeps, seasonId: string | null) {
  if (seasonId === null) return seasonMethodSchema.parse(SCORING_METHOD);
  return (await deps.reputation.getSeasonMethod(seasonId)).method;
}

/** Rivalries: facts from the rank tape. They take no input but a division and a page. Section 5.4. */
export function registerRivalryRoutes(app: Hono, deps: SocialApiDeps): void {
  const { store, social } = deps;

  app.get('/social/rivalries', async (c) => {
    const { division, page } = readQuery(rivalriesQuerySchema, c.req.url);
    const season = await currentSeason(store, deps.now().toISOString());
    if (season === null) {
      return json<RivalriesResponse>(
        {
          seasonId: null,
          division,
          method: await methodOf(deps, null),
          tapedDays: 0,
          page,
          hasMore: false,
          rivalries: [],
        },
        200,
        'public',
      );
    }
    const [method, tapedDays, views] = await Promise.all([
      methodOf(deps, season.id),
      social.countTapeDays(season.id, division),
      social.listRivalries(season.id, division, SOCIAL_PAGE_SIZE + 1, (page - 1) * SOCIAL_PAGE_SIZE),
    ]);
    return json<RivalriesResponse>(
      {
        seasonId: season.id,
        division,
        method,
        tapedDays,
        page,
        hasMore: views.length > SOCIAL_PAGE_SIZE,
        rivalries: views
          .slice(0, SOCIAL_PAGE_SIZE)
          .filter((view) => !view.agentA.hidden && !view.agentB.hidden)
          .map((view) => rivalryPublicOf(deps, view)),
      },
      200,
      'public',
    );
  });

  app.get('/social/rivalries/:id', async (c) => {
    const id = c.req.param('id');
    if (!matches(rivalryIdSchema, id)) throw socialFailures.rivalryNotFound();
    const [seasonId = '', agentA = '', agentB = ''] = id.split('-');
    // The lower agent id comes first; any other spelling names no rivalry.
    if (!(agentA < agentB)) throw socialFailures.rivalryNotFound();
    const found = await social.getRivalry(seasonId, agentA, agentB, RIVALRY_EVENTS_SHOWN);
    if (found === null || found.view.agentA.hidden || found.view.agentB.hidden) throw socialFailures.rivalryNotFound();
    const { view, events } = found;
    return json<RivalryDetailResponse>(
      {
        rivalry: rivalryPublicOf(deps, view),
        method: await methodOf(deps, seasonId),
        series: view.rivalry.series,
        events: events.slice(0, RIVALRY_EVENTS_SHOWN).map((event) => ({
          seasonId: event.seasonId,
          agentA: event.agentA,
          agentB: event.agentB,
          day: event.day,
          seq: event.seq,
          kind: event.kind,
          subject: event.subject,
          rankA: event.rankA,
          rankB: event.rankB,
          detail: event.detail,
        })),
      },
      200,
      'public',
    );
  });
}
