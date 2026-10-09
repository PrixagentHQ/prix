import {
  isAddress,
  lookupTrust,
  TRUST_KINDS,
  type TrustKind,
  type TrustLabels,
  type TrustView,
} from './trust-client.ts';

/**
 * Wires the lookup form of TrustPage.astro. The page renders the form and every state in words on
 * the server; this script only shows one state at a time and fills the result. All text it writes
 * is set with textContent, so nothing from the API is ever parsed as markup.
 */

interface Words {
  labels: TrustLabels;
  errors: Record<string, string>;
  unusable: string;
  offline: string;
  badAddress: string;
  busyLabel: string;
  headings: { method: string; facts: string; observations: string; blindSpots: string };
}

const STATES = ['empty', 'loading', 'error', 'result'] as const;
type State = (typeof STATES)[number];

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  content?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

function list(items: string[]): HTMLUListElement {
  const ul = el('ul');
  for (const item of items) ul.append(el('li', undefined, item));
  return ul;
}

/** A part of the answer's card. Every part after the first starts under a hairline, as in a panel. */
function section(title: string, ...body: HTMLElement[]): HTMLElement {
  const wrap = el('section', 'trust-block panel-part');
  wrap.append(el('h2', 'title', title), ...body);
  return wrap;
}

function renderView(view: TrustView, words: Words): HTMLElement[] {
  const out: HTMLElement[] = [];
  const method = el('dl', 'facts facts--label-10');
  method.append(el('dt', undefined, words.labels.method), el('dd', undefined, view.method));
  out.push(section(words.headings.method, method));
  const facts = el('dl', 'facts facts--label-10');
  for (const fact of view.facts) facts.append(el('dt', undefined, fact.label), el('dd', 'trust-value', fact.value));
  out.push(section(words.headings.facts, facts));
  if (view.observations.length > 0) out.push(section(words.headings.observations, list(view.observations)));
  out.push(section(words.headings.blindSpots, list(view.blindSpots)));
  // The first part opens the card, so it has no hairline above it.
  out[0]?.classList.remove('panel-part');
  return out;
}

export function mountTrust(): void {
  const root = document.querySelector<HTMLElement>('[data-trust]');
  const form = root?.querySelector<HTMLFormElement>('form');
  if (!root || !form) return;
  let words: Words;
  try {
    words = JSON.parse(root.dataset.words ?? '') as Words;
  } catch {
    return;
  }
  const panels = new Map<State, HTMLElement>();
  for (const state of STATES) {
    const panel = root.querySelector<HTMLElement>(`[data-state="${state}"]`);
    if (panel) panels.set(state, panel);
  }
  const show = (state: State): void => {
    for (const [name, panel] of panels) panel.hidden = name !== state;
  };
  const kindSelect = form.elements.namedItem('kind') as HTMLSelectElement;
  const addressInput = form.elements.namedItem('address') as HTMLInputElement;
  const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  // The error of the address field, not of the first field in the form.
  const fieldError = form.querySelector<HTMLElement>('[data-field="address"] [data-field-error]');
  const errorBody = panels.get('error')?.querySelector<HTMLElement>('.notice-body') ?? null;
  const resultBox = panels.get('result');
  const idleLabel = button?.textContent ?? '';

  const fail = (message: string): void => {
    if (errorBody) errorBody.textContent = message;
    show('error');
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const kind = kindSelect.value as TrustKind;
    const address = addressInput.value.trim();
    if (fieldError) {
      fieldError.hidden = true;
      fieldError.textContent = '';
    }
    addressInput.removeAttribute('aria-invalid');
    if (!TRUST_KINDS.includes(kind) || !isAddress(address)) {
      if (fieldError) {
        fieldError.textContent = words.badAddress;
        fieldError.hidden = false;
      }
      addressInput.setAttribute('aria-invalid', 'true');
      addressInput.focus();
      return;
    }
    show('loading');
    if (button) {
      button.disabled = true;
      button.textContent = words.busyLabel;
    }
    const outcome = await lookupTrust(kind, address, words.labels);
    if (button) {
      button.disabled = false;
      button.textContent = idleLabel;
    }
    if (outcome.ok && resultBox) {
      resultBox.replaceChildren(...renderView(outcome.view, words));
      show('result');
      return;
    }
    if (outcome.ok) return;
    if (outcome.status === 0) fail(words.offline);
    else fail((outcome.code !== null ? words.errors[outcome.code] : undefined) ?? words.unusable);
  });
}
