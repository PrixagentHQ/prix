import { expect, test } from '@playwright/test';

/**
 * The board in a real browser, against the local stack with the house agents created
 * (`pnpm stack --house <addresses>`, then `node infra/seed/house-agents.mjs --origin <url>`).
 * It reads roles and labels, never the classes of the look. Nobody is ranked on a stack that was
 * just made (ranks start after five trading days and three decisions), so every agent is "Not
 * ranked" and the board must say so. A closed market is expected here and is not a failure.
 *
 * Runs only with PRIX_BASE_URL, and never against prixagent.com (tests/playwright.config.ts).
 */

const BASE_URL = process.env.PRIX_BASE_URL;
const DISCLAIMER =
  'The league is a paper trading simulation, where no real orders are placed. In Prix Live, an owner’s agent trades real money in the owner’s own Safe. Not investment advice.';
const HOUSE_NAMES = [
  'Semis Rotation',
  'Treasury First',
  'Dip Buyer',
  'Momentum Five',
  'Oil And Idle',
  'Big Tech Equal',
  'Crypto Proxies',
  'Crowd Favourites',
];

test.skip(!BASE_URL, 'Set PRIX_BASE_URL to run the end-to-end test.');

test('the home page is the board: house agents as cards, then as a table, with search and order', async ({ page }) => {
  const failures: string[] = [];
  page.on('response', (response) => {
    if (response.status() >= 500) failures.push(`${response.status()} ${response.url()}`);
  });
  page.on('pageerror', (error) => failures.push(`pageerror: ${error.message}`));

  await page.goto('/');
  await expect(page.getByText(DISCLAIMER).first()).toBeVisible();
  const board = page.getByRole('region', { name: /Open division/i });
  await expect(board).toBeVisible();

  for (const name of HOUSE_NAMES) {
    await expect(board.getByRole('heading', { name }), `${name} is on the board`).toBeVisible();
  }
  // No agent has a rank yet, and no agent shows a number it does not have.
  await expect(board.getByText('Not ranked').first()).toBeVisible();
  await expect(board.getByText(/^#\d+$/)).toHaveCount(0);
  // Prix says which agents it runs itself.
  await expect(board.getByText('House', { exact: true }).first()).toBeVisible();

  // The same agents as rows of a table: the form is named in the address.
  const showAs = page.getByRole('group', { name: 'Show as' });
  await showAs.getByRole('button', { name: 'Table' }).click();
  await expect(showAs.getByRole('button', { name: 'Table' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page).toHaveURL(/view=list/);
  for (const name of HOUSE_NAMES) await expect(board.getByRole('heading', { name })).toBeVisible();

  // The search narrows the board by name.
  const search = page.getByRole('searchbox', { name: 'Search agents' });
  await search.fill('dip buyer');
  await expect(board.getByRole('heading', { name: 'Dip Buyer' })).toBeVisible();
  await expect(board.getByRole('heading', { name: 'Treasury First' })).toBeHidden();
  await search.fill('');
  await expect(board.getByRole('heading', { name: 'Treasury First' })).toBeVisible();

  // The order is a link, so it works without script: New puts the newest agent first.
  const order = page.getByRole('group', { name: 'Order' });
  await order.getByRole('link', { name: 'New' }).click();
  await expect(page).toHaveURL(/order=new/);
  await expect(order.getByRole('link', { name: 'New' })).toHaveAttribute('aria-current', 'true');

  // The Pro division is its own board, empty on a new stack, and says what to do about it.
  await page.getByRole('group', { name: 'Division' }).getByRole('link', { name: 'Pro' }).click();
  await expect(page.getByText('No agents in this division', { exact: true })).toBeVisible();
  expect(failures).toEqual([]);
});

test('a house agent has a page of its own with the simulation sentence and no prompt', async ({ page }) => {
  await page.goto('/league');
  await page
    .getByRole('region', { name: /Open division/i })
    .getByRole('link', { name: 'Treasury First', exact: true })
    .click();
  await expect(page).toHaveURL(/\/agents\/[a-z0-9]+$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Treasury First' })).toBeVisible();
  await expect(page.getByText(DISCLAIMER).first()).toBeVisible();
  // A paper account at the start: nothing here may read as advice or as a promise.
  await expect(page.getByText(/guaranteed|risk-free|you will earn/i)).toHaveCount(0);
});

test('the header and the board fit a phone without sideways scrolling', async ({ page }) => {
  for (const path of ['/', '/league', '/methodology', '/token']) {
    await page.goto(path);
    const overflow = await page.evaluate(() => {
      const root = (
        globalThis as unknown as { document: { documentElement: { scrollWidth: number; clientWidth: number } } }
      ).document.documentElement;
      return root.scrollWidth - root.clientWidth;
    });
    expect(overflow, `${path} scrolls sideways by ${overflow}px`).toBeLessThanOrEqual(0);
  }
});
