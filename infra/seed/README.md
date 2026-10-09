# Seeding the database

A new D1 database has tables and no rows. One row has to be put there by hand before the league can run: season 1. Seasons are not created in a migration, because a start date is a decision and not part of the schema.

There is one environment, prixagent.com, and so one remote database (docs/CONTRACTS.md section 15). The command writes either to the local database on this machine or, with `--remote`, to that one.

## What a season is

A season starts at 00:00 UTC on a Monday and ends 28 days later at 00:00 UTC (docs/CONTRACTS.md section 3). The length is `SEASON_LENGTH_DAYS` in `packages/contracts`.

## The command

Run it from the repository root.

```sh
node infra/seed/season.ts --start 2026-10-12
```

`--start` is the first day of season 1, as `YYYY-MM-DD`. It must be a Monday.

Without `--remote` the command writes to the local database, the one `wrangler dev` uses. Nothing leaves the machine.

```sh
node infra/seed/season.ts --start 2026-10-12 --remote
```

With `--remote` it writes to the real database on Cloudflare. Only the operator runs this, at a gate.

Other options:

| Option | What it does |
|---|---|
| `--print` | Prints the SQL and stops. Nothing is run. |
| `--config <file>` | The Wrangler configuration file. Default: `apps/api/wrangler.jsonc`. |
| `--database <name>` | The D1 binding or database name. Default: `DB`. |
| `--persist-to <dir>` | Where the local database lives, as for `wrangler dev --persist-to`. Local only. |

There is no `--env` option. An option the command does not know stops it before anything is run.

## What it prints

| Output | Exit code | Meaning |
|---|---|---|
| `Created season 1, id ..., from ... to ..., in the local database.` | 0 | The season was written. |
| `Already there, left as it is: season 1, ...` | 0 | Season 1 exists with this start date. Nothing was changed. |
| `There is already a season 1, ..., in the local database. It does not start on .... Nothing was changed.` | 1 | Season 1 exists with another start date. |
| `A season starts on a Monday. 2026-10-13 is a Tuesday.` | 2 | The arguments were wrong. Nothing was run. |

With `--remote` the same lines end in `the remote database`.

The command is safe to repeat. It never moves or replaces a season that exists: agents and their records belong to it.

## Before the first seed

The tables must exist, so apply the migrations first. For the local database:

```sh
pnpm --filter @prix/api run db:migrate:local
```

The D1 binding in the Wrangler configuration must point at this repository's migrations with `"migrations_dir": "../../infra/migrations"`.

Applying migrations to the remote database is a deploy step. The operator does it at a gate, before seeding.

## The first migration

`infra/migrations/0001_initial.sql` was changed in place for contract revision 3, which is allowed only because it had never been applied to a remote database. A local database made from the older file does not match it. Delete the folder `apps/api/.wrangler` and apply the migrations again.

From the first remote apply onwards the rule holds without exception: a migration that has been applied is never edited, and a schema change is a new file with the next number.

## Later seasons

This command creates season 1 and nothing else. Season rollover is Phase 2 (docs/CONTRACTS.md section 14). When season 1 ends before rollover exists, the league stays readable and new agents wait.
