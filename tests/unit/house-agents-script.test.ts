import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repoRoot } from '../support/repo.ts';

/**
 * infra/seed/house-agents.mjs keeps its keys in the main checkout, whichever checkout runs it, and
 * one run at a time makes wallets (security review of the board look, finding 1). The script runs
 * as the operator runs it, with `node`, in a throwaway git repository with a worktree of its own.
 */
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
};

let base: string;
let main: string;
let worktree: string;

function git(cwd: string, ...args: string[]): void {
  const run = spawnSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', timeout: 30_000 });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`);
}

/** The script reads viem from apps/api: each checkout gets a link to the real one. */
function linkViem(checkout: string): void {
  mkdirSync(join(checkout, 'apps', 'api'), { recursive: true });
  symlinkSync(
    join(repoRoot(), 'apps', 'api', 'node_modules'),
    join(checkout, 'apps', 'api', 'node_modules'),
    'junction',
  );
}

function run(checkout: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [join(checkout, 'infra', 'seed', 'house-agents.mjs'), ...args], {
    cwd: checkout,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

const keysIn = (checkout: string) => join(checkout, '.artifacts', 'house-agents', 'wallets.json');
const walletsOf = (checkout: string): { address: string; privateKey: string }[] =>
  JSON.parse(readFileSync(keysIn(checkout), 'utf8')).wallets;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'prix-house-'));
  main = join(base, 'main');
  worktree = join(base, 'worktree');
  mkdirSync(join(main, 'infra', 'seed'), { recursive: true });
  cpSync(join(repoRoot(), 'infra', 'seed', 'house-agents.mjs'), join(main, 'infra', 'seed', 'house-agents.mjs'));
  cpSync(join(repoRoot(), 'infra', 'seed', 'house-agents.json'), join(main, 'infra', 'seed', 'house-agents.json'));
  writeFileSync(join(main, '.gitignore'), '.artifacts/\napps/api/node_modules\n');
  git(main, 'init', '-q');
  git(main, 'add', '-A');
  git(main, 'commit', '-q', '-m', 'seed');
  git(main, 'worktree', 'add', '-q', worktree);
  linkViem(main);
  linkViem(worktree);
}, 60_000);

afterAll(() => {
  if (base !== undefined) rmSync(base, { recursive: true, force: true });
});

describe('house-agents.mjs --wallets', () => {
  it('keeps the keys in the main checkout when it runs from a worktree', () => {
    const fromWorktree = run(worktree, '--wallets');
    expect(fromWorktree.status, fromWorktree.out).toBe(0);
    expect(existsSync(keysIn(worktree))).toBe(false);
    expect(existsSync(keysIn(main))).toBe(true);

    // The main checkout finds the same wallets and makes none.
    const fromMain = run(main, '--wallets');
    expect(fromMain.status, fromMain.out).toBe(0);
    expect(fromMain.out).toContain('0 of them new');
    for (const wallet of walletsOf(main)) {
      expect(fromWorktree.out).toContain(wallet.address);
      expect(fromWorktree.out).not.toContain(wallet.privateKey.slice(2));
    }
  });

  it('leaves no lock behind after a run', () => {
    expect(run(main, '--wallets').status).toBe(0);
    expect(existsSync(`${keysIn(main)}.lock`)).toBe(false);
  });

  it('stops, and changes no key, while another run holds the lock', () => {
    const before = readFileSync(keysIn(main), 'utf8');
    writeFileSync(`${keysIn(main)}.lock`, 'held\n');
    try {
      const held = run(worktree, '--wallets');
      expect(held.status, held.out).toBe(1);
      expect(held.out).toContain('wallets.json.lock');
      expect(readFileSync(keysIn(main), 'utf8')).toBe(before);
      // The lock of the other run is not taken away.
      expect(existsSync(`${keysIn(main)}.lock`)).toBe(true);
    } finally {
      rmSync(`${keysIn(main)}.lock`, { force: true });
    }
  });
});
