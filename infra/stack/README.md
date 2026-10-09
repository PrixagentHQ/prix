# The local stack

The whole product on this machine: the real site build, the API Worker, a local D1 database with season 1, and the cron handler on request. It needs no Cloudflare login and touches no remote resource. The end-to-end tests run here and never against prixagent.com.

```sh
pnpm stack
```

It prints `stack ready on http://localhost:8791` when the landing page and `/api/market` both answer. Stop it with Ctrl+C. The first run takes about a minute (site build, migrations, two Workers starting).

| Option | What it does |
|---|---|
| `--port <n>` | The address of the stack. Default 8791. Also uses n+1 (API), n+2 (site), n+3 and n+4 (inspectors). |
| `--fresh` | Start from an empty database and reseed. Without it the last run's state is kept. |
| `--admin 0x...` | Sets `ADMIN_ADDRESSES` (comma-separated) so a test wallet may use the admin routes. |
| `--house 0x...` | Sets `HOUSE_OWNERS` (comma-separated): the wallets whose agents are house agents. `node infra/seed/house-agents.mjs --wallets` prints the value, and `--origin http://localhost:<port>` then creates the agents on the stack (infra/README.md, section 15). |
| `--scheduled` | Exposes the cron handler, see below. |
| `--no-build` | Reuse the last site build. Use it only when the site did not change. |
| `--stop` | Stop a stack that a killed script left behind. |

## How it is put together

Two `wrangler dev` sessions run, `prix-api` and `prix-web`. The site's `API` service binding reaches the API through Wrangler's local dev registry, as it does in production through Cloudflare. Wrangler's one-session multi-config mode was not used: only the first Worker of such a session is reachable over HTTP, and the browser needs `/api/*` on the same origin as the pages. A small front server on `--port` does what the zone route does in production: `/api/*` goes to the API, everything else to the site.

The configuration is derived from `apps/api/wrangler.jsonc` and the site build, with the zone routes removed and `SITE_ORIGIN` set to `http://localhost:<port>`. The derived files live in `.artifacts/stack/`.

## Sign-in over http

The session cookie is `__Host-prix_session`, which carries `Secure`. Chromium (and so Playwright's Chromium) treats `http://localhost` as a secure origin and keeps the cookie; this was checked against the real Chromium of this repository. Firefox does the same. WebKit (Safari, Playwright's `webkit`) does not, and sign-in will not hold there. Use `localhost`, not `127.0.0.1`, as the host: the origin must equal `SITE_ORIGIN`, and `localhost` is the one the API expects. The stack therefore serves plain http.

## State

Everything is under `.artifacts/stack/` (gitignored):

| Path | Content |
|---|---|
| `state/` | The local D1 database (Miniflare files). |
| `seed.json` | The start date of season 1, so a kept database is not reseeded with another date. The first run uses the most recent Monday, UTC. |
| `secrets.json` | `NONCE_SECRET` and `KEY_ENCRYPTION_KEY`, random, generated at the first run, never printed. |
| `api/`, `web/` | The derived Worker configurations, and the API's `.dev.vars`. Rewritten at each start. |
| `api.log`, `web.log` | Output of the two Workers. |

Reset: `pnpm stack --fresh` empties the database and reseeds. To forget the secrets too, delete `.artifacts/stack/` while the stack is stopped. Deleting the secrets while keeping the database makes the sealed model keys in it unreadable.

## The scheduler by hand

Start with `--scheduled`, then:

```sh
curl -X POST http://localhost:8791/__scheduled
```

One call is one run of the `scheduled` handler, the same as one Cron Trigger tick. Add `?cron=*+*+*+*+*` to choose the cron expression. The endpoint exists only with `--scheduled` and only for POST. `wrangler dev` never fires a Cron Trigger by itself, so nothing runs unless you call it. Market snapshots read the chain over the network, and a house-model call needs a Cloudflare login (`wrangler login`); nothing else does.

## Stopping

Ctrl+C stops the front server and both Workers, and every process under them. If the script was killed instead (a hard kill leaves the Workers behind), run `pnpm stack --stop`, or simply start the stack again: it first stops what the last run recorded in `.artifacts/stack/stack.pid.json`.
