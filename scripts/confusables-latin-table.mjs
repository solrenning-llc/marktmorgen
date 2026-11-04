/**
 * The table of letters that look like a plain Latin letter or digit, made
 * from Unicode's confusables.txt (UTS #39, Unicode Security Mechanisms), for
 * the store assistant's deal-word check (lib/store-assistant-rules.ts,
 * heldToFacts). Pure functions: scripts/confusables-latin.mjs writes
 * lib/confusables-latin.ts with them, and tests/deal-words.test.ts fails when
 * that file is not what they make from the committed copy.
 *
 * The copy: tooling/unicode/confusables-18.0.0.txt, Version 18.0.0, Date
 * 2026-08-06 01:05:35 GMT, read on 4 November 2026 from Unicode's own
 * repository (github.com/unicode-org/unicodetools, unicodetools/data/security/18.0.0/confusables.txt),
 * SHA-256 6ed3ee967c9dfdf6677d563c9985182fbc50a2efb7d6059cd57b2e2ce18f5b92.
 * www.unicode.org itself could not be reached from the session that copied it.
 * Its license, the Unicode License v3, is copied beside it from the same
 * repository (tooling/unicode/LICENSE, the repository's LICENSE file), as
 * that license requires with every copy; lib/confusables-latin.ts, made
 * from it, cites it in its header.
 *
 * What is kept: one source code point mapped to one target that is a Latin
 * letter or digit (a-z, A-Z, 0-9, read lowercase), alone or followed only
 * by combining marks (read as the letter), when the source
 *   - is past Latin Extended-A (U+017F): the accented letters of the store
 *     languages are read without their accent, never as another letter;
 *   - is not a digit (a number stays a number) and not a symbol outside
 *     identifiers (the entries marked "#*", such as math operators);
 *   - is not Arabic, Hebrew, Han, kana or hangul, which never refuse a reply.
 * A few letters that confusables.txt maps to another look-alike rather than
 * to Latin, or leaves out, are added by hand (EXTRA), each with its reason.
 * A vertical stroke is confusables.txt's "l" (the prototype of l, I, 1 and
 * |): it is written "l|i" here, and the store assistant reads each such
 * letter both as "l" and as "i".
 */

/** Ranges never read as Latin: Arabic, Hebrew, Han and CJK, kana, hangul. */
const EXCLUDED = [
  [0x0590, 0x05ff], [0x0600, 0x06ff], [0x0700, 0x08ff], [0xfb1d, 0xfdff], [0xfe70, 0xfeff], [0x1ee00, 0x1eeff],
  [0x1100, 0x11ff], [0x2e80, 0x9fff], [0xa960, 0xa97f], [0xac00, 0xd7ff], [0xf900, 0xfaff], [0xff66, 0xffdc], [0x20000, 0x3ffff],
];

/** Look-alikes confusables.txt sends to another look-alike, not to Latin. */
export const EXTRA = [
  [0x104c3, "o", "OSAGE CAPITAL LETTER OIN (mapped to U+0298)"],
  [0x104eb, "o", "OSAGE SMALL LETTER OIN (mapped to U+A669)"],
  [0xa668, "o", "CYRILLIC CAPITAL LETTER MONOCULAR O (its own prototype)"],
  [0xa669, "o", "CYRILLIC SMALL LETTER MONOCULAR O (its own prototype)"],
  [0x1455, "c", "CANADIAN SYLLABICS TA (its own prototype)"],
  // Latin small capitals, which read as their letter in a lowercase word but are not in confusables.txt.
  [0x1d00, "a", "LATIN LETTER SMALL CAPITAL A"], [0x0299, "b", "LATIN LETTER SMALL CAPITAL B"], [0x1d05, "d", "LATIN LETTER SMALL CAPITAL D"],
  [0x1d07, "e", "LATIN LETTER SMALL CAPITAL E"], [0xa730, "f", "LATIN LETTER SMALL CAPITAL F"], [0x0262, "g", "LATIN LETTER SMALL CAPITAL G"],
  [0x029c, "h", "LATIN LETTER SMALL CAPITAL H"], [0x1d0a, "j", "LATIN LETTER SMALL CAPITAL J"], [0x1d0b, "k", "LATIN LETTER SMALL CAPITAL K"],
  [0x029f, "l", "LATIN LETTER SMALL CAPITAL L"], [0x1d0d, "m", "LATIN LETTER SMALL CAPITAL M"], [0x0274, "n", "LATIN LETTER SMALL CAPITAL N"],
  [0x1d18, "p", "LATIN LETTER SMALL CAPITAL P"], [0xa7af, "q", "LATIN LETTER SMALL CAPITAL Q"], [0x0280, "r", "LATIN LETTER SMALL CAPITAL R"],
  [0x1d1b, "t", "LATIN LETTER SMALL CAPITAL T"],
  // Letters that look like a Latin letter in lowercase text, not in confusables.txt as such.
  [0x0500, "d", "CYRILLIC CAPITAL LETTER KOMI DE"], [0x043a, "k", "CYRILLIC SMALL LETTER KA"], [0x03ba, "k", "GREEK SMALL LETTER KAPPA"],
  [0x03c7, "x", "GREEK SMALL LETTER CHI"], [0x0275, "o", "LATIN SMALL LETTER BARRED O"],
  // Letters with a stroke that have no decomposition, so the accent folding leaves them: read as their base letter (Danish, Croatian, Polish).
  [0x00f8, "o", "LATIN SMALL LETTER O WITH STROKE"], [0x0111, "d", "LATIN SMALL LETTER D WITH STROKE"], [0x0142, "l", "LATIN SMALL LETTER L WITH STROKE"],
];

/** The header lines that name the copy: its version and date. */
export function versionOf(text) {
  const version = /^# Version: (.+)$/m.exec(text)?.[1]?.trim() ?? "";
  const date = /^# Date: (.+)$/m.exec(text)?.[1]?.trim() ?? "";
  return { version, date };
}

/** Every kept source as [code point, lowercase Latin letter or digit], by code point. */
export function latinLookalikes(text) {
  const kept = new Map();
  for (const line of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const m = /^([0-9A-F]+)\s*;\s*([0-9A-F]+(?: [0-9A-F]+)*)\s*;\s*MA\s*#(\*?)\s*\(.*?\)\s*(.*?)\s*\u2192/u.exec(line);
    if (!m) continue;
    const source = parseInt(m[1], 16);
    // One Latin letter or digit, alone or followed only by combining marks, read as that letter (GREEK SMALL LETTER ETA is "n" with a line below).
    const [base, ...marks] = m[2].split(" ").map((hex) => String.fromCodePoint(parseInt(hex, 16)));
    if (m[3] === "*" || source <= 0x17f || !/^[A-Za-z0-9]$/.test(base) || !marks.every((mark) => /^\p{M}$/u.test(mark))) continue;
    if (/\bDIGIT\b/.test(m[4])) continue;
    if (EXCLUDED.some(([from, to]) => source >= from && source <= to)) continue;
    // A target "l" is a vertical stroke (the prototype of l, I, 1 and |): written "l|i", read both ways.
    kept.set(source, base === "l" ? "l|i" : base.toLowerCase());
  }
  for (const [source, target] of EXTRA) kept.set(source, target);
  return [...kept].sort((a, b) => a[0] - b[0]);
}

/** lib/confusables-latin.ts as it must be: one line per Latin letter or digit, its sources in hexadecimal. */
export function renderTable(text) {
  const { version, date } = versionOf(text);
  const byTarget = new Map();
  for (const [source, target] of latinLookalikes(text)) byTarget.set(target, [...(byTarget.get(target) ?? []), source]);
  const lines = [...byTarget].sort(([a], [b]) => (a < b ? -1 : 1)).map(([target, sources]) => `  ${JSON.stringify(target)}: [${sources.map((s) => `0x${s.toString(16)}`).join(", ")}],`);
  return [
    "// Generated by scripts/confusables-latin.mjs from tooling/unicode/confusables-18.0.0.txt; do not edit by hand.",
    `// Unicode Security Mechanisms (UTS #39) confusables.txt, Version ${version}, Date ${date}.`,
    "// Data derived from it: Copyright (c) Unicode, Inc., under the Unicode License v3 (tooling/unicode/LICENSE).",
    "/** Letters that look like a Latin letter or digit, by that letter: what the store assistant reads them as when it looks for a deal word. */",
    "export const CONFUSABLE_LATIN_SOURCES: Readonly<Record<string, readonly number[]>> = {",
    ...lines,
    "};",
    "",
  ].join("\n");
}
