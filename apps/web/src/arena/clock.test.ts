// The league's clock never repeats an old market check as if it were made now.
// Run: pnpm exec vitest run --root apps/web/src/arena
import type { MarketStatus } from '@prix/contracts';
import { describe, expect, it } from 'vitest';
import { checkIsCurrent, leagueClock, nextRoundToday } from './clock.ts';

const paused = (checkedAt: string): MarketStatus => ({
  open: false,
  closedReason: 'rpc_unavailable',
  checkedAt,
  lastTickId: null,
  halted: [],
});
const open = (checkedAt: string): MarketStatus => ({ ...paused(checkedAt), open: true, closedReason: null });
const at = (iso: string) => Date.parse(iso);

describe('leagueClock', () => {
  it('does not call the league paused at night from the last round of the day before', () => {
    // Thursday 8 Oct 2026, 03:10 UTC; the check is the 19:00 round of Wednesday.
    const clock = leagueClock({ market: paused('2026-10-07T19:00:30.000Z'), round: null }, at('2026-10-08T03:10:00Z'));
    expect(clock).toEqual({ kind: 'between', next: '2026-10-08T15:00:00.000Z' });
  });

  it('says paused when the check is from this window', () => {
    const clock = leagueClock({ market: paused('2026-10-08T16:00:20.000Z'), round: null }, at('2026-10-08T16:20:00Z'));
    expect(clock).toEqual({ kind: 'closed' });
  });

  it('treats the first minutes of a window, before its first check, as between rounds', () => {
    const clock = leagueClock({ market: paused('2026-10-07T19:00:30.000Z'), round: null }, at('2026-10-08T15:02:00Z'));
    expect(clock).toEqual({ kind: 'between', next: '2026-10-08T16:00:00.000Z' });
  });

  it('gives the next round of an open market inside the window', () => {
    const clock = leagueClock({ market: open('2026-10-08T17:00:10.000Z'), round: null }, at('2026-10-08T17:40:00Z'));
    expect(clock).toEqual({ kind: 'open', next: '2026-10-08T18:00:00.000Z' });
  });

  it('points to the next trading day after the last round and at the weekend', () => {
    expect(leagueClock({ market: open('2026-10-08T19:00:10.000Z'), round: null }, at('2026-10-08T20:30:00Z'))).toEqual({
      kind: 'between',
      next: null,
    });
    // Saturday 10 Oct 2026.
    expect(leagueClock({ market: open('2026-10-09T19:00:10.000Z'), round: null }, at('2026-10-10T12:00:00Z'))).toEqual({
      kind: 'between',
      next: null,
    });
  });

  it('says a round runs while one is being processed, whatever the check', () => {
    expect(
      leagueClock(
        { market: paused('2026-10-07T19:00:30.000Z'), round: { tickId: '2026-10-08T19:00Z' } },
        at('2026-10-08T20:10:00Z'),
      ),
    ).toEqual({ kind: 'round' });
  });

  it('has no market check before the first round', () => {
    expect(leagueClock({ market: null, round: null }, at('2026-10-08T16:30:00Z'))).toEqual({
      kind: 'between',
      next: '2026-10-08T17:00:00.000Z',
    });
  });
});

describe('nextRoundToday and checkIsCurrent', () => {
  it('ends at the last round hour', () => {
    expect(nextRoundToday(at('2026-10-08T18:59:59Z'))).toBe('2026-10-08T19:00:00.000Z');
    expect(nextRoundToday(at('2026-10-08T19:00:00Z'))).toBeNull();
  });

  it('counts a check as current only inside the window it was made in', () => {
    expect(checkIsCurrent(paused('2026-10-08T19:00:20.000Z'), at('2026-10-08T19:59:00Z'))).toBe(true);
    expect(checkIsCurrent(paused('2026-10-08T19:00:20.000Z'), at('2026-10-08T20:00:00Z'))).toBe(false);
    expect(checkIsCurrent(paused('2026-10-07T19:00:20.000Z'), at('2026-10-08T16:00:00Z'))).toBe(false);
  });
});
