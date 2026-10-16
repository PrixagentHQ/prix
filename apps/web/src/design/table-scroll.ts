// The scrolling table's own layout step (docs/DESIGN.md section 12.3, `Table.astro`, R20 and R21).
//
// A `Table` with `scroll` scrolls inside its own box while the box is narrower than the table. This module:
//   - makes that box a tab stop only while it overflows;
//   - with `openAt`, opens the box scrolled so that the named column's start sits against the end of the
//     sticky first column (or against the box's start when the first column is not sticky), at once, with
//     no smooth scroll, and again after a resize or a font load until the reader has moved the box;
//   - marks the box `data-hidden-start` while columns lie out of view before its start edge (beside the sticky
//     column when there is one) and `data-hidden-end` while more columns follow beyond its end edge, and
//     `data-sticky-first` while its first column is sticky, with `--table-end-at`, the box's end edge measured
//     from that column's start: the edge fades of primitives.css read these (R21);
//   - with `cue`, marks the cue's line (the box's previous sibling, `data-table-cue`) `data-overflows` while
//     the box overflows and `data-more` while columns lie out of view on either side (R21).
// It reads the page's own layout and nothing else: no request, no storage, no timer.

/** More than this many pixels of table beyond an edge of the box counts as "out of view". */
const EPSILON = 1;

/** The box is narrower than its table. */
export function overflows(scrollWidth: number, clientWidth: number): boolean {
  return scrollWidth - clientWidth > EPSILON;
}

/** More columns follow beyond the box's end edge at this scroll position. */
export function moreFollows(scrollLeft: number, scrollWidth: number, clientWidth: number): boolean {
  return scrollWidth - clientWidth - scrollLeft > EPSILON;
}

export interface HiddenEdges {
  /** Columns lie out of view before the box's start edge (under the sticky column, when there is one). */
  start: boolean;
  /** Columns follow beyond the box's end edge. */
  end: boolean;
}

/**
 * Which edges of the box have columns out of view at this scroll position. Neither, while the box is wide
 * enough for every column. The fades stand on these edges, and the cue shows while either holds (R21).
 */
export function hiddenEdges(scrollLeft: number, scrollWidth: number, clientWidth: number): HiddenEdges {
  if (!overflows(scrollWidth, clientWidth)) return { start: false, end: false };
  return { start: scrollLeft > EPSILON, end: moreFollows(scrollLeft, scrollWidth, clientWidth) };
}

/** The cue shows while columns lie out of view on either side, never while every column is in view. */
export function cueShown(edges: HiddenEdges): boolean {
  return edges.start || edges.end;
}

export interface OpenGeometry {
  /** The box's scroll position now. */
  scrollLeft: number;
  /** The largest scroll position: scrollWidth minus clientWidth. */
  maxScroll: number;
  /** The named column's start edge, measured from the box's visible start edge, at the scroll position now. */
  columnStart: number;
  /** Where the sticky first column ends, measured from the box's visible start edge; 0 when it is not sticky. */
  stickyEnd: number;
}

/**
 * The scroll position at which the named column's start edge sits against `stickyEnd`, held inside
 * 0 and `maxScroll` and rounded to a whole pixel. A column that already sits there needs no move.
 */
export function openScrollLeft(g: OpenGeometry): number {
  const wanted = g.scrollLeft + g.columnStart - g.stickyEnd;
  const max = Math.max(0, g.maxScroll);
  return Math.round(Math.min(max, Math.max(0, wanted)));
}

function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(value)
    : value.replace(/[^\w-]/g, '\\$&');
}

/** The box's first head cell while it is sticky; null otherwise. */
function stickyFirst(region: HTMLElement): HTMLElement | null {
  const first = region.querySelector<HTMLElement>('thead th:first-child');
  return first && getComputedStyle(first).position === 'sticky' ? first : null;
}

/** Opens one box at its named column. */
function open(region: HTMLElement, key: string): void {
  const head = region.querySelector<HTMLElement>(`thead th.c-${cssEscape(key)}`);
  if (!head) return;
  const box = region.getBoundingClientRect();
  const first = stickyFirst(region);
  const stickyEnd = first && first !== head ? first.getBoundingClientRect().right - box.left - region.clientLeft : 0;
  const left = openScrollLeft({
    scrollLeft: region.scrollLeft,
    maxScroll: region.scrollWidth - region.clientWidth,
    columnStart: head.getBoundingClientRect().left - box.left - region.clientLeft,
    stickyEnd,
  });
  if (Math.abs(left - region.scrollLeft) >= 1) region.scrollTo({ left, behavior: 'instant' });
}

/**
 * Marks whether the first column is sticky and, while it is, where the box's end edge stands measured from
 * that column's start, so that the end fade can hang from the sticky cells and stay at the box's end edge.
 */
function measure(region: HTMLElement): void {
  const first = stickyFirst(region);
  region.toggleAttribute('data-sticky-first', first !== null);
  if (!first) {
    region.style.removeProperty('--table-end-at');
    return;
  }
  const offset = first.getBoundingClientRect().left - region.getBoundingClientRect().left - region.clientLeft;
  region.style.setProperty('--table-end-at', `${Math.round(region.clientWidth - offset)}px`);
}

/** Wires every scrolling table under `root`. Safe to call once per page. */
export function wireScrollTables(root: ParentNode = document): void {
  const regions = [...root.querySelectorAll<HTMLElement>('[data-table-scroll]')];
  if (regions.length === 0) return;

  // A box the reader has moved (by pointer, wheel, touch or key) is never moved again by the page.
  const moved = new WeakSet<HTMLElement>();

  const edges = (region: HTMLElement) => {
    const hidden = hiddenEdges(region.scrollLeft, region.scrollWidth, region.clientWidth);
    region.toggleAttribute('data-hidden-start', hidden.start);
    region.toggleAttribute('data-hidden-end', hidden.end);
    const line = region.previousElementSibling;
    if (!(line instanceof HTMLElement) || !line.hasAttribute('data-table-cue')) return;
    line.toggleAttribute('data-overflows', overflows(region.scrollWidth, region.clientWidth));
    line.toggleAttribute('data-more', cueShown(hidden));
  };

  const sync = () => {
    for (const region of regions) {
      if (overflows(region.scrollWidth, region.clientWidth)) region.tabIndex = 0;
      else region.removeAttribute('tabindex');
      const key = region.dataset.openAt;
      if (key && !moved.has(region)) open(region, key);
      measure(region);
      edges(region);
    }
  };

  for (const region of regions) {
    const mark = () => moved.add(region);
    for (const type of ['pointerdown', 'wheel', 'touchstart', 'keydown'] as const) {
      region.addEventListener(type, mark, { passive: true });
    }
    region.addEventListener('scroll', () => edges(region), { passive: true });
  }

  sync();
  window.addEventListener('resize', sync);
  if (typeof document !== 'undefined' && document.fonts) void document.fonts.ready.then(sync);
}
