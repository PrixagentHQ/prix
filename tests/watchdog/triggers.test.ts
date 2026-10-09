import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CRON_PLAN } from '@prix/contracts';
import { describe, expect, it } from 'vitest';

/**
 * The Cron Triggers of `prix-api` (finding 17b). The scheduled work runs on the Durable Object clock
 * (D-073), so a trigger may only be the watchdog: an expression outside `CRON_PLAN`, whose run starts
 * the clocks and runs no step. A trigger with a `CRON_PLAN` expression would run that schedule's steps
 * a second time beside its clock. At most one trigger: the account has five for all its Workers.
 */

function crons(): string[] {
  const file = path.join(import.meta.dirname, '..', '..', 'apps', 'api', 'wrangler.jsonc');
  const text = readFileSync(file, 'utf8');
  const block = /"triggers"\s*:\s*\{\s*"crons"\s*:\s*\[([^\]]*)\]/.exec(text);
  if (block === null) throw new Error('apps/api/wrangler.jsonc has no triggers.crons');
  return [...(block[1] ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? '');
}

describe('the triggers of prix-api', () => {
  it('hold at most one Cron Trigger', () => {
    expect(crons().length).toBeLessThanOrEqual(1);
  });

  it('never repeat a schedule of CRON_PLAN', () => {
    for (const cron of crons()) expect(Object.keys(CRON_PLAN)).not.toContain(cron);
  });
});
