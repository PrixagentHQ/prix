import { z } from 'zod';
import {
  AGENT_NAME_MAX,
  AGENT_NAME_MIN,
  PROMPT_MAX,
  PROMPT_MAX_BYTES,
  PROMPT_MIN,
  RESERVED_AGENT_NAMES,
  SUMMARY_MAX,
} from './constants.ts';
import { addressSchema, amountSchema, divisionSchema, idSchema, isoTimeSchema, utcDaySchema } from './primitives.ts';

/**
 * The key that makes two agent names "the same": lower case, letters and digits only.
 * "Slow Compounder", "slow-compounder" and "SLOW.COMPOUNDER" share one key, so only one can exist.
 */
export function agentNameKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const RESERVED_KEYS = new Set(RESERVED_AGENT_NAMES.map(agentNameKey));
const RESERVED_FRAGMENTS = ['official', 'admin', 'moderator', 'support', 'staff'];

/** True for a name that would pass for the product, its staff or a partner. */
export function isReservedAgentName(name: string): boolean {
  const key = agentNameKey(name);
  if (RESERVED_KEYS.has(key) || key.startsWith('prix')) return true;
  return RESERVED_FRAGMENTS.some((fragment) => key.includes(fragment));
}

/** ASCII letters, digits, spaces, dots, underscores and hyphens. Starts and ends with a letter or digit. */
export const agentNameSchema = z
  .string()
  .min(AGENT_NAME_MIN)
  .max(AGENT_NAME_MAX)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9 ._-]*[A-Za-z0-9])?$/, 'Use letters, digits, spaces, dots, underscores and hyphens.')
  .refine((name) => !/ {2}/.test(name), 'Use single spaces.')
  .refine((name) => agentNameKey(name).length >= AGENT_NAME_MIN, 'Use at least three letters or digits.')
  .refine((name) => !isReservedAgentName(name), 'That name is reserved.');

/** A strategy prompt: plain text. Tabs and line breaks are allowed, other control characters are not. */
export const promptSchema = z
  .string()
  .min(PROMPT_MIN)
  .max(PROMPT_MAX)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  .refine((text) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(text), 'Remove control characters.')
  // Characters that reorder text on screen could make a published prompt read as something it is not.
  .refine((text) => !/[‪-‮⁦-⁩]/.test(text), 'Remove text-direction characters.')
  .refine((text) => new TextEncoder().encode(text).length <= PROMPT_MAX_BYTES, 'That prompt is too long.');

export const agentStatusSchema = z.enum(['active', 'paused']);
export type AgentStatus = z.infer<typeof agentStatusSchema>;

/**
 * `key_failing`: the provider refused the key or the model several rounds in a row.
 * `slot_limit`: the wallet holds fewer agent slots than it has agents (Phase 4).
 */
export const pausedReasonSchema = z.enum(['owner', 'key_removed', 'key_failing', 'admin', 'slot_limit']);
export type PausedReason = z.infer<typeof pausedReasonSchema>;

export const summaryStatusSchema = z.enum(['pending', 'ready', 'failed']);
export type SummaryStatus = z.infer<typeof summaryStatusSchema>;

/** An agent as it is stored. The prompt is private unless `promptPublic` is true. */
export const agentRecordSchema = z.strictObject({
  id: idSchema,
  owner: addressSchema,
  name: agentNameSchema,
  nameKey: z.string(),
  division: divisionSchema,
  prompt: promptSchema,
  promptPublic: z.boolean(),
  /** A short generated description of the strategy. Null until it has been generated. */
  summary: z.string().max(SUMMARY_MAX).nullable(),
  summaryStatus: summaryStatusSchema,
  /** The owner's model key. Set for Pro, null for Open. */
  modelKeyId: idSchema.nullable(),
  status: agentStatusSchema,
  pausedReason: pausedReasonSchema.nullable(),
  /** Set by an admin. A hidden agent is not shown anywhere public and does not trade. */
  hidden: z.boolean(),
  createdAt: isoTimeSchema,
  updatedAt: isoTimeSchema,
  /**
   * When the strategy last changed: set when the agent is created, when its prompt or model
   * key changes, and when it is resumed. A tick created before this instant does not use it.
   */
  strategyChangedAt: isoTimeSchema,
  /** The UTC day of the latest prompt change, and how many there were on that day. */
  promptChangeDay: utcDaySchema.nullable(),
  promptChangeCount: amountSchema,
});
export type AgentRecord = z.infer<typeof agentRecordSchema>;

/** The fields of an agent that can change after it is created. */
export interface AgentPatch {
  name?: string;
  nameKey?: string;
  prompt?: string;
  promptPublic?: boolean;
  summary?: string | null;
  summaryStatus?: SummaryStatus;
  modelKeyId?: string | null;
  status?: AgentStatus;
  pausedReason?: PausedReason | null;
  hidden?: boolean;
  strategyChangedAt?: string;
  promptChangeDay?: string | null;
  promptChangeCount?: number;
}

/** POST /api/agents */
export const createAgentInputSchema = z
  .strictObject({
    name: agentNameSchema,
    prompt: promptSchema,
    division: divisionSchema,
    /** Required for the Pro division. Not allowed for Open. */
    modelKeyId: idSchema.optional(),
  })
  .refine((input) => (input.division === 'pro') === (input.modelKeyId !== undefined), {
    message: 'A Pro agent needs a model key. An Open agent must not have one.',
    path: ['modelKeyId'],
  });
export type CreateAgentInput = z.infer<typeof createAgentInputSchema>;

/** PATCH /api/agents/:id. The division of an agent never changes. */
export const updateAgentInputSchema = z
  .strictObject({
    name: agentNameSchema.optional(),
    prompt: promptSchema.optional(),
    promptPublic: z.boolean().optional(),
    paused: z.boolean().optional(),
    modelKeyId: idSchema.optional(),
  })
  .refine((input) => Object.values(input).some((value) => value !== undefined), 'Send at least one field.');
export type UpdateAgentInput = z.infer<typeof updateAgentInputSchema>;
