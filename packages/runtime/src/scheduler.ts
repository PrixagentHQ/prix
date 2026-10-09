import type {
  AgentRecord,
  AgentStats,
  AgentWork,
  AiUse,
  DecisionRow,
  Division,
  IsoTime,
  MarketSnapshot,
  ModelKeyRecord,
  ModelPort,
  ModelRequest,
  ModelResponse,
  NoDecisionCode,
  PriceMap,
  RebalanceResult,
  RecentReturns,
  RunSchedulerStep,
  SchedulerDeps,
  SchedulerReport,
  SkipCode,
  Tick,
  TokenSymbol,
  UtcDay,
} from '@prix/contracts';
import {
  DailyLimitError,
  KEY_FAILURES_TO_PAUSE,
  modelTextProblem,
  OPEN_DAILY_TICK_HOUR_UTC,
  parseDecisionOutput,
  SCORING_METHOD,
  SUMMARY_MAX,
  TICK_CREATE_WINDOW_MINUTES,
  TICK_FIRST_HOUR_UTC,
  TICK_LAST_HOUR_UTC,
  TICK_WINDOW_MINUTES,
  tickIdFor,
  tickStart,
  utcDayOfTick,
} from '@prix/contracts';
import { computeRecentReturns, haltedSymbols, toPriceMap } from '@prix/market';
import type { PriceHistory } from './holds.ts';
import { applyHolds, unavailableSnapshot } from './holds.ts';
import { assembleDecisionMessages, assembleSummaryMessages } from './prompts.ts';
import { hasLinkOrAddress, publicLine, utf8Length } from './text.ts';

/**
 * One step of the scheduler. docs/CONTRACTS.md section 10, as changed by section 15.
 *
 * A step is small on purpose: the free plan gives a Cron Trigger 10 ms of CPU, 50 subrequests
 * and 50 D1 statements. A step therefore does one of four things and returns: it creates a
 * tick, it moves a handful of agents of the oldest unfinished tick forward, it ranks one
 * division, or it does idle work.
 *
 * Nothing here is applied twice. `store.writeDecision` refuses a second row for an agent and
 * a tick, `createTick` never overwrites, `putSymbolHold` keeps an existing hold and `rerank`
 * is safe to repeat, so a step that runs twice, or two steps that overlap, leave one result.
 *
 * A database that fails cannot turn into spend. Every model call of a step comes after one
 * probe write, `store.touchScheduler`, and after every read the step needs for those calls. If
 * the probe fails the step ends as `idle` with no call made. Any other store call that fails
 * ends the step where it is: nothing after it runs.
 *
 * A log line carries an event name, ids, counts, codes and public prices. It never carries a
 * key, a prompt or model output, and the detail of a failed validation is not logged because
 * it can quote the model.
 */

/** How many earlier trading days the returns in a prompt look back. */
const RETURN_HISTORY_DAYS = 20;
/** Expired nonces and sessions deleted by one idle step, at most, of each. */
const EXPIRED_ROWS_PER_STEP = 100;
/** Slack on top of `modelTimeoutMs` before the scheduler stops waiting for an adapter. */
const TIMEOUT_GUARD_MS = 1_000;
/** Used to count neurons when the house model reports neither its cost nor its tokens: UTF-8 bytes per token. */
const BYTES_PER_TOKEN_ESTIMATE = 3;
/** A decision counts as two skips against the one budget of a step. docs/CONTRACTS.md section 15. */
const DECISION_UNITS = 2;

type LogData = Record<string, string | number | boolean | null>;

interface StepState {
  report: SchedulerReport;
  /** What the step was doing, for the log line of a failure. */
  stage: string;
}

function log(deps: SchedulerDeps, event: string, data?: LogData): void {
  try {
    deps.log(event, data);
  } catch {
    // A broken log sink must not break a step.
  }
}

/** The name of an error and nothing else: a message can carry text that does not belong in a log. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** A limit or a count as a whole number, zero when it is missing or negative. */
function whole(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function utcDay(iso: IsoTime): UtcDay {
  return iso.slice(0, 10);
}

export const runSchedulerStep: RunSchedulerStep = async (deps, now) => {
  const state: StepState = {
    report: { action: 'idle', tickId: null, decided: 0, noDecision: 0, skipped: 0, pending: 0, summaries: 0 },
    stage: 'start',
  };
  try {
    await runStep(deps, now, state);
  } catch (error) {
    // Whatever throws out of a step is a store call that failed: model calls and the engine are
    // caught where they happen. The step stops here, and the next one starts from the store.
    // A used-up daily limit of the database is expected on the free plan: it ends the step too.
    if (error instanceof DailyLimitError) log(deps, 'daily_limit', { stage: state.stage, tickId: state.report.tickId });
    else log(deps, 'step_stopped', { stage: state.stage, tickId: state.report.tickId, error: errorName(error) });
  }
  return state.report;
};

async function runStep(deps: SchedulerDeps, now: Date, state: StepState): Promise<void> {
  const nowIso = now.toISOString();

  // 1. Finish the oldest unfinished tick before anything else.
  state.stage = 'find_tick';
  const processing = await deps.store.listProcessingTicks();
  const oldest = processing[0];
  if (oldest !== undefined) {
    await processTick(deps, now, nowIso, oldest, state);
    return;
  }

  // 2. Create the tick of this hour, if it is time for one.
  if (await createTick(deps, now, nowIso, state)) return;

  // 3. Idle work.
  await idle(deps, nowIso, state);
}

/**
 * The probe write that comes before any model call. False when the database does not take
 * writes: the step then ends as `idle`, and no model is asked for an answer that could not be
 * stored.
 */
async function databaseTakesWrites(deps: SchedulerDeps, nowIso: IsoTime, state: StepState): Promise<boolean> {
  state.stage = 'touch';
  try {
    await deps.store.touchScheduler(nowIso);
    return true;
  } catch (error) {
    state.report.action = 'idle';
    log(deps, 'store_unwritable', { tickId: state.report.tickId, error: errorName(error) });
    return false;
  }
}

// --- step 2: a new tick ---------------------------------------------------------------------------

/** True when the step is over: the market was closed, or the tick now exists. */
async function createTick(deps: SchedulerDeps, now: Date, nowIso: IsoTime, state: StepState): Promise<boolean> {
  const { store } = deps;
  const hour = now.getUTCHours();
  if (hour < TICK_FIRST_HOUR_UTC || hour > TICK_LAST_HOUR_UTC) return false;
  if (now.getUTCMinutes() >= TICK_CREATE_WINDOW_MINUTES) return false;

  state.stage = 'tick_lookup';
  const tickId = tickIdFor(now);
  if ((await store.getTick(tickId)) !== null) return false;
  const season = await store.getActiveSeason(nowIso);
  if (season === null) return false;

  state.stage = 'snapshot';
  let taken: MarketSnapshot;
  try {
    taken = await deps.market.takeSnapshot(now);
  } catch (error) {
    log(deps, 'snapshot_failed', { tickId, error: errorName(error) });
    taken = unavailableSnapshot(nowIso);
  }
  // An open market has prices. One without them could not be read, whatever it says.
  if (taken.open && taken.prices.length === 0) taken = unavailableSnapshot(nowIso);

  state.stage = 'holds';
  const latest = await store.getLatestTick();
  // Every new point is compared with the last trusted price of its symbol (CONTRACTS section 20).
  // A closed snapshot is not compared, so it needs neither read.
  const history: PriceHistory = { trusted: {}, latest, previousTradingDay: null };
  if (taken.open && latest !== null) {
    history.trusted = await store.getLastTrustedPrices(tickId);
    const today = utcDay(nowIso);
    const latestDay = utcDayOfTick(latest.id);
    // The latest tick is the previous trading day's last unless it is today's; then one seek finds it.
    history.previousTradingDay =
      latestDay < today ? latestDay : ((await store.listDailyPrices(today, 1))[0]?.day ?? null);
    // A point with no trusted price that the latest tick carries is compared with its anchor if
    // its symbol entered the league since the previous trading day, and held for review on any
    // change otherwise. Only then is the trading day before the previous one read.
    const carried = new Set(latest.snapshot.prices.map((point) => point.symbol));
    const trusted = history.trusted;
    if (taken.prices.some((point) => trusted[point.symbol] === undefined && carried.has(point.symbol))) {
      const before =
        history.previousTradingDay === null
          ? undefined
          : (await store.listDailyPrices(history.previousTradingDay, 1))[0];
      history.establishedSymbols = new Set(Object.keys(before?.prices ?? {}));
    }
  }
  const holds = await store.listSymbolHolds();
  const { snapshot, newHolds, released } = applyHolds(taken, history, holds, tickId, nowIso);
  for (const hold of newHolds) {
    await store.putSymbolHold(hold);
    // Both prices are public feed values. They are what an admin needs to review the hold.
    log(deps, 'symbol_held', {
      tickId,
      symbol: hold.symbol,
      trustedPriceMicro: hold.priceMicro,
      seenPriceMicro: hold.seenPriceMicro,
      moveBps: Math.round(((hold.seenPriceMicro - hold.priceMicro) / hold.priceMicro) * 10_000),
    });
  }

  state.stage = 'market_status';
  const halted = haltedSymbols(snapshot);
  await store.putMarketStatus({
    open: snapshot.open,
    closedReason: snapshot.closedReason,
    checkedAt: nowIso,
    lastTickId: latest?.id ?? null,
    halted,
  });

  if (!snapshot.open) {
    state.report.action = 'market_closed';
    log(deps, 'market_closed', { tickId, reason: snapshot.closedReason, halted: halted.length });
    return true;
  }

  state.stage = 'tick_create';
  const daily = hour >= OPEN_DAILY_TICK_HOUR_UTC && !(await store.hasDailyTick(season.id, utcDay(nowIso)));
  const created = await store.createTick({
    id: tickId,
    seasonId: season.id,
    daily,
    snapshot,
    status: 'processing',
    createdAt: nowIso,
    completedAt: null,
  });

  // False means another step created it a moment ago. Either way the tick now exists.
  state.report.tickId = tickId;
  state.report.action = created ? 'tick_created' : 'batch';

  // A released hold ends here, after the tick that took the feed's price exists. If the step
  // stops before this, the row stays and the next tick takes the feed's price once more.
  if (created) {
    state.stage = 'holds_released';
    for (const symbol of released) {
      await store.deleteSymbolHold(symbol);
      log(deps, 'hold_ended', { tickId, symbol });
    }
  }

  state.stage = 'tick_count';
  const pendingPro = await store.countPendingAgents(tickId, 'pro');
  const pendingOpen = daily ? await store.countPendingAgents(tickId, 'open') : 0;
  state.report.pending = pendingPro + pendingOpen;
  log(deps, 'tick_created', { tickId, daily, created, pending: state.report.pending, halted: halted.length });
  return true;
}

// --- step 3: idle work ----------------------------------------------------------------------------

async function idle(deps: SchedulerDeps, nowIso: IsoTime, state: StepState): Promise<void> {
  const { store, limits } = deps;
  state.report.action = 'idle';

  state.stage = 'summaries';
  const maxSummaries = whole(limits.maxSummariesPerStep);
  // Summaries have a budget of their own inside the day's budget, so that no number of new or
  // edited strategies can use up what the daily round needs.
  const summaryBudget = Math.min(whole(limits.summaryNeuronsPerDay), whole(limits.houseNeuronsPerDay));
  const agents = maxSummaries > 0 && summaryBudget > 0 ? await store.listAgentsNeedingSummary(maxSummaries) : [];
  if (agents.length > 0) {
    const day = utcDay(nowIso);
    const counted = await store.getAiNeurons(day, 'summary');

    // Summaries are counted apart from decisions, against their own budget: a call is made
    // only if its largest possible cost still fits, whatever the decisions have used.
    const asks: SummaryAsk[] = [];
    let reserved = counted;
    for (const agent of agents.slice(0, maxSummaries)) {
      const request: ModelRequest = {
        messages: assembleSummaryMessages(agent.prompt),
        maxOutputTokens: limits.maxOutputTokens,
        timeoutMs: limits.modelTimeoutMs,
        jsonDecision: false,
      };
      const most = largestCost(deps, request);
      if (reserved + most > summaryBudget) break;
      reserved += most;
      asks.push({ agent, request });
    }

    if (asks.length > 0) {
      if (!(await databaseTakesWrites(deps, nowIso, state))) return;
      state.stage = 'summaries';
      const answers = await Promise.all(asks.map((ask) => askSummary(deps, ask)));

      let neurons = 0;
      let exhausted = false;
      for (const answer of answers) {
        neurons += answer.neurons;
        exhausted ||= answer.exhausted;
      }
      await countNeurons(deps, day, 'summary', summaryBudget, counted, neurons, exhausted);

      for (const answer of answers) {
        // An exhausted allocation is not a failed summary: the agent stays pending for another day.
        if (answer.exhausted) continue;
        // The owner may have changed the prompt while the model was writing.
        const current = await store.getAgent(answer.agent.id);
        if (current === null || current.prompt !== answer.agent.prompt || current.summaryStatus !== 'pending') continue;
        if (answer.summary === null) {
          await store.updateAgent(current.id, { summaryStatus: 'failed' }, nowIso);
          log(deps, 'summary_failed', { agentId: current.id, code: answer.code });
        } else {
          await store.updateAgent(current.id, { summary: answer.summary, summaryStatus: 'ready' }, nowIso);
          state.report.summaries += 1;
          log(deps, 'summary_written', { agentId: current.id });
        }
      }
    }
  }

  state.stage = 'cleanup';
  await store.deleteExpired(nowIso, EXPIRED_ROWS_PER_STEP);
}

interface SummaryAsk {
  agent: AgentRecord;
  request: ModelRequest;
}

interface SummaryAnswer {
  agent: AgentRecord;
  /** The summary, or null when the call failed or the answer cannot be shown. */
  summary: string | null;
  /** Why there is no summary. A code, never text from the model. */
  code: string | null;
  neurons: number;
  exhausted: boolean;
}

/**
 * A summary is written by a model from an owner's text and shown to everyone, so it is cleaned
 * the way a reason is, and it fails when it is empty, too long, or carries a link, a host name
 * or a 0x address. A summary that fails is not repaired.
 */
async function askSummary(deps: SchedulerDeps, ask: SummaryAsk): Promise<SummaryAnswer> {
  const { agent, request } = ask;
  const response = await callModel(deps.houseModel, request);
  const neurons = houseNeurons(deps, request, response);
  if (!response.ok) {
    return { agent, summary: null, code: response.code, neurons, exhausted: response.code === 'allocation_exhausted' };
  }
  let summary: string;
  try {
    summary = publicLine(response.text);
  } catch {
    return { agent, summary: null, code: 'unreadable', neurons, exhausted: false };
  }
  if (summary.length === 0) return { agent, summary: null, code: 'empty', neurons, exhausted: false };
  if (summary.length > SUMMARY_MAX) return { agent, summary: null, code: 'too_long', neurons, exhausted: false };
  if (hasLinkOrAddress(summary)) return { agent, summary: null, code: 'link_or_address', neurons, exhausted: false };
  if (modelTextProblem(summary) !== null)
    return { agent, summary: null, code: 'text_refused', neurons, exhausted: false };
  return { agent, summary, code: null, neurons, exhausted: false };
}

// --- the house-model budget -----------------------------------------------------------------------

function neuronsFor(deps: SchedulerDeps, inputTokens: number, outputTokens: number): number {
  const { limits } = deps;
  return (
    (inputTokens * limits.houseNeuronsPerMillionInputTokens +
      outputTokens * limits.houseNeuronsPerMillionOutputTokens) /
    1_000_000
  );
}

/** Tokens of a request, from its size in UTF-8 bytes: dense text costs more tokens than its length shows. */
function estimateInputTokens(request: ModelRequest): number {
  let bytes = 0;
  for (const message of request.messages) bytes += utf8Length(message.content);
  return Math.ceil(bytes / BYTES_PER_TOKEN_ESTIMATE);
}

/** The most a house-model call can cost: the estimated input and every output token it may write. */
function largestCost(deps: SchedulerDeps, request: ModelRequest): number {
  return Math.ceil(neuronsFor(deps, estimateInputTokens(request), whole(request.maxOutputTokens)));
}

/**
 * Neurons of one house-model call. The exact figure, when Workers AI reported one; otherwise
 * the token counts times the configured prices. Not rounded: the step rounds the sum up.
 */
function houseNeurons(deps: SchedulerDeps, request: ModelRequest, response: ModelResponse): number {
  if (response.ok) {
    const reported = response.neurons;
    if (typeof reported === 'number' && Number.isFinite(reported) && reported > 0) return reported;
    // A count the model did not report is estimated, never taken as zero.
    return neuronsFor(
      deps,
      response.inputTokens ?? estimateInputTokens(request),
      response.outputTokens ?? whole(request.maxOutputTokens),
    );
  }
  // A call that timed out may still have run to the end. Count it in full.
  if (response.code === 'provider_timeout') {
    return neuronsFor(deps, estimateInputTokens(request), whole(request.maxOutputTokens));
  }
  return 0;
}

/**
 * Adds what a step spent to the day's count. When the model said the allocation is used up,
 * the count is raised to the daily limit, so the steps that follow skip without calling.
 * A count that cannot be stored ends the step: uncounted calls must not go on.
 */
async function countNeurons(
  deps: SchedulerDeps,
  day: UtcDay,
  use: AiUse,
  budget: number,
  countedBefore: number,
  spent: number,
  exhausted: boolean,
): Promise<void> {
  let add = spent > 0 ? Math.ceil(spent) : 0;
  if (exhausted) add = Math.max(add, Math.ceil(budget - countedBefore));
  if (exhausted) log(deps, 'allocation_exhausted', { day, use });
  if (add <= 0) return;
  await deps.store.addAiNeurons(day, use, add);
}

// --- steps 4 to 7: one tick -----------------------------------------------------------------------

interface TickContext {
  tick: Tick;
  day: UtcDay;
  symbols: TokenSymbol[];
  prices: PriceMap;
  halted: TokenSymbol[];
  nowIso: IsoTime;
}

/** One agent to deal with in this step: skip it with a code, or ask its model. */
interface Job {
  work: AgentWork;
  skip: SkipCode | null;
  /** The stored key of a Pro agent that is asked. Null when it has none. Ciphertext only. */
  key: ModelKeyRecord | null;
}

/** Which model was asked for a row, and with which strategy. */
interface Asked {
  model: string;
  strategyAt: IsoTime;
}

/** What is known about a job while it runs, so that a failure can still be recorded honestly. */
interface Trace {
  asked: Asked | null;
  neurons: number;
  exhausted: boolean;
}

/** What a job produced: a row to write, and what the house model spent on it. */
interface Outcome {
  row: DecisionRow;
  stats: AgentStats;
  /** The agent's count of refused rows in a row, after this row. */
  keyFailures: number;
  neurons: number;
  exhausted: boolean;
  /** The HTTP status of a provider failure, for the log. */
  httpStatus: number | null;
}

/**
 * Membership is fixed at the snapshot. An agent whose strategy changed at or after the moment
 * the tick was created sits the round out: its prompt, its key or its pause was touched when
 * the prices were already known. A time that cannot be read counts as changed.
 */
function changedThisRound(agent: AgentRecord, tick: Tick): boolean {
  const changedAt = Date.parse(agent.strategyChangedAt);
  const createdAt = Date.parse(tick.createdAt);
  return !(changedAt < createdAt);
}

async function processTick(
  deps: SchedulerDeps,
  now: Date,
  nowIso: IsoTime,
  tick: Tick,
  state: StepState,
): Promise<void> {
  const { store, limits } = deps;
  const report = state.report;
  report.tickId = tick.id;
  report.action = 'batch';

  state.stage = 'count';
  const pendingPro = await store.countPendingAgents(tick.id, 'pro');
  const pendingOpen = tick.daily ? await store.countPendingAgents(tick.id, 'open') : 0;
  if (pendingPro + pendingOpen === 0) {
    // 7. Nobody is waiting: rank. Ranking has a step of its own, away from the row writes.
    await rankAndComplete(deps, nowIso, tick, state);
    return;
  }
  report.pending = pendingPro + pendingOpen;

  // One budget per step, counted in skips: `maxSkipsPerStep` rows without a model call. A
  // decision counts as two of them, and a step never makes more than `maxDecisionsPerStep`
  // model calls. That keeps every mix of the two inside 50 D1 statements.
  let units = whole(limits.maxSkipsPerStep);
  let calls = whole(limits.maxDecisionsPerStep);
  const jobs: Job[] = [];

  const take = async (division: Division, forced: SkipCode | null): Promise<void> => {
    const limit = forced === null ? Math.min(calls, Math.floor(units / DECISION_UNITS)) : units;
    if (limit <= 0) return;
    const works = (await store.listPendingAgents(tick.id, division, limit)).slice(0, limit);
    for (const work of works) {
      const skip = changedThisRound(work.agent, tick) ? 'changed_this_round' : forced;
      jobs.push({ work, skip, key: null });
      units -= skip === null ? DECISION_UNITS : 1;
      if (skip === null) calls -= 1;
    }
  };

  // 4. Pro agents: skipped once the tick's window has passed, otherwise asked.
  state.stage = 'pro';
  if (pendingPro > 0) {
    const windowOver = now.getTime() - tickStart(tick.id).getTime() >= TICK_WINDOW_MINUTES * 60_000;
    await take('pro', windowOver ? 'not_reached' : null);
  }

  // 5. Open agents, at the daily tick, with what is left of the step.
  state.stage = 'open';
  const today = utcDay(nowIso);
  let countedToday: number | null = null;
  if (pendingOpen > 0 && units > 0) {
    if (today !== utcDayOfTick(tick.id)) {
      await take('open', 'not_reached');
    } else {
      countedToday = await store.getAiNeurons(today, 'decision');
      await take('open', countedToday >= limits.houseNeuronsPerDay ? 'allocation_exhausted' : null);
    }
  }

  // Before any model call: the probe write, then every read the calls need. A database that
  // fails does so here, while nothing has been spent.
  const context = tickContext(tick, nowIso);
  let returns: RecentReturns[] = [];
  if (jobs.some((job) => job.skip === null)) {
    if (!(await databaseTakesWrites(deps, nowIso, state))) return;
    state.stage = 'history';
    returns = computeRecentReturns(context.prices, await store.listDailyPrices(context.day, RETURN_HISTORY_DAYS));
    state.stage = 'keys';
    for (const job of jobs) {
      const { agent } = job.work;
      if (job.skip !== null || agent.division !== 'pro' || agent.modelKeyId === null) continue;
      // The store answers only for the agent's own owner. What comes back is ciphertext.
      job.key = await store.getModelKey(agent.modelKeyId, agent.owner);
    }
  }

  // Every model call of the step runs at once. Nothing in here touches the store.
  state.stage = 'decide';
  const outcomes = await Promise.all(jobs.map((job) => settle(deps, context, returns, job)));

  // What the house model spent is counted before any row is written: the neurons are gone
  // whether or not the rows land.
  state.stage = 'neurons';
  let neurons = 0;
  let exhausted = false;
  for (const outcome of outcomes) {
    neurons += outcome.neurons;
    exhausted ||= outcome.exhausted;
  }
  if (neurons > 0 || exhausted)
    await countNeurons(deps, today, 'decision', limits.houseNeuronsPerDay, countedToday ?? 0, neurons, exhausted);

  // The rows, one at a time. The first write that fails ends the step: the agents after it
  // stay pending, and the next step asks the database before it asks any model.
  state.stage = 'write';
  for (const [index, first] of outcomes.entries()) {
    let outcome = first;
    let written: boolean;
    try {
      written = await store.writeDecision(outcome.row, outcome.stats, outcome.keyFailures);
    } catch (error) {
      // The store refuses a row it does not accept. Any other error still ends the step.
      const refusedJob = jobs[index];
      if (!(error instanceof Error) || error.name !== 'ZodError' || refusedJob === undefined) throw error;
      log(deps, 'row_refused', { tickId: tick.id, agentId: outcome.row.agentId, error: errorName(error) });
      outcome = internalError(deps, context, refusedJob.work, { asked: null, neurons: 0, exhausted: false });
      written = await store.writeDecision(outcome.row, outcome.stats, outcome.keyFailures);
    }
    const { row } = outcome;
    report.pending = Math.max(0, report.pending - 1);
    if (!written) {
      // Another step wrote this agent's row first. Nothing is applied a second time.
      log(deps, 'row_exists', { tickId: tick.id, agentId: row.agentId });
      continue;
    }
    if (row.status === 'decided') report.decided += 1;
    else if (row.status === 'no_decision') report.noDecision += 1;
    else report.skipped += 1;
    log(deps, 'row_written', {
      tickId: tick.id,
      agentId: row.agentId,
      division: row.division,
      status: row.status,
      code: row.code,
      fills: row.fills.length,
      httpStatus: outcome.httpStatus,
    });

    // A key or a model that is refused round after round is paused, so it stops costing the
    // league a row and a call at every tick. The owner resumes it with a key that works.
    if (row.division === 'pro' && row.status === 'no_decision' && outcome.keyFailures >= KEY_FAILURES_TO_PAUSE) {
      state.stage = 'pause';
      const current = await store.getAgent(row.agentId);
      // Only an agent that is still active: a pause its owner or an admin set meanwhile stands.
      if (current !== null && current.status === 'active') {
        await store.updateAgent(row.agentId, { status: 'paused', pausedReason: 'key_failing' }, nowIso);
        log(deps, 'agent_paused', { agentId: row.agentId, reason: 'key_failing', keyFailures: outcome.keyFailures });
      }
      state.stage = 'write';
    }
  }

  // 6. The tick stays open. A step that wrote rows never ranks, even if it wrote the last one.
}

function tickContext(tick: Tick, nowIso: IsoTime): TickContext {
  return {
    tick,
    day: utcDayOfTick(tick.id),
    symbols: tick.snapshot.prices.map((point) => point.symbol),
    prices: toPriceMap(tick.snapshot),
    halted: haltedSymbols(tick.snapshot),
    nowIso,
  };
}

/**
 * Runs one job and always returns a row. If the engine throws for an agent, the row is
 * `skipped` with `internal_error`, the portfolio is left as it was and the event is logged, so
 * one agent that cannot be processed never keeps a tick, and with it the league, from finishing.
 */
async function settle(
  deps: SchedulerDeps,
  context: TickContext,
  returns: readonly RecentReturns[],
  job: Job,
): Promise<Outcome> {
  const trace: Trace = { asked: null, neurons: 0, exhausted: false };
  try {
    if (job.skip !== null) return untouched(deps, context, job.work, 'skipped', job.skip, null);
    return await decide(deps, context, returns, job, trace);
  } catch (error) {
    log(deps, 'agent_failed', {
      tickId: context.tick.id,
      agentId: job.work.agent.id,
      asked: trace.asked !== null,
      error: errorName(error),
    });
    return internalError(deps, context, job.work, trace);
  }
}

/** The count of refused rows in a row after `row`. docs/CONTRACTS.md section 15. */
function keyFailuresAfter(work: AgentWork, row: DecisionRow): number {
  // A skipped row says nothing about the key.
  if (row.status === 'skipped') return whole(work.keyFailures);
  const refused =
    row.division === 'pro' &&
    row.status === 'no_decision' &&
    (row.code === 'provider_rejected' || row.code === 'key_unavailable');
  return refused ? whole(work.keyFailures) + 1 : 0;
}

function rowWithout(
  context: TickContext,
  work: AgentWork,
  status: 'skipped' | 'no_decision',
  code: SkipCode | NoDecisionCode,
  asked: Asked | null,
  equityMicro: number,
): DecisionRow {
  return {
    agentId: work.agent.id,
    tickId: context.tick.id,
    seasonId: context.tick.seasonId,
    division: work.agent.division,
    status,
    code,
    targetsBps: null,
    reason: null,
    fills: [],
    halted: context.halted,
    portfolio: work.portfolio,
    equityMicro,
    costMicro: 0,
    model: asked?.model ?? null,
    strategyAt: asked?.strategyAt ?? null,
    createdAt: context.nowIso,
  };
}

function statsAfter(deps: SchedulerDeps, context: TickContext, work: AgentWork, row: DecisionRow): AgentStats {
  return deps.scoring.updateStats(work.stats, {
    day: context.day,
    status: row.status,
    equityMicro: row.equityMicro,
    fillCount: row.fills.length,
  });
}

/** A row that leaves the portfolio as it was: `skipped`, or `no_decision`. Throws if the engine does. */
function untouched(
  deps: SchedulerDeps,
  context: TickContext,
  work: AgentWork,
  status: 'skipped' | 'no_decision',
  code: SkipCode | NoDecisionCode,
  asked: Asked | null,
): Outcome {
  const equityMicro = deps.sim.valuePortfolio(work.portfolio, context.prices);
  const row = rowWithout(context, work, status, code, asked, equityMicro);
  return {
    row,
    stats: statsAfter(deps, context, work, row),
    keyFailures: keyFailuresAfter(work, row),
    neurons: 0,
    exhausted: false,
    httpStatus: null,
  };
}

/**
 * The row of an agent the engine could not process. It must not throw, so it trusts nothing:
 * a portfolio that cannot be valued keeps its last known value, and stats that cannot be
 * updated stay as they were.
 */
function internalError(deps: SchedulerDeps, context: TickContext, work: AgentWork, trace: Trace): Outcome {
  let equityMicro = work.stats.equityMicro;
  try {
    equityMicro = deps.sim.valuePortfolio(work.portfolio, context.prices);
  } catch {
    // Keeps the last known value.
  }
  const row = rowWithout(context, work, 'skipped', 'internal_error', trace.asked, equityMicro);
  let stats = work.stats;
  try {
    stats = statsAfter(deps, context, work, row);
  } catch (error) {
    log(deps, 'stats_failed', { tickId: context.tick.id, agentId: work.agent.id, error: errorName(error) });
  }
  return {
    row,
    stats,
    keyFailures: keyFailuresAfter(work, row),
    neurons: trace.neurons,
    exhausted: trace.exhausted,
    httpStatus: null,
  };
}

/** Asks one agent's model and turns the answer into a row. docs/CONTRACTS.md section 10. */
async function decide(
  deps: SchedulerDeps,
  context: TickContext,
  returns: readonly RecentReturns[],
  job: Job,
  trace: Trace,
): Promise<Outcome> {
  const { work } = job;
  const { agent } = work;
  const house = agent.division === 'open';

  // The value before trading. Without it there is nothing honest to show a model.
  const equityMicro = deps.sim.valuePortfolio(work.portfolio, context.prices);

  // The owner's key is opened here, at the moment of use, and is not kept after the call.
  const model = house ? deps.houseModel : await openOwnModel(deps, agent, job.key);
  if (model === null) return untouched(deps, context, work, 'no_decision', 'key_unavailable', null);

  const request: ModelRequest = {
    messages: assembleDecisionMessages({
      now: context.tick.snapshot.takenAt,
      prices: context.tick.snapshot.prices,
      returns,
      halted: context.halted,
      portfolio: work.portfolio,
      equityMicro,
      strategy: agent.prompt,
    }),
    // An owner's model may spend part of its answer reasoning, and the owner pays for it.
    maxOutputTokens: house ? deps.limits.maxOutputTokens : deps.limits.ownMaxOutputTokens,
    timeoutMs: deps.limits.modelTimeoutMs,
    jsonDecision: true,
  };
  const asked: Asked = { model: labelOf(model), strategyAt: agent.strategyChangedAt };
  trace.asked = asked;
  const response = await callModel(model, request);
  trace.neurons = house ? houseNeurons(deps, request, response) : 0;
  const { neurons } = trace;

  if (!response.ok) {
    if (response.code === 'allocation_exhausted' && house) {
      // The allocation was gone before the model could answer: the agent was not asked.
      trace.asked = null;
      trace.exhausted = true;
      return { ...untouched(deps, context, work, 'skipped', 'allocation_exhausted', null), neurons, exhausted: true };
    }
    // Only the house model has an allocation. From an owner's model it is a provider failure.
    const code = response.code === 'allocation_exhausted' ? 'provider_error' : response.code;
    return {
      ...untouched(deps, context, work, 'no_decision', code, asked),
      neurons,
      httpStatus: response.httpStatus,
    };
  }

  // The one place that decides whether an answer is a decision. Nothing is repaired.
  const parsed = parseDecisionOutput(response.text, context.symbols);
  if (!parsed.ok) return { ...untouched(deps, context, work, 'no_decision', parsed.code, asked), neurons };
  // A reason is public text like a summary: no link, no address, no claim of a return, no abuse. The neurons stay charged.
  if (hasLinkOrAddress(parsed.reason) || modelTextProblem(parsed.reason) !== null) {
    return { ...untouched(deps, context, work, 'no_decision', 'reason_invalid', asked), neurons };
  }

  // The engine throws on a programming error, or on a target it must never be given. Either
  // way the caller records `internal_error` and the portfolio stays as it was.
  const result: RebalanceResult = deps.sim.rebalance({
    portfolio: work.portfolio,
    prices: context.prices,
    targetsBps: parsed.targetsBps,
    halted: context.halted,
  });

  const row: DecisionRow = {
    agentId: agent.id,
    tickId: context.tick.id,
    seasonId: context.tick.seasonId,
    division: agent.division,
    status: 'decided',
    code: null,
    targetsBps: parsed.targetsBps,
    reason: parsed.reason,
    fills: result.fills,
    halted: context.halted,
    portfolio: result.portfolio,
    equityMicro: result.equityAfterMicro,
    costMicro: result.costMicro,
    model: asked.model,
    strategyAt: asked.strategyAt,
    createdAt: context.nowIso,
  };
  return {
    row,
    stats: statsAfter(deps, context, work, row),
    keyFailures: keyFailuresAfter(work, row),
    neurons,
    exhausted: false,
    httpStatus: null,
  };
}

/**
 * The adapter for a Pro agent's own key. Null when the agent has no key, the key row is gone,
 * or the key cannot be opened. The key exists in the clear only from here to the end of the call.
 */
async function openOwnModel(
  deps: SchedulerDeps,
  agent: AgentRecord,
  key: ModelKeyRecord | null,
): Promise<ModelPort | null> {
  // A key is used only for its owner's agent, whatever a row says.
  if (key === null || key.owner !== agent.owner) return null;
  try {
    const apiKey = await deps.keys.open(key);
    if (apiKey === null || apiKey.length === 0) return null;
    return deps.ownModel(key, apiKey);
  } catch {
    return null;
  }
}

function labelOf(model: ModelPort): string {
  try {
    return String(model.label);
  } catch {
    return 'unknown';
  }
}

/**
 * One model call that cannot throw and cannot hang. An adapter keeps `modelTimeoutMs` on its
 * own; the timer here only stops the step from waiting on one that does not.
 */
async function callModel(model: ModelPort, request: ModelRequest): Promise<ModelResponse> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const call = Promise.resolve().then(() => model.complete(request));
    call.catch(() => {});
    const guard = new Promise<ModelResponse>((resolve) => {
      timer = setTimeout(
        () => resolve({ ok: false, code: 'provider_timeout', httpStatus: null }),
        whole(request.timeoutMs) + TIMEOUT_GUARD_MS,
      );
    });
    const response = await Promise.race([call, guard]);
    if (typeof response !== 'object' || response === null) {
      return { ok: false, code: 'provider_error', httpStatus: null };
    }
    if (response.ok && typeof response.text !== 'string') {
      return { ok: false, code: 'provider_error', httpStatus: null };
    }
    return response;
  } catch {
    return { ok: false, code: 'provider_error', httpStatus: null };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// --- step 7: ranking ------------------------------------------------------------------------------

/**
 * Publishes the ranks, one division per step: Pro first, then Open when the tick is daily.
 * A division is ranked for this tick once its league state names the tick.
 */
async function rankAndComplete(deps: SchedulerDeps, nowIso: IsoTime, tick: Tick, state: StepState): Promise<void> {
  const { store } = deps;
  const report = state.report;

  state.stage = 'rank_pro';
  const pro = await store.getLeagueState(tick.seasonId, 'pro');
  if (pro?.tickId !== tick.id) {
    const ranked = await store.rerank(tick.seasonId, 'pro', tick.id, nowIso, SCORING_METHOD);
    log(deps, 'ranked', { tickId: tick.id, division: 'pro', ranked: ranked.rankedCount, agents: ranked.agentCount });
    if (tick.daily) {
      report.action = 'batch';
      return;
    }
  } else if (tick.daily) {
    state.stage = 'rank_open';
    const open = await store.getLeagueState(tick.seasonId, 'open');
    if (open?.tickId !== tick.id) {
      const ranked = await store.rerank(tick.seasonId, 'open', tick.id, nowIso, SCORING_METHOD);
      log(deps, 'ranked', { tickId: tick.id, division: 'open', ranked: ranked.rankedCount, agents: ranked.agentCount });
    }
  }

  state.stage = 'complete';
  await store.completeTick(tick.id, nowIso);
  // The market was not read again, so the status keeps what the last check found and gains the tick.
  const status = (await store.getMarketStatus()) ?? {
    open: tick.snapshot.open,
    closedReason: tick.snapshot.closedReason,
    checkedAt: tick.snapshot.takenAt,
    lastTickId: null,
    halted: haltedSymbols(tick.snapshot),
  };
  await store.putMarketStatus({ ...status, lastTickId: tick.id });
  report.action = 'tick_completed';
  log(deps, 'tick_completed', { tickId: tick.id, daily: tick.daily });
}
