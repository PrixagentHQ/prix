import type {
  Division,
  DnaAxis,
  DnaNote,
  DnaProfile,
  ManagerDetailResponse,
  ManagerSchedule,
  ManagerStatus,
  RebalanceReason,
  RivalryEvent,
  RivalryPublic,
  WarProvider,
  WarStatus,
  WarStopReason,
} from '@prix/contracts';
import { noDecisionCodeSchema, skipCodeSchema } from '@prix/contracts';
import {
  formatCount,
  formatDay,
  formatDayShort,
  formatDrawdownBps,
  formatPercentBps,
  formatWeightBps,
} from '../../content/format.ts';
import { text } from '../../content/index.ts';
import { noDecisionText, skippedText } from '../../content/states.ts';
import { siteHref } from '../words.ts';

/**
 * The words and links of the Phase 6 pages. Server only. Every string is a key of the `social`
 * area with a draft that could ship (`editor` writes the deck, docs/contracts/phase-6-social.md
 * section 9). Nothing here may use a word of SOCIAL_FORBIDDEN_WORDS or ADVICE_WORDS: a paper
 * manager is always a paper manager, a model war is "one run under these conditions".
 *
 * Every figure is the API's own value, formatted. Fixed-point values (milli, basis points) are
 * written in their unit; nothing is ranked, scored or summed here.
 */

const MINUS = '−';

// --- links -------------------------------------------------------------------------------------

export const familyHref = (current: URL, rootId: string): string => siteHref(`/agents/${rootId}/family`, {}, current);
export const rivalryHref = (current: URL, id: string): string => siteHref(`/rivalries/${id}`, {}, current);
export const warHref = (current: URL, id: string): string => siteHref(`/wars/${id}`, {}, current);
export const managerHref = (current: URL, id: string): string => siteHref(`/managers/${id}`, {}, current);
export const forkHref = (current: URL, id: string): string => siteHref(`/build/fork/${id}`, {}, current);
export const profileMethodHref = (current: URL): string => siteHref('/methodology/strategy-profile', {}, current);

export function rivalriesHref(current: URL, options: { division?: Division; page?: number } = {}): string {
  return siteHref(
    '/rivalries',
    {
      division: options.division === 'pro' ? 'pro' : undefined,
      page: options.page && options.page > 1 ? String(options.page) : undefined,
    },
    current,
  );
}

export function listHref(current: URL, path: '/wars' | '/managers', page: number): string {
  return siteHref(path, { page: page > 1 ? String(page) : undefined }, current);
}

export function familyPageHref(current: URL, rootId: string, page: number): string {
  return siteHref(`/agents/${rootId}/family`, { page: page > 1 ? String(page) : undefined }, current);
}

// --- shared ------------------------------------------------------------------------------------

/** The sentence every Phase 6 page carries under its title. */
export function paperLine(): string {
  return text(
    'social.paperLine',
    'Paper trading simulation. Every figure here comes from simulated portfolios. No money is involved and nothing here is advice.',
  );
}

export function divisionWord(division: Division): string {
  return division === 'pro' ? text('social.divisionPro', 'Pro') : text('social.divisionOpen', 'Open');
}

/**
 * A fixed-point value written with `decimals` decimals: 4180 milli with 1 decimal is "4.2", and
 * -180 milli with 2 decimals and a sign is "−0.18". Integer arithmetic only; a half rounds away
 * from zero, and a value that rounds to zero has no sign.
 */
export function formatMilli(milli: number, decimals: 1 | 2, sign = false): string {
  const step = decimals === 1 ? 100 : 10;
  const units = Math.round(Math.abs(milli) / step);
  const scale = decimals === 1 ? 10 : 100;
  const body = `${formatCount(Math.floor(units / scale))}.${String(units % scale).padStart(decimals, '0')}`;
  if (units === 0) return body;
  if (milli < 0) return `${MINUS}${body}`;
  return sign ? `+${body}` : body;
}

export function confidenceText(confidence: 'insufficient' | 'low' | 'medium' | 'high' | null | undefined): string {
  switch (confidence) {
    case 'high':
      return text('social.rankConfidenceHigh', 'High confidence');
    case 'medium':
      return text('social.rankConfidenceMedium', 'Medium confidence');
    case 'low':
      return text('social.rankConfidenceLow', 'Low confidence');
    default:
      return text('social.rankConfidenceInsufficient', 'Too few days to rate confidence');
  }
}

// --- the strategy profile ----------------------------------------------------------------------

export interface DnaRow {
  key: string;
  label: string;
  /** What the axis measures, in one sentence. */
  about: string;
  /** The exact value as text, or null when the axis has none. */
  value: string | null;
  /** Where the dot sits on the fixed scale, from 0 to 1. Null draws no dot. */
  position: number | null;
  /** True when the value lies past the end of the scale: the dot sits on the end and says so. */
  beyond: boolean;
  start: string;
  end: string;
  /** Why there is no value, in words. */
  note: string | null;
  /** A second line of text inside the row: the implied holding period, in the turnover row. */
  extra: string | null;
}

/**
 * The fixed scale of each axis: the value at the left and right ends of its track. Fixed, so the
 * same dot means the same thing on every agent's page. They are not thresholds of anything.
 */
export const DNA_SCALES = {
  positionsMilli: { lo: 1000, hi: 20_000 },
  cashBps: { lo: 0, hi: 10_000 },
  turnoverBps: { lo: 0, hi: 20_000 },
  swingBps: { lo: 0, hi: 500 },
  deepestFallBps: { lo: 0, hi: 5000 },
  momentumMilli: { lo: -1000, hi: 1000 },
} as const;

function place(value: number | null, scale: { lo: number; hi: number }): { position: number | null; beyond: boolean } {
  if (value === null) return { position: null, beyond: false };
  const share = (value - scale.lo) / (scale.hi - scale.lo);
  return { position: Math.min(1, Math.max(0, share)), beyond: share > 1 || share < 0 };
}

export function dnaNoteText(note: DnaNote | null, axis: DnaAxis): string | null {
  switch (note) {
    case 'not_enough_history':
      return text('social.dnaNoteHistory', 'Not enough history yet: {n} of {min} days.', {
        n: formatCount(axis.sample),
        min: formatCount(axis.min),
      });
    case 'no_holdings':
      // Paper holdings, so a coin counts as much as a Stock Token (docs/CONTRACTS.md section 21).
      return text('social.dnaNoteOnlyCash', 'It held only cash on every day of the window.');
    case 'needs_market_history':
      return text(
        'social.dnaNoteMarket',
        'Not measured yet: the league needs 20 priced days of prices before the first day measured.',
      );
    case 'longer_than_window':
      return text('social.dnaNoteLonger', 'Longer than the window.');
    default:
      return null;
  }
}

/** The rows of the strategy profile, in the order of the contract. */
export function dnaRows(profile: DnaProfile): DnaRow[] {
  const { axes } = profile;
  // While the profile is forming, the panel says once how many days it has; a row repeats it
  // never (design review 6, finding 2). A different reason (the league's own history) still shows.
  const forming = profile.status === 'forming';
  const noteOf = (axis: DnaAxis): string | null =>
    forming && axis.note === 'not_enough_history' ? null : dnaNoteText(axis.note, axis);
  const row = (
    key: keyof typeof DNA_SCALES,
    label: string,
    about: string,
    format: (value: number) => string,
    start: string,
    end: string,
    extra: string | null = null,
  ): DnaRow => {
    const axis = axes[key];
    return {
      key,
      label,
      about,
      value: axis.value === null ? null : format(axis.value),
      ...place(axis.value, DNA_SCALES[key]),
      start,
      end,
      note: axis.value === null ? noteOf(axis) : null,
      extra,
    };
  };

  const holding = axes.holdingDays;
  const holdingText =
    holding.value !== null
      ? text('social.dnaHoldingValue', 'Implied holding period: {days} priced days.', {
          days: formatCount(holding.value),
        })
      : holding.note === 'longer_than_window'
        ? text('social.dnaHoldingLonger', 'Implied holding period: longer than the window.')
        : holding.note && noteOf(holding) !== null
          ? text('social.dnaHoldingNone', 'Implied holding period: {note}', {
              note: dnaNoteText(holding.note, holding) ?? '',
            })
          : null;

  return [
    row(
      'positionsMilli',
      text('social.dnaPositions', 'Effective positions'),
      text('social.dnaPositionsAbout', 'How many holdings its money was spread over, on an average day.'),
      (value) => text('social.dnaPositionsValue', '{n} positions', { n: formatMilli(value, 1) }),
      text('social.dnaPositionsStart', '1'),
      text('social.dnaPositionsEnd', '20'),
    ),
    row(
      'cashBps',
      text('social.dnaCash', 'Cash share'),
      text('social.dnaCashAbout', 'The average share of the portfolio kept in cash. SGOV counts as a holding.'),
      (value) => formatWeightBps(value),
      text('social.dnaCashStart', 'None'),
      text('social.dnaCashEnd', 'All cash'),
    ),
    row(
      'turnoverBps',
      text('social.dnaTurnover', 'Net turnover'),
      text('social.dnaTurnoverAbout', 'How much it traded every 20 priced days, net of round trips within a day.'),
      (value) =>
        text('social.dnaTurnoverValue', '{share} per 20 days', { share: formatPercentBps(value, { sign: false }) }),
      text('social.dnaTurnoverStart', '0%'),
      text('social.dnaTurnoverEnd', '200%'),
      holdingText,
    ),
    row(
      'swingBps',
      text('social.dnaSwing', 'Daily swing'),
      text('social.dnaSwingAbout', 'How far its value moved from one priced day to the next, as a standard deviation.'),
      (value) => formatPercentBps(value, { sign: false }),
      text('social.dnaSwingStart', '0%'),
      text('social.dnaSwingEnd', '5%'),
    ),
    row(
      'deepestFallBps',
      text('social.dnaFall', 'Deepest fall'),
      text('social.dnaFallAbout', 'The largest fall of its value from a high point within the window.'),
      (value) => formatDrawdownBps(value),
      text('social.dnaFallStart', '0%'),
      text('social.dnaFallEnd', '−50%'),
    ),
    row(
      'momentumMilli',
      text('social.dnaMomentum', 'Momentum tilt'),
      text(
        'social.dnaMomentumAbout',
        'Whether it held the symbols that had risen most or least over the previous 20 priced days.',
      ),
      (value) => formatMilli(value, 2, true),
      text('social.dnaMomentumStart', 'Held recent laggards'),
      text('social.dnaMomentumEnd', 'Held recent leaders'),
    ),
  ];
}

/** The footer of the profile: what it is measured from and what it is not (contract section 5.1). */
export function dnaFooter(profile: DnaProfile): string {
  return text(
    'social.dnaFooter',
    'Measured from {days} end-of-day rows of the paper portfolio, {start} to {end}, with method {method}. The window starts no earlier than the last change of strategy, on {since}. It describes what the agent did. It is not a score, a rank or a rating, and nothing is sorted by it.',
    {
      days: formatCount(profile.observedDays),
      start: formatDay(profile.windowStartDay),
      end: formatDay(profile.asOfDay),
      method: profile.method,
      since: formatDay(profile.strategySinceDay),
    },
  );
}

// --- rivalries ---------------------------------------------------------------------------------

/**
 * The two agents of a rivalry, the one ahead first, with each one's latest rank. Every page names
 * the pair in this order: the list, the rivalry's page and the agent's panel (design review 6, finding 13).
 */
export interface RivalrySide {
  name: string;
  id: string;
  rank: number | null;
  /** Which of the API's two agents this is: the index of its rank in each point of the series. */
  at: 1 | 2;
}

export function rivalrySides(rivalry: RivalryPublic): { ahead: RivalrySide; behind: RivalrySide } {
  const a: RivalrySide = { name: rivalry.agentA.name, id: rivalry.agentA.id, rank: rivalry.rankA, at: 1 };
  const b: RivalrySide = { name: rivalry.agentB.name, id: rivalry.agentB.id, rank: rivalry.rankB, at: 2 };
  return rivalry.leader === rivalry.agentB.id ? { ahead: b, behind: a } : { ahead: a, behind: b };
}

export function rankText(rank: number | null): string {
  return rank === null ? text('social.notRanked', 'not ranked') : `#${formatCount(rank)}`;
}

/** "Momentum Mule is ahead of Slow Compounder: #3 and #4 on 7 Oct." */
export function rivalryStanding(rivalry: RivalryPublic): string {
  const { ahead, behind } = rivalrySides(rivalry);
  if (rivalry.leader === null) {
    return text('social.rivalryNoLeader', 'Neither was ranked on {day}.', { day: formatDayShort(rivalry.lastDay) });
  }
  return text('social.rivalryAhead', '{ahead} is above {behind}: {aheadRank} and {behindRank} on {day}.', {
    ahead: ahead.name,
    behind: behind.name,
    aheadRank: rankText(ahead.rank),
    behindRank: rankText(behind.rank),
    day: formatDayShort(rivalry.lastDay),
  });
}

export function leadChangesText(count: number): string {
  return count === 1
    ? text('social.leadChangesOne', '1 change of place')
    : text('social.leadChangesOther', '{count} changes of place', { count: formatCount(count) });
}

export function rivalryStatusText(rivalry: RivalryPublic): string {
  if (rivalry.status === 'active') {
    return text('social.rivalryActiveSince', 'Close since {day}', { day: formatDayShort(rivalry.formedDay) });
  }
  if (rivalry.endReason === 'season_end') {
    return text('social.rivalryEndedOn', 'Ended on {day}', {
      day: formatDayShort(rivalry.endedDay ?? rivalry.lastDay),
    });
  }
  return text('social.rivalryEndedApart', 'Drifted apart on {day}', {
    day: formatDayShort(rivalry.endedDay ?? rivalry.lastDay),
  });
}

/** One event of a rivalry, as a sentence built from its kind and its integers. No model text. */
export function rivalryEventText(event: RivalryEvent, rivalry: RivalryPublic): string {
  const nameOf = (id: string | null): string =>
    id === rivalry.agentA.id ? rivalry.agentA.name : id === rivalry.agentB.id ? rivalry.agentB.name : '';
  const detail = event.detail;
  if (event.kind === 'formed') {
    return text(
      'social.eventFormed',
      'Became a rivalry: within {gap} of each other on {close} of the last {window} ranked days, with {swaps} changes of place.',
      {
        gap:
          (detail.gap ?? 1) === 1
            ? text('social.gapOne', 'one place')
            : text('social.gapOther', '{n} places', { n: formatCount(detail.gap ?? 0) }),
        close: formatCount(detail.closeDays ?? 0),
        window: formatCount(detail.windowDays ?? 0),
        swaps: formatCount(detail.swaps ?? 0),
      },
    );
  }
  if (event.kind === 'overtake') {
    const subject = event.subject;
    const other = subject === rivalry.agentA.id ? rivalry.agentB.id : rivalry.agentA.id;
    const subjectRank = subject === rivalry.agentA.id ? event.rankA : event.rankB;
    const otherRank = subject === rivalry.agentA.id ? event.rankB : event.rankA;
    return text('social.eventOvertake', '{subject} moved above {other}: {subjectRank} and {otherRank}.', {
      subject: nameOf(subject),
      other: nameOf(other),
      subjectRank: rankText(subjectRank),
      otherRank: rankText(otherRank),
    });
  }
  if (rivalry.endReason === 'season_end') {
    return text('social.eventEnded', 'Ended after {changes}.', {
      changes: leadChangesText(detail.leadChanges ?? rivalry.leadChanges),
    });
  }
  return text('social.eventEndedApart', 'Ended: close on only {close} of the last {window} ranked days.', {
    close: formatCount(detail.closeDays ?? 0),
    window: formatCount(detail.windowDays ?? 0),
  });
}

export function rivalryMethodText(method: string, division: Division): string {
  return text(
    'social.rivalryMethod',
    'Ranks are the official ranks of the {division} division under scoring {method}, recorded once a day after the last round. A gap is a day one of the two had no rank. A rivalry is a fact about two places in the table; it is not a contest and nothing is given for it.',
    { division: divisionWord(division), method },
  );
}

// --- model wars ------------------------------------------------------------------------------

export function warStatusText(status: WarStatus): string {
  switch (status) {
    case 'scheduled':
      return text('social.warScheduled', 'Scheduled');
    case 'running':
      return text('social.warRunning', 'Running');
    case 'complete':
      return text('social.warComplete', 'Complete');
    default:
      return text('social.warStopped', 'Stopped');
  }
}

export function stopReasonText(reason: WarStopReason | null): string {
  switch (reason) {
    case 'admin':
      return text('social.stopAdmin', 'Prix stopped it before its last day.');
    case 'prompt_changed':
      return text('social.stopPrompt', 'It stopped because the decision instructions changed while it ran.');
    case 'model_unavailable':
      return text(
        'social.stopModel',
        'It stopped because a provider rejected a model’s requests on two war-days in a row.',
      );
    case 'budget':
      return text(
        'social.stopBudget',
        'It stopped because the daily allowance for model calls did not let it finish its days before its deadline.',
      );
    default:
      return text('social.stopUnknown', 'It stopped before its last day.');
  }
}

export function providerText(provider: WarProvider): string {
  return provider === 'groq' ? text('social.providerGroq', 'Groq') : text('social.providerWorkersAi', 'Workers AI');
}

/** The status of one entrant on one war-day, in a word or two. */
export function warCellText(status: string, code: string | null): { word: string; detail: string | null } {
  if (status === 'decided') return { word: text('social.cellDecided', 'Decided'), detail: null };
  if (status === 'no_decision') {
    const known = noDecisionCodeSchema.safeParse(code);
    return {
      word: text('social.cellNoDecision', 'No decision'),
      detail: known.success ? (noDecisionText(known.data) ?? null) : code,
    };
  }
  const known = skipCodeSchema.safeParse(code);
  return {
    word: text('social.cellSkipped', 'Not asked'),
    detail: known.success ? (skippedText(known.data) ?? null) : code,
  };
}

/**
 * A model's settings in words: "At most 300 output tokens, thinking off". A setting Prix has no
 * words for is named as it is sent, so no condition of the run is left out.
 */
export function warSettingsText(maxOutputTokens: number, extra: Readonly<Record<string, unknown>>): string {
  const pieces = [
    text('social.settingsTokens', 'At most {tokens} output tokens', { tokens: formatCount(maxOutputTokens) }),
  ];
  for (const [name, value] of Object.entries(extra)) {
    const kwargs =
      name === 'chat_template_kwargs' && value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
    if (kwargs && Object.keys(kwargs).length === 1 && typeof kwargs.enable_thinking === 'boolean') {
      pieces.push(
        kwargs.enable_thinking
          ? text('social.settingsThinkingOn', 'thinking on')
          : text('social.settingsThinkingOff', 'thinking off'),
      );
    } else {
      pieces.push(`${name.replaceAll('_', ' ')} ${typeof value === 'string' ? value : JSON.stringify(value)}`);
    }
  }
  return pieces.join(', ');
}

// --- paper managers ----------------------------------------------------------------------------

/** The sentence every paper manager surface carries. It names no fund, on purpose. */
export function managerDefinition(): string {
  return text(
    'social.managerDefinition',
    'A paper manager is a simulated allocation across public agents. No money is involved, nobody can put money into it, and it is not advice.',
  );
}

export function managerStatusText(status: ManagerStatus): string {
  switch (status) {
    case 'active':
      return text('social.managerActive', 'Active');
    case 'paused':
      return text('social.managerPaused', 'Paused by its owner');
    default:
      return text('social.managerClosed', 'Closed');
  }
}

export function scheduleText(schedule: ManagerSchedule): string {
  return schedule === 'weekly'
    ? text('social.scheduleWeekly', 'Back to its weights every week')
    : text('social.scheduleHold', 'Set once, then held');
}

export function rebalanceReasonText(reason: RebalanceReason): string {
  switch (reason) {
    case 'start':
      return text('social.reasonStart', 'First allocation');
    case 'policy':
      return text('social.reasonPolicy', 'New weights from its owner');
    case 'scheduled':
      return text('social.reasonScheduled', 'Weekly return to its weights');
    default:
      return text('social.reasonExit', 'An agent left: it had no value for three days in a row');
  }
}

export function allocationStateText(state: ManagerDetailResponse['allocation'][number]['state']): string {
  switch (state) {
    case 'valued':
      return text('social.allocValued', 'Valued');
    case 'no_point_today':
      return text('social.allocNoPoint', 'No value on the latest day: held at its last value');
    default:
      return text('social.allocExited', 'Left the allocation');
  }
}

/** The volatility of a paper manager: daily, not annualised, from the API's milli basis points. */
export function volText(volMilliBps: number): string {
  return formatPercentBps(Math.round(volMilliBps / 1000), { sign: false });
}

// --- sentences with links ----------------------------------------------------------------------

/** A piece of a sentence: plain text, or a link inside it. */
export type Part = string | { text: string; href: string };

/**
 * A sentence of the deck whose slots are text or links: "Fork of {parent} by {owner}." becomes
 * ["Fork of ", { text, href }, " by 0x51d0…8e2b."]. A page renders each piece as text or as a
 * link, so a name from a user is never HTML. `template` is the deck's sentence with its slots
 * unfilled: `parts(text('social.forkOf', 'Fork of {parent} by {owner}.'), slots)`.
 */
export function parts(template: string, slots: Record<string, Part>): Part[] {
  const pieces: Part[] = [];
  let at = 0;
  for (const match of template.matchAll(/\{(\w+)\}/g)) {
    const name = match[1] ?? '';
    const index = match.index ?? 0;
    if (index > at) pieces.push(template.slice(at, index));
    const slot = slots[name];
    pieces.push(slot !== undefined && Object.hasOwn(slots, name) ? slot : match[0]);
    at = index + match[0].length;
  }
  if (at < template.length) pieces.push(template.slice(at));
  return pieces;
}
