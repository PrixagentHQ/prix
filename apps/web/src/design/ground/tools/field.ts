// Draws the field of characters (../field.ts) and writes its markup to ../field.data.ts, which the
// layout prints as it is. Run it after any change to field.ts; field.test.ts fails until it is run.
//   node apps/web/src/design/ground/tools/field.ts
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fieldMarkup } from '../field.ts';

const markup = fieldMarkup();
const file = fileURLToPath(new URL('../field.data.ts', import.meta.url));
writeFileSync(
  file,
  [
    '// Written by tools/field.ts from field.ts. Do not edit; run the tool again.',
    '// The markup of the field of characters behind the page head (docs/DESIGN.md section 2.3).',
    // A template literal, one line of markup per row: the ramp has no backtick, dollar or backslash.
    `export const FIELD_MARKUP = \`${markup}\`;`,
    '',
  ].join('\n'),
);
console.log(`${file}: ${markup.length} characters`);
