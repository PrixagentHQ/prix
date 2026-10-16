// Makes a new TELEGRAM_WEBHOOK_SECRET for prix-api and stores it, and prints nothing of it
// (docs/contracts/phase-6-holders.md section 7, revision 2 H-SEC-2, revision 3 HB-9).
//
//   node infra/telegram/put-webhook-secret.mjs
//
// Run from the repository root, signed in to Wrangler. It takes 32 random bytes from crypto.getRandomValues,
// writes them as 64 lower-case hex characters and a newline to the standard input of
// `wrangler secret put TELEGRAM_WEBHOOK_SECRET` for prix-api (apps/api/wrangler.jsonc), and never to a file,
// the screen or a log. Wrangler's own output is not shown either: it prints only "done" or one fixed failure line.
// The secret is never typed, never pasted and never seen; a new one is made each time this runs, and the
// webhook must then be set again from /admin/holders (infra/README.md section 20).
//
// PRIX_WRANGLER_SCRIPT, for tests only: a Node script run in Wrangler's place with the same arguments.

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const apiDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'apps', 'api');

/** 64 lower-case hex characters: the alphabet apps/api/src/index.ts `readTelegram` takes (32 to 256 of A-Za-z0-9_-). */
export function newWebhookSecret() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function wranglerCommand() {
  const fake = process.env.PRIX_WRANGLER_SCRIPT;
  const args = ['secret', 'put', 'TELEGRAM_WEBHOOK_SECRET'];
  if (fake !== undefined && fake !== '') return { command: process.execPath, args: [fake, ...args], shell: false };
  return { command: 'pnpm', args: ['exec', 'wrangler', ...args], shell: process.platform === 'win32' };
}

async function main() {
  const { command, args, shell } = wranglerCommand();
  const child = spawn(command, args, { cwd: apiDir, stdio: ['pipe', 'ignore', 'ignore'], shell });
  const exit = new Promise((resolve) => {
    child.on('error', () => resolve(-1));
    child.on('close', (code) => resolve(code ?? -1));
  });
  child.stdin.on('error', () => undefined);
  child.stdin.end(`${newWebhookSecret()}\n`);
  const code = await exit;
  if (code === 0) {
    console.log('done');
  } else {
    console.log('The secret was not stored. Nothing was printed of it. Run the script again.');
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) await main();
