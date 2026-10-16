import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * The tests of the Community chat's composer and of its admins' page, beside them. The root's
 * `pnpm test` collects tests/ only, so these run by their own config:
 *
 *   pnpm exec vitest run --config apps/web/src/account/social/room/vitest.config.ts
 *
 * They pin what docs/contracts/phase-6-room.md asks of the two screens. A sentence is read from the
 * copy deck, never written here.
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
