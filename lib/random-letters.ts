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
  const per = Math.floor(256 / alphabet.length);
  const limit = per * alphabet.length;
  let out = "";
  while (out.length < length) {
    for (const byte of globalThis.crypto.getRandomValues(new Uint8Array(length - out.length + 4))) {
      if (byte < limit && out.length < length) out += alphabet[Math.floor(byte / per)];
    }
  }
  return out;
}
