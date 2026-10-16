import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * The tests of the lounge's block on /following (docs/contracts/phase-6-holders-2.md section 4.7), beside
 * it. The root's `pnpm test` collects tests/ only, so these run by their own config:
 *
 *   pnpm exec vitest run --config apps/web/src/account/lounge/vitest.config.ts
 */
export default defineConfig({
  test: {
    root: fileURLToPath(new URL('.', import.meta.url)),
    include: ['**/*.test.ts'],
    environment: 'node',
  },
  define: {
    __PRIX_FIXTURES__: 'false',
  },
});
