import { describe, expect, it } from 'vitest';
import { failures } from '../../../apps/api/src/http/errors.ts';

/**
 * One continuous league (D-109): a message a person can read never says "season". Error codes and
 * the data API's field names stay as they are.
 */
describe('API messages in one continuous league', () => {
  it('a missing league period is reported without the word', () => {
    const failure = failures.seasonNotFound();
    expect(failure.code).toBe('not_found');
    expect(failure.message).not.toMatch(/season/i);
  });

  it('a league that is not running is reported without the word, under the same code', () => {
    const failure = failures.noActiveSeason();
    expect(failure.code).toBe('no_active_season');
    expect(failure.message).not.toMatch(/season/i);
  });
});
