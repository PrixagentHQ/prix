import { describe, expect, it } from 'vitest';
import { readSources } from '../support/repo.ts';

/**
 * The only wallet interaction the product ever requests is a sign-in signature
 * (CLAUDE.md, docs/CONTRACTS.md section 11): "A wallet is asked for its address and for this
 * signature, and for nothing else: no chain switch, no chain add, no transaction, no
 * approval, no transfer."
 *
 * This test reads the source of the site. The end-to-end test checks the same rule in a
 * running browser, with a wallet that records every request it gets.
 */

/** The wallet requests the site may make: the address, and the sign-in signature. */
const ALLOWED_METHODS = ['eth_requestAccounts', 'eth_accounts', 'personal_sign'];

/** A wallet RPC method, written as a string: 'eth_sendTransaction', "wallet_addEthereumChain". */
const METHOD = /(?<=['"`])(?:eth|wallet|personal|net|web3)_[A-Za-z0-9_]+(?=['"`])/g;

/** Calls that move funds, grant an allowance, sign structured data or change the chain. */
const FORBIDDEN_CALLS: [RegExp, string][] = [
  [/\bsend(?:Raw)?Transaction\b/, 'sends a transaction'],
  [/\bsignTransaction\b/, 'signs a transaction'],
  [/\bsignTypedData\b/, 'signs typed data, which can be a token permit'],
  [/\bwriteContract\b/, 'writes to a contract'],
  [/\bsimulateContract\b/, 'prepares a contract write'],
  [/\bsendCalls\b/, 'sends a batch of calls'],
  [/\bswitchChain\b/, 'switches the chain of the wallet'],
  [/\baddChain\b/, 'adds a chain to the wallet'],
  [/\bwatchAsset\b/, 'adds a token to the wallet'],
  [/\bcreateWalletClient\b/, 'builds a client that can send transactions'],
  [
    /\b(?:approve|increaseAllowance|setApprovalForAll|permit|transferFrom)\s*\(/,
    'calls a token function that moves or releases funds',
  ],
];

interface Finding {
  file: string;
  line: number;
  what: string;
}

function findWalletMethods(file: string, source: string): Finding[] {
  const found: Finding[] = [];
  for (const match of source.matchAll(METHOD)) {
    if (ALLOWED_METHODS.includes(match[0])) continue;
    found.push({ file, line: source.slice(0, match.index).split('\n').length, what: match[0] });
  }
  return found;
}

function findForbiddenCalls(file: string, source: string): Finding[] {
  const found: Finding[] = [];
  const lines = source.split('\n');
  lines.forEach((text, index) => {
    for (const [pattern, what] of FORBIDDEN_CALLS) {
      if (pattern.test(text)) found.push({ file, line: index + 1, what });
    }
  });
  return found;
}

const sources = readSources('apps/web/src', ['.astro', '.ts', '.tsx', '.js', '.jsx', '.mjs'], (path) =>
  path.includes('/design/studies'),
);
const describeFindings = (findings: Finding[]): string =>
  findings.map((item) => `${item.file}:${item.line} ${item.what}`).join('\n');

describe('the site asks a wallet for an address and a sign-in signature, and nothing else', () => {
  it('reads the source of the site', () => {
    expect(sources.length).toBeGreaterThan(5);
  });

  it('names no wallet request other than eth_requestAccounts, eth_accounts and personal_sign', () => {
    const found = sources.flatMap((file) => findWalletMethods(file.path, file.source));
    expect(found, describeFindings(found)).toEqual([]);
  });

  it('has no code that sends a transaction, grants an approval, signs typed data or changes the chain', () => {
    const found = sources.flatMap((file) => findForbiddenCalls(file.path, file.source));
    expect(found, describeFindings(found)).toEqual([]);
  });

  it('never stores a session or a signature where a script can read it', () => {
    const found: Finding[] = [];
    for (const file of sources) {
      file.source.split('\n').forEach((text, index) => {
        // What is written is what follows the call. The name of the storage itself ("sessionStorage") is not a finding.
        const write = /(?:localStorage|sessionStorage)\s*\.\s*setItem\s*\(|document\s*\.\s*cookie\s*=/.exec(text);
        if (!write) return;
        const written = text.slice(write.index + write[0].length);
        if (/session|token|signature|prix_/i.test(written)) {
          found.push({ file: file.path, line: index + 1, what: 'keeps a session where a script can read it' });
        }
      });
    }
    expect(found, describeFindings(found)).toEqual([]);
  });
});

describe('the scanner of this test', () => {
  it('lets the sign-in requests through', () => {
    const source =
      "await provider.request({ method: 'eth_requestAccounts' });\nawait provider.request({ method: 'personal_sign', params: [message, address] });";
    expect(findWalletMethods('a.ts', source)).toEqual([]);
    expect(findForbiddenCalls('a.ts', source)).toEqual([]);
  });

  it.each([
    'eth_sendTransaction',
    'eth_sendRawTransaction',
    'eth_signTransaction',
    'eth_sign',
    'eth_signTypedData_v4',
    'wallet_switchEthereumChain',
    'wallet_addEthereumChain',
    'wallet_watchAsset',
    'wallet_requestPermissions',
    'wallet_sendCalls',
    'eth_chainId',
  ])('catches %s', (method) => {
    expect(
      findWalletMethods('a.ts', `await provider.request({ method: '${method}' });`).map((item) => item.what),
    ).toEqual([method]);
  });

  it.each([
    'await walletClient.sendTransaction({ to, value });',
    'await client.writeContract({ address, abi, functionName });',
    'await token.approve(spender, amount);',
    'const client = createWalletClient({ transport: custom(provider) });',
    'await walletClient.signTypedData(permit);',
    'await walletClient.switchChain({ id: 4663 });',
    'await erc20.transferFrom(owner, me, amount);',
  ])('catches %s', (line) => {
    expect(findForbiddenCalls('a.ts', line)).toHaveLength(1);
  });
});
