import { type AgentPublic, containsAdviceWord, SHARE_DESCRIPTION_MAX, SHARE_TITLE_MAX } from '@prix/contracts';
import { formatCount, formatPercentBps } from '../../content/format.ts';
import { text } from '../../content/index.ts';
import { divisionText } from '../../content/states.ts';

/**
 * The text of a link preview for an agent's page (docs/contracts/phase-3-follow.md section 5).
 * D-109: the league is one continuous league, so a preview names no season. Every figure is the API's own value, formatted
 * by content/format.ts. Nothing here is an instruction: a name that contains a word of an
 * instruction is replaced by a neutral word, so no preview can read as advice.
 */

export interface ShareText {
  title: string;
  description: string;
}

const ELLIPSIS = '…';

/** A name that is safe to put in a preview. The name schema allows words like "Should Win". */
function safeName(name: string): string {
  return containsAdviceWord(name) ? text('share.neutralName', 'An agent') : name;
}

/** The title with `name` shortened, if it must be, so that the label after the name survives. */
function fitTitle(name: string, rest: (name: string) => string): string {
  const whole = rest(name);
  if (whole.length <= SHARE_TITLE_MAX) return whole;
  const over = whole.length - SHARE_TITLE_MAX;
  const keep = Math.max(1, name.length - over - ELLIPSIS.length);
  return rest(`${name.slice(0, keep).trimEnd()}${ELLIPSIS}`).slice(0, SHARE_TITLE_MAX);
}

/** Joins the sentences, dropping the middle ones first when the whole is too long. */
function fitDescription(first: string, middle: string[], last: string): string {
  const join = (parts: string[]) => parts.join(' ');
  const kept = [...middle];
  while (kept.length > 0 && join([first, ...kept, last]).length > SHARE_DESCRIPTION_MAX) kept.pop();
  return join([first, ...kept, last]);
}

export function agentShare(agent: AgentPublic, rankedCount: number): ShareText {
  const name = safeName(agent.name);
  const title = fitTitle(name, (shown) =>
    agent.rank === null
      ? text('share.agentTitleUnranked', '{name}: paper portfolio, not yet ranked', { name: shown })
      : text('share.agentTitleLeague', '{name}: rank {rank} of {ranked}, return {return}', {
          name: shown,
          rank: formatCount(agent.rank),
          ranked: formatCount(rankedCount),
          return: formatPercentBps(agent.stats.seasonReturnBps),
        }),
  );
  const description = fitDescription(
    text('share.simulationSentence', 'Paper trading simulation.'),
    [
      text('share.agentFactsLeague', '{division} division, {days} trading days.', {
        division: divisionText(agent.division),
        days: formatCount(agent.stats.tradingDays),
      }),
    ],
    text('share.notAdviceSentence', 'Not investment advice.'),
  );
  return { title, description };
}
