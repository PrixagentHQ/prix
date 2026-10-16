import type { FollowApiDeps, TelegramWebhookAdminResponse, TelegramWebhookState } from '@prix/contracts';
import { TELEGRAM_ALLOWED_UPDATES, TELEGRAM_WEBHOOK_URL } from '@prix/contracts';
import type { Hono } from 'hono';
import { ApiFailure, failures, json } from '../errors.ts';
import { enforceLimit, readSession, sameSiteOr404 } from '../guard.ts';

/** The fixed reasons a failure of the webhook's admin route logs: never a Telegram URL or an error's text. */
type WebhookFailure = 'set' | 'info' | 'watch';

function logFailure(reason: WebhookFailure): void {
  console.error(JSON.stringify({ event: 'telegram_webhook_admin_failed', reason }));
}

/**
 * The webhook's two admin routes (docs/contracts/phase-6-holders.md section 7, revision 2, H-SEC-2; revision 4,
 * H3-SEC-8). Both answer anyone but an admin exactly as an unknown path, before anything else is read.
 *
 * `POST /admin/telegram/webhook` points Telegram at prix-api with its own secrets, the url
 * TELEGRAM_WEBHOOK_URL, `allowed_updates` TELEGRAM_ALLOWED_UPDATES (`["message", "chat_join_request"]`, the
 * contract's own list and never one of this route's; revision 6, R1, HB1F-SEC-1) and `drop_pending_updates: true`,
 * then reads the webhook back and answers only its `url`, `pending_update_count` and `last_error_message`, which
 * are what the founder pastes back. It needs the token and the webhook secret, not the username. Neither secret is in an answer or a log.
 *
 * `GET /admin/telegram/webhook` answers the webhook's watch, which /admin/holders shows.
 */
export function registerTelegramAdminRoutes(routes: Hono, deps: FollowApiDeps, admins: ReadonlySet<string>): void {
  async function adminOr404(request: Request): Promise<string> {
    const session = await readSession(deps, request);
    const address = session?.address.toLowerCase();
    if (address === undefined || !admins.has(address)) throw failures.routeNotFound();
    return address;
  }

  routes.post('/admin/telegram/webhook', async (c) => {
    // From the site, or the generic 404 like anyone who is not an admin (section 11 E).
    sameSiteOr404(deps, c.req.raw);
    const admin = await adminOr404(c.req.raw);
    const telegram = deps.telegram;
    if (telegram === null) throw failures.routeNotFound();
    // It calls Telegram twice, so it is counted per admin wallet as a write is.
    await enforceLimit(deps, 'write', admin);
    const set = await telegram.port.setWebhook({
      url: TELEGRAM_WEBHOOK_URL,
      secretToken: telegram.config.webhookSecret,
      allowedUpdates: TELEGRAM_ALLOWED_UPDATES,
      dropPendingUpdates: true,
    });
    if (!set) logFailure('set');
    const info = await telegram.port.getWebhookInfo();
    if (info === null) {
      logFailure('info');
      throw new ApiFailure('internal', 'Telegram could not be asked for the webhook. Try again in a minute.');
    }
    if (info.url === TELEGRAM_WEBHOOK_URL && deps.webhookWatch !== undefined) {
      try {
        await deps.webhookWatch.clear();
      } catch {
        logFailure('watch');
      }
    }
    console.log(JSON.stringify({ event: 'admin_action', action: 'telegram_webhook', target: set ? 'set' : 'not_set' }));
    return json<TelegramWebhookAdminResponse>(
      { url: info.url, pendingUpdateCount: info.pendingUpdateCount, lastErrorMessage: info.lastErrorMessage },
      200,
      'private',
    );
  });

  routes.get('/admin/telegram/webhook', async (c) => {
    await adminOr404(c.req.raw);
    const movedAt = deps.webhookWatch === undefined ? null : await deps.webhookWatch.movedAt();
    return json<TelegramWebhookState>({ moved: movedAt !== null, movedAt }, 200, 'private');
  });
}
