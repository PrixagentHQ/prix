// The holders' tape and the room's Holder mark as Astro renders them (docs/contracts/phase-6-holders-2.md,
// sections 2.1 and 3.2): the sentence that nothing is advice above the list in every view, the one sentence
// of the view, the empty and failed states, no green or red on a row, no script, and the Holder mark beside
// exactly the writers the read marks. Run: pnpm exec vitest run --config apps/web/src/arena/tape/vitest.config.ts

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { RoomWithPicturesResponse, TapeResponse } from '@prix/contracts';
import { HOLDERS2_PAGE_WORDS } from '@prix/contracts';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Read } from '../social/client.ts';
import { roomSample } from '../social/room/fixtures.ts';
import MessageList from '../social/room/MessageList.astro';
import { tapeSample } from './fixtures.ts';
import TapeBody from './TapeBody.astro';

const W = HOLDERS2_PAGE_WORDS;

let container: AstroContainer;
beforeAll(async () => {
  container = await AstroContainer.create();
});

type Renderable = Parameters<AstroContainer['renderToString']>[0];

async function render(component: Renderable, props: Record<string, unknown>): Promise<string> {
  const html = await container.renderToString(component, { props, request: new Request('https://prixagent.com/tape') });
  return html.replace(/ data-astro-source-(?:file|loc)="[^"]*"/g, '');
}

function decode(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&#34;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&#x27;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

/** The words of a page as a person reads them. */
function words(html: string): string {
  return decode(
    html
      .replace(/<style[\s\S]*?<\/style>/g, ' ')
      .replace(/<script[\s\S]*?<\/script>/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' '),
  );
}

const read = (data: TapeResponse | null): Read<TapeResponse> => {
  if (data === null) throw new Error('no sample');
  return { ok: true, status: 200, data };
};

describe('the tape', () => {
  for (const [name, view] of [
    [null, W['tape.viewDelayed']],
    ['tape-live', W['tape.viewLive']],
    ['tape-open', W['tape.viewOpen']],
  ] as const) {
    it(`says nothing is advice above the list, and one sentence of the view (${name ?? 'default'})`, async () => {
      const html = await render(TapeBody, { result: read(tapeSample(name)) });
      const text = words(html);
      const advice = html.indexOf('data-tape-advice');
      const list = html.search(/<ol[^>]*\sdata-tape[\s>=]/);
      expect(advice).toBeGreaterThan(-1);
      expect(list).toBeGreaterThan(advice);
      expect(text).toContain(W['tape.notAdvice']);
      expect(text).toContain(view);
      const others = [W['tape.viewDelayed'], W['tape.viewLive'], W['tape.viewOpen']].filter((entry) => entry !== view);
      for (const other of others) expect(text).not.toContain(other);
      expect(text).toContain(W['tape.liveHold']);
      expect(text).toContain(W['tape.title']);
      expect(text).toContain(W['tape.description']);
    });

    it(`says "Nothing here is advice" once, and keeps the Live hold and the scale in one grey note under it (${name ?? 'default'})`, async () => {
      // DC-H2-1: on a phone the list must start on the first screen. The head says the simulation only;
      // tape.notAdvice says the advice line once; the hold and the scale stand in one note after it, still
      // above the list as the contract's 3.2 orders them.
      const html = await render(TapeBody, { result: read(tapeSample(name)) });
      const text = words(html);
      expect(text.match(/Nothing here is advice/g) ?? []).toHaveLength(1);
      expect(text).toContain('Paper trading simulation.');
      const advice = html.indexOf('data-tape-advice');
      const note = html.indexOf('data-tape-note');
      const list = html.search(/<ol[^>]*\sdata-tape[\s>=]/);
      expect(note).toBeGreaterThan(advice);
      expect(list).toBeGreaterThan(note);
      const noteHtml = html.slice(note, list);
      expect(words(noteHtml)).toContain(W['tape.liveHold']);
      expect(words(noteHtml)).toContain(W['tape.scale'].replace('{count}', '40'));
      expect(html.slice(0, advice)).not.toContain(W['tape.liveHold']);
    });
  }

  it('shows every decision as a row with its agent’s link and its tag, and ships no script', async () => {
    const sample = tapeSample('tape-full');
    const html = await render(TapeBody, { result: read(sample) });
    expect((html.match(/data-feed-row/g) ?? []).length).toBe(sample?.items.length);
    for (const item of sample?.items ?? []) expect(html).toContain(`href="/agents/${item.agentId}"`);
    expect(html).not.toMatch(/<script/i);
  });

  it('puts no green or red on a row, and no word of judgement', async () => {
    const html = await render(TapeBody, { result: read(tapeSample('tape-full')) });
    expect(html).not.toMatch(/class="[^"]*\b(?:gain|loss)\b/);
    expect(html).not.toMatch(/var\(--(?:green|red)\)/);
    expect(words(html)).not.toMatch(/\b(?:good|bad|winner|loser|best|worst)\b/i);
  });

  it('says plainly that there is nothing yet, still under the sentence that nothing is advice', async () => {
    const html = await render(TapeBody, { result: read(tapeSample('tape-empty')) });
    expect(words(html)).toContain(W['tape.empty']);
    expect(words(html)).toContain(W['tape.notAdvice']);
    expect(html).not.toMatch(/<ol[^>]*\sdata-tape[\s>=]/);
  });

  it('gives the empty tape one way onward, to the league (DC-H2-5)', async () => {
    const html = await render(TapeBody, { result: read(tapeSample('tape-empty')) });
    const empty = html.slice(html.indexOf('data-tape-empty'));
    expect(empty).toMatch(/href="\/league"/);
    expect(words(empty)).toContain('Go to the league');
  });

  it('says a read that failed in words, with no view sentence and no row', async () => {
    const failed: Read<TapeResponse> = {
      ok: false,
      status: 500,
      error: { code: 'internal', message: 'Something went wrong on our side. Try again.', field: null },
    };
    const html = await render(TapeBody, { result: failed });
    expect(html).toContain('notice--error');
    expect(html).not.toContain('data-feed-row');
    expect(words(html)).not.toContain(W['tape.viewDelayed']);
  });
});

describe('the room’s Holder mark', () => {
  it('stands beside exactly the writers the read marks, with its label and no figure', async () => {
    const room = roomSample('social-room-pictures-holders') as RoomWithPicturesResponse;
    const html = await render(MessageList, { messages: room.messages, pictures: room.pictures, labelledBy: 'x' });
    const marked = room.messages.filter((message) => message.holder === true).length;
    expect((html.match(/class="room-holder/g) ?? []).length).toBe(marked);
    expect((html.match(new RegExp(W['social.roomHolderMarkLabel'].replace(/[.$]/g, '\\$&'), 'g')) ?? []).length).toBe(
      marked,
    );
    const items = html.split('<li').slice(1);
    room.messages.forEach((message, index) => {
      const item = items[index] ?? '';
      expect(item.includes('room-holder'), String(message.id)).toBe(message.holder === true);
    });
    const markWords = [...html.matchAll(/class="room-holder[^"]*"[^>]*>([\s\S]*?)<\/span>\s*<\/span>/g)].map((m) =>
      words(m[1] ?? ''),
    );
    for (const entry of markWords) expect(entry).not.toMatch(/\d/);
  });

  it('is quieter than the Prix mark in both themes: the address’s grey, regular weight, no fill (DC-H2-2)', () => {
    // The dark theme's --quiet-ink is the ink itself, so a chip in it read as a second official pill.
    const source = readFileSync(fileURLToPath(new URL('../social/room/HolderMark.astro', import.meta.url)), 'utf8');
    const rule = source.match(/\.room-holder\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toMatch(/color:\s*var\(--grey\)/);
    expect(rule).toMatch(/font-weight:\s*var\(--weight-regular\)/);
    expect(rule).not.toMatch(/--quiet-ink|--quiet-fill|background/);
  });

  it('is absent from a read that carries no holder field', async () => {
    const room = roomSample('social-room-pictures') as RoomWithPicturesResponse;
    const html = await render(MessageList, { messages: room.messages, pictures: room.pictures, labelledBy: 'x' });
    expect(html).not.toContain('room-holder');
  });
});
