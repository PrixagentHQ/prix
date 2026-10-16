import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Part E's secret script (docs/contracts/phase-6-holders.md sections 7 and 11 E, HB-9), run against a fake
 * `wrangler` that keeps what was piped to it: the script prints only "done" or its fixed failure line, and what
 * it pipes is 64 lower-case hex characters and a newline.
 */

const SCRIPT = join(import.meta.dirname, '..', '..', 'infra', 'telegram', 'put-webhook-secret.mjs');
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function run(exitCode: number) {
  const dir = mkdtempSync(join(tmpdir(), 'prix-webhook-secret-'));
  dirs.push(dir);
  const kept = join(dir, 'piped.txt');
  const argsFile = join(dir, 'args.json');
  const fake = join(dir, 'fake-wrangler.mjs');
  writeFileSync(
    fake,
    [
      "import { writeFileSync } from 'node:fs';",
      'let input = "";',
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      `  writeFileSync(${JSON.stringify(kept)}, input);`,
      `  writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));`,
      "  console.log('wrangler says: ' + input);",
      `  process.exit(${exitCode});`,
      '});',
    ].join('\n'),
  );
  const result = spawnSync(process.execPath, [SCRIPT], {
    env: { ...process.env, PRIX_WRANGLER_SCRIPT: fake },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { result, piped: readFileSync(kept, 'utf8'), args: JSON.parse(readFileSync(argsFile, 'utf8')) as string[] };
}

describe('infra/telegram/put-webhook-secret.mjs', () => {
  it('pipes 64 lower-case hex characters and a newline to `secret put TELEGRAM_WEBHOOK_SECRET` and prints only "done"', () => {
    const { result, piped, args } = run(0);
    expect(result.status).toBe(0);
    expect(piped).toMatch(/^[0-9a-f]{64}\n$/);
    expect(args).toEqual(['secret', 'put', 'TELEGRAM_WEBHOOK_SECRET']);
    expect(result.stdout).toBe('done\n');
    expect(result.stderr).toBe('');
    expect(result.stdout).not.toContain(piped.trim());
  });

  it('prints one fixed failure line and nothing of the secret when wrangler fails, and a new secret each run', () => {
    const first = run(1);
    expect(first.result.status).toBe(1);
    expect(first.result.stdout.trim().split('\n')).toHaveLength(1);
    expect(first.result.stdout).not.toContain(first.piped.trim());
    expect(first.result.stderr).toBe('');
    const second = run(0);
    expect(second.piped).not.toBe(first.piped);
  });
});
