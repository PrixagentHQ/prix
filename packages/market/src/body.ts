/**
 * The most bytes of one RPC answer that a chain reader of this package reads (docs/CONTRACTS.md
 * section 20; security review of the newest reads, finding 5). The Robinhood multicall answer (20 Stock
 * Tokens and two crypto assets, section 21; 66 inner calls) and the Arbitrum one (three crypto assets
 * and the sequencer feed, section 23; 10 inner calls) are a few kilobytes each, so the cap never
 * touches an honest answer of the snapshot or of `createRpc`.
 */
export const RPC_MAX_RESPONSE_BYTES = 256 * 1024;

/** The body was larger than the cap. Nothing past the cap was read. */
export const TOO_LARGE = Symbol('too large');

/**
 * Reads a response body as UTF-8 text, at most `maxBytes` bytes. A Content-Length over the cap is
 * refused before a byte is read; without one, or with one that lies, the stream is counted as it
 * arrives and cancelled as soon as it passes the cap. Either way the body is released and
 * `TOO_LARGE` comes back. A failure of the stream itself (the time limit, a lost connection) is
 * thrown, as `response.text()` would.
 */
export async function readCappedText(
  response: Response,
  maxBytes: number = RPC_MAX_RESPONSE_BYTES,
): Promise<string | typeof TOO_LARGE> {
  const declared = response.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared.trim()) && Number(declared.trim()) > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    return TOO_LARGE;
  }
  const body = response.body;
  if (body === null) return '';
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return TOO_LARGE;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}
