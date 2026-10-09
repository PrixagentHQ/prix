// The ASCII animals are pure, fill their grids, keep the draw of the agent's mark, and stay
// cheap enough to draw on the server. Run: pnpm exec vitest run --root apps/web/src/design/ascii
import { describe, expect, it } from 'vitest';
import { agentMark } from '../mark.ts';
import { ASCII_HUES, asciiAnimal, CHOICES, character, GRIDS, SPECIES } from './animal.ts';
import { agentAvatar, markMarkup, printCharacter, stackCharacter } from './avatar.ts';
import { favicon, faviconSvg, MASCOTS, mascot } from './mascot.ts';
import { RAMP } from './paint.ts';
import { PLATE_DATA } from './plates.data.ts';
import { drawPlateData } from './plates-draw.ts';
import { MARK_PLATE_DATA } from './plates-mark.data.ts';
import { gridMarkup } from './render.ts';
import { ACCESSORIES, DRAW } from './species.ts';

const BRIEF = [
  '4nxdlbu3idgu',
  '2ynmb7yiulmp',
  'rqfkmxkfz72j',
  'adiz4yeo5ams',
  '3w6inochcjno',
  'vvdzsaur4iyn',
  'qfoocl4nen6j',
  'tgxiopdti5m2',
  '5oq63nmwh5kz',
  'slowcompound',
  'gammascoutaa',
  'macrotourist',
];

/** Ids shaped like the API's: twelve characters of a to z and 0 to 9. */
function ids(count: number): string[] {
  const out: string[] = [];
  let state = 7;
  for (let index = 0; index < count; index += 1) {
    let id = '';
    for (let char = 0; char < 12; char += 1) {
      state = (state * 1103515245 + 12345) % 2147483648;
      id += 'abcdefghijklmnopqrstuvwxyz0123456789'[state % 36];
    }
    out.push(id);
  }
  return out;
}

describe('asciiAnimal', () => {
  it('gives the same animal for the same id', () => {
    for (const id of BRIEF) {
      const first = character(id);
      expect(character(id)).toEqual(first);
      expect(asciiAnimal(id, 'small').lines).toEqual(asciiAnimal(id, 'small').lines);
    }
  });

  it('fills a grid of 20 by 16 and one of 40 by 32, in both prints', () => {
    for (const id of BRIEF) {
      for (const size of ['small', 'large'] as const) {
        const animal = asciiAnimal(id, size);
        const { cols, rows } = GRIDS[size];
        expect([animal.cols, animal.rows]).toEqual([cols, rows]);
        for (const grid of [animal, animal.print]) {
          expect(grid.lines).toHaveLength(rows);
          expect(grid.cells).toHaveLength(rows);
          for (const [row, line] of grid.lines.entries()) {
            expect(line).toHaveLength(cols);
            expect([...line].every((char) => RAMP.includes(char))).toBe(true);
            grid.cells[row]?.forEach((cell, col) => {
              expect(cell.char).toBe(line[col]);
              expect(cell.tone).toBeGreaterThanOrEqual(0);
              expect(cell.tone).toBeLessThanOrEqual(4);
              if (cell.char === ' ') expect(cell.tone).toBe(0);
            });
          }
          // A picture, not an empty box and not a solid block.
          const inked = grid.lines.join('').replace(/ /g, '').length;
          expect(inked).toBeGreaterThan(cols * rows * 0.25);
          expect(inked).toBeLessThan(cols * rows * 0.95);
        }
      }
    }
  });

  it('draws the hue first, as the agent mark does, so no agent changed animal when the hues went', () => {
    for (const id of [...BRIEF, ...ids(400)]) expect(asciiAnimal(id).hue).toBe(agentMark(id).hue);
    expect([...ASCII_HUES]).toEqual(['olive', 'teal', 'petrol', 'violet', 'rose', 'umber', 'slate', 'ochre']);
  });

  it('spreads the ids over the twelve species', () => {
    const counts = new Map<string, number>();
    for (const id of ids(2400)) counts.set(character(id).species, (counts.get(character(id).species) ?? 0) + 1);
    expect(counts.size).toBe(SPECIES.length);
    for (const count of counts.values()) {
      expect(count).toBeGreaterThan(130);
      expect(count).toBeLessThan(270);
    }
  });

  it('rarely gives two agents the same character', () => {
    const many = ids(1000);
    const keys = new Set(many.map((id) => JSON.stringify(character(id))));
    expect(keys.size).toBe(many.length);
    // Even the visible choices alone (species, hue, eyes, marking, accessory) seldom repeat.
    const visible = new Set(
      many.map((id) => {
        const who = character(id);
        return `${who.species} ${who.hue} ${who.eyes} ${who.marking} ${who.accessory}`;
      }),
    );
    expect(visible.size).toBeGreaterThan(800);
    const pictures = new Set(BRIEF.map((id) => asciiAnimal(id).lines.join('\n')));
    expect(pictures.size).toBe(BRIEF.length);
  });

  it('draws a board of agents within a few milliseconds each', () => {
    const fresh = ids(60).map((id) => `t${id}`);
    const start = performance.now();
    for (const id of fresh) asciiAnimal(id, 'small');
    const small = (performance.now() - start) / fresh.length;
    const begin = performance.now();
    for (const id of fresh.slice(0, 20)) asciiAnimal(id, 'large');
    const large = (performance.now() - begin) / 20;
    console.log(`small ${small.toFixed(2)} ms, large ${large.toFixed(2)} ms per animal`);
    expect(small).toBeLessThan(8);
    expect(large).toBeLessThan(40);
  });
});

describe('gridMarkup', () => {
  it('writes the elements of a tone and nothing else: no style, no script', () => {
    const html = gridMarkup(asciiAnimal(BRIEF[0] as string, 'small'));
    expect(html).not.toMatch(/style|script|on\w+=/i);
    const tags = html.match(/<[^>]+>/g) ?? [];
    expect(tags.every((tag) => /^<\/?t-[0134]>$/.test(tag))).toBe(true);
    expect(html.split('\n')).toHaveLength(16);
    // Taking the tags out leaves the picture itself, without the spaces that end a row.
    expect(html.replace(/<[^>]+>/g, '').split('\n')).toEqual(
      asciiAnimal(BRIEF[0] as string, 'small').lines.map((line) => line.trimEnd()),
    );
  });
});

describe('the avatar of a mark, from the plates', () => {
  it('reads plates.data.ts as the shapes draw it today (run tools/plates.ts when this fails)', () => {
    expect(drawPlateData()).toBe(PLATE_DATA.replace(/\s/g, ''));
  });

  it('chooses from the markings and accessories each drawing lists', () => {
    for (const species of SPECIES) {
      const drawing = DRAW[species]({ coat: 0.6, lean: 0, trait: false, eyes: 'round', large: false });
      expect(CHOICES[species].markings).toEqual(drawing.markings);
      expect(CHOICES[species].worn).toEqual((drawing.accessories ?? ACCESSORIES).filter((each) => each !== 'none'));
    }
  });

  it('writes one grid for both grounds: the dark view is the stacked plates, cell for cell', () => {
    let cells = 0;
    let differ = 0;
    for (const id of [...BRIEF, ...ids(200)]) {
      const html = markMarkup(stackCharacter(character(id)));
      expect(html).not.toMatch(/style|script|on\w+=|class="(?!ascii-grid")/i);
      const inner = html.replace(/^<span class="ascii-grid">/, '').replace(/<\/span>$/, '');
      const tags = inner.match(/<[^>]+>/g) ?? [];
      expect(tags.every((tag) => /^<\/?(t-[0134]|d-[0-4]|l-[0-4])>$/.test(tag))).toBe(true);
      const dark = inner
        .replace(/<l-\d>.<\/l-\d>/g, '')
        .replace(/<[^>]+>/g, '')
        .split('\n');
      const light = inner
        .replace(/<d-\d>.<\/d-\d>/g, '')
        .replace(/<[^>]+>/g, '')
        .split('\n');
      expect(dark).toHaveLength(16);
      expect(light).toHaveLength(16);
      const expected = printCharacter(character(id)).glow.lines.map((line) => line.trimEnd());
      dark.forEach((line, row) => {
        const want = expected[row] as string;
        for (let col = 0; col < Math.max(line.length, want.length); col += 1) {
          cells += 1;
          if ((line[col] ?? ' ') !== (want[col] ?? ' ')) differ += 1;
        }
      });
      // Every cell is one character wide in both views, so the light view has the same rows.
      for (const line of light) expect(line.length).toBeLessThanOrEqual(20);
    }
    // The lookup table of the markup may put a cell on a cut one step away: a few in a thousand.
    expect(differ / cells).toBeLessThan(0.005);
  });

  it('gives the eyes of the light ground their own ink: a mark has cells for one ground only', () => {
    const html = agentAvatar(BRIEF[0] as string).html;
    expect(html).toMatch(/<d-\d>.<\/d-\d><l-\d>.<\/l-\d>/);
  });

  it('keeps an avatar by id and draws a board of a hundred in a few milliseconds', () => {
    expect(agentAvatar(BRIEF[1] as string)).toBe(agentAvatar(BRIEF[1] as string));
    const fresh = ids(100).map((id) => `board${id}`);
    for (const id of ids(50)) agentAvatar(`warm${id}`);
    const start = performance.now();
    for (const id of fresh) agentAvatar(id);
    const board = performance.now() - start;
    console.log(`a board of 100 new avatars: ${board.toFixed(2)} ms in Node`);
    // Generous for a busy test machine; the measured figure is in workerd (tools/bench-worker.ts).
    expect(board).toBeLessThan(40);
  });
});

describe('the mark under 48 pixels, on the 12 by 10 grid', () => {
  it('reads plates-mark.data.ts as the shapes draw it today (run tools/plates.ts when this fails)', () => {
    expect(drawPlateData('mark')).toBe(MARK_PLATE_DATA.replace(/\s/g, ''));
  });

  it('fills about 85% of the square with the head of every species', () => {
    for (const species of SPECIES) {
      const html = agentAvatar(idOf(species), 'mark').html;
      const rows = html
        .replace(/^<span class="ascii-grid ascii-grid--mark">/, '')
        .replace(/<\/span>$/, '')
        .replace(/<l-\d>.<\/l-\d>/g, '')
        .replace(/<[^>]+>/g, '')
        .split('\n');
      expect(rows).toHaveLength(10);
      const inked = rows.map((row) => row.trimEnd().length > 0);
      const height = inked.lastIndexOf(true) - inked.indexOf(true) + 1;
      const left = Math.min(...rows.map((row) => row.search(/\S/)).filter((at) => at >= 0));
      const right = Math.max(...rows.map((row) => row.trimEnd().length));
      // The longer side of the head spans 8 to 10 cells of its 10 or 12.
      expect(Math.max(height / 10, (right - left) / 12)).toBeGreaterThanOrEqual(0.75);
    }
  });

  it('writes the tones and nothing else, every eye a clear cell on both grounds', () => {
    for (const id of [...BRIEF, ...ids(100)]) {
      const html = agentAvatar(id, 'mark').html;
      expect(html).not.toMatch(/style|script|on\w+=/i);
      expect(html.startsWith('<span class="ascii-grid ascii-grid--mark">')).toBe(true);
      const inner = html.replace(/^<span[^>]*>/, '').replace(/<\/span>$/, '');
      const tags = inner.match(/<[^>]+>/g) ?? [];
      expect(tags.every((tag) => /^<\/?(t-[0134]|d-[0-4]|l-[0-4])>$/.test(tag))).toBe(true);
      for (const view of [/<l-\d>.<\/l-\d>/g, /<d-\d>.<\/d-\d>/g]) {
        const rows = inner
          .replace(view, '')
          .replace(/<[^>]+>/g, '')
          .split('\n');
        expect(rows).toHaveLength(10);
        for (const row of rows) {
          expect(row.length).toBeLessThanOrEqual(12);
          expect([...row].every((char) => ' .:+*#%@'.includes(char))).toBe(true);
        }
        // The eyes: at least one clear cell with ink on both sides of it, in some row.
        expect(rows.some((row) => /[+*#%@] +[+*#%@]/.test(row))).toBe(true);
      }
    }
  });

  it('draws the head alone: no marking and no accessory under 48 pixels', () => {
    const who = character(BRIEF[0] as string);
    const plain = { ...who, marking: 'none' as const, accessory: 'none' as const };
    expect([...stackCharacter(who, 'mark').glow]).toEqual([...stackCharacter(plain, 'mark').glow]);
  });

  it('keeps a mark by id and grid, apart from the small grid', () => {
    const id = BRIEF[2] as string;
    expect(agentAvatar(id, 'mark')).toBe(agentAvatar(id, 'mark'));
    expect(agentAvatar(id, 'mark').html).not.toBe(agentAvatar(id).html);
    expect(agentAvatar(id, 'mark').species).toBe(agentAvatar(id).species);
  });
});

/** The first id of the generator that draws this species. */
function idOf(species: string): string {
  for (const id of ids(400)) if (character(id).species === species) return id;
  throw new Error(`No id draws a ${species}.`);
}

describe('mascots', () => {
  it('print on three grids and make a favicon of three inks at 16 and 32', () => {
    for (const name of MASCOTS) {
      expect(mascot(name, 'poster').lines).toHaveLength(48);
      for (const size of [16, 32] as const) {
        const rows = favicon(name, size);
        expect(rows).toHaveLength(size);
        for (const row of rows) expect(row).toHaveLength(size);
        const inks = new Set(rows.flat());
        expect([...inks].sort()).toEqual([0, 1, 2]);
        expect(faviconSvg(name, size)).toMatch(new RegExp(`^<svg [^>]*viewBox="0 0 ${size} ${size}"`));
      }
    }
  });
});
