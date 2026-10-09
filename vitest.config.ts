import { defineConfig } from 'vitest/config';

/**
 * The Vitest suites of `qa`: unit, integration and scheduler tests under tests/.
 * End-to-end tests are Playwright specs (tests/e2e/*.spec.ts) and are not collected here.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // The Workers-runtime tests have their own config: tests/vitest.workers.config.ts.
    exclude: ['tests/workers/**', 'tests/**/*.d1.test.ts', '**/node_modules/**'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
