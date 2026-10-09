/**
 * A new row arrives at the top of a feed: the rows already there travel down to make room, and
 * the new one fades in over a short slide.
 *
 *   import { arrive } from '../design/motion/feed.ts';
 *   arrive(list, row);          // `list` is the <ol class="feed">, `row` a FeedRow's <li>
 *
 * The row is in the page at once; a visitor who asked for less motion sees it appear.
 */
import { moveElements } from '../reorder.ts';
import { calm, EASE, MOTION } from './shared.ts';

export function arrive(list: HTMLElement, row: HTMLElement): void {
  moveElements(list, () => list.prepend(row), { selector: ':scope > [data-feed-row]' });
  if (calm()) return;
  // `moveElements` gave the new row its fade. It also slides from just above its place.
  for (const animation of row.getAnimations()) animation.cancel();
  row.animate(
    [
      { opacity: 0, transform: 'translateY(-0.5rem)' },
      { opacity: 1, transform: 'none' },
    ],
    { duration: MOTION.move, easing: EASE },
  );
}
