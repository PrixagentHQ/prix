/**
 * Creates season 1 in the D1 database. infra/seed/README.md is the manual.
 *
 *   node infra/seed/season.ts --start 2026-10-12            the local database
 *   node infra/seed/season.ts --start 2026-10-12 --remote   the database on Cloudflare
 *
 * There is one environment (docs/CONTRACTS.md section 15), so there is nothing to choose but
 * local or remote. Local is the default. The remote database is written only with --remote.
 *
 * A season starts at 00:00 UTC on a Monday and ends SEASON_LENGTH_DAYS later
 * (docs/CONTRACTS.md section 3). Seasons are seeded with this command and never in a migration,
 * because a start date is a decision and not part of the schema.
 *
 * The command is safe to repeat: it inserts season 1 only if the database has none. If season 1
 * exists with another start date it changes nothing and fails, so a typo cannot move a season.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { Season } from '../../packages/contracts/src/index.ts';
import { newId, SEASON_LENGTH_DAYS, seasonSchema } from '../../packages/contracts/src/index.ts';

const SEASON_NUMBER = 1;
const DAY_MS = 24 * 60 * 60 * 1000;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CONFIG_CANDIDATES = ['apps/api/wrangler.jsonc', 'apps/api/wrangler.json', 'apps/api/wrangler.toml'];

const USAGE = `Usage:
  node infra/seed/season.ts --start <YYYY-MM-DD> [options]

  --start        The first day of season 1. It must be a Monday. The season starts at 00:00 UTC.

Options:
  --remote       Write to the database on Cloudflare. Without it, the local one is used.
  --print        Print the SQL and stop. Nothing is run.
  --config       The Wrangler configuration file. Default: apps/api/wrangler.jsonc.
  --database     The D1 binding or database name. Default: DB.
  --persist-to   Where the local database lives, as for "wrangler dev". Local only.`;

class UsageError extends Error {}

/** The season that starts on `start`, a UTC calendar day that must be a Monday. */
export function seasonStartingOn(start: string, id: string): Season {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) throw new UsageError(`--start must look like 2026-10-12. Got "${start}".`);
  const startsAt = new Date(`${start}T00:00:00.000Z`);
  if (Number.isNaN(startsAt.getTime()) || startsAt.toISOString().slice(0, 10) !== start) {
    throw new UsageError(`--start is not a real calendar day: "${start}".`);
  }
  if (startsAt.getUTCDay() !== 1) {
    const weekday = startsAt.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
    throw new UsageError(`A season starts on a Monday. ${start} is a ${weekday}.`);
  }
  const endsAt = new Date(startsAt.getTime() + SEASON_LENGTH_DAYS * DAY_MS);
  return seasonSchema.parse({
    id,
    number: SEASON_NUMBER,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
  });
}

/**
 * Inserts the season unless season 1 exists, then reads season 1 back.
 * Every value is generated or validated above, so none of them can carry a quote.
 */
export function seasonSql(season: Season): string {
  return [
    'INSERT INTO seasons (id, number, starts_at, ends_at)',
    `SELECT '${season.id}', ${season.number}, '${season.startsAt}', '${season.endsAt}'`,
    `WHERE NOT EXISTS (SELECT 1 FROM seasons WHERE number = ${season.number});`,
    `SELECT id, number, starts_at, ends_at FROM seasons WHERE number = ${season.number};`,
  ].join(' ');
}

function findConfig(given: string | undefined): string {
  if (given !== undefined) {
    const path = resolve(given);
    if (!existsSync(path)) throw new UsageError(`No Wrangler configuration at ${path}.`);
    return path;
  }
  for (const candidate of CONFIG_CANDIDATES) {
    const path = resolve(REPO_ROOT, candidate);
    if (existsSync(path)) return path;
  }
  throw new UsageError(`No Wrangler configuration found. Looked for ${CONFIG_CANDIDATES.join(', ')}. Use --config.`);
}

/** The path of Wrangler's own entry file, so it runs under this Node without a shell. */
function wranglerEntry(): string {
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve('wrangler/package.json');
  const manifest = require(manifestPath) as { bin: string | Record<string, string> };
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin.wrangler;
  if (bin === undefined) throw new Error('The wrangler package names no executable.');
  return resolve(dirname(manifestPath), bin);
}

interface StoredSeason {
  id: string;
  number: number;
  starts_at: string;
  ends_at: string;
}

/** The season row that the last statement of `seasonSql` returned, from Wrangler's JSON output. */
function storedSeason(output: string): StoredSeason | null {
  const start = output.indexOf('[');
  if (start === -1) return null;
  const statements = JSON.parse(output.slice(start)) as { results?: StoredSeason[] }[];
  return statements.at(-1)?.results?.[0] ?? null;
}

/** The options of the command. An option it does not know is a usage error, not a stack trace. */
function readOptions() {
  try {
    return parseArgs({
      options: {
        start: { type: 'string' },
        remote: { type: 'boolean', default: false },
        print: { type: 'boolean', default: false },
        config: { type: 'string' },
        database: { type: 'string', default: 'DB' },
        'persist-to': { type: 'string' },
        help: { type: 'boolean', default: false },
      },
    }).values;
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : 'The arguments could not be read.');
  }
}

function main(): number {
  const values = readOptions();
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (values.start === undefined) throw new UsageError('--start is required.');
  if (values.remote && values['persist-to'] !== undefined) {
    throw new UsageError('--persist-to is for the local database. Leave it out with --remote.');
  }

  const season = seasonStartingOn(values.start, newId());
  const sql = seasonSql(season);
  if (values.print) {
    console.log(sql);
    return 0;
  }

  const where = values.remote ? 'the remote database' : 'the local database';
  const args = [
    wranglerEntry(),
    'd1',
    'execute',
    values.database,
    '--config',
    findConfig(values.config),
    values.remote ? '--remote' : '--local',
    '--json',
    '--yes',
    '--command',
    sql,
  ];
  if (values['persist-to'] !== undefined) args.push('--persist-to', resolve(values['persist-to']));

  const run = spawnSync(process.execPath, args, { cwd: REPO_ROOT, encoding: 'utf8' });
  if (run.error !== undefined) throw run.error;
  if (run.status !== 0) {
    console.error(run.stdout);
    console.error(run.stderr);
    console.error(`Wrangler failed. Nothing is known about season ${SEASON_NUMBER} in ${where}.`);
    return 1;
  }

  const stored = storedSeason(run.stdout);
  if (stored === null) {
    console.error(run.stdout);
    console.error(`Wrangler ran, but season ${SEASON_NUMBER} could not be read back from ${where}.`);
    return 1;
  }
  const line = `season ${stored.number}, id ${stored.id}, from ${stored.starts_at} to ${stored.ends_at}`;
  if (stored.starts_at !== season.startsAt) {
    console.error(`There is already a ${line}, in ${where}.`);
    console.error(`It does not start on ${values.start}. Nothing was changed.`);
    return 1;
  }
  const verb = stored.id === season.id ? 'Created' : 'Already there, left as it is:';
  console.log(`${verb} ${line}, in ${where}.`);
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(error.message);
    console.error('');
    console.error(USAGE);
    process.exitCode = 2;
  }
}
