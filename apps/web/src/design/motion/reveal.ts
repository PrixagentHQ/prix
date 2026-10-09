/**
 * A block rises 8 pixels and fades in as it scrolls into view, once.
 *
 *   <section data-reveal>...</section>     import '../design/motion/reveal.ts';
 *
 * Only a block that is below the fold when the page loads rises, at the moment its first pixel
 * enters the window. A block that is in view at load is never touched, painted or not: a page
 * that assembles itself in front of a person reads as generated (docs/DESIGN.md section 16).
 * No block is ever hidden to wait for this, so a page is whole without script, in print and in
 * a picture of the full page. One block, not each thing inside it: a feed, a band, a panel.
 */
import { belowFold, inBrowser, onceSeen } from './shared.ts';

/** Reveals every `[data-reveal]` under `root` that is below the fold now, as it scrolls into view. */
export function initReveal(root: ParentNode = document): void {
  onceSeen(belowFold(root.querySelectorAll<HTMLElement>('[data-reveal]')), (element) => {
    element.classList.add('is-revealed');
    element.addEventListener('animationend', () => element.classList.remove('is-revealed'), { once: true });
  });
}

if (inBrowser) initReveal();
