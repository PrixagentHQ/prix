/**
 * What the page is made of, as two scripts read it: ground/fit.ts (where the field of characters
 * ends) and crawler/scan.ts (where the crawler may be drawn). Moved out of fit.ts unchanged
 * (docs/DESIGN.md section 2.3 and section 30).
 */

/** A control: the field never meets one, whatever it stands on, and the crawler never draws over one. */
export const CONTROL =
  'a[href], button, input, select, textarea, summary, [role="button"], [tabindex]:not([tabindex="-1"])';
/** A figure or a sign that is not text. */
export const FIGURE = 'img, svg, canvas, video, iframe, hr';

/** Whether the element holds text of its own, not only inside its children. */
export function hasOwnText(element: Element): boolean {
  for (const node of element.childNodes) {
    if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) return true;
  }
  return false;
}

/** An opaque fill: a colour that is not clear, a picture, or a band's border image. */
export function isSurface(element: Element): boolean {
  const style = getComputedStyle(element);
  const colour = style.backgroundColor;
  const clear = colour === 'transparent' || /^rgba\(.*,\s*0\)$/u.test(colour);
  return !clear || style.backgroundImage !== 'none' || style.borderImageSource !== 'none';
}

/** Whether the element or something between it and `main` is opaque: the field lies under it. */
export function onSurface(element: Element, main: Element): boolean {
  for (let parent: Element | null = element; parent && parent !== main; parent = parent.parentElement) {
    if (isSurface(parent)) return true;
  }
  return false;
}
