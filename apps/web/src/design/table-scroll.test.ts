import { describe, expect, it } from 'vitest';
import { cueShown, hiddenEdges, moreFollows, openScrollLeft, overflows } from './table-scroll.ts';

// The holders table at 360 pixels (docs/contracts/phase-6-holders.md section 2, revision 5, D2): a box of 328,
// a table of 31rem (496), a sticky Feature column of 9rem (144) and four amount columns of 5.5rem (88).
const BOX = 328;
const TABLE = 496;
const STICKY = 144;
const COL = 88;
const startOf = (tier: number) => STICKY + tier * COL;

describe('overflows', () => {
  it('holds while the table is wider than its box, by more than a pixel', () => {
    expect(overflows(TABLE, BOX)).toBe(true);
    expect(overflows(BOX, BOX)).toBe(false);
    expect(overflows(BOX + 1, BOX)).toBe(false);
    expect(overflows(BOX + 2, BOX)).toBe(true);
  });
});

describe('moreFollows', () => {
  it('holds at the start and until the last column is in view', () => {
    expect(moreFollows(0, TABLE, BOX)).toBe(true);
    expect(moreFollows(TABLE - BOX - 2, TABLE, BOX)).toBe(true);
    expect(moreFollows(TABLE - BOX, TABLE, BOX)).toBe(false);
    // A fractional scroll position at the end on a dense screen.
    expect(moreFollows(TABLE - BOX - 0.5, TABLE, BOX)).toBe(false);
  });

  it('never holds when the box is wide enough for every column', () => {
    expect(moreFollows(0, BOX, BOX)).toBe(false);
  });
});

// R21 (DC6-3 of the holders round): the fades stand on the edges with columns out of view beyond them, and
// the cue shows while either does.
describe('hiddenEdges and cueShown', () => {
  const max = TABLE - BOX;

  it('opened at the start: columns follow at the end only', () => {
    const edges = hiddenEdges(0, TABLE, BOX);
    expect(edges).toEqual({ start: false, end: true });
    expect(cueShown(edges)).toBe(true);
  });

  it('opened at tier 1: columns out of view on both sides', () => {
    expect(hiddenEdges(COL, TABLE, BOX)).toEqual({ start: true, end: true });
  });

  it('opened at its end (tier 2 or 3, the phone clamp): Tier 0 and Tier 1 lie to the left, the cue still shows', () => {
    const edges = hiddenEdges(max, TABLE, BOX);
    expect(edges).toEqual({ start: true, end: false });
    expect(cueShown(edges)).toBe(true);
    // A fractional scroll position at the end on a dense screen.
    expect(hiddenEdges(max - 0.5, TABLE, BOX)).toEqual({ start: true, end: false });
  });

  it('a scroll of a pixel or less from the start hides nothing before it', () => {
    expect(hiddenEdges(1, TABLE, BOX).start).toBe(false);
    expect(hiddenEdges(1.5, TABLE, BOX).start).toBe(true);
  });

  it('neither edge, and no cue, while every column is in view', () => {
    for (const scrollLeft of [0, 0.5, 1]) {
      const edges = hiddenEdges(scrollLeft, BOX + 1, BOX);
      expect(edges).toEqual({ start: false, end: false });
      expect(cueShown(edges)).toBe(false);
    }
    expect(hiddenEdges(0, BOX, 600)).toEqual({ start: false, end: false });
  });
});

describe('openScrollLeft', () => {
  const max = TABLE - BOX;

  it('puts the named column against the end of the sticky column', () => {
    // Tier 1 starts at 232: scroll by 88 so it stands at 144.
    expect(openScrollLeft({ scrollLeft: 0, maxScroll: max, columnStart: startOf(1), stickyEnd: STICKY })).toBe(COL);
    // In a wider box (a table of 640) tier 2 starts at 320: scroll by 176.
    expect(openScrollLeft({ scrollLeft: 0, maxScroll: 312, columnStart: startOf(2), stickyEnd: STICKY })).toBe(2 * COL);
  });

  it('holds the last columns inside the largest scroll position', () => {
    // Tier 2 would want 176 and tier 3 264; the box can scroll 168 at most. The column then stands
    // 8 pixels (tier 2) or 96 (tier 3) past the sticky column's end, whole in view.
    expect(openScrollLeft({ scrollLeft: 0, maxScroll: max, columnStart: startOf(2), stickyEnd: STICKY })).toBe(max);
    expect(openScrollLeft({ scrollLeft: 0, maxScroll: max, columnStart: startOf(3), stickyEnd: STICKY })).toBe(max);
    expect(startOf(3) - max + COL).toBeLessThanOrEqual(BOX);
  });

  it('leaves a column that already stands there where it is', () => {
    expect(openScrollLeft({ scrollLeft: 0, maxScroll: max, columnStart: startOf(0), stickyEnd: STICKY })).toBe(0);
  });

  it('measures from where the box stands now', () => {
    // Already scrolled by 40: tier 1's start is then at 192 in the box, so the target is still 88.
    expect(openScrollLeft({ scrollLeft: 40, maxScroll: max, columnStart: startOf(1) - 40, stickyEnd: STICKY })).toBe(
      COL,
    );
  });

  it('puts the column at the box start when the first column is not sticky', () => {
    expect(openScrollLeft({ scrollLeft: 0, maxScroll: 400, columnStart: 300, stickyEnd: 0 })).toBe(300);
  });

  it('never scrolls below zero or when nothing overflows, and rounds to a whole pixel', () => {
    expect(openScrollLeft({ scrollLeft: 0, maxScroll: max, columnStart: 10, stickyEnd: STICKY })).toBe(0);
    expect(openScrollLeft({ scrollLeft: 0, maxScroll: 0, columnStart: startOf(2), stickyEnd: STICKY })).toBe(0);
    expect(openScrollLeft({ scrollLeft: 0, maxScroll: -3, columnStart: startOf(2), stickyEnd: STICKY })).toBe(0);
    expect(openScrollLeft({ scrollLeft: 0, maxScroll: max, columnStart: 232.6, stickyEnd: 144.2 })).toBe(88);
  });
});
