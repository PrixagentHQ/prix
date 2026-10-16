import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { CHAIN_ID, SESSION_COOKIE, SIWE_STATEMENT } from '@prix/contracts';
import { e2eRun } from '../support/e2e-wallets.ts';
import { testWallet } from '../support/eth.ts';

/**
 * The path of the Phase 1 gate in a real browser, against the local stack (`pnpm stack`): a
 * stranger opens the site, signs in with a wallet, writes a prompt, gets an agent, finds it
 * on the account page, on the public league (unranked, with its reason) and on its own page,
 * and signs out.
 *
 * Runs only when PRIX_BASE_URL is set, and never against prixagent.com (tests/playwright.config.ts
 * refuses that address). The wallet is a stub injected into the page. It answers only
 * `eth_requestAccounts`, `eth_accounts` and `personal_sign`; any other request makes it record
 * the call and the test fail (docs/CONTRACTS.md section 15, "The wallet").
 */

const BASE_URL = process.env.PRIX_BASE_URL;
const RUN = e2eRun();
const DISCLAIMER =
  'The league is a paper trading simulation, where no real orders are placed. In Prix Live, an owner’s agent trades real money in the owner’s own Safe. Not investment advice.';
const PROMPT = 'Hold the five largest companies in equal parts and change the portfolio at most once a week.';
const ALLOWED_WALLET_REQUESTS = ['eth_requestAccounts', 'eth_accounts', 'personal_sign'];

test.skip(!BASE_URL, 'Set PRIX_BASE_URL to run the end-to-end test.');

/** Letters only, so the name passes the name rules whatever the run number is. */
function runLabel(n: number): string {
  let value = Math.abs(Math.floor(n));
  let label = '';
  do {
    label = 'abcdefghijklmnopqrstuvwxyz'[value % 26] + label;
    value = Math.floor(value / 26);
  } while (value > 0);
  return label.slice(-10);
}

interface WalletLog {
  requests: string[];
  signed: string[];
}

async function injectWallet(page: Page, walletNumber: number): Promise<WalletLog> {
  const wallet = testWallet(walletNumber);
  const log: WalletLog = { requests: [], signed: [] };
  await page.exposeFunction('__prixWalletRecord', (method: string) => {
    log.requests.push(method);
  });
  await page.exposeFunction('__prixWalletSign', async (message: string) => {
    log.signed.push(message);
    return wallet.signMessage(message);
  });
  await page.addInitScript((address: string) => {
    // The page's own global object, typed by hand: this package is not checked against the DOM library.
    const bridge = globalThis as unknown as {
      __prixWalletRecord(method: string): Promise<void>;
      __prixWalletSign(message: string): Promise<string>;
      ethereum?: unknown;
      dispatchEvent(event: unknown): boolean;
      addEventListener(type: string, listener: () => void): void;
      CustomEvent: new (type: string, init: { detail: unknown }) => unknown;
    };
    const decode = (hex: string): string => {
      const bytes = new Uint8Array((hex.length - 2) / 2);
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = Number.parseInt(hex.slice(2 + i * 2, 4 + i * 2), 16);
      return new TextDecoder().decode(bytes);
    };
    const provider = {
      isMetaMask: true,
      async request(call: { method: string; params?: unknown[] }): Promise<unknown> {
        await bridge.__prixWalletRecord(call.method);
        if (call.method === 'eth_requestAccounts' || call.method === 'eth_accounts') return [address];
        if (call.method === 'personal_sign') {
          const params = (call.params ?? []).map(String);
          const data = params.find((param) => param.toLowerCase() !== address.toLowerCase()) ?? '';
          return bridge.__prixWalletSign(/^0x([0-9a-fA-F]{2})+$/.test(data) ? decode(data) : data);
        }
        // Everything else is refused, the way a wallet refuses a method it does not support.
        throw Object.assign(new Error(`The test wallet does not support ${call.method}.`), { code: 4200 });
      },
      on(): void {},
      removeListener(): void {},
    };
    bridge.ethereum = provider;
    const announce = (): void => {
      bridge.dispatchEvent(
        new bridge.CustomEvent('eip6963:announceProvider', {
          detail: Object.freeze({
            info: {
              uuid: '6f1d3d0e-6a0b-4d0a-9f6e-0c1b7e2a9d41',
              name: 'Prix Test Wallet',
              icon: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E',
              rdns: 'test.prix.wallet',
            },
            provider,
          }),
        }),
      );
    };
    bridge.addEventListener('eip6963:requestProvider', announce);
    announce();
  }, wallet.checksumAddress);
  return log;
}

/**
 * The two-row header, read by role and name: the search field, the sign-in actions, and the
 * sections of the site as tabs. The wallet is untouched by any of it.
 */
async function expectHeader(page: Page): Promise<void> {
  const header = page.getByRole('banner');
  await expect(header.getByRole('link', { name: 'Prix, home' })).toBeVisible();
  await expect(header.getByRole('searchbox', { name: 'Search agents' })).toBeVisible();
  const tabs = header.getByRole('navigation', { name: 'Main' });
  for (const name of ['League', 'Listed', 'Token', 'Methodology']) {
    await expect(tabs.getByRole('link', { name, exact: true }), `tab ${name}`).toBeVisible();
  }
}

test('a stranger signs in, builds an agent, finds it on the league and signs out', async ({ page }, testInfo) => {
  const walletNumber = RUN * 10 + (testInfo.project.name === 'phone' ? 2 : 1);
  const wallet = testWallet(walletNumber);
  const agentName = `Trial ${runLabel(walletNumber)}`;
  const log = await injectWallet(page, walletNumber);
  const shot = (step: string) =>
    page.screenshot({ path: `../.artifacts/e2e/${testInfo.project.name}-${step}.png`, fullPage: true });

  const serverErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('response', (response) => {
    if (response.status() >= 500) serverErrors.push(`${response.status()} ${response.url()}`);
  });
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));

  // 1. The home page is the board. The header has two rows: the search and the actions, then the tabs.
  await page.goto('/');
  await expect(page.getByText(DISCLAIMER).first()).toBeVisible();
  await expectHeader(page);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await shot('1-landing');
  expect(log.requests, 'the site must not touch the wallet before the visitor asks to sign in').toEqual([]);

  // 2. Sign in. The masthead has a link of the same name, so the role is button.
  await page.goto('/sign-in');
  await expect(page.getByText(DISCLAIMER).first()).toBeVisible();
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect
    .poll(async () => (await page.request.get('/api/me')).status(), {
      message: 'the session cookie was not set after signing in',
      timeout: 60_000,
    })
    .toBe(200);
  await shot('2-signed-in');
  const me = await (await page.request.get('/api/me')).json();
  expect(me.address).toBe(wallet.address);
  expect(log.signed).toHaveLength(1);
  expect(log.signed[0]).toContain(SIWE_STATEMENT);
  expect(log.signed[0]).toContain(`Chain ID: ${CHAIN_ID}`);

  // The session lives in an HttpOnly cookie that no script can read.
  const session = (await page.context().cookies()).find((cookie) => cookie.name === SESSION_COOKIE);
  expect(session, `no ${SESSION_COOKIE} cookie`).toBeDefined();
  expect(session?.path).toBe('/');
  expect(session?.httpOnly).toBe(true);
  expect(session?.secure).toBe(true);
  expect(session?.sameSite).toBe('Lax');
  const readable = await page.evaluate(
    () => (globalThis as unknown as { document: { cookie: string } }).document.cookie,
  );
  expect(readable).not.toContain('prix_session');

  // 3. Build an Open agent from a plain-language prompt.
  await page.goto('/build');
  await page.getByLabel('Agent name').fill(agentName);
  await page.getByLabel('Strategy prompt').fill(PROMPT);
  await shot('3-build-form');
  await page.getByRole('button', { name: 'Build an agent' }).click();
  await expect
    .poll(async () => (await (await page.request.get('/api/me')).json()).agent?.name ?? null, {
      message: 'the agent was not created',
      timeout: 30_000,
    })
    .toBe(agentName);
  const agent = (await (await page.request.get('/api/me')).json()).agent as { id: string; division: string };
  expect(agent.division).toBe('open');

  // 4. The account page shows it.
  await page.goto('/account');
  await expect(page.getByText(agentName).first()).toBeVisible();
  await shot('4-account');

  // 5. The league lists it as a card, unranked, with the reason; the table form shows the same agent.
  await page.goto('/league');
  await expectHeader(page);
  const board = page.getByRole('region', { name: /Open division/i });
  const card = board.getByRole('article').filter({ has: page.getByRole('heading', { name: agentName }) });
  await expect(card).toBeVisible();
  await shot('5-league');
  const cardText = (await card.innerText()).replace(/\s+/g, ' ');
  expect(cardText.toLowerCase(), `card text was: ${cardText}`).toMatch(/not ranked/);
  expect(cardText.length).toBeGreaterThan(agentName.length + 'not ranked'.length);

  const showAs = page.getByRole('group', { name: 'Show as' });
  await showAs.getByRole('button', { name: 'Table' }).click();
  await expect(showAs.getByRole('button', { name: 'Table' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page).toHaveURL(/view=list/);
  await expect(card).toBeVisible();
  await shot('5-league-table');
  await showAs.getByRole('button', { name: 'Cards' }).click();
  await expect(showAs.getByRole('button', { name: 'Cards' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page).not.toHaveURL(/view=list/);

  // The search field in the header narrows the board by name and renumbers nothing.
  const search = page.getByRole('searchbox', { name: 'Search agents' });
  await search.fill(agentName.toLowerCase());
  await expect(board.getByRole('article').filter({ visible: true })).toHaveCount(1);
  await expect(card).toBeVisible();
  await search.fill('zzzz-no-such-agent');
  await expect(page.getByText('No agent on this board has', { exact: false })).toBeVisible();
  await search.fill('');
  await expect(card).toBeVisible();

  // 6. Its page opens from the card and keeps the prompt private.
  await card.getByRole('link', { name: agentName }).click();
  await expect(page).toHaveURL(new RegExp(`/agents/${agent.id}$`));
  await expect(page.getByRole('heading', { name: agentName })).toBeVisible();
  await expect(page.getByText(DISCLAIMER).first()).toBeVisible();
  await expect(page.getByText(PROMPT)).toHaveCount(0);
  await shot('6-agent-page');

  // 7. Sign out: the session ends and the page goes back to the home page.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(new RegExp(`${BASE_URL}/?$`.replace(/[.]/g, '\\.')), { timeout: 30_000 });
  await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
  // One check of the server side, after the read rate limit (300 a minute per address) has room again.
  await expect
    .poll(async () => (await page.request.get('/api/me')).status(), { intervals: [15_000], timeout: 90_000 })
    .toBe(401);
  await shot('7-signed-out');

  // 8. Nothing but the address and the sign-in signature was ever asked of the wallet.
  const others = log.requests.filter((method) => !ALLOWED_WALLET_REQUESTS.includes(method));
  expect(others, `the site asked the wallet for: ${others.join(', ')}`).toEqual([]);
  expect(log.requests.filter((method) => method === 'personal_sign')).toHaveLength(1);
  expect(serverErrors).toEqual([]);
  expect(consoleErrors, 'console errors on the path').toEqual([]);
});

test('a visitor who is not signed in is offered sign-in on the build page', async ({ page }) => {
  const log = await injectWallet(page, RUN * 10 + 9);
  await page.goto('/build');
  await expect(
    page
      .getByRole('button', { name: 'Sign in', exact: true })
      .or(page.getByRole('link', { name: /sign in/i }))
      .first(),
  ).toBeVisible();
  expect((await page.request.get('/api/me')).status()).toBe(401);
  expect(log.requests).toEqual([]);
});

test('every public page says that this is a simulation', async ({ page }) => {
  for (const path of ['/', '/league', '/methodology', '/terms', '/privacy', '/sign-in']) {
    const response = await page.goto(path);
    expect(response?.status(), path).toBe(200);
    await expect(page.getByText(DISCLAIMER).first(), path).toBeVisible();
  }
});
