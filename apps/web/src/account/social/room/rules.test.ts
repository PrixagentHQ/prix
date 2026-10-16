import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ROOM_PICTURE_ADMIN_NOTE,
  ROOM_PICTURE_COMPOSER_NOTE,
  ROOM_PICTURE_COPY_KEYS,
  ROOM_PICTURE_LIMITS,
  ROOM_PICTURE_REFUSALS,
  ROOM_PICTURES_PATH,
  ROOM_REFUSALS,
  type RoomPictureRefusalField,
  type RoomPictureSentenceField,
  type RoomRefusalField,
  roomAdminWithPicturesResponseSchema,
  roomMeWithPicturesResponseSchema,
  roomPictureRefusalKey,
  roomPictureReportPath,
  roomPicturesAdminResponseSchema,
} from '@prix/contracts';
import { describe, expect, it } from 'vitest';
import { deck } from '../../../content/deck.ts';
import { roomRefusalMoreFor, roomRefusalText } from '../../../content/states.ts';
import type { RoomCall } from './client.ts';
import { roomAdminFixture, roomFixtureAnswer, roomPicturesAdminFixture } from './fixtures.ts';
import {
  adminLookWords,
  adminPictureWords,
  pictureRefusalWords,
  pictureScriptWords,
  pictureWords,
} from './picture-words.ts';
import { adminScriptWords, adminWords, composerScriptWords, composerWords } from './words.ts';

/**
 * Rules of docs/contracts/phase-6-room.md that no type catches (sections 6, 9 and 13), read from the
 * source of the two screens: no script asks again by itself, nothing builds markup from a message or an
 * answer, the text rule is the contract's own function from its file with no zod, and `me` is asked once.
 */

const here = fileURLToPath(new URL('.', import.meta.url));
const read = (name: string): string => readFileSync(`${here}${name}`, 'utf8');
/** Comments say what the code must not do, so they are taken out before a rule is read. */
const code = (name: string): string =>
  read(name)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/<!--[\s\S]*?-->/g, '');

const all = readdirSync(here).filter((name) => /\.(ts|astro)$/.test(name) && !name.endsWith('.test.ts'));
/**
 * What a browser loads: the scripts and everything they import from this folder. Every new script goes
 * here (docs/contracts/phase-6-pictures.md sections 11 and 14): one that is not in the list escapes
 * every rule below.
 */
const browser = ['composer.ts', 'admin.ts', 'client.ts', 'answers.ts', 'picture.ts', 'report.ts', 'admin-look.ts'];

describe('the files of the two screens', () => {
  it('are where the contract names them', () => {
    expect(all).toContain('Composer.astro');
    for (const name of browser) expect(all).toContain(name);
  });
});

describe('a script of the Community chat', () => {
  it.each(browser)('%s never asks again by itself: no timer, no retry', (name) => {
    expect(code(name)).not.toMatch(/\bset(?:Interval|Timeout)\b|\brequestAnimationFrame\b|\brequestIdleCallback\b/);
    expect(code(name)).not.toMatch(/visibilitychange|\bonline\b|EventSource|WebSocket|BroadcastChannel/);
  });

  it.each(all)('%s never builds markup from a string', (name) => {
    expect(code(name)).not.toMatch(
      /innerHTML|outerHTML|insertAdjacentHTML|document\.write|DOMParser|set:html|createContextualFragment/,
    );
  });

  it.each(browser)('%s never reads the text of an answer: not a message’s, not an error’s', (name) => {
    expect(code(name)).not.toMatch(/\.message\b|\.text\b|authorShort/);
  });

  it.each(browser)('%s loads no zod: of the contracts, types and the file of the text rule only', (name) => {
    const imports = [...code(name).matchAll(/^import\s+(type\s+)?[^;]*?from\s+'([^']+)';/gm)];
    for (const [, typeOnly, from] of imports) {
      if (from === '@prix/contracts') expect(typeOnly, `${name} imports values from @prix/contracts`).toBeTruthy();
      expect(from).not.toMatch(/zod|content\/|words\.ts$/);
    }
  });

  it('keeps nothing in the browser: no storage, no cookie, no log of what was typed', () => {
    for (const name of browser)
      expect(code(name)).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|console\./);
  });

  it('judges a text with the contract’s own function', () => {
    expect(code('answers.ts')).toMatch(/import \{[^}]*\broomTextProblem\b[^}]*\} from '@prix\/contracts\/room-text';/);
    expect(code('composer.ts')).toMatch(/\btextRefusal\(/);
  });

  it('asks me once, when the composer opens', () => {
    expect(code('composer.ts').match(/\breadMe\(/g)).toHaveLength(1);
    expect(code('admin.ts')).not.toMatch(/\breadMe\(/);
  });

  it('loads the page again after a send and puts nothing of the answer into it', () => {
    expect(code('composer.ts')).toMatch(/window\.location\.reload\(\)/);
  });

  it('sends JSON from the site’s own origin, with the session’s cookie', () => {
    const client = code('client.ts');
    expect(client).toMatch(/credentials: 'same-origin'/);
    expect(client).toMatch(/headers\['content-type'\] = 'application\/json'/);
    expect(client).not.toMatch(/https?:\/\//);
  });
});

describe('the sentences a script is handed', () => {
  const fields = Object.keys(ROOM_REFUSALS) as RoomRefusalField[];

  it('hold one for every field of ROOM_REFUSALS, the deck’s own', () => {
    const words = composerScriptWords();
    expect(Object.keys(words.refusals).sort()).toEqual([...fields].sort());
    for (const field of fields) expect(words.refusals[field]).toBe(roomRefusalText(field));
  });

  it('hold what follows the first sentence for every text rule, the deck’s own, and for no other field', () => {
    const words = composerScriptWords();
    const textFields = fields.filter((field) => field.startsWith('text_'));
    expect(Object.keys(words.more).sort()).toEqual([...textFields].sort());
    for (const field of textFields) expect(words.more[field]).toBe(roomRefusalMoreFor(field));
  });

  it('are never empty', () => {
    const flat = (value: unknown): string[] =>
      typeof value === 'string' ? [value] : Object.values(value as Record<string, unknown>).flatMap(flat);
    for (const sentence of [...flat(composerScriptWords()), ...flat(adminScriptWords())]) {
      expect(sentence.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('a draft of words.ts', () => {
  // `text(key, draft)`: the deck's sentence is the one a page shows, and the draft beside it must not drift.
  const pairs = [...read('words.ts').matchAll(/\btext\(\s*'([^']+)',\s*'([^']*)',?\s*\)/g)];

  it('is found for every key the file reads', () => {
    expect(pairs.length).toBe(read('words.ts').match(/\btext\(/g)?.length);
    expect(pairs.length).toBeGreaterThan(60);
  });

  it.each(pairs.map(([, key, draft]) => [key, draft]))('of %s is the deck’s own sentence', (key, draft) => {
    expect(draft).toBe(deck[key as string]);
  });
});

describe('what the server renders for the composer', () => {
  const composer = code('Composer.astro');
  const form = composer.slice(composer.indexOf('<form'), composer.indexOf('</form>'));

  it('is the form itself for a signed-in visitor, closed until me answers: no part that only waits', () => {
    expect(composer).not.toMatch(/data-room-state="checking"/);
    expect(composer).not.toMatch(/tone="loading"/);
    expect(form).toMatch(/^<form[^>]*data-room-state="yes"[^>]*>/);
    expect(form.match(/^<form[^>]*>/)?.[0]).not.toMatch(/\bhidden\b/);
    expect(form).toMatch(/<TextInput[^>]*\bdisabled\b/);
    expect(form).toMatch(/<Button type="submit"[^>]*\bdisabled\b/);
  });

  it('puts what a send ended as directly under the button, above the note', () => {
    const outlet = form.indexOf('data-outlet');
    expect(outlet).toBeGreaterThan(form.indexOf('data-room-left'));
    expect(outlet).toBeLessThan(form.indexOf('room-note'));
    expect(code('composer.ts')).toMatch(/scrollIntoView\(\{ block: 'nearest' \}\)/);
  });

  it('has a place under the field for what follows a refusal’s first sentence, named for a screen reader', () => {
    expect(form).toMatch(/<p class="room-refusal-more" id="room-text-more"[^>]*data-room-more[^>]*hidden/);
    expect(form.indexOf('room-refusal-more')).toBeGreaterThan(form.indexOf('<TextInput'));
    expect(form.indexOf('room-refusal-more')).toBeLessThan(form.indexOf('data-room-count'));
  });
});

describe('who may write, as the composer says it', () => {
  // Revision 7 of the contract (sections 3 and 9): writing takes a holding and no tier, and the link
  // beside the sentence goes to the page of the account that shows the wallet's $PRIX and reads it again.
  const composer = code('Composer.astro');
  const TIER_WORD = /\btiers?\b/i;
  const HREF = 'href="/account/token"';
  const LINK = /<Button href="\/account\/token" label=\{words\.holdingLink\} variant="secondary" \/>/g;
  const flat = (value: unknown): string[] =>
    typeof value === 'string' ? [value] : Object.values(value as Record<string, unknown>).flatMap(flat);

  it.each(all)('%s names no tier, in its code or in a comment', (name) => {
    expect(read(name)).not.toMatch(TIER_WORD);
  });

  it('shows no sentence that names a tier', () => {
    const shown = [...flat(composerWords()), ...flat(composerScriptWords())];
    expect(shown.length).toBeGreaterThan(40);
    for (const sentence of shown) expect(TIER_WORD.test(sentence), sentence).toBe(false);
  });

  it('labels the link with the deck’s own words', () => {
    expect(composerWords().holdingLink).toBe(deck['social.roomTiersLink']);
    expect(composer.match(LINK)).toHaveLength(2);
  });

  it('links that page twice and the public token page never: signed out, and under the sentence of not_holder', () => {
    expect(composer.split(HREF)).toHaveLength(3);
    expect(composer).not.toMatch(/href="\/token"/);
    const signedOut = composer.slice(composer.indexOf('!signedIn ? ('), composer.indexOf('data-room-composer'));
    expect(signedOut.split(HREF)).toHaveLength(2);
    const from = composer.indexOf('data-room-state="not_holder"');
    const below = composer.slice(from, composer.indexOf('data-room-state="gate_off"'));
    expect(from).toBeGreaterThan(0);
    expect(below.split(HREF)).toHaveLength(2);
    expect(below.indexOf(HREF)).toBeGreaterThan(below.indexOf("roomRefusalText('not_holder')"));
  });

  it('leads to a route the site has, whose page shows the holding and has the control that reads it again', () => {
    const source = (path: string): string => fileURLToPath(new URL(path, import.meta.url));
    expect(existsSync(source('../../../pages/account/token.astro'))).toBe(true);
    expect(readFileSync(source('../../../pages/account/token.astro'), 'utf8')).toMatch(
      /account\/token\/TokenPage\.astro/,
    );
    const card = readFileSync(source('../../token/TierCard.astro'), 'utf8');
    // The holding in whole tokens, as the holders table counts them (holders-1b, HB-DC-3).
    expect(card).toMatch(/'token\.holdingTokens'/);
    expect(card).toMatch(/data-token-check/);
    expect(readFileSync(source('../../token/token-client.ts'), 'utf8')).toMatch(/path: '\/api\/token\/refresh'/);
  });
});

describe('the admins’ page', () => {
  const page = code('AdminChatPage.astro');

  it('marks a row only when the public does not see the message', () => {
    expect(page).not.toMatch(/stateOpen|kind="open"/);
    expect(Object.keys(adminWords())).not.toContain('stateOpen');
  });

  it('has controls of the form’s own size', () => {
    expect(page).not.toMatch(/size="sm"/);
  });

  it('says a failed read in one sentence, the deck’s own', () => {
    expect(adminWords().loadFailedBody).toBe(deck['social.roomAdminLoadFailedBody']);
    expect(page).toMatch(/body=\{words\.loadFailedBody\}/);
    expect(page).not.toMatch(/apiErrorText|failed\.body/);
  });
});

describe('the list of browser scripts', () => {
  it('holds every file of this folder that a script of a page loads', () => {
    // From the two pages' own script elements, and from there along every import inside this folder.
    const seen = new Set<string>();
    const walk = (name: string): void => {
      if (seen.has(name)) return;
      seen.add(name);
      for (const [, , from] of code(name).matchAll(/^import\s+(type\s+)?[^;]*?from\s+'\.\/([^']+)';/gm)) {
        if (from) walk(from);
      }
    };
    for (const page of ['Composer.astro', 'AdminChatPage.astro']) {
      const scripts = read(page).slice(read(page).lastIndexOf('<script>'));
      for (const [, from] of scripts.matchAll(/from '\.\/([^']+)'/g)) if (from) walk(from);
    }
    // Type-only imports load nothing, and fixtures.ts is reached by a dynamic import of a sample build only.
    expect([...seen].sort()).toEqual([...browser].sort());
  });
});

describe('a script and the contract of pictures', () => {
  // docs/contracts/phase-6-pictures.md sections 11 and 17.
  const VALUE_IMPORT = /^import\s+(?!type\s)[^;]*?from\s+'(@prix\/contracts[^']*)';/gm;

  it.each(browser)('%s imports values of the contracts from the two files with no zod only', (name) => {
    for (const [, from] of code(name).matchAll(VALUE_IMPORT)) {
      expect(['@prix/contracts/room-text', '@prix/contracts/room-picture']).toContain(from);
    }
  });

  it('checks what is sent with the contract’s own rule, and sends the rule’s answer', () => {
    const picture = code('picture.ts');
    expect(picture).toMatch(/import \{[^}]*\broomPictureCheck\b[^}]*\} from '@prix\/contracts\/room-picture';/);
    expect(picture).toMatch(/\bROOM_PICTURE_COMPOSER_STEPS\b/);
    expect(picture).toMatch(/picture\?\.bytes/);
  });

  it('learns what a file is from its bytes: never from the type or the name a browser gives it', () => {
    for (const name of browser) expect(code(name), name).not.toMatch(/\bfile\.type\b|\.name\b|webkitRelativePath/);
    for (const name of ['picture.ts', 'composer.ts']) expect(code(name), name).not.toMatch(/\.type\b/);
    expect(code('picture.ts')).toMatch(/file\.slice\(0, length\)/);
  });

  it('draws a still upright through a canvas, and previews in a canvas', () => {
    const picture = code('picture.ts');
    expect(picture).toMatch(/createImageBitmap\(file, \{ imageOrientation: 'from-image' \}\)/);
    expect(picture).toMatch(/canvas\.toBlob\(/);
    for (const name of ['picture.ts', 'composer.ts', 'report.ts']) {
      expect(code(name), name).not.toMatch(
        /createObjectURL|readAsDataURL|FileReader|new Image\b|createElement\('img'\)|blob:|data:image/,
      );
    }
  });

  it('has no paste and no drag: a picture is chosen', () => {
    for (const name of [...browser, 'Composer.astro']) {
      expect(code(name), name).not.toMatch(/\bpaste\b|\bdrop\b|\bdrag\w*\b|clipboard|DataTransfer/i);
    }
  });

  it('offers the three types and one file, and no camera of its own', () => {
    const composer = code('Composer.astro');
    const inputs = composer.match(/<input[^>]*type="file"[^>]*>/g) ?? [];
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatch(/accept="image\/jpeg,image\/png,image\/gif"/);
    expect(inputs[0]).not.toMatch(/\bmultiple\b|\bcapture\b|\bname=/);
  });

  it('sends the bytes once, from the site’s own origin, as the contract’s type, and never by itself', () => {
    const client = code('client.ts');
    expect(client).toMatch(/import \{[^}]*\bROOM_PICTURES_PATH\b[^}]*\} from '@prix\/contracts\/room-picture';/);
    expect(client).toMatch(/headers\['content-type'\] = ROOM_PICTURE_UPLOAD_CONTENT_TYPE/);
    expect(client).toMatch(/path: ROOM_PICTURES_PATH/);
    expect(client.match(/\bfetch\(/g)).toHaveLength(1);
    expect(client).toMatch(/credentials: 'same-origin'/);
    expect(client).toMatch(/cache: 'no-store'/);
    expect(client).not.toMatch(/FormData|multipart|keepalive|sendBeacon/);
    expect(code('composer.ts').match(/\bpostPicture\(/g)).toHaveLength(1);
    for (const name of browser.filter((name) => name !== 'composer.ts' && name !== 'client.ts')) {
      expect(code(name), name).not.toMatch(/\bpostPicture\(/);
    }
  });

  it('loads the page again after a picture was taken, as after a line', () => {
    const composer = code('composer.ts');
    const upload = composer.slice(composer.indexOf('postPicture('));
    expect(upload.slice(0, upload.indexOf('postLine('))).toMatch(/window\.location\.reload\(\)/);
  });

  it('learns whether pictures are on from the page’s list and from no prop', () => {
    const composer = code('composer.ts');
    expect(composer).toMatch(/\[\$\{ROOM_PICTURE_DOM\.list\}\]/);
    expect(composer).toMatch(/getAttribute\(ROOM_PICTURE_DOM\.state\)/);
    expect(composer).toMatch(/setAttribute\(ROOM_PICTURE_DOM\.reportOn, ''\)/);
    // Never by a class, an id or a label of the other owner's.
    for (const name of browser) expect(code(name), name).not.toMatch(/room-list|room-item|#room-(?!text)/);
    const page = read('Composer.astro');
    const props = page.slice(page.indexOf('interface Props {'), page.indexOf('const {'));
    expect(props.match(/^\s+\w+\??:/gm)?.map((line) => line.trim())).toEqual([
      'prixAddress:',
      'siteHost:',
      'signedIn:',
    ]);
  });

  it('builds a path from an attribute only through roomPictureIdOf', () => {
    for (const name of ['report.ts', 'admin-look.ts']) {
      expect(code(name), name).toMatch(/roomPictureIdOf\(/);
      expect(code(name), name).not.toMatch(/\/api\//);
    }
    expect(code('client.ts')).toMatch(/roomPictureReportPath\(id\)/);
    expect(code('admin-look.ts')).toMatch(/roomPictureAdminPath\(id\)/);
  });

  it('reports once, only from the question’s yes, with the JSON type and no body', () => {
    // Revision 6 (P2): the first press on "Report" sends nothing. The page driver holds the behaviour.
    const report = code('report.ts');
    expect(report.match(/\breportPicture\(/g)).toHaveLength(1);
    expect(report).toMatch(/ROOM_PICTURE_DOM\.reportYes/);
    expect(report).toMatch(/ROOM_PICTURE_DOM\.reportNo/);
    // The one call stands inside what a press on the yes runs, after the report button was closed for good.
    const sends = report.slice(report.indexOf('const send = '));
    expect(report.indexOf('const send = ')).toBeGreaterThan(-1);
    expect(sends.indexOf("setAttribute('disabled', '')")).toBeGreaterThan(-1);
    expect(sends.indexOf("setAttribute('disabled', '')")).toBeLessThan(sends.indexOf('reportPicture('));
    // The question takes the focus: the note itself, never one of its two buttons.
    expect(report).toMatch(/note\.tabIndex = -1/);
    expect(report).toMatch(/note\.focus\(/);
    for (const [, focused] of report.matchAll(/(\w+)\.focus\(/g)) expect(['note', 'button']).toContain(focused);
    // "Hide picture" closes an open question: the one attribute of the one row, let go of when it closes.
    expect(report).toMatch(/attributeFilter: \[ROOM_PICTURE_DOM\.shown\]/);
    expect(report).toMatch(/\.disconnect\(\)/);
    expect(code('client.ts')).toMatch(
      /reportPicture = \(id: number\): Promise<Answer> =>\s*send\(\{ method: 'POST', path: roomPictureReportPath\(id\) \}\)/,
    );
  });

  it('never lets a second press on the same spot unblur: "Hide picture" takes the place and the focus', () => {
    // Revision 6 (P1 and D1). The page driver holds the double-press cases; this pins the four rules' shape.
    const look = code('admin-look.ts');
    const shows = look.slice(look.indexOf("if (step !== 'show') return;"));
    expect(shows).toMatch(/offer\('hide'\)/);
    expect(look).not.toMatch(/offer\('unblur'/);
    // "Unblur picture" only in the image's own load, only while the image is in the page, with no focus.
    expect(look.indexOf("addEventListener('load'")).toBeGreaterThan(-1);
    const loaded = look.slice(look.indexOf("addEventListener('load'"));
    expect(loaded.slice(0, loaded.indexOf('});'))).toMatch(/image\.isConnected/);
    const markup = code('AdminLook.astro');
    const at = (step: string): number => markup.indexOf(`data-room-look-step="${step}"`);
    expect(at('show')).toBeGreaterThan(-1);
    expect(at('hide')).toBeGreaterThan(at('show'));
    expect(at('unblur')).toBeGreaterThan(at('hide'));
    // The picture's place stands under the buttons.
    expect(markup.indexOf('data-room-look-place')).toBeGreaterThan(at('unblur'));
  });

  it('shows an admin one picture a click, blurred first, and never as a link', () => {
    const look = code('admin-look.ts');
    expect(look).toMatch(/referrerPolicy = 'no-referrer'/);
    expect(look).not.toMatch(/createElement\('a'\)|\.href\b|window\.open|srcset/);
    expect(look).toMatch(/room-look--blurred/);
    // Nothing is asked for before a click: the one image is made inside a click's handler.
    expect(look.indexOf("createElement('img')")).toBeGreaterThan(look.indexOf("addEventListener('click'"));
    expect(code('AdminChatPage.astro')).not.toMatch(/<img\b|roomPictureAdminPath|pictures\/\$\{/);
  });
});

describe('the sentences of pictures', () => {
  const source = read('picture-words.ts');
  const pairs = [...source.matchAll(/\btext\(\s*'([^']+)',\s*(?:figured\(\s*)?'([^']*)'/g)].map(([, key, draft]) => [
    key ?? '',
    draft ?? '',
  ]);
  // The editor settled every key of the contract's revisions 5 and 6 in the deck, so no draft is left out
  // of the comparison below: each one is the deck's own sentence.
  const landed = ROOM_PICTURE_COPY_KEYS.some((key) => Object.hasOwn(deck, key));

  it('are read by a key and a draft, every one', () => {
    expect(pairs.length).toBe(source.match(/\btext\(/g)?.length);
    expect(pairs.length).toBeGreaterThan(80);
  });

  it.each(pairs)('%s is a key of the contract’s list, or one the deck had before pictures', (key) => {
    const older = ['social.roomRefusalOther', 'errors.sessionEnded'];
    expect(ROOM_PICTURE_COPY_KEYS.includes(key) || older.includes(key), key).toBe(true);
  });

  it('reads one size, by the one key, and neither of the two the contract dropped', () => {
    const keys = pairs.map(([key]) => key);
    expect(keys).toContain('social.roomPictureSizeKb');
    expect(keys).not.toContain('social.roomPictureSize');
    expect(keys).not.toContain('social.roomPictureSizeBytes');
  });

  it('passes a sentence no slot that nothing reads: a figure of the limits stands in the draft’s own text', () => {
    // The deck wrote each figure of ROOM_PICTURE_LIMITS into its sentence, so a page hands it none.
    expect(code('picture-words.ts')).not.toMatch(/,\s*LIMITS,?\s*\)/);
    expect(code('picture-words.ts')).not.toMatch(/\{ (?:count|strikes): ROOM_PICTURE_/);
  });

  it('use every key of the contract’s list that is these two screens’', () => {
    const used = new Set(pairs.map(([key]) => key));
    // The rows of the list are the other owner's, and so are these keys (`RestingRow` since revision 6).
    const arena = ['Show', 'Off', 'Resting', 'RestingRow', 'Reported', 'Gone', 'Report'].map(
      (name) => `social.roomPicture${name}`,
    );
    for (const key of ROOM_PICTURE_COPY_KEYS) {
      if (!arena.includes(key)) expect(used.has(key), key).toBe(true);
    }
  });

  it('name each refusal by the contract’s own key', () => {
    const fields = (Object.keys(ROOM_PICTURE_REFUSALS) as RoomPictureRefusalField[]).filter(
      (field): field is RoomPictureSentenceField => field !== 'picture_views_day',
    );
    for (const field of fields) {
      expect(source, field).toMatch(
        new RegExp(`\\b${field}: text\\(\\s*'${roomPictureRefusalKey(field).replace('.', '\\.')}',`),
      );
    }
  });

  // The editor writes the deck in the same round. Until its keys are there a draft is what a page shows.
  // The deck writes each figure of ROOM_PICTURE_LIMITS into its sentence and keeps no slot for one, while a
  // draft holds a slot there (the test below), so a draft is compared with those slots filled as the deck
  // prints a figure: grouped in thousands. Every other slot stays as it is, and is the deck's own too.
  const figures: Record<string, string> = Object.fromEntries(
    Object.entries(ROOM_PICTURE_LIMITS).map(([name, figure]) => [name, figure.toLocaleString('en-US')]),
  );
  const withFigures = (draft: string): string =>
    draft.replace(/\{(\w+)\}/g, (slot, name: string) => figures[name] ?? slot);
  it.skipIf(!landed).each(pairs)('the draft of %s is the deck’s own sentence', (key, draft) => {
    expect(withFigures(draft)).toBe(deck[key]);
  });

  it('say nothing that reads as Prix vouching for a picture, name no number of their own, and are never empty', () => {
    const flat = (value: unknown): string[] =>
      typeof value === 'string' ? [value] : Object.values(value as Record<string, unknown>).flatMap(flat);
    const shown = [
      ...flat(pictureWords()),
      ...flat(pictureScriptWords()),
      ...flat(adminPictureWords()),
      ...flat(adminLookWords()),
    ];
    expect(shown.length).toBeGreaterThan(80);
    for (const sentence of shown) {
      expect(sentence.trim().length).toBeGreaterThan(0);
      expect(sentence, sentence).not.toMatch(/\b(?:safe|verified|checked by|approved|trusted)\b/i);
    }
    // A draft holds a slot where a number of the contract goes; "00:00 UTC", "SHA-256" and "1 more" are no limits.
    for (const [key, draft] of pairs) {
      const bare = draft.replace(/00:00 UTC|SHA-256|^1 report$|1 more picture/g, '');
      expect(bare, key).not.toMatch(/\d/);
    }
  });

  it('fill every slot the server can fill, so no brace reaches a page', () => {
    const flat = (value: unknown): string[] =>
      typeof value === 'string' ? [value] : Object.values(value as Record<string, unknown>).flatMap(flat);
    for (const sentence of [...flat(pictureWords()), ...flat(pictureRefusalWords())]) {
      expect(sentence, sentence).not.toMatch(/\{(?!count\})\w+\}/);
    }
  });
});

describe('what the server renders for a picture in the composer', () => {
  const composer = code('Composer.astro');
  const form = composer.slice(composer.indexOf('<form'), composer.indexOf('</form>'));

  it('is closed until me answers: every part of pictures arrives hidden', () => {
    for (const part of form.match(/<[a-zA-Z]+[^>]*data-room-picture-offer=[^>]*>/g) ?? [])
      expect(part).toMatch(/\bhidden\b/);
    expect(form.match(/data-room-picture-offer="(\w+)"/g)?.sort()).toEqual(
      ['add', 'admin', 'day_used', 'new_writer'].map((kind) => `data-room-picture-offer="${kind}"`),
    );
    expect(form).toMatch(/<div[^>]*data-room-picture\b[^>]*hidden/);
    expect(form).toMatch(/<div[^>]*data-room-picture-problem\b[^>]*hidden/);
  });

  it('says the contract’s own note above the send once a picture is chosen, and the admin’s note as it stands', () => {
    expect(form).toMatch(/\{picture\.composerNote\}/);
    expect(form.indexOf('{picture.composerNote}')).toBeLessThan(form.indexOf('type="submit"'));
    expect(form.indexOf('{picture.composerNote}')).toBeGreaterThan(form.indexOf('data-room-picture '));
    expect(form).toMatch(/data-room-picture-offer="admin"[^>]*>\s*\{picture\.adminNote\}/);
    expect(pictureWords().composerNote).toBe(ROOM_PICTURE_COMPOSER_NOTE);
    expect(pictureWords().adminNote).toBe(ROOM_PICTURE_ADMIN_NOTE);
  });

  it('says the rule of the first message with the contract’s number, and no time', () => {
    const said = pictureWords().newWriter;
    expect(said).toContain(String(ROOM_PICTURE_LIMITS.writerAgeMinutes));
    expect(said).not.toMatch(/[{}]/);
    expect(form).toMatch(/data-room-picture-offer="new_writer"[^>]*>\s*\{picture\.newWriter\}/);
  });

  it('previews in a canvas and holds no image and no address of one', () => {
    expect(form).toMatch(/<canvas[^>]*data-room-picture-preview/);
    expect(composer).not.toMatch(/<img\b|\bsrc=|srcset/);
  });

  it('says the limits under a file the page refused', () => {
    const problem = form.slice(form.indexOf('data-room-picture-problem'));
    expect(problem.slice(0, problem.indexOf('</div>'))).toMatch(/\{picture\.limits\}/);
  });
});

describe('the classes of this owner', () => {
  // Revision 5, point 17: the rows of the list are the other owner's and carry `room-picture-*`.
  it('are its own family: no class of the composer or of its stylesheet begins room-picture', () => {
    expect(read('room.css')).not.toMatch(/\.room-picture\b/);
    for (const name of ['Composer.astro', 'AdminChatPage.astro', 'AdminLook.astro']) {
      for (const [, classes] of code(name).matchAll(/class="([^"]*)"/g)) {
        expect(classes, name).not.toMatch(/\broom-picture\b/);
      }
    }
  });

  it('give a picture square corners in the composer’s preview and in the admins’ look', () => {
    const css = read('room.css');
    for (const rule of ['.room-pick-preview {', '.room-look-place {', '.room-look-image {']) {
      const at = css.indexOf(rule);
      expect(at, rule).toBeGreaterThan(-1);
      expect(css.slice(at, css.indexOf('}', at)), rule).not.toMatch(/border-radius/);
    }
  });
});

describe('the composer’s form with a picture', () => {
  const composer = code('Composer.astro');
  const form = composer.slice(composer.indexOf('<form'), composer.indexOf('</form>'));

  it('puts a refusal directly under the buttons, above the two lines of what is left today', () => {
    const buttons = form.indexOf('type="submit"');
    const problem = form.indexOf('data-room-picture-problem');
    const left = form.indexOf('data-room-left');
    const pictureLeft = form.indexOf('data-room-picture-left');
    expect(problem).toBeGreaterThan(buttons);
    expect(left).toBeGreaterThan(problem);
    expect(pictureLeft).toBeGreaterThan(left);
    // One stack holds both lines.
    expect(form.indexOf('<div class="room-left-lines"')).toBeGreaterThan(-1);
    const stack = form.slice(form.indexOf('<div class="room-left-lines"'));
    expect(stack.slice(0, stack.indexOf('</div>'))).toMatch(/data-room-left[\s\S]*data-room-picture-left/);
  });

  it('sets the contract’s note in the body size, not as a small note', () => {
    expect(form).toMatch(/<p class="body room-pick-note">\{picture\.composerNote\}<\/p>/);
  });

  it('names the send for a picture, and what a failed one is called, from the deck', () => {
    expect(form).toMatch(/data-picture-label=\{picture\.send\}/);
    expect(form).toMatch(/data-picture-busy-label=\{picture\.sending\}/);
    expect(form).toMatch(
      /<template data-message="picture-failed">\s*<Notice tone="error" title=\{picture\.sendFailedTitle\}/,
    );
  });

  it('renders the question of a report once, with its two answers under the contract’s names', () => {
    expect(composer).toMatch(/<template data-room-report-ask>/);
    expect(composer).toMatch(/ROOM_PICTURE_DOM\.reportYes/);
    expect(composer).toMatch(/ROOM_PICTURE_DOM\.reportNo/);
  });
});

describe('the admins’ page and pictures', () => {
  const page = code('AdminChatPage.astro');

  it('gives the card of the switch and the card of all messages a title each', () => {
    expect(page).toMatch(/<AccountCard title=\{pic\.picturesTitle\} headingId="room-switch-heading">/);
    expect(page).toMatch(/<AccountCard title=\{pic\.messagesTitle\} headingId="room-messages-heading">/);
  });

  it('reads the list with the schema that knows a picture, and the reported ones with theirs', () => {
    const reader = code('admin-read.ts');
    expect(reader).toMatch(/roomAdminWithPicturesResponseSchema\.safeParse/);
    expect(reader).toMatch(/roomPicturesAdminResponseSchema\.safeParse/);
    expect(reader).not.toMatch(/\broomAdminResponseSchema\b/);
  });

  it('asks before every control of a picture, and says each result in words', () => {
    const words = adminPictureWords();
    for (const name of ['remove', 'keep', 'off', 'on'] as const) {
      for (const part of ['label', 'busy', 'question', 'consequence', 'done', 'failed'] as const) {
        expect(words[name][part].trim().length, `${name}.${part}`).toBeGreaterThan(0);
      }
    }
    for (const done of ['room-picture-removed', 'room-picture-kept', 'room-pictures-off', 'room-pictures-on']) {
      expect(page, done).toContain(`name: '${done}'`);
      expect(code('admin.ts'), done).toContain(`done: '${done}'`);
    }
    const control = code('AdminControl.astro');
    expect(control).toMatch(/data-confirm-ask/);
    expect(control).toMatch(/\{words\.question\}/);
    expect(control).toMatch(/\{words\.consequence\}/);
    // No control of this page runs from its first click: each button with an act stands inside a question.
    expect(page).not.toMatch(/data-room-act=/);
  });

  it('says in the removal’s question that the file cannot be brought back', () => {
    expect(adminPictureWords().remove.consequence).toMatch(/cannot be brought back/);
  });

  it('never refuses a removal, a keep or the switch in the page: the calls go by the id or by nothing', () => {
    const client = code('client.ts');
    expect(client).toMatch(/keepPicture = \(id: string\)/);
    expect(client).toMatch(/picturesOff = \(\)/);
    expect(client).toMatch(/picturesOn = \(\)/);
  });
});

describe('the fixtures of pictures', () => {
  const answer = (fixture: string, call: RoomCall) => roomFixtureAnswer(fixture, call);

  it('answer a refused upload with the status the contract gives its field', () => {
    const fields = (Object.keys(ROOM_PICTURE_REFUSALS) as RoomPictureRefusalField[]).filter(
      (field) => !field.startsWith('report_') && field !== 'picture_views_day',
    );
    for (const field of fields) {
      const refused = answer(`social-room-pic-${field.replaceAll('_', '-')}`, {
        method: 'POST',
        path: ROOM_PICTURES_PATH,
        bytes: new Blob([]),
      });
      expect(refused.status, field).toBe(ROOM_PICTURE_REFUSALS[field]);
      expect(refused.body).toMatchObject({ error: { code: 'invalid_input', field } });
    }
    expect(answer('', { method: 'POST', path: ROOM_PICTURES_PATH, bytes: new Blob([]) }).status).toBe(201);
  });

  it('answer me as the contract’s schema with pictures reads it, in every state', () => {
    for (const [fixture, picture] of [
      ['', 'yes'],
      ['social-room-me-pic-admin', 'admin'],
      ['social-room-me-pic-new', 'new_writer'],
      ['social-room-me-pic-no', 'no'],
      ['social-room-me-pic-used', 'yes'],
    ] as const) {
      const body = answer(fixture, { method: 'GET', path: '/api/social/room/me' }).body;
      expect(roomMeWithPicturesResponseSchema.parse(body).picture, fixture).toBe(picture);
    }
    const old = answer('social-room-me-pic-none', { method: 'GET', path: '/api/social/room/me' }).body;
    expect(roomMeWithPicturesResponseSchema.parse(old).picture).toBeUndefined();
  });

  it('answer a report: 204, and each refusal with its status', () => {
    const report = (fixture: string) => answer(fixture, { method: 'POST', path: roomPictureReportPath(52) });
    expect(report('').status).toBe(204);
    expect(report('social-room-report-own')).toMatchObject({ status: 400, body: { error: { field: 'report_own' } } });
    expect(report('social-room-report-day').status).toBe(ROOM_PICTURE_REFUSALS.report_wallet_day);
    expect(report('social-room-report-closed').status).toBe(404);
  });

  it('answer the admins’ two reads as the contract’s schemas read them', () => {
    for (const fixture of ['', 'social-room-pics-off', 'social-room-pics-auto-off', 'social-room-pics-none']) {
      const list = roomAdminFixture(fixture, null);
      expect(list.kind).toBe('data');
      if (list.kind === 'data')
        expect(roomAdminWithPicturesResponseSchema.safeParse(list.data).success, fixture).toBe(true);
      const reported = roomPicturesAdminFixture(fixture);
      if (reported.kind === 'data') {
        expect(roomPicturesAdminResponseSchema.safeParse(reported.data).success, fixture).toBe(true);
      }
    }
    const reported = roomPicturesAdminFixture('');
    expect(reported.kind === 'data' && reported.data.reported.length).toBeGreaterThan(0);
    expect(roomPicturesAdminFixture('social-room-pics-old-api')).toEqual({ kind: 'error', status: 404 });
  });

  it('show no picture larger than the largest file the chat takes', () => {
    // The admins' schema bounds no size, so only this keeps a sample from showing a file that cannot exist.
    const sizes: number[] = [];
    const list = roomAdminFixture('', null);
    if (list.kind === 'data') {
      for (const message of list.data.messages) if (message.picture) sizes.push(message.picture.bytes);
    }
    const reported = roomPicturesAdminFixture('social-room-pics-many');
    if (reported.kind === 'data') for (const each of reported.data.reported) sizes.push(each.picture.bytes);
    const sent = answer('', { method: 'POST', path: ROOM_PICTURES_PATH, bytes: new Blob([]) }).body as {
      message: { picture: { bytes: number } };
    };
    sizes.push(sent.message.picture.bytes);
    expect(sizes.length).toBeGreaterThan(5);
    for (const bytes of sizes) expect(bytes).toBeLessThanOrEqual(ROOM_PICTURE_LIMITS.maxKib * 1024);
  });

  it('count the reports a sample page sent, for the page driver, and send none by itself', () => {
    const sample = globalThis as { prixSampleReports?: number };
    delete sample.prixSampleReports;
    answer('', { method: 'GET', path: '/api/social/room/me' });
    expect(sample.prixSampleReports).toBeUndefined();
    answer('', { method: 'POST', path: roomPictureReportPath(52) });
    answer('social-room-report-own', { method: 'POST', path: roomPictureReportPath(52) });
    expect(sample.prixSampleReports).toBe(2);
    delete sample.prixSampleReports;
  });
});

describe('the fixtures of the two screens', () => {
  const answer = (fixture: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string) =>
    roomFixtureAnswer(fixture, { method, path });

  it('answer a refused send with the status the contract gives its field', () => {
    for (const field of Object.keys(ROOM_REFUSALS) as RoomRefusalField[]) {
      if (field === 'admin') continue;
      const refused = answer(`social-room-send-${field.replaceAll('_', '-')}`, 'POST', '/api/social/room');
      expect(refused.status, field).toBe(ROOM_REFUSALS[field]);
      expect(refused.body).toMatchObject({ error: { code: 'invalid_input', field } });
    }
  });

  it('answer the four states of me', () => {
    const write = (fixture: string) => (answer(fixture, 'GET', '/api/social/room/me').body as { write: string }).write;
    expect(write('')).toBe('yes');
    expect(write('social-room-me-below')).toBe('not_holder');
    expect(write('social-room-me-muted')).toBe('muted');
    expect(write('social-room-me-gate-off')).toBe('gate_off');
  });
});
