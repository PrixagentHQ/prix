import type {
  AgentStats,
  MarketSnapshot,
  ModelRequest,
  ModelResponse,
  NoDecisionCode,
  PriceMap,
  RecentReturns,
  SocialJob,
  SocialJobDeps,
  Tick,
  TokenSymbol,
  UtcDay,
  WarEntrant,
  WarPatch,
  WarRecord,
  WarRow,
} from '@prix/contracts';
import {
  modelTextProblem,
  parseDecisionOutput,
  utcDayOfTick,
  WAR_DECISIONS_AND_WARS_CEILING,
  WAR_NEURONS_PER_DAY,
  WAR_REJECTED_DAYS_TO_STOP,
  WAR_TIMEOUT_MS,
} from '@prix/contracts';
import { computeRecentReturns, haltedSymbols, toPriceMap, UNIVERSE } from '@prix/market';
import { assembleDecisionMessages, decisionSystemMessage } from '../prompts.ts';
import { hasLinkOrAddress, utf8 } from '../text.ts';
import { guardSocialJob, idField, logSafe, parseBody, utcDayOf } from './common.ts';
import { callWarModel, entrantBlock, entrantModel, spentNeurons, warRequest, worstNeurons } from './war-models.ts';

/**
 * The `model_war` job (docs/contracts/phase-6-social.md section 5.3). One run plays at most one
 * war-day of the one open war: every entrant is asked once, at once, at the league's daily tick, and
 * the rows land in one batch whose key (war, tick, slot) makes a second run roll back as a whole.
 *
 * Money first, then calls: the neurons of every Workers AI entrant are reserved all or nothing before
 * any model is asked, under the war's own daily cap and, together with the day's league decisions,
 * under the house ceiling. The reservation is also the write that proves the database takes writes.
 *
 * Nothing here logs a key, the strategy or a model answer.
 */

/** Earlier trading days the returns in a prompt look back, as in the league. */
const RETURN_HISTORY_DAYS = 20;

/** One entrant at this war-day: what it will be asked, or why it will not be. */
interface Plan {
  entrant: WarEntrant;
  /** Why no model is asked: no key, or the model left the allowlist. */
  code: 'provider_rejected' | 'key_unavailable' | null;
  request: ModelRequest | null;
  /** The value before trading; null when the portfolio could not be valued. */
  equityMicro: number | null;
  worst: number;
}

interface Answer {
  plan: Plan;
  response: ModelResponse | null;
  neurons: number;
}

interface WarDayContext {
  tick: Tick;
  day: UtcDay;
  /** The decision system message of the symbols the war froze (docs/CONTRACTS.md section 21.7). */
  systemMessage: string;
  /** The tick's points of the symbols the war froze, in snapshot order. */
  points: MarketSnapshot['prices'];
  symbols: TokenSymbol[];
  prices: PriceMap;
  halted: TokenSymbol[];
  nowIso: string;
}

/**
 * The job_state row of the war-day being played: written before the first
 * model call, and turned to `missed` by a later run that finds it without its rows.
 */
const WAR_DAY_CURSOR = 'social:war';

interface WarDayRecord {
  warId: string;
  tickId: string;
  state: 'asked' | 'missed';
}

function readWarDayRecord(body: string | null): WarDayRecord | null {
  const raw = parseBody(body);
  const warId = idField(raw.warId);
  const tickId = idField(raw.tickId);
  if (warId === null || tickId === null) return null;
  return { warId, tickId, state: raw.state === 'missed' ? 'missed' : 'asked' };
}

async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(text)));
  let hex = '';
  for (const byte of digest) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

export function createModelWarJob(deps: SocialJobDeps): SocialJob {
  const name = 'model_war';
  const { store, social, reputation } = deps;

  function putWarDayRecord(record: WarDayRecord, nowIso: string): Promise<void> {
    return social.putCursor({ name: WAR_DAY_CURSOR, body: JSON.stringify(record) }, nowIso);
  }

  async function stop(war: WarRecord, reason: NonNullable<WarRecord['stopReason']>, nowIso: string): Promise<'done'> {
    await social.updateWar(war.id, { status: 'stopped', stopReason: reason, endedAt: nowIso }, nowIso);
    logSafe(deps, 'war_stopped', { warId: war.id, reason });
    return 'done';
  }

  function plan(context: WarDayContext, war: WarRecord, returns: readonly RecentReturns[], entrant: WarEntrant): Plan {
    let equityMicro: number | null = null;
    try {
      equityMicro = deps.sim.valuePortfolio(entrant.portfolio, context.prices);
    } catch {
      // The row records internal_error and no model is asked.
      return { entrant, code: null, request: null, equityMicro: null, worst: 0 };
    }
    const blocked = entrantBlock(entrant, deps.war);
    if (blocked !== null) return { entrant, code: blocked, request: null, equityMicro, worst: 0 };
    const assembled = assembleDecisionMessages({
      now: context.tick.snapshot.takenAt,
      prices: context.points,
      returns,
      halted: context.halted,
      portfolio: entrant.portfolio,
      equityMicro,
      strategy: war.strategy,
    });
    // The war's own system message, which names only the symbols it froze.
    const request = warRequest(
      assembled.map((message) =>
        message.role === 'system' ? { ...message, content: context.systemMessage } : message,
      ),
      WAR_TIMEOUT_MS,
    );
    return { entrant, code: null, request, equityMicro, worst: worstNeurons(entrant, request) };
  }

  /** The adapter is built here, after the reservation: a Groq key is handed over only for this call. */
  async function ask(entry: Plan): Promise<Answer> {
    if (entry.code !== null || entry.request === null) return { plan: entry, response: null, neurons: 0 };
    const built = entrantModel(entry.entrant, deps.war);
    if (!built.ok) return { plan: { ...entry, code: built.code }, response: null, neurons: 0 };
    const response = await callWarModel(built.port, entry.request);
    return { plan: entry, response, neurons: spentNeurons(entry.entrant, entry.request, response) };
  }

  function statsAfter(context: WarDayContext, stats: AgentStats, row: WarRow): AgentStats {
    return deps.scoring.updateStats(stats, {
      day: context.day,
      status: row.status,
      equityMicro: row.equityMicro,
      fillCount: row.fills.length,
    });
  }

  function baseRow(context: WarDayContext, answer: Answer, equityMicro: number): WarRow {
    const { entrant } = answer.plan;
    const ok = answer.response?.ok === true ? answer.response : null;
    return {
      warId: entrant.warId,
      slot: entrant.slot,
      tickId: context.tick.id,
      status: 'skipped',
      code: 'internal_error',
      targetsBps: null,
      reason: null,
      fills: [],
      halted: context.halted,
      portfolio: entrant.portfolio,
      equityMicro,
      costMicro: 0,
      inputTokens: ok?.inputTokens ?? null,
      outputTokens: ok?.outputTokens ?? null,
      neurons: entrant.provider === 'workers-ai' ? answer.neurons : null,
      createdAt: context.nowIso,
    };
  }

  /** The row of one answer, as the league builds a row. Throws only if the engine does. */
  function rowOf(context: WarDayContext, answer: Answer): WarRow {
    const { plan: entry } = answer;
    if (entry.equityMicro === null) throw new Error('unvalued');
    const base = baseRow(context, answer, entry.equityMicro);
    const without = (code: NoDecisionCode): WarRow => ({ ...base, status: 'no_decision', code });
    if (entry.code !== null) return without(entry.code);
    const response = answer.response;
    if (response === null) throw new Error('unasked');
    if (!response.ok) {
      // Only Workers AI has an allocation, and an exhausted war-day never reaches here.
      return without(response.code === 'allocation_exhausted' ? 'provider_error' : response.code);
    }
    // The one place that decides whether an answer is a decision. Nothing is repaired.
    const parsed = parseDecisionOutput(response.text, context.symbols);
    if (!parsed.ok) return without(parsed.code);
    if (hasLinkOrAddress(parsed.reason) || modelTextProblem(parsed.reason) !== null) return without('reason_invalid');
    const result = deps.sim.rebalance({
      portfolio: entry.entrant.portfolio,
      prices: context.prices,
      targetsBps: parsed.targetsBps,
      halted: context.halted,
    });
    return {
      ...base,
      status: 'decided',
      code: null,
      targetsBps: parsed.targetsBps,
      reason: parsed.reason,
      fills: result.fills,
      portfolio: result.portfolio,
      equityMicro: result.equityAfterMicro,
      costMicro: result.costMicro,
    };
  }

  /** Never throws: an entrant the engine cannot process gets `skipped` with `internal_error`. */
  function settle(context: WarDayContext, answer: Answer): { row: WarRow; entrant: WarEntrant } {
    const { entrant } = answer.plan;
    let row: WarRow;
    let stats: AgentStats;
    try {
      row = rowOf(context, answer);
      stats = statsAfter(context, entrant.stats, row);
    } catch {
      logSafe(deps, 'war_entrant_failed', { warId: entrant.warId, slot: entrant.slot, tickId: context.tick.id });
      row = baseRow(context, answer, answer.plan.equityMicro ?? entrant.stats.equityMicro);
      stats = entrant.stats;
      try {
        stats = statsAfter(context, entrant.stats, row);
      } catch {
        // The stats stay as they were.
      }
    }
    const rejectedDays =
      row.status === 'skipped' ? entrant.rejectedDays : row.code === 'provider_rejected' ? entrant.rejectedDays + 1 : 0;
    return {
      row,
      entrant: {
        ...entrant,
        portfolio: row.portfolio,
        stats,
        lastTickId: context.tick.id,
        days: entrant.days + 1,
        rejectedDays,
      },
    };
  }

  return {
    name,
    run: (now) =>
      guardSocialJob(deps, name, now, async (skip) => {
        const nowIso = now.toISOString();
        const today = utcDayOf(now);

        // 1. The open war, if any. A war past its deadline is stopped.
        const war = await social.getOpenWar();
        if (war === null) return 'idle';
        if (today > war.deadlineDay) return stop(war, 'budget', nowIso);
        if (today < war.startsOn) return 'idle';
        if (war.lastTickId !== null && utcDayOfTick(war.lastTickId) >= today) return 'idle';

        // 2. Today's daily tick, complete, newer than the war's last war-day.
        const daily = await social.getDailyTickOf(today);
        if (daily === null || daily.status !== 'complete') return 'idle';
        if (war.lastTickId !== null && war.lastTickId >= daily.id) return 'idle';

        // A war-day recorded before its models were asked but without its rows: the batch that should
        // have stored it failed. It is marked missed, and the models are never asked twice for it.
        const record = readWarDayRecord(await reputation.getJobState(WAR_DAY_CURSOR));
        if (record !== null && record.warId === war.id && record.tickId === daily.id) {
          if (record.state === 'missed') return 'idle';
          if (await skip()) return 'idle';
          await putWarDayRecord({ ...record, state: 'missed' }, nowIso);
          logSafe(deps, 'war_day_missed', { warId: war.id, tickId: daily.id });
          return 'done';
        }

        // 3, early: a day already spent needs no further read.
        const warToday = await social.getWarNeurons(today);
        const decisionsToday = await store.getAiNeurons(today, 'decision');
        if (warToday >= WAR_NEURONS_PER_DAY || decisionsToday + warToday >= WAR_DECISIONS_AND_WARS_CEILING)
          return 'idle';

        if ((await store.listProcessingTicks()).length > 0) return 'idle';

        // The prompt freeze: a different decision prompt ends the war before anyone is asked. The war's
        // message names the symbols it froze (section 21.7): a war keeps its universe, and a symbol
        // that joined the league later is neither offered, priced nor tradable in it.
        const frozen = new Set<TokenSymbol>(war.rules.universe);
        const systemMessage = decisionSystemMessage(UNIVERSE.filter((token) => frozen.has(token.symbol)));
        const systemHash = await sha256Hex(systemMessage);
        if (war.systemMessageSha256 !== null && war.systemMessageSha256 !== systemHash) {
          return stop(war, 'prompt_changed', nowIso);
        }

        const tick = await store.getTick(daily.id);
        if (tick === null || tick.status !== 'complete' || !tick.daily || utcDayOfTick(tick.id) !== today)
          return 'idle';
        const entrants = await social.listWarEntrants(war.id);
        if (entrants.length === 0) return 'idle';
        if (entrants.some((entrant) => entrant.lastTickId !== null && entrant.lastTickId >= tick.id)) return 'idle';

        const points = tick.snapshot.prices.filter((point) => frozen.has(point.symbol));
        const warSnapshot: MarketSnapshot = { ...tick.snapshot, prices: points };
        const context: WarDayContext = {
          tick,
          day: utcDayOfTick(tick.id),
          systemMessage,
          points,
          symbols: points.map((point) => point.symbol),
          prices: toPriceMap(warSnapshot),
          halted: haltedSymbols(warSnapshot),
          nowIso,
        };
        const returns = computeRecentReturns(
          context.prices,
          await store.listDailyPrices(context.day, RETURN_HISTORY_DAYS),
        );
        const plans = entrants.map((entrant) => plan(context, war, returns, entrant));

        // 3. Budget, all or nothing, before any model is asked.
        const worst = plans.reduce((sum, entry) => sum + entry.worst, 0);
        if (decisionsToday + warToday + worst > WAR_DECISIONS_AND_WARS_CEILING) return 'idle';
        if (await skip()) return 'idle';
        if (!(await social.reserveWarNeurons(today, worst, WAR_NEURONS_PER_DAY))) return 'idle';
        // The war-day is recorded before the first model call: if anything after the calls fails, the next
        // run marks it missed instead of asking again. A failed record asks nobody.
        await putWarDayRecord({ warId: war.id, tickId: tick.id, state: 'asked' }, nowIso);

        // 4. Every entrant at once. Nothing in here touches the store.
        const answers = await Promise.all(plans.map((entry) => ask(entry)));

        // 5. Settle the neurons: the reservation becomes what was spent. They are spent whatever follows.
        const spent = Math.ceil(answers.reduce((sum, answer) => sum + answer.neurons, 0));
        const exhausted = answers.some(
          (answer) =>
            answer.response?.ok === false &&
            answer.response.code === 'allocation_exhausted' &&
            answer.plan.entrant.provider === 'workers-ai',
        );
        let delta = spent - worst;
        // An exhausted allocation closes the day to wars, so nobody is asked again until tomorrow.
        if (exhausted) delta = Math.max(delta, WAR_NEURONS_PER_DAY - (warToday + worst));
        if (delta !== 0) await social.adjustWarNeurons(today, delta);
        if (exhausted) {
          // The war-day is discarded for everyone: missed, and nobody is asked again for it.
          await putWarDayRecord({ warId: war.id, tickId: tick.id, state: 'missed' }, nowIso);
          logSafe(deps, 'war_allocation_exhausted', { warId: war.id, tickId: tick.id, day: today });
          return 'done';
        }

        // 6. Rows as in the league.
        const settled = answers.map((answer) => settle(context, answer));
        const nextEntrants = settled.map((entry) => entry.entrant);

        // 7 and 8. One batch: rows, entrants, the war.
        const complete = nextEntrants.every((entrant) => entrant.days >= war.tradingDays);
        const unavailable = nextEntrants.some((entrant) => entrant.rejectedDays >= WAR_REJECTED_DAYS_TO_STOP);
        const patch: WarPatch = {
          status: complete ? 'complete' : unavailable ? 'stopped' : 'running',
          firstTickId: war.firstTickId ?? tick.id,
          lastTickId: tick.id,
        };
        if (war.systemMessageSha256 === null) {
          patch.systemMessageSha256 = systemHash;
          patch.promptVersion = `decision@${systemHash.slice(0, 12)}`;
        }
        if (!complete && unavailable) patch.stopReason = 'model_unavailable';
        if (complete || unavailable) patch.endedAt = nowIso;

        const rows = settled.map((entry) => entry.row);
        const written = await social.writeWarDay(war.id, rows, nextEntrants, patch, nowIso);
        if (!written) {
          logSafe(deps, 'war_day_exists', { warId: war.id, tickId: tick.id });
          return 'done';
        }
        logSafe(deps, 'war_day_written', {
          warId: war.id,
          tickId: tick.id,
          rows: rows.length,
          decided: rows.filter((row) => row.status === 'decided').length,
          neurons: spent,
          status: patch.status ?? null,
        });
        return 'done';
      }),
  };
}
