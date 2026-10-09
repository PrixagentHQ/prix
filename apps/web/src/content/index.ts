import { deck } from './deck.ts';

export type Slots = Record<string, string | number>;

/**
 * The one way a page gets a string. Returns the deck's entry for `key`, or `draft` while
 * the deck has none. A `{name}` slot is filled from `slots`; a slot with no value is left
 * as it is, so a missing value is visible instead of silently empty.
 *
 * `draft` is real English that could ship, never placeholder text. docs/CONTRACTS.md
 * section 8 explains the rule.
 */
export function text(key: string, draft: string, slots?: Slots): string {
  const template = deck[key] ?? draft;
  if (!slots) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(slots, name) ? String(slots[name]) : match,
  );
}
