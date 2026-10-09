import type {
  AwardCandidate,
  Division,
  FollowApiDeps,
  ResultRow,
  SeasonResultRow,
  SeasonResultsResponse,
} from '@prix/contracts';
import { RESULTS_PAGE_SIZE, SEASON_RESULTS_CACHE_SECONDS, SEASON_RESULTS_TOP } from '@prix/contracts';
import type { Hono } from 'hono';
import { failures, json } from '../errors.ts';

const SEASON_NUMBER = /^[1-9][0-9]{0,3}$/;
const DIVISIONS: readonly Division[] = ['open', 'pro'];
/** Three pages of 100 cover the 200 agents a division holds. */
const MAX_PAGES = 3;

export function registerResultsRoutes(routes: Hono, deps: FollowApiDeps): void {
  const { records } = deps;

  async function rankedRows(seasonId: string, division: Division): Promise<(SeasonResultRow & { rank: number })[]> {
    const ranked: (SeasonResultRow & { rank: number })[] = [];
    for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber++) {
      const rows = await records.listSeasonResults(
        seasonId,
        division,
        RESULTS_PAGE_SIZE,
        pageNumber * RESULTS_PAGE_SIZE,
      );
      if (rows === null) break;
      const before = ranked.length;
      for (const row of rows) if (row.rank !== null) ranked.push({ ...row, rank: row.rank });
      if (ranked.length === before || rows.length < RESULTS_PAGE_SIZE) break;
    }
    return ranked.sort((a, b) => a.rank - b.rank);
  }

  routes.get('/seasons/:number/results', async (c) => {
    const text = c.req.param('number');
    if (!SEASON_NUMBER.test(text)) throw failures.seasonNotFound();
    const entry = (await records.listSeasonArchive()).find((candidate) => candidate.season.number === Number(text));
    if (entry === undefined) throw failures.seasonNotFound();
    const final = entry.frozenAt !== null;

    const divisions = await Promise.all(
      DIVISIONS.map(async (division) => {
        const rankedCount = entry.rankedCount[division];
        if (!final) return { division, rankedCount, top: [] as ResultRow[], awards: [] };
        const ranked = await rankedRows(entry.season.id, division);
        const candidates: AwardCandidate[] = ranked.map((row) => ({
          rank: row.rank,
          agentId: row.agentId,
          name: row.name,
          seasonReturnBps: row.returnBps,
          maxDrawdownBps: row.maxDrawdownBps,
          tradingDays: row.tradingDays,
        }));
        // The house mark of each row of Phase 2, set there with `isHouseOwner` (docs/CONTRACTS.md section 17.1).
        const house = new Map(ranked.map((row) => [row.agentId, row.house === true]));
        const marked = <T extends { agentId: string }>(entry: T): T & { house: boolean } => ({
          ...entry,
          house: house.get(entry.agentId) === true,
        });
        const top: ResultRow[] = candidates.slice(0, SEASON_RESULTS_TOP).map(marked);
        const awards = deps.awards.computeAwards(division, candidates).map(marked);
        return { division, rankedCount, top, awards };
      }),
    );

    const body: SeasonResultsResponse = { season: entry.season, final, divisions, prize: 'none' };
    const maxAge = final ? SEASON_RESULTS_CACHE_SECONDS : 60;
    return json<SeasonResultsResponse>(body, 200, 'public', { 'Cache-Control': `public, max-age=${maxAge}` });
  });
}
