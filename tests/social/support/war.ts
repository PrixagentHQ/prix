import type { Season, WarEntrant, WarModel, WarRecord } from '@prix/contracts';
import { STARTING_CASH_MICRO, WAR_MAX_OUTPUT_TOKENS, WAR_MODELS, WAR_RULES } from '@prix/contracts';
import { scoring } from '@prix/reputation';
import { makeSnapshot, makeTick, SEASON_1, TEST_PRICES, TEST_SYMBOLS, utc } from '../../support/fixtures.ts';
import type { Stores } from './d1.ts';

/** The model of WAR_MODELS with this id. */
export function modelById(id: string): WarModel {
  const model = WAR_MODELS.find((m) => m.id === id);
  if (!model) throw new Error(`no war model ${id}`);
  return model;
}

export const LLAMA = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
export const GEMMA = '@cf/google/gemma-4-26b-a4b-it';
export const MISTRAL = '@cf/mistralai/mistral-small-3.1-24b-instruct';
export const GPT_OSS = 'openai/gpt-oss-120b';

export const WAR_ID = 'warlaunchaaa';
export const STRATEGY =
  'Hold a few large companies in roughly equal parts and change the portfolio only when the picture clearly changes. Keep some cash.';

/** The war the admin route would create, built by hand because no model has a probe yet. */
export function warRecord(over: Partial<Omit<WarRecord, 'number'>> = {}): Omit<WarRecord, 'number'> {
  return {
    id: WAR_ID,
    title: 'Four models, one strategy',
    status: 'scheduled',
    stopReason: null,
    strategy: STRATEGY,
    strategySha256: 'a'.repeat(64),
    systemMessageSha256: null,
    promptVersion: null,
    rules: { ...WAR_RULES, universe: [...TEST_SYMBOLS] },
    startsOn: '2026-10-12',
    tradingDays: 5,
    deadlineDay: '2026-10-27',
    method: 'v1',
    createdAt: '2026-10-10T10:00:00.000Z',
    firstTickId: null,
    lastTickId: null,
    endedAt: null,
    ...over,
  };
}

export function entrantOf(slot: 'A' | 'B' | 'C' | 'D', modelId: string, over: Partial<WarEntrant> = {}): WarEntrant {
  const model = modelById(modelId);
  return {
    warId: WAR_ID,
    slot,
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
    probedOn: '2026-10-09',
    portfolio: { cashMicro: STARTING_CASH_MICRO, holdings: {} },
    stats: scoring.initialStats(),
    lastTickId: null,
    days: 0,
    rejectedDays: 0,
    ...over,
  };
}

export async function createWar(
  stores: Stores,
  models: string[] = [LLAMA, GEMMA, GPT_OSS],
  over: Partial<Omit<WarRecord, 'number'>> = {},
): Promise<void> {
  const slots = ['A', 'B', 'C', 'D'] as const;
  const result = await stores.social.createWar(
    warRecord(over),
    models.map((id, k) => entrantOf(slots[k] as 'A', id)),
  );
  if (result.result !== 'created') throw new Error('createWar: another war is open');
}

/** A complete daily tick of `day` at 15:00 UTC with these prices (the test prices by default). */
export async function dailyTick(
  stores: Stores,
  day: string,
  options: { season?: Season; status?: 'processing' | 'complete'; daily?: boolean; scale?: number; hour?: number } = {},
): Promise<string> {
  const hour = options.hour ?? 15;
  const at = utc(`${day}T${String(hour).padStart(2, '0')}:00:00.000Z`);
  const scale = options.scale ?? 1;
  const prices = Object.fromEntries(
    Object.entries(TEST_PRICES).map(([symbol, price]) => [symbol, Math.round(price * scale)]),
  );
  const tick = makeTick(at, {
    daily: options.daily ?? true,
    status: options.status ?? 'complete',
    snapshot: makeSnapshot(at, { prices }),
  });
  const withSeason = { ...tick, seasonId: (options.season ?? SEASON_1).id };
  if (!(await stores.store.createTick(withSeason))) throw new Error(`dailyTick: ${tick.id} exists`);
  return tick.id;
}
