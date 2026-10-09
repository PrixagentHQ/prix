import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The walls around Phase 6 (docs/contracts/phase-6-social.md sections 5.4 and 11), proved from the source:
 * no scoring, ranking or replay code imports the rivalry module or reads its tables; no Phase 6 code writes a
 * Phase 1 to 5 table, except the rank copy in `rerank`; no Phase 6 SQL selects an agent's prompt; no Phase 6
 * code asks a wallet for anything.
 */

const root = process.cwd();

function files(dir: string, extensions: readonly string[]): string[] {
  const out: string[] = [];
  const base = join(root, dir);
  if (!existsSync(base)) return out;
  for (const name of readdirSync(base)) {
    if (name === 'node_modules' || name === '__tests__') continue;
    const path = join(base, name);
    if (statSync(path).isDirectory()) out.push(...files(join(dir, name), extensions));
    else if (extensions.some((e) => name.endsWith(e)) && !name.endsWith('.test.ts')) out.push(path);
  }
  return out;
}

const read = (path: string): string => readFileSync(path, 'utf8');
const rel = (path: string): string => relative(root, path).replaceAll('\\', '/');

/** Comments removed, so a sentence that names a table is not read as a use of it. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

describe('the rivalry module and its tables', () => {
  const scoring = [
    'packages/reputation/src/v1.ts',
    'packages/reputation/src/v2.ts',
    'packages/reputation/src/replay.ts',
    'packages/reputation/src/awards.ts',
    'packages/reputation/src/chain-record.ts',
    'packages/reputation/src/index.ts',
    'packages/sim/src/portfolio.ts',
    'packages/sim/src/rebalance.ts',
    ...files('packages/runtime/src/reputation', ['.ts']).map(rel),
    'packages/runtime/src/scheduler.ts',
    'apps/api/src/store/reputation.ts',
    'apps/api/src/store/index.ts',
    'apps/api/src/store/sql.ts',
  ];

  it('is imported by none of the scoring, ranking or replay code', () => {
    for (const path of scoring) {
      const source = code(read(join(root, path)));
      expect(source, path).not.toMatch(/rivalr/i);
    }
    expect(scoring.length).toBeGreaterThan(8);
  });

  it('is imported by the rivalry job and by nothing that scores', () => {
    const importers = [...files('packages', ['.ts']), ...files('apps/api/src', ['.ts'])]
      .map(rel)
      .filter((path) => /from\s+['"][^'"]*rivalry(\.ts)?['"]/.test(read(join(root, path))));
    // Only the engine's own package and its job may name it; the job takes the engine through the deps.
    // The Worker entrypoint is the one place that builds those deps, so it names the engine once to hand
    // it to the social job and to nothing else.
    const COMPOSITION_ROOT = 'apps/api/src/index.ts';
    for (const path of importers) {
      expect(
        path.startsWith('packages/reputation/src/') ||
          path.startsWith('packages/runtime/src/social/') ||
          path === COMPOSITION_ROOT,
        path,
      ).toBe(true);
    }
    const root_ = read(join(root, COMPOSITION_ROOT));
    expect(root_.match(/rivalryEngine/g)?.length, 'the entrypoint uses the engine once, in the social deps').toBe(2);
  });
});

describe('the tables that Phase 6 must not write', () => {
  const PROTECTED = [
    'users',
    'nonces',
    'sessions',
    'agents',
    'model_keys',
    'seasons',
    'portfolios',
    'ticks',
    'decisions',
    'league_state',
    'season_scores',
    'season_methods',
    'day_prices',
    'listings',
    'follows',
    'counters',
    'ai_usage',
  ];
  const writes = new RegExp(
    `\\b(insert\\s+(?:or\\s+\\w+\\s+)?into|update|delete\\s+from|replace\\s+into)\\s+(?:${PROTECTED.join('|')})\\b`,
    'i',
  );

  it('no statement of the Phase 6 store writes a Phase 1 to 5 table', () => {
    const source = code(read(join(root, 'apps/api/src/store/social.ts')));
    const hits = [...source.matchAll(new RegExp(writes, 'gi'))].map((m) => m[0]);
    // `counters` and `job_state` are Phase 2's shared tables: the cursors live in `job_state` (see below).
    expect(hits.filter((hit) => !/job_state/i.test(hit))).toEqual([]);
  });

  it('writes the job_state table only for rows that start with social:', () => {
    const source = code(read(join(root, 'apps/api/src/store/social.ts')));
    const cursor = source.match(/INSERT INTO job_state[\s\S]*?ON CONFLICT/);
    expect(cursor).not.toBeNull();
    // The cursor statement takes its name from the caller; the jobs name only SOCIAL_CURSOR entries.
    for (const path of files('packages/runtime/src/social', ['.ts'])) {
      const text = code(read(path));
      for (const match of text.matchAll(/name:\s*['"]([^'"]+)['"]/g)) {
        expect(match[1], `${rel(path)}`).toMatch(/^social:/);
      }
    }
  });

  it('no Phase 6 job calls a method of the stores that writes a Phase 1 to 5 table', () => {
    const mutating = [
      'writeDecision',
      'createAgent',
      'updateAgent',
      'createTick',
      'completeTick',
      'rerank',
      'putScores',
      'rankScores',
      'putSeason',
      'captureDayPrices',
      'putSessionless',
      'spendApiWrites',
      'addAiNeurons',
      'putJobState',
    ];
    for (const path of files('packages/runtime/src/social', ['.ts'])) {
      const text = code(read(path));
      for (const name of mutating) expect(text, `${rel(path)} calls ${name}`).not.toMatch(new RegExp(`\\.${name}\\(`));
    }
  });

  it('only reads ai_usage: the war cap is a table of its own', () => {
    const text = code(read(join(root, 'packages/runtime/src/social/war-job.ts')));
    expect(text).toMatch(/getAiNeurons/);
    expect(text).not.toMatch(/addAiNeurons|reserveAiNeurons/);
  });
});

describe('private prompts', () => {
  it('no SQL of the Phase 6 store selects the prompt of an agent', () => {
    const source = code(read(join(root, 'apps/api/src/store/social.ts')));
    expect(source).not.toMatch(/\bprompt\b/i);
    expect(source).not.toMatch(/agentRecordColumns\([^)]*\)[\s\S]{0,40}prompt/i);
  });

  it('the routes name the prompt in one place only: the fork source', () => {
    const hits: string[] = [];
    for (const path of files('apps/api/src/http/social', ['.ts'])) {
      const text = code(read(path));
      for (const match of text.matchAll(/\.prompt\b/g)) hits.push(`${rel(path)}:${match.index}`);
    }
    // routes-agents.ts reads agent.prompt for the fork source and compares prompts in the link rule.
    for (const hit of hits) expect(hit.startsWith('apps/api/src/http/social/routes-agents.ts'), hit).toBe(true);
  });
});

describe('the wallet', () => {
  it('no Phase 6 code of the Worker or the packages asks a wallet for anything', () => {
    const paths = [
      ...files('apps/api/src/http/social', ['.ts']),
      ...files('packages/runtime/src/social', ['.ts']),
      join(root, 'apps/api/src/store/social.ts'),
      join(root, 'packages/reputation/src/dna.ts'),
      join(root, 'packages/reputation/src/rivalry.ts'),
      join(root, 'packages/reputation/src/war-standings.ts'),
      join(root, 'packages/sim/src/manager.ts'),
    ];
    for (const path of paths) {
      const text = code(read(path));
      expect(text, rel(path)).not.toMatch(
        /eth_sendTransaction|eth_signTransaction|eth_sign\b|personal_sign|signTypedData|wallet_|sendTransaction|writeContract|createWalletClient|signMessage/,
      );
    }
  });
});
