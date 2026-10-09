/**
 * A sparkline below the fold draws once, from left to right, as it scrolls into view.
 *
 *   <Sparkline values={...} draw />     import '../design/motion/draw.ts';
 *
 * The line is complete in the page and stays so without script. Drawing is a window that
 * slides over it (two transforms, in motion.css); this module only says when. A line that is
 * in view at load is shown drawn. On a card the line also redraws under the pointer, in CSS.
 */
import { inBrowser, onceSeen } from './shared.ts';

/** Draws one element with the class `spark` now. */
export function draw(element: HTMLElement): void {
  element.classList.add('is-drawing');
  element.addEventListener('animationend', () => element.classList.remove('is-drawing'), { once: true });
}

/** Draws every `[data-draw]` under `root` once, as it shows. */
export function initDraw(root: ParentNode = document): void {
  onceSeen(root.querySelectorAll<HTMLElement>('[data-draw]'), draw);
}

if (inBrowser) initDraw();
