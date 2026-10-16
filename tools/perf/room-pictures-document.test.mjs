// The exit rule of room-pictures.mjs (the contract's section 14, perf's row, revision 5): it exits 1 only
// when a figure it prints from the constants differs from the document, and a laptop's CPU estimate is a
// warning that leaves the exit code at 0.
//
//   node --test tools/perf/room-pictures-document.test.mjs

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { PERF_DIR, REPO_ROOT } from './lib.mjs';
import { differencesFromDocument, exitCodeOf, sectionOf } from './room-pictures-document.mjs';

const DOCUMENT = resolve(REPO_ROOT, 'docs', 'contracts', 'phase-6-pictures.md');
const SCRIPT = resolve(PERF_DIR, 'room-pictures.mjs');

function figuresOnly(...args) {
  const run = spawnSync(process.execPath, [SCRIPT, '--figures-only', ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { code: run.status, out: `${run.stdout}\n${run.stderr}` };
}

test('a section is its own text and nothing of the next', () => {
  const text = '# T\n\n## 6. Storage\n\nnine days\n\n## 7. Serving\n\nheaders\n\n## 23. History\n\nnine days, once\n';
  assert.equal(sectionOf(text, 6).includes('nine days'), true);
  assert.equal(sectionOf(text, 6).includes('headers'), false);
  assert.equal(sectionOf(text, 7).includes('nine days'), false);
  assert.throws(() => sectionOf(text, 13), /section 13/);
});

test('a claim the section holds is no difference, and one it lacks is named with its section', () => {
  const text = '## 6. Storage\n\n150 pictures of 262,144 bytes\n\n## 7. Serving\n\n524,288 bytes, once\n';
  const claims = [
    { section: 6, what: 'the largest file', says: '262,144 bytes' },
    { section: 6, what: 'the old largest file', says: '524,288 bytes' },
  ];
  const differences = differencesFromDocument(text, claims);
  assert.equal(differences.length, 1);
  assert.match(differences[0], /the old largest file/);
  assert.match(differences[0], /524,288 bytes/);
  assert.match(differences[0], /section 6/);
});

test('a CPU estimate is a warning: it never moves the exit code', () => {
  assert.equal(exitCodeOf({ differences: [], warnings: [] }), 0);
  assert.equal(exitCodeOf({ differences: [], warnings: ['a warm upload took 12.00 ms of CPU, an estimate'] }), 0);
  assert.equal(exitCodeOf({ differences: ['KV storage at the ceiling'], warnings: [] }), 1);
});

test('the figures printed from the constants are the document’s: exit 0', () => {
  const run = figuresOnly();
  assert.equal(run.code, 0, run.out);
  assert.match(run.out, /PASS: every figure printed from the constants is the document’s/);
});

test('a figure of the document that differs from the constants: exit 1, and the figure is named', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prix-perf-document-'));
  try {
    const changed = readFileSync(DOCUMENT, 'utf8').replaceAll('353,894,400', '353,894,401');
    const file = join(dir, 'phase-6-pictures.md');
    writeFileSync(file, changed);
    const run = figuresOnly('--document', file);
    assert.equal(run.code, 1, run.out);
    assert.match(run.out, /FAIL/);
    assert.match(run.out, /353,894,400/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
