/**
 * The crosshair of a Chart. The pointer, a finger or the arrow keys pick a point of the line;
 * a hairline and a dot mark it, a label names its time, and the figure above the plot shows the
 * value there. Leaving the plot puts everything back on the latest point.
 *
 * Chart.astro imports this module itself. The chart is whole without it: this adds the reading
 * of single points and the range tabs. Left and right move one point, with Shift five; Home and
 * End go to the ends. Nothing here animates except what motion.css fades.
 */
import { stopCount } from './count.ts';
import { inBrowser } from './shared.ts';

type Point = [value: number, figure: string, tone: number, detail: string, tip: string];

function initChart(root: HTMLElement): void {
  let points: Point[];
  try {
    points = JSON.parse(root.dataset.points ?? '[]') as Point[];
  } catch {
    return;
  }
  const last = points.length - 1;
  if (last < 1) return;

  const figure = root.querySelector<HTMLElement>('[data-chart-figure]');
  const detail = root.querySelector<HTMLElement>('[data-chart-detail]');
  const panels = [...root.querySelectorAll<HTMLElement>('[data-range]')];
  let panel = panels.find((candidate) => !candidate.hidden) ?? panels[0];
  if (!panel) return;
  let at = last;

  const show = (index: number, held: boolean): void => {
    const current = panel;
    const point = points[index];
    const plot = current?.querySelector<HTMLElement>('[data-chart-plot]');
    if (!current || !point || !plot) return;
    at = index;
    const first = Number(current.dataset.first);
    const lo = Number(current.dataset.lo);
    const hi = Number(current.dataset.hi);
    const x = last === first ? 100 : ((index - first) / (last - first)) * 100;
    const y = hi === lo ? 50 : ((hi - point[0]) / (hi - lo)) * 100;

    const dot = plot.querySelector('circle');
    const cross = plot.querySelector('.linechart-cross');
    const tip = plot.querySelector<HTMLElement>('.linechart-tip');
    dot?.setAttribute('cx', `${x}%`);
    dot?.setAttribute('cy', `${y}%`);
    cross?.setAttribute('x1', `${x}%`);
    cross?.setAttribute('x2', `${x}%`);
    if (tip) {
      tip.textContent = point[4];
      const width = plot.clientWidth;
      const left = Math.min(width - tip.offsetWidth, Math.max(0, (x / 100) * width - tip.offsetWidth / 2));
      tip.style.transform = `translateX(${left}px)`;
    }
    plot.classList.toggle('is-held', held);
    plot.setAttribute('aria-valuenow', String(index));
    plot.setAttribute('aria-valuetext', `${point[3]}, ${point[1]}`);

    if (figure) {
      stopCount(figure);
      figure.textContent = point[1];
      figure.classList.toggle('gain', point[2] > 0);
      figure.classList.toggle('loss', point[2] < 0);
    }
    if (detail) detail.textContent = point[3];
  };

  for (const candidate of panels) {
    const plot = candidate.querySelector<HTMLElement>('[data-chart-plot]');
    if (!plot) continue;
    const first = Number(candidate.dataset.first);
    const pick = (event: PointerEvent): void => {
      const box = plot.getBoundingClientRect();
      const share = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
      show(first + Math.round(share * (last - first)), true);
    };
    plot.addEventListener('pointermove', pick);
    plot.addEventListener('pointerdown', pick);
    plot.addEventListener('pointerleave', () => show(last, false));
    plot.addEventListener('pointercancel', () => show(last, false));
    plot.addEventListener('blur', () => show(last, false));
    plot.addEventListener('keydown', (event) => {
      const steps: Record<string, number> = {
        ArrowLeft: -1,
        ArrowRight: 1,
        ArrowDown: -1,
        ArrowUp: 1,
        Home: -last,
        End: last,
      };
      const by = steps[event.key];
      if (by === undefined) return;
      event.preventDefault();
      const stride = Math.abs(by) === 1 && event.shiftKey ? 5 : 1;
      show(Math.min(last, Math.max(first, at + by * stride)), true);
    });
  }
  window.addEventListener('resize', () => show(at, false));

  const ranges = root.querySelector<HTMLElement>('[data-chart-ranges]');
  if (ranges) {
    ranges.hidden = false;
    ranges.addEventListener('click', (event) => {
      const button = (event.target as Element).closest<HTMLElement>('[data-range-button]');
      const next = panels[Number(button?.dataset.rangeButton)];
      if (!button || !next || next === panel) return;
      for (const other of ranges.querySelectorAll('[data-range-button]')) {
        other.setAttribute('aria-pressed', other === button ? 'true' : 'false');
      }
      for (const other of panels) other.hidden = other !== next;
      panel = next;
      show(last, false);
    });
  }
}

/** Gives every `[data-chart]` under `root` its crosshair. */
export function initCrosshair(root: ParentNode = document): void {
  for (const chart of root.querySelectorAll<HTMLElement>('[data-chart]')) {
    if (chart.dataset.chartReady !== undefined) continue;
    chart.dataset.chartReady = '';
    initChart(chart);
  }
}

if (inBrowser) initCrosshair();
