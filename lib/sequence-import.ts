/**
 * A sequence brought in from a simple file (544 [SQ9], unit 1; added 2
 * November 2026): the rules that read a CSV of emails written for another
 * service and make the steps of a sequence (lib/flows.ts) from it, with an
 * exact report of what came in and what did not. Pure (no store, email,
 * Redis or network); read on the server, and the studio shows its report.
 *
 * The file has one email per row, in the columns of the template the studio
 * offers (lib/sequence-template.ts): order, days after the one before (for
 * the first, after the sequence starts), subject, preview text and body.
 * Names other services use for the same columns are read too, the
 * template's own names first.
 *
 * What is made of it, and what is not:
 *
 *   - Nothing is sent and nothing is switched on: what this reads opens in
 *     the studio's editor, where the creator picks what starts the sequence,
 *     reads every email and saves it, paused (unit 2).
 *   - The body comes in as text. HTML is walked once, start to end, never
 *     with a pattern that can go back over what it read (a large file costs
 *     time in proportion to its size): paragraphs, line breaks and list items
 *     are kept, and a link as its words and its address; scripts, styles,
 *     images, comments and the rest of the markup are taken out. A link
 *     through another service's click tracker is taken out and reported, so
 *     no reader is sent through the old service.
 *   - Emails here have no merge fields, so another service's variables
 *     (*|FNAME|*, {{ subscriber.first_name }}, {% if %}, {$name}, %FIRSTNAME%)
 *     are taken out and listed, in the subject, the body and a link's
 *     address alike, never sent as written.
 *   - The preview text has no place in a sequence's email yet (537 [PH1]): it
 *     is reported, not kept.
 *   - A row whose subject or body is missing or too long, or whose wait
 *     cannot be read, is left out and reported; its wait is added to the next
 *     email's, so the emails after it keep their days.
 *   - At most MAX_STEPS emails; the rows past it are reported. A file larger
 *     than MAX_SEQUENCE_FILE_BYTES, or where no email could be kept, is
 *     refused whole, saying why.
 */
import { parseCsv } from "@/lib/csv";
import { MAX_STEPS } from "@/lib/flow-limits";
import { MAX_FLOW_WAIT_HOURS } from "@/lib/flow-rules";
import { MAX_SEQUENCE_FILE_BYTES, SEQUENCE_BODY_MAX, SEQUENCE_SUBJECT_MAX, SEQUENCE_TEMPLATE } from "@/lib/sequence-template";

export { MAX_SEQUENCE_FILE_BYTES, SEQUENCE_TEMPLATE };

type Column = (typeof SEQUENCE_TEMPLATE)[number];

/** Other names for the same columns, as other services and people write them, lowercased; the template's own name first. */
const COLUMN_NAMES: Record<Column, string[]> = {
  order: ["order", "position", "step", "#", "email number", "number"],
  days_after: ["days_after", "days after", "delay", "delay (days)", "wait", "wait (days)", "days", "send after (days)"],
  subject: ["subject", "subject line", "title"],
  preview: ["preview", "preview text", "preheader", "pre-header"],
  body: ["body", "content", "text", "message", "html", "email body"],
};

export type SequenceStep = { delayHours: number; subject: string; body: string };

export type ReportLine = {
  /** The file's line, counting the header as 1; 0 for the file as a whole. */
  line: number;
  column: Column | "file";
  /** What happened, in plain words for the creator. */
  reason: string;
};

export type SequenceImport =
  | { ok: true; steps: SequenceStep[]; report: ReportLine[] }
  | { ok: false; why: "size" | "empty" | "columns"; report: ReportLine[] };

/**
 * Click trackers of the services people move from, by host: a link through
 * one is taken out, never carried. Only hosts that do nothing but count
 * clicks; a service's own pages (a landing page, a hosted file, a post) are
 * ordinary links and stay.
 */
const TRACKER_HOSTS = [/(^|\.)list-manage\.com$/, /(^|\.)convertkit-mail\d*\.com$/, /(^|\.)acemlna\.com$/, /^link\.mail\.beehiiv\.com$/, /(^|\.)mlsend\.com$/, /^click\.mailerlite\.com$/, /(^|\.)ct\.sendgrid\.net$/, /(^|\.)hubspotlinks\.com$/, /(^|\.)klclick\d*\.com$/];

/** Another service's variables: Mailchimp *|X|*, Liquid {{ x }} and {% x %}, MailerLite {$x}, and %X%. Each bounded and on one line. */
const VARIABLE = /\*\|[^|*\n]{1,60}\|\*|\{\{[^{}\n]{1,80}\}\}|\{%[^%\n]{0,80}%\}|\{\$[A-Za-z_][^{}\n]{0,60}\}|%[A-Z][A-Z0-9_]{1,40}%/g;

/** Control characters, those that change the order text is shown in, and the invisible ones. */
const UNSEEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u00ad\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g;

/** The named characters emails use most, as the characters themselves. */
const NAMED: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  copy: "©",
  reg: "®",
  trade: "™",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  euro: "€",
  pound: "£",
  middot: "·",
  bull: "•",
};

const fromCode = (code: number) => (Number.isSafeInteger(code) && code > 31 && code < 0x110000 && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : "");

/** Character references, read once each (&amp;lt; stays &lt;). */
const decode = (text: string) =>
  text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, ref: string) =>
    ref[0] !== "#" ? (NAMED[ref.toLowerCase()] ?? whole) : fromCode(ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : Number(ref.slice(1))),
  );

function isTracker(href: string): boolean {
  try {
    const host = new URL(href).hostname.toLowerCase().replace(/\.$/, "");
    return TRACKER_HOSTS.some((pattern) => pattern.test(host));
  } catch {
    return false;
  }
}

/** Elements whose content is never text a reader sees. */
const HIDDEN = new Set(["script", "style", "head", "title", "noscript", "template", "svg", "object", "iframe"]);
const BLOCK_END = new Set(["p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "tr", "table", "blockquote", "section", "article", "header", "footer"]);

/** The end of a tag that starts at `from` ("<"): the first ">" outside quotes, or -1. Linear. */
function tagEnd(text: string, from: number): number {
  let quote = "";
  for (let i = from + 1; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === ">") return i;
  }
  return -1;
}

/** One attribute of a tag's text, quoted or not; empty when absent. */
function attribute(tag: string, name: string): string {
  const source = tag.slice(0, 4_000);
  let i = 1;
  // Skip the element name, then consume each whole attribute and its value.
  // A whitespace + href inside a quoted title is still that title's value.
  while (i < source.length && !/[\s/>]/.test(source[i])) i += 1;
  while (i < source.length) {
    while (i < source.length && /\s/.test(source[i])) i += 1;
    if (source[i] === ">" || source[i] === "/" || i >= source.length) break;
    const start = i;
    while (i < source.length && !/[\s=/>]/.test(source[i])) i += 1;
    if (i === start) { i += 1; continue; }
    const key = source.slice(start, i).toLowerCase();
    while (i < source.length && /\s/.test(source[i])) i += 1;
    if (source[i] !== "=") continue;
    i += 1;
    while (i < source.length && /\s/.test(source[i])) i += 1;
    const quote = source[i] === '"' || source[i] === "'" ? source[i++] : null;
    const valueStart = i;
    while (i < source.length && (quote ? source[i] !== quote : !/[\s"'>]/.test(source[i]))) i += 1;
    const value = source.slice(valueStart, i);
    if (quote && source[i] === quote) i += 1;
    if (key === name.toLowerCase()) return value;
  }
  return "";
}

type Taken = { variables: string[]; trackers: number; images: number };

/** Text and a link's address, with another service's variables taken out and kept for the report. */
function withoutVariables(text: string, taken: Taken): string {
  return text.replace(VARIABLE, (found) => {
    if (!taken.variables.includes(found)) taken.variables.push(found);
    return "";
  });
}

/** HTML walked once, as text a reader sees. */
function htmlText(html: string, taken: Taken): string {
  const out: string[] = [];
  const lower = html.toLowerCase();
  let link: { href: string; at: number } | null = null;
  let i = 0;
  while (i < html.length) {
    const open = html.indexOf("<", i);
    const textEnd = open === -1 ? html.length : open;
    if (textEnd > i) out.push(html.slice(i, textEnd).replace(/\s+/g, " "));
    if (open === -1) break;
    if (lower.startsWith("<!--", open)) {
      const close = lower.indexOf("-->", open + 4);
      i = close === -1 ? html.length : close + 3;
      continue;
    }
    const end = tagEnd(html, open);
    if (end === -1) {
      // A "<" that starts no tag is text.
      out.push("<");
      i = open + 1;
      continue;
    }
    const tag = html.slice(open, end + 1);
    const name = /^<\/?\s*([a-z][a-z0-9-]*)/i.exec(tag)?.[1]?.toLowerCase() ?? "";
    const closing = tag[1] === "/";
    i = end + 1;
    if (!name) continue;
    if (!closing && HIDDEN.has(name)) {
      const close = lower.indexOf(`</${name}`, i);
      i = close === -1 ? html.length : Math.max(i, tagEnd(html, close) + 1 || html.length);
      continue;
    }
    if (name === "img") {
      if (!closing) taken.images += 1;
    } else if (name === "br") out.push("\n");
    else if (name === "li") {
      // A new item on a line of its own, never a blank line between two.
      const last = out.length ? out[out.length - 1] : "\n";
      out.push(closing ? "\n" : last.endsWith("\n") ? "- " : "\n- ");
    }
    else if (BLOCK_END.has(name)) {
      if (closing) out.push("\n\n");
    } else if (name === "a") {
      if (!closing) link = { href: decode(attribute(tag, "href")).trim(), at: out.length };
      else if (link) {
        const words = out.splice(link.at).join("").replace(/\s+/g, " ").trim();
        const address = withoutVariables(link.href, taken).trim();
        if (/^https?:\/\//i.test(address) && isTracker(address)) taken.trackers += 1;
        out.push(/^https?:\/\/\S+$/i.test(address) && !isTracker(address) && words !== address ? (words ? `${words} (${address})` : address) : words);
        link = null;
      }
    }
  }
  return decode(out.join(""));
}

/**
 * A body written for another service, as plain text a sequence can send, and
 * what was taken out of it.
 */
export function plainBody(raw: string): { body: string } & Taken {
  const taken: Taken = { variables: [], trackers: 0, images: 0 };
  let text = raw.replace(/\r\n?/g, "\n");
  // Markup is looked for in a bounded way: a "<", a letter, and a ">" within a short distance.
  if (/<\/?[a-z][^<>]{0,500}>/i.test(text)) text = htmlText(text, taken);
  // A bare address through a tracker, in a text body too.
  text = text.replace(/https?:\/\/[^\s<>()"']{1,2048}/g, (address) => {
    if (!isTracker(address)) return address;
    taken.trackers += 1;
    return "";
  });
  text = withoutVariables(text, taken);
  const body = text
    .replace(UNSEEN, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { body, ...taken };
}

/** A subject as one plain line: no markup, references read, nothing unseen; another service's variables taken out. */
function plainSubject(raw: string, taken: Taken): string {
  const text = decode(raw.replace(/<[^<>]{0,200}>/g, ""));
  return withoutVariables(text, taken).replace(UNSEEN, "").replace(/\s+/g, " ").trim();
}

/** Which column of the file is which: the template's own names first, then other services' names for them. */
function columnsOf(header: string[]): Partial<Record<Column, number>> {
  const names = header.map((name) => name.trim().toLowerCase());
  const out: Partial<Record<Column, number>> = {};
  const used = new Set<number>();
  for (const pass of [0, 1]) {
    for (const column of SEQUENCE_TEMPLATE) {
      if (out[column] !== undefined) continue;
      const index = names.findIndex((name, i) => !used.has(i) && (pass === 0 ? name === column : COLUMN_NAMES[column].includes(name)));
      if (index !== -1) {
        out[column] = index;
        used.add(index);
      }
    }
  }
  return out;
}

/** Days written as a whole number, from 0 to a year; a half day or anything else is not read. */
function readDays(raw: string): number | null {
  const text = raw.trim();
  if (text === "") return 0;
  if (!/^\d{1,3}$/.test(text)) return null;
  const days = Number(text);
  return days * 24 <= MAX_FLOW_WAIT_HOURS ? days : null;
}

/** Reads a file of emails into the steps of a sequence, with the report of everything left out or changed. */
export function readSequenceCsv(text: string, bytes: number = new TextEncoder().encode(text).length): SequenceImport {
  if (bytes > MAX_SEQUENCE_FILE_BYTES) {
    return { ok: false, why: "size", report: [{ line: 0, column: "file", reason: `The file is larger than ${MAX_SEQUENCE_FILE_BYTES / 1000} KB. Split it into two sequences, or keep the emails' text only.` }] };
  }
  const parsed = parseCsv(text, MAX_STEPS * 5);
  const columns = columnsOf(parsed.header);
  const missing = (["subject", "body"] as const).filter((column) => columns[column] === undefined);
  if (missing.length) {
    return { ok: false, why: "columns", report: missing.map((column) => ({ line: 1, column, reason: `The file has no "${column}" column. Use the template's columns: ${SEQUENCE_TEMPLATE.join(", ")}.` })) };
  }
  if (parsed.rows.length === 0) return { ok: false, why: "empty", report: [{ line: 0, column: "file", reason: "The file has no emails under its header." }] };

  const report: ReportLine[] = [];
  const cell = (row: string[], column: Column) => (columns[column] === undefined ? "" : row[columns[column] as number] ?? "");
  // In the file's own order column when every row has a whole number there; else in the order of the rows.
  const numbered = parsed.rows.map((row, i) => ({ row, line: parsed.lines[i], order: cell(row, "order").trim() }));
  const byOrder = columns.order !== undefined && numbered.every((r) => /^\d{1,4}$/.test(r.order));
  if (columns.order !== undefined && !byOrder) report.push({ line: 0, column: "order", reason: "Some rows have no whole number in the order column, so the emails are kept in the order of the rows." });
  const ordered = byOrder ? [...numbered].sort((a, b) => Number(a.order) - Number(b.order) || a.line - b.line) : numbered;

  const steps: SequenceStep[] = [];
  // The wait of an email left out, carried to the next one, so the emails after it keep their days.
  let carried = 0;
  for (const { row, line } of ordered) {
    const days = readDays(cell(row, "days_after"));
    if (days === null) {
      report.push({ line, column: "days_after", reason: "The wait is not a whole number of days from 0 to 365. This email was left out." });
      continue;
    }
    const taken: Taken = { variables: [], trackers: 0, images: 0 };
    const subject = plainSubject(cell(row, "subject"), taken);
    const read = plainBody(cell(row, "body"));
    const leftOut = (column: Column | "file", why: string) => {
      report.push({ line, column, reason: `${why} This email was left out${carried + days ? "; its wait was added to the next email's, so the ones after it keep their days" : ""}.` });
      carried += days;
    };
    if (!subject) {
      leftOut("subject", "The subject is empty.");
      continue;
    }
    if (subject.length > SEQUENCE_SUBJECT_MAX) {
      leftOut("subject", `The subject is longer than ${SEQUENCE_SUBJECT_MAX} characters.`);
      continue;
    }
    if (!read.body) {
      leftOut("body", "The body is empty once its markup is taken out.");
      continue;
    }
    if (read.body.length > SEQUENCE_BODY_MAX) {
      leftOut("body", `The body is longer than ${SEQUENCE_BODY_MAX.toLocaleString("en-US")} characters.`);
      continue;
    }
    if (steps.length >= MAX_STEPS) {
      report.push({ line, column: "file", reason: `A sequence holds at most ${MAX_STEPS} emails. This one was left out.` });
      continue;
    }
    const hours = (carried + days) * 24;
    if (hours > MAX_FLOW_WAIT_HOURS) {
      leftOut("days_after", "With the wait of the emails left out before it, this one would come more than a year after the one before.");
      continue;
    }
    const variables = [...new Set([...taken.variables, ...read.variables])];
    if (variables.length) report.push({ line, column: "body", reason: `Taken out, because emails here have no merge fields: ${variables.join(", ")}. Read the sentence around it.` });
    if (read.trackers) report.push({ line, column: "body", reason: `${read.trackers} ${read.trackers === 1 ? "link went" : "links went"} through the old service's click tracker and ${read.trackers === 1 ? "was" : "were"} taken out. Add the real address if you need it.` });
    if (read.images) report.push({ line, column: "body", reason: `${read.images} ${read.images === 1 ? "image was" : "images were"} taken out. Upload an image again if you need it.` });
    if (cell(row, "preview").trim()) report.push({ line, column: "preview", reason: "Preview text is not kept yet: a sequence's email has no place for it." });
    steps.push({ delayHours: hours, subject, body: read.body });
    carried = 0;
  }
  if (parsed.truncated) report.push({ line: 0, column: "file", reason: `Only the first ${MAX_STEPS * 5} rows were read.` });
  if (!steps.length) return { ok: false, why: "empty", report: [...report, { line: 0, column: "file", reason: "No email in the file could be brought in." }] };
  return { ok: true, steps, report };
}
