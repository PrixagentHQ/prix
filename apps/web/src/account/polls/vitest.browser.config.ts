import { fileURLToPath } from 'node:url';
import { getViteConfig } from 'astro/config';

/**
 * The holders' poll's vote control in a real browser (browser.test.ts beside it): /polls rendered by
 * Astro's container from the site's fixtures, served from 127.0.0.1 on a port from 9050 to 9059, with the
 * control's own script running and answering from fixtures.ts by `?pollfixture=`. Nothing leaves the
 * machine. It needs Playwright's Chromium (`pnpm exec playwright install chromium`).
 *
 * Run: pnpm exec vitest run --config apps/web/src/account/polls/vitest.browser.config.ts
 *
 * The control's other tests run under apps/web/src/account/token/vitest.config.ts, which leaves this file
 * out: the page here is read from fixtures, there from nothing.
 */
const root = fileURLToPath(new URL('.', import.meta.url));
const webRoot = fileURLToPath(new URL('../../..', import.meta.url));

export default getViteConfig(
  {
    test: {
      root,
      include: ['browser.test.ts'],
      environment: 'node',
      testTimeout: 60_000,
      hookTimeout: 120_000,
    },
    define: { __PRIX_FIXTURES__: 'true' },
  },
  { root: webRoot, configFile: false },
);
