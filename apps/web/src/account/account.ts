import type { CreateModelKeyInput } from '@prix/contracts';
import { createApi } from '../lib/api.ts';
import { mountActions } from './actions.ts';
import {
  clearMessage,
  clearOnInput,
  controlOf,
  fieldOf,
  fieldValue,
  fill,
  focusFirstInvalid,
  reloadWith,
  report,
  setBusy,
  showFailure,
  showRefusal,
  wordsOf,
} from './dom.ts';
import { checkKey, checkModel, checkPrompt } from './validate.ts';

/** The forms of the account page. Each sends one request and reloads to show what the API now says. */

function submitButton(form: HTMLFormElement): HTMLButtonElement | null {
  return form.querySelector<HTMLButtonElement>('button[type="submit"]');
}

function mountPromptForm(): void {
  const form = document.querySelector<HTMLFormElement>('form[data-prompt-form]');
  const button = form && submitButton(form);
  const field = form && fieldOf(form, 'prompt');
  if (!form || !button || !field) return;
  const words = wordsOf(form);
  clearOnInput(field);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (button.disabled) return;
    clearMessage(form);
    const area = controlOf(field);
    const prompt = (area?.value ?? '').trim();
    const saved = area instanceof HTMLTextAreaElement ? area.defaultValue.trim() : null;
    // Saving the same prompt would use up one of the day's changes for nothing.
    if (report(field, prompt === saved ? (words.promptSame ?? '') : checkPrompt(prompt, words))) {
      focusFirstInvalid(form);
      return;
    }
    setBusy(button, true);
    const result = await createApi().updateAgent(form.dataset.agent ?? '', { prompt });
    if (result.ok) {
      reloadWith('prompt-saved');
      return;
    }
    setBusy(button, false);
    showRefusal(
      form,
      result,
      (name) => (name === 'prompt' ? field : null),
      (name, message) => fill(words[`${name}Rejected`] ?? words.rejected ?? '', { message }),
    );
  });
}

/** A Pro agent's owner chooses which saved key the agent runs on. */
function mountAgentKeyForm(): void {
  const form = document.querySelector<HTMLFormElement>('form[data-agent-key-form]');
  const button = form && submitButton(form);
  if (!form || !button) return;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (button.disabled) return;
    clearMessage(form);
    setBusy(button, true);
    const result = await createApi().updateAgent(form.dataset.agent ?? '', {
      modelKeyId: fieldValue(form, 'modelKeyId'),
    });
    if (result.ok) {
      reloadWith('agent-key-set');
      return;
    }
    setBusy(button, false);
    showFailure(form, result);
  });
}

/**
 * The model key form. The key leaves this page once, in the body of one request to Prix, and
 * is not kept: the field is emptied before the page reloads, nothing here writes it to
 * storage, to the address, to the console or back into the page, and no message repeats any
 * part of it. What the page shows afterwards is the last four characters the API returns.
 */
function mountKeyForm(): void {
  const form = document.querySelector<HTMLFormElement>('form[data-key-form]');
  const button = form && submitButton(form);
  if (!form || !button) return;
  const words = wordsOf(form);
  const fields: Record<string, HTMLElement | null> = {
    provider: fieldOf(form, 'provider'),
    model: fieldOf(form, 'model'),
    apiKey: fieldOf(form, 'apiKey'),
  };
  for (const field of Object.values(fields)) if (field) clearOnInput(field);
  const lookup = (name: string): Element | null => fields[name] ?? null;
  // Never the API's message: the page's own sentence for the field.
  const rejected = (name: string): string => words[`${name}Rejected`] ?? '';

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (button.disabled) return;
    clearMessage(form);
    const provider = fieldValue(form, 'provider');
    const model = fieldValue(form, 'model').trim();
    const apiKey = fieldValue(form, 'apiKey').trim();
    const wrong = [
      report(fields.model ?? null, checkModel(model, words)),
      report(fields.apiKey ?? null, checkKey(apiKey, words)),
    ];
    // The provider is a choice from the list the API sent; the API refuses any other.
    if (provider === '') wrong.push(report(lookup('provider'), rejected('provider')));
    const input = { provider, model, apiKey } as CreateModelKeyInput;
    if (wrong.includes(true)) {
      focusFirstInvalid(form);
      return;
    }

    setBusy(button, true);
    const result = await createApi().createModelKey(input);
    if (result.ok) {
      const keyControl = fields.apiKey && controlOf(fields.apiKey);
      if (keyControl) keyControl.value = '';
      reloadWith('key-saved');
      return;
    }
    setBusy(button, false);
    showRefusal(form, result, lookup, rejected);
  });
}

export function mountAccount(): void {
  mountActions();
  mountPromptForm();
  mountAgentKeyForm();
  mountKeyForm();
}
