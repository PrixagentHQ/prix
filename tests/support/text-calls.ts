/**
 * Finds every `text(` call in a source file and checks it against the rules of
 * docs/CONTRACTS.md section 8. It is a small scanner, not a parser: it reads the first two
 * arguments of each call and insists that they are plain string literals, which is exactly
 * what the contract demands of them.
 */

import { ADVICE_WORDS, SOCIAL_FORBIDDEN_WORDS } from '@prix/contracts';

export const AREAS = [
  'common',
  'nav',
  'states',
  'errors',
  'methodology',
  'legal',
  'landing',
  'share',
  'league',
  'agent',
  'signIn',
  'builder',
  'account',
  'modelKey',
  'admin',
  'reputation',
  'follow',
  'token',
  'data',
  'social',
  // Prix Live's keys (Prix Live is not part of this copy).
  'live',
  // The holders' poll, /polls (docs/contracts/phase-6-holders.md, deck-holders.ts).
  'polls',
  // The holders' second wave (Phase 6.8, docs/contracts/phase-6-holders-2.md section 7): the lounge block on
  // /following and the decision tape, /tape.
  'lounge',
  'tape',
] as const;

const KEY_PATTERN = new RegExp(`^(?:${AREAS.join('|')})\\.[a-z][A-Za-z0-9]*$`);

export interface TextCall {
  file: string;
  line: number;
  /** Null when the first argument is not a string literal. */
  key: string | null;
  /** Null when the second argument is not a string literal. */
  draft: string | null;
  /** The source of the call up to the end of its second argument, for messages. */
  source: string;
}

export interface Violation {
  file: string;
  line: number;
  rule: string;
  detail: string;
}

interface Literal {
  value: string;
  end: number;
}

function skipSpace(source: string, from: number): number {
  let index = from;
  for (;;) {
    while (index < source.length && /\s/.test(source[index] as string)) index += 1;
    if (source.startsWith('//', index)) {
      const end = source.indexOf('\n', index);
      index = end === -1 ? source.length : end + 1;
    } else if (source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index);
      index = end === -1 ? source.length : end + 2;
    } else {
      return index;
    }
  }
}

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0' };

/** Reads a string literal that starts at `from`. A template literal with `${` is not one. */
function readLiteral(source: string, from: number): Literal | null {
  const quote = source[from];
  if (quote !== "'" && quote !== '"' && quote !== '`') return null;
  let value = '';
  let index = from + 1;
  while (index < source.length) {
    const char = source[index] as string;
    if (char === quote) return { value, end: index + 1 };
    if (quote === '`' && char === '$' && source[index + 1] === '{') return null;
    if (quote !== '`' && char === '\n') return null;
    if (char === '\\') {
      const next = source[index + 1] as string;
      if (next === 'u') {
        const braced = /^\{([0-9a-fA-F]+)\}/.exec(source.slice(index + 2));
        if (braced) {
          value += String.fromCodePoint(Number.parseInt(braced[1] as string, 16));
          index += 2 + braced[0].length;
        } else {
          value += String.fromCharCode(Number.parseInt(source.slice(index + 2, index + 6), 16));
          index += 6;
        }
      } else if (next === 'x') {
        value += String.fromCharCode(Number.parseInt(source.slice(index + 2, index + 4), 16));
        index += 4;
      } else if (next === '\n') {
        index += 2;
      } else {
        value += ESCAPES[next] ?? next;
        index += 2;
      }
      continue;
    }
    value += char;
    index += 1;
  }
  return null;
}

function isCommentedOut(source: string, at: number): boolean {
  const lineStart = source.lastIndexOf('\n', at - 1) + 1;
  const prefix = source.slice(lineStart, at);
  if (/^\s*(\/\/|\*|\/\*)/.test(prefix)) return true;
  // A line comment that starts after code on the same line, outside any string.
  const withoutStrings = prefix.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, '');
  if (/(^|[^:])\/\//.test(withoutStrings)) return true;
  // An HTML comment in the template part of an Astro file.
  const open = source.lastIndexOf('<!--', at);
  return open !== -1 && source.indexOf('-->', open) > at;
}

/** Every call of the function `text` in a source, in order. The definition of `text` is not a call. */
export function findTextCalls(file: string, source: string): TextCall[] {
  const calls: TextCall[] = [];
  const pattern = /(?<![\w$.])text\s*\(/g;
  for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
    const before = source.slice(Math.max(0, match.index - 12), match.index);
    if (/function\s+$/.test(before)) continue;
    if (isCommentedOut(source, match.index)) continue;

    const line = source.slice(0, match.index).split('\n').length;
    let index = skipSpace(source, match.index + match[0].length);
    const key = readLiteral(source, index);
    let draft: Literal | null = null;
    if (key) {
      index = skipSpace(source, key.end);
      if (source[index] === ',') {
        index = skipSpace(source, index + 1);
        draft = readLiteral(source, index);
        if (draft) {
          // The draft must be the whole second argument: no concatenation, no call on it.
          const after = source[skipSpace(source, draft.end)];
          if (after !== ',' && after !== ')') draft = null;
        }
      }
    }
    const end = draft?.end ?? key?.end ?? match.index + match[0].length + 40;
    calls.push({
      file,
      line,
      key: key ? key.value : null,
      draft: draft ? draft.value : null,
      source: source.slice(match.index, end).replace(/\s+/g, ' '),
    });
  }
  return calls;
}

/** True if a file imports `text` under another name, which would hide its calls from this scanner. */
export function renamesText(source: string): boolean {
  // Only code counts: "the bytes of a text as 0x and hex" in a comment is not a renaming.
  const code = source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
  return /\btext\s+as\s+[\w$]+/.test(code) || /\b(?:const|let|var)\s+[\w$]+\s*=\s*text\s*[;\n]/.test(code);
}

/**
 * The slots of a string: a name in braces. "Safe{Wallet}" is the name of Safe's own app as Safe writes it, and
 * no slot: nothing fills it, and it is shown as it is. That one name only: any other word in braces after
 * "Safe" is a slot, and so is {Wallet} after any other word.
 */
export function slotsOf(template: string): string[] {
  return [...template.matchAll(/(?<!\bSafe(?=\{Wallet\}))\{(\w+)\}/g)].map((match) => match[1] as string);
}

/** Markup or a line break in a string that must be plain text. */
export function plainTextProblem(value: string): string | null {
  if (/[\n\r]/.test(value)) return 'contains a line break';
  if (/<\/?[A-Za-z][^>]*>/.test(value)) return 'contains markup';
  if (/&(?:[a-z]+|#\d+);/i.test(value)) return 'contains an HTML entity';
  return null;
}

const PLACEHOLDER = /\b(?:lorem|ipsum|todo|tbd|placeholder|fixme|xxx+|foo|bar baz)\b/i;

/** The words of section 8 that name regulated things and must not describe the product. */
export function forbiddenWording(value: string): string | null {
  if (/fact\s?sheet/i.test(value)) return 'calls a page a fact sheet';
  if (/\bprix\b[^.!?]{0,60}\bexchange\b/i.test(value) || /\bexchange for (?:ai|trading) agents\b/i.test(value)) {
    return 'calls Prix an exchange';
  }
  return null;
}

/** True for a key of the Phase 6 copy area. */
export function isSocialKey(key: string): boolean {
  return key.startsWith('social.');
}

/**
 * Words that no Phase 6 copy uses (docs/contracts/phase-6-social.md sections 5.3 and 5.5): the words of
 * betting and of ranking one model or one manager above the others (SOCIAL_FORBIDDEN_WORDS), the words of
 * advice (ADVICE_WORDS), and the words of a fund (an ETF, a NAV, to subscribe, to invest in).
 */
export function socialWording(value: string): string | null {
  const forbidden = SOCIAL_FORBIDDEN_WORDS.exec(value);
  if (forbidden) return `uses the word "${forbidden[0]}", which Phase 6 copy never uses`;
  const advice = ADVICE_WORDS.exec(value);
  if (advice) return `uses the word "${advice[0]}", which reads as advice`;
  const fund = /\b(etf|etfs|nav|subscribe|subscribing|subscription|invest(?:ing|ment|ments)?\s+in)\b/i.exec(value);
  if (fund) return `uses "${fund[0]}", the language of a fund, for a paper simulation`;
  return null;
}

export interface CheckOptions {
  deck: Readonly<Record<string, string>>;
  /** At the gate, a key that is in use must have its final string in the deck. */
  gate: boolean;
}

export function checkTextCalls(calls: readonly TextCall[], options: CheckOptions): Violation[] {
  const violations: Violation[] = [];
  const add = (call: TextCall, rule: string, detail: string) =>
    violations.push({ file: call.file, line: call.line, rule, detail });
  const drafts = new Map<string, TextCall>();

  for (const call of calls) {
    if (call.key === null) {
      add(call, 'key-literal', `the key is not a string literal: ${call.source}`);
      continue;
    }
    if (!KEY_PATTERN.test(call.key)) {
      add(call, 'key-area', `"${call.key}" is not an area, a dot and a name in camelCase`);
    }
    if (call.draft === null) {
      add(call, 'draft-literal', `the draft of "${call.key}" is not a string literal: ${call.source}`);
      continue;
    }
    if (call.draft.trim().length === 0) add(call, 'draft-empty', `the draft of "${call.key}" is empty`);
    if (PLACEHOLDER.test(call.draft))
      add(call, 'draft-placeholder', `the draft of "${call.key}" is placeholder text: "${call.draft}"`);
    const plain = plainTextProblem(call.draft);
    if (plain) add(call, 'draft-plain-text', `the draft of "${call.key}" ${plain}`);
    const wording = forbiddenWording(call.draft) ?? (isSocialKey(call.key) ? socialWording(call.draft) : null);
    if (wording) add(call, 'draft-wording', `the draft of "${call.key}" ${wording}`);

    const first = drafts.get(call.key);
    if (first === undefined) {
      drafts.set(call.key, call);
    } else if (first.draft !== call.draft) {
      add(
        call,
        'draft-conflict',
        `"${call.key}" has another draft at ${first.file}:${first.line}: "${first.draft}" and "${call.draft}"`,
      );
    }

    const final = options.deck[call.key];
    if (final === undefined) {
      if (options.gate) add(call, 'deck-missing', `"${call.key}" is in use and has no entry in the deck`);
    } else {
      const known = new Set(slotsOf(call.draft));
      for (const slot of slotsOf(final)) {
        if (!known.has(slot))
          add(call, 'deck-slot', `the deck string of "${call.key}" has the slot {${slot}} and the draft does not`);
      }
    }
  }

  // Where a count changes the sentence, the two keys end in One and Other. A key that merely ends in
  // "Other", such as a fallback sentence for any other code, is not a plural: only a draft with a
  // {count} slot, or a key ending in "One", asks for a partner.
  const keys = new Set([...drafts.keys(), ...Object.keys(options.deck)]);
  for (const [key, call] of drafts) {
    const plural = /^(.*)(One|Other)$/.exec(key);
    if (!plural) continue;
    if (plural[2] === 'Other' && !slotsOf(call.draft ?? '').includes('count') && !keys.has(`${plural[1]}One`)) continue;
    const partner = `${plural[1]}${plural[2] === 'One' ? 'Other' : 'One'}`;
    // The holders' contract names its pairs `<base>` and `<base>One` (polls.castCount, polls.castCountOne):
    // a One key whose bare base is a key is paired too.
    if (plural[2] === 'One' && keys.has(plural[1] ?? '')) continue;
    if (!keys.has(partner)) add(call, 'plural-pair', `"${key}" has no partner "${partner}"`);
  }
  return violations;
}

/** The checks on the deck itself: every entry is a valid key with a plain, final string. */
export function checkDeck(deck: Readonly<Record<string, string>>): Violation[] {
  const violations: Violation[] = [];
  const add = (key: string, rule: string, detail: string) =>
    violations.push({ file: 'apps/web/src/content/deck.ts', line: 0, rule, detail: `"${key}" ${detail}` });
  for (const [key, value] of Object.entries(deck)) {
    if (!KEY_PATTERN.test(key)) add(key, 'key-area', 'is not an area, a dot and a name in camelCase');
    if (typeof value !== 'string' || value.trim().length === 0) {
      add(key, 'deck-empty', 'has no string');
      continue;
    }
    const plain = plainTextProblem(value);
    if (plain) add(key, 'deck-plain-text', plain);
    if (PLACEHOLDER.test(value)) add(key, 'deck-placeholder', `is placeholder text: "${value}"`);
    const wording = forbiddenWording(value) ?? (isSocialKey(key) ? socialWording(value) : null);
    if (wording) add(key, 'deck-wording', wording);
    if (value !== value.trim()) add(key, 'deck-whitespace', 'starts or ends with whitespace');
  }
  return violations;
}
