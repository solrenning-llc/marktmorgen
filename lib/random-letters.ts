/**
 * Letters drawn evenly from an alphabet, with the Web Crypto source, so the
 * same code runs in the browser and on the server.
 *
 * A random byte taken modulo the alphabet's length favours its first letters
 * whenever 256 is not a multiple of that length (36 letters: the first four
 * come out 8/256 of the time, the rest 7/256). Here a byte is kept only below
 * the largest multiple of the length that fits in a byte, and the others are
 * thrown away and drawn again, so every letter is as likely as any other.
 * Server code that can import node:crypto uses its randomInt instead.
 */
export function randomLetters(alphabet: string, length: number): string {
  if (alphabet.length < 1 || alphabet.length > 256) throw new RangeError("The alphabet has 1 to 256 letters.");
  // Each kept byte names one letter through a table: the same number of bytes for every letter, and no arithmetic
  // on the random value itself (which CodeQL cannot tell from a biased modulo).
  const byByte = lettersByByte(alphabet);
  let out = "";
  while (out.length < length) {
    for (const byte of globalThis.crypto.getRandomValues(new Uint8Array(length - out.length + 4))) {
      const letter = byByte[byte];
      if (letter !== undefined && out.length < length) out += letter;
    }
  }
  return out;
}

/** The letter each byte stands for: the first `per` bytes the first letter, and so on; the bytes past the last whole share stand for none. */
export function lettersByByte(alphabet: string): readonly (string | undefined)[] {
  const per = Math.floor(256 / alphabet.length);
  return Array.from({ length: 256 }, (_, byte) => (byte < per * alphabet.length ? alphabet[Math.floor(byte / per)] : undefined));
}
