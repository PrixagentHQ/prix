import { fill } from '../dom.ts';

/**
 * The template picker of the Build page, in the browser (D-155).
 *
 * Signed in, choosing a template puts its text in the prompt field as plain text and leaves the
 * cursor at its end; nothing else on the form changes. Signed out, choosing one keeps its text as
 * the prompt of this tab's builder draft, which the form restores after the sign-in; the status
 * line says so and focus stays on the template. Either way a text the person wrote is replaced only
 * after they say so, and nothing is sent anywhere. Every word this script shows was rendered by the
 * server from the copy deck. No template is marked as chosen: a starting text is not a pick, and
 * the filled field and the status line say what happened.
 */

/**
 * Whether the field holds text the person wrote: anything but nothing or a template's own text,
 * word for word. A template they have edited is their text.
 */
export function isOwnText(value: string, templates: readonly string[]): boolean {
  return value.trim() !== '' && !templates.includes(value);
}

/**
 * Puts `value` in the field as plain text, as an edit the browser can undo where it can (so the
 * text it replaces is one undo away), and leaves the cursor at its end. A textarea's value is
 * text: markup in a template is shown as the characters it is made of.
 */
export function putText(area: HTMLTextAreaElement, value: string): void {
  area.focus();
  area.select();
  const inserted = typeof document.execCommand === 'function' && document.execCommand('insertText', false, value);
  if (!inserted || area.value !== value) {
    area.value = value;
    area.dispatchEvent(new Event('input', { bubbles: true }));
  }
  area.setSelectionRange(area.value.length, area.value.length);
}

type Draft = Record<string, unknown>;

/**
 * The builder draft of this tab, as build.ts writes it: `{}` when there is none or it does not
 * read as one, and null when the browser's storage cannot be reached at all.
 */
export function readStoredDraft(key: string): Draft | null {
  let raw: string | null;
  try {
    raw = window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
  try {
    const value: unknown = raw ? JSON.parse(raw) : null;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Draft) : {};
  } catch {
    return {};
  }
}

/**
 * Keeps `prompt` as the prompt of the builder draft under `key`, beside whatever else the draft
 * holds. Answers whether it was kept: storage that throws keeps nothing and throws nothing.
 */
export function keepPrompt(key: string, prompt: string): boolean {
  const draft = readStoredDraft(key);
  if (!draft) return false;
  try {
    window.sessionStorage.setItem(key, JSON.stringify({ ...draft, prompt }));
    return true;
  } catch {
    return false;
  }
}

function wordsOf(section: HTMLElement): Record<string, string> {
  try {
    return JSON.parse(section.dataset.words ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

interface SectionHooks {
  /** Whether what a template would replace is text the person wrote. */
  ownText: (texts: readonly string[]) => boolean;
  /** Takes the template; answers the sentence for the status line. */
  take: (button: HTMLButtonElement, words: Record<string, string>) => string;
  /** Where focus goes after a confirmed replacement: the field, or the template itself. */
  focusAfterReplace: (button: HTMLButtonElement) => void;
}

/** The buttons, the question and the status line, the same on both pages. Returns the question's closer. */
function mountSection(section: HTMLElement, hooks: SectionHooks): (returnTo: HTMLElement | null) => void {
  const words = wordsOf(section);
  const buttons = [...section.querySelectorAll<HTMLButtonElement>('button[data-template]')];
  const texts = buttons.map((button) => button.dataset.template ?? '');
  const panel = section.querySelector<HTMLElement>('[data-template-confirm]');
  const consequence = section.querySelector<HTMLElement>('[data-template-consequence]');
  const status = section.querySelector<HTMLElement>('[data-template-status]');
  // Signed out, the status line's way on: shown once a choice has been made.
  const next = section.querySelector<HTMLElement>('[data-template-sign-in]');
  let pending: HTMLButtonElement | null = null;

  const close = (returnTo: HTMLElement | null): void => {
    if (!panel || panel.hidden) return;
    panel.hidden = true;
    pending = null;
    returnTo?.focus();
  };

  const choose = (button: HTMLButtonElement): void => {
    const sentence = hooks.take(button, words);
    if (status) {
      // Emptied first, so that choosing the same template twice is still announced.
      status.textContent = '';
      status.textContent = sentence;
    }
    if (next) next.hidden = false;
  };

  const ask = (button: HTMLButtonElement): void => {
    if (!panel || !consequence) {
      // Without the question the text is never replaced: the person's text stays.
      return;
    }
    pending = button;
    consequence.textContent = fill(words.consequence ?? '', { title: button.dataset.templateName ?? '' });
    panel.hidden = false;
    panel.focus();
  };

  for (const button of buttons) {
    button.addEventListener('click', () => {
      if (hooks.ownText(texts)) ask(button);
      else {
        close(null);
        choose(button);
      }
    });
  }

  panel?.querySelector<HTMLButtonElement>('[data-template-replace]')?.addEventListener('click', () => {
    const chosen = pending;
    if (!chosen) return;
    close(null);
    choose(chosen);
    hooks.focusAfterReplace(chosen);
  });
  panel?.querySelector<HTMLButtonElement>('[data-template-keep]')?.addEventListener('click', () => close(pending));
  panel?.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    close(pending);
  });
  return (returnTo) => {
    if (panel && !panel.hidden) close(returnTo);
  };
}

/** Mounts the picker inside `form` for the prompt field `area`. Does nothing on a page without one. */
export function mountTemplates(form: HTMLFormElement, area: HTMLTextAreaElement): void {
  const section = form.querySelector<HTMLElement>('[data-templates]');
  if (!section) return;
  const close = mountSection(section, {
    ownText: (texts) => isOwnText(area.value, texts),
    take: (button, words) => {
      putText(area, button.dataset.template ?? '');
      return fill(words.filled ?? '', { title: button.dataset.templateName ?? '' });
    },
    // putText already left the cursor at the end of the field.
    focusAfterReplace: () => {},
  });
  area.addEventListener('input', () => {
    // A question about text that has since changed no longer stands.
    if (document.activeElement === area) close(null);
  });
}

/**
 * Mounts the picker of the signed-out Build page, inside the sign-in card: choosing a template
 * keeps its text as the prompt of the builder draft under `draftKey` (build.ts restores it into
 * the field once the person has signed in). Nothing is sent and no other key is written. Does
 * nothing on a page without that section.
 */
export function mountTemplatesSignedOut(root: ParentNode, draftKey: string): void {
  const section = root.querySelector<HTMLElement>('[data-templates][data-templates-keep]');
  if (!section) return;
  mountSection(section, {
    ownText: (texts) => {
      const prompt = readStoredDraft(draftKey)?.prompt;
      return typeof prompt === 'string' && isOwnText(prompt, texts);
    },
    take: (button, words) => {
      const title = button.dataset.templateName ?? '';
      const kept = keepPrompt(draftKey, button.dataset.template ?? '');
      return fill((kept ? words.kept : words.notKept) ?? '', { title });
    },
    // Focus stays on the template the person chose.
    focusAfterReplace: (button) => button.focus(),
  });
  mountSignInLink(section);
}

/**
 * The status line's "Sign in" link: pressing it moves focus to the Sign in button of the card
 * whose heading it points at, which brings that button into view. It starts nothing itself: the
 * button is the one control that asks a wallet. Without that button the link is a plain link.
 */
function mountSignInLink(section: HTMLElement): void {
  const link = section.querySelector<HTMLAnchorElement>('a[data-template-sign-in]');
  if (!link) return;
  link.addEventListener('click', (event) => {
    const id = decodeURIComponent(link.hash.slice(1));
    const heading = id ? document.getElementById(id) : null;
    const button = heading?.closest('section')?.querySelector<HTMLButtonElement>('button[data-sign-in-button]');
    if (!button) return;
    event.preventDefault();
    button.focus();
  });
}
