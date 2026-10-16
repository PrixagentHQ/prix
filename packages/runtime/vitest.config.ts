import { defineConfig } from 'vitest/config';

/**
 * The runtime's own unit tests, beside the code they test. They run in Node against fakes of the ports
 * and reach no network. The suites of `qa` are under tests/ and have the root config.
 * Run: pnpm --filter @prix/runtime test
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
  },
});
