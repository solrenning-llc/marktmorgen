/**
 * The reader's first name in an email (370 [SU3], unit 1; added 2 November
 * 2026): the rules only, pure and browser-safe. Where the token can be typed
 * (one-off emails, sequences), its preview in the studio and filling it in
 * at sending are the next units.
 *
 *   - One token, FIRST_NAME_TOKEN, written exactly so. A near spelling
 *     ({First_Name}, { first_name }) is refused, saying how to write it, and
 *     so is another service's merge field ({{first_name}}, *|FNAME|*,
 *     {$name}, %FIRSTNAME%, {name}), so no reader gets the braces. At most
 *     MAX_TOKENS in each part of an email; never inside a web address, where
 *     the name would go to another site.
 *   - The name is only the one the reader typed here, in a form or at
 *     checkout, as kept on the contact. Nothing is guessed from the address
 *     or looked up anywhere else, and the name kept is never changed.
 *   - Its first word, as typed: "María José Pérez" gives "María"; "Jean-Luc",
 *     "O'Neil" and a Persian name with its joiner stay whole; capitals are
 *     left as they are. Letters, marks and digits only, joined at most by an
 *     apostrophe, a hyphen or a middle dot: anything that could make a link,
 *     a button or markup is no name.
 *   - When the first word may not be the first name, the fallback is used,
 *     since "Hi there" is never wrong and "Hi Dr" is: a title or initial
 *     ending in a period ("Dr.", "J."), a surname typed first ("Souza, Ana"),
 *     one letter, a small word that starts many surnames ("de", "van",
 *     "bin"), the first half of a joined name ("Abd", "عبد"), and a name in
 *     Chinese, Japanese or Korean characters written in parts, whose first
 *     part is usually the family name. A name longer than MAX_FIRST_NAME is
 *     no name either; none is ever cut.
 *   - The fallback is the creator's, required wherever the token is used
 *     ("there" in "Hi {first_name}"), so an email never says "Hi ,": with
 *     neither a name nor a fallback, fillFirstName gives null and nothing is
 *     sent with that text.
 *   - Filled once per reader, in one pass, in the plain words before they are
 *     made into HTML, so the name is escaped with the rest; nothing is kept
 *     between one reader and the next.
 */

export const FIRST_NAME_TOKEN = "{first_name}";
/** The longest first name used, in characters as a reader counts them; a longer one is taken for no name. */
export const MAX_FIRST_NAME = 40;
/** The longest fallback. */
export const MAX_FALLBACK = 40;
/** The most tokens in one part of an email (its subject, its preview text, its body). */
export const MAX_TOKENS = 10;

export type FirstNameProblem = "fallback" | "fallback_long" | "fallback_words" | "unknown" | "spelling" | "in_link" | "too_many";

/** What the studio says for each problem, in plain words, with how to fix it. */
export const FIRST_NAME_PROBLEMS: Record<FirstNameProblem, string> = {
  fallback: `Write the word to use when we do not know a reader's name, such as “there” in “Hi ${FIRST_NAME_TOKEN}”.`,
  fallback_long: `The word to use when we do not know a name can be up to ${MAX_FALLBACK} characters. Make it shorter.`,
  fallback_words: "Use plain words only, such as “there”. Take out curly braces, square brackets, < and > signs, web addresses and email addresses.",
  unknown: `Only ${FIRST_NAME_TOKEN}, written exactly like this, is filled in with a reader's name. Fix or take out the other words in curly braces.`,
  spelling: `Write ${FIRST_NAME_TOKEN} exactly like this, in small letters with no spaces.`,
  in_link: `A reader's name cannot go inside a web address. Move ${FIRST_NAME_TOKEN} out of the link.`,
  too_many: `Use ${FIRST_NAME_TOKEN} up to ${MAX_TOKENS} times in each part of the email.`,
};

const graphemes = (text: string) => [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(text)].length;
/** Not too long as a reader counts it, nor as it is stored: a letter carrying hundreds of marks is one character to a reader. */
const fits = (text: string, max: number) => text.length <= max * 4 && graphemes(text) <= max;

/** Lone surrogate halves, invisible characters and those that change the order text is shown in taken out; controls and line breaks made spaces; spaces made one. The joiners that build a word (U+200C, U+200D) stay. */
function tidy(raw: string): string {
  return raw
    .slice(0, 400)
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "")
    .replace(/[\u00ad\u061c\u180e\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// An address or markup, read in one pass whatever the length (no part can go back over what it read).
const LINKLIKE = /@|https?:|www\.|[<>{}[\]]|[a-z0-9-]\.(com|net|org|io|co|app|me|info|xyz|link|site|online|ly|ru|cn|support|shop|store)\b/i;

// The whole first name: letters, marks and digits, joined at most by an apostrophe, a hyphen or a middle dot.
const NAME = /^[\p{L}\p{M}\p{N}\u200c\u200d]+(?:['’\-\u2010·][\p{L}\p{M}\p{N}\u200c\u200d]+)*$/u;
// Small words that start many surnames, typed in small letters.
const PARTICLES = new Set(["de", "da", "do", "dos", "das", "del", "della", "di", "du", "van", "von", "der", "den", "la", "le", "bin", "ibn", "al", "el"]);
// Titles a reader may type before a name, in the store's languages, without the period; never a first name to greet them by.
const TITLES = new Set(["mr", "mrs", "ms", "miss", "mx", "dr", "dra", "prof", "profa", "sr", "sra", "srta", "sir", "rev", "herr", "frau", "mme", "mlle", "m", "dhr", "mevr", "sig", "sig.ra", "dott", "ing", "lic", "mag"]);
// The first half of a joined name ("Abd al-Rahman").
const FIRST_HALVES = new Set(["abd", "abdul", "abdel", "عبد"]);
const FAMILY_FIRST = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/u;

/** The first name to use, or "" when there is none to use. */
export function firstNameOf(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const name = tidy(raw);
  if (!name || LINKLIKE.test(name)) return "";
  const words = name.split(" ");
  const typed = words[0];
  // "Dr.", "J.", "Souza,": a title, an initial or a surname typed first.
  if (/[.,]$/.test(typed)) return "";
  // A title typed without its period: "Mr Smith", "Dra Ana".
  if (TITLES.has(typed.toLowerCase())) return "";
  // The punctuation around it goes: "(Ana)" gives "Ana".
  const word = typed.replace(/^[^\p{L}\p{M}\p{N}]+|[^\p{L}\p{M}\p{N}]+$/gu, "");
  if (!NAME.test(word) || !/\p{L}/u.test(word) || !fits(word, MAX_FIRST_NAME)) return "";
  if (graphemes(word) === 1) return "";
  if (PARTICLES.has(word) || FIRST_HALVES.has(word.toLowerCase())) return "";
  if (words.length > 1 && FAMILY_FIRST.test(word)) return "";
  return word;
}

// Another service's merge fields, as lib/sequence-import.ts takes them out of an imported email (VARIABLE there): Mailchimp *|X|*,
// Liquid {{ x }} and {% x %}, MailerLite {$x}, each always a field. Each bounded and on one line.
const OTHER_FIELD = /\*\|[^|*\n]{1,60}\|\*|\{\{[^{}\n]{1,80}\}\}|\{%[^%\n]{0,80}%\}|\{\$[^{}\n]{1,60}\}/gu;
// One word in curly braces, {name}, or between percent signs, %NAME%: a field only when the word names a person's details, so a course's
// code ("function f() {return}") or a path ("%APPDATA%") is never refused.
const MAYBE_FIELD = /%([A-Za-z][A-Za-z0-9_]{1,40})%|\{[ \t]*([\p{L}_][\p{L}\p{N}_. ]{0,40}?)[ \t]*\}/gu;
const PERSON_WORD = /^(?:(?:first|last|full|sur|given|family|user|nick|company|business)?[ _.-]?name|[fl]name|e[ _-]?mail|nome|primeiro[ _]?nome|nombre|nom|pr[ée]nom|vorname|nachname|voornaam|achternaam|cognome|名前|氏名|이름|subscriber|contact|company|phone|city|country|zip|address|unsubscribe|unsub|coupon)$/iu;
const NEAR_TOKEN = /^\{[ \t]*first[ _]?name[ \t]*\}$/i;
// Where a web address can start: a scheme, "www." or a host with a dot and a path, query or fragment after it ("example.com/p",
// "example.com?n=", "example.com#"), since an email program makes any of those a link by itself.
const LINK_START = /https?:|www\.|mailto:|[\p{L}\p{N}-]\.[\p{L}]{2,}[/?#]/iu;

/** Whether the token is inside a web address: the run of characters before it, up to a space or a bracket, reads as one. Linear: each token looks back once, at most 300 characters. */
function inLink(text: string): boolean {
  for (let at = text.indexOf(FIRST_NAME_TOKEN); at >= 0; at = text.indexOf(FIRST_NAME_TOKEN, at + 1)) {
    let from = at;
    while (from > 0 && at - from < 300 && !/[\s<>()]/.test(text[from - 1])) from -= 1;
    if (LINK_START.test(text.slice(from, at))) return true;
  }
  return false;
}

/** Any merge field in the words but the token itself; empty when there is none. */
export function otherFields(text: string): string[] {
  const maybe = [...text.matchAll(MAYBE_FIELD)].filter((m) => PERSON_WORD.test((m[1] ?? m[2] ?? "").trim())).map((m) => m[0]);
  return [...[...text.matchAll(OTHER_FIELD)].map((m) => m[0]), ...maybe].filter((found) => found !== FIRST_NAME_TOKEN);
}

/** The fallback as kept, or why it is refused. */
export function cleanFallback(raw: unknown): { ok: true; text: string } | { ok: false; why: FirstNameProblem } {
  const text = typeof raw === "string" ? tidy(raw) : "";
  if (!fits(text, MAX_FALLBACK)) return { ok: false, why: "fallback_long" };
  if (text && LINKLIKE.test(text)) return { ok: false, why: "fallback_words" };
  return { ok: true, text };
}

const tokensIn = (text: string) => text.split(FIRST_NAME_TOKEN).length - 1;

/**
 * Whether the words may be saved, or the first problem found. `texts` are
 * every part of the email a reader sees (subject, preview text, body); the
 * fallback is read only where the token is used.
 */
export function firstNameProblem(texts: string[], fallback: unknown): FirstNameProblem | null {
  for (const text of texts) {
    const others = otherFields(text);
    if (others.some((found) => NEAR_TOKEN.test(found))) return "spelling";
    if (others.length) return "unknown";
    if (inLink(text)) return "in_link";
    if (tokensIn(text) > MAX_TOKENS) return "too_many";
  }
  if (!texts.some((text) => text.includes(FIRST_NAME_TOKEN))) return null;
  const kept = cleanFallback(fallback);
  if (!kept.ok) return kept.why;
  return kept.text ? null : "fallback";
}

/**
 * The words for one reader: each token made their first name, or the
 * fallback; the plain words, before any HTML. Null when the token is there
 * and there is neither a name nor a fallback to put in its place.
 */
export function fillFirstName(text: string, name: unknown, fallback: unknown): string | null {
  if (!text.includes(FIRST_NAME_TOKEN)) return text;
  const kept = cleanFallback(fallback);
  const said = firstNameOf(name) || (kept.ok ? kept.text : "");
  return said ? text.split(FIRST_NAME_TOKEN).join(said) : null;
}
