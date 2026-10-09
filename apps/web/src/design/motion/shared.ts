/**
 * What the motion modules share. The durations and the curve are the values of tokens.css: a
 * script cannot read a token before the stylesheet has arrived, so they are written here too.
 * Keep the two in step.
 */
export const MOTION = { press: 120, hover: 160, show: 200, move: 240, reorder: 320, draw: 400 } as const;
export const EASE = 'cubic-bezier(0.2, 0, 0, 1)';
export const EASE_EXIT = 'cubic-bezier(0.4, 0, 1, 1)';

/** True in a browser. A module that a server also imports does nothing there. */
export const inBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';

/** True when the visitor asked for less motion, or the browser cannot animate an element. */
export function calm(): boolean {
  if (!inBrowser) return true;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches || typeof document.body?.animate !== 'function';
}

/**
 * True once the page has been painted. Kept for a page script that asks; the modules of this
 * folder no longer need it, because they never animate what is in view at load.
 */
export function painted(): boolean {
  if (!inBrowser || typeof performance.getEntriesByName !== 'function') return true;
  return performance.getEntriesByName('first-contentful-paint').length > 0;
}

export function inView(element: Element): boolean {
  const box = element.getBoundingClientRect();
  return box.bottom > 0 && box.top < window.innerHeight && box.width > 0;
}

/** The elements that are not in the window now: the only ones a module may animate later. */
export function belowFold(elements: Iterable<HTMLElement>): HTMLElement[] {
  if (!inBrowser) return [];
  return [...elements].filter((element) => !inView(element));
}

/**
 * Runs `show` once for each element that is below the fold now, when it scrolls into view.
 * An element that is in view when this runs is never touched, whether the page has been
 * painted or not: a module script cannot promise to run before the first paint, and a figure
 * or a line that shows, blanks and comes back reads as generated (docs/DESIGN.md section 9).
 * `hold` is called for an element that will be shown later, so it can be put in its starting
 * state while nobody sees it.
 */
export function onceSeen(
  elements: Iterable<HTMLElement>,
  show: (element: HTMLElement) => void,
  hold?: (element: HTMLElement) => void,
): void {
  if (calm()) return;
  const later = belowFold(elements);
  if (later.length === 0) return;
  if (typeof IntersectionObserver !== 'function') return;
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      show(entry.target as HTMLElement);
    }
  });
  for (const element of later) {
    hold?.(element);
    observer.observe(element);
  }
}
