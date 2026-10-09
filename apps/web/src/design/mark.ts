/**
 * The mark of an agent: its initials in white on a solid square of one of eight grounds, as in
 * the approved study. The ground is drawn from the agent's id, so one agent always has the same
 * colour on every page and in every season; the initials come from its name (`markInitials`).
 *
 * The eight grounds sit where no colour has a job (docs/DESIGN.md section 2): olive and ochre
 * between the bronze and the green, teal and petrol between the green and the blue, violet
 * (the one purple) and rose between the blue and the red, umber under the bronze, and slate, a
 * neutral. Their order is fixed; over many ids each takes an eighth of the agents. The ground
 * is also the accent of the agent's card.
 *
 * `bars` is the drawing of the retired mark (five bars). It stays in the result for a script
 * that still reads it and is no longer drawn by AgentMark.
 */

export const MARK_HUES = ['olive', 'teal', 'petrol', 'violet', 'rose', 'umber', 'slate', 'ochre'] as const;
export type MarkHue = (typeof MARK_HUES)[number];

/** The view box of a mark, and the grid its bars stand on. */
export const MARK = { size: 40, bar: 4, gap: 3, row: 2.5, rows: 12, left: 4, top: 5 } as const;

export interface MarkBar {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AgentMarkShape<H extends string = MarkHue> {
  hue: H;
  bars: MarkBar[];
}

/** FNV-1a over the characters of the id, then one round of mixing per number that is drawn. */
function seed(id: string): number {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function generator(start: number): () => number {
  let state = start;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The mark of the agent with this id. `hues` is the list of grounds to draw from; the site
 * always uses MARK_HUES, and the specimen passes the retired list to show the two side by side.
 * The ground takes the first number drawn and the bars the next six, so a list of another
 * length changes the ground and never the bars.
 */
export function agentMark<H extends string = MarkHue>(
  id: string,
  hues: readonly H[] = MARK_HUES as unknown as readonly H[],
): AgentMarkShape<H> {
  const next = generator(seed(id));
  const pick = (count: number): number => Math.min(count - 1, Math.floor(next() * count));
  const hue = hues[pick(hues.length)] ?? (hues[hues.length - 1] as H);
  // The outer bar, the inner bar, the middle bar. Each: the level it stands on, and its height in rows.
  const free = [0, 1, 2].map(() => ({ foot: pick(5), rows: 4 + pick(5) }));
  const bars = [0, 1, 2, 1, 0].map((which, column) => {
    const bar = free[which] ?? { foot: 0, rows: 4 };
    const height = bar.rows * MARK.row;
    return {
      x: MARK.left + column * (MARK.bar + MARK.gap),
      y: MARK.top + (MARK.rows - bar.foot - bar.rows) * MARK.row,
      width: MARK.bar,
      height,
    };
  });
  return { hue, bars };
}

/**
 * The initials of an agent's mark: the first letter or digit of each of the first two words of
 * its name, in capitals ("Dip Buyer 9000" gives DB, "T-Bill Tortoise" gives TB, "Momentum"
 * gives M). Words are split at spaces and hyphens; a word with no letter or digit is skipped.
 * An empty name gives an empty string, and the mark is then its ground alone.
 */
export function markInitials(name: string): string {
  return name
    .split(/[\s-]+/)
    .map((word) => Array.from(word.normalize('NFC')).find((character) => /[\p{L}\p{N}]/u.test(character)))
    .filter((first): first is string => first !== undefined)
    .slice(0, 2)
    .join('')
    .toLocaleUpperCase('en');
}
