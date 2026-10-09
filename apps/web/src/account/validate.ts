import {
  AGENT_NAME_MAX,
  AGENT_NAME_MIN,
  API_KEY_MAX,
  API_KEY_MIN,
  MODEL_NAME_MAX,
  PROMPT_MAX,
  PROMPT_MAX_BYTES,
  PROMPT_MIN,
  RESERVED_AGENT_NAMES,
} from '@prix/contracts/constants';
import { fill } from './dom.ts';

/**
 * The checks a form makes before it sends anything, in plain code that follows the contract's
 * constants and rules. They only save the person a round trip: the API checks every request
 * again with its own schemas and decides. Nothing here imports a schema, so a page does not
 * load the schema library.
 *
 * Each returns null for a value that passes, a sentence for one that does not, or an empty
 * string when the page already says what is wrong beside the field.
 */

const nameKey = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '');
const RESERVED = new Set(RESERVED_AGENT_NAMES.map(nameKey));
const RESERVED_FRAGMENTS = ['official', 'admin', 'moderator', 'support', 'staff'];

function isReserved(name: string): boolean {
  const key = nameKey(name);
  return RESERVED.has(key) || key.startsWith('prix') || RESERVED_FRAGMENTS.some((part) => key.includes(part));
}

/** The first rule a name breaks beyond its length and reserved words, as a sentence, or null. */
function nameIssue(name: string): string | null {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9 ._-]*[A-Za-z0-9])?$/.test(name)) {
    return 'Use letters, digits, spaces, dots, underscores and hyphens.';
  }
  if (/ {2}/.test(name)) return 'Use single spaces.';
  if (nameKey(name).length < AGENT_NAME_MIN) return 'Use at least three letters or digits.';
  return null;
}

/** The first rule a prompt breaks beyond its length, as a sentence, or null. */
function promptIssue(prompt: string): string | null {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(prompt)) return 'Remove control characters.';
  if (/[‪-‮⁦-⁩]/.test(prompt)) return 'Remove text-direction characters.';
  if (new TextEncoder().encode(prompt).length > PROMPT_MAX_BYTES) return 'That prompt is too long.';
  return null;
}

/** A model name as the provider spells it: no `//` and no `..`. */
function modelOk(model: string): boolean {
  return (
    model.length >= 1 &&
    model.length <= MODEL_NAME_MAX &&
    /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(model) &&
    !model.includes('//') &&
    !model.includes('..')
  );
}

export function checkName(name: string, words: Record<string, string>): string | null {
  if (name.length < AGENT_NAME_MIN) return words.nameShort ?? '';
  if (name.length > AGENT_NAME_MAX) return words.nameLong ?? '';
  if (isReserved(name)) return words.nameReserved ?? '';
  const issue = nameIssue(name);
  return issue === null ? null : fill(words.nameRejected ?? '', { message: issue });
}

export function checkPrompt(prompt: string, words: Record<string, string>): string | null {
  if (prompt.length < PROMPT_MIN) return words.promptShort ?? '';
  // Past the limit the field's running count already says so, with the number to cut.
  if (prompt.length > PROMPT_MAX) return '';
  const issue = promptIssue(prompt);
  return issue === null ? null : fill(words.promptRejected ?? '', { message: issue });
}

export function checkModel(model: string, words: Record<string, string>): string | null {
  if (model === '') return words.modelMissing ?? '';
  return modelOk(model) ? null : (words.modelRejected ?? '');
}

/** The ids the API issues: twelve characters of a to z and 2 to 7. */
export function idOk(id: string): boolean {
  return /^[a-z2-7]{12}$/.test(id);
}

/** A key gets the page's own sentences only: nothing here may repeat any part of what was typed. */
export function checkKey(apiKey: string, words: Record<string, string>): string | null {
  if (apiKey.length < API_KEY_MIN) return words.keyShort ?? '';
  if (apiKey.length > API_KEY_MAX) return words.keyLong ?? '';
  return /^[\x21-\x7e]+$/.test(apiKey) ? null : (words.keyRejected ?? '');
}
