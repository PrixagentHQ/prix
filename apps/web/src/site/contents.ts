/**
 * Marks the entry of a contents list whose section is being read: the last section whose heading
 * has passed a line a quarter of the way down the window. Only `aria-current` changes, so the
 * mark is a style and nothing moves. It reads the page; it computes nothing that the page shows.
 */
export function markContents(root: ParentNode = document): void {
  const nav = root.querySelector<HTMLElement>('[data-contents]');
  if (!nav) return;
  const entries = [...nav.querySelectorAll<HTMLAnchorElement>('[data-contents-link]')]
    .map((link) => ({ link, target: document.getElementById(link.dataset.contentsLink ?? '') }))
    .filter((entry): entry is { link: HTMLAnchorElement; target: HTMLElement } => entry.target !== null);
  if (entries.length === 0) return;

  let current: HTMLAnchorElement | null = null;
  let queued = false;

  const update = (): void => {
    queued = false;
    const line = window.innerHeight / 4;
    // Above the first heading the reader is at the start of the first section.
    let found: HTMLAnchorElement | null = entries[0]?.link ?? null;
    for (const { link, target } of entries) {
      if (target.getBoundingClientRect().top <= line) found = link;
      else break;
    }
    // At the very end of the page the last section is the one being read, however short it is.
    const atEnd = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
    if (atEnd) found = entries[entries.length - 1]?.link ?? found;
    if (found === current) return;
    current?.removeAttribute('aria-current');
    found?.setAttribute('aria-current', 'location');
    current = found;
  };

  const queue = (): void => {
    if (queued) return;
    queued = true;
    window.requestAnimationFrame(update);
  };

  window.addEventListener('scroll', queue, { passive: true });
  window.addEventListener('resize', queue, { passive: true });
  update();
}
