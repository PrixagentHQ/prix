import type { FeedItem } from '@prix/contracts';
import { formatTick, formatUsdMicro } from '../../content/format.ts';
import { reasonBeyond } from '../../design/feed.ts';
import { markInitials } from '../../design/mark.ts';
import type { ApiFailure } from '../../lib/api.ts';
import { createFollowApi } from '../../lib/follow-api.ts';
import {
  clearMessage,
  fill,
  reloadWith,
  setBusy,
  showConfirmation,
  showFailure,
  showMessage,
  wordsOf,
} from '../dom.ts';

/**
 * The browser script of /following. Every word it shows was rendered by the server into the
 * page (templates and `data-words`); it holds no sentence of its own. Each action sends one
 * request and reloads, so the server shows what the API now says. The client claims nothing
 * about a delay or a limit: the API decides both.
 */

function scopeOf(button: HTMLElement): HTMLElement {
  return button.closest<HTMLElement>('[data-scope]') ?? document.body;
}

/** Runs one action behind a button: names the wait, then reloads on success or shows the failure. */
async function run(
  button: HTMLButtonElement,
  call: () => Promise<{ ok: true } | ApiFailure>,
  done: string,
): Promise<void> {
  if (button.disabled) return;
  const scope = scopeOf(button);
  clearMessage(scope);
  setBusy(button, true);
  const result = await call();
  if (result.ok) {
    reloadWith(done);
    return;
  }
  setBusy(button, false);
  if (result.error.code === 'invalid_input' && result.error.field === 'follows' && showMessage(scope, 'limit')) return;
  showFailure(scope, result);
}

/**
 * Puts an agent's own mark into the mark element of a copied FeedRow. The server rendered one
 * mark per followed agent into a template keyed by agent id; the right one is cloned. An agent
 * without a template (unfollowed since the page loaded) gets the initials of its name.
 */
function drawMark(mark: Element, marks: HTMLTemplateElement | null, agentId: string, agentName: string): void {
  const source = marks
    ? [...marks.content.querySelectorAll<HTMLElement>('[data-mark-for]')].find((el) => el.dataset.markFor === agentId)
    : undefined;
  const own = source?.firstElementChild?.cloneNode(true);
  if (own instanceof HTMLElement) {
    mark.replaceWith(own);
    return;
  }
  const initials = document.createElement('span');
  initials.className = 'agent-mark agent-mark--sm';
  initials.setAttribute('aria-hidden', 'true');
  initials.textContent = markInitials(agentName);
  mark.replaceWith(initials);
}

/**
 * One decision as a FeedRow: a copy of the row the server rendered in the page's template, with
 * this item's words put in as text. Nothing from the API is read as markup.
 */
function itemNode(
  template: HTMLTemplateElement,
  marks: HTMLTemplateElement | null,
  item: FeedItem,
  words: Record<string, string>,
): HTMLElement | null {
  const row = template.content.firstElementChild?.cloneNode(true);
  if (!(row instanceof HTMLElement)) return null;
  const mark = row.querySelector('.agent-mark');
  if (mark) drawMark(mark, marks, item.agentId, item.agentName);
  const name = row.querySelector<HTMLAnchorElement>('.feed-row-name');
  if (name) {
    name.href = `/agents/${encodeURIComponent(item.agentId)}`;
    name.textContent = item.agentName;
  }
  const [division, house] = row.querySelectorAll<HTMLElement>('.feed-row-head .chip');
  if (division) {
    division.textContent = words[item.division] ?? '';
    division.classList.toggle('chip--open', item.division === 'open');
    division.classList.toggle('chip--pro', item.division === 'pro');
  }
  if (house && !item.house) house.remove();
  const time = row.querySelector('time');
  if (time) {
    time.dateTime = item.at;
    time.textContent = formatTick(item.tickId);
  }
  const fills = item.fills.map((f) =>
    fill(f.side === 'buy' ? (words.added ?? '') : (words.reduced ?? ''), {
      symbol: f.symbol,
      amount: formatUsdMicro(f.notionalMicro),
    }),
  );
  const title = fills.length > 0 ? (words.changed ?? '') : (words.unchanged ?? '');
  const what = row.querySelector('.feed-row-what');
  const detail = what?.querySelector('span');
  if (what) {
    for (const node of [...what.childNodes]) if (node.nodeType === Node.TEXT_NODE) node.remove();
    what.prepend(title);
  }
  if (detail) {
    if (fills.length > 0) detail.textContent = `${fills.join('. ')}.`;
    else detail.remove();
  }
  // The reason without the title's words, as FeedRow prints a row the server renders; a reason
  // that only repeats the title leaves no line.
  const why = row.querySelector('.feed-row-why');
  if (why) {
    const reason = reasonBeyond(title, item.reason);
    if (reason === '') why.remove();
    else why.textContent = reason;
  }
  return row;
}

function mountLoadMore(button: HTMLButtonElement): void {
  const list = document.querySelector<HTMLElement>('[data-feed]');
  const template = document.querySelector<HTMLTemplateElement>('template[data-feed-template]');
  const marks = document.querySelector<HTMLTemplateElement>('template[data-mark-templates]');
  const words = list ? wordsOf(list) : {};
  button.addEventListener('click', async () => {
    if (button.disabled || !list || !template) return;
    const scope = scopeOf(button);
    clearMessage(scope);
    setBusy(button, true);
    const result = await createFollowApi().feed({ cursor: button.dataset.cursor });
    setBusy(button, false);
    if (!result.ok) {
      showFailure(scope, result);
      return;
    }
    for (const item of result.data.items) {
      const row = itemNode(template, marks, item, words);
      if (row) list.append(row);
    }
    if (result.data.nextCursor) button.dataset.cursor = result.data.nextCursor;
    else button.closest('p')?.remove();
  });
}

/** Only an address on Telegram's own host is ever offered as a link. */
function telegramHref(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 't.me' ? url.href : null;
  } catch {
    return null;
  }
}

function mountTelegram(card: HTMLElement): void {
  const words = wordsOf(card);
  const link = card.querySelector<HTMLButtonElement>('[data-telegram-link]');
  const out = card.querySelector<HTMLElement>('[data-link-out]');
  link?.addEventListener('click', async () => {
    if (link.disabled) return;
    clearMessage(card);
    out?.replaceChildren();
    setBusy(link, true);
    const result = await createFollowApi().telegramLink();
    setBusy(link, false);
    if (!result.ok) {
      showFailure(card, result);
      return;
    }
    const href = telegramHref(result.data.url);
    if (!href || !out) {
      showFailure(card, { ok: false, status: 502, error: { code: 'internal', message: '', field: null } });
      return;
    }
    const anchor = document.createElement('a');
    anchor.className = 'button';
    anchor.href = href;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.textContent = words.linkLabel ?? '';
    const note = document.createElement('p');
    note.className = 'small';
    note.textContent = words.linkExpires ?? '';
    out.replaceChildren(anchor, note);
    anchor.focus();
  });

  const toggle = card.querySelector<HTMLButtonElement>('[data-telegram-toggle]');
  toggle?.addEventListener('click', () => {
    const enabled = toggle.dataset.enabled === 'true';
    void run(
      toggle,
      () => createFollowApi().setTelegram({ enabled: !enabled }),
      enabled ? 'telegram-paused' : 'telegram-resumed',
    );
  });

  const unlink = card.querySelector<HTMLButtonElement>('[data-telegram-unlink]');
  unlink?.addEventListener('click', () => {
    void run(unlink, () => createFollowApi().unlinkTelegram(), 'telegram-unlinked');
  });
}

export function mountFollowing(): void {
  showConfirmation();

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-note-toggle]')) {
    button.addEventListener('click', () => {
      const notify = button.dataset.notify !== 'true';
      void run(
        button,
        () => createFollowApi().putFollow(button.dataset.agent ?? '', { notify }),
        notify ? 'follow-note-on' : 'follow-note-off',
      );
    });
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-unfollow]')) {
    button.addEventListener('click', () => {
      void run(button, () => createFollowApi().deleteFollow(button.dataset.agent ?? ''), 'follow-removed');
    });
  }
  const more = document.querySelector<HTMLButtonElement>('[data-load-more]');
  if (more) mountLoadMore(more);
  const card = document.querySelector<HTMLElement>('[data-telegram]');
  if (card) mountTelegram(card);
}
