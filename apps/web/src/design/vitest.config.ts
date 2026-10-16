import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * The unit tests of the design system, beside their code: the charts, the animals, the field of
 * characters and the crawler. The root suite collects only tests/; the studies are left out.
 * Run: pnpm exec vitest run --config apps/web/src/design/vitest.config.ts
 */
export default defineConfig({
  test: {
    root: fileURLToPath(new URL('.', import.meta.url)),
    include: ['**/*.test.ts'],
    exclude: ['**/node_modules/**', 'studies*/**'],
    environment: 'node',
  },
});
