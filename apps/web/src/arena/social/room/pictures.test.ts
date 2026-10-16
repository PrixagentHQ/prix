// Pictures in the Community chat, as this folder shows them (docs/contracts/phase-6-pictures.md, sections
// 11, 14 and 17): the sample answers of every state, the sentences of a picture's row, what the one script
// makes of a row's attributes, and the rules no type catches, read from the source of the folder.
// Run: pnpm exec vitest run --config apps/web/src/arena/vitest.config.ts
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ROOM_PAGE,
  ROOM_PICTURE_ALT,
  ROOM_PICTURE_COPY_KEYS,
  ROOM_PICTURE_DISCLAIMER,
  ROOM_PICTURE_DOM,
  ROOM_PICTURE_MAX_BYTES,
  ROOM_PICTURE_MAX_FRAMES,
  ROOM_PICTURE_MAX_SIDE,
  ROOM_PICTURE_MIN_SIDE,
  ROOM_PICTURE_ROW_NOTE,
  ROOM_PICTURE_TEXT,
  type RoomPictureView,
  roomPicturePath,
  roomResponseSchema,
  roomWithPicturesResponseSchema,
} from '@prix/contracts';
import { describe, expect, it } from 'vitest';
import { deck } from '../../../content/deck.ts';
import { text } from '../../../content/index.ts';
import { ROOM_FIXTURES, roomSample } from './fixtures.ts';
import { pictureImage } from './pictures.ts';
import { pictureAlt, pictureFacts, pictureRow, pictureSize, pictureWords } from './words.ts';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const read = (name: string): string => readFileSync(`${HERE}${name}`, 'utf8');
/** Comments say what the code must not do, so they are taken out before a rule is read. */
const code = (name: string): string =>
  read(name)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/<!--[\s\S]*?-->/g, '');
const FILES = readdirSync(HERE).filter((name) => /\.(?:ts|astro|css)$/.test(name) && !name.endsWith('.test.ts'));

const PICTURE_STATES = ROOM_FIXTURES.filter((name) => name.startsWith('social-room-pictures'));
const view = (over: Partial<RoomPictureView> = {}): RoomPictureView => ({
  type: 'jpeg',
  width: 1_600,
  height: 1_200,
  bytes: 240_700,
  frames: 1,
  state: 'shown',
  ...over,
});

describe('the sample answers with pictures', () => {
  it('answer in the shape of the contract in every state, with pictures or without', () => {
    for (const name of [null, ...ROOM_FIXTURES]) {
      const sample = roomSample(name);
      if (sample === null) continue;
      const parsed = roomWithPicturesResponseSchema.safeParse(sample);
      expect(parsed.success, `${name}`).toBe(true);
    }
  });

  it('leave the states of the room before pictures as the older API answers them', () => {
    for (const name of [null, ...ROOM_FIXTURES.filter((fixture) => !PICTURE_STATES.includes(fixture))]) {
      const sample = roomSample(name);
      if (sample === null) continue;
      expect(roomResponseSchema.safeParse(sample).success, `${name}`).toBe(true);
      expect(sample.pictures, `${name}`).toBeUndefined();
    }
  });

  it('name a room with pictures on, off and resting, a full page of pictures and an empty room', () => {
    expect(roomSample('social-room-pictures')?.pictures).toBe('on');
    expect(roomSample('social-room-pictures-off')?.pictures).toBe('off');
    expect(roomSample('social-room-pictures-resting')?.pictures).toBe('resting');
    expect(roomSample('social-room-pictures-empty')).toMatchObject({ pictures: 'on', messages: [] });
    const full = roomSample('social-room-pictures-full');
    expect(full?.pictures).toBe('on');
    expect(full?.messages.length).toBe(ROOM_PAGE);
    expect(full?.messages.every((message) => message.picture?.state === 'shown')).toBe(true);
  });

  it('hold every state a picture has, beside messages of text', () => {
    for (const name of ['social-room-pictures', 'social-room-pictures-off', 'social-room-pictures-resting']) {
      const pictures = (roomSample(name)?.messages ?? []).flatMap((message) => message.picture ?? []);
      for (const state of ['shown', 'reported', 'gone']) {
        expect(
          pictures.some((picture) => picture.state === state),
          `${name}: ${state}`,
        ).toBe(true);
      }
      for (const type of ['jpeg', 'png', 'gif']) {
        expect(
          pictures.some((picture) => picture.state === 'shown' && picture.type === type),
          `${name}: ${type}`,
        ).toBe(true);
      }
      expect(roomSample(name)?.messages.some((message) => message.picture === null)).toBe(true);
    }
  });

  it('hold an animated GIF at the most frames, a still one, and pictures at the limits of the file', () => {
    const shown = (roomSample('social-room-pictures')?.messages ?? [])
      .flatMap((message) => message.picture ?? [])
      .filter((picture) => picture.state === 'shown');
    expect(shown.some((picture) => picture.type === 'gif' && picture.frames === ROOM_PICTURE_MAX_FRAMES)).toBe(true);
    expect(shown.some((picture) => picture.type === 'gif' && picture.frames === 1)).toBe(true);
    expect(shown.some((picture) => picture.bytes === ROOM_PICTURE_MAX_BYTES)).toBe(true);
    expect(shown.some((picture) => picture.bytes < 1_024)).toBe(true);
    expect(shown.some((picture) => picture.width === ROOM_PICTURE_MAX_SIDE && picture.height < 320)).toBe(true);
    expect(shown.some((picture) => picture.height === ROOM_PICTURE_MAX_SIDE && picture.width < 600)).toBe(true);
    expect(shown.some((picture) => picture.width === ROOM_PICTURE_MIN_SIDE)).toBe(true);
  });

  it('hold no picture above the largest file the contract takes, in any state', () => {
    for (const name of PICTURE_STATES) {
      for (const message of roomSample(name)?.messages ?? []) {
        if (!message.picture) continue;
        expect(message.picture.bytes, `${name}, message ${message.id}`).toBeLessThanOrEqual(ROOM_PICTURE_MAX_BYTES);
      }
    }
  });

  it("give every picture message the contract's word as its text, and never show a picture of an admin wallet", () => {
    for (const name of PICTURE_STATES) {
      for (const message of roomSample(name)?.messages ?? []) {
        if (message.picture === null || message.picture === undefined) continue;
        expect(message.text, name).toBe(ROOM_PICTURE_TEXT);
        if (message.admin) expect(message.picture.state, name).toBe('gone');
      }
    }
    const withAdmin = roomSample('social-room-pictures')?.messages ?? [];
    expect(withAdmin.some((message) => message.admin && message.picture?.state === 'gone')).toBe(true);
  });
});

describe('the size of a file, as a row says it', () => {
  // The deck's own sentence of the one key, filled as the page fills it. The draft is the key's one draft:
  // the test of every call of `text` reads this file too, and a key has one draft (docs/CONTRACTS.md, 8).
  const kb = (count: number): string => text('social.roomPictureSizeKb', '{count} KB', { count });

  it("is the deck's sentence of the one key, in whole kilobytes of 1,024 bytes", () => {
    expect(deck['social.roomPictureSizeKb']).toBeDefined();
    expect(pictureSize(ROOM_PICTURE_MAX_BYTES)).toBe(kb(ROOM_PICTURE_MAX_BYTES / 1_024));
    expect(pictureSize(2_048)).toBe(kb(2));
    expect(pictureSize(1_024)).toBe(kb(1));
  });

  it('rounds up, so that a file never reads smaller than it is', () => {
    expect(pictureSize(1_025)).toBe(kb(2));
    expect(pictureSize(2_049)).toBe(kb(3));
    // 235.06 kilobytes: the nearest whole number would say 235.
    expect(pictureSize(240_700)).toBe(kb(236));
    expect(pictureSize(ROOM_PICTURE_MAX_BYTES - 1)).toBe(kb(ROOM_PICTURE_MAX_BYTES / 1_024));
  });

  it('says 1 KB for a file below one kilobyte, and never bytes', () => {
    for (const bytes of [32, 96, 511, 1_023]) expect(pictureSize(bytes), `${bytes}`).toBe(kb(1));
  });

  it('never says zero and leaves no slot unfilled', () => {
    for (const bytes of [32, 511, 1_023, 1_024, 1_025, 1_535, 1_536, ROOM_PICTURE_MAX_BYTES]) {
      expect(pictureSize(bytes), `${bytes}`).not.toMatch(/\b0\b|[{}]/);
    }
  });
});

describe('the facts of a file, as a row says them', () => {
  it("are the server's own figures: the type, both sides and the size", () => {
    const facts = pictureFacts(view({ type: 'png', width: 2_048, height: 256, bytes: 201_728 }));
    expect(facts).toContain('PNG');
    // The sides are printed grouped, as the site prints numbers.
    expect(facts).toContain('2,048');
    expect(facts).not.toContain('2048');
    expect(facts).toContain('256');
    expect(facts).toContain(pictureSize(201_728));
    expect(facts).not.toMatch(/[{}]/);
  });

  it('print each side grouped, the height as the width', () => {
    // The size is kept below a thousand kilobytes here, so only a side can hold a run of four digits.
    const tall = pictureFacts(view({ type: 'png', width: 512, height: 2_048, bytes: 229_530 }));
    expect(tall).toContain('2,048');
    expect(tall).not.toMatch(/\d{4}/);
    const both = pictureFacts(view({ width: 1_600, height: 1_200 }));
    expect(both).toMatch(/1,600\D+1,200/);
    expect(both).not.toMatch(/\d{4}/);
  });

  it("say that a GIF is animated, with the server's count of frames, when it has more than one", () => {
    const still = pictureFacts(view({ type: 'gif', width: 480, height: 270, frames: 1 }));
    const moving = pictureFacts(view({ type: 'gif', width: 480, height: 270, frames: 97 }));
    expect(moving).not.toBe(still);
    expect(moving).toContain('97');
    expect(moving).toContain('GIF');
    expect(moving).toContain('480');
    expect(moving).toContain('270');
    expect(moving).toContain(pictureSize(240_700));
    expect(moving).not.toMatch(/[{}]/);
    expect(still).not.toContain('97');
    expect(still).toContain('GIF');
  });

  it('never read a type, a side or a count from anywhere but the picture', () => {
    expect(pictureFacts(view({ type: 'jpeg' }))).toContain('JPEG');
    expect(pictureFacts(view({ width: 1_111, height: 777 }))).toMatch(/1,111.*777/);
  });
});

describe('the row of a picture', () => {
  const words = pictureWords();

  it('offers the picture only while its state is shown and pictures are on', () => {
    expect(pictureRow(view(), 'on')).toEqual({ kind: 'offer', facts: pictureFacts(view()) });
  });

  it('has the facts and a sentence, and no offer, while pictures are off or resting', () => {
    expect(pictureRow(view(), 'off')).toEqual({ kind: 'closed', facts: pictureFacts(view()), sentence: words.off });
    expect(pictureRow(view(), 'resting')).toEqual({
      kind: 'closed',
      facts: pictureFacts(view()),
      sentence: words.restingRow,
    });
  });

  it("keeps the short form in a row while pictures rest: the long sentence is the page's, said once", () => {
    const row = pictureRow(view(), 'resting');
    expect(row.kind === 'closed' && row.sentence).not.toBe(words.resting);
    expect(words.restingRow.length).toBeLessThan(words.resting.length);
    // The row's short form and the page's long sentence both name the hour pictures come back.
    expect(words.restingRow).toContain('00:00 UTC');
    expect(words.resting).toContain('00:00 UTC');
  });

  it('offers nothing when the read says nothing of pictures', () => {
    expect(pictureRow(view(), undefined).kind).toBe('closed');
  });

  it('is one sentence for a reported picture and for one that is gone, whatever the room says', () => {
    for (const pictures of ['on', 'off', 'resting', undefined] as const) {
      expect(pictureRow(view({ state: 'reported' }), pictures)).toEqual({ kind: 'said', sentence: words.reported });
      expect(pictureRow(view({ state: 'gone' }), pictures)).toEqual({ kind: 'said', sentence: words.gone });
    }
  });

  it('has a sentence of its own for every state, none empty', () => {
    const sentences = [words.off, words.resting, words.restingRow, words.reported, words.gone, words.loadFailed];
    expect(new Set(sentences).size).toBe(sentences.length);
    for (const sentence of [...sentences, words.show, words.hide, words.report]) {
      expect(sentence.trim().length).toBeGreaterThan(0);
      expect(sentence).not.toMatch(/[{}]/);
    }
    expect(words.show).not.toBe(words.hide);
  });

  it("names a shown picture by its writer's short address, in the contract's words", () => {
    expect(pictureAlt('0x7a3f…c91e')).toBe(ROOM_PICTURE_ALT.replace('{author}', '0x7a3f…c91e'));
    expect(pictureAlt('0x7a3f…c91e')).not.toMatch(/[{}]/);
  });
});

describe('the sentences of a picture', () => {
  // `text(key, draft)`: the names are the contract's (ROOM_PICTURE_COPY_KEYS) and the words are the editor's.
  const source = read('words.ts');
  const pairs = [...source.matchAll(/\btext\(\s*'(social\.roomPicture[^']+)',\s*'([^']*)'/g)];

  it('are read by the names of the contract, and by no other name', () => {
    expect(pairs.length).toBeGreaterThanOrEqual(10);
    for (const [, key] of pairs) expect(ROOM_PICTURE_COPY_KEYS, key).toContain(key);
    // Every key of a picture in the folder, however it is read, is one of the contract's.
    for (const name of FILES.filter((file) => !file.endsWith('.css'))) {
      for (const [key] of code(name).matchAll(/\bsocial\.roomPicture\w+/g)) {
        expect(ROOM_PICTURE_COPY_KEYS, `${name}: ${key}`).toContain(key);
      }
    }
  });

  it('read the size by the one key: no key for bytes and none for a second rounding', () => {
    const sizes = pairs.map(([, key]) => key as string).filter((key) => key.includes('Size'));
    expect(sizes).toEqual(['social.roomPictureSizeKb']);
  });

  it("read every key of the contract's list that is this page's", () => {
    const read = pairs.map(([, key]) => key);
    for (const name of [
      'Show',
      'Hide',
      'Facts',
      'FactsAnimated',
      'SizeKb',
      'Off',
      'Resting',
      'RestingRow',
      'Reported',
      'Gone',
      'LoadFailed',
      'Report',
    ]) {
      expect(read, name).toContain(`social.roomPicture${name}`);
    }
  });

  it.each(pairs.map(([, key, draft]) => [key, draft]))(
    "of %s keep the deck's own sentence as their draft",
    (key, draft) => {
      // Until the editor's keys are merged the deck has none of them, and the page shows the draft.
      const sentence = deck[key as string];
      if (sentence !== undefined) expect(draft).toBe(sentence);
      expect((draft as string).trim().length).toBeGreaterThan(0);
    },
  );

  it('never vouch for a picture: no "safe" and no "verified" in a sentence of this folder', () => {
    const shown = [...Object.values(pictureWords()), ...pairs.map(([, , draft]) => draft as string)];
    for (const sentence of shown) expect(sentence).not.toMatch(/\b(?:safe|verified|trusted|approved)\b/i);
  });
});

describe('what the script makes of a row', () => {
  const row = { id: '1283', width: '1600', height: '1200', alt: 'Picture posted by 0x7a3f…c91e' };

  it('is one picture: the address from the id, both sides and the words in its place', () => {
    expect(pictureImage(row)).toEqual({
      src: roomPicturePath(1_283),
      width: 1_600,
      height: 1_200,
      alt: 'Picture posted by 0x7a3f…c91e',
    });
  });

  it.each([
    [null],
    [undefined],
    [''],
    ['0'],
    ['01283'],
    ['12a'],
    ['-1'],
    ['1283/report'],
    ['../../account'],
    ['1283?x=1'],
    [' 1283'],
    ['1e3'],
    ['1234567890123456'],
  ])('is nothing when the id is %j', (id) => {
    expect(pictureImage({ ...row, id })).toBeNull();
  });

  it.each([[null], [undefined], [''], ['0'], ['15'], ['2049'], ['-1600'], ['1600px'], ['1e3'], ['16.5'], ['01600']])(
    'is nothing when a side is %j',
    (side) => {
      expect(pictureImage({ ...row, width: side })).toBeNull();
      expect(pictureImage({ ...row, height: side })).toBeNull();
    },
  );

  it('takes the smallest and the largest side', () => {
    const smallest = String(ROOM_PICTURE_MIN_SIDE);
    const largest = String(ROOM_PICTURE_MAX_SIDE);
    expect(pictureImage({ ...row, width: smallest, height: largest })).toMatchObject({
      width: ROOM_PICTURE_MIN_SIDE,
      height: ROOM_PICTURE_MAX_SIDE,
    });
  });

  it('is nothing without the words that stand in its place', () => {
    expect(pictureImage({ ...row, alt: null })).toBeNull();
    expect(pictureImage({ ...row, alt: '' })).toBeNull();
  });
});

describe('the one script of pictures', () => {
  const script = code('pictures.ts');

  it('is the only browser script of the folder, mounted from the row that offers a picture', () => {
    const mounted = FILES.filter((name) => name.endsWith('.astro') && /<script\b/.test(read(name)));
    expect(mounted).toEqual(['PictureScript.astro']);
    expect(code('PictureScript.astro')).toMatch(/import \{ mountPictures \} from '\.\/pictures\.ts';/);
  });

  it('imports values of the contracts from the file a browser may load, and from no other', () => {
    const imports = [...script.matchAll(/^import\s+(type\s+)?[^;]*?from\s+'([^']+)';/gm)];
    expect(imports.length).toBeGreaterThan(0);
    for (const [, typeOnly, from] of imports) {
      if (from === '@prix/contracts') expect(typeOnly, 'pictures.ts imports values from @prix/contracts').toBeTruthy();
      else expect(from).toBe('@prix/contracts/room-picture');
      expect(from).not.toMatch(/zod|content\/|words\.ts$|account\//);
    }
    expect(script).not.toMatch(/\bimport\(/);
  });

  it('builds the address of a picture only from the id of a row, through the two functions of the contract', () => {
    expect(script.match(/\broomPicturePath\(/g)).toHaveLength(1);
    expect(script.match(/\broomPictureIdOf\(/g)).toHaveLength(1);
    expect(script).not.toMatch(/\/api\/|https?:\/\/|ROOM_PICTURES_PATH|roomPictureAdminPath|roomPictureReportPath/);
  });

  it('makes one <img> a click and asks for nothing by itself', () => {
    expect(script.match(/createElement\('img'\)/g)).toHaveLength(1);
    expect(script).not.toMatch(/\bfetch\(|XMLHttpRequest|sendBeacon|\bnew Image\b|EventSource|WebSocket/);
    expect(script).not.toMatch(/\bset(?:Interval|Timeout)\b|\brequestAnimationFrame\b|\brequestIdleCallback\b/);
    expect(script).not.toMatch(/IntersectionObserver|MutationObserver|visibilitychange|\bonline\b|\bpreload\b/);
    expect(script).not.toMatch(/\.decode\(|srcset|\.loading\b/);
    // Nothing but a click starts it: the one listener on the list, and the error of the picture it made.
    const listened = [...script.matchAll(/addEventListener\(\s*'([^']+)'/g)].map(([, event]) => event);
    expect(listened.sort()).toEqual(['click', 'error']);
  });

  it('sends no referrer and never makes a link of a picture', () => {
    expect(script).toMatch(/referrerPolicy = 'no-referrer'/);
    expect(script).not.toMatch(/createElement\('a'\)|\bhref\b|window\.open|location\b|\.target\b = /);
  });

  it('sets the sides as attributes and the words in its place before the address', () => {
    const at = (needle: string): number => script.indexOf(needle);
    for (const needle of ['.width = ', '.height = ', '.alt = ', "referrerPolicy = 'no-referrer'"]) {
      expect(at(needle), needle).toBeGreaterThan(0);
      expect(at(needle), needle).toBeLessThan(at('.src = '));
    }
    expect(script).not.toMatch(/setAttribute\('style'|cssText/);
  });

  it('gives the frame the proportion of the picture, and sets no other style', () => {
    // The site's policy blocks style attributes; a script may set a property through the style object
    // (docs/DESIGN.md, section 19). The one it sets lets the stylesheet keep the frame as narrow as a
    // picture that is twenty lines high, so the box the browser reserves is the picture's own.
    expect(script.match(/\.style\b/g)).toHaveLength(2);
    expect(script).toMatch(
      /frame\.style\.setProperty\('--room-picture-ratio', String\(picture\.width \/ picture\.height\)\)/,
    );
    expect(script).toMatch(/frame\.style\.removeProperty\('--room-picture-ratio'\)/);
    const rules = read('pictures.css').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(rules).toMatch(
      /\.room-picture-frame \{[^}]*max-width: min\(var\(--measure\), calc\(20rem \* var\(--room-picture-ratio, 100\)\)\);/,
    );
  });

  it('marks the row while its picture is shown, and takes the mark away again', () => {
    expect(script).toMatch(/setAttribute\(ROOM_PICTURE_DOM\.shown, ''\)/);
    expect(script).toMatch(/removeAttribute\(ROOM_PICTURE_DOM\.shown\)/);
  });

  it('never touches the Report button, its note or the mark that shows it: those are the account’s', () => {
    expect(script).not.toMatch(/ROOM_PICTURE_DOM\.(?:report|reportNote|reportOn)\b/);
    expect(script).not.toMatch(/data-room-picture-report|data-room-report-on/);
    expect(script).not.toMatch(/\/room\/me\b|readMe/);
  });

  it('builds no markup from a string, keeps nothing in the browser and logs nothing', () => {
    for (const name of FILES.filter((file) => !file.endsWith('.css'))) {
      expect(code(name), name).not.toMatch(
        /innerHTML|outerHTML|insertAdjacentHTML|document\.write|DOMParser|set:html|createContextualFragment/,
      );
    }
    expect(script).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|console\./);
  });
});

describe('what the server renders of a picture', () => {
  const list = code('MessageList.astro');
  const row = code('PictureRow.astro');
  const page = code('RoomPage.astro');
  const styles = read('pictures.css');

  it('holds no <img> and no address of a picture: the page is built before any click', () => {
    for (const name of FILES.filter((file) => file.endsWith('.astro') || file === 'words.ts')) {
      expect(code(name), name).not.toMatch(/<img\b|roomPicturePath|ROOM_PICTURES_PATH|\/room\/pictures/);
    }
  });

  it('never prints the text of a picture message', () => {
    expect(list.match(/message\.text\b/g)).toHaveLength(1);
    expect(list).toMatch(/message\.picture \? \(\s*<PictureRow[\s\S]*?\) : \(\s*<p class="room-text">/);
    expect(row).not.toMatch(/\.text\b|ROOM_PICTURE_TEXT/);
  });

  it('names the list and says whether pictures are on, by the names of the contract', () => {
    // With no value, as the contract writes it: an empty string is rendered as the bare name.
    expect(list).toMatch(/\[ROOM_PICTURE_DOM\.list\]: ''/);
    expect(list).toMatch(/\[ROOM_PICTURE_DOM\.state\]: pictures/);
    expect(list).toMatch(/\[ROOM_PICTURE_DOM\.id\]: message\.id/);
  });

  it('renders the list whenever the read answered, also for a room with nothing to show', () => {
    expect(page.match(/<MessageList\b/g)).toHaveLength(1);
    expect(page).toMatch(/<MessageList messages=\{room\.messages\} pictures=\{room\.pictures\}/);
    expect(page).not.toMatch(/\) : \(\s*<MessageList/);
  });

  it("puts the contract's sentence about pictures under the room's own, only while the read carries pictures", () => {
    expect(page).toMatch(/room\.pictures !== undefined && <p>\{ROOM_PICTURE_DISCLAIMER\}<\/p>/);
    expect(page.indexOf('{ROOM_PICTURE_DISCLAIMER}')).toBeGreaterThan(page.indexOf('<p>{ROOM_DISCLAIMER}</p>'));
    expect(page.indexOf('{ROOM_PICTURE_DISCLAIMER}')).toBeLessThan(page.indexOf('room-marked'));
    expect(ROOM_PICTURE_DISCLAIMER.length).toBeGreaterThan(0);
  });

  it("puts the contract's note in the row of every picture that is not hidden or gone", () => {
    expect(row).toMatch(/\{ROOM_PICTURE_ROW_NOTE\}/);
    expect(ROOM_PICTURE_ROW_NOTE.length).toBeGreaterThan(0);
  });

  it('puts the Report button and the place of its answer into every row in the state shown, offered or not', () => {
    const closed = row.slice(row.indexOf("row.kind === 'said'"));
    expect(closed).toMatch(/\[ROOM_PICTURE_DOM\.report\]: ''/);
    expect(closed).toMatch(/\[ROOM_PICTURE_DOM\.reportNote\]: ''/);
    // Once, outside the choice between the offer and the sentence, so that both kinds of row carry them.
    expect(row.match(/ROOM_PICTURE_DOM\.report\b/g)).toHaveLength(1);
    expect(row.match(/ROOM_PICTURE_DOM\.reportNote\b/g)).toHaveLength(1);
  });

  it('shows the Report button only in a row whose picture is shown, under a list that the account has opened', () => {
    const { list: listName, shown, report, reportOn } = ROOM_PICTURE_DOM;
    const rules = styles.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(rules).toContain(`.room-picture [${report}] {\n  display: none;\n}`);
    expect(rules).toContain(
      `[${listName}][${reportOn}] [${shown}] .room-picture [${report}] {\n  display: inline-flex;\n}`,
    );
    // No other rule gives the button a display.
    const displays = [...rules.matchAll(/([^{}]+)\{[^{}]*\bdisplay:[^{}]*\}/g)].filter(([, selector]) =>
      (selector as string).includes(report),
    );
    expect(displays).toHaveLength(2);
  });

  it('puts no admin mark on a row that carries a picture, whatever its state', () => {
    // Prix never posts a picture: the gone row of a writer who is an admin wallet now carries no mark.
    expect(list.match(/<AdminMark\b/g)).toHaveLength(1);
    expect(list).toMatch(/\{message\.admin && !message\.picture && <AdminMark \/>\}/);
  });

  it('describes each "Show picture" button by the writer and the time of its own row', () => {
    // Fifty buttons of one name in a full room: a screen reader hears whose picture each one shows.
    expect(list).toMatch(/id=\{message\.picture \? `room-who-\$\{message\.id\}` : undefined\}/);
    expect(list).toMatch(/id=\{message\.picture \? `room-when-\$\{message\.id\}` : undefined\}/);
    expect(list).toMatch(/describedBy=\{`room-who-\$\{message\.id\} room-when-\$\{message\.id\}`\}/);
    const toggle = /<Button\b[^>]*data-room-picture-toggle=""[^>]*\/>/.exec(row)?.[0] ?? '';
    expect(toggle).toMatch(/\{\.\.\.\{ 'aria-describedby': describedBy \}\}/);
  });

  it('says the long sentence of resting once, under the heading of the list, and in no row', () => {
    const said = page.match(
      /room\.pictures === 'resting' && \(?\s*<p class="room-resting">\{pictureWords\(\)\.resting\}<\/p>/g,
    );
    expect(said).toHaveLength(1);
    const at = page.indexOf("room.pictures === 'resting'");
    expect(at).toBeGreaterThan(page.indexOf('id="room-messages"'));
    expect(at).toBeGreaterThan(page.indexOf('</header>'));
    expect(at).toBeLessThan(page.indexOf('<MessageList'));
    expect(row).not.toMatch(/words\.resting\b/);
    expect(list).not.toMatch(/words\.resting\b/);
  });

  it('gives a shown picture a hairline edge and square corners', () => {
    const rules = styles.replace(/\/\*[\s\S]*?\*\//g, '');
    const image = /\.room-picture-image \{([^}]*)\}/.exec(rules)?.[1] ?? '';
    expect(image).toContain('outline: var(--rule-hair) solid var(--line-strong);');
    // Drawn inside the picture's own box, so the edge costs no room and nothing moves for it.
    expect(image).toContain('outline-offset: calc(var(--rule-hair) * -1);');
    expect(rules).not.toMatch(/border-radius/);
  });

  it('draws the rule at the left only beside a row of the note and the facts, never beside one sentence', () => {
    const rules = styles.replace(/\/\*[\s\S]*?\*\//g, '');
    const lefts = [...rules.matchAll(/([^{}]+)\{[^{}]*\bborder-left:[^{}]*\}/g)].map(([, selector]) =>
      (selector as string).trim(),
    );
    expect(lefts).toEqual(['.room-picture--file']);
    expect(row).toMatch(/class:list=\{\['room-picture', row\.kind !== 'said' && 'room-picture--file'\]\}/);
  });

  it('sets the button beside the note and the facts from 45em, where a message is a row of a ledger', () => {
    const rules = styles.replace(/\/\*[\s\S]*?\*\//g, '');
    const wide = /@media \(min-width: 45em\) \{([\s\S]*?)\n\}/.exec(rules)?.[1] ?? '';
    expect(wide).toMatch(/\.room-picture--file \{[^}]*grid-template-columns:/);
    // What opens later (a question, an answer, the picture) takes the whole width under the two.
    expect(wide).toMatch(/\.room-picture-answer,\s*\.room-picture-frame \{[^}]*grid-column: 1 \/ -1;/);
    // The two columns are sized by nothing inside them, so a button that appears moves no other.
    expect(/grid-template-columns: ([^;]*);/.exec(wide)?.[1]).not.toMatch(/auto|min-content|max-content|fit-content/);
  });

  it("gives the report's question its place in the row, and lays its two buttons out by the contract's names", () => {
    const { reportNote, reportYes, reportNo } = ROOM_PICTURE_DOM;
    const rules = styles.replace(/\/\*[\s\S]*?\*\//g, '');
    // The place is the element of the answer: one element, rendered empty by the server.
    expect(row).toMatch(
      /<p class="room-picture-answer" role="status" \{\.\.\.\{ \[ROOM_PICTURE_DOM\.reportNote\]: '' \}\} \/>/,
    );
    expect(rules).toContain(`.room-picture-answer :is([${reportYes}], [${reportNo}])`);
    expect(reportNote).toBe('data-room-picture-report-note');
    // Nothing of the account's is named here but the contract's attributes: no class of its scripts or styles.
    expect(rules).not.toMatch(/\.room-pick\b|\.room-pick-|\.room-look|\.room-compose|\.room-report/);
    for (const [, name] of rules.matchAll(/\.(room-[a-z-]+)/g)) {
      expect(name === 'room-picture' || (name as string).startsWith('room-picture-'), name).toBe(true);
    }
    const named = [...rules.matchAll(/\[(data-[a-z-]+)\]/g)].map(([, name]) => name as string);
    const mine = ['data-room-picture-toggle', 'data-room-picture-frame', 'data-room-picture-failed'];
    for (const name of named) {
      expect([...Object.values(ROOM_PICTURE_DOM), ...mine], name).toContain(name);
    }
  });

  it('keeps the line of the button as high as the sentence that can stand in its place', () => {
    // A load that failed puts a sentence of two lines where the button was, at a phone's width: the line
    // holds two lines of that size from the start, so the row is no taller after a failure than before.
    const rules = styles.replace(/\/\*[\s\S]*?\*\//g, '');
    const controls = /\.room-picture-controls \{([^}]*)\}/.exec(rules)?.[1] ?? '';
    expect(controls).toContain('min-height: calc(2 * var(--leading-13));');
    const said = /\.room-picture-controls > \.room-picture-said \{([^}]*)\}/.exec(rules)?.[1] ?? '';
    expect(said).toContain('line-height: var(--leading-13);');
  });

  it('keeps the picture inside its column and lets the browser reserve its box', () => {
    const rules = styles.replace(/\/\*[\s\S]*?\*\//g, '');
    const image = /\.room-picture-image \{([^}]*)\}/.exec(rules)?.[1] ?? '';
    for (const rule of ['max-width: 100%;', 'max-height: 20rem;', 'height: auto;', 'object-fit: contain;']) {
      expect(image, rule).toContain(rule);
    }
  });

  it('writes no colour, size or space of its own: every value of the stylesheet is a token', () => {
    const rules = styles.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(rules).not.toMatch(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(/i);
    expect(rules).not.toMatch(/\[data-theme|filter:|backdrop-filter|gradient\(|text-transform|letter-spacing/);
  });
});
