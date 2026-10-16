import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { text } from '../../apps/web/src/content/index.ts';
import { repoRoot } from '../support/repo.ts';
import { findTextCalls } from '../support/text-calls.ts';

/**
 * docs/contracts/phase-4-token.md section 5.4, item 4 and section 6 rule 13: the public token page
 * promises no return.
 *
 * The rendered text is taken from the page source: every `text(key, draft)` call of
 * apps/web/src/site/token/TokenPage.astro, resolved through the real `text()` of the content
 * deck, so a deck override is what is checked. The page has no other words of its own.
 */

const PAGE = 'apps/web/src/site/token/TokenPage.astro';

const FORBIDDEN =
  /\b(returns?|profits?|profitable|gains?|earn(?:s|ed|ing|ings)?|yields?|appreciat\w*|invest\w*|dividends?|guarantee\w*)\b|\bwill rise\b/i;
/** A sentence that denies a promise may name it: "not a promise of return" is the sentence the contract demands. */
const DENIES = /\b(not|no|nothing|never|without|cannot|neither)\b/i;

function pageSentences(): { key: string; sentence: string }[] {
  const source = readFileSync(join(repoRoot(), PAGE), 'utf8');
  const calls = findTextCalls(PAGE, source);
  const out: { key: string; sentence: string }[] = [];
  for (const call of calls) {
    expect(call.key, `a text() call at line ${call.line} has no literal key`).not.toBeNull();
    expect(call.draft, `${call.key} has no literal draft`).not.toBeNull();
    const resolved = text(call.key as string, call.draft as string);
    for (const sentence of resolved.split(/(?<=[.!?])\s+/)) out.push({ key: call.key as string, sentence });
  }
  return out;
}

describe('the token page promises no return', () => {
  const sentences = pageSentences();
  const whole = sentences.map((entry) => entry.sentence).join(' ');

  it('finds the page copy', () => {
    expect(sentences.length).toBeGreaterThan(20);
  });

  it('uses none of the words of a promise outside a sentence that denies one', () => {
    const offenders = sentences
      .filter(({ sentence }) => FORBIDDEN.test(sentence) && !DENIES.test(sentence))
      .map(({ key, sentence }) => `${key}: ${sentence}`);
    expect(offenders).toEqual([]);
  });

  it('only uses those words to say what the token does not give', () => {
    // Every use of a forbidden word sits in a sentence that is itself a denial or a statement of risk.
    const uses = sentences.filter(({ sentence }) => FORBIDDEN.test(sentence));
    expect(uses.length).toBeGreaterThan(0);
    for (const { key, sentence } of uses) expect(DENIES.test(sentence), `${key}: ${sentence}`).toBe(true);
  });

  it('says the token carries no promise of return, no rights to Prix and no link to any agent decisions', () => {
    expect(whole).toMatch(/not a promise of return/i);
    // The holders' round reworded it "no rights in Prix" (the poll gives a vote on a paper league only).
    expect(whole).toMatch(/no rights (?:to|in) Prix/i);
    expect(whole).toMatch(/no (?:link|connection) to any agent.s decisions/i);
  });

  it('says it gives no share of revenue and is no advice', () => {
    expect(whole).toMatch(/no share of revenue/i);
    // D-168, second pass (W168-1): `token.notAdvice` says "Nothing an agent decides is advice."
    expect(whole).toMatch(/nothing an agent decides is advice/i);
  });

  it('names the risks and the one address that counts, and names no other token', () => {
    expect(whole).toMatch(/lose all of its value/i);
    expect(whole).toMatch(/liquidity may be thin/i);
    expect(whole).toMatch(/market that Prix does not control/i);
    expect(whole).toMatch(/only one that counts/i);
    expect(whole).not.toMatch(/prize/i);
  });

  it('shows no address or link of its own: the address, the explorer and the buy link come from the API', () => {
    const source = readFileSync(join(repoRoot(), PAGE), 'utf8');
    expect(source).not.toMatch(/0x[0-9a-fA-F]{40}/);
    expect(source).not.toMatch(/ponsfamily\.com/);
    expect(source).not.toMatch(/eth_sendTransaction|eth_requestAccounts|wallet_|personal_sign/);
  });
});
