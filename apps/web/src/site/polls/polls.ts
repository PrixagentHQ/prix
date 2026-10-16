// The words of /polls that depend on what GET /api/polls returned (docs/contracts/phase-6-holders.md
// sections 4.4 and 4.5). Pure: every count, every leader and every state is the API's; the page only
// chooses the sentence and fills its slots. Never "winner", "governance" or "DAO".
import type { PollPublic } from '@prix/contracts';
import { grouped } from '../../content/facts.ts';
import { formatDateTimeUtc } from '../../content/format.ts';
import { text } from '../../content/index.ts';

/** What the page needs to hand the vote control (web-account, apps/web/src/account/polls/**). */
export interface PollControlProps {
  /** The open poll's id. */
  pollId: string;
  /** Its options, in the poll's order. Each option's row on the page carries `[data-poll-vote="<id>"]`. */
  options: { id: string; name: string }[];
  /** Whether the visitor's request carries a session, as the site's session read says. */
  signedIn: boolean;
  /** The tier-1 amount in whole tokens, from GET /api/polls's `minTokens`. */
  minTokens: number;
  /** Where "Sign in to vote" leads: the sign-in page, back to /polls. */
  signInHref: string;
}

/** A time for a `{time} UTC` slot: "21 Oct 2026, 20:00" (the sentence says UTC itself). */
export function pollTime(iso: string): string {
  return formatDateTimeUtc(iso).replace(/ UTC$/, '');
}

/** The amount for an `{amount}` slot, in whole tokens. */
export function pollAmount(value: number): string {
  return grouped(value);
}

/** "{count} votes cast", with its singular. */
export function castLabel(count: number): string {
  return count === 1
    ? text('polls.castCountOne', '1 vote cast')
    : text('polls.castCount', '{count} votes cast', { count: grouped(count) });
}

/** "{count} counted", with its singular. */
export function countedLabel(count: number): string {
  return count === 1
    ? text('polls.countedCountOne', '1 counted')
    : text('polls.countedCount', '{count} counted', { count: grouped(count) });
}

/** What the words need of a poll: its options' ids and names, in the poll's order. */
type PollOptions = { options: readonly { id: string; name: string }[] };

/** An option's public name by its id, as the poll lists it; the id itself if the poll does not. */
export function optionName(poll: PollOptions, id: string): string {
  return poll.options.find((option) => option.id === id)?.name ?? id;
}

/** Names joined as English lists them: "A and B", "A, B and C". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return new Intl.ListFormat('en-GB', { style: 'long', type: 'conjunction' }).format(names);
}

/**
 * The line of a counted poll, from the API's `leaders`: none counted, one option chosen, or a tie that Prix
 * settles in its posts. Never "winner".
 */
export function outcomeLine(poll: PollOptions, leaders: readonly string[]): string {
  if (leaders.length === 0) return text('polls.noneCounted', 'No vote was counted.');
  if (leaders.length === 1) {
    return text('polls.chosen', 'Chosen: {option}', { option: optionName(poll, leaders[0] ?? '') });
  }
  return text('polls.tie', 'A tie between {options}. Prix picks one of them and says which in its posts.', {
    options: joinNames(leaders.map((id) => optionName(poll, id))),
  });
}

/** A count by option, zero for an option the API sent no figure for. */
export function countOf(counts: Readonly<Record<string, number>> | null | undefined, id: string): number {
  return counts?.[id] ?? 0;
}

/**
 * A bar's share for display only: the option's count against the total of the same figure (cast while open,
 * counted after the close), 0 when the total is 0. A bar is a share of a whole, so the leader is drawn whole
 * only when it holds every vote (HB-DC-2).
 */
export function barShare(counts: Readonly<Record<string, number>> | null | undefined, id: string): number {
  const total = Object.values(counts ?? {}).reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
  return total > 0 ? countOf(counts, id) / total : 0;
}

/** The open poll, and the closed ones in the API's order (newest close first). */
export function splitPolls(polls: readonly PollPublic[]): { open: PollPublic | null; closed: PollPublic[] } {
  return {
    open: polls.find((poll) => poll.state === 'open') ?? null,
    closed: polls.filter((poll) => poll.state !== 'open'),
  };
}
