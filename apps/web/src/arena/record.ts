import type { AgentPublic, AgentStats, DecisionPublic } from '@prix/contracts';
import { MICRO, noDecisionCodeSchema, skipCodeSchema } from '@prix/contracts';
import { formatCount, formatDayShort, formatPercentBps, formatTick, formatUsdMicro } from '../content/format.ts';
import { text } from '../content/index.ts';
import { noDecisionText, rowStatusText, skippedText } from '../content/states.ts';
import { stateText, symbolList } from './words.ts';

/**
 * What the agent's page says about one agent's record: the points of its value chart and the
 * rows of its decisions. Server only.
 *
 * Every value shown is the API's own. This file lays values out and chooses words. The latest
 * point carries the season return as the API sent it. An earlier point carries no figure: the
 * Chart primitive (`figure="return"`) shows the return since the season's starting value there,
 * worked out for display from the value the API sent for that day (docs/DECISIONS.md D-103). It
 * is never a rank or a score.
 */

/** One point of the value chart, in the shape the Chart primitive takes. */
export interface ChartPoint {
  /** Virtual USD: the geometry, and the return the chart shows at this point. */
  value: number;
  /** The API's season return, on the latest point only. */
  figure?: string;
  tone?: 'gain' | 'loss';
  detail: string;
  tip: string;
  tick: string;
}

export interface ValueChart {
  points: ChartPoint[];
  /** The value every agent starts a season with, in virtual USD: the dashed line of the chart. */
  baseline: number;
  alt: string;
  /** Narrowest first. Empty when the whole range is the only one that holds anything new. */
  ranges: Array<{ label: string; last?: number; current?: boolean }>;
  /** The UTC day the agent started from: the later of its creation and the season's start. */
  startDay: string;
}

/** A tone for a signed figure. Zero is ink. */
export function toneOf(bps: number): 'gain' | 'loss' | undefined {
  return bps > 0 ? 'gain' : bps < 0 ? 'loss' : undefined;
}

/** "10,000" for a grid line of the chart, from a value in virtual USD. */
export function chartTick(value: number): string {
  return formatCount(Math.round(value));
}

/**
 * The value chart of an agent: the value it started with, then one point per trading day the
 * API sent. Null before the agent's first trading day: the page then shows an empty state.
 *
 * The latest point carries the season return as the API sent it. Beside the figure, every point
 * says its portfolio value and its day, so the figure keeps one unit along the whole line.
 */
export function buildChart(
  agent: Pick<AgentPublic, 'createdAt' | 'season' | 'asOfTickId'>,
  stats: AgentStats,
  start: number,
): ValueChart | null {
  const days = stats.daily;
  const latest = days[days.length - 1];
  if (!latest) return null;

  const created = agent.createdAt.slice(0, 10);
  const seasonStart = agent.season.startsAt.slice(0, 10);
  const startDay = created > seasonStart ? created : seasonStart;
  const usd = (micro: number): number => micro / MICRO;

  const startPoint: ChartPoint = {
    value: usd(start),
    detail: text('agent.chartLatestDetail', '{value} virtual USD on {when}', {
      value: formatUsdMicro(start),
      when: formatDayShort(startDay),
    }),
    tip: text('agent.chartStartTip', 'Start, {day}', { day: formatDayShort(startDay) }),
    tick: text('agent.chartStartTick', 'Start'),
  };

  const dayPoints: ChartPoint[] = days.map((point, index) => {
    const isLatest = index === days.length - 1;
    const when = isLatest && agent.asOfTickId ? formatTick(agent.asOfTickId) : formatDayShort(point.day);
    if (isLatest) {
      return {
        value: usd(point.equityMicro),
        figure: formatPercentBps(stats.seasonReturnBps),
        tone: toneOf(stats.seasonReturnBps),
        detail: text('agent.chartLatestDetail', '{value} virtual USD on {when}', {
          value: formatUsdMicro(point.equityMicro),
          when,
        }),
        tip: when,
        tick: formatDayShort(point.day),
      };
    }
    return {
      value: usd(point.equityMicro),
      detail: text('agent.chartLatestDetail', '{value} virtual USD on {when}', {
        value: formatUsdMicro(point.equityMicro),
        when: formatDayShort(point.day),
      }),
      tip: formatDayShort(point.day),
      tick: formatDayShort(point.day),
    };
  });

  const points = [startPoint, ...dayPoints];
  // A range is offered only when it shows less than the whole record. A week is five trading
  // days and the close before them.
  const ranges: ValueChart['ranges'] = [];
  if (points.length > 6) ranges.push({ label: text('agent.rangeWeek', '1W'), last: 6 });
  if (points.length > 11) ranges.push({ label: text('agent.rangeTwoWeeks', '2W'), last: 11 });
  if (ranges.length > 0) ranges.push({ label: text('agent.rangeAll', 'All'), current: true });

  return {
    points,
    baseline: usd(start),
    ranges,
    startDay,
    alt: text(
      'agent.chartAlt',
      'Portfolio value by trading day, in virtual USD, from {start} on {startDay} to {latest} on {latestDay}. Use the arrow keys to move through the days.',
      {
        start: formatUsdMicro(start),
        startDay: formatDayShort(startDay),
        latest: formatUsdMicro(latest.equityMicro),
        latestDay: formatDayShort(latest.day),
      },
    ),
  };
}

export interface DecisionLine {
  /** For machines: the time of the row. */
  iso: string;
  /** "7 Oct, 15:00 UTC" */
  time: string;
  /** What changed, in the past tense: "Sold NVDA. Bought AMD", "No decision". */
  what: string;
  /** A note after the change, in grey: symbols that were not trading in the round. */
  detail?: string;
  /** The agent's own reason, or the record's sentence about the round. */
  why: string;
  /** True when `why` is the agent's own sentence. False when it is the record's. */
  own: boolean;
}

/** Why an agent that was asked made no decision, in words anyone may read. */
function noDecisionSentence(code: string | null): string {
  const known = noDecisionCodeSchema.safeParse(code);
  const sentence = known.success ? noDecisionText(known.data) : undefined;
  return (
    sentence ??
    text(
      'agent.noDecisionOther',
      'The agent was asked and returned no valid decision, so the portfolio was left unchanged.',
    )
  );
}

/** Why an agent was not asked in a round, in words anyone may read. */
function skippedSentence(code: string | null): string {
  const known = skipCodeSchema.safeParse(code);
  const sentence = known.success ? skippedText(known.data) : undefined;
  return (
    sentence ??
    text('agent.skippedOther', 'The agent was not asked in this round, so its portfolio was left unchanged.')
  );
}

/** One row of the feed of decisions on the agent's page. */
export function decisionLine(decision: DecisionPublic): DecisionLine {
  const base = { iso: decision.at, time: formatTick(decision.tickId) };
  if (decision.status === 'no_decision') {
    return { ...base, what: rowStatusText('no_decision'), why: noDecisionSentence(decision.code), own: false };
  }
  if (decision.status === 'skipped') {
    return { ...base, what: rowStatusText('skipped'), why: skippedSentence(decision.code), own: false };
  }

  // The API lists a decision's trades in the order they filled: what was sold, then what was bought.
  const sold = decision.fills.filter((fill) => fill.side === 'sell').map((fill) => fill.symbol);
  const bought = decision.fills.filter((fill) => fill.side === 'buy').map((fill) => fill.symbol);
  const change: string[] = [];
  if (sold.length > 0) change.push(text('agent.changeSold', 'Sold {symbols}', { symbols: sold.join(', ') }));
  if (bought.length > 0) change.push(text('agent.changeBought', 'Bought {symbols}', { symbols: bought.join(', ') }));
  if (change.length === 0) change.push(stateText('states.noChange'));

  const detail =
    decision.halted.length === 0
      ? undefined
      : decision.halted.length === 1
        ? text('agent.haltedOne', '{symbols} was not trading in this round.', { symbols: symbolList(decision.halted) })
        : text('agent.haltedOther', '{symbols} were not trading in this round.', {
            symbols: symbolList(decision.halted),
          });

  return {
    ...base,
    what: change.join('. '),
    detail,
    why: decision.reason ?? text('agent.reasonMissing', 'No reason was recorded with this decision.'),
    own: decision.reason !== null,
  };
}

/** "House model", "OpenRouter, anthropic/claude-sonnet-4.5", or the words for an agent without a model. */
export function modelText(model: AgentPublic['model']): string {
  if (model.kind === 'house') return text('common.houseModel', 'House model');
  if (model.kind === 'own') {
    if (model.model === '') return model.providerLabel;
    return text('agent.modelOwn', '{provider}, {model}', { provider: model.providerLabel, model: model.model });
  }
  return text('common.noModel', 'No model key');
}
