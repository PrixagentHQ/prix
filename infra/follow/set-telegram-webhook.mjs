// NOT USED SINCE THE HOLDERS ROUND (docs/contracts/phase-6-holders.md section 7, infra/README.md section 20): it
// takes the webhook secret from the command line. prix-api sets the webhook itself from /admin/holders, and
// infra/telegram/put-webhook-secret.mjs makes and stores the secret without showing it.
//
// Registers the Prix Telegram webhook (docs/contracts/phase-3-follow.md section 5).
//
//   TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... SITE_ORIGIN=https://prixagent.com \
//     node infra/follow/set-telegram-webhook.mjs
//
// It calls setWebhook once and prints Telegram's answer. It never prints the token or the secret.

const token = process.env.TELEGRAM_BOT_TOKEN ?? '';
const secret = process.env.TELEGRAM_WEBHOOK_SECRET ?? '';
const origin = (process.env.SITE_ORIGIN ?? '').replace(/\/+$/, '');

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (token === '') fail('TELEGRAM_BOT_TOKEN is not set.');
// Telegram allows A-Z, a-z, 0-9, underscore and hyphen in the secret, 1 to 256 characters.
if (!/^[A-Za-z0-9_-]{1,256}$/.test(secret)) {
  fail('TELEGRAM_WEBHOOK_SECRET must be 1 to 256 characters of A-Z, a-z, 0-9, underscore or hyphen.');
}
if (!/^https:\/\/[^/\s]+$/.test(origin)) fail('SITE_ORIGIN must be an https origin such as https://prixagent.com.');

const url = `${origin}/api/telegram/webhook`;

try {
  // The token is part of the path, so the URL is never printed.
  const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ url, secret_token: secret, allowed_updates: ['message'] }),
  });
  const answer = await response.json().catch(() => null);
  console.log(JSON.stringify({ status: response.status, webhook: url, telegram: answer }, null, 2));
  if (!response.ok || answer?.ok !== true) process.exit(1);
} catch (cause) {
  fail(`setWebhook failed: ${cause instanceof Error ? cause.name : 'unknown error'}`);
}
