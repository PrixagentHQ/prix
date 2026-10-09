import { createManager, patchManager } from '../../arena/social/writes.ts';
import {
  clearMessage,
  clearOnInput,
  errorSentences,
  fieldOf,
  fieldValue,
  fill,
  focusFirstInvalid,
  reloadWith,
  report,
  setBusy,
  setFieldError,
  showConfirmation,
  showFailure,
  showRefusal,
  wordsOf,
} from '../dom.ts';
import { allocationOf, bpsToPercent, checkRows, targetsOf, type WeightLimits, type WeightRow } from './weights.ts';

/**
 * The paper manager page, in the browser: one form that creates a manager or changes the allocation
 * of one, and the one-press actions pause, resume and close. It checks the weights with plain code
 * and shows the cash they leave, and sends one request. Everything the server decides stays its
 * own: eligibility of the agents, the slots, the day's one change, the weights in force.
 *
 * The page holds no sentence of its own: every word was rendered by the server into `data-words`.
 */

interface Limits extends WeightLimits {
  nameMin: number;
  nameMax: number;
}

interface Choice {
  id: string;
  label: string;
}

interface EditTarget {
  id: string;
  name: string;
  schedule: 'weekly' | 'hold';
  targetsBps: Record<string, number>;
}

function parse<T>(value: string | undefined, fallback: T): T {
  try {
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

function mountConfirm(group: HTMLElement): void {
  const ask = group.querySelector<HTMLButtonElement>('[data-confirm-ask]');
  const panel = group.querySelector<HTMLElement>('[data-confirm-panel]');
  if (!ask || !panel) return;
  const show = (open: boolean): void => {
    panel.hidden = !open;
    ask.hidden = open;
    // Focus goes to the question, not to the button that confirms: a second Enter confirms nothing.
    (open ? panel : ask).focus();
  };
  ask.addEventListener('click', () => show(true));
  panel.querySelector('[data-confirm-cancel]')?.addEventListener('click', () => show(false));
  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') show(false);
  });
}

/** Pause, resume and close: one PATCH each, then a reload so that the page shows what the API now says. */
function mountStatus(): void {
  document.addEventListener('click', async (event) => {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>('button[data-status]');
    if (!button || button.disabled) return;
    const act = parse<{ id: string; status: 'active' | 'paused' | 'closed'; done: string } | null>(
      button.dataset.status,
      null,
    );
    if (!act) return;
    const scope = button.closest<HTMLElement>('[data-scope]') ?? document.body;
    clearMessage(scope);
    setBusy(button, true);
    const result = await patchManager(act.id, { status: act.status });
    if (result.ok) {
      reloadWith(act.done);
      return;
    }
    setBusy(button, false);
    showFailure(scope, result);
  });
}

export function mountManagers(): void {
  showConfirmation();
  for (const group of document.querySelectorAll<HTMLElement>('[data-confirm]')) mountConfirm(group);
  mountStatus();

  const form = document.querySelector<HTMLFormElement>('form[data-manager-form]');
  const wrap = document.querySelector<HTMLElement>('[data-editor-wrap]');
  const submit = form?.querySelector<HTMLButtonElement>('[data-submit]');
  if (!form || !wrap || !submit) return;

  const words = wordsOf(form);
  const limits = parse<Limits>(form.dataset.limits, {
    minAgents: 2,
    maxAgents: 5,
    minWeightBps: 500,
    maxWeightBps: 4000,
    nameMin: 3,
    nameMax: 32,
  });
  const choices = parse<Choice[]>(form.dataset.agents, []);
  const rows = [...form.querySelectorAll<HTMLElement>('[data-row]')];
  const heading = document.getElementById('manager-form-heading');
  const nameWrap = form.querySelector<HTMLElement>('[data-name-wrap]');
  const intro = form.querySelector<HTMLElement>('[data-create-intro]');
  const cancelWrap = form.querySelector<HTMLElement>('[data-cancel-wrap]');
  const cancel = form.querySelector<HTMLButtonElement>('[data-cancel-edit]');
  const addRow = form.querySelector<HTMLButtonElement>('[data-add-row]');
  const cash = form.querySelector<HTMLElement>('[data-cash]');
  const targetsField = form.querySelector<HTMLElement>('fieldset[data-field="targetsBps"]');
  const fields = {
    name: fieldOf(form, 'name'),
    targets: targetsField,
  };
  let editing: EditTarget | null = null;

  const select = (row: HTMLElement): HTMLSelectElement | null => row.querySelector('select');
  const weight = (row: HTMLElement): HTMLInputElement | null => row.querySelector('input[type="text"]');
  const shown = (): HTMLElement[] => rows.filter((row) => !row.hidden);

  // The agent lists are built here from the data of the page, with text nodes only.
  for (const row of rows) {
    const control = select(row);
    if (!control) continue;
    for (const choice of choices) {
      const option = document.createElement('option');
      option.value = choice.id;
      option.textContent = choice.label;
      control.append(option);
    }
  }

  const current = (): WeightRow[] =>
    shown().map((row) => ({ id: select(row)?.value ?? '', percent: weight(row)?.value ?? '' }));

  // The cash that the weights leave, said as the weights are typed.
  const showCash = (): void => {
    if (!cash) return;
    const { sumBps, cashBps } = allocationOf(current());
    cash.textContent =
      cashBps < 0
        ? fill(words.cashOver ?? '', { sum: bpsToPercent(sumBps), over: bpsToPercent(-cashBps) })
        : fill(words.cashLine ?? '', { sum: bpsToPercent(sumBps), cash: bpsToPercent(cashBps) });
    cash.classList.toggle('mgr-cash--over', cashBps < 0);
  };

  // Rows are numbered by position, so a removed row leaves no gap in the labels.
  const renumber = (): void => {
    const visible = shown();
    visible.forEach((row, index) => {
      const n = String(index + 1);
      const first = row.querySelector<HTMLLabelElement>('.field-label');
      if (first) first.textContent = fill(words.rowLabel ?? '', { n });
      const remove = row.querySelector<HTMLButtonElement>('[data-remove-row]');
      if (remove) {
        const text = fill(words.removeRow ?? '', { n });
        remove.textContent = text;
        remove.dataset.label = text;
        // Two agents is the least a manager can hold, so those two rows cannot be removed.
        remove.hidden = visible.length <= limits.minAgents;
      }
    });
    if (addRow) addRow.hidden = visible.length >= limits.maxAgents;
    showCash();
  };

  const clearRow = (row: HTMLElement): void => {
    const control = select(row);
    const input = weight(row);
    if (control) control.value = '';
    if (input) input.value = '';
    for (const field of row.querySelectorAll('[data-field]')) setFieldError(field, null);
  };

  addRow?.addEventListener('click', () => {
    const next = rows.find((row) => row.hidden);
    if (!next) return;
    next.hidden = false;
    renumber();
    select(next)?.focus();
  });

  form.addEventListener('click', (event) => {
    const remove = (event.target as Element | null)?.closest<HTMLButtonElement>('[data-remove-row]');
    if (!remove) return;
    const row = remove.closest<HTMLElement>('[data-row]');
    if (!row || shown().length <= limits.minAgents) return;
    const index = shown().indexOf(row);
    clearRow(row);
    row.hidden = true;
    renumber();
    // Focus stays in the list of rows, on the one that took the place of the removed row.
    const stay = shown()[Math.min(index, shown().length - 1)];
    select(stay as HTMLElement)?.focus();
  });

  form.addEventListener('input', showCash);
  form.addEventListener('change', showCash);
  for (const field of form.querySelectorAll('[data-field]')) clearOnInput(field);

  const mode = (target: EditTarget | null): void => {
    editing = target;
    if (heading) {
      heading.textContent = target ? fill(words.editTitle ?? '', { name: target.name }) : (words.createTitle ?? '');
    }
    if (nameWrap) nameWrap.hidden = target !== null;
    if (intro) intro.hidden = target !== null;
    if (cancelWrap) cancelWrap.hidden = target === null;
    submit.dataset.label = target ? submit.dataset.editLabel : submit.dataset.createLabel;
    submit.dataset.busyLabel = target ? submit.dataset.editBusy : submit.dataset.createBusy;
    submit.textContent = submit.dataset.label ?? '';
    clearMessage(form);
  };

  const reset = (): void => {
    for (const row of rows) clearRow(row);
    rows.forEach((row, index) => {
      row.hidden = index >= limits.minAgents;
    });
    const input = nameWrap?.querySelector('input');
    if (input) input.value = '';
    const weekly = form.querySelector<HTMLInputElement>('input[name="schedule"][value="weekly"]');
    if (weekly) weekly.checked = true;
    renumber();
  };

  // "Edit the allocation" fills the form with the manager's latest allocation.
  document.addEventListener('click', (event) => {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>('button[data-edit]');
    if (!button || button.disabled) return;
    const target = parse<EditTarget | null>(button.dataset.edit, null);
    if (!target) return;
    reset();
    mode(target);
    const entries = Object.entries(target.targetsBps);
    entries.forEach(([agentId, bps], index) => {
      const row = rows[index];
      const control = row ? select(row) : null;
      const input = row ? weight(row) : null;
      if (!row || !control || !input) return;
      row.hidden = false;
      // An agent that is not in the list (it left the first page, or is no longer public) stays
      // in the allocation as it is, under its id, so that saving never drops it silently.
      if (![...control.options].some((option) => option.value === agentId)) {
        const option = document.createElement('option');
        option.value = agentId;
        option.textContent = fill(words.unknownAgent ?? '', { id: agentId });
        control.append(option);
      }
      control.value = agentId;
      input.value = bpsToPercent(bps);
    });
    const radio = form.querySelector<HTMLInputElement>(`input[name="schedule"][value="${target.schedule}"]`);
    if (radio) radio.checked = true;
    wrap.hidden = false;
    renumber();
    heading?.setAttribute('tabindex', '-1');
    heading?.focus();
    wrap.scrollIntoView({ block: 'start' });
  });

  cancel?.addEventListener('click', () => {
    reset();
    mode(null);
    // Back where the person came from: the form is closed again when every slot is in use.
    const slotsFull = document.querySelector('[data-slots]')?.getAttribute('data-full') === 'true';
    if (slotsFull) wrap.hidden = true;
  });

  renumber();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    clearMessage(form);

    const name = fieldValue(form, 'name').trim();
    const schedule =
      form.querySelector<HTMLInputElement>('input[name="schedule"]:checked')?.value === 'hold' ? 'hold' : 'weekly';
    const input = current();
    const result = checkRows(input, limits);

    // Each row's problem goes beside its own field; a problem of the whole goes under the rows.
    const sentence = (issue: string | null): string | null => {
      if (issue === 'agent_missing') return words.agentMissing ?? '';
      if (issue === 'agent_twice') return words.agentTwice ?? '';
      if (issue === 'weight_missing') return words.weightMissing ?? '';
      if (issue === 'weight_range') return words.weightRange ?? '';
      return null;
    };
    const wrong: boolean[] = [];
    if (editing === null) {
      let problem: string | null = null;
      if (name.length < limits.nameMin) problem = fill(words.nameShort ?? '', { min: String(limits.nameMin) });
      else if (name.length > limits.nameMax) problem = fill(words.nameLong ?? '', { max: String(limits.nameMax) });
      wrong.push(report(fields.name, problem));
    }
    shown().forEach((row, index) => {
      const issue = result.rows[index] ?? null;
      const target = issue === 'weight_missing' || issue === 'weight_range' ? weight(row) : select(row);
      const field = target?.closest('[data-field]') ?? null;
      for (const own of row.querySelectorAll('[data-field]')) if (own !== field) setFieldError(own, null);
      wrong.push(report(field, sentence(issue)));
    });
    if (targetsField) {
      const whole =
        result.whole === 'count'
          ? fill(words.countWrong ?? '', {})
          : result.whole === 'over'
            ? (words.weightsOver ?? '')
            : null;
      setFieldError(targetsField, whole);
      if (whole) wrong.push(true);
    }
    if (wrong.includes(true)) {
      focusFirstInvalid(form);
      return;
    }

    const targetsBps = targetsOf(input);
    const lookup = (field: string): Element | null =>
      field === 'name' ? fields.name : field === 'targetsBps' || field === 'policy' ? targetsField : null;
    const rejected = (field: string, message: string): string =>
      field === 'name' ? fill(words.nameRejected ?? '', { message }) : fill(words.weightsRejected ?? '', { message });
    const sentences = errorSentences(form);
    // The daily limit means a different thing when changing an allocation than when creating a manager.
    if (editing !== null && words.changeLimit) sentences.rate_limited = words.changeLimit;

    setBusy(submit, true);
    const result_ =
      editing === null
        ? await createManager({ name, targetsBps, schedule })
        : await patchManager(editing.id, { policy: { targetsBps, schedule } });
    if (result_.ok) {
      reloadWith(editing === null ? 'manager-created' : 'manager-saved');
      return;
    }
    setBusy(submit, false);
    showRefusal(form, result_, lookup, rejected, { name_taken: 'name', name_not_allowed: 'name' }, sentences);
  });
}
