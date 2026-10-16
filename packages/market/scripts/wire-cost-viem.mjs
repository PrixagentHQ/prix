// viem as packages/market/src/wire.ts sees it while scripts/wire-cost.mjs runs: every export of viem
// unchanged, with a counter in front of the two functions that do the work of a read. Nothing in the
// product imports this file.

import { decodeFunctionResult as realDecode, encodeFunctionData as realEncode } from 'viem';

export * from 'viem';

/**
 * `outerEncodes`: how often the calldata of a whole read was built, by the target of its first inner
 * call. `decodes`: how often an answer was decoded, by the function it answers.
 */
export const counts = { outerEncodes: new Map(), decodes: new Map() };

export function resetCounts() {
  counts.outerEncodes.clear();
  counts.decodes.clear();
}

const add = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);

export function encodeFunctionData(parameters) {
  if (parameters.functionName === 'tryBlockAndAggregate') {
    add(counts.outerEncodes, String(parameters.args?.[1]?.[0]?.target).toLowerCase());
  }
  return realEncode(parameters);
}

export function decodeFunctionResult(parameters) {
  add(counts.decodes, String(parameters.functionName));
  return realDecode(parameters);
}
