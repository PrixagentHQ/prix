import { defineConfig } from 'vitest/config';

/**
 * The tests that sit beside the code of packages/market (the holders round's lean token encoding and the
 * token read's block tag, docs/contracts/phase-6-holders.md section 5). The root's `pnpm test` reads tests/**
 * only. Run from the repository root:
 *   pnpm exec vitest run --config packages/market/vitest.config.ts
 */
export default defineConfig({
  test: {
    include: ['packages/market/src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
  },
});
