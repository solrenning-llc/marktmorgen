/**
 * Bold, italic, links and lists in a page's text: the rules the page editor's
 * preview will ask before it shows a formatted paragraph or list (32 [F1],
 * with the 375 [TB1] complement of 29 October 2026, 10h58: the floating bar).
 * Pure and browser-safe: no network, no Redis, no React. The bar itself comes
 * in the next unit (components/page-editor.tsx).
 *
 * What a page keeps today is plain text: a row's paragraph is one string and
 * a row's list is one string per item (RowElement in lib/sales-page.ts).
 * Formatting is laid over those exact words as runs, in the shape the
 * community already draws a post with (Segment in lib/community-text.ts: a
 * piece of text, or a link with its address), with bold and italic as flags
 * on a run. Nothing here is ever HTML: a page draws the runs as React
 * elements (<strong>, <em>, <a>, <ul><li>), so a typed tag stays words.
 *
 * The rules only propose. `proposeInlineFormat` takes the creator's text as
 * the page keeps it and the formatting asked for, and answers with the
 * formatted block or with the reason it cannot be one. It never changes a
 * word: the plain text of a proposal is the text sent, character for
 * character (`plainTextOf`), and the creator's click is what applies it
 * (AX274 part B, item 6). Anything it cannot read is refused with a reason,
 * never cleaned into something else (rule 24): raw HTML, a javascript: or
 * data: link, an address the page would not keep (its fix is offered, not
 * applied), link words that do not say where it goes (WCAG 2.4.4, 2.4.9),
 * marks that overlap or nest past the caps below, text over the row's
 * limits or not in the form a page keeps, and any unknown field.
 *
 * Links follow the page's own rule for a button's address (quoteUrl in
 * lib/sales-page.ts): https only, no login in it, no address on this machine.
 *
 * `readInlineBlock` reads a stored block back only when it is exactly what
 * these rules propose from its own words and marks: well-formed and minimal.
 */
import type { Segment } from "@/lib/community-text";
import { vagueLinkTitle } from "@/lib/link-purpose";
import { MAX_ITEM, MAX_ROW_LIST_ITEMS, MAX_ROW_PARAGRAPH, quoteUrl } from "@/lib/sales-page";

/** Marks one paragraph or list may carry, links included. */
export const MAX_INLINE_MARKS = 24;
/** Links in one paragraph or one whole list: a row's buttons are where most links belong. */
export const MAX_INLINE_LINKS = 5;
/** How deep formatting goes: a link, bold, italic, each at most once over any word; nothing nests inside itself. */
export const MAX_INLINE_DEPTH = 3;

/** A piece of words: plain, or a link (Segment), with bold and italic only when set. */
export type InlineRun = Segment & { bold?: true; italic?: true };
export type InlineBlock = { kind: "paragraph"; runs: InlineRun[] } | { kind: "list"; items: InlineRun[][] };

export type InlineMark =
  | { kind: "bold" | "italic"; start: number; end: number }
  | { kind: "link"; start: number; end: number; href: string };
/** What the creator asked for: the block's shape and the marks, by position in the text (UTF-16 units, end not included). */
export type InlineRequest = { as: "paragraph" | "list"; marks: InlineMark[] };

/** Why a text or a request cannot be formatted, in words the editor can show as they are. */
export const INLINE_PROBLEM_WORDS = {
  not_text: "There is no text here to format.",
  empty: "Write some words first, then format them.",
  too_long: `A paragraph here can be up to ${MAX_ROW_PARAGRAPH.toLocaleString("en-US")} characters.`,
  too_many_items: `A list here can have up to ${MAX_ROW_LIST_ITEMS} items.`,
  item_too_long: `Each item in a list can be up to ${MAX_ITEM} characters.`,
  list_empty_item: "A list item cannot be empty. Remove the blank line or write the item.",
  html: "This text has what looks like an HTML tag. Pages show words, not code, so remove the tag.",
  control_character: "This text has a hidden character a page does not keep. Retype that part.",
  not_saved_form: "This text has extra spaces or blank lines. Save the block first, then format it.",
  unknown_request: "This formatting request could not be read. Nothing was changed.",
  unknown_mark: "Only bold, italic and links can be added here. Nothing was changed.",
  bad_range: "That selection does not match the text. Select the words again.",
  too_many_marks: `A paragraph or list can have up to ${MAX_INLINE_MARKS} pieces of formatting.`,
  too_many_links: `A paragraph or list can have up to ${MAX_INLINE_LINKS} links.`,
  marks_overlap: "These words already have that formatting.",
  links_overlap: "Two links cannot overlap or touch. Leave a word between them.",
  mark_splits_link: "Bold or italic must cover a whole link, or none of it.",
  mark_crosses_item: "Formatting cannot run from one list item into the next.",
  link_crosses_line: "A link cannot run across a line break.",
  link_scheme: "A link here must be a web address that starts with https://.",
  link_not_https: "This address cannot be a link here. It must start with https:// and name a public website.",
  link_words: "Say where the link goes in its own words, not \"click here\" or the address itself.",
  malformed: "This saved formatting could not be read. Nothing was changed.",
} as const;
export type InlineProblem = keyof typeof INLINE_PROBLEM_WORDS;

export type InlineRefusal = { ok: false; problem: InlineProblem; words: string; fix?: string };
export type InlineProposal = { ok: true; block: InlineBlock } | InlineRefusal;

const refuse = (problem: InlineProblem, fix?: string): InlineRefusal =>
  fix ? { ok: false, problem, words: INLINE_PROBLEM_WORDS[problem], fix } : { ok: false, problem, words: INLINE_PROBLEM_WORDS[problem] };

/** A tag, a comment or a processing instruction: "<b>", "</p>", "<img src=x>", "<!-- -->". A "<" before a space or a digit is words. */
const HTML = /<\/?[a-z][^<>]*>|<![^<>]*>|<\?[^<>]*>/i;
/** Control characters (C0 but the line break, DEL, C1), the line and paragraph separators, and the ones that flip or isolate the direction of text, which can disguise a link's words. */
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const hasOnly = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every((key) => keys.includes(key));

/** Whether a paragraph is in the form the page keeps (lines in lib/sales-page.ts): no space at either end or at a line's end, at most one blank line in a row. */
function paragraphKept(text: string): boolean {
  if (text !== text.trim() || /\n{3,}/.test(text)) return false;
  return text.split("\n").every((row) => !/\s$/.test(row));
}
/** Whether a list item is in the form the page keeps (line in lib/sales-page.ts): one line, single spaces, none at either end. */
const itemKept = (item: string) => item === item.replace(/\s+/g, " ").trim();

/** Whether a position falls between the two halves of one character. */
const splitsCharacter = (text: string, at: number) => at > 0 && at < text.length && /[\udc00-\udfff]/.test(text[at]) && /[\ud800-\udbff]/.test(text[at - 1]);

/** A link's address as the page keeps it, or the refusal with a fix when there is one. */
function linkAddress(href: string): string | InlineRefusal {
  const typed = href.trim();
  // The scheme as a browser reads it: tabs and line breaks inside it are ignored.
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(typed.replace(/[\u0000- ]/g, ""))?.[1]?.toLowerCase();
  if (scheme && scheme !== "https" && scheme !== "http") return refuse("link_scheme");
  const kept = quoteUrl(href);
  if (kept && kept === href) return kept;
  const fix = kept || (scheme === "http" ? quoteUrl(`https://${typed.slice(typed.indexOf(":") + 1).replace(/^\/+/, "")}`) : "");
  return refuse("link_not_https", fix || undefined);
}

function readMarks(raw: unknown, length: number): InlineMark[] | InlineRefusal {
  if (!Array.isArray(raw)) return refuse("unknown_request");
  if (raw.length > MAX_INLINE_MARKS) return refuse("too_many_marks");
  const marks: InlineMark[] = [];
  for (const value of raw) {
    if (!isPlainObject(value)) return refuse("unknown_mark");
    const { kind, start, end } = value;
    if (kind === "bold" || kind === "italic") {
      if (!hasOnly(value, ["kind", "start", "end"])) return refuse("unknown_mark");
    } else if (kind === "link") {
      if (!hasOnly(value, ["kind", "start", "end", "href"]) || typeof value.href !== "string") return refuse("unknown_mark");
    } else return refuse("unknown_mark");
    if (!Number.isInteger(start) || !Number.isInteger(end)) return refuse("bad_range");
    const s = start as number;
    const e = end as number;
    if (s < 0 || e <= s || e > length) return refuse("bad_range");
    marks.push(kind === "link" ? { kind, start: s, end: e, href: value.href as string } : { kind, start: s, end: e });
  }
  return marks;
}

/**
 * The formatted block the creator asked for, or why it cannot be one. The
 * text must be the paragraph or the list (one item per line) exactly as the
 * page keeps it; nothing sent is changed or written.
 */
export function proposeInlineFormat(text: unknown, request: unknown): InlineProposal {
  if (typeof text !== "string") return refuse("not_text");
  if (!isPlainObject(request) || !hasOnly(request, ["as", "marks"]) || (request.as !== "paragraph" && request.as !== "list")) return refuse("unknown_request");
  const asList = request.as === "list";
  if (!text) return refuse("empty");
  if (!asList && text.length > MAX_ROW_PARAGRAPH) return refuse("too_long");
  if (asList && text.length > (MAX_ITEM + 1) * MAX_ROW_LIST_ITEMS) return refuse(text.split("\n", MAX_ROW_LIST_ITEMS + 1).length > MAX_ROW_LIST_ITEMS ? "too_many_items" : "item_too_long");
  if (CONTROL.test(text)) return refuse("control_character");
  if (HTML.test(text)) return refuse("html");
  const items = asList ? text.split("\n") : [text];
  if (asList) {
    if (items.length > MAX_ROW_LIST_ITEMS) return refuse("too_many_items");
    if (items.some((item) => !item)) return refuse("list_empty_item");
    if (items.some((item) => item.length > MAX_ITEM)) return refuse("item_too_long");
    if (!items.every(itemKept)) return refuse("not_saved_form");
  } else if (!paragraphKept(text)) return refuse("not_saved_form");

  const marks = readMarks(request.marks, text.length);
  if (!Array.isArray(marks)) return marks;
  if (marks.some((mark) => splitsCharacter(text, mark.start) || splitsCharacter(text, mark.end))) return refuse("bad_range");

  const links = marks.filter((mark): mark is Extract<InlineMark, { kind: "link" }> => mark.kind === "link").sort((a, b) => a.start - b.start);
  if (links.length > MAX_INLINE_LINKS) return refuse("too_many_links");
  for (const kind of ["bold", "italic"] as const) {
    const same = marks.filter((mark) => mark.kind === kind).sort((a, b) => a.start - b.start);
    if (same.some((mark, i) => i > 0 && mark.start < same[i - 1].end)) return refuse("marks_overlap");
  }
  // Touching links would read as one link with two addresses.
  if (links.some((link, i) => i > 0 && link.start <= links[i - 1].end)) return refuse("links_overlap");
  for (const mark of marks) {
    const inside = text.slice(mark.start, mark.end);
    if (asList && inside.includes("\n")) return refuse("mark_crosses_item");
    if (mark.kind !== "link") {
      const splits = links.some((link) => mark.start < link.end && link.start < mark.end && !(mark.start <= link.start && mark.end >= link.end));
      if (splits) return refuse("mark_splits_link");
    }
  }
  const hrefs: string[] = [];
  for (const link of links) {
    const words = text.slice(link.start, link.end);
    if (words.includes("\n")) return refuse("link_crosses_line");
    const href = linkAddress(link.href);
    if (typeof href !== "string") return href;
    if (vagueLinkTitle(words)) return refuse("link_words");
    hrefs.push(href);
  }

  const runsOf = (from: number, to: number): InlineRun[] => {
    const cuts = new Set([from, to]);
    for (const mark of marks) for (const at of [mark.start, mark.end]) if (at > from && at < to) cuts.add(at);
    const points = [...cuts].sort((a, b) => a - b);
    const runs: InlineRun[] = [];
    let lastLink = -1;
    for (let i = 0; i + 1 < points.length; i += 1) {
      const [a, b] = [points[i], points[i + 1]];
      const covers = (mark: InlineMark) => mark.start <= a && b <= mark.end;
      const bold = marks.some((mark) => mark.kind === "bold" && covers(mark));
      const italic = marks.some((mark) => mark.kind === "italic" && covers(mark));
      const linkAt = links.findIndex(covers);
      const words = text.slice(a, b);
      const last = runs[runs.length - 1];
      // A link is one run (no mark may split it); plain pieces that look the same are one run.
      if (last && linkAt === lastLink && last.kind === (linkAt >= 0 ? "link" : "text") && !!last.bold === bold && !!last.italic === italic) {
        last.text += words;
        continue;
      }
      const run: InlineRun = linkAt >= 0 ? { kind: "link", text: words, href: hrefs[linkAt] } : { kind: "text", text: words };
      if (bold) run.bold = true;
      if (italic) run.italic = true;
      runs.push(run);
      lastLink = linkAt;
    }
    return runs;
  };

  if (!asList) return { ok: true, block: { kind: "paragraph", runs: runsOf(0, text.length) } };
  let at = 0;
  const listed = items.map((item) => {
    const runs = runsOf(at, at + item.length);
    at += item.length + 1;
    return runs;
  });
  return { ok: true, block: { kind: "list", items: listed } };
}

/** The words of a block as the page keeps them: a paragraph's text, or a list's items one per line. */
export function plainTextOf(block: InlineBlock): string {
  const words = (runs: InlineRun[]) => runs.map((run) => run.text).join("");
  return block.kind === "paragraph" ? words(block.runs) : block.items.map(words).join("\n");
}

/** One stored run, its fields checked and put in the order the rules write them; null when it is not one. */
function readRun(raw: unknown): InlineRun | null {
  if (!isPlainObject(raw) || typeof raw.text !== "string" || !raw.text) return null;
  if (raw.kind === "text") {
    if (!hasOnly(raw, ["kind", "text", "bold", "italic"])) return null;
  } else if (raw.kind === "link") {
    if (!hasOnly(raw, ["kind", "text", "href", "bold", "italic"]) || typeof raw.href !== "string") return null;
  } else return null;
  if (("bold" in raw && raw.bold !== true) || ("italic" in raw && raw.italic !== true)) return null;
  const run: InlineRun = raw.kind === "link" ? { kind: "link", text: raw.text, href: raw.href as string } : { kind: "text", text: raw.text };
  if (raw.bold) run.bold = true;
  if (raw.italic) run.italic = true;
  return run;
}

/** The marks that draw these runs, from `offset` in the whole text: each stretch of bold or italic runs is one mark, each link one mark. */
function marksOf(runs: InlineRun[], offset: number): InlineMark[] {
  const marks: InlineMark[] = [];
  const open: { bold: number; italic: number } = { bold: -1, italic: -1 };
  let at = offset;
  for (const run of [...runs, null]) {
    for (const kind of ["bold", "italic"] as const) {
      const on = !!run?.[kind];
      if (on && open[kind] < 0) open[kind] = at;
      if (!on && open[kind] >= 0) {
        marks.push({ kind, start: open[kind], end: at });
        open[kind] = -1;
      }
    }
    if (!run) break;
    if (run.kind === "link") marks.push({ kind: "link", start: at, end: at + run.text.length, href: run.href });
    at += run.text.length;
  }
  return marks;
}

/**
 * A stored block, read back only when it is exactly what proposeInlineFormat
 * gives for its own words and marks: every field known, no empty or
 * repeated run, nothing nested, every rule above kept. Anything else is
 * refused with a reason, never mended.
 */
export function readInlineBlock(raw: unknown): InlineProposal {
  if (!isPlainObject(raw)) return refuse("malformed");
  let canonical: InlineBlock;
  let text: string;
  let marks: InlineMark[];
  if (raw.kind === "paragraph" && hasOnly(raw, ["kind", "runs"]) && Array.isArray(raw.runs)) {
    if (raw.runs.length > MAX_ROW_PARAGRAPH) return refuse("too_long");
    const runs = raw.runs.map(readRun);
    if (runs.some((run) => !run)) return refuse("malformed");
    canonical = { kind: "paragraph", runs: runs as InlineRun[] };
    text = plainTextOf(canonical);
    marks = marksOf(canonical.runs, 0);
  } else if (raw.kind === "list" && hasOnly(raw, ["kind", "items"]) && Array.isArray(raw.items)) {
    if (raw.items.length > MAX_ROW_LIST_ITEMS) return refuse("too_many_items");
    if (!raw.items.every((item) => Array.isArray(item) && item.length <= MAX_ITEM)) return refuse("malformed");
    const items = (raw.items as unknown[][]).map((item) => item.map(readRun));
    if (items.some((item) => item.some((run) => !run))) return refuse("malformed");
    canonical = { kind: "list", items: items as InlineRun[][] };
    text = plainTextOf(canonical);
    marks = [];
    let at = 0;
    for (const item of canonical.items) {
      marks.push(...marksOf(item, at));
      at += item.reduce((n, run) => n + run.text.length, 0) + 1;
    }
  } else return refuse("malformed");
  const proposed = proposeInlineFormat(text, { as: canonical.kind, marks });
  if (!proposed.ok) return proposed;
  return JSON.stringify(proposed.block) === JSON.stringify(canonical) ? proposed : refuse("malformed");
}
