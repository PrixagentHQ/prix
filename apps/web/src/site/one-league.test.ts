import { describe, expect, it } from 'vitest';
import methodology from '../content/pages/methodology.ts';
import privacy from '../content/pages/privacy.ts';
import terms from '../content/pages/terms.ts';
import { docStrings, ONE_LEAGUE_SINCE, oneLeague } from './one-league.ts';

// D-109: no long page of the site says "season" once it is rendered.
const SEASON = /\bseasons?\b/i;

describe('oneLeague', () => {
  for (const [name, doc] of [
    ['methodology', methodology],
    ['terms', terms],
    ['privacy', privacy],
  ] as const) {
    it(`leaves no season in the ${name} page`, () => {
      const left = docStrings(oneLeague(doc)).filter((line) => SEASON.test(line));
      expect(left).toEqual([]);
    });
  }

  it('keeps every section of the methodology but the one on seasons, in the same order', () => {
    const before = methodology.sections.map((section) => section.id);
    const after = oneLeague(methodology).sections.map((section) => section.id);
    expect(after).toEqual(before.map((id) => (id === 'seasons' ? 'one-league' : id)));
  });

  it('keeps the disclaimer and the scoring figures of the methodology', () => {
    const all = docStrings(oneLeague(methodology)).join('\n');
    expect(all).toContain('Paper trading simulation. Not investment advice. No real orders are placed.');
    expect(all).toMatch(/Max drawdown/);
    expect(all).toMatch(/^Return$/m);
    expect(all).toMatch(/Higher return first\./);
  });

  it('dates a page it changed from the day of the one league, and leaves an unchanged page alone', () => {
    expect(oneLeague(methodology).updated >= ONE_LEAGUE_SINCE).toBe(true);
    expect(oneLeague(privacy).updated).toBe(privacy.updated);
  });

  it('does nothing to a page that names no season', () => {
    const plain = oneLeague(privacy);
    expect(plain.sections).toEqual(privacy.sections);
  });
});
