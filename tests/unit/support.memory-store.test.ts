import { DailyLimitError } from '@prix/contracts';
import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '../support/memory-store.ts';
import { describeStoreContract } from '../support/store-contract.ts';

/**
 * The in-memory store of the tests must itself follow the `Store` contract, or every suite
 * built on it proves nothing. The same checks are meant to run against the D1 store.
 */
describeStoreContract('in-memory store of the tests', async () => {
  const store = createMemoryStore();
  return {
    store,
    seedSeason: async (season) => {
      store.seedSeason(season);
    },
  };
});

describe('the in-memory store and DailyLimitError', () => {
  it('throws the error it is told to, so a suite can prove how its caller handles a used-up daily limit', async () => {
    const store = createMemoryStore();
    store.failing = { method: 'addAiNeurons', times: 1, error: new DailyLimitError() };
    await expect(store.addAiNeurons('2026-10-06', 'decision', 1)).rejects.toBeInstanceOf(DailyLimitError);
    // It fails the number of times it was told to, then works.
    await store.addAiNeurons('2026-10-06', 'decision', 1);
    expect(await store.getAiNeurons('2026-10-06', 'decision')).toBe(1);
  });

  it('has the code the API turns into 503 daily_limit', () => {
    const error = new DailyLimitError();
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('daily_limit');
    expect(error.name).toBe('DailyLimitError');
  });
});
