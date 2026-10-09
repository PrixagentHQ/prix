/**
 * Turns a grid of characters and tones into the markup of an avatar: one text block, a line
 * per row. Tone 2, the middle one, is the colour of the block itself and needs no element; a run
 * of another tone is wrapped in `<t-0>`, `<t-1>`, `<t-3>` or `<t-4>`, inline elements the styles
 * colour (ascii.css). Spaces carry no ink and join whatever run they sit in. Short names because
 * a board prints a hundred of these: each tag is a third of the bytes of a span with a class.
 *
 * The characters are those of RAMP in paint.ts and none of them needs escaping; the markup is
 * still escaped, so a change to the ramp can never write HTML. avatar.ts writes the same markup
 * from a plate, byte by byte.
 */
import type { Tone } from './paint.ts';

export interface Grid {
  readonly lines: readonly string[];
  readonly cells: readonly (readonly { readonly char: string; readonly tone: Tone }[])[];
}

/** The tone of the block itself: a run of it is written bare. */
export const BARE_TONE = 2;

const ESCAPE: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => ESCAPE[character] ?? character);
}

/** The inner markup of `.ascii-grid`: rows joined by newlines, runs of tones other than 2 wrapped in `t-N`. */
export function gridMarkup(grid: Grid): string {
  const rows: string[] = [];
  for (const row of grid.cells) {
    let out = '';
    let tone: number = BARE_TONE;
    let pending = '';
    for (const cell of row) {
      if (cell.char === ' ') {
        pending += ' ';
        continue;
      }
      if (cell.tone !== tone) {
        if (tone !== BARE_TONE) out += `</t-${tone}>`;
        out += pending;
        if (cell.tone !== BARE_TONE) out += `<t-${cell.tone}>`;
        tone = cell.tone;
      } else out += pending;
      pending = '';
      out += escapeHtml(cell.char);
    }
    if (tone !== BARE_TONE) out += `</t-${tone}>`;
    // Spaces at the end of a row are left out: the block is left-aligned in a box of fixed size.
    rows.push(out);
  }
  return rows.join('\n');
}
