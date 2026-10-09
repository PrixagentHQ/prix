import { createWar, stopWar } from '../../arena/social/writes.ts';
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
  showConfirmation,
  showFailure,
  showRefusal,
  wordsOf,
} from '../dom.ts';

/**
 * The Model Wars admin page, in the browser: create a war from the models the server listed, and
 * stop the open one. The checks only save the administrator a round trip. The server checks the
 * administrator again on each call and decides everything else: the models, the dates, the one open war.
 *
 * The page holds no sentence of its own: every word was rendered by the server.
 */

interface Limits {
  titleMin: number;
  titleMax: number;
  strategyMin: number;
  strategyMax: number;
  modelsMin: number;
  modelsMax: number;
}

function mountConfirm(group: HTMLElement): void {
  const ask = group.querySelector<HTMLButtonElement>('[data-confirm-ask]');
  const panel = group.querySelector<HTMLElement>('[data-confirm-panel]');
  if (!ask || !panel) return;
  const show = (open: boolean): void => {
    panel.hidden = !open;
    ask.hidden = open;
    (open ? panel : ask).focus();
  };
  ask.addEventListener('click', () => show(true));
  panel.querySelector('[data-confirm-cancel]')?.addEventListener('click', () => show(false));
  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') show(false);
  });
}

export function mountWars(): void {
  showConfirmation();
  for (const group of document.querySelectorAll<HTMLElement>('[data-confirm]')) mountConfirm(group);

  document.addEventListener('click', async (event) => {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>('button[data-stop]');
    if (!button || button.disabled) return;
    const scope = button.closest<HTMLElement>('[data-scope]') ?? document.body;
    clearMessage(scope);
    setBusy(button, true);
    const result = await stopWar(button.dataset.stop ?? '');
    if (result.ok) {
      reloadWith('war-stopped');
      return;
    }
    setBusy(button, false);
    showFailure(scope, result);
  });

  const form = document.querySelector<HTMLFormElement>('form[data-war-form]');
  const button = form?.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (!form || !button) return;

  const words = wordsOf(form);
  const limits = JSON.parse(form.dataset.limits ?? '{}') as Limits;
  const fields = {
    title: fieldOf(form, 'title'),
    strategy: fieldOf(form, 'strategy'),
    startsOn: fieldOf(form, 'startsOn'),
    tradingDays: fieldOf(form, 'tradingDays'),
    models: form.querySelector<HTMLElement>('fieldset#models'),
  };
  for (const field of Object.values(fields)) if (field) clearOnInput(field);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (button.disabled) return;
    clearMessage(form);

    const title = fieldValue(form, 'title').trim();
    const strategy = fieldValue(form, 'strategy').trim();
    const startsOn = fieldValue(form, 'startsOn');
    const tradingDays = Number(fieldValue(form, 'tradingDays'));
    const models = [...form.querySelectorAll<HTMLInputElement>('input[name="models"]:checked')].map(
      (input) => input.value,
    );

    const wrong = [
      report(
        fields.title,
        title.length < limits.titleMin
          ? (words.titleShort ?? '')
          : title.length > limits.titleMax
            ? (words.titleLong ?? '')
            : null,
      ),
      // Past the limit the field's running count already says so.
      report(
        fields.strategy,
        strategy.length < limits.strategyMin
          ? (words.strategyShort ?? '')
          : strategy.length > limits.strategyMax
            ? ''
            : null,
      ),
      report(
        fields.models,
        models.length < limits.modelsMin || models.length > limits.modelsMax ? (words.modelsCount ?? '') : null,
      ),
    ];
    if (wrong.includes(true)) {
      focusFirstInvalid(form);
      return;
    }

    setBusy(button, true);
    const result = await createWar({ title, strategy, startsOn, tradingDays, models });
    if (result.ok) {
      reloadWith('war-created');
      return;
    }
    setBusy(button, false);

    const sentences = errorSentences(form);
    // One war may be open at a time: the server names that rule with the field "wars".
    if (result.error.field === 'wars') sentences.invalid_input = words.warOpen ?? '';
    const lookup = (field: string): Element | null =>
      field in fields ? (fields[field as keyof typeof fields] ?? null) : null;
    const rejected = (_field: string, message: string): string => fill(words.fieldRejected ?? '', { message });
    showRefusal(form, result, lookup, rejected, {}, sentences);
  });
}
