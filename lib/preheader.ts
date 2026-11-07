/**
 * The preview text of an email the creator writes (537 [PH1], unit 1; added
 * 2 November 2026): the line a mail app shows after the subject, before the
 * email is opened. The rules only, pure and browser-safe; the field in the
 * studio and its place in one-off emails, sequences and templates are the
 * next units.
 *
 *   - Optional. Without one, nothing is added and the email goes out as it
 *     does today, the app showing the first words of the body.
 *   - Plain text, at most MAX_PREVIEW characters, said and refused when
 *     longer (never cut): no markup, no link and no address, since the app
 *     shows it as plain words and a reader cannot follow it there.
 *   - Not the subject again: the app shows both side by side. Compared as
 *     a reader sees them: one way of writing each letter, without what
 *     draws nothing, ignoring case and spaces.
 *   - Something a reader sees: a preview of invisible characters only is
 *     refused, and so is a letter under more marks than writing needs.
 *   - In the HTML it is the first text of the body, hidden from view and from
 *     screen readers (they read the email itself, which says what it says),
 *     followed by spacers so the app does not fill the rest of the preview
 *     with the start of the body. In the plain text it is the first line.
 *
 * Its words are the creator's. Examples and suggestions shown by the studio
 * promise nothing the email does not have, and never press for haste.
 */

/** The most characters a preview text may have. */
export const MAX_PREVIEW = 120;

/**
 * The most bytes it may take (UTF-8), besides MAX_PREVIEW (unit 2, 6 November
 * 2026): one character as a reader counts it can carry any number of marks,
 * so 120 of them are no bound on what is kept and sent. 120 of the longest
 * emoji a person types (a family of four with skin tones, 41 bytes) fit, with
 * room; the cost of what fits is in tests/plan-cost-registry.ts (list-email).
 */
export const MAX_PREVIEW_BYTES = 6_144;

/**
 * The most marks one character may carry, and the most bytes it may take
 * (unit 2, review of 7 November 2026): real writing stays well inside them
 * (Vietnamese two marks on a letter, Hebrew with its points and cantillation
 * four, a Hindi cluster five; the longest emoji, 41 bytes), while one letter
 * under a pile of accents, which draws over the lines around it, does not.
 */
export const MAX_MARKS_PER_LETTER = 6;
export const MAX_BYTES_PER_LETTER = 64;

export type PreviewProblem = "long" | "markup" | "link" | "subject" | "heavy" | "blank";

/** What the studio says for each problem, in plain words. */
export const PREVIEW_PROBLEMS: Record<PreviewProblem, string> = {
  long: `Keep the preview text to ${MAX_PREVIEW} characters or fewer.`,
  markup: "The preview text is plain words: take out the < and > signs.",
  link: "A mail app shows the preview text as plain words, so a link or address in it cannot be opened. Put it in the email instead.",
  subject: "The mail app shows the subject and the preview text side by side, so say something the subject does not.",
  heavy: "Some letters or emoji in the preview text carry too many marks to send. Take some of them out.",
  blank: "The preview text has nothing a reader would see. Write a few words, or leave it empty.",
};

// An address written out: a scheme, "www.", an email address, or a name with a common or country ending.
const ADDRESS = /\bhttps?:\/\/|\bwww\.|@[a-z0-9-]+\.[a-z]{2,}/i;
const DOMAIN = /\b[a-z0-9-]+\.(com|net|org|io|co|app|shop|store|me|info|biz|de|uk|br|ai|dev|ca|us|eu|tv|ly|xyz|link|page|site|gg|to|fm|so|online|blog|live|club|academy|courses|studio|pt|es|fr|it|nl|au|mx|in)\b/gi;

/** Whether the words hold an address; an ending that starts with a capital ("Go.Shop now") is two sentences, not an address. */
function holdsLink(text: string): boolean {
  if (ADDRESS.test(text)) return true;
  return [...text.matchAll(DOMAIN)].some((m) => m[1][0] === m[1][0].toLowerCase());
}

/**
 * Words as a preview keeps them: lone surrogate halves, characters that draw
 * nothing (zero-width space, word joiner, byte-order mark) and the bidi
 * overrides taken out; controls and line separators made spaces; runs of
 * spaces made one. The joiners that build an emoji or spell a Persian word
 * (U+200C, U+200D) and the marks that order a number in Arabic or Hebrew
 * (U+200E, U+200F) are kept.
 */
function tidy(raw: string): string {
  return raw
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "")
    .replace(/[\u200b\u2060-\u2064\ufeff\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Characters that draw nothing, kept in the text where they build a word or
 * an emoji but never counted as something a reader sees: the default-
 * ignorable ones (joiners, soft hyphen, grapheme joiner, variation
 * selectors, Hangul fillers, tag characters, direction marks), the blank
 * Braille pattern, and spaces.
 */
const UNSEEN = /[\p{Default_Ignorable_Code_Point}\u2800\s]/gu;
const SEEN = /[\p{L}\p{N}\p{P}\p{S}]/u;

/** Words as a reader sees them, to compare: one way of writing each letter (NFC), without what draws nothing, in lower case. */
const seenAs = (text: string) => text.normalize("NFC").replace(UNSEEN, "").toLowerCase();

const letters = (text: string) => [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(text)].map((s) => s.segment);

/** Whether a character as a reader counts it carries more marks or bytes than any real writing or emoji needs. */
const overMarked = (letter: string) => (letter.match(/\p{M}/gu)?.length ?? 0) > MAX_MARKS_PER_LETTER || new TextEncoder().encode(letter).length > MAX_BYTES_PER_LETTER;

/** A preview's length as a reader counts it: an emoji, even one built of several, is one. The studio's counter uses the same. */
export function previewLength(text: string): number {
  return letters(text).length;
}

/**
 * The preview text as kept (tidy, above). Empty means none. Refused, saying
 * why, when it has nothing a reader would see, is heavier than its bytes or
 * a letter's marks allow, is longer than MAX_PREVIEW, holds markup or a link
 * or address, or repeats the subject, compared as a reader sees both (seenAs).
 */
export function cleanPreview(raw: unknown, subject = ""): { ok: true; text: string } | { ok: false; why: PreviewProblem } {
  if (typeof raw !== "string") return { ok: true, text: "" };
  const text = tidy(raw);
  if (!text) return { ok: true, text: "" };
  if (new TextEncoder().encode(text).length > MAX_PREVIEW_BYTES) return { ok: false, why: "heavy" };
  const seen = seenAs(text);
  if (!SEEN.test(seen)) return { ok: false, why: "blank" };
  const all = letters(text);
  if (all.some(overMarked)) return { ok: false, why: "heavy" };
  if (all.length > MAX_PREVIEW) return { ok: false, why: "long" };
  if (/[<>]/.test(text)) return { ok: false, why: "markup" };
  if (holdsLink(text)) return { ok: false, why: "link" };
  if (subject && seen === seenAs(tidy(subject))) return { ok: false, why: "subject" };
  return { ok: true, text };
}

/**
 * A stored preview text exactly as its rules keep it, against `subject` when
 * one is given (unit 3, 6 November 2026): what a strict reader accepts. An
 * empty one is never kept, so it is not read as none either.
 */
export function isKeptPreview(value: unknown, subject = ""): value is string {
  if (typeof value !== "string" || !value) return false;
  const read = cleanPreview(value, subject);
  return read.ok && read.text === value;
}

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Invisible characters a mail app shows as nothing, enough for the longest previews (about 255 characters), so it ends with the creator's words. */
const SPACERS = "&#847;&zwnj;&nbsp;".repeat(120);

/** Only a preview its own rules keep is ever put in an email; anything else is none. */
const kept = (preview: string) => {
  const read = cleanPreview(preview);
  return read.ok ? read.text : "";
};

/**
 * The preview text as the first thing in an email's HTML body, before any
 * picture's description some apps would take for it: hidden from view in
 * every common mail app (and in Outlook by mso-hide on the text itself) and
 * from screen readers, then the spacers. Empty without one, so the email is
 * as it is today.
 */
export function preheaderHtml(preview: string): string {
  const text = kept(preview);
  if (!text) return "";
  return `<div aria-hidden="true" style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;color:transparent"><span style="mso-hide:all">${escape(text)}</span>${SPACERS}</div>`;
}

/** The plain-text email with the preview text as its first line, then a blank line; as it is without one. */
export function withPreviewLine(text: string, preview: string): string {
  const line = kept(preview);
  return line ? `${line}\n\n${text}` : text;
}

/**
 * A whole email's HTML with the preview text first in its body, right after
 * the opening <body> tag (or first of all, for HTML without one); the HTML as
 * it is without one, or with one its rules refuse.
 */
export function withPreheader(html: string, preview: string): string {
  const hidden = preheaderHtml(preview);
  if (!hidden) return html;
  const body = /<body\b[^>]*>/i.exec(html);
  if (!body) return hidden + html;
  const at = body.index + body[0].length;
  return html.slice(0, at) + hidden + html.slice(at);
}
