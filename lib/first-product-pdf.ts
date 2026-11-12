/**
 * The first product a creator makes inside Marktmorgen, as a PDF a screen reader can read (490 [PP1], unit 2;
 * added 12 November 2026). The studio's screen (components/first-product-maker.tsx) builds the outline of
 * lib/first-product.ts from the format and the answers; the creator writes each part; this turns what they wrote
 * into a tagged PDF (lib/tagged-pdf-sheet.ts) for them to download and add to a product as its file.
 *
 * Everything in the file is the creator's own: the title, each heading and what they wrote under it. Nothing is
 * added for them: no number, study, testimonial or promised result. The outline is worked out again here from
 * the format and the answers, so the browser cannot send more parts, or other kinds, than the format has.
 *
 * The work is bounded before it starts: a part holds at most FIRST_PRODUCT_MAX_PART characters, the whole file
 * FIRST_PRODUCT_MAX_TEXT and FIRST_PRODUCT_MAX_BREAKS line breaks, and a run of letters with no space longer than FIRST_PRODUCT_LONG_WORD (a pasted link)
 * is broken into pieces of that length, so the line layout never has to search a long word letter by letter.
 * Made on request and kept nowhere. Server only (the fonts).
 */
import { FIRST_FORMATS, type FirstFormat, outlineFor, placeholderTitle } from "@/lib/first-product";
import { canDraw } from "@/lib/certificate-pdf";
import { type SheetText, taggedSheetPdf } from "@/lib/tagged-pdf-sheet";
import { FIRST_PRODUCT_MADE_FORMATS, FIRST_PRODUCT_MAX_BREAKS, FIRST_PRODUCT_MAX_HEADING, FIRST_PRODUCT_MAX_PART, FIRST_PRODUCT_MAX_TEXT } from "@/lib/first-product-limits";

export { FIRST_PRODUCT_MAX_BREAKS, FIRST_PRODUCT_MAX_HEADING, FIRST_PRODUCT_MAX_PART, FIRST_PRODUCT_MAX_TEXT };
/** A run of letters with no space longer than this is broken into pieces of this length. */
export const FIRST_PRODUCT_LONG_WORD = 40;
/** The largest request body the route reads: the whole file's text at four bytes a letter, with room for JSON. */
export const FIRST_PRODUCT_BODY_BYTES = 300_000;
/**
 * The store's studio requests a PDF takes, one at the door and the rest before it is drawn: the longest file
 * measured is priced in tests/first-product-pdf.test.ts against this many studio requests (UNIT_COST.studio).
 */
export const FIRST_PRODUCT_PDF_UNITS = 4;

export type FirstProductSheet = {
  format: FirstFormat;
  title: string;
  /** For a checklist in groups: each group's name, in order. */
  groups: string[];
  parts: { heading: string; body: string; group?: number }[];
};

export type FirstProductRead = { ok: true; sheet: FirstProductSheet } | { ok: false; reason: "format" | "title" | "parts" | "long" | "empty" };

const chars = (text: string) => Array.from(text).length;

/**
 * Tabs and other control characters become spaces, line ends are kept as one kind, a run of empty lines becomes one
 * empty line, and the ends are trimmed.
 */
function clean(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ").replace(/\n[ ]*(?:\n[ ]*)+\n/g, "\n\n").trim();
}

const breaks = (text: string) => (text.match(/\n/g) ?? []).length;

/** A run of letters with no space longer than FIRST_PRODUCT_LONG_WORD, cut into pieces of that length. */
export function breakLongWords(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      line
        .split(" ")
        .map((word) => {
          const letters = Array.from(word);
          if (letters.length <= FIRST_PRODUCT_LONG_WORD) return word;
          const pieces: string[] = [];
          for (let i = 0; i < letters.length; i += FIRST_PRODUCT_LONG_WORD) pieces.push(letters.slice(i, i + FIRST_PRODUCT_LONG_WORD).join(""));
          return pieces.join(" ");
        })
        .join(" "),
    )
    .join("\n");
}

/**
 * What the screen sent, read against the outline the format and answers make: the same number of parts, in the
 * same groups. A heading or group name left empty is the outline's own; a title is required and is never the
 * placeholder; at least one part has words. Too much text is refused, never cut.
 */
export function readFirstProduct(raw: unknown): FirstProductRead {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "parts" };
  const value = raw as Record<string, unknown>;
  // Only a format whose PDF holds everything its outline describes (FIRST_PRODUCT_MADE_FORMATS).
  const format = FIRST_FORMATS.find((f) => f === value.format && (FIRST_PRODUCT_MADE_FORMATS as readonly string[]).includes(f));
  if (!format) return { ok: false, reason: "format" };
  const answers = value.answers && typeof value.answers === "object" && !Array.isArray(value.answers) ? (value.answers as Record<string, string>) : {};
  const title = clean(value.title);
  if (!title || title === placeholderTitle(format)) return { ok: false, reason: "title" };
  if (chars(title) > FIRST_PRODUCT_MAX_HEADING) return { ok: false, reason: "long" };
  const outline = outlineFor(format, answers, title);
  const sent = Array.isArray(value.parts) ? value.parts : null;
  if (!sent || sent.length !== outline.parts.length) return { ok: false, reason: "parts" };
  const sentGroups = Array.isArray(value.groups) ? value.groups : [];
  const groups = outline.groups.map((name, g) => clean(sentGroups[g]) || name);
  const parts: FirstProductSheet["parts"] = [];
  for (const [i, part] of outline.parts.entries()) {
    const given = sent[i];
    const row = given && typeof given === "object" && !Array.isArray(given) ? (given as Record<string, unknown>) : {};
    const heading = clean(row.heading) || part.heading;
    const body = clean(row.body);
    if (chars(heading) > FIRST_PRODUCT_MAX_HEADING || chars(body) > FIRST_PRODUCT_MAX_PART) return { ok: false, reason: "long" };
    parts.push({ heading, body, ...(part.group !== undefined ? { group: part.group } : {}) });
  }
  if (groups.some((name) => chars(name) > FIRST_PRODUCT_MAX_HEADING)) return { ok: false, reason: "long" };
  if (!parts.some((part) => part.body)) return { ok: false, reason: "empty" };
  const total = chars(title) + groups.reduce((n, g) => n + chars(g), 0) + parts.reduce((n, p) => n + chars(p.heading) + chars(p.body), 0);
  if (total > FIRST_PRODUCT_MAX_TEXT) return { ok: false, reason: "long" };
  // Each line break starts a line on the page: the file holds at most FIRST_PRODUCT_MAX_BREAKS of them in all.
  if (breaks(title) + groups.reduce((n, g) => n + breaks(g), 0) + parts.reduce((n, p) => n + breaks(p.heading) + breaks(p.body), 0) > FIRST_PRODUCT_MAX_BREAKS) return { ok: false, reason: "long" };
  return { ok: true, sheet: { format, title, groups, parts } };
}

/** What the file says, in order: the title, who made it, then each part the creator wrote. A part left empty is left out. */
export function firstProductTexts(sheet: FirstProductSheet, by: string): SheetText[] {
  const out: SheetText[] = [{ role: "H1", text: breakLongWords(sheet.title) }, { role: "P", text: breakLongWords(`By ${by}`) }];
  for (const part of sheet.parts) {
    if (!part.body) continue;
    out.push({ role: "H2", text: breakLongWords(part.heading) }, { role: "P", text: breakLongWords(part.body) });
  }
  return out;
}

/** Whether every letter can be drawn; when not, no file is made and the screen says so. */
export async function firstProductDrawable(texts: SheetText[]): Promise<boolean> {
  return canDraw(...texts.map((t) => t.text));
}

/** The PDF, tagged, in the store's language. */
export async function firstProductPdf(sheet: FirstProductSheet, by: string, lang: string): Promise<Uint8Array> {
  return taggedSheetPdf(firstProductTexts(sheet, by), { title: sheet.title, author: by, producer: by, lang });
}

/** A file name from the title: letters, digits and hyphens, never empty. */
export function firstProductFileName(title: string): string {
  return `${title.normalize("NFKD").replace(/[^A-Za-z0-9 _-]+/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "my-product"}.pdf`;
}
