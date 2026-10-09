// Draws the plates of every species and writes them to plates.data.ts (the 20 by 16 grid) and
// plates-mark.data.ts (the 12 by 10 grid of a mark under 48 pixels); see plates.ts. Run it after
// any change to species.ts, animal.ts, framing.ts, paint.ts or shapes.ts; the test of the
// animals fails until it is run.
//   node apps/web/src/design/ascii/tools/plates.ts
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { drawPlateData } from '../plates-draw.ts';

const FILES = [
  { size: 'small', file: '../plates.data.ts', name: 'PLATE_DATA' },
  { size: 'mark', file: '../plates-mark.data.ts', name: 'MARK_PLATE_DATA' },
] as const;

for (const { size, file: relative, name } of FILES) {
  const data = drawPlateData(size);
  const file = fileURLToPath(new URL(relative, import.meta.url));
  // Lines of 100; `atob` skips the line breaks.
  const lines = data.match(/.{1,100}/g) ?? [];
  writeFileSync(
    file,
    [
      '// Written by tools/plates.ts from the shapes of the animals. Do not edit; run the tool again.',
      '// The layout is in plates.ts.',
      `export const ${name} = \`${lines.join('\n')}\`;`,
      '',
    ].join('\n'),
  );
  console.log(`${file}: ${data.length} characters`);
}
