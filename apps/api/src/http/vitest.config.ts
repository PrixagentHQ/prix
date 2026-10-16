import { defineConfig } from 'vitest/config';

// The unit tests of this folder's own files (input.ts), with ports in memory: no D1, no Worker.
// Run: pnpm exec vitest run --config apps/api/src/http/vitest.config.ts
// The room's tests keep their own config (social/room/vitest.config.ts), and Live's its own (live/vitest.config.ts).
// Phase 6.8 adds the tape's, the lounge's and the follow routes' unit tests (tape/, lounge/, follow/).
// `--expose-gc` is for the test of what the body reader holds: it collects before it measures.
export default defineConfig({
  test: {
    root: 'apps/api/src/http',
    include: ['*.test.ts', 'tape/**/*.test.ts', 'lounge/**/*.test.ts', 'follow/**/*.test.ts'],
    environment: 'node',
    execArgv: ['--expose-gc'],
  },
});
