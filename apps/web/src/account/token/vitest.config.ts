import { fileURLToPath } from 'node:url';
import { getViteConfig } from 'astro/config';

/**
 * The tests of the holders round's account screens (docs/contracts/phase-6-holders.md, web-account's row):
 * "Open to holders now" and the mark's switch on /account/token, the holders' poll's vote control, and
 * /admin/holders. They sit beside their code under account/token, account/polls and account/admin/holders.
 * The root's `pnpm test` collects tests/ only, so they run by their own config:
 *
 *   pnpm exec vitest run --config apps/web/src/account/token/vitest.config.ts
 *
 * The components are rendered with Astro's container API; a sentence is read from the copy deck through
 * `text()`, never written here.
 */
const root = fileURLToPath(new URL('..', import.meta.url));
const webRoot = fileURLToPath(new URL('../../..', import.meta.url));

export default getViteConfig(
  {
    test: {
      root,
      include: ['token/**/*.test.ts', 'polls/**/*.test.ts', 'admin/holders/**/*.test.ts'],
      // The vote control in a browser has its own config (polls/vitest.browser.config.ts): fixtures on.
      exclude: ['polls/browser.test.ts', '**/node_modules/**'],
      environment: 'node',
      testTimeout: 60_000,
    },
    define: { __PRIX_FIXTURES__: 'false' },
  },
  { root: webRoot, configFile: false },
);
