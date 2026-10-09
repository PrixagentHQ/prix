/**
 * Fits the field of characters to the head of its page (docs/DESIGN.md section 2.3, R11).
 *
 * The field is 476 pixels tall, and many page heads are not: on a short page it ran under the
 * footer's links, and where a raised band begins 120 pixels down, that band's hairline cut it
 * into a ruler-straight edge. So the field ends where the head ends: 48 pixels above the first
 * thing in its reach (right of the line from which it is nothing, below its top) that is a
 * control, a raised band, the footer, or a word or a figure that stands on no opaque surface.
 * A card, a panel, the season strip and a tray are opaque and lie over the field as before.
 * The stylesheet fades its last 112 pixels to nothing, so it always ends in its own fade. Where
 * that leaves less than 232 pixels (a head band under about 280), there is no field at all.
 *
 * It sets one height, through the element's style object (section 19), when the page is laid
 * out, when its fonts arrive and when `main` changes size. The field itself never moves. Until
 * this has run the stylesheet keeps the field hidden; without scripts the stylesheet's own limit
 * (the height of `main` less 48 pixels) holds.
 */

/** The height of the grid (field.ts: 34 rows of 14). */
const FIELD_HEIGHT = 476;
/** The open ground kept between the field's end and what ends the head. */
const CLEAR = 48;
/** Under this the field would be a strip: no field. */
const MIN_HEIGHT = 232;
/** From the grid's right edge, the line left of which the field is nothing (field.ts). */
const NOTHING_FROM_RIGHT = 830;

/** A control: the field never meets one, whatever it stands on. */
const CONTROL = 'a[href], button, input, select, textarea, summary, [role="button"], [tabindex]:not([tabindex="-1"])';
/** A figure or a sign that is not text. */
const FIGURE = 'img, svg, canvas, video, iframe, hr';
/** A band across the page: a raised zone, or a block of a page without zones on its raised band. */
const BAND = 'main > .zone--raised, main > .page.section';

function hasOwnText(element: Element): boolean {
  for (const node of element.childNodes) {
    if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) return true;
  }
  return false;
}

/** An opaque fill: a colour that is not clear, a picture, or a band's border image. */
function isSurface(element: Element): boolean {
  const style = getComputedStyle(element);
  const colour = style.backgroundColor;
  const clear = colour === 'transparent' || /^rgba\(.*,\s*0\)$/u.test(colour);
  return !clear || style.backgroundImage !== 'none' || style.borderImageSource !== 'none';
}

/** Whether the element or something between it and `main` is opaque: the field lies under it. */
function onSurface(element: Element, main: Element): boolean {
  for (let parent: Element | null = element; parent && parent !== main; parent = parent.parentElement) {
    if (isSurface(parent)) return true;
  }
  return false;
}

/**
 * Where the element ends the head for the field (see above), as the top of what is in its reach,
 * or nothing. A word is measured by its own lines, not by the box of its block: a title's box
 * runs the whole measure, its words do not. What starts at or above the field's top (the tape,
 * a strip the field lies under) ends it only when it is a band.
 */
function headEnd(element: HTMLElement, main: HTMLElement, top: number, left: number, right: number): number | null {
  if (element.closest('.toast')) return null;
  const rect = element.getBoundingClientRect();
  if (element.matches(BAND)) {
    const raised = element.matches('.zone--raised') || getComputedStyle(element).borderImageSource !== 'none';
    return raised ? rect.top : null;
  }
  const inReach = (r: DOMRect) => r.width > 0 && r.height > 0 && r.top > top && r.right > left && r.left < right;
  if (element.matches(CONTROL)) return inReach(rect) ? rect.top : null;
  const figure = element.matches(FIGURE);
  if (!figure && !hasOwnText(element)) return null;
  if (getComputedStyle(element).visibility === 'hidden' || onSurface(element, main)) return null;
  if (figure) return inReach(rect) ? rect.top : null;
  let end: number | null = null;
  const range = document.createRange();
  for (const node of element.childNodes) {
    if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) continue;
    range.selectNodeContents(node);
    for (const line of range.getClientRects()) {
      if (inReach(line) && (end === null || line.top < end)) end = line.top;
    }
  }
  return end;
}

function fit(ground: HTMLElement, main: HTMLElement): void {
  ground.style.height = '';
  if (getComputedStyle(ground).display === 'none') {
    ground.dataset.fit = 'none';
    return;
  }
  const box = ground.getBoundingClientRect();
  const nothing = box.right - NOTHING_FROM_RIGHT;
  const reach = box.top + FIELD_HEIGHT + CLEAR;
  let end = reach;
  const footer = document.querySelector('body > footer');
  if (footer) end = Math.min(end, footer.getBoundingClientRect().top);
  for (const element of main.querySelectorAll<HTMLElement>('*')) {
    if (element === ground || ground.contains(element)) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    if (rect.top >= end || rect.bottom <= box.top) continue;
    if (rect.right <= nothing || rect.left >= box.right) continue;
    const top = headEnd(element, main, box.top, nothing, box.right);
    // A band the field lies on (it starts above the field's top) ends the field at once.
    if (top !== null) end = Math.min(end, Math.max(top, box.top));
  }
  const height = Math.floor(Math.min(FIELD_HEIGHT, end - box.top - CLEAR));
  if (height < MIN_HEIGHT) {
    ground.dataset.fit = 'none';
    return;
  }
  ground.style.height = `${height}px`;
  ground.dataset.fit = 'fitted';
}

const ground = document.querySelector<HTMLElement>('main > .ground');
const main = ground?.parentElement;
if (ground && main) {
  let queued = false;
  const queue = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fit(ground, main);
    });
  };
  fit(ground, main);
  document.fonts?.ready.then(queue).catch(() => {});
  new ResizeObserver(queue).observe(main);
  window.addEventListener('resize', queue, { passive: true });
}

// A module of its own, so its names never meet another script's.
export {};
