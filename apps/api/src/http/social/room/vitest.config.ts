import { defineConfig } from 'vitest/config';

// The unit tests of the room's routes, with a store in memory and no D1.
// Run: pnpm exec vitest run --config apps/api/src/http/social/room/vitest.config.ts
export default defineConfig({
  test: {
    root: 'apps/api/src/http/social/room',
    include: ['**/*.test.ts'],
    environment: 'node',
  },
});
