import { testWallet } from './eth.ts';

/**
 * The wallets of the end-to-end tests, in one place so that the specs and the stack agree.
 *
 * A new wallet may not create an agent until ten minutes after its first sign-in, and one network
 * may create three agents a day (docs/contracts/phase-2-reputation.md section 8). A test cannot
 * wait ten minutes and every test comes from one network, so the wallets that create an agent are
 * named as house wallets when the stack starts. The rules themselves are tested in
 * tests/reputation/creation-guard.test.ts and tests/workers.
 *
 *   PRIX_E2E_RUN=1 node tests/support/e2e-wallets.ts      prints the value for `pnpm stack --house`
 *
 * The default run number is 1. One run number makes one set of wallets, and each wallet creates one agent, so a second run on
 * the same stack needs a new number or `pnpm stack --fresh`.
 */
export function e2eRun(): number {
  return Number(process.env.PRIX_E2E_RUN ?? 1);
}

/** The wallet numbers a run uses to create an agent: the browser test, then the API test and its second wallet. */
export function e2eCreatorNumbers(run: number): number[] {
  return [run * 10 + 1, run * 10 + 2, run * 10 + 3, run * 10 + 4, run * 10 + 3 + 1000, run * 10 + 4 + 1000];
}

if (process.argv[1]?.endsWith('e2e-wallets.ts')) {
  console.log(
    e2eCreatorNumbers(e2eRun())
      .map((n) => testWallet(n).address)
      .join(','),
  );
}
