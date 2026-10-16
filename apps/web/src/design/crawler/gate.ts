/**
 * The crawler's gate (docs/DESIGN.md section 30), in the layout's own script. It loads nothing
 * unless the layout marked the page (`main[data-crawler]`), the window is a desktop's (a fine
 * pointer that hovers, 1100 pixels and wider), the reader has not asked for less motion or less
 * data, and this device was not found too slow in this session. Then, after `load`, an idle
 * moment, the face of the field and the reader's first pointer move inside `main`, the crawler
 * comes in. A move over the header comes first when the pointer arrives from the address bar or
 * the tabs: it is ignored, and the gate keeps listening (R20).
 *
 * A phone or a tablet (a coarse pointer) never loads it, whatever it taps: this version is for a
 * desktop only, and the phone comes later (section 30).
 *
 * The crawler is built as its own bundle (crawler/crawl.ts) and comes in as a plain script, never
 * through `import()`: an `import()` here would make Vite add its preload helper, and the layout's
 * script, inline on every page, would become two more requests on every page.
 */
import crawlUrl from './crawl.ts?worker&url';

const can = (query: string) => matchMedia(query).matches;
const page = document.querySelector('main[data-crawler]');
let slow = false;
try {
  slow = sessionStorage.getItem('prix-crawler') !== null;
} catch {
  // Storage refused: the crawler may come, and a slow device still sends it away.
}

if (
  page &&
  !slow &&
  !(navigator as { connection?: { saveData?: boolean } }).connection?.saveData &&
  !can('(prefers-reduced-motion: reduce)') &&
  can('(hover: hover) and (pointer: fine) and (min-width: 1100px)')
) {
  new Promise((done) => (document.readyState === 'complete' ? done(0) : addEventListener('load', done, { once: true })))
    .then(
      () =>
        new Promise((done) =>
          'requestIdleCallback' in window ? requestIdleCallback(done, { timeout: 2000 }) : setTimeout(done, 1),
        ),
    )
    .then(() => document.fonts.load('16px "Prix ASCII"'))
    .catch(() => {})
    .then(() => {
      const move = (e: PointerEvent) => {
        if (e.pointerType === 'touch') return;
        // Only a move over `main` itself, below the header: anything else is ignored, never removed.
        const box = page.getBoundingClientRect();
        if (
          !(e.target instanceof Node && page.contains(e.target)) ||
          e.clientX < box.left ||
          e.clientX >= box.right ||
          e.clientY < box.top ||
          e.clientY >= box.bottom
        ) {
          return;
        }
        removeEventListener('pointermove', move);
        if (can('(prefers-reduced-motion: reduce)')) return;
        const script = document.createElement('script');
        script.src = crawlUrl;
        script.dataset.x = String(e.clientX);
        script.dataset.y = String(e.clientY);
        document.head.append(script);
      };
      addEventListener('pointermove', move, { passive: true });
    });
}
