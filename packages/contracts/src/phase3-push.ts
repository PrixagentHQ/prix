import { z } from 'zod';
import type { ApiDeps } from './api.ts';

// Browser push for the follow notes. A subscription is the address of a push service that a
// browser gave the page. The address is untrusted input: the Worker fetches it, so only the hosts
// below are ever fetched. A push carries no body: nothing about a person or an agent travels in it.

/** The push services the Worker will talk to: exact hosts, and one suffix. */
export const PUSH_ALLOWED_HOSTS: readonly string[] = [
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'web.push.apple.com',
];
export const PUSH_ALLOWED_HOST_SUFFIXES: readonly string[] = ['.notify.windows.com'];

export const PUSH_ENDPOINT_MAX_CHARS = 1000;
/** A sixth subscription of a wallet replaces its oldest. */
export const MAX_PUSH_SUBSCRIPTIONS_PER_WALLET = 5;
/** The TTL header of a push, in seconds. */
export const PUSH_TTL_SECONDS = 3600;
/** The lifetime of a VAPID token, and how long before its end the sender makes a new one. */
export const VAPID_TOKEN_LIFETIME_SECONDS = 12 * 60 * 60;
export const VAPID_TOKEN_REFRESH_SECONDS = 60 * 60;
export const VAPID_SUBJECT = 'mailto:support@prixagent.com';
export const PUSH_TIMEOUT_MS = 5000;
export const PUSH_MAX_RESPONSE_BYTES = 1024;

/** True for an https address, with no credentials and no port, on an allowed push service. */
export function isAllowedPushEndpoint(value: string): boolean {
  if (value.length === 0 || value.length > PUSH_ENDPOINT_MAX_CHARS) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.username !== '' || url.password !== '' || url.port !== '') return false;
  // `new URL` lower-cases the host. A trailing dot is a different name and is not allowed.
  const host = url.hostname;
  if (PUSH_ALLOWED_HOSTS.includes(host)) return true;
  return PUSH_ALLOWED_HOST_SUFFIXES.some((suffix) => host.length > suffix.length && host.endsWith(suffix));
}

export const pushEndpointSchema = z
  .string()
  .max(PUSH_ENDPOINT_MAX_CHARS)
  .refine(isAllowedPushEndpoint, { message: 'The address is not one of an allowed push service.' });

/** The body of POST and DELETE /api/push/subscriptions. */
export const pushSubscriptionInputSchema = z.object({ endpoint: pushEndpointSchema }).strict();
export type PushSubscriptionInput = z.infer<typeof pushSubscriptionInputSchema>;

export interface PushSubscriptionRow {
  /** SHA-256 of the endpoint, in hex. */
  id: string;
  address: string;
  endpoint: string;
  createdAt: string;
  lastPushedAt: string | null;
}

/** The store of `apps/api/src/store/push.ts`. Every method is one D1 statement or one batch. */
export interface PushStore {
  /** Adds a subscription (or moves an existing one to this wallet) and drops the wallet's oldest beyond the limit. */
  addSubscription(address: string, endpoint: string, now: string, max: number): Promise<void>;
  /** Removes one subscription of this wallet. */
  removeSubscription(address: string, endpoint: string): Promise<void>;
  listSubscriptions(address: string): Promise<PushSubscriptionRow[]>;
  /** Removes by endpoint, whoever owns it: the push service said it is gone. */
  removeByEndpoint(endpoint: string): Promise<void>;
  markAccepted(endpoint: string, now: string): Promise<void>;
}

export interface PushApiDeps extends ApiDeps {
  push: PushStore;
  /** The public VAPID key (raw point, base64url), or null when push is not configured. */
  vapidPublicKey: string | null;
}

/** What the deliver step uses. `requests` counts the subrequests and D1 statements it started. */
export interface PushSender {
  /**
   * Pushes to every subscription of the wallet, using at most `budget` requests and statements.
   * `kept` counts the subscriptions that were not accepted and not removed: the next note tries them again.
   * Never throws.
   */
  pushTo(address: string, budget: number): Promise<{ delivered: number; kept: number; requests: number }>;
}
