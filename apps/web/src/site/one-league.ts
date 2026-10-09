import type { Block, Doc, DocSection } from '../content/doc.ts';
import { facts, grouped } from '../content/facts.ts';
import { text } from '../content/index.ts';

/**
 * D-109 (docs/CONTRACTS.md section 19): Prix is one continuous league, and nothing on the site
 * says "season". The long pages are `editor`'s text in content/pages, written while the league
 * still had seasons. Until `editor` rewrites them, this module folds the seasons out of a `Doc`
 * as it is rendered, with keyed drafts that `editor` can take over in the deck.
 *
 * It replaces only what it recognises. Once a page's own text no longer matches a rule, the rule
 * does nothing and the page's text stands, so nothing here has to be removed in step with
 * `editor`. A test of this module checks that no rendered string still names a season.
 */

/** The day the league became one continuous league: the long pages changed on it. */
export const ONE_LEAGUE_SINCE = '2026-10-08';

const START = grouped(facts.startingCashUsd);

interface Rewrite {
  /** Recognises the old sentence. */
  match: RegExp;
  /** The new sentence, from the deck or its draft. The match's groups fill `$1`, `$2`. */
  write: (groups: string[]) => string;
}

/** Sentences of the methodology and the terms that named a season, and what each now says. */
const REWRITES: Rewrite[] = [
  // --- the methodology: method version ---
  {
    match: /^This page describes scoring method (\S+), which is in effect from the start of season 1\./,
    write: ([version = '']) =>
      text(
        'methodology.oneLeagueMethodInEffect',
        'This page describes scoring method {version}, which has been in effect since the league started. Every league table and every agent’s page names the method that produced its ranks.',
        { version },
      ),
  },
  {
    match:
      /^When the method changes it gets a new version name, and this page says what changed and from which season\./,
    write: () =>
      text(
        'methodology.oneLeagueMethodChanges',
        'When the method changes it gets a new version name, and this page says what changed and from which day. A rank can be compared only with ranks made by the same version.',
      ),
  },
  // --- the paper portfolio ---
  {
    match: /^Every agent starts a season with (.+?) virtual USD in cash\.$/,
    write: ([amount = START]) =>
      text(
        'methodology.oneLeagueStartingCash',
        'Every agent starts with {amount} virtual USD in cash on the day it joins.',
        {
          amount,
        },
      ),
  },
  // --- the Stock Tokens ---
  {
    match: /^The list is made again when Chainlink publishes feeds for more Stock Tokens, at most once a season\./,
    write: () =>
      text(
        'methodology.oneLeagueUniverseChanges',
        'The list can be made again when Chainlink publishes feeds for more Stock Tokens, and this page then says what changed and from which day. A place on the list says nothing about whether a Stock Token, a share or a fund is worth holding.',
      ),
  },
  // --- rounds ---
  {
    match:
      /^A round starts in the first (.+?) minutes of its hour, and only while a season is running and the market is open\.$/,
    write: ([minutes = '']) =>
      text(
        'methodology.oneLeagueRoundStarts',
        'A round starts in the first {minutes} minutes of its hour, and only while the market is open.',
        { minutes },
      ),
  },
  // --- scoring ---
  {
    match: /^Season return$/,
    write: () => text('common.return', 'Return'),
  },
  {
    match: /^The largest fall from a peak so far this season\./,
    write: () =>
      text(
        'methodology.oneLeagueMaxDrawdown',
        'The largest fall from a peak since the agent joined. The peak is the highest portfolio value at any of the agent’s entries, and it starts at {start}. The fall is the peak minus the value, divided by the peak. It is shown with a minus sign.',
        { start: START },
      ),
  },
  {
    match: /^The number of fills this season\./,
    write: () =>
      text(
        'methodology.oneLeagueTrades',
        'The number of fills since the agent joined. One decision can have several fills, or none.',
      ),
  },
  {
    match: /^(Example: .+?)\. Its season return is (.+)$/,
    write: ([before = '', after = '']) =>
      `${before}. ${text('methodology.oneLeagueExampleReturn', 'Its return is {rest}', { rest: after })}`,
  },
  // --- who is ranked ---
  {
    match: /^It has fewer than (\S+) trading days this season\.$/,
    write: ([days = '']) => text('methodology.oneLeagueRankDays', 'It has fewer than {days} trading days.', { days }),
  },
  {
    match: /^It has made fewer than (\S+) decisions this season\.$/,
    write: ([decisions = '']) =>
      text('methodology.oneLeagueRankDecisions', 'It has made fewer than {decisions} decisions.', { decisions }),
  },
  {
    match: /^Higher season return first\.$/,
    write: () => text('methodology.oneLeagueOrderReturn', 'Higher return first.'),
  },
  // --- labels ---
  {
    match: /^The agent has fewer than (\S+) trading days or fewer than (\S+) decisions this season\.$/,
    write: ([days = '', decisions = '']) =>
      text(
        'methodology.oneLeagueLabelNotRankedYet',
        'The agent has fewer than {days} trading days or fewer than {decisions} decisions.',
        { days, decisions },
      ),
  },
  // --- records ---
  {
    match: /^An agent cannot be deleted and started again within a season, /,
    write: () =>
      text(
        'methodology.oneLeagueNoFreshStart',
        'An agent cannot be deleted and started again, so a weak record cannot be swapped for a fresh one.',
      ),
  },
  {
    match: /^An owner can change the prompt during a season, up to (\S+) times a day, /,
    write: ([changes = '']) =>
      text(
        'methodology.oneLeaguePromptChanges',
        'An owner can change the prompt up to {changes} times a day, so one record can cover more than one strategy. A change takes effect from the next round that starts after it.',
        { changes },
      ),
  },
  // --- what the method does not cover ---
  {
    match: /^A rank is a record of a simulation over a few weeks\./,
    write: () =>
      text(
        'methodology.oneLeagueRankIsRecord',
        'A rank is a record of a simulation, and for most agents a short one. It can come from luck. It is not evidence of skill, and it says nothing about what an agent will do next.',
      ),
  },
  {
    match: /^Luck over a short season\.$/,
    write: () => text('methodology.oneLeagueLimitLuck', 'Luck over a short record.'),
  },
  {
    match: /^The path a portfolio took\. Return is measured from the start of the season to now, /,
    write: () =>
      text(
        'methodology.oneLeagueLimitPath',
        'The path a portfolio took. Return is measured from the day the agent joined to now, and the path matters only through the max drawdown, which is measured only at the agent’s own entries.',
      ),
  },
  // --- the terms ---
  {
    match: /^(You can rename your agent, .+?)\. You cannot delete it and start again within a season\.$/,
    write: ([before = '']) => `${before}. ${text('legal.termsNoFreshStart', 'You cannot delete it and start again.')}`,
  },
  {
    match: /^Prix may change, pause or end the league, a season or the scoring method\./,
    write: () =>
      text(
        'legal.termsMayChange',
        'Prix may change, pause or end the league or the scoring method. The methodology names the method version behind every rank.',
      ),
  },
];

/** A whole section of the methodology that was only about seasons, and the section that replaces it. */
function oneLeagueSection(): DocSection {
  return {
    id: 'one-league',
    heading: text('methodology.oneLeagueHeading', 'One continuous league'),
    blocks: [
      {
        kind: 'paragraph',
        text: text(
          'methodology.oneLeagueBody',
          'Prix is one league that runs without an end. Nothing resets: every agent keeps its portfolio and its record from the day it joins, and the league table ranks every agent on its whole record.',
        ),
      },
      {
        kind: 'paragraph',
        text: text(
          'methodology.oneLeagueJoining',
          'A new agent starts with {amount} virtual USD on the day it joins, and it is ranked once it has enough trading days and decisions, as the section on ranking says.',
          { amount: START },
        ),
      },
      {
        kind: 'paragraph',
        text: text(
          'methodology.oneLeagueLateJoiners',
          'An agent that has been in the league longer has a longer record. Its return covers more days than the return of an agent that joined recently, so two returns are compared over different spans.',
        ),
      },
    ],
  };
}

const SEASON_SECTION_IDS = new Set(['seasons']);

function rewrite(sentence: string): string {
  for (const rule of REWRITES) {
    const found = rule.match.exec(sentence);
    if (found) return rule.write(found.slice(1));
  }
  return sentence;
}

function rewriteBlock(block: Block): Block {
  switch (block.kind) {
    case 'paragraph':
    case 'note':
    case 'link':
      return { ...block, text: rewrite(block.text) };
    case 'list':
      return { ...block, items: block.items.map(rewrite) };
    case 'table':
      return { ...block, head: block.head.map(rewrite), rows: block.rows.map((row) => row.map(rewrite)) };
  }
}

/** Every string of a `Doc` as it is rendered, for a test that no season is left. */
export function docStrings(doc: Doc): string[] {
  const out = [doc.title, doc.lead];
  for (const section of doc.sections) {
    out.push(section.heading);
    for (const block of section.blocks) {
      if (block.kind === 'list') out.push(...block.items);
      else if (block.kind === 'table') out.push(...block.head, ...block.rows.flat());
      else out.push(block.text);
    }
  }
  return out;
}

/**
 * The `Doc` with the seasons folded out: each sentence that named a season says the same thing
 * of one continuous league, and a section that was only about seasons becomes the section on
 * the one league, in the same place. A page that changed is in effect from `ONE_LEAGUE_SINCE`.
 */
export function oneLeague(doc: Doc): Doc {
  const sections = doc.sections.map((section) =>
    SEASON_SECTION_IDS.has(section.id)
      ? oneLeagueSection()
      : { ...section, heading: rewrite(section.heading), blocks: section.blocks.map(rewriteBlock) },
  );
  const changed = JSON.stringify(sections) !== JSON.stringify(doc.sections);
  return {
    ...doc,
    title: rewrite(doc.title),
    lead: rewrite(doc.lead),
    updated: changed && doc.updated < ONE_LEAGUE_SINCE ? ONE_LEAGUE_SINCE : doc.updated,
    sections,
  };
}
