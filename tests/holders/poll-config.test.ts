import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  POLL_MAX_VOTERS,
  POLL_MAX_VOTERS_FLOOR,
  POLL_RUNBOOK_STATES,
  pollHolderCountHolds,
  pollRunbookState,
  pollsConfigConsistent,
  pollTallyJobOn,
} from '@prix/contracts';
import { describe, expect, it } from 'vitest';

/**
 * The switch's states, the cap's floor and the first poll's dates as the tests read them (docs/contracts/
 * phase-6-holders.md section 25: platform rows (1) and (2), qa row (8); revision 8d D1 and D5). The entry is driven
 * in each of the runbook's three states in poll-entry.d1.test.ts; here the real apps/api/wrangler.jsonc is read.
 */

function wranglerVars(): Record<string, string> {
  const file = path.join(import.meta.dirname, '..', '..', 'apps', 'api', 'wrangler.jsonc');
  const text = readFileSync(file, 'utf8');
  const vars: Record<string, string> = {};
  for (const name of ['POLLS_ENABLED', 'POLL_TALLY_JOB']) {
    const matches = [...text.matchAll(new RegExp(`^\\s*"${name}"\\s*:\\s*"([^"]*)"`, 'gm'))];
    expect(matches, name).toHaveLength(1);
    vars[name] = (matches[0] as RegExpMatchArray)[1] as string;
  }
  return vars;
}

describe('the runbook states (revision 8d, D1)', () => {
  it('the real apps/api/wrangler.jsonc stands in one of the three states', () => {
    const vars = wranglerVars();
    expect(pollRunbookState(vars.POLLS_ENABLED, vars.POLL_TALLY_JOB)).toBe(true);
    expect(pollsConfigConsistent(vars.POLLS_ENABLED, vars.POLL_TALLY_JOB)).toBe(true);
  });

  it('exactly three states, each consistent; ("true","off") is refused; POLL_TALLY_JOB is on only for "on"', () => {
    expect(POLL_RUNBOOK_STATES.map((s) => s.join())).toEqual(['false,on', 'true,on', 'false,off']);
    for (const [polls, job] of POLL_RUNBOOK_STATES) expect(pollsConfigConsistent(polls, job)).toBe(true);
    expect(pollsConfigConsistent('true', 'off')).toBe(false);
    expect(pollsConfigConsistent('true', undefined)).toBe(false);
    expect(pollRunbookState('true', 'off')).toBe(false);
    expect(pollRunbookState('TRUE', 'on')).toBe(false);
    expect(pollTallyJobOn('on')).toBe(true);
    for (const value of [undefined, 'On', ' on', 'true', '1', 'off']) expect(pollTallyJobOn(value)).toBe(false);
  });
});

describe("the cap's floor (revision 8d, D5)", () => {
  it('the cap stands at or above its floor, and the holder count holds the switch from half the cap', () => {
    expect(POLL_MAX_VOTERS).toBeGreaterThanOrEqual(POLL_MAX_VOTERS_FLOOR);
    const half = POLL_MAX_VOTERS / 2;
    expect(pollHolderCountHolds(half - 1)).toBe(false);
    expect(pollHolderCountHolds(0)).toBe(false);
    expect(pollHolderCountHolds(half)).toBe(true);
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(pollHolderCountHolds(bad)).toBe(true);
  });
});
