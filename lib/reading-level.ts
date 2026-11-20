/**
 * Reading level of Marktmorgen's own English text (310 [AX2], section 3,
 * point 1; AX274 Part A, item 4, "Linguagem"; WCAG 2.2 success criterion
 * 3.1.5 Reading Level, AAA).
 *
 * Pure and import-free: plain text in, counts and two scores out. It measures;
 * it decides nothing. No page is changed and nothing is enforced here: the
 * baseline in tests/reading-level.test.ts prints the pages above the threshold
 * until the owner or the coordinator sets how it is held.
 *
 * Method, so a reader can check every number by hand:
 *   1. plainText() strips markup, URLs, email addresses, code and numbers
 *      (a figure is read as a word by nobody's formula, and "$4,490" is not
 *      four syllables of prose). Block ends become line breaks.
 *   2. sentencesOf() splits on ".", "!", "?" and "…" followed by a space, and
 *      on line breaks; a handful of common abbreviations (e.g., i.e., etc., vs.,
 *      U.S.) are kept from ending a sentence. "LLC.", "Inc." and "no." are
 *      not on that list: they end sentences here more often than not.
 *   3. wordsOf() takes letter runs, with inner apostrophes and hyphens
 *      ("don't", "money-back" are one word each).
 *   4. syllablesOf() is a vowel-group heuristic for English (see its comment).
 *      It is an estimate, not a dictionary: tests/reading-level.test.ts holds
 *      it to a fixed word list and documents the tolerance.
 *   5. Flesch-Kincaid grade = 0.39 × (words / sentences)
 *                           + 11.8 × (syllables / words) − 15.59
 *      Flesch reading ease   = 206.835 − 1.015 × (words / sentences)
 *                           − 84.6 × (syllables / words)
 *      (Kincaid, Fishburne, Rogers and Chissom, 1975, Research Branch
 *      Report 8-75, Naval Technical Training Command; Flesch, 1948, "A new
 *      readability yardstick", Journal of Applied Psychology 32(3)).
 *
 * A formula is not a reader: it does not see jargon that is short, a word
 * explained in a glossary, or a long sentence that is a plain list. WCAG's
 * Understanding document itself says a readability formula is one way to
 * check 3.1.5, not the only one. Human testing (item 202) stays a gap.
 */

/**
 * WCAG 2.2, 3.1.5 Reading Level (AAA): "When text requires reading ability
 * more advanced than the lower secondary education level after removal of
 * proper names and titles, supplemental content, or a version that does not
 * require reading ability more advanced than the lower secondary education
 * level, is available."
 *
 * WCAG 2.2 glossary, "lower secondary education level": "the two or three
 * year period of education that begins after completion of six years of
 * school and ends nine years after the beginning of primary education".
 * Nine years of school is US grade 9, so a Flesch-Kincaid grade above 9 is
 * above the level.
 *
 * Sources, read 15 November 2026:
 *   https://www.w3.org/WAI/WCAG22/Understanding/reading-level.html
 *   https://www.w3.org/TR/WCAG22/#dfn-lower-secondary-education-level
 */
export const LOWER_SECONDARY_GRADE = 9;

/** Abbreviations whose period never ends a sentence. Lower case, without the final period. */
const ABBREVIATIONS = ["e.g", "i.e", "etc", "vs", "u.s", "u.k", "a.m", "p.m", "mr", "mrs", "ms", "dr", "approx", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec"];

/** Elements whose end ends a sentence when markup is stripped. */
const BLOCK_TAGS = "p|div|li|ul|ol|h[1-6]|td|th|tr|table|section|article|header|footer|nav|aside|main|blockquote|dt|dd|dl|figcaption|caption|summary|details|button|label|legend|option|title";

/**
 * Text as a reader reads it: no markup, URLs, email addresses, code or
 * numbers. Block ends and <br> become line breaks, so a heading, a list item
 * or a table cell without a final period still counts as its own sentence.
 */
export function plainText(input: string): string {
  return input
    .replace(/<(script|style|code|pre|svg)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(new RegExp(`</(?:${BLOCK_TAGS})\\s*>`, "gi"), "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&(?:quot|#34|#x22);/gi, '"')
    .replace(/&(?:#39|#x27|apos|rsquo|lsquo);/gi, "'")
    .replace(/&(?:mdash|ndash|#8212|#8211);/gi, " ")
    .replace(/&(?:lt|gt);/gi, " ")
    .replace(/&#?\w+;/g, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, " ")
    .replace(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, " ")
    .replace(/(?:^|\s)\/[\w@./?=&%#-]+/g, " ")
    .replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|dev|app|co|test)(?:\/\S*)?/gi, " ")
    .replace(/[$€£¥]?\d(?:[\d,.:/]*\d)?(?:%|(?:x|k|m|st|nd|rd|th|s)\b)?/gi, " ")
    .replace(/[ \t\f\v\r]+/g, " ")
    .replace(/ *\n[\s]*/g, "\n")
    .trim();
}

/** The sentences of plain text: split on end punctuation followed by space, and on line breaks. */
export function sentencesOf(text: string): string[] {
  let guarded = text;
  for (const abbreviation of ABBREVIATIONS) {
    // Every character a pattern reads as an operator is escaped, the backslash too (CodeQL js/incomplete-sanitization).
    const escaped = abbreviation.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    guarded = guarded.replace(new RegExp(`\\b${escaped}\\.(?=\\s)`, "gi"), (match) => match.replace(/\./g, "\u0000"));
  }
  return guarded
    .split(/(?<=[.!?…])["'”’)\]]*\s+|\n+/)
    .map((sentence) => sentence.replace(/\u0000/g, ".").trim())
    .filter((sentence) => wordsOf(sentence).length > 0);
}

/** The words of plain text: letter runs, with an inner apostrophe or hyphen kept inside one word. */
export function wordsOf(text: string): string[] {
  return text.match(/[A-Za-zÀ-ÖØ-öø-ÿ]+(?:['’-][A-Za-zÀ-ÖØ-öø-ÿ]+)*/g) ?? [];
}

/**
 * Syllables of one English word, by vowel groups:
 *   - an all-capital word of two to five letters is an initialism read letter
 *     by letter ("AI" 2, "PDF" 3, "W" counted as 3: "double-u");
 *   - a hyphenated word is the sum of its parts;
 *   - otherwise, lower case, drop a possessive "'s" and a contraction's tail,
 *     then drop a final silent "e" (but keep "-le" after a consonant, as in
 *     "simple"), a final "-es" or "-ed" that adds no syllable (but keep "-ed"
 *     after "t" or "d", as in "wanted", and "-es" after s, x, z, c, g, ch
 *     or sh, as in "boxes" and "pages"), and count groups of a, e, i, o, u, y;
 *   - a vowel pair that is two syllables (a hiatus) counts as two (HIATUS):
 *     "i" before "a", "o" or "u" ("media", "studio", "audio", "period",
 *     "various") except after c, t, s, x, g, n or l, where it is mostly one
 *     ("special", "nation", "region", "million"); "eo" after d, h or r
 *     ("video", "theory", "stereo"), not in "-eous"; "creat" ("create",
 *     "creator"); a final "ea" ("idea", "area"); "ien" before c or t
 *     except after c, t or s ("client", "experience", but "patient");
 *     "e" before a final "ing" ("being", "seeing"); and "u" before "a"
 *     except after q, g or s ("actual", "manual", but "quality");
 *   - every word has at least one syllable.
 * The hiatus rule adds only where a pair is two syllables in the words it
 * names (Claude 7 on #4612: the vowel groups alone undercount in one
 * direction, so every page read easier than it is). Known misses that
 * remain: "-ness" and a silent "e" before "-be", "usual" and "visual"
 * (after s), "quiet", some "-ely" words. The test holds the misses on its
 * list to one syllable a word, and the hiatus words to their dictionary
 * count.
 */
export function syllablesOf(word: string): number {
  if (word.includes("-")) return word.split("-").filter(Boolean).reduce((sum, part) => sum + syllablesOf(part), 0);
  if (/^[A-Z]{2,5}s?$/.test(word)) return [...word.replace(/s$/, "")].reduce((sum, letter) => sum + (letter === "W" ? 3 : 1), 0);
  const w = word.toLowerCase().replace(/['’]s$/, "").replace(/['’](?:t|re|ve|ll|d|m)$/, "").replace(/[^a-zà-öø-ÿ]/g, "");
  if (!w) return 0;
  if (w.length <= 3) return 1;
  let stem = w;
  let extra = 0;
  if (/[^aeiouy]le$/.test(w)) {
    stem = w.slice(0, -2); // "simple": "simp" + the "-le" syllable
    extra = 1;
  } else if (/(?:[sxzcg]|[cs]h)es$/.test(w)) {
    stem = w.slice(0, -2); // "boxes", "pages", "teaches": "-es" is its own syllable
    extra = 1;
  } else if (/[^aeiouy]es$/.test(w)) stem = w.slice(0, -2); // "makes"
  else if (/[td]ed$/.test(w)) {
    stem = w.slice(0, -2); // "wanted", "added": "-ed" is its own syllable
    extra = 1;
  } else if (/[^aeiouy]ed$/.test(w)) stem = w.slice(0, -2); // "used", "signed"
  else if (/[^aeiouy]e$/.test(w)) stem = w.slice(0, -1); // "make", "store": silent "e"
  return Math.max(1, vowelGroups(stem) + hiatusSplits(stem) + extra);
}

/** The vowel pairs read as two syllables, each a split of one vowel group (see syllablesOf). */
const HIATUS = [
  /(?<![ctsxgnl])i(?=[aou])/g,
  /(?<=[dhr])e(?=o(?!us))/g,
  /creat/g,
  /ea$/g,
  /(?<![cts])ien(?=[ct])/g,
  /e(?=ings?$)/g,
  /(?<![qgs])u(?=a)/g,
];

function hiatusSplits(stem: string): number {
  return HIATUS.reduce((sum, pattern) => sum + (stem.match(pattern) ?? []).length, 0);
}

function vowelGroups(word: string): number {
  return (word.match(/[aeiouyà-öø-ÿ]+/g) ?? []).length;
}

export type ReadingLevel = {
  sentences: number;
  words: number;
  syllables: number;
  /** Flesch-Kincaid grade level, rounded to one decimal. */
  grade: number;
  /** Flesch reading ease, rounded to one decimal (higher is easier). */
  ease: number;
};

/** Raw scores from counts, unrounded. */
export function fleschKincaidGrade(words: number, sentences: number, syllables: number): number {
  return 0.39 * (words / sentences) + 11.8 * (syllables / words) - 15.59;
}

export function fleschReadingEase(words: number, sentences: number, syllables: number): number {
  return 206.835 - 1.015 * (words / sentences) - 84.6 * (syllables / words);
}

/**
 * The reading level of one text, or of several fragments read as one page
 * (each fragment ends a sentence, as a heading or a list item does).
 * Text with no word throws: unknown is never a pass.
 *
 * minSentenceWords (default 1) leaves out shorter sentences: with 5, a page's
 * headings, buttons, labels and table cells ("Yes", "One store") no longer
 * pull its average sentence length down, so the grade is that of its prose.
 */
export function readingLevel(text: string | readonly string[], options: { minSentenceWords?: number } = {}): ReadingLevel {
  const fragments = typeof text === "string" ? [text] : text;
  const min = options.minSentenceWords ?? 1;
  const sentences = fragments.flatMap((fragment) => sentencesOf(plainText(fragment))).filter((sentence) => wordsOf(sentence).length >= min);
  const words = sentences.flatMap(wordsOf);
  if (words.length === 0) throw new Error("reading level: no readable words in this text");
  const syllables = words.reduce((sum, word) => sum + syllablesOf(word), 0);
  const round = (value: number) => Math.round(value * 10) / 10;
  return {
    sentences: sentences.length,
    words: words.length,
    syllables,
    grade: round(fleschKincaidGrade(words.length, sentences.length, syllables)),
    ease: round(fleschReadingEase(words.length, sentences.length, syllables)),
  };
}

/** Whether a measured text is above the lower secondary level (WCAG 3.1.5). */
export function aboveLowerSecondary(level: ReadingLevel): boolean {
  return level.grade > LOWER_SECONDARY_GRADE;
}
