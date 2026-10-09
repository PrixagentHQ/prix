import type {
  SocialApiDeps,
  WarDay,
  WarDetailResponse,
  WarEntrant,
  WarListResponse,
  WarRecord,
  WarRow,
  WarSlot,
} from '@prix/contracts';
import {
  createWarInputSchema,
  idSchema,
  newId,
  SOCIAL_PAGE_SIZE,
  socialPageQuerySchema,
  WAR_CREATE_WRITE_ROWS,
  WAR_DEADLINE_DAYS_PER_TRADING_DAY,
  WAR_MAX_OUTPUT_TOKENS,
  WAR_RULES,
  warModelOf,
  warSlotSchema,
} from '@prix/contracts';
import { UNIVERSE } from '@prix/market';
import type { Hono } from 'hono';
import { failures, json, noContent } from '../errors.ts';
import { requireWriter } from '../guard.ts';
import { matches, readInput, readQuery } from '../input.ts';
import { addDays, adminOr404, audit, conflict, dayOf, socialFailures } from './shared.ts';

/** Rows a stop costs against the day's API writes: the war row and its index row. */
const WAR_STOP_WRITE_ROWS = 2;

async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  let hex = '';
  for (const byte of digest) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/** An entrant as the public sees it: no portfolio, stats or count of rejected days. */
function entrantPublic(entrant: WarEntrant): WarDetailResponse['entrants'][number] {
  return {
    warId: entrant.warId,
    slot: entrant.slot,
    modelId: entrant.modelId,
    provider: entrant.provider,
    maker: entrant.maker,
    family: entrant.family,
    label: entrant.label,
    extra: entrant.extra,
    maxOutputTokens: entrant.maxOutputTokens,
    inputNeuronsPerMillion: entrant.inputNeuronsPerMillion,
    outputNeuronsPerMillion: entrant.outputNeuronsPerMillion,
    pricesReadOn: entrant.pricesReadOn,
    probedOn: entrant.probedOn,
    lastTickId: entrant.lastTickId,
    days: entrant.days,
  };
}

/** A war row as stored is already the parsed record; it is copied field by field all the same. */
function rowPublic(row: WarRow): WarRow {
  return {
    warId: row.warId,
    slot: row.slot,
    tickId: row.tickId,
    status: row.status,
    code: row.code,
    targetsBps: row.targetsBps,
    reason: row.reason,
    fills: row.fills,
    halted: row.halted,
    portfolio: row.portfolio,
    equityMicro: row.equityMicro,
    costMicro: row.costMicro,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    neurons: row.neurons,
    createdAt: row.createdAt,
  };
}

function warPublic(war: WarRecord): WarRecord {
  return {
    id: war.id,
    number: war.number,
    title: war.title,
    status: war.status,
    stopReason: war.stopReason,
    strategy: war.strategy,
    strategySha256: war.strategySha256,
    systemMessageSha256: war.systemMessageSha256,
    promptVersion: war.promptVersion,
    rules: war.rules,
    startsOn: war.startsOn,
    tradingDays: war.tradingDays,
    deadlineDay: war.deadlineDay,
    method: war.method,
    createdAt: war.createdAt,
    firstTickId: war.firstTickId,
    lastTickId: war.lastTickId,
    endedAt: war.endedAt,
  };
}

/** Every war-day's tick with the prices of the war's universe, so the accounting can be replayed. */
async function warDays(deps: SocialApiDeps, war: WarRecord, rows: readonly WarRow[]): Promise<WarDay[]> {
  const tickIds = [...new Set(rows.map((row) => row.tickId))].sort();
  const universe = new Set(war.rules.universe);
  const ticks = await Promise.all(tickIds.map((id) => deps.store.getTick(id)));
  const days: WarDay[] = [];
  for (const tick of ticks) {
    if (tick === null) continue;
    const pricesMicro: Record<string, number> = {};
    const halted: string[] = [];
    for (const point of tick.snapshot.prices) {
      if (!universe.has(point.symbol)) continue;
      pricesMicro[point.symbol] = point.priceMicro;
      if (!point.fresh) halted.push(point.symbol);
    }
    days.push({ tickId: tick.id, takenAt: tick.snapshot.takenAt, pricesMicro, halted });
  }
  return days;
}

async function detailOf(
  deps: SocialApiDeps,
  war: WarRecord,
  entrants: readonly WarEntrant[],
  rows: readonly WarRow[],
): Promise<WarDetailResponse> {
  const standings = deps.warStandings.standings(
    entrants.map((entrant) => ({ entrant, rows: rows.filter((row) => row.slot === entrant.slot) })),
    war.status === 'complete',
  );
  return {
    war: warPublic(war),
    entrants: entrants.map(entrantPublic),
    standings,
    days: await warDays(deps, war, rows),
    rows: rows.map(rowPublic),
  };
}

/** Model Wars, the public reads. Section 5.3. */
export function registerWarRoutes(app: Hono, deps: SocialApiDeps): void {
  const { social } = deps;

  app.get('/social/wars', async (c) => {
    const { page } = readQuery(socialPageQuerySchema, c.req.url);
    const wars = await social.listWars(SOCIAL_PAGE_SIZE + 1, (page - 1) * SOCIAL_PAGE_SIZE);
    const shown = wars.slice(0, SOCIAL_PAGE_SIZE);
    // One read of entrants per war. Wars are curated, one at a time, so a page holds few of them.
    const entrants = await Promise.all(shown.map((war) => social.listWarEntrants(war.id)));
    return json<WarListResponse>(
      {
        page,
        hasMore: wars.length > SOCIAL_PAGE_SIZE,
        wars: shown.map((war, index) => {
          const list = entrants[index] ?? [];
          return {
            id: war.id,
            number: war.number,
            title: war.title,
            status: war.status,
            startsOn: war.startsOn,
            tradingDays: war.tradingDays,
            daysDone: list.reduce((most, entrant) => Math.max(most, entrant.days), 0),
            entrants: list.map((entrant) => ({
              slot: entrant.slot,
              modelId: entrant.modelId,
              label: entrant.label,
              maker: entrant.maker,
            })),
          };
        }),
      },
      200,
      'public',
    );
  });

  app.get('/social/wars/:id', async (c) => {
    const id = c.req.param('id');
    if (!matches(idSchema, id)) throw socialFailures.warNotFound();
    const war = await social.getWar(id);
    if (war === null) throw socialFailures.warNotFound();
    const [entrants, rows] = await Promise.all([social.listWarEntrants(war.id), social.listWarRows(war.id)]);
    return json<WarDetailResponse>(await detailOf(deps, war, entrants, rows), 200, 'public');
  });
}

/** Model Wars, the admin routes. Mounted whatever the switch says; anyone but an admin gets the generic 404. */
export function registerWarAdminRoutes(app: Hono, deps: SocialApiDeps): void {
  const { social, sim, scoring } = deps;

  app.post('/social/admin/wars', async (c) => {
    const admin = await adminOr404(deps, c.req.raw);
    await requireWriter(deps, c.req.raw, WAR_CREATE_WRITE_ROWS);
    const input = await readInput(createWarInputSchema, c.req.raw);
    const at = deps.now();
    const now = at.toISOString();
    if (input.startsOn < dayOf(now)) {
      throw failures.invalidInput('A paper experiment starts today or later. Choose another day.', 'startsOn');
    }
    const models = input.models.map((id) => warModelOf(id));
    // The schema admits only probed models; the server checks again, and refuses Groq without its key.
    for (const model of models) {
      if (model === null || model.probe === null) {
        throw failures.invalidInput('Choose models that passed the probe.', 'models');
      }
      if (model.provider === 'groq' && !deps.groqConfigured) {
        throw failures.invalidInput('Groq is not configured on this server. Choose Workers AI models.', 'models');
      }
    }
    if ((await social.getOpenWar()) !== null) {
      return conflict('A paper experiment is already scheduled or running. Stop it or wait for it to end.', 'wars');
    }

    const id = newId();
    const war: Omit<WarRecord, 'number'> = {
      id,
      title: input.title,
      status: 'scheduled',
      stopReason: null,
      strategy: input.strategy,
      strategySha256: await sha256Hex(input.strategy),
      systemMessageSha256: null,
      promptVersion: null,
      rules: { ...WAR_RULES, universe: UNIVERSE.map((token) => token.symbol) },
      startsOn: input.startsOn,
      tradingDays: input.tradingDays,
      deadlineDay: addDays(input.startsOn, WAR_DEADLINE_DAYS_PER_TRADING_DAY * input.tradingDays),
      method: 'v1',
      createdAt: now,
      firstTickId: null,
      lastTickId: null,
      endedAt: null,
    };
    const entrants: WarEntrant[] = [];
    models.forEach((model, index) => {
      if (model === null || model.probe === null) return;
      entrants.push({
        warId: id,
        slot: warSlotSchema.options[index] as WarSlot,
        modelId: model.id,
        provider: model.provider,
        maker: model.maker,
        family: model.family,
        label: model.label,
        extra: { ...model.extra },
        maxOutputTokens: WAR_MAX_OUTPUT_TOKENS,
        inputNeuronsPerMillion: model.inputNeuronsPerMillion,
        outputNeuronsPerMillion: model.outputNeuronsPerMillion,
        pricesReadOn: model.pricesReadOn,
        probedOn: model.probe.on,
        portfolio: sim.newPortfolio(),
        stats: scoring.initialStats(),
        lastTickId: null,
        days: 0,
        rejectedDays: 0,
      });
    });
    const outcome = await social.createWar(war, entrants);
    if (outcome.result === 'war_open') {
      return conflict('A paper experiment is already scheduled or running. Stop it or wait for it to end.', 'wars');
    }
    audit(admin, 'create_war', id);
    return json<WarDetailResponse>(
      await detailOf(deps, { ...war, number: outcome.number }, entrants, []),
      201,
      'private',
    );
  });

  app.post('/social/admin/wars/:id/stop', async (c) => {
    const admin = await adminOr404(deps, c.req.raw);
    await requireWriter(deps, c.req.raw, WAR_STOP_WRITE_ROWS);
    const id = c.req.param('id');
    if (!matches(idSchema, id)) throw socialFailures.warNotFound();
    const war = await social.getWar(id);
    if (war === null) throw socialFailures.warNotFound();
    // A war that has ended stays as it ended; stopping it again changes nothing.
    if (war.status === 'scheduled' || war.status === 'running') {
      const now = deps.now().toISOString();
      await social.updateWar(id, { status: 'stopped', stopReason: 'admin', endedAt: now }, now);
      audit(admin, 'stop_war', id);
    }
    return noContent();
  });
}
