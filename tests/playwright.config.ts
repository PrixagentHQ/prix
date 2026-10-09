import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests. They run against a stack on the local machine and never against
 * prixagent.com: they create wallets and agents, and there is one environment only
 * (docs/CONTRACTS.md section 15, "Tests").
 *
 *   PRIX_BASE_URL=http://localhost:4321 pnpm --filter @prix/tests run e2e
 *
 * Without PRIX_BASE_URL every test is skipped. The acceptance list of docs/SPEC.md section 8
 * asks for the path "on a phone and on a desktop", so there is one project for each.
 */
const baseURL = process.env.PRIX_BASE_URL;

if (baseURL !== undefined && baseURL !== '') {
  const host = new URL(baseURL).hostname.toLowerCase();
  if (host === 'prixagent.com' || host.endsWith('.prixagent.com')) {
    throw new Error('The end-to-end tests create agents. They never run against prixagent.com: use a local stack.');
  }
}

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 400_000,
  reporter: 'list',
  outputDir: '../test-results',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'phone', use: { ...devices['Pixel 7'] } },
  ],
});
