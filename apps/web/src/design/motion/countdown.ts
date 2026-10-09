/**
 * The time left until a moment, kept running once a second.
 *
 *   <Countdown to={nextRoundIso} />      import '../design/motion/countdown.ts';
 *
 * The server writes the time left when the page was made, so the figure stands without script.
 * When the moment arrives the element fires `prix:countdown-end` once, which bubbles: the page
 * that owns the data decides what to read next. Nothing here moves; the figures are tabular, so
 * the line does not shift as they change.
 */
import { inBrowser } from './shared.ts';

const two = (value: number): string => String(value).padStart(2, '0');

/** "54:18", "02:54:18", "2d 02:54:18". Never negative. The server and the browser both use it. */
export function countdownText(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const days = Math.floor(hours / 24);
  const clock = `${two(Math.floor(seconds / 60) % 60)}:${two(seconds % 60)}`;
  if (hours === 0) return clock;
  return `${days > 0 ? `${days}d ` : ''}${two(hours % 24)}:${clock}`;
}

/** Keeps every `[data-countdown]` under `root` running. The attribute holds the moment as an ISO time. */
export function initCountdown(root: ParentNode = document): void {
  const clocks = [...root.querySelectorAll<HTMLElement>('[data-countdown]')]
    .map((element) => ({ element, to: Date.parse(element.dataset.countdown ?? ''), ended: false }))
    .filter((clock) => Number.isFinite(clock.to));
  if (clocks.length === 0) return;
  const tick = (): void => {
    const now = Date.now();
    for (const clock of clocks) {
      const text = countdownText(clock.to - now);
      if (clock.element.textContent !== text) clock.element.textContent = text;
      if (!clock.ended && clock.to <= now) {
        clock.ended = true;
        clock.element.dispatchEvent(new CustomEvent('prix:countdown-end', { bubbles: true }));
      }
    }
  };
  tick();
  window.setInterval(tick, 1000);
}

if (inBrowser) initCountdown();
