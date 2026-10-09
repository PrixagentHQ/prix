import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * The unit tests of the site's own modules, beside them. The root suite collects only tests/.
 * Run: pnpm exec vitest run --config apps/web/src/site/vitest.config.ts
 */
export default defineConfig({
  test: {
    root: fileURLToPath(new URL('.', import.meta.url)),
    include: ['**/*.test.ts'],
    environment: 'node',
  },
});
