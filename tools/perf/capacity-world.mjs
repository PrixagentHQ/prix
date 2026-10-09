// The league that capacity.mjs measures: the product's own code, a full division of agents in
// the fourth week of a season, and stand-ins for the three things that are not on this machine
// (the chain, Workers AI and the owners' model providers).
//
// Everything that costs a D1 row or a D1 statement is the real code: the store of
// apps/api/src/store, the scheduler of packages/runtime, the engine and the scoring. Only the
// answers of the market and of the models are made up, and they are made up to be expensive:
// every prompt is as long as a prompt may be, every decision trades, and the prices move so
// that the whole league table turns over at every ranking.

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from './lib.mjs';
import { DAY_SHAPE, HOUSE_CALL_TOKENS, SCHEDULER_LIMITS } from './limits.mjs';

const DAY_MS = 86_400_000;
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** The scheduler's own estimate when a model reports no usage: three characters to a token. */
export const CHARS_PER_TOKEN = 3;

const REASON =
  'Keeps the core holding where it is and moves the rest of the portfolio from the two weakest names of the ' +
  'round into the two that the strategy ranks highest, so that the record shows a full rotation at every round.';
const SUMMARY =
  'Holds one core name at a fixed weight and rotates the remainder between two other names at every round, ' +
  'selling what it held before. It never uses leverage and keeps a third of the portfolio or more in cash.';

/** Loads the product's own modules from their source files. Node strips the types. */
export async function loadProduct() {
  const load = async (path) => {
    try {
      return await import(pathToFileURL(resolve(REPO_ROOT, path)).href);
    } catch (error) {
      throw new Error(`Could not load ${path}: ${error instanceof Error ? error.message : error}`, { cause: error });
    }
  };
  const contracts = await load('packages/contracts/src/index.ts');
  const [market, sim, reputation, runtime, store] = await Promise.all([
    load('packages/market/src/index.ts'),
    load('packages/sim/src/index.ts'),
    load('packages/reputation/src/index.ts'),
    load('packages/runtime/src/index.ts'),
    load('apps/api/src/store/index.ts'),
  ]);
  // The HTTP API is loaded apart: without it the scheduler can still be measured.
  let createApp = null;
  let httpError = null;
  try {
    createApp = (await load('apps/api/src/http/index.ts')).createApp;
  } catch (error) {
    httpError = error.message;
  }
  return {
    contracts,
    symbols: market.UNIVERSE.map((token) => token.symbol),
    sim: sim.sim,
    scoring: reputation.scoring,
    runSchedulerStep: runtime.runSchedulerStep,
    createD1Store: store.createD1Store,
    createApp,
    httpError,
  };
}

function utcDay(time) {
  return new Date(time).toISOString().slice(0, 10);
}

function isWeekday(time) {
  const day = new Date(time).getUTCDay();
  return day !== 0 && day !== 6;
}

/** The `count` weekdays before `day`, newest first. */
function weekdaysBefore(day, count) {
  const days = [];
  for (let time = Date.parse(`${day}T00:00:00.000Z`) - DAY_MS; days.length < count; time -= DAY_MS) {
    if (isWeekday(time)) days.push(utcDay(time));
  }
  return days;
}

/** A 12-character id in the alphabet of `idSchema`, the same for the same `kind` and `n`. */
function idOf(kind, n) {
  let text = '';
  for (let rest = n; rest > 0; rest = Math.floor(rest / 32)) text = BASE32[rest % 32] + text;
  return kind + text.padStart(11, 'a');
}

function addressOf(n) {
  return `0x${n.toString(16).padStart(40, '0')}`;
}

function hex64(n) {
  return n.toString(16).padStart(64, '0');
}

/**
 * The world of one run. `start` is the Monday the season starts on. The measured day is the
 * Tuesday of the season's fourth week, so every agent has a record of sixteen trading days,
 * and the three days after it are there for the scenarios that go wrong on purpose.
 */
export function createWorld(product, options, start = '2026-10-12') {
  const { contracts, symbols } = product;
  const { CHAIN_ID, MICRO, STARTING_CASH_MICRO, PROMPT_MAX, SEASON_LENGTH_DAYS, agentNameKey } = contracts;
  const startTime = Date.parse(`${start}T00:00:00.000Z`);
  const days = [22, 23, 24, 25].map((offset) => utcDay(startTime + offset * DAY_MS));
  const measuredDay = days[0];
  const recordDays = [];
  for (let time = startTime; utcDay(time) < measuredDay; time += DAY_MS) {
    if (isWeekday(time)) recordDays.push(utcDay(time));
  }
  const seasonId = idOf('s', 1);
  const season = {
    id: seasonId,
    number: 1,
    startsAt: new Date(startTime).toISOString(),
    endsAt: new Date(startTime + SEASON_LENGTH_DAYS * DAY_MS).toISOString(),
  };
  const seededAt = new Date(startTime + 60_000).toISOString();

  // --- prices -----------------------------------------------------------------------------------

  const basePrice = (k) => (40 + 23 * k) * MICRO;

  /**
   * The price of symbol `k` at round `ordinal`, or its base price in the history (`ordinal` null).
   * The first symbol swings ten percent above and eight percent below its base at alternate
   * rounds. Every agent holds a different share of it, so the order of the table reverses each
   * time: the most a ranking can have to write. The swing stays under SUSPECT_MOVE_BPS.
   */
  function priceAt(k, ordinal) {
    const base = basePrice(k);
    if (ordinal === null) return base;
    if (k === 0) return Math.round(base * (ordinal % 2 === 0 ? 1.1 : 0.92));
    return base + Math.round((base * (((ordinal * 7 + k * 13) % 11) - 5)) / 1000);
  }

  function ordinalOf(now) {
    const midnight = Date.parse(`${utcDay(now)}T00:00:00.000Z`);
    const dayIndex = Math.round((midnight - Date.parse(`${measuredDay}T00:00:00.000Z`)) / DAY_MS);
    return dayIndex * DAY_SHAPE.ticksPerDay + (now.getUTCHours() - DAY_SHAPE.tickFirstHourUtc);
  }

  function snapshot(takenAt, ordinal, factor = 1) {
    const updatedAt = new Date(Date.parse(takenAt) - 60_000).toISOString();
    return {
      takenAt,
      chainId: CHAIN_ID,
      blockNumber: 1_000_000 + (ordinal ?? 0),
      open: true,
      closedReason: null,
      prices: symbols.map((symbol, k) => ({
        symbol,
        priceMicro: Math.round(priceAt(k, ordinal) * factor),
        updatedAt,
        ageSeconds: 60,
        fresh: true,
      })),
    };
  }

  /** The chain, as `MarketPort`. `jump` multiplies every price, which is what a bad feed looks like. */
  const market = {
    calls: 0,
    jump: 1,
    async takeSnapshot(now) {
      this.calls += 1;
      return snapshot(now.toISOString(), ordinalOf(now), this.jump);
    },
  };

  // --- agents -----------------------------------------------------------------------------------

  const prompt = 'Hold the strongest names of the last month, keep cash for the weak weeks and sell what falls behind. '
    .repeat(40)
    .slice(0, PROMPT_MAX);

  function agentOf(division, index, number) {
    const owner = addressOf(number);
    const name = `Bench ${division === 'open' ? 'Open' : 'Pro'} ${String(index + 1).padStart(3, '0')}`;
    // The share of the first symbol, different for every agent of a division.
    const coreBps = division === 'open' ? 100 + index * 18 : 150 + index * 70;
    const weights = [
      [0, coreBps],
      [1 + (index % (symbols.length - 1)), 1500],
      [1 + ((index + 7) % (symbols.length - 1)), 1000],
    ];
    const holdings = {};
    let cashMicro = STARTING_CASH_MICRO;
    for (const [k, bps] of weights) {
      const price = BigInt(basePrice(k));
      const units = (BigInt(STARTING_CASH_MICRO) * BigInt(bps) * BigInt(MICRO)) / (10_000n * price);
      holdings[symbols[k]] = Number(units);
      // The engine's own valuation: floor(units * price / 1,000,000).
      cashMicro -= Number((units * price) / BigInt(MICRO));
    }
    const sorted = Object.fromEntries(Object.entries(holdings).sort(([a], [b]) => (a < b ? -1 : 1)));
    const keyId = division === 'pro' ? idOf('k', number) : null;
    return {
      agent: {
        id: idOf(division === 'open' ? 'o' : 'p', number),
        owner,
        name,
        nameKey: agentNameKey(name),
        division,
        prompt,
        promptPublic: false,
        summary: SUMMARY,
        summaryStatus: 'ready',
        modelKeyId: keyId,
        status: 'active',
        pausedReason: null,
        hidden: false,
        createdAt: new Date(startTime + 60_000 + number * 1000).toISOString(),
        updatedAt: seededAt,
        strategyChangedAt: new Date(startTime + 60_000 + number * 1000).toISOString(),
        promptChangeDay: null,
        promptChangeCount: 0,
      },
      portfolio: { cashMicro, holdings: sorted },
      stats: {
        equityMicro: STARTING_CASH_MICRO,
        peakEquityMicro: STARTING_CASH_MICRO,
        seasonReturnBps: 0,
        maxDrawdownBps: 0,
        tradeCount: recordDays.length * 4,
        decidedCount: recordDays.length * (division === 'pro' ? DAY_SHAPE.ticksPerDay : 1),
        noDecisionCount: 0,
        skippedCount: 0,
        tradingDays: recordDays.length,
        lastDay: recordDays.at(-1) ?? null,
        daily: recordDays.map((day) => ({ day, equityMicro: STARTING_CASH_MICRO })),
      },
      key:
        keyId === null
          ? null
          : {
              id: keyId,
              owner,
              provider: 'openai',
              model: 'bench-model',
              last4: '0000',
              // Not a sealed key: the opener below never reads it.
              ciphertext: 'bm90IGEga2V5',
              iv: 'AAAAAAAAAAAAAAAA',
              keyVersion: 1,
              createdAt: seededAt,
            },
    };
  }

  const agents = [];
  for (let i = 0; i < options.open; i += 1) agents.push(agentOf('open', i, 1 + i));
  for (let i = 0; i < options.pro; i += 1) agents.push(agentOf('pro', i, 100_001 + i));

  // --- models -----------------------------------------------------------------------------------

  const usage = {
    inFlight: 0,
    /** Reset by the caller before a step. */
    step: { calls: 0, mostAtOnce: 0 },
    house: { decisions: 0, summaries: 0 },
    own: { decisions: 0 },
    decisionChars: { most: 0, total: 0, count: 0 },
    summaryChars: { most: 0, total: 0, count: 0 },
  };

  /** A valid decision that trades: the core holding stays, the other two names are replaced. */
  function decide(document) {
    const names = Object.keys(document.prices);
    const core = names[0];
    const corePercent = Math.min(40, document.portfolio.holdingsPercent?.[core] ?? 0);
    const others = names.slice(1);
    const turn = Number(document.time.slice(11, 13)) * 5 + Math.round(corePercent * 10);
    const targets = {};
    if (corePercent > 0) targets[core] = corePercent;
    targets[others[turn % others.length]] = 15;
    targets[others[(turn + 9) % others.length]] = 10;
    return JSON.stringify({ targets, reason: REASON });
  }

  async function complete(kind, request) {
    usage.inFlight += 1;
    usage.step.calls += 1;
    usage.step.mostAtOnce = Math.max(usage.step.mostAtOnce, usage.inFlight);
    try {
      // A real call is answered later, never in the same turn. This keeps the calls of a step
      // in flight together, as they are in a Worker.
      await new Promise((done) => setImmediate(done));
      const chars = request.messages.reduce((sum, message) => sum + message.content.length, 0);
      // The stand-in answers with the measured token counts of the house model and with the exact
      // cost Workers AI would report, so the scheduler counts neurons as it will in production.
      const shape = request.jsonDecision
        ? options.strategy === 'long'
          ? HOUSE_CALL_TOKENS.decisionLong
          : HOUSE_CALL_TOKENS.decisionShort
        : HOUSE_CALL_TOKENS.summary;
      const inputTokens = shape.input;
      const neurons =
        (shape.input * SCHEDULER_LIMITS.houseNeuronsPerMillionInputTokens +
          shape.output * SCHEDULER_LIMITS.houseNeuronsPerMillionOutputTokens) /
        1_000_000;
      const tally = request.jsonDecision ? usage.decisionChars : usage.summaryChars;
      tally.most = Math.max(tally.most, chars);
      tally.total += chars;
      tally.count += 1;
      if (!request.jsonDecision) {
        usage.house.summaries += 1;
        return {
          ok: true,
          text: SUMMARY,
          inputTokens,
          outputTokens: shape.output,
          ...(kind === 'house' ? { neurons } : {}),
        };
      }
      usage[kind].decisions += 1;
      const text = decide(JSON.parse(request.messages.at(-1).content));
      return { ok: true, text, inputTokens, outputTokens: shape.output, ...(kind === 'house' ? { neurons } : {}) };
    } finally {
      usage.inFlight -= 1;
    }
  }

  const houseModel = { label: 'house:bench', complete: (request) => complete('house', request) };
  const ownModel = (key) => ({
    label: `${key.provider}:${key.model}`,
    complete: (request) => complete('own', request),
  });
  const keys = { open: async () => 'bench-key-that-opens-nothing' };

  return {
    season,
    seededAt,
    days,
    measuredDay,
    recordDays,
    historyDays: weekdaysBefore(measuredDay, 20),
    agents,
    prompt,
    market,
    usage,
    houseModel,
    ownModel,
    keys,
    historySnapshot: (takenAt) => snapshot(takenAt, null),
    hex64,
    addressOf,
    /** One agent beyond the caps, for the probe that the store refuses it. It has no key. */
    extraAgent(division) {
      const index = division === 'open' ? options.open : options.pro;
      const entry = agentOf(division, index, (division === 'open' ? 1 : 100_001) + index);
      entry.agent.modelKeyId = null;
      entry.key = null;
      return entry;
    },
  };
}

/** Everything a scheduler step gets, as the Worker entry point builds it, with the stand-ins. */
export function schedulerDeps(product, world, store, log) {
  return {
    store,
    market: world.market,
    sim: product.sim,
    scoring: product.scoring,
    houseModel: world.houseModel,
    ownModel: world.ownModel,
    keys: world.keys,
    limits: { ...SCHEDULER_LIMITS },
    log,
  };
}

async function inGroups(items, size, work) {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(work));
  }
}

/** The SQL that creates season 1, from the product's own seed command when it can be loaded. */
async function seasonStatements(season) {
  try {
    const seed = await import(pathToFileURL(resolve(REPO_ROOT, 'infra', 'seed', 'season.ts')).href);
    if (typeof seed.seasonSql === 'function') {
      return seed
        .seasonSql(season)
        .split(';')
        .map((sql) => sql.trim())
        .filter((sql) => sql !== '')
        .map((sql) => ({ sql, params: [] }));
    }
  } catch {
    // Fall through to the table as docs/CONTRACTS.md section 3 names it.
  }
  return [
    {
      sql: 'INSERT INTO seasons (id, number, starts_at, ends_at) VALUES (?1, ?2, ?3, ?4)',
      params: [season.id, season.number, season.startsAt, season.endsAt],
    },
  ];
}

/**
 * Fills the database through the store, and measures what each kind of write costs on the way.
 * Returns the cost of one operation of each kind: D1 statements, rows read, rows written.
 */
export async function seedWorld({ product, world, store, execute, meter, options }) {
  const { contracts } = product;
  const costs = {};
  const measure = (name, count) => {
    const taken = meter.take();
    costs[name] = {
      count,
      statements: count === 0 ? 0 : taken.statements / count,
      rowsRead: count === 0 ? 0 : taken.rowsRead / count,
      rowsWritten: count === 0 ? 0 : taken.rowsWritten / count,
    };
  };

  for (const statement of await seasonStatements(world.season)) await execute([statement], false);
  const season = await store.getSeason(world.season.id);
  if (season === null) throw new Error('The season was not stored.');
  meter.reset();

  // Twenty earlier trading days of prices, so that a decision prompt carries every return.
  await inGroups(world.historyDays, 5, async (day) => {
    const at = `${day}T19:00:00.000Z`;
    const created = await store.createTick({
      id: `${day}T19:00Z`,
      seasonId: world.season.id,
      daily: false,
      snapshot: world.historySnapshot(at),
      status: 'complete',
      createdAt: at,
      completedAt: at,
    });
    if (!created) throw new Error(`The history tick of ${day} was not stored.`);
  });
  meter.reset();

  const keyed = world.agents.filter((entry) => entry.key !== null);
  await inGroups(keyed, 5, async (entry) => {
    const result = await store.putModelKey(entry.key, contracts.MAX_MODEL_KEYS_PER_WALLET);
    if (result !== undefined && result !== 'stored') throw new Error(`A model key was refused: ${result}.`);
  });
  measure('modelKey', keyed.length);

  await inGroups(world.agents, 5, async (entry) => {
    const { agent } = entry;
    // The cap of the contract, or the size asked for when a run goes above it on purpose.
    const cap = Math.max(
      agent.division === 'open' ? contracts.MAX_AGENTS_OPEN : contracts.MAX_AGENTS_PRO,
      agent.division === 'open' ? options.open : options.pro,
    );
    const result = await store.createAgent(agent, world.season.id, entry.portfolio, entry.stats, cap);
    if (result !== 'created') throw new Error(`Agent ${agent.name} was not created: ${result}.`);
  });
  measure('createAgent', world.agents.length);

  // Changed prompts, the day before the measured day: each one waits for a new summary.
  const changedAt = `${world.recordDays.at(-1)}T20:00:00.000Z`;
  const changed = world.agents.slice(0, options.promptChanges);
  await inGroups(changed, 5, async (entry) => {
    const result = await store.updateAgent(
      entry.agent.id,
      {
        prompt: `${world.prompt.slice(0, -1)}!`,
        summary: null,
        summaryStatus: 'pending',
        strategyChangedAt: changedAt,
        promptChangeDay: changedAt.slice(0, 10),
        promptChangeCount: 1,
      },
      changedAt,
    );
    if (result !== 'updated') throw new Error(`A prompt change was refused: ${result}.`);
  });
  measure('promptChange', changed.length);

  // Sign-ins that have expired by the measured day, so that its idle steps have rows to delete.
  const expiredAt = `${world.recordDays.at(-1)}T12:00:00.000Z`;
  const signedInAt = new Date(Date.parse(expiredAt) - contracts.SESSION_TTL_SECONDS * 1000).toISOString();
  const signIns = Array.from({ length: options.signIns }, (_, i) => i + 1);
  const statelessNonce = typeof store.useNonce === 'function';
  await inGroups(signIns, 5, async (n) => {
    if (statelessNonce) {
      await store.useNonce(`bench${String(n).padStart(51, '0')}`, expiredAt);
    } else {
      // Revision 2 of the store: a nonce is stored when it is issued and updated when it is used.
      await store.putNonce(`bench${String(n).padStart(51, '0')}`, expiredAt);
      await store.consumeNonce(`bench${String(n).padStart(51, '0')}`, signedInAt);
    }
    await store.touchUser(world.addressOf(n), signedInAt);
    await store.putSession({
      tokenHash: world.hex64(n),
      address: world.addressOf(n),
      createdAt: signedInAt,
      expiresAt: expiredAt,
    });
  });
  measure('signIn', signIns.length);
  costs.signIn.statelessNonce = statelessNonce;

  // What a signed-in request reads before it does anything: the session and the wallet's agent.
  const live = { tokenHash: world.hex64(9_000_001), address: world.addressOf(1) };
  await store.putSession({ ...live, createdAt: changedAt, expiresAt: `${world.days.at(-1)}T23:59:59.000Z` });
  meter.reset();
  await store.getSession(live.tokenHash, changedAt);
  await store.getAgentByOwner(live.address);
  measure('signedInRead', 1);

  return costs;
}
