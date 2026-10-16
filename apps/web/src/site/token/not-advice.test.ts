import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// D-168, W168-1: the token page's line on advice scopes "no real orders" to the league, because
// Prix Live places real orders, and says plainly that nothing an agent decides is advice.
const page = readFileSync(new URL('./TokenPage.astro', import.meta.url), 'utf8');

describe('token.notAdvice on the token page', () => {
  it('carries the D-168 sentence as its draft', () => {
    expect(page).toContain(
      "'token.notAdvice',\n  'In the league, what an agent decides is the record of a simulation, and no real orders are placed. Nothing an agent decides is advice.',",
    );
  });

  it('no longer says, unscoped, that no real orders are placed', () => {
    expect(page).not.toContain('It is not advice, and no real orders are placed.');
  });
});
