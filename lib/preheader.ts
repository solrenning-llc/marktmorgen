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
 *   - Not the subject again: the app shows both side by side.
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

export type PreviewProblem = "long" | "markup" | "link" | "subject";

/** What the studio says for each problem, in plain words. */
export const PREVIEW_PROBLEMS: Record<PreviewProblem, string> = {
  long: `Keep the preview text to ${MAX_PREVIEW} characters or fewer.`,
  markup: "The preview text is plain words: take out the < and > signs.",
  link: "A mail app shows the preview text as plain words, so a link or address in it cannot be opened. Put it in the email instead.",
  subject: "The mail app shows the subject and the preview text side by side, so say something the subject does not.",
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

/** A preview's length as a reader counts it: an emoji, even one built of several, is one. The studio's counter uses the same. */
export function previewLength(text: string): number {
  return [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(text)].length;
}

/**
 * The preview text as kept (tidy, above). Empty means none. Refused, saying
 * why, when it is longer than MAX_PREVIEW, holds markup or a link or address,
 * or repeats the subject.
 */
export function cleanPreview(raw: unknown, subject = ""): { ok: true; text: string } | { ok: false; why: PreviewProblem } {
  if (typeof raw !== "string") return { ok: true, text: "" };
  const text = tidy(raw);
  if (!text) return { ok: true, text: "" };
  if (previewLength(text) > MAX_PREVIEW) return { ok: false, why: "long" };
  if (/[<>]/.test(text)) return { ok: false, why: "markup" };
  if (holdsLink(text)) return { ok: false, why: "link" };
  if (subject && text.toLowerCase() === tidy(subject).toLowerCase()) return { ok: false, why: "subject" };
  return { ok: true, text };
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
