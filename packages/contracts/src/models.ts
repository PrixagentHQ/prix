import { API_KEY_MAX, API_KEY_MIN, MODEL_NAME_MAX } from './constants.ts';
import { addressSchema, idSchema, isoTimeSchema } from './primitives.ts';
import { z } from './zod.ts';

/**
 * The providers an owner may bring a key for. This list is the allowlist: there is no
 * other way to name a provider, and no input anywhere accepts a base URL.
 * `packages/runtime` holds the base URL of each id, with the source it was read from.
 */
export const PROVIDERS = [
  { id: 'openai', label: 'OpenAI' },
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'google', label: 'Google' },
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'groq', label: 'Groq' },
  { id: 'xai', label: 'xAI' },
] as const;

export const providerIdSchema = z.enum(['openai', 'anthropic', 'google', 'openrouter', 'groq', 'xai']);
export type ProviderId = z.infer<typeof providerIdSchema>;

/**
 * A model name as the provider spells it. It travels in a JSON body, never in a URL.
 * A name may hold a slash or a colon (`vendor/model:variant`), but nothing shaped like an
 * address or a path that climbs: no `//` and no `..`.
 */
export const modelNameSchema = z
  .string()
  .min(1)
  .max(MODEL_NAME_MAX)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/, 'Use the model name exactly as the provider spells it.')
  .refine(
    (name) => !name.includes('//') && !name.includes('..'),
    'Use the model name exactly as the provider spells it.',
  );

/** POST /api/model-keys. The only request that ever carries a key. */
export const createModelKeyInputSchema = z.strictObject({
  provider: providerIdSchema,
  model: modelNameSchema,
  apiKey: z
    .string()
    .min(API_KEY_MIN)
    .max(API_KEY_MAX)
    .regex(/^[\x21-\x7e]+$/, 'A key has no spaces and no special characters outside ASCII.'),
});
export type CreateModelKeyInput = z.infer<typeof createModelKeyInputSchema>;

/** What any response may say about a stored key. Nothing here can rebuild the key. */
export const modelKeyPublicSchema = z.strictObject({
  id: idSchema,
  provider: providerIdSchema,
  model: modelNameSchema,
  last4: z.string().length(4),
  createdAt: isoTimeSchema,
});
export type ModelKeyPublic = z.infer<typeof modelKeyPublicSchema>;

/** A key as it is stored: AES-GCM ciphertext, never the key itself. */
export const modelKeyRecordSchema = z.strictObject({
  id: idSchema,
  owner: addressSchema,
  provider: providerIdSchema,
  model: modelNameSchema,
  last4: z.string().length(4),
  /** Base64 of the AES-256-GCM ciphertext with its authentication tag. */
  ciphertext: z.string(),
  /** Base64 of the 12-byte nonce. A fresh one for every encryption. */
  iv: z.string(),
  /** Which encryption secret sealed this key, so the secret can be rotated. */
  keyVersion: z.number().int().positive(),
  createdAt: isoTimeSchema,
});
export type ModelKeyRecord = z.infer<typeof modelKeyRecordSchema>;

/** The text that is bound to a ciphertext as additional authenticated data. */
export function modelKeyAad(record: { id: string; owner: string; provider: string; keyVersion: number }): string {
  // The provider is part of it, so a row whose provider is changed cannot send the key to another company.
  return `${record.id}:${record.owner}:${record.provider}:${record.keyVersion}`;
}

/** Sealing a key. The API gets only this half. */
export interface KeySealer {
  /** The key version this sealer writes. The caller needs it to build the AAD before it seals. */
  readonly keyVersion: number;
  seal(apiKey: string, aad: string): Promise<{ ciphertext: string; iv: string; keyVersion: number }>;
}

/** Opening a key. Only the runtime gets this half, and it opens a key at the moment of use. */
export interface KeyOpener {
  /** Null when the record cannot be opened: wrong secret, wrong AAD or damaged data. */
  open(
    record: Pick<ModelKeyRecord, 'id' | 'owner' | 'provider' | 'ciphertext' | 'iv' | 'keyVersion'>,
  ): Promise<string | null>;
}

export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

export interface ModelRequest {
  messages: ChatMessage[];
  maxOutputTokens: number;
  timeoutMs: number;
  /** True when the caller wants the decision JSON shape enforced by the provider, where it can be. */
  jsonDecision: boolean;
}

/** `provider_rejected` is HTTP 401, 403 or 404: the key or the model name is wrong. */
export type ModelFailureCode = 'provider_rejected' | 'provider_error' | 'provider_timeout' | 'allocation_exhausted';

export type ModelResponse =
  | {
      ok: true;
      text: string;
      inputTokens: number | null;
      outputTokens: number | null;
      /**
       * What the call cost in Workers AI neurons, when the provider reports it (`usage.neurons`).
       * The scheduler charges this exact figure and falls back to tokens times the configured
       * prices when it is absent.
       */
      neurons?: number | null;
    }
  | { ok: false; code: ModelFailureCode; httpStatus: number | null };

/**
 * One model behind one interface: the house model on Workers AI, or an owner's model.
 * `complete` never throws, and a failure carries a code and a status only: never the
 * provider's message, which can echo part of a key.
 */
export interface ModelPort {
  /** A label for records, for example "house" or "openai:gpt-x". Never contains a key. */
  readonly label: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
}
