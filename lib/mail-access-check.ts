/**
 * "Can everyone read it?" before an email goes out (AX274 Part A item 6; ATAG 2.0 Part B: the studio warns
 * about what a reader cannot use and offers the fix; it never changes the creator's content on its own).
 *
 * Read from the email's own text exactly as it is drawn (lib/mail-body.ts, parseMailBlocks and bodyHtml):
 *   - a picture with no words (WCAG 1.1.1): a screen reader says nothing for it, or only "image";
 *   - a button whose words do not say where it goes, such as "Click here" (2.4.4, and 2.4.9 at AAA,
 *     lib/link-purpose.ts);
 *   - a bare web address, which the email turns into a link whose words are the address (2.4.9 at AAA):
 *     read out letter by letter, and it does not say what is there.
 * Each note carries where it is in the text, so the studio can show it there. Headings need no check: an email
 * has one heading level, under its subject. Colors need no warning: an email's colors are moved until its text
 * keeps 7:1 (lib/mail-body.ts, lib/email-theme.ts).
 *
 * The fixes below only put in words the creator typed, never invented ones; they refuse empty or vague words,
 * and refuse to write when the text at that place is no longer what was checked. Pure and browser-safe.
 * Not a conformity claim: nothing here says an email is accessible.
 */
import { MAX_MAIL_BUTTON, parseMailBlocks } from "@/lib/mail-body";
import { MAX_MAIL_PICTURES, pictureLine, readPicture } from "@/lib/mail-picture-rules";
import { vagueLinkTitle } from "@/lib/link-purpose";

/** A place in the email's text: [start, end) of what the note is about, and that text as it was checked. */
type At = { start: number; end: number; source: string };

export type MailAccessNote =
  | (At & { kind: "picture"; url: string })
  | (At & { kind: "button"; label: string; href: string })
  /** `alone`: the address is a paragraph of its own, so it can become a button with words. */
  | (At & { kind: "address"; address: string; alone: boolean });

/** The same addresses lib/mail-body.ts makes links of, and the sentence's full stop it leaves out. */
const ADDRESS = /https:\/\/[^\s<>"')\]]+/g;
const TRAILING = /[.,;:!?]+$/;
/** A paragraph: lines with no blank line between them, as parseMailBlocks splits them (after it turns \r\n into \n). */
const PARAGRAPH = /[^\r\n]+(?:\r?\n[^\r\n]+)*/g;

/** What a reader cannot use in this email, in the order it reads. */
export function mailAccessNotes(body: string): MailAccessNote[] {
  const notes: MailAccessNote[] = [];
  let pictures = 0;
  for (const chunk of body.matchAll(PARAGRAPH)) {
    const text = chunk[0];
    if (!text.trim()) continue;
    const from = chunk.index ?? 0;
    const lead = text.length - text.trimStart().length;
    const trimmed = text.trim();
    const at = { start: from + lead, end: from + lead + trimmed.length, source: trimmed };
    const block = parseMailBlocks(text)[0];
    if (!block || block.kind === "heading" || block.kind === "divider") continue;
    if (block.kind === "button") {
      if (vagueLinkTitle(block.label)) notes.push({ kind: "button", label: block.label, href: block.href, ...at });
      continue;
    }
    if (block.kind === "picture") {
      // Past the sixth, a picture is drawn as its text, as bodyHtml does.
      const picture = pictures < MAX_MAIL_PICTURES ? readPicture(block.line) : null;
      if (picture) {
        pictures += 1;
        if (!picture.alt) notes.push({ kind: "picture", url: picture.url, ...at });
        continue;
      }
    }
    // Text and lists, line by line: a picture on a line of its own inside a paragraph, and the addresses.
    let offset = from;
    for (const line of text.split("\n")) {
      const picture = block.kind === "text" && pictures < MAX_MAIL_PICTURES ? readPicture(line) : null;
      if (picture) {
        pictures += 1;
        const lineLead = line.length - line.trimStart().length;
        if (!picture.alt) notes.push({ kind: "picture", url: picture.url, start: offset + lineLead, end: offset + lineLead + line.trim().length, source: line.trim() });
      } else {
        for (const match of line.matchAll(ADDRESS)) {
          const address = match[0].replace(TRAILING, "");
          const start = offset + (match.index ?? 0);
          notes.push({ kind: "address", address, alone: trimmed === address, start, end: start + address.length, source: address });
        }
      }
      offset += line.length + 1;
    }
  }
  return notes;
}

export type FixResult = { ok: true; body: string } | { ok: false; why: "changed" | "empty" | "vague" | "long" | "not_alone" };

function replaceAt(body: string, note: MailAccessNote, next: string): FixResult {
  if (body.slice(note.start, note.end) !== note.source) return { ok: false, why: "changed" };
  return { ok: true, body: body.slice(0, note.start) + next + body.slice(note.end) };
}

/** Words for a button, cleaned the way the designer writes them (lib/mail-body.ts, serializeMailBlocks). */
function buttonWords(words: string): string | Exclude<FixResult, { ok: true }> {
  const clean = words.replace(/[[\]\n]/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) return { ok: false, why: "empty" };
  if (clean.length > MAX_MAIL_BUTTON) return { ok: false, why: "long" };
  if (vagueLinkTitle(clean)) return { ok: false, why: "vague" };
  return clean;
}

/** The picture with the words the creator typed for it. */
export function describePicture(body: string, note: MailAccessNote, words: string): FixResult {
  if (note.kind !== "picture") return { ok: false, why: "changed" };
  if (!words.replace(/[[\]\r\n]/g, " ").trim()) return { ok: false, why: "empty" };
  return replaceAt(body, note, pictureLine(words, note.url));
}

/** The button with the words the creator typed, to the same address. */
export function renameButton(body: string, note: MailAccessNote, words: string): FixResult {
  if (note.kind !== "button") return { ok: false, why: "changed" };
  const label = buttonWords(words);
  return typeof label === "string" ? replaceAt(body, note, `[${label}](${note.href})`) : label;
}

/** An address on a line of its own made a button, with the words the creator typed. One in a sentence is left to them. */
export function addressToButton(body: string, note: MailAccessNote, words: string): FixResult {
  if (note.kind !== "address") return { ok: false, why: "changed" };
  if (!note.alone) return { ok: false, why: "not_alone" };
  const label = buttonWords(words);
  return typeof label === "string" ? replaceAt(body, note, `[${label}](${note.address})`) : label;
}

/** What every email gets without the creator doing anything, and only what the code does. */
export const MAIL_ACCESS_DONE_FOR_YOU: readonly string[] = [
  "If a button or text color is too light or too dark, we adjust it so the words keep at least 7:1 contrast.",
  "Every email also goes out as plain text, where each picture is replaced by its description.",
];
