import type { FeedItem, TapeResponse } from '@prix/contracts';
import { TAPE_ROWS } from '@prix/contracts';
import { formatCount, formatTick, formatUsdMicro } from '../../content/format.ts';
import { text } from '../../content/index.ts';
import { divisionText } from '../../content/states.ts';
import { agentHref, siteHref } from '../words.ts';

/**
 * The words of the holders' tape (docs/contracts/phase-6-holders-2.md, sections 3.2 and 7). Server only:
 * this file reads the copy deck. Every sentence is the editor's key; each draft is the contract's own
 * sentence for that key (HOLDERS2_PAGE_WORDS). Which sentence stands is decided by the API's answer and by
 * nothing the page works out: its `view` and its `delay.gatingOn`.
 */

/** The page itself, for the link from /league. It carries no query of the page it is rendered on. */
export const tapeHref = (current: URL): string => siteHref('/tape', {}, current);

export function tapeTitle(): string {
  return text('tape.title', 'Decision tape');
}

export function tapeDescription(): string {
  return text(
    'tape.description',
    'Every agent’s newest decisions in one place: what each paper portfolio changed and the reason its agent gave, newest first.',
  );
}

/**
 * The one sentence that says whose view this is. The rows are the server's, cut by its delay, so the
 * sentence follows the answer: `delayed` rows are a day old whatever else is true; `live` rows with the
 * gate on are a holder's; `live` rows with the gate off are everyone's.
 */
export function tapeViewSentence(answer: Pick<TapeResponse, 'view' | 'delay'>): string {
  if (answer.view === 'delayed') {
    return text(
      'tape.viewDelayed',
      'Decisions appear here 24 hours after they are made. A wallet that holds at least 10,000 $PRIX sees them as they are made.',
    );
  }
  if (answer.delay.gatingOn) {
    return text(
      'tape.viewLive',
      'Your wallet holds at least 10,000 $PRIX, so paper decisions show here when they are made.',
    );
  }
  return text('tape.viewOpen', 'Decisions appear here as they are made.');
}

export function tapeLiveHold(): string {
  return text(
    'tape.liveHold',
    'An agent linked to Prix Live shows each day’s decisions from 20:00 UTC, for everyone, holders included.',
  );
}

/** How far back the newest TAPE_ROWS decisions reach. `{count}` is the contract's figure, never a count of rows. */
export function tapeScale(): string {
  return text(
    'tape.scale',
    'Each agent decides at most a few times a day, so the newest {count} decisions reach back a few days.',
    { count: formatCount(TAPE_ROWS) },
  );
}

export function tapeNotAdvice(): string {
  return text(
    'tape.notAdvice',
    'These are decisions of AI agents that run paper portfolios. Reasons are written by a model from each owner’s strategy. Nothing here is advice.',
  );
}

/**
 * The tape's head says the simulation only: the sentence that nothing is advice is tape.notAdvice's, said once
 * above the list (DC-H2-1).
 */
export function tapePaper(): string {
  return text('share.simulationSentence', 'Paper trading simulation.');
}

/** The empty tape's one way onward (DC-H2-5): the league, with the words the 404 page uses. */
export function tapeToLeague(): string {
  return text('errors.goToLeague', 'Go to the league');
}

export const tapeLeagueHref = (current: URL): string => siteHref('/league', {}, current);

export function tapeEmpty(): string {
  return text('tape.empty', 'No decision to show yet.');
}

export function tapeFromLeague(): string {
  return text('tape.fromLeague', 'See every agent’s newest decisions on the tape');
}

/** What a row of the tape shows: the parts of the design system's FeedRow, in the feeds' own words. */
export interface TapeRowView {
  agent: {
    id: string;
    name: string;
    href: string;
    chips: Array<{ label: string; kind: 'open' | 'pro' | 'house' }>;
  };
  time: { iso: string; label: string };
  what: string;
  detail?: string;
  why: string;
  tag: string;
  'data-key': string;
}

/**
 * The rows, in the order the API gave them (newest tick first, then agent id). Nothing here sorts, filters,
 * ranks or judges: a fill is "Added" or "Reduced" with its virtual amount, in the neutral words of every
 * feed, and the reason is the agent's own text, printed as text.
 */
export function tapeRows(items: readonly FeedItem[], current: URL): TapeRowView[] {
  const house = text('common.house', 'House');
  const tag = text('agent.simulationRecord', 'Simulation record');
  return items.map((item) => {
    const fills = item.fills.map((fill) => {
      const values = { symbol: fill.symbol, amount: formatUsdMicro(fill.notionalMicro) };
      return fill.side === 'buy'
        ? text('follow.fillAdded', 'Added {symbol}, {amount} in virtual USD', values)
        : text('follow.fillReduced', 'Reduced {symbol}, {amount} in virtual USD', values);
    });
    return {
      agent: {
        id: item.agentId,
        name: item.agentName,
        href: agentHref(current, item.agentId),
        chips: [
          { label: divisionText(item.division), kind: item.division },
          ...(item.house ? [{ label: house, kind: 'house' as const }] : []),
        ],
      },
      time: { iso: item.at, label: formatTick(item.tickId) },
      what:
        fills.length > 0
          ? text('follow.changedPortfolio', 'Changed the paper portfolio')
          : text('follow.keptPortfolio', 'Kept the paper portfolio as it was'),
      ...(fills.length > 0 ? { detail: `${fills.join('. ')}.` } : {}),
      why: item.reason,
      tag,
      'data-key': `${item.tickId}~${item.agentId}`,
    };
  });
}
