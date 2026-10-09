import { formatCount, formatDay, formatTimeUtc } from '../../content/format.ts';
import { clearOnInput, fieldOf, fieldValue, fill, setBusy, setFieldError } from '../dom.ts';
import type { DataClient, FailureCode, Result } from './data-client.ts';
import { createDataClient } from './data-client.ts';
import type { DataWords } from './words.ts';

/**
 * The script of /account/api. Every sentence comes from `data-words`, rendered by the server.
 * The page asks the wallet for nothing. The secret of a new key lives in one variable and one
 * text node until the person dismisses it: it is never written to storage, a cookie, a URL or
 * the console.
 */

const LABEL_PATTERN = /^[A-Za-z0-9 ._-]{1,40}$/;
const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const LABEL_MAX = 40;

function q<T extends HTMLElement>(scope: ParentNode, selector: string): T {
  const found = scope.querySelector<T>(selector);
  if (!found) throw new Error(`missing ${selector}`);
  return found;
}

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

/** USDG has six decimals: 5000000 is "5.00", 1000 is "0.001". Integer arithmetic only. */
function usdg(micro: number): string {
  const whole = Math.floor(micro / 1_000_000);
  const fraction = String(micro % 1_000_000)
    .padStart(6, '0')
    .replace(/0+$/, '')
    .padEnd(2, '0');
  return `${formatCount(whole)}.${fraction}`;
}

function mount(): void {
  const root = document.querySelector<HTMLElement>('[data-api-page]');
  if (!root) return;
  const words = JSON.parse(root.dataset.words ?? '{}') as DataWords;
  const client: DataClient = createDataClient();

  const sentence = (code: FailureCode): string => words.errors[code] ?? words.errors.internal;

  function notice(tone: 'status' | 'error' | 'empty', title: string, body: string): HTMLElement {
    const box = el('div', `notice notice--${tone}`);
    if (tone === 'error') box.setAttribute('role', 'alert');
    box.append(el('p', 'notice-title', title), el('p', 'notice-body', body));
    return box;
  }

  function show(panel: HTMLElement, view: 'loading' | 'error' | 'ready', message = ''): void {
    for (const node of panel.querySelectorAll<HTMLElement>(':scope > [data-view]')) {
      node.hidden = node.dataset.view !== view;
    }
    if (view === 'error') q(panel, '[data-view="error"] .notice-body').textContent = message;
  }

  function wireRetry(panel: HTMLElement, load: () => Promise<void>): void {
    q(panel, '[data-retry]').addEventListener('click', () => {
      show(panel, 'loading');
      void load();
    });
  }

  function facts(items: [string, string | Node][]): HTMLElement {
    const list = el('dl', 'facts facts--label-10');
    for (const [term, value] of items) {
      const dd = el('dd');
      dd.append(value);
      list.append(el('dt', undefined, term), dd);
    }
    return list;
  }

  /** An address in two fixed halves, so it never breaks mid-run, with a button that copies it whole. */
  function addressFact(address: string): HTMLElement {
    const box = el('div', 'addr-box');
    const shown = el('span', 'addr');
    const half = Math.ceil(address.length / 2);
    shown.append(el('span', 'addr-half', address.slice(0, half)), el('span', 'addr-half', address.slice(half)));
    const copy = el('button', 'button button--secondary', words.copyAddress);
    copy.type = 'button';
    const status = el('span', 'small addr-status');
    status.setAttribute('role', 'status');
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(address);
        status.textContent = words.copied;
      } catch {
        status.textContent = words.copyFailed;
      }
    });
    const actions = el('span', 'addr-actions');
    actions.append(copy, status);
    box.append(shown, actions);
    return box;
  }

  // --- usage ------------------------------------------------------------------------------------

  const usagePanel = q(root, '[data-panel="usage"]');
  async function loadUsage(): Promise<void> {
    const res = await client.usage();
    if (!res.ok) return show(usagePanel, 'error', sentence(res.code));
    const usage = res.data;
    const summary = q(usagePanel, '[data-usage-summary]');
    summary.replaceChildren(
      facts([
        [words.quotaLabel, formatCount(usage.quotaPerDay)],
        [
          words.usedLabel,
          fill(words.usedValue, { free: formatCount(usage.usedFree), paid: formatCount(usage.usedPaid) }),
        ],
        [words.remainingLabel, formatCount(usage.remainingFree)],
        [words.creditsLabel, `${usdg(usage.creditsMicro)} USDG`],
        [words.resetLabel, `${formatDay(usage.resetsAt)}, ${formatTimeUtc(usage.resetsAt)}`],
      ]),
    );
    q(usagePanel, '[data-usage-note]').textContent = usage.gatingOn
      ? fill(words.usageTier, { tier: String(usage.tier) })
      : words.usagePreview;
    const rows = q(usagePanel, '[data-history-rows]');
    rows.replaceChildren(
      ...usage.history.map((row) => {
        const tr = el('tr');
        tr.append(
          el('td', 'c-day', formatDay(row.day)),
          el('td', 'c-free num', formatCount(row.free)),
          el('td', 'c-paid num', formatCount(row.paid)),
        );
        return tr;
      }),
    );
    q(usagePanel, '[data-history-table]').hidden = usage.history.length === 0;
    q(usagePanel, '[data-history-empty]').hidden = usage.history.length !== 0;
    show(usagePanel, 'ready');
  }
  wireRetry(usagePanel, loadUsage);

  // --- keys -------------------------------------------------------------------------------------

  const keysPanel = q(root, '[data-panel="keys"]');
  const keysOutlet = q(keysPanel, '[data-keys-outlet]');
  const secretBox = q(keysPanel, '[data-secret]');
  const secretText = q(keysPanel, '[data-secret-text]');
  const copyStatus = q(keysPanel, '[data-copy-status]');
  const createForm = q<HTMLFormElement>(keysPanel, '[data-create-form]');

  function setOutlet(node: HTMLElement | null): void {
    keysOutlet.replaceChildren(...(node ? [node] : []));
  }

  /** On a phone the header row is hidden, so a cell carries its own label (see the page style). */
  function labelled(cell: HTMLElement, label: string): HTMLElement {
    cell.dataset.label = label;
    return cell;
  }

  function revokeCell(key: { id: string; prefix: string }): HTMLElement {
    const cell = el('td', 'c-action');
    const ask = el('button', 'button button--secondary', words.revoke);
    ask.type = 'button';
    cell.append(ask);
    ask.addEventListener('click', () => {
      const panel = el('div', 'stack-16 revoke-confirm');
      panel.setAttribute('role', 'group');
      panel.tabIndex = -1;
      const lead = el('p', 'body');
      lead.append(el('strong', undefined, fill(words.revokeQuestion, { prefix: key.prefix })));
      const go = el('button', 'button button--secondary', words.revoke);
      go.type = 'button';
      go.dataset.label = words.revoke;
      go.dataset.busyLabel = words.revoking;
      const cancel = el('button', 'button button--quiet', words.cancel);
      cancel.type = 'button';
      panel.append(lead, el('p', 'body', words.revokeConsequence), go, cancel);
      setOutlet(panel);
      panel.focus();
      cancel.addEventListener('click', () => {
        setOutlet(null);
        ask.focus();
      });
      go.addEventListener('click', async () => {
        setBusy(go, true);
        const res = await client.revokeKey(key.id);
        setBusy(go, false);
        if (!res.ok) {
          setOutlet(notice('error', words.revokeFailedTitle, sentence(res.code)));
          return;
        }
        setOutlet(notice('status', words.revokedTitle, ''));
        await loadKeys();
      });
    });
    return cell;
  }

  async function loadKeys(): Promise<void> {
    const res = await client.keys();
    if (!res.ok) return show(keysPanel, 'error', sentence(res.code));
    const { keys, maxActive } = res.data;
    const rows = q(keysPanel, '[data-keys-rows]');
    rows.replaceChildren(
      ...keys.map((key) => {
        const tr = el('tr');
        tr.append(
          el('td', 'c-prefix', `${key.prefix}…`),
          el('td', 'c-label', key.label),
          labelled(el('td', 'c-created', formatDay(key.createdAt)), words.keyColCreated),
          labelled(
            el('td', 'c-used', key.lastUsedDay ? formatDay(key.lastUsedDay) : words.keyNeverUsed),
            words.keyColLastUsed,
          ),
          el('td', 'c-status', key.revoked ? words.keyRevoked : words.keyActive),
          key.revoked ? el('td', 'c-action') : revokeCell(key),
        );
        return tr;
      }),
    );
    q(keysPanel, '[data-keys-table]').hidden = keys.length === 0;
    q(keysPanel, '[data-keys-empty]').hidden = keys.length !== 0;
    const full = keys.filter((key) => !key.revoked).length >= maxActive;
    q(keysPanel, '[data-keys-full]').hidden = !full;
    createForm.hidden = full;
    q(keysPanel, '[data-keys-full] .notice-body').textContent = fill(words.keysFullBody, { max: String(maxActive) });
    q(keysPanel, '[data-keys-max]').textContent = fill(words.keysMax, { max: String(maxActive) });
    show(keysPanel, 'ready');
  }
  wireRetry(keysPanel, loadKeys);

  const labelField = fieldOf(createForm, 'label');
  if (labelField) clearOnInput(labelField);
  createForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = q<HTMLButtonElement>(createForm, '[type="submit"]');
    const label = fieldValue(createForm, 'label').trim();
    if (labelField) setFieldError(labelField, null);
    setOutlet(null);
    if (!LABEL_PATTERN.test(label)) {
      if (labelField) setFieldError(labelField, fill(words.labelInvalid, { max: String(LABEL_MAX) }));
      labelField?.querySelector('input')?.focus();
      return;
    }
    setBusy(submit, true);
    const res = await client.createKey(label);
    setBusy(submit, false);
    if (!res.ok) {
      if (res.code === 'invalid_input' && labelField) {
        setFieldError(labelField, fill(words.labelInvalid, { max: String(LABEL_MAX) }));
        return;
      }
      setOutlet(notice('error', words.createFailedTitle, sentence(res.code)));
      return;
    }
    // The secret goes into one text node. It is not copied anywhere else by this page.
    secretText.textContent = res.data.secret;
    copyStatus.textContent = '';
    secretBox.hidden = false;
    const input = labelField?.querySelector('input');
    if (input) input.value = '';
    secretBox.focus();
    await loadKeys();
  });

  q(keysPanel, '[data-copy]').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(secretText.textContent ?? '');
      copyStatus.textContent = words.copied;
    } catch {
      copyStatus.textContent = words.copyFailed;
    }
  });
  q(keysPanel, '[data-secret-done]').addEventListener('click', () => {
    secretText.textContent = '';
    copyStatus.textContent = '';
    secretBox.hidden = true;
    createForm.querySelector('input')?.focus();
  });

  // --- credits ----------------------------------------------------------------------------------

  const creditsPanel = q(root, '[data-panel="credits"]');
  const payOutlet = q(creditsPanel, '[data-pay-outlet]');
  const payForm = q<HTMLFormElement>(creditsPanel, '[data-pay-form]');

  async function loadCredits(): Promise<void> {
    const [pricing, payments] = await Promise.all([client.pricing(), client.payments()]);
    if (!pricing.ok) return show(creditsPanel, 'error', sentence(pricing.code));
    const price = pricing.data;
    const on = price.paymentsEnabled && price.paymentAddress !== null;
    q(creditsPanel, '[data-credits-off]').hidden = on;
    q(creditsPanel, '[data-credits-on]').hidden = !on;
    if (!on || price.paymentAddress === null) return show(creditsPanel, 'ready');
    if (!payments.ok) return show(creditsPanel, 'error', sentence(payments.code));
    q(creditsPanel, '[data-pay-facts]').replaceChildren(
      facts([
        [words.payAddressLabel, addressFact(price.paymentAddress)],
        [words.payTokenLabel, fill(words.payTokenValue, { chain: String(price.token.chainId) })],
        [words.payContractLabel, addressFact(price.token.address)],
        [words.payPriceLabel, fill(words.payPriceValue, { price: usdg(price.callPriceMicro) })],
        [words.payMinLabel, fill(words.payMinValue, { min: usdg(price.minPaymentMicro) })],
        [words.payConfirmLabel, formatCount(price.confirmations)],
        [words.creditsBalance, `${usdg(payments.data.balanceMicro)} USDG`],
      ]),
    );
    const rows = q(creditsPanel, '[data-payment-rows]');
    rows.replaceChildren(
      ...payments.data.payments.map((payment) => {
        const tr = el('tr');
        tr.append(
          el('td', 'c-time', `${formatDay(payment.creditedAt)}, ${formatTimeUtc(payment.creditedAt)}`),
          el('td', 'c-amount num', usdg(payment.amountMicro)),
          el('td', 'c-hash', `${payment.txHash.slice(0, 10)}…${payment.txHash.slice(-6)}`),
        );
        return tr;
      }),
    );
    q(creditsPanel, '[data-payments-table]').hidden = payments.data.payments.length === 0;
    q(creditsPanel, '[data-payments-empty]').hidden = payments.data.payments.length !== 0;
    show(creditsPanel, 'ready');
  }
  wireRetry(creditsPanel, loadCredits);

  const hashField = fieldOf(payForm, 'txHash');
  if (hashField) clearOnInput(hashField);
  payForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = q<HTMLButtonElement>(payForm, '[type="submit"]');
    const hash = fieldValue(payForm, 'txHash').trim();
    if (hashField) setFieldError(hashField, null);
    payOutlet.replaceChildren();
    if (!HASH_PATTERN.test(hash)) {
      if (hashField) setFieldError(hashField, words.hashInvalid);
      hashField?.querySelector('input')?.focus();
      return;
    }
    setBusy(submit, true);
    const res = await client.submitPayment(hash);
    setBusy(submit, false);
    payOutlet.replaceChildren(paymentNotice(res));
    if (res.ok) {
      const input = hashField?.querySelector('input');
      if (input) input.value = '';
      await Promise.all([loadCredits(), loadUsage()]);
    }
  });

  function paymentNotice(
    res: Result<{ payment: { amountMicro: number }; balanceMicro: number; alreadyCredited: boolean }>,
  ) {
    if (res.ok) {
      return res.data.alreadyCredited
        ? notice('status', words.payAlreadyTitle, words.payAlreadyBody)
        : notice(
            'status',
            words.payCreditedTitle,
            fill(words.payCreditedBody, {
              amount: usdg(res.data.payment.amountMicro),
              balance: usdg(res.data.balanceMicro),
            }),
          );
    }
    if (res.code === 'payment_pending') return notice('status', words.payPendingTitle, words.payPendingBody);
    if (res.code === 'payment_invalid') return notice('error', words.payInvalidTitle, words.payInvalidBody);
    if (res.code === 'payment_already_credited') {
      return notice('error', words.payAlreadyTitle, words.payOtherWalletBody);
    }
    return notice('error', words.payFailedTitle, sentence(res.code));
  }

  void loadKeys();
  void loadUsage();
  void loadCredits();
}

mount();
