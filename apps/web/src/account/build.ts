import type { CreateAgentInput } from '@prix/contracts';
import { createApi } from '../lib/api.ts';
import { mountTemplates, mountTemplatesSignedOut } from './build/picker.ts';
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
  setBusy,
  showRefusal,
  wordsOf,
} from './dom.ts';
import { checkName, checkPrompt } from './validate.ts';

const DRAFT = 'prix.builder-draft';
const DRAFT_FIELDS = ['name', 'prompt', 'division', 'publish', 'modelKeyId'] as const;

/** What was typed, kept in this tab only so that a trip to the account page to save a key loses nothing. */
function readDraft(): Record<string, string> {
  try {
    const raw = window.sessionStorage.getItem(DRAFT);
    const value: unknown = raw ? JSON.parse(raw) : null;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/**
 * Writes the form's fields into the draft. A key the builder does not own is left as it is: it is
 * never read, shown or sent. A field the form no longer holds (an unticked box) leaves the draft.
 */
function writeDraft(form: HTMLFormElement): void {
  try {
    const data = new FormData(form);
    const draft: Record<string, unknown> = { ...readDraft() };
    for (const key of DRAFT_FIELDS) {
      delete draft[key];
      const value = data.get(key);
      if (typeof value === 'string') draft[key] = value;
    }
    window.sessionStorage.setItem(DRAFT, JSON.stringify(draft));
  } catch {
    // Without storage the builder works as before.
  }
}

function restoreDraft(form: HTMLFormElement): void {
  const draft = readDraft();
  for (const key of DRAFT_FIELDS) {
    const value = draft[key];
    if (typeof value !== 'string') continue;
    const controls = form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
      `[name="${key}"]`,
    );
    for (const control of controls) {
      if (control instanceof HTMLInputElement && (control.type === 'radio' || control.type === 'checkbox')) {
        control.checked = control.type === 'radio' ? control.value === value : true;
      } else {
        control.value = value;
      }
    }
  }
}

/** The bar under the prompt: the share of the longest prompt used, in step with every key. */
function mountMeter(form: HTMLFormElement, area: HTMLTextAreaElement): void {
  const fill = form.querySelector<SVGRectElement>('.build-meter .meter-fill');
  const max = Number(form.querySelector<HTMLElement>('[data-count-for]')?.dataset.max);
  if (!fill || !(max > 0)) return;
  const update = (): void => {
    fill.style.transform = `scaleX(${Math.min(1, area.value.length / max)})`;
  };
  // The bar is drawn whole and scaled, so that it moves by transform alone. Its first state is
  // put in place without a transition, so nothing moves before the person types.
  fill.style.transition = 'none';
  update();
  fill.setAttribute('width', '100');
  void fill.getBoundingClientRect();
  fill.style.removeProperty('transition');
  area.addEventListener('input', update);
}

/**
 * The card beside the form: the typed name in it at once, and the card of the chosen division.
 * A change of division fades the other card in; under reduced motion it simply shows.
 */
function mountPreview(form: HTMLFormElement, division: () => 'open' | 'pro'): void {
  const preview = document.querySelector<HTMLElement>('[data-preview]');
  const input = form.querySelector<HTMLInputElement>('input[name="name"]');
  if (!preview || !input) return;
  const fallback = preview.dataset.defaultName ?? '';
  const names = preview.querySelectorAll<HTMLElement>('.agent-card-name span');
  const cards = preview.querySelectorAll<HTMLElement>('[data-preview-division]');

  const showName = (): void => {
    const typed = input.value.trim();
    for (const name of names) name.textContent = typed || fallback;
  };
  let shown = division();
  const showDivision = (): void => {
    const chosen = division();
    for (const card of cards) {
      const match = card.dataset.previewDivision === chosen;
      card.hidden = !match;
      if (match && chosen !== shown) {
        card.classList.remove('is-switched');
        // Read the layout once so the animation starts again on a second change.
        void card.offsetWidth;
        card.classList.add('is-switched');
      }
    }
    shown = chosen;
  };
  input.addEventListener('input', showName);
  form.addEventListener('change', showDivision);
  showName();
  showDivision();
}

/**
 * The agent builder, in the browser. It checks what was typed with the contract's constants and plain code,
 * sends one request, and puts a refusal beside the field it is about. Whether the agent is
 * built is the API's decision alone: nothing here claims a slot, a division or a limit.
 *
 * Signed out, the page has no form: the templates in the sign-in card keep a chosen text in this
 * tab's draft, which `restoreDraft` puts in the prompt field once the person has signed in.
 */
export function mountBuild(): void {
  mountTemplatesSignedOut(document, DRAFT);
  const form = document.querySelector<HTMLFormElement>('form[data-build]');
  const button = form?.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (!form || !button) return;

  const words = wordsOf(form);
  const fields: Record<string, Element | null> = {
    name: fieldOf(form, 'name'),
    prompt: fieldOf(form, 'prompt'),
    division: form.querySelector('fieldset#division'),
    modelKeyId: fieldOf(form, 'modelKeyId'),
  };
  for (const field of Object.values(fields)) if (field) clearOnInput(field);

  const division = (): 'open' | 'pro' => (new FormData(form).get('division') === 'pro' ? 'pro' : 'open');

  // The model key belongs to a Pro agent, so its field shows only while Pro is chosen.
  const proOnly = form.querySelector<HTMLElement>('[data-pro-only]');
  const sync = (): void => {
    if (proOnly) proOnly.hidden = division() !== 'pro';
  };
  restoreDraft(form);
  form.addEventListener('change', sync);
  form.addEventListener('input', () => writeDraft(form));
  form.addEventListener('change', () => writeDraft(form));
  sync();

  const area = form.querySelector<HTMLTextAreaElement>('textarea[name="prompt"]');
  if (area) {
    mountTemplates(form, area);
    mountMeter(form, area);
  }
  mountPreview(form, division);
  // A restored draft is put in place without events: let the count, the bar and the card catch up.
  for (const control of form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input[name="name"], textarea')) {
    if (control.value) control.dispatchEvent(new Event('input', { bubbles: true }));
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (button.disabled) return;
    clearMessage(form);

    const chosen = division();
    const name = fieldValue(form, 'name').trim();
    const prompt = fieldValue(form, 'prompt').trim();
    const modelKeyId = fieldValue(form, 'modelKeyId');
    const wrong = [
      report(fields.name ?? null, checkName(name, words)),
      report(fields.prompt ?? null, checkPrompt(prompt, words)),
      report(fields.modelKeyId ?? null, chosen === 'pro' && !modelKeyId ? (words.keyMissing ?? '') : null),
    ];
    if (wrong.includes(true)) {
      focusFirstInvalid(form);
      return;
    }

    const rejected = (field: string, message: string): string =>
      fill(words[`${field}Rejected`] ?? words.rejected ?? '', { message });
    const lookup = (field: string): Element | null => fields[field] ?? null;

    const input: CreateAgentInput =
      chosen === 'pro' ? { name, prompt, division: chosen, modelKeyId } : { name, prompt, division: chosen };

    setBusy(button, true);
    const api = createApi();
    const created = await api.createAgent(input);
    if (!created.ok) {
      setBusy(button, false);
      // A full division is said beside the choice of division, in the words for that division.
      const sentences = errorSentences(form);
      const full = words[chosen === 'pro' ? 'fullPro' : 'fullOpen'];
      if (full) sentences.league_full = full;
      showRefusal(
        form,
        created,
        lookup,
        rejected,
        { name_taken: 'name', name_not_allowed: 'name', league_full: 'division' },
        sentences,
      );
      return;
    }

    // Publishing is a second request, because the agent has to exist first. If it fails the
    // prompt stays private, which is the safe side, and the account page says so.
    let done = 'agent-built';
    if (form.querySelector<HTMLInputElement>('input[name="publish"]')?.checked) {
      const published = await api.updateAgent(created.data.agent.id, { promptPublic: true });
      if (!published.ok) done = 'agent-built-private';
    }
    try {
      window.sessionStorage.removeItem(DRAFT);
    } catch {
      // Nothing to clear.
    }
    goWith(done, form.dataset.next ?? '/account');
  });
}
