import { describe, expect, it } from 'vitest';
import { keccak256, siweMessage, testWallet, toHex, walletFromPrivateKey } from '../support/eth.ts';

/**
 * The test wallet signs the sign-in messages of the integration tests. These checks pin it
 * to published vectors, so a sign-in test that fails is a finding about the API and not
 * about the test wallet.
 */
describe('test wallet (support)', () => {
  const bytes = (text: string) => new TextEncoder().encode(text);

  it('computes keccak-256 of the published vectors', () => {
    expect(toHex(keccak256(bytes('')))).toBe('c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
    expect(toHex(keccak256(bytes('abc')))).toBe('4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
    // Longer than one 136-byte block.
    expect(toHex(keccak256(bytes('a'.repeat(200))))).toHaveLength(64);
    expect(toHex(keccak256(bytes('a'.repeat(135))))).not.toBe(toHex(keccak256(bytes('a'.repeat(136)))));
  });

  it('derives the well-known address of private key 1, with its EIP-55 checksum', () => {
    const wallet = walletFromPrivateKey(1n);
    expect(wallet.address).toBe('0x7e5f4552091a69125d5dfcb7b8c2659029395bdf');
    expect(wallet.checksumAddress).toBe('0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf');
  });

  it('signs deterministically, with a 65-byte signature and a low s value', async () => {
    const wallet = testWallet(1);
    const first = await wallet.signMessage('hello');
    const second = await wallet.signMessage('hello');
    expect(first).toBe(second);
    expect(first).toMatch(/^0x[0-9a-f]{130}$/);
    expect(['1b', '1c']).toContain(first.slice(-2));
    const s = BigInt(`0x${first.slice(66, 130)}`);
    expect(s <= 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n).toBe(true);
    expect(await wallet.signMessage('hello!')).not.toBe(first);
  });

  it('gives different wallets different addresses', () => {
    expect(testWallet(1).address).not.toBe(testWallet(2).address);
    expect(testWallet(1).address).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it('writes a sign-in message in the EIP-4361 layout', () => {
    const message = siweMessage({
      domain: 'prix.test',
      address: '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf',
      statement: 'Sign in.',
      uri: 'https://prix.test',
      chainId: 4663,
      nonce: 'abcdefgh12345678',
      issuedAt: '2026-10-06T14:00:00.000Z',
    });
    expect(message).toBe(
      [
        'prix.test wants you to sign in with your Ethereum account:',
        '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf',
        '',
        'Sign in.',
        '',
        'URI: https://prix.test',
        'Version: 1',
        'Chain ID: 4663',
        'Nonce: abcdefgh12345678',
        'Issued At: 2026-10-06T14:00:00.000Z',
      ].join('\n'),
    );
  });
});
