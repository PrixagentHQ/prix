// The exit rule of room-pictures.mjs (docs/contracts/phase-6-pictures.md, section 14, perf's row, revision
// 5): the script exits 1 only when a figure it prints from the constants differs from the document. This
// file holds the comparison and the rule; it measures nothing.
//
// A claim is one phrase of the document with its figure built from the constants: `{ section, what, says }`.
// It holds when the text of that section contains `says`. Only the named section is read, because the
// document's history (sections 20 to 24) quotes the figures of earlier revisions.

/** The text of the section whose heading is `## <number>. ...`, up to the next heading of that level. */
export function sectionOf(text, number) {
  const start = text.search(new RegExp(`^## ${number}\\. `, 'm'));
  if (start === -1) throw new Error(`The document has no section ${number}.`);
  const next = text.slice(start + 3).search(/^## /m);
  return next === -1 ? text.slice(start) : text.slice(start, start + 3 + next);
}

/** One line for each claim the document does not hold, naming the figure and where it was looked for. */
export function differencesFromDocument(text, claims) {
  const sections = new Map();
  const differences = [];
  for (const claim of claims) {
    if (!sections.has(claim.section)) sections.set(claim.section, sectionOf(text, claim.section));
    if (!sections.get(claim.section).includes(claim.says)) {
      differences.push(
        `${claim.what}: the constants give "${claim.says}", which section ${claim.section} does not say`,
      );
    }
  }
  return differences;
}

/**
 * 1 when a figure printed from the constants differs from the document, 0 otherwise. A warning (a time
 * measured on this machine, a count read in local workerd) is printed and never moves the exit code.
 */
export function exitCodeOf({ differences }) {
  return differences.length === 0 ? 0 : 1;
}
