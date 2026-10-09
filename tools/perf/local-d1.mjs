// A D1 database on this machine that reports what Cloudflare bills: rows read and rows written
// per statement. It is the same SQLite build and the same counters as production D1, because
// Wrangler runs D1 locally in workerd. Nothing here touches a Cloudflare account.
//
// The database lives in memory and is gone when `stop()` is called.

import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PERF_DIR, REPO_ROOT } from './lib.mjs';

const MIGRATIONS_DIR = resolve(REPO_ROOT, 'infra', 'migrations');

/** Starts the Worker in tools/perf/d1-worker and returns a function that sends it statements. */
export async function startLocalD1() {
  const { unstable_startWorker: startWorker } = await import('wrangler');
  const worker = await startWorker({
    config: resolve(PERF_DIR, 'd1-worker', 'wrangler.jsonc'),
    dev: { persist: false, server: { port: 0 }, inspector: false, logLevel: 'error', watch: false, remote: false },
  });
  await worker.ready;
  const url = String(await worker.url);

  /** Runs one statement, or several as one batch, and returns D1's result for each. */
  async function execute(statements, batch) {
    const response = await fetch(url, { method: 'POST', body: JSON.stringify({ statements, batch }) });
    const answer = await response.json();
    if (!answer.ok) throw new D1Error(answer.message);
    return answer.results;
  }

  return { execute, stop: () => worker.dispose() };
}

/** What D1 throws for a statement it refuses: a constraint, a trigger, a daily limit. */
export class D1Error extends Error {
  constructor(message) {
    super(message);
    this.name = 'D1Error';
  }
}

/**
 * The part of the D1 binding that the store uses, over `execute`, with a meter in front of it.
 *
 * The meter counts what the free plan limits (docs/CONTRACTS.md section 2): one D1 query per
 * statement, a batch counting each of its statements, and the rows D1 says it read and wrote.
 * `meter.onExecute`, when set, sees every call and its results; a replay uses that.
 */
export function createMeteredD1(execute) {
  const meter = {
    calls: 0,
    statements: 0,
    rowsRead: 0,
    rowsWritten: 0,
    sizeAfter: 0,
    /** Rows by statement, keyed by the start of its SQL. */
    byStatement: new Map(),
    onExecute: null,
    reset() {
      this.calls = 0;
      this.statements = 0;
      this.rowsRead = 0;
      this.rowsWritten = 0;
      this.byStatement = new Map();
    },
    take() {
      const taken = {
        calls: this.calls,
        statements: this.statements,
        rowsRead: this.rowsRead,
        rowsWritten: this.rowsWritten,
        byStatement: this.byStatement,
      };
      this.reset();
      return taken;
    },
  };

  async function run(statements, batch) {
    const sent = statements.map((statement) => ({ sql: statement.sql, params: statement.params }));
    meter.calls += 1;
    meter.statements += sent.length;
    const results = await execute(sent, batch);
    results.forEach((result, index) => {
      const meta = result.meta ?? {};
      const read = meta.rows_read ?? 0;
      const written = meta.rows_written ?? 0;
      meter.rowsRead += read;
      meter.rowsWritten += written;
      if (typeof meta.size_after === 'number') meter.sizeAfter = meta.size_after;
      const key = labelOf(sent[index].sql);
      const entry = meter.byStatement.get(key) ?? { count: 0, rowsRead: 0, rowsWritten: 0 };
      entry.count += 1;
      entry.rowsRead += read;
      entry.rowsWritten += written;
      meter.byStatement.set(key, entry);
    });
    meter.onExecute?.(sent, batch, results);
    return results.map((result) => ({ success: true, results: result.results ?? [], meta: result.meta ?? {} }));
  }

  class Statement {
    constructor(sql, params) {
      this.sql = sql;
      this.params = params;
    }

    bind(...values) {
      return new Statement(this.sql, values);
    }

    async all() {
      return (await run([this], false))[0];
    }

    async run() {
      return (await run([this], false))[0];
    }

    async first(column) {
      const row = (await run([this], false))[0].results[0];
      if (row === undefined) return null;
      return column === undefined ? row : (row[column] ?? null);
    }

    async raw() {
      return (await run([this], false))[0].results.map((row) => Object.values(row));
    }
  }

  const db = {
    prepare: (sql) => new Statement(sql, []),
    batch: (statements) => run(statements, true),
    exec() {
      throw new Error('local-d1: exec is not supported. Use prepare().');
    },
  };
  return { db, meter };
}

/** The first words of a statement, enough to tell it from the others in a report. */
function labelOf(sql) {
  return sql.replace(/\s+/g, ' ').trim().slice(0, 72);
}

/**
 * Splits a migration file into statements. A trigger keeps its body: the semicolons between
 * BEGIN and END do not end the statement.
 */
export function splitSql(text) {
  const withoutComments = text
    .split('\n')
    .map((line) => {
      const at = line.indexOf('--');
      return at === -1 ? line : line.slice(0, at);
    })
    .join('\n');
  const statements = [];
  let current = '';
  for (const piece of withoutComments.split(';')) {
    current = current === '' ? piece : `${current};${piece}`;
    const inTrigger = /^\s*CREATE\s+(TEMP\s+|TEMPORARY\s+)?TRIGGER\b/i.test(current);
    if (inTrigger && !/\bEND\s*$/i.test(current)) continue;
    if (current.trim() !== '') statements.push(current.trim());
    current = '';
  }
  if (current.trim() !== '') statements.push(current.trim());
  return statements;
}

/** Applies every file of infra/migrations, in name order, as `wrangler d1 migrations apply` would. */
export async function applyMigrations(execute) {
  const files = (await readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith('.sql')).sort();
  if (files.length === 0) throw new Error(`No migration in ${MIGRATIONS_DIR}.`);
  for (const file of files) {
    const statements = splitSql(await readFile(resolve(MIGRATIONS_DIR, file), 'utf8'));
    for (const sql of statements) {
      try {
        await execute([{ sql, params: [] }], false);
      } catch (error) {
        throw new Error(`Migration ${file} failed at "${labelOf(sql)}": ${error.message}`);
      }
    }
  }
  return files;
}
