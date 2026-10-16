import type {
  ApiError,
  ApiErrorCode,
  OwnerHoldsSetting,
  TokenConfigInput,
  TokenConfigResponse,
  TokenMeResponse,
  TokenProbeResponse,
} from '@prix/contracts';
import type { ApiContext, ApiFailure, ApiResult } from '../../lib/api.ts';
import {
  clearMessage,
  clearOnInput,
  fieldOf,
  fieldValue,
  focusFirstInvalid,
  reloadWith,
  report,
  setBusy,
  showConfirmation,
  showFailure,
  showMessage,
  wordsOf,
} from '../dom.ts';
import type { TokenCall, TokenTransport } from './fixtures.ts';
import { formatHolding, formatUnits } from './format.ts';

/**
 * The client of the tier page. It calls /api/token/me, /api/token/refresh and /api/admin/token/*
 * and nothing else, and asks the wallet for nothing. The server entry checks every answer against
 * the contract schemas; a browser script does not import zod (docs/CONTRACTS.md section 15), so
 * the schemas are loaded behind `import.meta.env.SSR`, which the build drops from browser scripts.
 * Under `__PRIX_FIXTURES__` it answers from fixtures.ts and `?tokenfixture=` selects the state.
 *
 * What this page shows is what the server read. Nothing here decides a tier.
 */

type SchemaName = 'me' | 'config' | 'probe' | 'ownerHolds' | 'apiError';

async function check<T>(name: SchemaName, body: unknown): Promise<T | undefined> {
  if (!import.meta.env.SSR) return looksRight(name, body) ? (body as T) : undefined;
  const contracts = await import('@prix/contracts');
  const schemas = {
    me: contracts.tokenMeResponseSchema,
    config: contracts.tokenConfigResponseSchema,
    probe: contracts.tokenProbeResponseSchema,
    ownerHolds: contracts.ownerHoldsSettingSchema,
    apiError: contracts.apiErrorSchema,
  };
  const parsed = schemas[name].safeParse(body);
  return parsed.success ? (parsed.data as T) : undefined;
}

/** The browser's guard: enough to know the answer has the shape the page reads. */
function looksRight(name: SchemaName, body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const record = body as Record<string, unknown>;
  if (name === 'me')
    return typeof record.tier === 'number' && typeof record.slots === 'object' && record.slots !== null;
  if (name === 'config') return typeof record.config === 'object' && record.config !== null;
  if (name === 'probe') return typeof record.tier === 'number' && typeof record.balance === 'string';
  if (name === 'ownerHolds') return typeof record.show === 'boolean' && Object.keys(record).length === 1;
  return typeof record.error === 'object' && record.error !== null;
}

const UNUSABLE = 'The API did not give a usable answer. Try again in a minute.';

function codeForStatus(status: number): ApiErrorCode {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  return 'internal';
}

function unusable(status: number): ApiFailure {
  const failed = status >= 400 ? status : 502;
  return { ok: false, status: failed, error: { code: codeForStatus(failed), message: UNUSABLE, field: null } };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

const browserTransport: TokenTransport = (call) => {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (call.method !== 'GET') headers['content-type'] = 'application/json';
  return fetch(call.path, {
    method: call.method,
    credentials: 'same-origin',
    headers,
    body: call.body === undefined ? undefined : JSON.stringify(call.body),
  });
};

async function transportFor(context: ApiContext | undefined): Promise<TokenTransport> {
  if (import.meta.env.SSR && !context) throw new Error('The token client needs the Astro global on the server.');
  if (typeof __PRIX_FIXTURES__ !== 'undefined' && __PRIX_FIXTURES__) {
    const { createTokenFixtureTransport } = await import('./fixtures.ts');
    return createTokenFixtureTransport(context ? context.url : new URL(window.location.href));
  }
  if (import.meta.env.SSR && context) {
    const { createServerTransport } = await import('../../lib/api-server.ts');
    // The server transport passes the method through as it is, so it carries PUT too.
    return createServerTransport(context) as TokenTransport;
  }
  return browserTransport;
}

async function send<T>(context: ApiContext | undefined, call: TokenCall, schema: SchemaName): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await (await transportFor(context))(call);
  } catch (cause) {
    // Logged by name only: never a body, a header or a query.
    console.error('token_call_failed', call.method, call.path.split('?')[0], cause instanceof Error ? cause.name : '');
    return unusable(502);
  }
  const body = await readJson(response);
  if (!response.ok) {
    const error = await check<ApiError>('apiError', body);
    return error ? { ok: false, status: response.status, error: error.error } : unusable(response.status);
  }
  const data = await check<T>(schema, body);
  return data !== undefined ? { ok: true, status: response.status, data } : unusable(502);
}

/** GET /api/token/me: the signed-in wallet's tier, as the server read it. */
export function fetchTokenMe(context?: ApiContext): Promise<ApiResult<TokenMeResponse>> {
  return send<TokenMeResponse>(context, { method: 'GET', path: '/api/token/me' }, 'me');
}

/** POST /api/token/refresh: asks the server to read the chain again. The server throttles it. */
export function refreshTokenMe(context?: ApiContext): Promise<ApiResult<TokenMeResponse>> {
  return send<TokenMeResponse>(context, { method: 'POST', path: '/api/token/refresh' }, 'me');
}

/**
 * GET /api/token/me/owner-holds (docs/contracts/phase-6-holders.md section 3): the wallet's choice to show
 * "Owner holds $PRIX" on its agents' pages. Its status also says whether the route is there at all
 * (`ownerHoldsRouteOn`): 404 while the API does not have B's half yet.
 */
export function fetchOwnerHolds(context?: ApiContext): Promise<ApiResult<OwnerHoldsSetting>> {
  return send<OwnerHoldsSetting>(context, { method: 'GET', path: '/api/token/me/owner-holds' }, 'ownerHolds');
}

/** PUT /api/token/me/owner-holds with `{ show }`. The server books the write and answers the stored choice. */
export function saveOwnerHolds(show: boolean, context?: ApiContext): Promise<ApiResult<OwnerHoldsSetting>> {
  return send<OwnerHoldsSetting>(
    context,
    { method: 'PUT', path: '/api/token/me/owner-holds', body: { show } },
    'ownerHolds',
  );
}

/** GET /api/admin/token/config. */
export function fetchTokenConfig(context?: ApiContext): Promise<ApiResult<TokenConfigResponse>> {
  return send<TokenConfigResponse>(context, { method: 'GET', path: '/api/admin/token/config' }, 'config');
}

/** PUT /api/admin/token/config. The server verifies the token against the chain and decides. */
export function saveTokenConfig(
  input: TokenConfigInput,
  context?: ApiContext,
): Promise<ApiResult<TokenConfigResponse>> {
  return send<TokenConfigResponse>(context, { method: 'PUT', path: '/api/admin/token/config', body: input }, 'config');
}

/** GET /api/admin/token/probe: the tier a wallet would have now. Reads the chain, writes nothing. */
export function probeWallet(wallet: string, context?: ApiContext): Promise<ApiResult<TokenProbeResponse>> {
  const path = `/api/admin/token/probe?wallet=${encodeURIComponent(wallet)}`;
  return send<TokenProbeResponse>(context, { method: 'GET', path }, 'probe');
}

// --- the browser side ---------------------------------------------------------------------------

/**
 * Asks the server once per page load to read the wallet's balance, after sign-in has been
 * confirmed: the page that follows a sign-in carries `[data-token-refresh]` only for a signed-in
 * wallet. A failure is ignored: the tier is then read when it is next asked for.
 */
export function refreshAfterSignIn(): void {
  const marker = document.querySelector<HTMLElement>('[data-token-refresh]');
  if (!marker) return;
  // No storage: the call is made once per page load, and the server throttles it.
  void refreshTokenMe();
}

/**
 * The mark's switch (docs/contracts/phase-6-holders.md section 3): a checkbox that saves on change. While the
 * PUT runs the box is held; on success it shows what the server stored, on a failure it goes back to what it
 * was and the form's outlet says why. The server decides; the box only asks.
 */
export function mountOwnerHolds(
  form: HTMLElement,
  save: (show: boolean) => Promise<ApiResult<OwnerHoldsSetting>> = (show) => saveOwnerHolds(show),
): void {
  const box = form.querySelector<HTMLInputElement>('input[name="ownerHolds"]');
  if (!box) return;
  form.addEventListener('submit', (event) => event.preventDefault());
  box.addEventListener('change', async () => {
    const wanted = box.checked;
    clearMessage(form);
    box.disabled = true;
    form.setAttribute('aria-busy', 'true');
    const result = await save(wanted);
    box.disabled = false;
    form.removeAttribute('aria-busy');
    box.checked = result.ok ? result.data.show : !wanted;
    if (!result.ok) showFailure(form, result);
    box.focus({ preventScroll: true });
  });
}

/** The tier page: "Check again" asks the server to read the balance again, then shows what it read. */
export function mountToken(): void {
  showConfirmation();
  const ownerHolds = document.querySelector<HTMLElement>('[data-owner-holds-form]');
  if (ownerHolds) mountOwnerHolds(ownerHolds);
  const button = document.querySelector<HTMLButtonElement>('button[data-token-check]');
  const scope = button?.closest<HTMLElement>('[data-scope]');
  if (!button || !scope) return;
  button.addEventListener('click', async () => {
    if (button.disabled) return;
    clearMessage(scope);
    setBusy(button, true);
    const result = await refreshTokenMe();
    if (result.ok) {
      reloadWith('token-checked');
      return;
    }
    setBusy(button, false);
    showFailure(scope, result);
  });
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const WHOLE = /^\d{1,7}$/;

/** The admin panel: save the configuration and probe a wallet. The API checks the administrator again on each call. */
export function mountTokenAdmin(): void {
  const form = document.querySelector<HTMLFormElement>('form[data-token-config]');
  if (form) mountConfigForm(form);
  const probe = document.querySelector<HTMLFormElement>('form[data-token-probe]');
  if (probe) mountProbeForm(probe);
}

function mountConfigForm(form: HTMLFormElement): void {
  const words = wordsOf(form);
  const fields = {
    tokenAddress: fieldOf(form, 'tokenAddress'),
    thresholds: fieldOf(form, 'threshold3'),
    buyUrl: fieldOf(form, 'buyUrl'),
  };
  for (const field of ['tokenAddress', 'threshold1', 'threshold2', 'threshold3', 'buyUrl']) {
    const element = fieldOf(form, field);
    if (element) clearOnInput(element);
  }
  const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (!button) return;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (button.disabled) return;
    clearMessage(form);

    const address = fieldValue(form, 'tokenAddress').trim();
    const raw = ['threshold1', 'threshold2', 'threshold3'].map((name) => fieldValue(form, name).trim());
    const thresholds = raw.map(Number);
    const buyUrl = fieldValue(form, 'buyUrl').trim();
    const enabled = form.querySelector<HTMLInputElement>('input[name="enabled"]')?.checked === true;

    const thresholdsOk =
      raw.every((value) => WHOLE.test(value)) &&
      thresholds.every((value) => value >= 1 && value <= 1_000_000) &&
      (thresholds[0] ?? 0) < (thresholds[1] ?? 0) &&
      (thresholds[1] ?? 0) < (thresholds[2] ?? 0);
    const wrong = [
      report(fields.tokenAddress, address !== '' && !ADDRESS.test(address) ? (words.addressRejected ?? '') : null),
      report(fields.tokenAddress, enabled && address === '' ? (words.addressNeeded ?? '') : null),
      report(fields.thresholds, thresholdsOk ? null : (words.thresholdsRejected ?? '')),
      report(fields.buyUrl, buyUrl !== '' && !buyUrl.startsWith('https://') ? (words.buyUrlRejected ?? '') : null),
    ];
    if (wrong.includes(true)) {
      focusFirstInvalid(form);
      return;
    }

    setBusy(button, true);
    const result = await saveTokenConfig({
      enabled,
      tokenAddress: address === '' ? null : (address.toLowerCase() as `0x${string}`),
      thresholdsPpm: [thresholds[0] ?? 0, thresholds[1] ?? 0, thresholds[2] ?? 0],
      buyUrl: buyUrl === '' ? null : buyUrl,
    });
    if (result.ok) {
      reloadWith('token-config-saved');
      return;
    }
    setBusy(button, false);
    showFailure(form, result);
  });
}

function mountProbeForm(form: HTMLFormElement): void {
  const words = wordsOf(form);
  const field = fieldOf(form, 'wallet');
  const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (!field || !button) return;
  clearOnInput(field);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (button.disabled) return;
    clearMessage(form);
    const wallet = fieldValue(form, 'wallet').trim();
    if (report(field, ADDRESS.test(wallet) ? null : (words.walletRejected ?? ''))) {
      focusFirstInvalid(form);
      return;
    }
    setBusy(button, true);
    const result = await probeWallet(wallet.toLowerCase());
    setBusy(button, false);
    if (!result.ok) {
      showFailure(form, result);
      return;
    }
    showMessage(form, 'probed', {
      tier: String(result.data.tier),
      share: formatHolding(result.data.holdingPpm),
      balance: formatUnits(result.data.balance, result.data.decimals),
      block: String(result.data.blockNumber),
    });
  });
}
