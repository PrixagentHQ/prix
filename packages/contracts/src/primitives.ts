import { z } from './zod.ts';

/** A wallet or contract address: 0x followed by 40 lower-case hex characters. */
export const addressSchema = z.string().regex(/^0x[0-9a-f]{40}$/, 'Expected a lower-case 0x address.');
export type Address = z.infer<typeof addressSchema>;

/**
 * A UTC instant exactly as `Date.prototype.toISOString()` writes it: 2026-10-06T15:00:00.000Z.
 * Every timestamp is written that way, so text order is time order.
 */
export const isoTimeSchema = z.iso.datetime({ precision: 3 });
export type IsoTime = string;

/** A UTC calendar day, for example 2026-10-06. */
export const utcDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export type UtcDay = string;

/** A symbol from the universe, for example NVDA. */
export const symbolSchema = z.string().regex(/^[A-Z][A-Z0-9.]{0,9}$/);
export type TokenSymbol = string;

/** A non-negative safe integer: micro-USD, micro-shares, basis points or a count. */
export const amountSchema = z.number().int().nonnegative();

/** A safe integer that may be negative, for example a return in basis points. */
export const signedAmountSchema = z.number().int();

export const divisionSchema = z.enum(['open', 'pro']);
export type Division = z.infer<typeof divisionSchema>;

/** Agent, model-key and season ids are 12 characters of lower-case base32. */
export const idSchema = z.string().regex(/^[a-z2-7]{12}$/);
export type AgentId = string;
export type ModelKeyId = string;
export type SeasonId = string;

/** A tick id names the UTC hour it belongs to: 2026-10-06T15:00Z. Tick ids sort in time order. */
export const tickIdSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:00Z$/);
export type TickId = string;

/** The id of the tick for the UTC hour that contains `date`. */
export function tickIdFor(date: Date): TickId {
  return `${date.toISOString().slice(0, 13)}:00Z`;
}

/** The instant at which a tick's hour starts. */
export function tickStart(tickId: TickId): Date {
  return new Date(`${tickId.slice(0, 16)}:00.000Z`);
}

/** The UTC day a tick belongs to. */
export function utcDayOfTick(tickId: TickId): UtcDay {
  return tickId.slice(0, 10);
}

/** The UTC hour of a tick, 0 to 23. */
export function utcHourOfTick(tickId: TickId): number {
  return Number.parseInt(tickId.slice(11, 13), 10);
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/**
 * A new random id. Uses the Web Crypto API, which exists in Workers, Node and browsers.
 * It is reached through `globalThis` with a local type, so this file type-checks under
 * every lib setting (Workers runtime types, DOM, or neither) without redeclaring a global.
 */
export function newId(): string {
  const bytes = new Uint8Array(12);
  const webCrypto = (globalThis as unknown as { crypto: { getRandomValues(array: Uint8Array): Uint8Array } }).crypto;
  webCrypto.getRandomValues(bytes);
  let id = '';
  for (const byte of bytes) id += BASE32[byte % 32];
  return id;
}
