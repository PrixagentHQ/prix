import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type {
  ModelRequest,
  ModelResponse,
  ReputationStore,
  Season,
  SeasonMethod,
  SocialJobDeps,
  SocialStore,
  Store,
  WarModelDeps,
} from '@prix/contracts';
import { scoring } from '@prix/reputation';
import { strategyDna } from '@prix/reputation/dna';
import { rivalryEngine } from '@prix/reputation/rivalry';
import { scoringV2 } from '@prix/reputation/v2';
import { sim } from '@prix/sim';
import { createManagerEngine } from '@prix/sim/manager';
import { createD1Store } from '../../../apps/api/src/store/index.ts';
import { createReputationStore } from '../../../apps/api/src/store/reputation.ts';
import { createSocialStore } from '../../../apps/api/src/store/social.ts';
import { SEASON_1 } from '../../support/fixtures.ts';

/**
 * What the Phase 6 tests in the Workers runtime share: the local D1 database with the real migrations,
 * a wrapper that counts every statement a store sends (and can make the database fail), the three real
 * stores on top of it, the job dependencies, and a scripted set of war models.
 */

export const db = (env as unknown as { DB: D1Database }).DB;

export async function resetDb(seasons: Array<{ season: Season; method: SeasonMethod | null }> = []): Promise<void> {
  const tables = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all<{ name: string }>();
  for (const { name } of tables.results) {
    if (!name.startsWith('_cf_')) await db.prepare(`DROP TABLE IF EXISTS "${name}"`).run();
  }
  const bindings = env as unknown as { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
  await applyD1Migrations(db, bindings.TEST_MIGRATIONS);
  for (const { season, method } of seasons) {
    if (method === null) {
      await db
        .prepare('INSERT INTO seasons (id, number, starts_at, ends_at) VALUES (?, ?, ?, ?)')
        .bind(season.id, season.number, season.startsAt, season.endsAt)
        .run();
    } else {
      expectTrue(await createReputationStore(db).putSeason(season, method, method === 'v2' ? 56 : 28));
    }
  }
}

function expectTrue(value: boolean): void {
  if (!value) throw new Error('resetDb: the season was not inserted');
}

// --- counting ------------------------------------------------------------------------------------

export interface Meter {
  /** Calls to the database: a single statement or a whole batch each count once. */
  calls: number;
  /** Statements sent, the statements of a batch counted one by one. */
  statements: number;
  /** Statements that are not a SELECT. */
  writes: number;
  /** The statements, in order, as the first 60 characters of their text. */
  log: string[];
}

export interface MeteredDb {
  db: D1Database;
  meter: Meter;
  reset(): void;
  /**
   * After `statements` more statements, every call throws `error`, until `clear()`; with `once`, only the
   * first call that reaches the failure point throws and the database then works again.
   */
  failAfter(statements: number, error?: Error, once?: boolean): void;
  clear(): void;
}

/** A statement that does not change the database: a SELECT, or a WITH whose last word is a SELECT. */
const isRead = (sql: string): boolean =>
  !/^\s*(insert|update|delete|replace|create|drop|alter)\b/i.test(sql) &&
  !/^\s*with\b[\s\S]*\)\s*(insert|update|delete)\b/i.test(sql);

/** Wraps a database so that every statement is counted. Only what the stores use is implemented. */
export function meteredDb(real: D1Database): MeteredDb {
  const meter: Meter = { calls: 0, statements: 0, writes: 0, log: [] };
  let failure: { left: number; error: Error; once: boolean } | null = null;

  const note = (sql: string): void => {
    meter.statements += 1;
    if (!isRead(sql)) meter.writes += 1;
    meter.log.push(sql.replace(/\s+/g, ' ').trim().slice(0, 60));
  };
  const check = (count: number): void => {
    if (failure === null) return;
    if (failure.left < count || failure.left === 0) {
      const { error, once } = failure;
      if (once) failure = null;
      throw error;
    }
    failure.left -= count;
  };

  interface Wrapped {
    sql: string;
    inner: D1PreparedStatement;
  }
  const wrap = (sql: string, inner: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = {
      sql,
      inner,
      bind: (...values: unknown[]) => wrap(sql, inner.bind(...values)),
      run: async () => {
        check(1);
        meter.calls += 1;
        note(sql);
        return inner.run();
      },
      first: async (column?: string) => {
        check(1);
        meter.calls += 1;
        note(sql);
        return column === undefined ? inner.first() : inner.first(column);
      },
      all: async () => {
        check(1);
        meter.calls += 1;
        note(sql);
        return inner.all();
      },
      raw: async () => {
        check(1);
        meter.calls += 1;
        note(sql);
        return inner.raw();
      },
    } satisfies Wrapped & Record<string, unknown>;
    return wrapped as unknown as D1PreparedStatement;
  };

  const wrapper = {
    prepare: (sql: string) => wrap(sql, real.prepare(sql)),
    batch: async (statements: D1PreparedStatement[]) => {
      check(statements.length);
      meter.calls += 1;
      for (const statement of statements) note((statement as unknown as Wrapped).sql);
      return real.batch(statements.map((statement) => (statement as unknown as Wrapped).inner));
    },
  };

  return {
    db: wrapper as unknown as D1Database,
    meter,
    reset() {
      meter.calls = 0;
      meter.statements = 0;
      meter.writes = 0;
      meter.log.length = 0;
    },
    failAfter(statements, error = new Error('the database failed on purpose'), once = false) {
      failure = { left: statements, error, once };
    },
    clear() {
      failure = null;
    },
  };
}

// --- stores and job dependencies -----------------------------------------------------------------

export interface Stores {
  store: Store;
  reputation: ReputationStore;
  social: SocialStore;
}

export function storesOn(target: D1Database, houseOwners: readonly string[] = []): Stores {
  return {
    store: createD1Store(target),
    reputation: createReputationStore(target, { houseOwners }),
    social: createSocialStore(target),
  };
}

export type ModelScript = Record<string, (request: ModelRequest) => ModelResponse | Promise<ModelResponse>>;

export interface WarWorld {
  deps: WarModelDeps;
  /** Every request that reached a model, with the model id and the provider, in order. */
  calls: Array<{ modelId: string; provider: 'workers-ai' | 'groq'; request: ModelRequest; aiExtra: unknown }>;
  /** The Groq keys that were handed to `createOwnModel`. */
  groqKeysSeen: string[];
}

/** The war models, scripted by model id. A model without a script answers `provider_error`. */
export function warWorld(script: ModelScript, options: { groqApiKey?: string | null } = {}): WarWorld {
  const calls: WarWorld['calls'] = [];
  const groqKeysSeen: string[] = [];
  // The AI binding records what reaches it. The war job hands the model adapter a wrapper that adds the
  // entrant's `extra` fields, so calling the wrapper with an empty input shows exactly those fields.
  const aiInputs = new Map<string, unknown>();
  const port = (
    modelId: string,
    provider: 'workers-ai' | 'groq',
    ai: { run(model: string, input: Record<string, unknown>): Promise<unknown> } | null,
  ) => ({
    label: `${provider}:${modelId}`,
    async complete(request: ModelRequest): Promise<ModelResponse> {
      let aiExtra: unknown = null;
      if (ai !== null) {
        await ai.run(modelId, {});
        aiExtra = aiInputs.get(modelId) ?? null;
      }
      calls.push({ modelId, provider, request, aiExtra });
      const answer = script[modelId];
      return answer === undefined ? { ok: false, code: 'provider_error', httpStatus: 500 } : answer(request);
    },
  });
  return {
    calls,
    groqKeysSeen,
    deps: {
      ai: {
        run: async (model, input) => {
          aiInputs.set(model, input);
          return null;
        },
      },
      groqApiKey: options.groqApiKey === undefined ? 'gsk_test_groq_key_000000000000000000000000' : options.groqApiKey,
      createHouseModel: (ai, modelId) => port(modelId, 'workers-ai', ai),
      createOwnModel: (key, apiKey) => {
        groqKeysSeen.push(apiKey);
        return port(key.model, 'groq', null);
      },
    },
  };
}

export interface JobWorld {
  deps: SocialJobDeps;
  logs: Array<{ event: string; data: Record<string, string | number | boolean | null> | undefined }>;
  clock: { now: Date };
}

export function jobDeps(
  stores: Stores,
  options: { now: string; war?: WarModelDeps } = { now: '2026-10-20T20:05:00.000Z' },
): JobWorld {
  const logs: JobWorld['logs'] = [];
  const clock = { now: new Date(options.now) };
  const war = options.war ?? warWorld({}).deps;
  return {
    logs,
    clock,
    deps: {
      store: stores.store,
      social: stores.social,
      reputation: stores.reputation,
      sim,
      scoring,
      scoringV2,
      dna: strategyDna,
      rivalry: rivalryEngine,
      manager: createManagerEngine({ sim, scoring }),
      war,
      now: () => new Date(clock.now.getTime()),
      log: (event, data) => {
        logs.push({ event, data });
      },
    },
  };
}

export { SEASON_1 };
