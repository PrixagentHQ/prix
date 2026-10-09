/**
 * Things move to their new places after a filter, a sort, a switch of form or a new ranking.
 * The change is made at once; what a person sees is each thing travelling from where it was to
 * where it now is (transform), and a thing that was not there fading in (opacity).
 * docs/DESIGN.md section 9 holds the rule; the durations and the curve are tokens.
 *
 *   moveElements(board, () => { ...hide, show, reorder, change a class... });
 *
 * Give every thing that moves a `data-agent` attribute, or pass another selector.
 * A visitor who asked for less motion gets the change and no travel.
 */
import { calm, EASE, MOTION } from './motion/shared.ts';

export interface MoveOptions {
  /** What moves. Default: every `[data-agent]` inside the container. */
  selector?: string;
  /**
   * For a change of form, where a thing changes its size as well as its place: it fades in over
   * a short slide from the direction it came from, instead of travelling the whole way.
   */
  soft?: boolean;
}

const shown = (element: HTMLElement): boolean => !element.hidden && element.getClientRects().length > 0;

export function moveElements(container: HTMLElement, change: () => void, options: MoveOptions = {}): void {
  const selector = options.selector ?? '[data-agent]';
  const items = (): HTMLElement[] => [...container.querySelectorAll<HTMLElement>(selector)];
  if (calm()) {
    change();
    return;
  }

  const before = new Map<HTMLElement, DOMRect>();
  for (const item of items()) if (shown(item)) before.set(item, item.getBoundingClientRect());

  change();

  for (const item of items()) {
    if (!shown(item)) continue;
    const from = before.get(item);
    const to = item.getBoundingClientRect();
    if (!from) {
      item.animate(
        [
          { opacity: 0, transform: 'scale(0.97)' },
          { opacity: 1, transform: 'none' },
        ],
        { duration: MOTION.move, easing: EASE },
      );
    } else if (options.soft) {
      const near = (distance: number): number => Math.max(-48, Math.min(48, distance));
      item.animate(
        [
          { opacity: 0, transform: `translate(${near(from.left - to.left)}px, ${near(from.top - to.top)}px)` },
          { opacity: 1, transform: 'none' },
        ],
        { duration: MOTION.reorder, easing: EASE },
      );
    } else if (Math.abs(from.left - to.left) >= 1 || Math.abs(from.top - to.top) >= 1) {
      item.animate(
        [{ transform: `translate(${from.left - to.left}px, ${from.top - to.top}px)` }, { transform: 'none' }],
        { duration: MOTION.reorder, easing: EASE },
      );
    }
  }
}

/**
 * League rows changing place when ranks change. Rows travel to their new places, once.
 * Kept for the table form of Phase 1; it is `moveElements` over `[data-agent]`.
 */
export function reorderRows(container: HTMLElement, update: () => void): void {
  moveElements(container, update);
}

/**
 * Switches a BoardList between its two forms in place. The cards travel softly, because a card
 * and a row are not the same size.
 */
export function switchBoard(board: HTMLElement, form: 'cards' | 'list'): void {
  if (board.classList.contains('board--list') === (form === 'list')) return;
  moveElements(board, () => board.classList.toggle('board--list', form === 'list'), { soft: true });
}
