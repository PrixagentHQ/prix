/**
 * What a reason adds to the title of a FeedRow (docs/DESIGN.md section 12.2, FeedRow).
 *
 * A model often opens its reason with the words of the row's title: the title says "Kept the
 * paper portfolio as it was" and the reason "Kept the paper portfolio as it was; no target
 * changed." Printed as they are, the row says one sentence twice. This keeps what follows the
 * title's words, with its first letter raised ("No target changed."), and gives an empty string
 * when the reason only repeats the title. A reason that does not open with the title's words
 * (whole words, any case) is kept as it is, and so is any reason under an empty title (the
 * template row a script fills).
 *
 * Pure and safe in the browser: a script that fills a row may call it with the same words.
 */
export function reasonBeyond(title: string, reason: string): string {
  const words = title
    .trim()
    .split(/\s+/u)
    .filter((word) => word !== '');
  if (words.length === 0) return reason;
  const escaped = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'));
  const opening = new RegExp(`^\\s*${escaped.join('\\s+')}(?![\\p{L}\\p{N}'’])`, 'iu');
  const match = opening.exec(reason);
  if (match === null) return reason;
  const rest = reason
    .slice(match[0].length)
    .replace(/^[\s\p{P}]+/u, '')
    .trimEnd();
  if (rest.replace(/[\s\p{P}]+/gu, '') === '') return '';
  return rest.charAt(0).toLocaleUpperCase('en') + rest.slice(1);
}
