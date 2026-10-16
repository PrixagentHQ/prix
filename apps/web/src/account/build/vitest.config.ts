import { fileURLToPath } from 'node:url';
import { getViteConfig } from 'astro/config';

/**
 * The tests of the Build page's strategy templates (D-155), beside them.
 *
 * - templates: the eight templates against the contract's prompt rules and the page's own (a title
 *   and a line say what a template does, never how well), and the picker rendered by Astro's
 *   container, where a template's text is an escaped attribute and never markup.
 * - browser: the Build page in Chromium (Playwright, already a dependency of the workspace) with
 *   its script running, rendered by the container from the site's fixtures (`?fixture=signed-in`)
 *   and served from 127.0.0.1 on a port from 9040 to 9049. Every /api request is answered by the
 *   test; nothing leaves the machine. It needs Playwright's Chromium on the machine
 *   (`pnpm exec playwright install chromium`).
 *
 * Run: pnpm exec vitest run --config apps/web/src/account/build/vitest.config.ts
 * Pictures of the section: set TEMPLATE_SHOTS to a folder and run the `browser` file.
 */
const root = fileURLToPath(new URL('.', import.meta.url));
const webRoot = fileURLToPath(new URL('../../..', import.meta.url));

export default getViteConfig(
  {
    test: {
      root,
      include: ['**/*.test.ts'],
      environment: 'node',
      testTimeout: 60_000,
      hookTimeout: 120_000,
    },
    // The fixtures answer the page's reads on the server, as in a fixture build.
    define: { __PRIX_FIXTURES__: 'true' },
  },
  { root: webRoot, configFile: false },
);
