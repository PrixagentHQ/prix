import { linkFork } from '../../arena/social/writes.ts';
import type { ApiFailure } from '../../lib/api.ts';
import { createApi } from '../../lib/api.ts';
import {
  clearMessage,
  clearOnInput,
  errorSentences,
  fieldOf,
  fieldValue,
  fill,
  focusFirstInvalid,
  goWith,
  report,
  type Slots,
  sentenceFor,
  setBusy,
  showMessage,
  showRefusal,
  wordsOf,
} from '../dom.ts';
import { checkName, checkPrompt } from '../validate.ts';

/**
 * The fork builder, in the browser. It checks what was typed, builds an ordinary agent with the
 * unchanged POST /api/agents, then asks the server to link it to its parent. Whether the agent is
 * built and whether it is linked is the API's decision alone: nothing here claims a slot, a
 * division, a window or a rule. The checks only save the person a round trip.
 *
 * The page holds no sentence of its own: every word was rendered by the server into `data-words`
 * or into a `<template data-message>`.
 */

const nameKey = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '');

/** A failure the person can only wait out, as opposed to one that will not change. */
function canTryAgain(failure: ApiFailure): boolean {
  if (failure.error.code === 'rate_limited') return true;
  return failure.status >= 500 || failure.status === 502;
}

export function mountFork(): void {
  const form = document.querySelector<HTMLFormElement>('form[data-fork]');
  const button = form?.querySelector<HTMLButtonElement>('[data-submit]');
  const area = form?.querySelector<HTMLTextAreaElement>('textarea[name="prompt"]');
  if (!form || !button || !area) return;

  const words = wordsOf(form);
  const parentId = form.dataset.parentId ?? '';
  const parentName = form.dataset.parentName ?? '';
  const division = form.dataset.division === 'pro' ? 'pro' : 'open';
  const published = form.dataset.published;
  const guardMin = Number(form.dataset.guardMin) || 4;
  const windowMs = (Number(form.dataset.window) || 600) * 1000;
  const next = form.dataset.next ?? '/account';
  const blocked = button.dataset.blocked === 'true';
  const sameHint = form.querySelector<HTMLElement>('[data-same-hint]');

  const fields: Record<string, Element | null> = {
    name: fieldOf(form, 'name'),
    prompt: fieldOf(form, 'prompt'),
    modelKeyId: fieldOf(form, 'modelKeyId'),
  };
  for (const field of Object.values(fields)) if (field) clearOnInput(field);

  // The submit button stays off while the prompt is the published one word for word.
  const identical = (): boolean => published !== undefined && area.value.trim() === published.trim();
  let working = false;
  const sync = (): void => {
    const same = identical();
    if (sameHint) sameHint.hidden = !same;
    button.disabled = same || working || blocked;
  };
  area.addEventListener('input', sync);
  sync();

  let created: { id: string; startedAt: number; done: string } | null = null;

  const lock = (): void => {
    // The agent exists now. Building another one from this form would only fail.
    for (const control of form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
      'input, textarea, select',
    )) {
      control.disabled = true;
    }
    button.hidden = true;
  };

  const finished = (): void => {
    if (created) goWith(created.done, next);
  };

  const outletFocus = (outlet: HTMLElement | null): void => {
    if (!outlet) return;
    outlet.tabIndex = -1;
    outlet.focus();
  };

  const linkFailed = (failure: ApiFailure): void => {
    const { code, field } = failure.error;
    const closed = created ? Date.now() - created.startedAt >= windowMs : false;
    let message: string;
    let again = canTryAgain(failure) && !closed;
    if (code === 'invalid_input' && field === 'parentId') {
      message = words.linkWindowClosed ?? '';
      again = false;
    } else if (code === 'invalid_input' && field === 'name') {
      message = words.linkNameRefused ?? '';
      again = false;
    } else if (code === 'invalid_input' && field === 'prompt') {
      message = words.linkPromptRefused ?? '';
      again = false;
    } else if (code === 'rate_limited') {
      message = words.linkCapped ?? '';
    } else if (closed) {
      message = words.linkWindowClosed ?? '';
    } else if (code === 'not_found' || code === 'invalid_input' || code === 'forbidden' || code === 'unauthorized') {
      message = words.linkRefused ?? '';
      again = false;
    } else {
      message = sentenceFor(errorSentences(form), failure);
    }
    const slots: Slots = { message };
    outletFocus(showMessage(form, again ? 'link-retry' : 'link-final', slots));
  };

  // "Link to <parent>" again, while the window is open. The server decides whether it still is.
  form.addEventListener('click', async (event) => {
    const again = (event.target as Element | null)?.closest<HTMLButtonElement>('[data-link-again]');
    if (!again || again.disabled || !created) return;
    if (Date.now() - created.startedAt >= windowMs) {
      outletFocus(showMessage(form, 'link-final', { message: words.linkWindowClosed ?? '' }));
      return;
    }
    setBusy(again, true);
    const linked = await linkFork(created.id, parentId);
    if (linked.ok) {
      finished();
      return;
    }
    linkFailed(linked);
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (button.disabled || created) return;
    clearMessage(form);

    const name = fieldValue(form, 'name').trim();
    const prompt = fieldValue(form, 'prompt').trim();
    const modelKeyId = fieldValue(form, 'modelKeyId');
    const containsParent = nameKey(parentName).length >= guardMin && nameKey(name).includes(nameKey(parentName));
    const wrong = [
      report(fields.name ?? null, checkName(name, words)),
      report(fields.name ?? null, containsParent ? fill(words.nameContains ?? '', { parent: parentName }) : null),
      report(fields.prompt ?? null, checkPrompt(prompt, words)),
      report(fields.modelKeyId ?? null, division === 'pro' && !modelKeyId ? (words.keyMissing ?? '') : null),
    ];
    if (wrong.includes(true)) {
      focusFirstInvalid(form);
      return;
    }
    if (published !== undefined && prompt === published.trim()) {
      sync();
      return;
    }

    const rejected = (field: string, message: string): string =>
      fill(words[`${field}Rejected`] ?? words.rejected ?? '', { message });
    const lookup = (field: string): Element | null => fields[field] ?? null;

    working = true;
    setBusy(button, true);
    const api = createApi();
    const made = await api.createAgent(
      division === 'pro' ? { name, prompt, division, modelKeyId } : { name, prompt, division },
    );
    if (!made.ok) {
      working = false;
      setBusy(button, false);
      sync();
      const sentences = errorSentences(form);
      const full = words[division === 'pro' ? 'fullPro' : 'fullOpen'];
      if (full) sentences.league_full = full;
      showRefusal(
        form,
        made,
        lookup,
        rejected,
        { name_taken: 'name', name_not_allowed: 'name', league_full: 'name' },
        sentences,
      );
      return;
    }

    // Publishing is a second request, because the agent has to exist first. If it fails the prompt
    // stays private, which is the safe side, and the account page says so.
    let done = 'agent-built';
    if (form.querySelector<HTMLInputElement>('input[name="publish"]')?.checked) {
      const publishedNow = await api.updateAgent(made.data.agent.id, { promptPublic: true });
      if (!publishedNow.ok) done = 'agent-built-private';
    }
    created = { id: made.data.agent.id, startedAt: Date.now(), done };
    lock();

    const linked = await linkFork(created.id, parentId);
    if (linked.ok) {
      finished();
      return;
    }
    linkFailed(linked);
  });
}
