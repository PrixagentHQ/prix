import { ARBITRUM_SEQUENCER_GRACE_SECONDS, otherChainProblemSchema } from '@prix/contracts';
import { describe, expect, it } from 'vitest';
import { ARB_OFFICIAL } from '../support/fake-arbitrum.ts';
import { createRng } from '../support/prng.ts';
import {
  arbitrumReadOf,
  isUnread,
  judgeSequencer,
  NOW,
  NOW_SECONDS,
  pointOf,
  robinhoodPoints,
  scene,
} from './support.ts';

/**
 * The sequencer rule of docs/CONTRACTS.md section 23, rule 5, and its effect (rule 7). The uptime
 * feed not read, or `startedAt` 0 or in the future: `sequencer_unknown`. An answer other than 0:
 * `sequencer_down`. Up for ARBITRUM_SEQUENCER_GRACE_SECONDS or less, measured from the snapshot
 * time: `sequencer_grace`. Otherwise trusted. Any of them makes every Arbitrum point unread and
 * never closes the market.
 */

const GRACE = ARBITRUM_SEQUENCER_GRACE_SECONDS;
const NOW_S = 1_791_810_000;

describe('judgeSequencer, the pure rule', () => {
  it('is 3,600 seconds of grace, as Chainlink sets it', () => {
    expect(GRACE).toBe(3_600);
  });

  it('is unknown when the uptime feed was not read', () => {
    expect(judgeSequencer()(null, NOW_S, GRACE)).toBe('sequencer_unknown');
  });

  it('is down for any answer other than 0', () => {
    for (const answer of [1n, 2n, -1n, 2n ** 255n]) {
      expect(judgeSequencer()({ answer, startedAt: BigInt(NOW_S - 86_400) }, NOW_S, GRACE), String(answer)).toBe(
        'sequencer_down',
      );
    }
  });

  it('is down before anything else is looked at, even with startedAt 0', () => {
    expect(judgeSequencer()({ answer: 1n, startedAt: 0n }, NOW_S, GRACE)).toBe('sequencer_down');
  });

  it('is unknown when startedAt is 0, the feed not initialised', () => {
    expect(judgeSequencer()({ answer: 0n, startedAt: 0n }, NOW_S, GRACE)).toBe('sequencer_unknown');
  });

  it('is unknown when startedAt is in the future, by even one second', () => {
    expect(judgeSequencer()({ answer: 0n, startedAt: BigInt(NOW_S + 1) }, NOW_S, GRACE)).toBe('sequencer_unknown');
    expect(judgeSequencer()({ answer: 0n, startedAt: 2n ** 200n }, NOW_S, GRACE)).toBe('sequencer_unknown');
  });

  it('is in grace while it has been up for the grace period or less, edges included', () => {
    for (const up of [0, 1, GRACE - 1, GRACE]) {
      expect(judgeSequencer()({ answer: 0n, startedAt: BigInt(NOW_S - up) }, NOW_S, GRACE), `up ${up} s`).toBe(
        'sequencer_grace',
      );
    }
  });

  it('is trusted once it has been up for longer than the grace period', () => {
    for (const up of [GRACE + 1, 86_400, NOW_S - 1]) {
      expect(judgeSequencer()({ answer: 0n, startedAt: BigInt(NOW_S - up) }, NOW_S, GRACE), `up ${up} s`).toBeNull();
    }
  });

  it('takes the grace it is given, not a constant of its own', () => {
    const read = { answer: 0n, startedAt: BigInt(NOW_S - 100) };
    expect(judgeSequencer()(read, NOW_S, 99)).toBeNull();
    expect(judgeSequencer()(read, NOW_S, 100)).toBe('sequencer_grace');
  });

  it('only ever answers null or one of the three sequencer problems, and never throws', () => {
    const rng = createRng(23);
    const allowed = new Set([null, 'sequencer_down', 'sequencer_grace', 'sequencer_unknown']);
    for (let i = 0; i < 2_000; i += 1) {
      const answer = BigInt(rng.int(-1, 1));
      const startedAt = BigInt(rng.chance(0.05) ? 0 : rng.int(NOW_S - 10_000, NOW_S + 100));
      const verdict = judgeSequencer()({ answer, startedAt }, NOW_S, GRACE);
      expect(allowed.has(verdict)).toBe(true);
      if (verdict !== null) expect(otherChainProblemSchema.safeParse(verdict).success).toBe(true);
      const expected =
        answer !== 0n
          ? 'sequencer_down'
          : startedAt === 0n || startedAt > BigInt(NOW_S)
            ? 'sequencer_unknown'
            : BigInt(NOW_S) - startedAt <= BigInt(GRACE)
              ? 'sequencer_grace'
              : null;
      expect(verdict).toBe(expected);
    }
  });
});

describe('the sequencer in a snapshot', () => {
  const cases: [string, Parameters<ReturnType<typeof scene>['rpc']['arbitrum']['set']>[0], string][] = [
    ['down', { sequencer: { answer: 1n, startedAt: BigInt(NOW_SECONDS - 600) } }, 'sequencer_down'],
    ['up for half an hour', { sequencer: { answer: 0n, startedAt: BigInt(NOW_SECONDS - 1_800) } }, 'sequencer_grace'],
    ['not read', { sequencer: 'reverts' }, 'sequencer_unknown'],
    ['not initialised', { sequencer: { answer: 0n, startedAt: 0n } }, 'sequencer_unknown'],
    [
      'started in the future',
      { sequencer: { answer: 0n, startedAt: BigInt(NOW_SECONDS + 3_600) } },
      'sequencer_unknown',
    ],
  ];

  for (const [label, patch, problem] of cases) {
    it(`a sequencer ${label} unreads SOL, BNB and HYPE, says ${problem}, and leaves the market as it was`, async () => {
      const healthy = await scene().take();
      const s = scene();
      s.rpc.arbitrum.set(patch);
      const snapshot = await s.take();
      expect(snapshot).toMatchObject({ open: true, closedReason: null, takenAt: NOW.toISOString() });
      expect(arbitrumReadOf(snapshot)?.problem).toBe(problem);
      for (const symbol of ['BNB', 'HYPE', 'SOL']) expect(isUnread(pointOf(snapshot, symbol)), symbol).toBe(true);
      expect(robinhoodPoints(snapshot)).toEqual(robinhoodPoints(healthy));
    });
  }

  it('measures the grace from the snapshot time, not from the block time', async () => {
    // The block is two seconds old. Up for exactly the grace at the snapshot time is still grace,
    // though from the block time it would be inside it by two seconds less.
    const s = scene();
    s.rpc.arbitrum.set({ sequencer: { answer: 0n, startedAt: BigInt(NOW_SECONDS - GRACE) } });
    expect(arbitrumReadOf(await s.take())?.problem).toBe('sequencer_grace');
    // One second more, measured from the snapshot time: trusted. From the block time it would be
    // 3,599 seconds, still grace.
    const t = scene();
    t.rpc.arbitrum.set({ sequencer: { answer: 0n, startedAt: BigInt(NOW_SECONDS - GRACE - 1) } });
    const snapshot = await t.take();
    expect(arbitrumReadOf(snapshot)?.problem).toBeNull();
    expect(pointOf(snapshot, 'SOL')).toMatchObject({ priceMicro: 152_880_000, fresh: true });
  });

  it('is read on the official endpoint in the same request as the feeds', async () => {
    const s = scene();
    await s.take();
    const requests = s.rpc.arbitrum.requestsTo(ARB_OFFICIAL);
    expect(requests).toHaveLength(1);
    const targets = new Set(requests[0]?.calls.map((call) => call.target));
    expect(targets.has('0xfdb631f5ee196f0ed6faa767959853a9f217697d')).toBe(true);
  });
});
