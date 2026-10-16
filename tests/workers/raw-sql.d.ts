/**
 * Vite's `?raw` import of a migration file: the file's text. Declared by hand so that `tsc` can check
 * tests/workers/live-program-row.test.ts (tests/workers/tsconfig.json). Vite provides the real module.
 */
declare module '*.sql?raw' {
  const text: string;
  export default text;
}
