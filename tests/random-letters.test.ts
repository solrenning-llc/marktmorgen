/**
 * Random ids and codes drawn evenly (CodeQL js/biased-cryptographic-random).
 * A random byte taken modulo an alphabet of 31 or 36 letters favours its
 * first letters; every id and code below is drawn with node:crypto's
 * randomInt on the server, or with lib/random-letters.ts where the code also
 * runs in the browser. What is checked:
 *
 *   - randomLetters keeps the alphabet and the length, and given every byte
 *     once gives every letter exactly as often, throwing the rest away;
 *   - the ids made with it keep their old shapes (certificates, course items,
 *     numbers links);
 *   - no file that draws ids or codes takes a random value modulo a length
 *     any more. Invite codes and short links have their shapes checked in
 *     tests/creator-invites.test.ts and tests/short-links.test.ts, inbox ids
 *     in tests/inbox.test.ts, the six-digit and recovery codes in
 *     tests/recovery-address.test.ts and tests/two-step.test.ts.
 */
import { readFileSync } from "node:fs";
import { randomLetters } from "@/lib/random-letters";
import { CERT_ID_PATTERN, newCertificateId } from "@/lib/certificate";
import { newItemId } from "@/lib/course";
import { makeLink } from "@/lib/numbers-links";
import { done, is, part } from "./check";

const LETTERS_36 = "abcdefghijklmnopqrstuvwxyz0123456789";
const LETTERS_31 = "abcdefghjkmnpqrstuvwxyz23456789";

/** Counts of each letter over one draw where the source gives every byte 0-255 once, in order. */
function everyByteOnce(alphabet: string): { counts: number[]; length: number } {
  const real = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
  let next = 0;
  const per = Math.floor(256 / alphabet.length);
  const wanted = per * alphabet.length;
  Object.defineProperty(globalThis.crypto, "getRandomValues", {
    configurable: true,
    value: <T extends ArrayBufferView | null>(array: T): T => {
      const bytes = array as unknown as Uint8Array;
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = next++ % 256;
      return array;
    },
  });
  try {
    const out = randomLetters(alphabet, wanted);
    return { counts: [...alphabet].map((letter) => [...out].filter((c) => c === letter).length), length: out.length };
  } finally {
    Object.defineProperty(globalThis.crypto, "getRandomValues", { configurable: true, value: real });
  }
}

part("Letters drawn evenly");
const drawn = randomLetters(LETTERS_31, 40);
is("the length and the alphabet are kept", [drawn.length, /^[abcdefghjkmnpqrstuvwxyz23456789]+$/.test(drawn)], [40, true]);
const of36 = everyByteOnce(LETTERS_36);
is("36 letters: every byte below 252 used once gives each letter 7 times", [of36.length, new Set(of36.counts).size, of36.counts[0]], [252, 1, 7]);
const of31 = everyByteOnce(LETTERS_31);
is("31 letters: every byte below 248 used once gives each letter 8 times", [of31.length, new Set(of31.counts).size, of31.counts[0]], [248, 1, 8]);
is("an alphabet that cannot be drawn from is refused", (() => {
  try {
    randomLetters("", 4);
    return "drawn";
  } catch (error) {
    return error instanceof RangeError ? "refused" : "other";
  }
})(), "refused");

part("The ids keep their shapes");
const certificates = Array.from({ length: 50 }, () => newCertificateId());
is("certificate ids: 16 lowercase letters and digits", certificates.every((id) => CERT_ID_PATTERN.test(id) && /^[a-z0-9]{16}$/.test(id)), true);
is("course item ids: 12 lowercase letters and digits", Array.from({ length: 50 }, () => newItemId()).every((id) => /^[a-z0-9]{12}$/.test(id)), true);
const link = makeLink({ label: "Acme", password: "longenough", days: 30, money: false }, Date.UTC(2026, 10, 4));
is("numbers link ids: 20 lowercase letters and digits", link.ok && /^[a-z0-9]{20}$/.test(link.link.id), true);

part("No random value taken modulo a length");
const FILES = [
  "lib/inbox.ts",
  "lib/recovery-address.ts",
  "lib/two-step.ts",
  "lib/creator-invites.ts",
  "lib/short-links.ts",
  "lib/certificate.ts",
  "lib/course.ts",
  "lib/numbers-links.ts",
  "lib/random-letters.ts",
  "components/funnel-editor.tsx",
  "components/inbox-studio.tsx",
];
const MODULO = /%\s*(?:[\w.]+\.length\b|\d[\d_]*\b)/;
is("none of the files that draw ids or codes takes a value modulo a length or a number", FILES.filter((file) => MODULO.test(readFileSync(file, "utf8"))), []);
is("the browser components draw through randomLetters", ["components/funnel-editor.tsx", "components/inbox-studio.tsx", "lib/certificate.ts", "lib/course.ts"].filter((file) => !readFileSync(file, "utf8").includes("randomLetters(")), []);

done();
