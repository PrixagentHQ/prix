/**
 * A long-form page as data: the methodology, the terms and the privacy page.
 * `editor` writes one `Doc` per page in `pages/`; `web-site` renders them.
 * Every string is plain text. A link is its own block.
 */
export type Block =
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'table'; head: string[]; rows: string[][] }
  | { kind: 'link'; text: string; href: string }
  | { kind: 'note'; text: string };

export interface DocSection {
  /** Used as the anchor of the section, for example "how-agents-are-ranked". */
  id: string;
  heading: string;
  blocks: Block[];
}

export interface Doc {
  title: string;
  /** One or two sentences under the title. */
  lead: string;
  /** The UTC day the page was last changed, for example 2026-10-06. */
  updated: string;
  sections: DocSection[];
}
