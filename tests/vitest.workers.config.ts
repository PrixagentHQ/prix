import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

/**
 * The tests that need the Workers runtime: the D1 store against a local D1 database.
 * Run with `pnpm exec vitest run --config tests/vitest.workers.config.ts`.
 *
 * The database is declared here, not in apps/api/wrangler.jsonc, and its schema is the
 * migrations in infra/migrations, so this test cannot depend on how the Worker is bound.
 * Written from the current Workers Vitest integration documentation: `cloudflareTest` takes the
 * Miniflare options, `readD1Migrations` reads the folder, and `applyD1Migrations` runs in a setup file.
 */
export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(path.join(import.meta.dirname, '..', 'infra', 'migrations'));
      return {
        miniflare: {
          compatibilityDate: '2026-08-22',
          compatibilityFlags: ['nodejs_compat'],
          d1Databases: ['DB'],
          bindings: { TEST_MIGRATIONS: migrations },
        },
      };
    }),
  ],
  test: {
    include: ['tests/workers/**/*.test.ts', 'tests/**/*.d1.test.ts'],
    setupFiles: ['tests/workers/apply-migrations.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
