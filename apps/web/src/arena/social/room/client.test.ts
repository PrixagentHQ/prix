// The read of the Community chat as the page makes it, against the sample answers
// (docs/contracts/phase-6-pictures.md, sections 10 and 14). A read that parsed with the room's older, strict
// schema would refuse an answer that carries `picture` or `pictures`, and /chat would show its failure
// state in production only: this file is what fails first.
// Run: pnpm exec vitest run --config apps/web/src/arena/vitest.config.ts
import { beforeAll, describe, expect, it } from 'vitest';
import type { Context } from '../client.ts';

/** The sample build's switch, set before the client is loaded: its reads then answer from the fixtures. */
let fetchRoom: typeof import('./client.ts').fetchRoom;
beforeAll(async () => {
  (globalThis as { __PRIX_FIXTURES__?: boolean }).__PRIX_FIXTURES__ = true;
  ({ fetchRoom } = await import('./client.ts'));
});

function asked(fixture: string | null): Context {
  const url = new URL('http://127.0.0.1/chat');
  if (fixture !== null) url.searchParams.set('fixture', fixture);
  // The read keeps its answers of one request in `locals`; nothing else of a request's locals is asked.
  return { request: new Request(url), url, locals: {} as Context['locals'] };
}

describe('the read of the room', () => {
  it('takes an answer of the API before pictures, with neither new field', async () => {
    const read = await fetchRoom(asked(null));
    if (!read.ok) throw new Error(`the read failed with ${read.status}`);
    expect(read.data.pictures).toBeUndefined();
    expect(read.data.messages.length).toBeGreaterThan(0);
    for (const message of read.data.messages) expect(message.picture).toBeUndefined();
  });

  it('takes an answer with pictures: the state of the room and a picture on a message', async () => {
    const read = await fetchRoom(asked('social-room-pictures'));
    if (!read.ok) throw new Error(`the read failed with ${read.status}`);
    expect(read.data.pictures).toBe('on');
    expect(read.data.messages.some((message) => message.picture?.state === 'shown')).toBe(true);
    expect(read.data.messages.some((message) => message.picture === null)).toBe(true);
  });

  it.each([
    ['social-room-pictures-off', 'off'],
    ['social-room-pictures-resting', 'resting'],
  ])('takes %s as pictures %s', async (fixture, pictures) => {
    const read = await fetchRoom(asked(fixture));
    if (!read.ok) throw new Error(`the read failed with ${read.status}`);
    expect(read.data.pictures).toBe(pictures);
  });
});
