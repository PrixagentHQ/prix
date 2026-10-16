import { fileURLToPath } from 'node:url';
import { getViteConfig } from 'astro/config';

/**
 * The holders' tape and the room's Holder mark rendered by Astro's container (render.test.ts), with the
 * site's fixtures on, as a sample build has them. The pure helpers of the tape are tested by the arena's
 * own config (../vitest.config.ts), which leaves this file's test out.
 *
 * Run: pnpm exec vitest run --config apps/web/src/arena/tape/vitest.config.ts
 */
const root = fileURLToPath(new URL('.', import.meta.url));
const webRoot = fileURLToPath(new URL('../../..', import.meta.url));

export default getViteConfig(
  {
    test: {
      root,
      include: ['render.test.ts'],
      environment: 'node',
      testTimeout: 60_000,
      hookTimeout: 120_000,
    },
    define: { __PRIX_FIXTURES__: 'true' },
  },
  { root: webRoot, configFile: false },
);
