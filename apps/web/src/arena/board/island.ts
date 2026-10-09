/**
 * The one island of the board pages (the home page and the league page). It computes nothing the
 * API decides: it hides and shows cards the server rendered, puts them in the order of their
 * published place or their creation time, switches the form, follows an agent through the follow
 * client, and brings in what the server renders when the page is read again.
 *
 *   import { mountBoard } from './board/island.ts';
 *   mountBoard();
 *
 * Every word it shows was rendered by the server into a `data-` attribute.
 */

import { formatCount } from '../../content/format.ts';
import { initCountdown } from '../../design/motion/countdown.ts';
import { arrive } from '../../design/motion/feed.ts';
import { toast } from '../../design/motion/toast.ts';
import { moveElements, switchBoard } from '../../design/reorder.ts';
import { createFollowApi } from '../../lib/follow-api.ts';

const FORM_KEY = 'prix-board-form';
/** How many decisions a feed keeps when new ones arrive, unless its list names its own `data-rows`. */
const FEED_ROWS = 8;

type Form = 'cards' | 'list';

function readForm(): Form | null {
  try {
    const value = window.sessionStorage.getItem(FORM_KEY);
    return value === 'list' || value === 'cards' ? value : null;
  } catch {
    return null;
  }
}

function keepForm(form: Form): void {
  try {
    window.sessionStorage.setItem(FORM_KEY, form);
  } catch {
    // A private window may refuse; the form then lasts as long as the page.
  }
}

const cardsOf = (board: HTMLElement): HTMLElement[] => [
  ...board.querySelectorAll<HTMLElement>(':scope > [data-agent]'),
];

function fill(template: string, slots: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(slots, name) ? String(slots[name]) : match,
  );
}

// --- the form: cards or a table, kept for the visit -----------------------------------------------

function markForm(group: HTMLElement | null, form: Form): void {
  for (const button of group?.querySelectorAll<HTMLButtonElement>('button[data-value]') ?? []) {
    button.setAttribute('aria-pressed', button.dataset.value === form ? 'true' : 'false');
  }
}

/** Names the form in the address (`view=list`), so a reload or a shared link comes back the same. */
function writeForm(root: HTMLElement, form: Form): void {
  const value = form === 'list' ? 'list' : null;
  const url = new URL(window.location.href);
  if (value) url.searchParams.set('view', value);
  else url.searchParams.delete('view');
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  for (const link of root.querySelectorAll<HTMLAnchorElement>('[data-board-order] a, [data-board-division] a')) {
    const target = new URL(link.href, window.location.href);
    if (value) target.searchParams.set('view', value);
    else target.searchParams.delete('view');
    link.href = `${target.pathname}${target.search}`;
  }
}

function wireForm(root: HTMLElement): void {
  const wrap = root.querySelector<HTMLElement>('[data-board-form-wrap]');
  const group = root.querySelector<HTMLElement>('[data-board-form]');
  const board = root.querySelector<HTMLElement>('[data-board]');
  if (!wrap || !group || !board) return;
  wrap.hidden = false;
  // The address decides when it names a form. Otherwise the form of the visit is put back, at
  // once and without travel: nobody has seen the other one yet.
  const named = new URL(window.location.href).searchParams.get('view');
  const kept = named === 'list' ? null : readForm();
  if (kept === 'list') {
    board.classList.add('board--list');
    markForm(group, kept);
    writeForm(root, kept);
  }
  group.addEventListener('click', (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>('button[data-value]');
    const form = button?.dataset.value;
    if (form !== 'cards' && form !== 'list') return;
    const live = root.querySelector<HTMLElement>('[data-board]');
    if (live) switchBoard(live, form);
    markForm(group, form);
    keepForm(form);
    writeForm(root, form);
  });
}

// --- the order: the published order, or the newest first ----------------------------------------

function sortCards(board: HTMLElement, order: string): void {
  const cards = cardsOf(board);
  const place = (card: HTMLElement): number => Number(card.dataset.place ?? 0);
  cards.sort((a, b) => {
    if (order === 'new') {
      const at = a.dataset.created ?? '';
      const bt = b.dataset.created ?? '';
      if (at !== bt) return !at ? 1 : !bt ? -1 : at < bt ? 1 : -1;
    }
    return place(a) - place(b);
  });
  const head = board.querySelector(':scope > .board-head');
  let anchor: Element | null = head;
  for (const card of cards) {
    if (anchor) anchor.after(card);
    else board.prepend(card);
    anchor = card;
  }
}

function setParam(href: string, name: string, value: string | null): string {
  const url = new URL(href, window.location.href);
  if (value) url.searchParams.set(name, value);
  else url.searchParams.delete(name);
  url.searchParams.delete('page');
  return `${url.pathname}${url.search}`;
}

function wireOrder(root: HTMLElement): void {
  const group = root.querySelector<HTMLElement>('[data-board-order]');
  group?.addEventListener('click', (event) => {
    const link = (event.target as Element).closest<HTMLAnchorElement>('a[data-value]');
    const board = root.querySelector<HTMLElement>('[data-board]');
    // Like the server, the script puts the cards of the page on screen in order: one page at a time.
    if (!link || !board) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const order = link.dataset.value === 'new' ? 'new' : 'top';
    const title = root.querySelector<HTMLElement>('#board-title');
    const named = order === 'new' ? title?.dataset.titleNew : title?.dataset.titleTop;
    if (title && named) title.textContent = named;
    for (const each of group.querySelectorAll<HTMLAnchorElement>('a[data-value]')) {
      if (each === link) each.setAttribute('aria-current', 'true');
      else each.removeAttribute('aria-current');
    }
    moveElements(board, () => sortCards(board, order));
    const value = order === 'new' ? 'new' : null;
    window.history.replaceState(window.history.state, '', setParam(window.location.href, 'order', value));
    for (const each of root.querySelectorAll<HTMLAnchorElement>('[data-board-division] a')) {
      each.href = setParam(each.href, 'order', value);
    }
  });
}

// --- the search: the header's field hides the cards whose name does not contain the text ----------

function applySearch(root: HTMLElement, query: string, travel: boolean): void {
  const board = root.querySelector<HTMLElement>('[data-board]');
  if (!board) return;
  const wanted = query.trim().toLocaleLowerCase('en');
  const change = (): void => {
    for (const card of cardsOf(board)) {
      card.removeAttribute('data-filtered');
      card.hidden = wanted !== '' && !(card.dataset.name ?? '').includes(wanted);
    }
  };
  if (travel) moveElements(board, change);
  else change();
  // A person who searches hears how many agents are left; the cards themselves say nothing.
  const said = root.querySelector<HTMLElement>('[data-board-shown]');
  if (said && travel) {
    const count = cardsOf(board).filter((card) => !card.hidden).length;
    const template = (count === 1 ? said.dataset.one : said.dataset.other) ?? '';
    said.textContent = wanted === '' ? '' : fill(template, { count: formatCount(count) });
  }
  const none = root.querySelector<HTMLElement>('[data-board-nomatch]');
  if (!none) return;
  const shown = cardsOf(board).some((card) => !card.hidden);
  none.hidden = shown;
  const title = none.querySelector<HTMLElement>('.empty-title');
  const template = none.querySelector<HTMLElement>('[data-template]')?.dataset.template;
  if (title && template) title.textContent = fill(template, { query: query.trim() });
}

function wireSearch(root: HTMLElement): HTMLInputElement | null {
  const field = document.querySelector<HTMLInputElement>('input[data-agent-search]');
  if (!field) return null;
  // The league page names the search in its address, so a refresh and the back button keep it.
  const onLeague = window.location.pathname.startsWith('/league');
  if (field.value.trim() !== '') applySearch(root, field.value, false);
  field.addEventListener('input', () => {
    applySearch(root, field.value, true);
    if (onLeague) {
      const value = field.value.trim().slice(0, 64);
      window.history.replaceState(window.history.state, '', setParam(window.location.href, 'q', value || null));
    }
  });
  return field;
}

// --- following: in place, with the API deciding ------------------------------------------------

function wireFollow(root: HTMLElement): void {
  const words = root.dataset;
  const api = createFollowApi();
  document.addEventListener('click', async (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>('button[data-follow-agent]');
    const agentId = button?.dataset.followAgent;
    if (!button || !agentId || button.disabled) return;
    const name = button.dataset.followName ?? '';
    const following = button.getAttribute('aria-pressed') === 'true';
    const twins = [...document.querySelectorAll<HTMLButtonElement>('button[data-follow-agent]')].filter(
      (each) => each.dataset.followAgent === agentId,
    );
    for (const each of twins) {
      each.disabled = true;
      each.setAttribute('aria-busy', 'true');
    }
    const result = following ? await api.deleteFollow(agentId) : await api.putFollow(agentId, { notify: false });
    for (const each of twins) {
      each.disabled = false;
      each.removeAttribute('aria-busy');
      if (result.ok) each.setAttribute('aria-pressed', following ? 'false' : 'true');
    }
    if (result.ok) {
      toast(fill((following ? words.msgUnfollowed : words.msgFollowed) ?? '', { name }));
      return;
    }
    const { code, field } = result.error;
    if (code === 'unauthorized') toast(words.msgUnauthorized ?? '');
    else if (code === 'invalid_input' && field === 'follows') toast(words.msgLimit ?? '');
    else if (code === 'forbidden') toast(words.msgForbidden ?? '');
    else if (code === 'rate_limited') toast(words.msgRate ?? '');
    else toast(words.msgFailed ?? '');
  });
}

// --- reading the page again ------------------------------------------------------------------------

const adopt = (from: Element): Node[] => [...from.childNodes].map((node) => document.importNode(node, true));

function syncAttributes(target: HTMLElement, source: HTMLElement): void {
  for (const name of target.getAttributeNames()) {
    if (name !== 'hidden' && !source.hasAttribute(name)) target.removeAttribute(name);
  }
  for (const name of source.getAttributeNames()) {
    if (name === 'data-filtered') continue;
    const value = source.getAttribute(name) ?? '';
    if (target.getAttribute(name) !== value) target.setAttribute(name, value);
  }
}

/** The board keeps its cards: each one takes the server's new markup, and cards that moved travel. */
function updateBoard(board: HTMLElement, fresh: HTMLElement): void {
  const incoming = [...fresh.querySelectorAll<HTMLElement>(':scope > [data-agent]')];
  moveElements(board, () => {
    const current = new Map(cardsOf(board).map((card) => [card.dataset.agent, card]));
    let anchor: Element | null = board.querySelector(':scope > .board-head');
    for (const source of incoming) {
      let card = current.get(source.dataset.agent);
      if (card) {
        current.delete(source.dataset.agent);
        syncAttributes(card, source);
        if (card.innerHTML !== source.innerHTML) card.replaceChildren(...adopt(source));
      } else {
        card = document.importNode(source, true);
        card.removeAttribute('data-filtered');
      }
      if (anchor) anchor.after(card);
      else board.prepend(card);
      anchor = card;
    }
    for (const gone of current.values()) gone.remove();
  });
}

/** New decisions arrive at the top of the feed; the oldest leave at the foot. */
function updateFeed(list: HTMLElement, fresh: HTMLElement): void {
  const known = new Set(
    [...list.querySelectorAll<HTMLElement>(':scope > [data-feed-row]')].map((row) => row.dataset.key),
  );
  const incoming = [...fresh.querySelectorAll<HTMLElement>(':scope > [data-feed-row]')].filter(
    (row) => !known.has(row.dataset.key),
  );
  for (const row of incoming.reverse()) arrive(list, document.importNode(row, true));
  const rows = [...list.querySelectorAll<HTMLElement>(':scope > [data-feed-row]')];
  for (const extra of rows.slice(Number(list.dataset.rows) || FEED_ROWS)) extra.remove();
}

/** Puts focus back on the same agent's link, or on the same link of a region that was replaced. */
function keepFocus(): () => void {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return () => {};
  const region = active.closest<HTMLElement>('[data-live]');
  if (!region) return () => {};
  const name = region.dataset.live;
  const agent = active.closest<HTMLElement>('[data-agent]')?.dataset.agent;
  const follow = active.hasAttribute('data-follow-agent');
  const href = active.getAttribute('href');
  return () => {
    if (document.activeElement === active && active.isConnected) return;
    const now = [...document.querySelectorAll<HTMLElement>('[data-live]')].find((each) => each.dataset.live === name);
    if (!now) return;
    const card = agent
      ? [...now.querySelectorAll<HTMLElement>('[data-agent]')].find((each) => each.dataset.agent === agent)
      : undefined;
    const target = card
      ? card.querySelector<HTMLElement>(follow ? '[data-follow-agent], .agent-card-action a' : '.agent-card-name a')
      : [...now.querySelectorAll<HTMLElement>('a')].find((link) => link.getAttribute('href') === href);
    target?.focus({ preventScroll: true });
  };
}

function wireRefresh(root: HTMLElement, field: HTMLInputElement | null): void {
  const clock = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-live="clock"]');
  let timer: number | undefined;
  let busy = false;
  let dueAt = 0;
  let lastNudge = 0;
  const seconds = (): number => Number(clock()?.dataset.refresh) || 0;

  const schedule = (wait = seconds()): void => {
    window.clearTimeout(timer);
    if (wait <= 0) return;
    dueAt = Date.now() + wait * 1000;
    if (!document.hidden) timer = window.setTimeout(refresh, wait * 1000);
  };

  async function refresh(): Promise<void> {
    if (busy) return;
    busy = true;
    const stale = root.querySelector<HTMLElement>('[data-league-stale]');
    try {
      const response = await fetch(window.location.href, {
        headers: { accept: 'text/html' },
        credentials: 'same-origin',
        cache: 'no-cache',
      });
      if (!response.ok) throw new Error('refresh failed');
      const next = new DOMParser().parseFromString(await response.text(), 'text/html');
      const pairs: Array<[HTMLElement, HTMLElement]> = [];
      for (const region of document.querySelectorAll<HTMLElement>('[data-live]')) {
        const fresh = [...next.querySelectorAll<HTMLElement>('[data-live]')].find(
          (entry) => entry.dataset.live === region.dataset.live,
        );
        // A page that no longer has the region is a different page: leave this one as it is.
        if (!fresh) throw new Error('refresh failed');
        // The price strip is one tab stop that scrolls by hand while it holds the keyboard: it
        // takes its new prices at the next read after the person has left it.
        if (region.dataset.live === 'prices' && region.contains(document.activeElement)) continue;
        if (fresh.outerHTML !== region.outerHTML) pairs.push([region, fresh]);
      }
      if (stale) stale.hidden = true;
      const restore = keepFocus();
      for (const [region, fresh] of pairs) {
        if (region.matches('[data-board]') && fresh.matches('[data-board]')) {
          updateBoard(region, fresh);
        } else if (region.matches('ol.feed') && fresh.matches('ol.feed')) {
          updateFeed(region, fresh);
        } else {
          const copy = document.importNode(fresh, true);
          region.replaceWith(copy);
          initCountdown(copy);
        }
      }
      if (field) applySearch(root, field.value, false);
      restore();
    } catch {
      // What is on screen stays. The note says that newer figures could not be read.
      if (stale) stale.hidden = false;
    } finally {
      busy = false;
      schedule();
    }
  }

  // Anything on the page may ask for a fresh read, for example after a person changed something.
  document.addEventListener('prix:league-refresh', () => void refresh());

  // When the next round starts, its ranks take a minute or two: the page looks again soon after.
  document.addEventListener('prix:countdown-end', () => {
    if (Date.now() - lastNudge < 300_000 || seconds() <= 0) return;
    lastNudge = Date.now();
    schedule(90);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      window.clearTimeout(timer);
    } else if (seconds() > 0 && Date.now() >= dueAt) {
      void refresh();
    } else if (seconds() > 0) {
      window.clearTimeout(timer);
      timer = window.setTimeout(refresh, Math.max(0, dueAt - Date.now()));
    }
  });

  schedule();
}

/**
 * The countdown to the next round, once that time has come: the banner says "Round in progress"
 * in its place, and only once, until the page reads the league again (the refresh replaces the
 * banner with the server's). A countdown that has already passed when this runs is treated the
 * same, so the figures never stand at 00:00.
 */
function roundDue(clock: Element): void {
  const banner = clock.closest('[data-live="banner"]');
  const wait = clock.closest<HTMLElement>('[data-round-wait]');
  const due = banner?.querySelector<HTMLElement>('[data-round-due]');
  if (!banner || !wait || !due) return;
  wait.hidden = true;
  due.hidden = false;
  for (const said of banner.querySelectorAll<HTMLElement>('[data-round-now]')) said.hidden = true;
}

function wireRoundDue(): void {
  for (const clock of document.querySelectorAll<HTMLElement>('[data-round-wait] [data-countdown]')) {
    const to = Date.parse(clock.dataset.countdown ?? '');
    if (Number.isFinite(to) && to <= Date.now()) roundDue(clock);
  }
  document.addEventListener('prix:countdown-end', (event) => {
    if (event.target instanceof Element) roundDue(event.target);
  });
}

export function mountBoard(): void {
  wireRoundDue();
  const root = document.querySelector<HTMLElement>('[data-board-root]');
  if (!root) return;
  wireForm(root);
  wireOrder(root);
  const field = wireSearch(root);
  wireFollow(root);
  wireRefresh(root, field);
}
