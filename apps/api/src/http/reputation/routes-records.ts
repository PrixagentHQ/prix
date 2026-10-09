import type { ArchiveResponse, ReputationApiDeps, ResultsResponse, TrackRecordResponse } from '@prix/contracts';
import { idSchema, RESULTS_PAGE_SIZE, resultsQuerySchema } from '@prix/contracts';
import type { Hono } from 'hono';
import { failures, json } from '../errors.ts';
import { matches, readQuery } from '../input.ts';

/** The public season reads. Cached 30 seconds; the results of a frozen season for an hour. */
export function registerRecordRoutes(app: Hono, deps: ReputationApiDeps): void {
  const { reputation } = deps;

  app.get('/seasons', async () => {
    const seasons = await reputation.listSeasonArchive();
    return json<ArchiveResponse>({ seasons }, 200, 'public');
  });

  app.get('/seasons/:id/results', async (c) => {
    const id = c.req.param('id');
    if (!matches(idSchema, id)) throw failures.seasonNotFound();
    const query = readQuery(resultsQuerySchema, c.req.url);
    const entry = await reputation.getSeasonArchiveEntry(id);
    if (entry === null) throw failures.seasonNotFound();
    const rows = await reputation.listSeasonResults(
      id,
      query.division,
      RESULTS_PAGE_SIZE + 1,
      (query.page - 1) * RESULTS_PAGE_SIZE,
    );
    if (rows === null) throw failures.seasonNotFound();
    const body: ResultsResponse = {
      entry,
      division: query.division,
      rows: rows.slice(0, RESULTS_PAGE_SIZE),
      page: query.page,
      hasMore: rows.length > RESULTS_PAGE_SIZE,
      estimated: query.division === 'chain',
    };
    return json(body, 200, 'public', {
      'Cache-Control': entry.frozenAt === null ? 'public, max-age=30' : 'public, max-age=3600',
    });
  });

  app.get('/agents/:id/record', async (c) => {
    const id = c.req.param('id');
    if (!matches(idSchema, id)) throw failures.agentNotFound();
    const record = await reputation.getTrackRecord(id);
    if (record === null) throw failures.agentNotFound();
    return json<TrackRecordResponse>({ record }, 200, 'public');
  });
}
