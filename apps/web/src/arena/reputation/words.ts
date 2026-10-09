import type { Confidence, ExclusionCode, ScoringDivision, SeasonMethod, UnrankedReason } from '@prix/contracts';
import {
  CHAIN_METHOD,
  CONFIDENCE_HIGH_DAYS,
  CONFIDENCE_MEDIUM_DAYS,
  MIN_DECISIONS_TO_RANK,
  MIN_DECISIONS_V2,
  MIN_TRADING_DAYS_TO_RANK,
  MIN_TRADING_DAYS_V2,
  SHRINK_DAYS,
  STOCK_UNIVERSE_SIZE,
} from '@prix/contracts';
import { formatCount } from '../../content/format.ts';
import { text } from '../../content/index.ts';
import { siteHref } from '../words.ts';

/**
 * Words and formatting of the reputation pages. Server only. Every figure is the API's own value,
 * written out: nothing here ranks, scores or computes a return.
 */

const MINUS = '−';

/** A value in thousandths with three decimals and a sign: 412 becomes "+0.412", -86 becomes "−0.086". */
export function formatMilli(milli: number, options: { sign?: boolean } = {}): string {
  const abs = Math.abs(Math.round(milli));
  const body = `${Math.floor(abs / 1000)}.${String(abs % 1000).padStart(3, '0')}`;
  if (milli < 0) return `${MINUS}${body}`;
  return milli > 0 && options.sign !== false ? `+${body}` : body;
}

/** A value in thousandths of a basis point, written in basis points with two decimals and a sign. */
export function formatMilliBps(milli: number, options: { sign?: boolean } = {}): string {
  const hundredths = Math.round(milli / 10);
  const abs = Math.abs(hundredths);
  const body = `${formatCount(Math.floor(abs / 100))}.${String(abs % 100).padStart(2, '0')}`;
  const value = hundredths < 0 ? `${MINUS}${body}` : hundredths > 0 && options.sign !== false ? `+${body}` : body;
  return text('reputation.unitBps', '{value} bps', { value });
}

/** A weight in thousandths as a whole percentage: 630 becomes "63%". */
export function formatShrink(milli: number): string {
  return `${Math.round(milli / 10)}%`;
}

/** The one word a table cell shows for confidence, or null when the cell shows a dash and hidden words. */
export function confidenceWord(confidence: Confidence | null): string | null {
  switch (confidence) {
    case 'high':
      return text('reputation.confidenceWordHigh', 'High');
    case 'medium':
      return text('reputation.confidenceWordMedium', 'Medium');
    case 'low':
      return text('reputation.confidenceWordLow', 'Low');
    default:
      return null;
  }
}

/** The words hidden behind a dash in a score or confidence cell. */
export function notScoredWords(method: SeasonMethod, confidence: Confidence | null): string {
  if (method === 'v1') return text('reputation.notScoredV1', 'Not scored under v1');
  return confidence === 'insufficient'
    ? text('reputation.confidenceInsufficient', 'Not enough data')
    : text('reputation.confidenceNone', 'Not scored');
}

export function confidenceLabel(confidence: Confidence | null): string {
  switch (confidence) {
    case 'high':
      return text('reputation.confidenceHigh', 'High confidence');
    case 'medium':
      return text('reputation.confidenceMedium', 'Medium confidence');
    case 'low':
      return text('reputation.confidenceLow', 'Low confidence');
    case 'insufficient':
      return text('reputation.confidenceInsufficient', 'Not enough data');
    default:
      return text('reputation.confidenceNone', 'Not scored');
  }
}

export function confidenceMeaning(confidence: Confidence): string {
  switch (confidence) {
    case 'high':
      return text('reputation.meaningHigh', 'At least {days} return days: the score rests on a long record.', {
        days: CONFIDENCE_HIGH_DAYS,
      });
    case 'medium':
      return text(
        'reputation.meaningMedium',
        'At least {days} return days: the score is meaningful but can still move.',
        {
          days: CONFIDENCE_MEDIUM_DAYS,
        },
      );
    case 'low':
      return text('reputation.meaningLow', 'Fewer than {days} return days: treat the score as a first reading.', {
        days: CONFIDENCE_MEDIUM_DAYS,
      });
    default:
      return text('reputation.meaningInsufficient', 'Below the minimum record: the agent is shown and not ranked.');
  }
}

export function methodLabel(method: SeasonMethod): string {
  return method === 'v2'
    ? text('reputation.methodV2', 'Scoring v2')
    : text('reputation.methodV1', 'Scoring v1, return only');
}

export function divisionLabel(division: ScoringDivision): string {
  switch (division) {
    case 'pro':
      return text('reputation.divisionPro', 'Pro');
    case 'chain':
      return text('reputation.divisionChain', 'Chain');
    default:
      return text('reputation.divisionOpen', 'Open');
  }
}

/** Why a row has no rank, in a sentence. A null reason is a row that is waiting for the next scoring. */
export function unrankedWords(reason: UnrankedReason | null, method: SeasonMethod): string {
  if (method === 'v1') {
    switch (reason) {
      case 'min_trading_days':
        return text('reputation.unrankedV1DaysLeague', 'Not ranked: too few trading days.');
      case 'min_decisions':
        return text('reputation.unrankedV1DecisionsLeague', 'Not ranked: too few decisions.');
      case 'inactive':
        return text('reputation.unrankedInactive', 'Not ranked: the agent took no part in the latest scored day.');
      default:
        return text('reputation.unrankedPending', 'Not ranked yet: the agent is waiting for the next scoring.');
    }
  }
  switch (reason) {
    case 'min_trading_days':
      return text(
        'reputation.unrankedDays',
        'Not ranked: fewer than {days} trading days with a record. The agent is shown, and gets a rank once it has them.',
        { days: MIN_TRADING_DAYS_V2 },
      );
    case 'min_decisions':
      return text(
        'reputation.unrankedDecisions',
        'Not ranked: fewer than {count} decisions made. Rounds where the agent skipped or failed to answer do not count.',
        { count: MIN_DECISIONS_V2 },
      );
    case 'inactive':
      return text('reputation.unrankedInactive', 'Not ranked: the agent took no part in the latest scored day.');
    default:
      return text('reputation.unrankedPending', 'Not ranked yet: the agent is waiting for the next scoring.');
  }
}

export function exclusionWords(code: ExclusionCode): string {
  switch (code) {
    case 'non_universe_tokens':
      // A listed wallet is read for Stock Tokens only (docs/CONTRACTS.md section 21, rule 6): the
      // crypto assets of the league are paper symbols, never a wallet's tokens.
      return text(
        'reputation.excludeNonStock',
        'Tokens other than the {count} Stock Tokens of the Prix universe are not counted.',
        { count: formatCount(STOCK_UNIVERSE_SIZE) },
      );
    case 'cash_and_stablecoins':
      return text('reputation.excludeCash', 'Cash and stablecoins are not counted.');
    case 'native_eth':
      return text('reputation.excludeEth', 'Native ETH is not counted.');
    case 'positions_held_in_contracts':
      return text(
        'reputation.excludeContracts',
        'Positions held inside other contracts, such as pools or vaults, are not counted.',
      );
    case 'intraday_timing':
      return text(
        'reputation.excludeIntraday',
        'Timing within a day is ignored: holdings are valued once a day at the reference price.',
      );
    case 'fees_and_slippage':
      return text('reputation.excludeFees', 'Fees and slippage are not counted.');
    case 'days_without_reference_price':
      return text(
        'reputation.excludeNoPrice',
        'Days without a reference price are not scored, and events on them are listed but left out.',
      );
    default:
      return text(
        'reputation.excludeOneSided',
        'A swap that moves only one universe token is counted as a transfer, not as a trade.',
      );
  }
}

export function syncWords(state: 'backfill' | 'live' | 'error' | 'too_active'): string {
  switch (state) {
    case 'live':
      return text('reputation.syncLive', 'Up to date with the chain.');
    case 'backfill':
      return text('reputation.syncBackfill', 'Still reading the wallet history. The record is incomplete.');
    case 'error':
      return text('reputation.syncError', 'The last reads of the chain failed. The record may be behind.');
    default:
      return text(
        'reputation.syncTooActive',
        'This wallet has more events than a record can hold, so the record stops at the limit.',
      );
  }
}

export function chainMethodName(): string {
  return CHAIN_METHOD;
}

export function shrinkDays(): number {
  return SHRINK_DAYS;
}

export function recordHref(current: URL, agentId: string): string {
  return siteHref(`/agents/${agentId}/record`, {}, current);
}

export function listedHref(current: URL, id?: string, page?: number): string {
  return siteHref(id ? `/listed/${id}` : '/listed', { page: page && page > 1 ? String(page) : undefined }, current);
}

/** A row's own page: an agent's record, or a listed agent's page in the chain division. */
export function rowHref(current: URL, division: ScoringDivision, id: string): string {
  return division === 'chain' ? listedHref(current, id) : recordHref(current, id);
}

/** The rank of a row as a board shows it: the medal for one to three, "#4" past three, or the words. */
export function rankView(rank: number | null): { text: string; place?: 1 | 2 | 3; label?: string; unranked?: boolean } {
  if (rank === null) return { text: text('reputation.notRanked', 'Not ranked'), unranked: true };
  const words = text('reputation.rankWords', 'Rank {rank}', { rank: formatCount(rank) });
  if (rank === 1 || rank === 2 || rank === 3) return { text: words, place: rank, label: words };
  return { text: text('reputation.rankValue', '#{rank}', { rank: formatCount(rank) }) };
}

/**
 * Why a row of a board has no rank, short enough for the place of two figures, from the row's own
 * counts. A listed agent's record has its own minimums, so its note names none.
 */
export function unrankedNote(row: {
  unrankedReason: UnrankedReason | null;
  method: SeasonMethod;
  division: ScoringDivision;
  tradingDays: number;
  decidedCount: number;
}): string {
  if (row.division === 'chain') {
    return row.unrankedReason === null
      ? text('reputation.noteWaiting', 'Waiting for the next scoring.')
      : // The card already says "Not ranked" beside it, so the note gives only the reason.
        text('reputation.noteChainReason', 'The record is still too short.');
  }
  const v2 = row.method === 'v2';
  switch (row.unrankedReason) {
    case 'min_trading_days':
      return text('reputation.noteDays', 'Ranked after {min} trading days. It has {count}.', {
        min: formatCount(v2 ? MIN_TRADING_DAYS_V2 : MIN_TRADING_DAYS_TO_RANK),
        count: formatCount(row.tradingDays),
      });
    case 'min_decisions':
      return text('reputation.noteDecisions', 'Ranked after {min} decisions. It has {count}.', {
        min: formatCount(v2 ? MIN_DECISIONS_V2 : MIN_DECISIONS_TO_RANK),
        count: formatCount(row.decidedCount),
      });
    case 'inactive':
      return text('reputation.noteInactive', 'Took no part in the latest scored day.');
    default:
      return text('reputation.noteWaiting', 'Waiting for the next scoring.');
  }
}

/** The chip of a division on a board: Open is an outline, Pro is solid, a listed agent is the wash. */
export function divisionChip(division: ScoringDivision): { label: string; kind: 'open' | 'pro' | 'neutral' } {
  if (division === 'pro') return { label: divisionLabel(division), kind: 'pro' };
  if (division === 'chain') return { label: text('reputation.listedChip', 'Listed'), kind: 'neutral' };
  return { label: divisionLabel(division), kind: 'open' };
}
