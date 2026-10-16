import { readFileSync } from 'node:fs';
import { promptSchema } from '@prix/contracts';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { deck } from '../../content/deck.ts';
import type { StrategyTemplate } from './templates.ts';
import { holderTemplates, strategyTemplates, templateWords } from './templates.ts';

/**
 * The eight templates of the Build page (D-155) and the section that shows them. A template is a
 * starting text: its title and line say what it does, never how well, and its prompt is rules for
 * an agent that the contract's own schema accepts. On the page its text is an escaped attribute.
 */

// One hostile template beside the eight, for the container's render only: markup, quotes and an
// ampersand that must reach the page as characters.
const HOSTILE: StrategyTemplate = {
  id: 'hostile',
  title: 'Bold <b>title</b>',
  line: 'A line with <i>markup</i> & "quotes"',
  prompt: 'Hold <b>SPY</b> at 20% & keep "the rest" in cash. <script>alert(1)</script>',
};
const withHostile = vi.hoisted(() => ({ on: false }));
vi.mock('./templates.ts', async (original) => {
  const actual = await original<typeof import('./templates.ts')>();
  return {
    ...actual,
    strategyTemplates: () => [...actual.strategyTemplates(), ...(withHostile.on ? [HOSTILE] : [])],
  };
});

const templates = strategyTemplates();

/** What a title or a line may never say: a figure of any kind, a rank, a result, a promise. */
const NOT_ON_A_TEMPLATE =
  /\d|%|\$|\b(?:best|top|wins?|winning|winner|beats?|outperform\w*|returns?|profit\w*|gains?|loss|yield|rank\w*|perform\w*|guarantee\w*|safe\w*|proven|popular|recommend\w*|advice|should|smart)\b/i;
/** What a prompt may never say: a promise, a forecast, advice to the reader, a target, a person or a firm's view. */
const NOT_IN_A_PROMPT =
  /\b(?:guarantee\w*|promise\w*|profit\w*|best|beats?|outperform\w*|risk-free|safe\w*|can.t lose|will (?:rise|go up|grow|double)|price target|target price|forecast\w*|predict\w*|analysts?|recommend\w*|advice|you should|we think|expect\w*)\b/i;

function attribute(html: string, name: string): string[] {
  return [...html.matchAll(new RegExp(`${name}="([^"]*)"`, 'g'))].map((match) => match[1] ?? '');
}

function unescapeHtml(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&#34;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

describe('the eight strategy templates', () => {
  it('are eight, each with its own id, title and prompt', () => {
    expect(templates).toHaveLength(8);
    for (const key of ['id', 'title', 'line', 'prompt'] as const) {
      expect(new Set(templates.map((template) => template[key])).size).toBe(8);
    }
  });

  it.each(templates.map((template) => [template.id, template] as const))(
    '%s passes the contract’s prompt rules',
    (_id, template) => {
      expect(promptSchema.safeParse(template.prompt).success).toBe(true);
      // The schema trims nothing: the field gets the text exactly as the server rendered it.
      expect(template.prompt).toBe(template.prompt.trim());
    },
  );

  it.each(templates.map((template) => [template.id, template] as const))(
    '%s says what it does in a short title and one line, with no figure and no verdict',
    (_id, template) => {
      expect(template.title.length).toBeLessThan(28);
      expect(template.line.length).toBeLessThan(90);
      expect(template.title).not.toMatch(NOT_ON_A_TEMPLATE);
      expect(template.line).not.toMatch(NOT_ON_A_TEMPLATE);
      expect(template.line).toMatch(/\.$/);
    },
  );

  it.each(templates.map((template) => [template.id, template] as const))(
    '%s reads as rules for an agent, never as a promise, a forecast or advice',
    (_id, template) => {
      expect(template.prompt).not.toMatch(NOT_IN_A_PROMPT);
      // No weight above the contract's 40% in one symbol.
      for (const match of template.prompt.matchAll(/(\d+)%/g)) expect(Number(match[1])).toBeLessThanOrEqual(40);
    },
  );

  it('says in its note that a template is not advice', () => {
    expect(templateWords().note).toMatch(/not advice/);
  });

  it('says "up to a set cap" where the down-days template adds, an instruction and not a certainty', () => {
    const downDays = templates.find((template) => template.id === 'down-days');
    expect(downDays?.line).toBe('Holds a core of SPY and adds to it after a down day, up to a set cap.');
  });
});

describe('the eight holder templates, under the same rules (D-161)', () => {
  const holder = holderTemplates();

  it.each(holder.map((template) => [template.id, template] as const))(
    '%s says what it does in a short title and one line, with no figure and no verdict',
    (_id, template) => {
      expect(template.title.length).toBeLessThan(28);
      expect(template.line.length).toBeLessThan(90);
      expect(template.title).not.toMatch(NOT_ON_A_TEMPLATE);
      expect(template.line).not.toMatch(NOT_ON_A_TEMPLATE);
      expect(template.line).toMatch(/\.$/);
    },
  );

  it.each(holder.map((template) => [template.id, template] as const))(
    '%s reads as rules for an agent, never as a promise, a forecast or advice',
    (_id, template) => {
      expect(template.prompt).not.toMatch(NOT_IN_A_PROMPT);
    },
  );
});

describe('the drafts of this folder', () => {
  // Every `text(key, draft)` here is the deck's own sentence, so the page reads the same with or
  // without the deck's entry, and a reworded key cannot leave an old draft behind.
  const files = ['templates.ts', 'TemplatePicker.astro'];
  const pairs = files.flatMap((file) => {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
    return [...source.matchAll(/\btext\(\s*'([^']+)',\s*'((?:[^'\\]|\\.)*)'/g)].map(
      (match) => [file, match[1] ?? '', (match[2] ?? '').replaceAll("\\'", "'")] as const,
    );
  });

  it('finds the drafts it checks', () => {
    expect(pairs.length).toBeGreaterThan(30);
    expect(pairs.map(([, key]) => key)).toContain('builder.templateKeptSignIn');
  });

  it.each(pairs.map(([file, key, draft]) => [`${file} ${key}`, key, draft] as const))(
    '%s equals the deck',
    (_name, key, draft) => {
      expect(deck[key]).toBe(draft);
    },
  );
});

describe('the section, as the server renders it', () => {
  let container: AstroContainer;
  beforeAll(async () => {
    container = await AstroContainer.create();
  });

  async function render(hostile: boolean, props: Record<string, unknown> = {}): Promise<string> {
    withHostile.on = hostile;
    const { default: TemplatePicker } = await import('./TemplatePicker.astro');
    try {
      return await container.renderToString(TemplatePicker, { props });
    } finally {
      withHostile.on = false;
    }
  }

  it('renders the signed-out section with its own ids, its own hint, a shown status line and no ring', async () => {
    const html = await render(false, { id: 'templates-out', signedOut: true });
    const words = templateWords();
    expect(html).toContain('data-templates-keep');
    expect(html).toContain('id="templates-out-title"');
    expect(html).not.toMatch(/id="templates-(?!out-)/);
    expect(html.split(words.hintSignedOut)).toHaveLength(2);
    expect(html).not.toContain(words.hint);
    expect(html.split(words.note)).toHaveLength(2);
    // The status line: a live region, and a plain link to the sign-in card, hidden until a choice.
    expect(html).toMatch(/<p class="tpl-status"[^>]*><span role="status" data-template-status[^>]*><\/span>/);
    // DC3-2: the link carries the step in its own words.
    expect(html).toMatch(/<a href="#step-sign-in" hidden data-template-sign-in[^>]*>Sign in to continue<\/a>/);
    expect(html).not.toContain('aria-current');
    const scriptWords = JSON.parse(unescapeHtml(attribute(html, 'data-words')[0] ?? '{}'));
    expect(scriptWords).toEqual({ consequence: words.consequenceSignedOut, kept: words.kept, notKept: words.notKept });
    expect(html).not.toMatch(/\sstyle="/);
    expect(html).not.toMatch(/<script/);
  });

  it('says the three signed-out sentences in the operator’s words', () => {
    const words = templateWords();
    expect(words.hintSignedOut).toBe(
      'Choosing one keeps its text for the strategy prompt, ready after you sign in. You can change every word before you build the agent.',
    );
    // DC3-2: the sentence says what was kept; the link after it says the step.
    expect(words.kept).toBe('{title} is ready for the strategy prompt.');
    expect(words.keptSignIn).toBe('Sign in to continue');
    expect(words.notKept).toBe('{title} could not be kept in this browser. Sign in, then choose it again.');
    // DC-T5: no strategy prompt is on the page signed out, so the question names the kept text.
    expect(words.consequenceSignedOut).toBe(
      'The text kept for your strategy prompt is text you wrote. The template {title} takes its place, and your text is not kept.',
    );
  });

  it('has a titled list of eight buttons that never submit the form, and the note once', async () => {
    const html = await render(false);
    expect(html.match(/<button class="tpl-item[^"]*" type="button"/g)).toHaveLength(8);
    expect(html.split(templateWords().note)).toHaveLength(2);
    expect(html).toContain(templateWords().title);
    // The question is in the page and hidden until it is asked.
    expect(html).toMatch(/<div[^>]*data-template-confirm[^>]*>|<div[^>]*hidden[^>]*data-template-confirm/);
    expect(html).toMatch(/role="status"/);
    // No style attribute and no script of its own: the site's CSP holds.
    expect(html).not.toMatch(/\sstyle="/);
    expect(html).not.toMatch(/<script/);
  });

  it('names each button by the deck’s sentence with its title, and describes it by its own line', async () => {
    const html = await render(false);
    const labels = attribute(html, 'aria-label').map(unescapeHtml);
    expect(labels).toEqual(templates.map((template) => templateWords().use.replace('{title}', template.title)));
    for (const label of labels) expect(label).not.toMatch(/\{\w+\}/);
    const described = attribute(html, 'aria-describedby');
    for (const template of templates) {
      const lineId = `templates-line-${template.id}`;
      expect(described).toContain(lineId);
      expect(html).toContain(`id="${lineId}"`);
    }
    // The hint says what a choice does, once, and the section points to it.
    expect(html.split(templateWords().hint)).toHaveLength(2);
    expect(described).toContain('templates-hint templates-note');
  });

  it('carries each template’s text in an attribute that reads back to it exactly', async () => {
    const html = await render(false);
    const carried = attribute(html, 'data-template').map(unescapeHtml);
    expect(carried).toEqual(templates.map((template) => template.prompt));
  });

  it('renders markup in a template as text: in the attribute, the title and the line', async () => {
    const html = await render(true);
    // Inside a quoted attribute `<` is a character, not a tag: Astro escapes `"` and `&` there, so
    // a value cannot end early. Outside the attributes there is no tag of the template's own.
    const outsideAttributes = html.replace(/="[^"]*"/g, '=""');
    expect(outsideAttributes).not.toContain('<b>');
    expect(outsideAttributes).not.toContain('<i>');
    expect(outsideAttributes).not.toContain('<script');
    expect(html).toContain('&amp; keep &quot;the rest&quot;');
    const carried = attribute(html, 'data-template').map(unescapeHtml);
    expect(carried.at(-1)).toBe(HOSTILE.prompt);
    expect(attribute(html, 'data-template-name').map(unescapeHtml).at(-1)).toBe(HOSTILE.title);
    expect(html).toContain('Bold &lt;b&gt;title&lt;/b&gt;');
  });
});
