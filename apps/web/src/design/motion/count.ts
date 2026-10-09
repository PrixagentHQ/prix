/**
 * A figure below the fold counts up once, from zero to the value in its text, as it scrolls into view.
 *
 *   <p data-count>+9.84%</p>          import '../design/motion/count.ts';
 *
 * The text is the final figure and stays so without script. The module reads the number out of
 * it and keeps everything around the number: the sign, a currency sign, a percent sign, the
 * decimals and the thousands separators. A figure that is in view at load is left as it is.
 */
import { calm, inBrowser, MOTION, onceSeen } from './shared.ts';

const NUMBER = /^([^\d]*)(\d[\d,]*(?:\.\d+)?)(.*)$/s;
const running = new WeakMap<HTMLElement, number>();

function format(value: number, decimals: number, grouped: boolean): string {
  const fixed = value.toFixed(decimals);
  if (!grouped) return fixed;
  const [whole = '', rest] = fixed.split('.');
  const withCommas = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return rest === undefined ? withCommas : `${withCommas}.${rest}`;
}

/**
 * Stops a count that is running and leaves the element's text to the caller, for good: a figure
 * that something else has started to write is never counted afterwards.
 */
export function stopCount(element: HTMLElement): void {
  const frame = running.get(element);
  if (frame !== undefined) cancelAnimationFrame(frame);
  running.delete(element);
  element.dataset.countOff = '';
}

/** Counts the element's figure up from zero. Does nothing when the text holds no number. */
export function countUp(element: HTMLElement, duration: number = MOTION.draw): void {
  const final = element.textContent ?? '';
  const match = NUMBER.exec(final.trim());
  if (!match || calm() || element.dataset.countOff !== undefined) return;
  const [, before = '', digits = '', after = ''] = match;
  const end = Number(digits.replaceAll(',', ''));
  if (!Number.isFinite(end)) return;
  const decimals = digits.includes('.') ? digits.length - digits.indexOf('.') - 1 : 0;
  const grouped = digits.includes(',');
  const started = performance.now();
  const step = (now: number): void => {
    const progress = Math.min(1, (now - started) / duration);
    if (progress >= 1) {
      element.textContent = final;
      running.delete(element);
      return;
    }
    element.textContent = `${before}${format(end * (1 - (1 - progress) ** 3), decimals, grouped)}${after}`;
    running.set(element, requestAnimationFrame(step));
  };
  step(started);
}

/** Counts every `[data-count]` under `root` once, as it shows. */
export function initCount(root: ParentNode = document): void {
  onceSeen(root.querySelectorAll<HTMLElement>('[data-count]'), (element) => countUp(element));
}

if (inBrowser) initCount();
