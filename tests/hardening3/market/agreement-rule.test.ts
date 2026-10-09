import { independent, readWithAgreement } from '@prix/market/agreement';
import { describe, expect, it } from 'vitest';
import { DRPC, OFFICIAL, PUBLICNODE } from './support.ts';

/** The two-endpoint rule without a network: each endpoint is a function of its URL. */

class Transient extends Error {}
const rule = { movesOn: (e: unknown) => e instanceof Transient, agree: (a: number, b: number) => a === b };

function reader(answers: Record<string, number | 'transient' | 'refused'>) {
  const asked: string[] = [];
  const read = async (url: string) => {
    asked.push(url);
    const a = answers[url];
    if (a === undefined || a === 'transient') throw new Transient();
    if (a === 'refused') throw new Error('refused');
    return a;
  };
  return { asked, read };
}

describe('readWithAgreement', () => {
  it('does not let a second endpoint on the same host confirm a third party', async () => {
    const twin = `${PUBLICNODE}/other-path`;
    const { asked, read } = reader({ [PUBLICNODE]: 7, [twin]: 7 });
    const agreed = await readWithAgreement([PUBLICNODE, twin], read, rule);
    expect(agreed).toEqual({ ok: false, reason: 'unconfirmed' });
    expect(asked).toEqual([PUBLICNODE]);
    expect(independent(PUBLICNODE, twin)).toBe(false);
  });

  it('ends the read on a refusal, without asking the next endpoint', async () => {
    const { asked, read } = reader({ [OFFICIAL]: 'refused', [PUBLICNODE]: 7, [DRPC]: 7 });
    const agreed = await readWithAgreement([OFFICIAL, PUBLICNODE, DRPC], read, rule);
    expect(agreed.ok).toBe(false);
    expect(asked).toEqual([OFFICIAL]);
  });

  it('skips a second endpoint that fails in transport and asks the next independent one', async () => {
    const third = 'https://third.example/rpc';
    const { read } = reader({ [PUBLICNODE]: 7, [DRPC]: 'transient', [third]: 7 });
    const agreed = await readWithAgreement([PUBLICNODE, DRPC, third], read, rule);
    expect(agreed).toEqual({ ok: true, value: 7, confirmation: 7 });
  });

  it('fails closed when the second endpoint refuses', async () => {
    const { read } = reader({ [PUBLICNODE]: 7, [DRPC]: 'refused' });
    expect(await readWithAgreement([PUBLICNODE, DRPC], read, rule)).toEqual({ ok: false, reason: 'unconfirmed' });
  });

  it('takes a third party alone when its answer grants nothing', async () => {
    const { asked, read } = reader({ [PUBLICNODE]: 0, [DRPC]: 0 });
    const agreed = await readWithAgreement([PUBLICNODE, DRPC], read, { ...rule, needsConfirmation: (v) => v > 0 });
    expect(agreed).toEqual({ ok: true, value: 0, confirmation: null });
    expect(asked).toEqual([PUBLICNODE]);
  });
});
