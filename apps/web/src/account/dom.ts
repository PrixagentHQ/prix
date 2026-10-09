import type { ApiFailure } from '../lib/api.ts';

/**
 * What the scripts of the account screens share. Every word a script shows was rendered by
 * the server from the copy deck: a script moves text that is already in the page, and holds
 * no sentence of its own.
 */

/** Slots of a message: `{name}` in the rendered text is replaced by the value, as text. */
export type Slots = Record<string, string>;

function fillText(node: Node, slots: Slots): void {
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    const before = current.nodeValue ?? '';
    if (!before.includes('{')) continue;
    current.nodeValue = before.replace(/\{(\w+)\}/g, (match, name: string) => slots[name] ?? match);
  }
}

/**
 * Shows the message `name` of `scope` in the outlet of `scope`: a copy of the
 * `<template data-message="name">` the server rendered. Returns the outlet, or null when the
 * page has no such message.
 */
export function showMessage(scope: ParentNode, name: string, slots: Slots = {}): HTMLElement | null {
  const outlet = scope.querySelector<HTMLElement>('[data-outlet]');
  const template = scope.querySelector<HTMLTemplateElement>(`template[data-message="${name}"]`);
  if (!outlet || !template) return null;
  const copy = template.content.cloneNode(true);
  fillText(copy, slots);
  outlet.replaceChildren(copy);
  outlet.dataset.showing = name;
  return outlet;
}

export function clearMessage(scope: ParentNode): void {
  const outlet = scope.querySelector<HTMLElement>('[data-outlet]');
  if (!outlet) return;
  outlet.replaceChildren();
  delete outlet.dataset.showing;
}

/**
 * Names the wait on a button and stops a second press, or puts the button back.
 * Focus stays on the button: a browser may drop it from a control that becomes disabled.
 */
export function setBusy(button: HTMLButtonElement, busy: boolean): void {
  const hadFocus = document.activeElement === button || document.activeElement === document.body;
  button.disabled = busy;
  if (busy) button.setAttribute('aria-busy', 'true');
  else button.removeAttribute('aria-busy');
  const label = busy ? button.dataset.busyLabel : button.dataset.label;
  if (label) button.textContent = label;
  if (!busy && hadFocus) button.focus({ preventScroll: true });
}

/** The control of a field the design system rendered: `[data-field]` around an input, a select or a textarea. */
export function controlOf(field: Element): HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null {
  return field.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input, select, textarea');
}

/**
 * Puts an error beside its field, or takes it away with `null`. `field` is the element with
 * `data-field` (TextInput, Textarea, Select) or the fieldset of a group of choices.
 */
export function setFieldError(field: Element, message: string | null): void {
  const slot = field.querySelector<HTMLElement>('[data-field-error]');
  const marked = field instanceof HTMLFieldSetElement ? field : controlOf(field);
  if (slot) {
    slot.textContent = message ?? '';
    slot.hidden = message === null;
  }
  if (!marked) return;
  if (message === null) {
    delete marked.dataset.invalid;
    // A prompt past its limit stays marked: its running count already says so.
    const count = field.querySelector('[data-count-for]');
    if (!count?.classList.contains('field-error')) marked.removeAttribute('aria-invalid');
  } else {
    marked.dataset.invalid = 'true';
    marked.setAttribute('aria-invalid', 'true');
  }
}

/** Marks a field without a message of its own, when the page already says what is wrong beside it. */
export function markInvalid(field: Element): void {
  controlOf(field)?.setAttribute('aria-invalid', 'true');
}

/** Clears a field's error as soon as the person changes the field. */
export function clearOnInput(field: Element): void {
  const handler = (): void => setFieldError(field, null);
  field.addEventListener('input', handler);
  field.addEventListener('change', handler);
}

/** The sentences the server chose for each API error code of one form, read from `data-errors`. */
export function errorSentences(scope: ParentNode): Record<string, string> {
  const holder = scope.querySelector<HTMLElement>('[data-errors]');
  try {
    return JSON.parse(holder?.dataset.errors ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

/**
 * The sentence for a failed call. A call that never reached Prix says so; an unknown code
 * gets the sentence for a fault on Prix's side. The API's own message is never used here.
 */
export function sentenceFor(sentences: Record<string, string>, failure: ApiFailure): string {
  if (failure.status === 502 && navigator.onLine === false && sentences.offline) return sentences.offline;
  return sentences[failure.error.code] ?? sentences.internal ?? '';
}

/**
 * Shows a failed call in the form's outlet. An ended session gets its own message with the
 * way back in; everything else is the form's "failed" message with the sentence for the code.
 */
export function showFailure(scope: ParentNode, failure: ApiFailure, sentences = errorSentences(scope)): void {
  if (failure.error.code === 'unauthorized' && showMessage(scope, 'session')) return;
  showMessage(scope, 'failed', { message: sentenceFor(sentences, failure) });
}

const DONE = 'prix-done';

/** Keeps the name of what just happened for the next page load. A fixed word, never anything typed. */
function remember(done: string): void {
  try {
    window.sessionStorage.setItem(DONE, done);
  } catch {
    // Storage is blocked. The page still shows the new state; it only lacks the confirmation.
  }
}

/**
 * Loads the page again so the server shows the new state, and remembers the name of what
 * just happened for that one load, so the page can confirm it in words. Only that name is
 * kept, a fixed word such as "key-saved": never anything the person typed.
 */
export function reloadWith(done: string): void {
  remember(done);
  window.location.reload();
}

/** The same, for an action that ends on another page: the builder ends on the account page. */
export function goWith(done: string, href: string): void {
  remember(done);
  window.location.assign(href);
}

/**
 * After that reload: shows the confirmation the server rendered for the action, in the
 * outlet beside it, and moves focus there so it is seen and read out. It shows once.
 */
export function showConfirmation(): void {
  let done: string | null = null;
  try {
    done = window.sessionStorage.getItem(DONE);
    window.sessionStorage.removeItem(DONE);
  } catch {
    return;
  }
  if (!done || !/^[a-z-]+$/.test(done)) return;
  const template = document.querySelector<HTMLTemplateElement>(`template[data-done="${done}"]`);
  const outlet = template?.parentElement?.querySelector<HTMLElement>('[data-done-outlet]');
  if (!template || !outlet) return;
  outlet.replaceChildren(template.content.cloneNode(true));
  outlet.tabIndex = -1;
  outlet.focus();
}

/** Fills the `{name}` slots of a sentence the server rendered. */
export function fill(template: string, slots: Slots): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => slots[name] ?? match);
}

/** The sentences a form's own checks use, which the server rendered into `data-words`. */
export function wordsOf(form: HTMLElement): Record<string, string> {
  try {
    return JSON.parse(form.dataset.words ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

/** The field `name` of a form: the element the design system marked with `data-field`. */
export function fieldOf(scope: ParentNode, name: string): HTMLElement | null {
  return scope.querySelector<HTMLElement>(`[data-field="${name}"]`);
}

/** What the field `name` holds, as typed. */
export function fieldValue(scope: ParentNode, name: string): string {
  const field = fieldOf(scope, name);
  return (field && controlOf(field)?.value) ?? '';
}

/** Moves focus to the first field in error, so the person lands on what to correct. */
export function focusFirstInvalid(scope: ParentNode): void {
  const marked = scope.querySelector<HTMLElement>('[aria-invalid="true"]');
  const target = marked instanceof HTMLFieldSetElement ? marked.querySelector<HTMLElement>('input') : marked;
  target?.focus();
}

/**
 * Shows what a field check found: a sentence beside the field, or only the mark when the
 * sentence is empty because the field's running count already says it. Returns true if the
 * field is in error.
 */
export function report(field: Element | null, problem: string | null): boolean {
  if (!field || problem === null) return false;
  if (problem) setFieldError(field, problem);
  else markInvalid(field);
  return true;
}

/**
 * Shows the API's refusal in the right place. A refusal about one field goes beside that
 * field: `invalid_input` names it, and `byCode` names it for a code such as `name_taken`.
 * For `invalid_input` the sentence is `rejected(field, message)`, which may use the API's
 * message; for every other code it is the page's own sentence. Anything else goes to the
 * form's outlet.
 */
export function showRefusal(
  form: HTMLElement,
  failure: ApiFailure,
  lookup: (name: string) => Element | null,
  rejected: (name: string, message: string) => string,
  byCode: Record<string, string> = {},
  sentences = errorSentences(form),
): void {
  const { code, field, message } = failure.error;
  const name = code === 'invalid_input' ? (field?.split('.')[0] ?? '') : (byCode[code] ?? '');
  const target = name ? lookup(name) : null;
  if (!target) {
    showFailure(form, failure, sentences);
    return;
  }
  setFieldError(target, code === 'invalid_input' ? rejected(name, message) : sentenceFor(sentences, failure));
  focusFirstInvalid(form);
}
