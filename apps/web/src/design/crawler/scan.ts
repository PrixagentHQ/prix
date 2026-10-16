/**
 * The page as the crawler sees it, read from the DOM (docs/DESIGN.md section 30): the boxes of its
 * walls and of its words, for the window and a band of `margin` around it (twice the crawler's
 * reach: all it can walk to before the next build), and the cells of the field of characters it
 * may clear behind its glyphs. Coordinates are those of `main`, whose box the crawler's layer
 * fills. Never called inside a frame.
 */
import { CONTROL, FIGURE, hasOwnText, isSurface } from '../ground/surface.ts';
import { GLYPH } from './model.ts';
import type { Box, SpaceInput } from './space.ts';

/**
 * Never drawn over: a control, a form, a picture or a chart, a figure, an animal, a medal, the
 * tape, a toast, a dialog; and a figure that CSS draws, which has no text node to find: what a
 * primitive marks `data-crawler-wall` (the numerals of Steps) and a numbered list, whose markers
 * sit in its own padding.
 */
const WALL = `${CONTROL},${FIGURE},form,.figures,.agent-mark,.ascii-grid,.medal,.ticker,.toast,dialog,[role="dialog"],[role="alertdialog"],[data-crawler-wall],ol:not([role="list"])`;
/** A word that holds a figure is a figure. */
const FIGURE_TEXT = /[0-9$%]/u;

export interface Scene extends SpaceInput {
  /** The cells of the field that show a character and lie under no surface: cleared behind a glyph. */
  field: Box[];
  /** Where the page starts in the window's coordinates when it was read: client = local + origin. */
  origin: { x: number; y: number };
}

export function scan(main: HTMLElement, layer: Element, margin: number): Scene {
  const top = main.getBoundingClientRect();
  const width = document.documentElement.clientWidth;
  const height = window.innerHeight;
  const local = (r: DOMRect | DOMRectReadOnly): Box => ({
    x: r.left - top.left,
    y: r.top - top.top,
    w: r.width,
    h: r.height,
  });
  const view = { x: -top.left, y: -top.top, w: width, h: height };
  const y0 = Math.max(0, view.y - margin);
  const area = {
    x: view.x - margin,
    y: y0,
    w: width + 2 * margin,
    h: Math.max(1, Math.min(top.height, view.y + height + margin) - y0),
  };
  const near = (b: Box) => b.x < area.x + area.w && b.x + b.w > area.x && b.y < area.y + area.h && b.y + b.h > area.y;

  const walls: Box[] = [];
  const soft: Box[] = [];
  const loud: Box[] = [];
  const ground = main.querySelector<HTMLElement>(':scope > .ground');
  const field = ground?.dataset.fit === 'fitted' ? local(ground.getBoundingClientRect()) : null;
  const surfaces: Box[] = [];
  const range = document.createRange();
  const { FILTER_REJECT, FILTER_SKIP } = NodeFilter;
  // Every element is judged as the walk reaches it; nothing is accepted, so the walk reads all of
  // `main` once and skips what lies inside a wall, far from the window, or in the crawler's layer.
  const walker = document.createTreeWalker(main, NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      const element = node as HTMLElement;
      if (element === layer || element === ground || element.classList.contains('visually-hidden'))
        return FILTER_REJECT;
      const box = local(element.getBoundingClientRect());
      if (box.w < 1 || box.h < 1) return FILTER_SKIP;
      if (!near(box)) return FILTER_REJECT;
      const position = getComputedStyle(element).position;
      if (element.matches(WALL) || position === 'fixed' || position === 'sticky') {
        walls.push(box);
        return FILTER_REJECT;
      }
      if (
        field &&
        box.x < field.x + field.w &&
        box.x + box.w > field.x &&
        box.y < field.y + field.h &&
        isSurface(element)
      ) {
        surfaces.push(box);
      }
      if (!hasOwnText(element)) return FILTER_SKIP;
      for (const child of element.childNodes) {
        if (child.nodeType !== Node.TEXT_NODE || !child.textContent?.trim()) continue;
        // A figure is a wall; the words of an h1 or an h2 are loud (crossed only where no other way is near).
        const list = FIGURE_TEXT.test(child.textContent) ? walls : element.closest('h1,h2') ? loud : soft;
        range.selectNodeContents(child);
        for (const line of range.getClientRects()) if (line.width > 0) list.push(local(line));
      }
      return FILTER_SKIP;
    },
  });
  while (walker.nextNode());

  // The field: a character under a surface is hidden and left alone; one a surface's edge cuts is a
  // wall, so no glyph stands half over it; the others are cleared behind any glyph that meets them.
  const cells: Box[] = [];
  if (ground && field) {
    const rows = (ground.textContent ?? '').split('\n');
    rows.forEach((row, r) => {
      const y = field.y + r * GLYPH.h;
      if (y >= field.y + field.h) return;
      for (let k = 0; k < row.length; k += 1) {
        if (row[k] === ' ') continue;
        // Each row is set right-aligned on the grid's right edge (ground/field.ts, fieldMarkup).
        const cell = { x: field.x + field.w - (row.length - k) * GLYPH.w, y, w: GLYPH.w, h: GLYPH.h };
        const over = surfaces.find(
          (s) => s.x < cell.x + cell.w && s.x + s.w > cell.x && s.y < cell.y + cell.h && s.y + s.h > cell.y,
        );
        if (!over) cells.push(cell);
        else if (
          !(
            over.x <= cell.x &&
            over.y <= cell.y &&
            over.x + over.w >= cell.x + cell.w &&
            over.y + over.h >= cell.y + cell.h
          )
        ) {
          walls.push(cell);
        }
      }
    });
  }
  return { area, view, walls, soft, loud, field: cells, origin: { x: top.left, y: top.top } };
}
