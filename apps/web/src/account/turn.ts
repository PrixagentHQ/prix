import type { DecisionPublic } from '@prix/contracts';
import { noDecisionCodeSchema, skipCodeSchema } from '@prix/contracts';
import { formatTick } from '../content/format.ts';
import { text } from '../content/index.ts';
import {
  noDecisionOwnerText,
  noDecisionText,
  rowStatusText,
  skippedOwnerText,
  skippedText,
} from '../content/states.ts';

/**
 * An agent's latest turn in words, for its owner. The sentence anyone may read comes first;
 * the sentence that tells the owner what to do follows it, and is shown on the account page
 * only (docs/CONTRACTS.md section 15). Server only.
 */
export interface TurnWords {
  /** "No decision, round of 6 Oct, 15:00 UTC" */
  heading: string;
  /** What happened and, where the owner can act, what to do. */
  lines: string[];
  /** The agent's own reason for a decision. A model wrote it: render it as text. */
  reason: string | null;
}

function symbols(decision: DecisionPublic, side: 'buy' | 'sell'): string {
  return [...new Set(decision.fills.filter((fill) => fill.side === side).map((fill) => fill.symbol))].join(', ');
}

export function turnWords(decision: DecisionPublic): TurnWords {
  const heading = text('account.turnHeading', '{status}, round of {time}', {
    status: rowStatusText(decision.status),
    time: formatTick(decision.tickId),
  });

  if (decision.status === 'decided') {
    const bought = symbols(decision, 'buy');
    const sold = symbols(decision, 'sell');
    const lines: string[] = [];
    if (bought) lines.push(text('account.turnBought', 'Bought {symbols}.', { symbols: bought }));
    if (sold) lines.push(text('account.turnSold', 'Sold {symbols}.', { symbols: sold }));
    if (lines.length === 0) {
      lines.push(text('account.turnNoTrades', 'The agent made no trades and kept its portfolio as it was.'));
    }
    return { heading, lines, reason: decision.reason };
  }

  if (decision.status === 'no_decision') {
    const code = noDecisionCodeSchema.safeParse(decision.code);
    const lines = code.success
      ? [noDecisionText(code.data), noDecisionOwnerText(code.data)]
      : [
          text(
            'account.turnNoDecision',
            'The agent made no decision in this round, so its portfolio was left unchanged.',
          ),
        ];
    return { heading, lines, reason: null };
  }

  const code = skipCodeSchema.safeParse(decision.code);
  const lines = code.success
    ? [skippedText(code.data), skippedOwnerText(code.data)]
    : [text('account.turnSkipped', 'The agent was skipped in this round, so its portfolio was left unchanged.')];
  return { heading, lines, reason: null };
}
