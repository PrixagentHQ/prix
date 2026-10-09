/**
 * The toast: one line that says what just happened, shown for a moment at the foot of the window.
 *
 *   import { toast } from '../design/motion/toast.ts';
 *   toast('Following Semis Rotation');
 *
 * It fills the `Toast` of the page, or makes one when the page has none. The region is a live
 * region, so the words are read out. A second toast replaces the first. It rises and fades in
 * 200 milliseconds; a visitor who asked for less motion sees it appear and disappear.
 */
let timer: number | undefined;

export function toast(text: string, duration = 2400): void {
  let region = document.querySelector<HTMLElement>('[data-toast]');
  if (!region) {
    region = document.createElement('div');
    region.className = 'toast';
    region.dataset.toast = '';
    region.setAttribute('role', 'status');
    region.setAttribute('aria-live', 'polite');
    document.body.append(region);
    // The first words must arrive after the region exists, or no screen reader announces them.
    void region.offsetWidth;
  }
  const shown = region;
  shown.textContent = text;
  shown.classList.add('is-shown');
  window.clearTimeout(timer);
  timer = window.setTimeout(() => shown.classList.remove('is-shown'), duration);
}
