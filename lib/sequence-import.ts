/**
 * A sequence brought in from a simple file (544 [SQ9], unit 1; added 2
 * November 2026): the rules that read a CSV of emails written for another
 * service and make the steps of a sequence (lib/flows.ts) from it, with an
 * exact report of what came in and what did not. Pure; read on the server
 * (it holds to the mail limits of lib/mail.ts), and the studio shows its
 * report as it is.
 *
 * The file has one email per row, in the columns of the template the studio
 * offers (SEQUENCE_TEMPLATE): order, days after the one before (for the
 * first, after the sequence starts), subject, preview text and body. Names
 * the other services use for the same columns are read too.
 *
 * What is made of it, and what is not:
 *
 *   - Nothing is sent and nothing is switched on: what this reads becomes a
 *     sequence the creator reviews and switches on themselves (unit 2).
 *   - The body comes in as text. HTML is read as text (paragraphs and line
 *     breaks kept, a link kept as its words and its address); scripts,
 *     styles, images, tracking pixels and comments are taken out, never
 *     carried. A link through another service's click tracker is taken out
 *     and reported, so no reader is sent through the old service.
 *   - Marktmorgen has no merge fields in emails, so another service's
 *     variables (*|FNAME|*, {{ subscriber.first_name }}, {% if %}, %FIRSTNAME%)
 *     are taken out and listed in the report, never sent as written.
 *   - The preview text has no place in a sequence's email yet (537 [PH1]): it
 *     is reported, not kept.
 *   - A row whose subject or body is missing or too long, or whose wait
 *     cannot be read, is left out and reported; the others come in, in their
 *     order.
 *   - At most MAX_STEPS emails (lib/flow-limits.ts); the rows past it are
 *     reported. A file larger than MAX_SEQUENCE_FILE_BYTES is refused whole.
 */
import { parseCsv } from "@/lib/csv";
import { MAX_STEPS } from "@/lib/flow-limits";
import { MAX_FLOW_WAIT_HOURS } from "@/lib/flow-rules";
import { MAX_MAIL_BODY, MAX_SUBJECT } from "@/lib/mail";

/** The largest file read: twenty long emails fit well inside it. */
export const MAX_SEQUENCE_FILE_BYTES = 500_000;

/** The template's columns, in order, as the studio offers it for download. */
export const SEQUENCE_TEMPLATE = ["order", "days_after", "subject", "preview", "body"] as const;

type Column = (typeof SEQUENCE_TEMPLATE)[number];

/** Other names for the same columns, as other services and people write them, lowercased. */
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

/** Click trackers of the services people move from: a link through one is taken out, never carried. */
const TRACKER_HOSTS = [
  /(^|\.)list-manage\.com$/i,
  /(^|\.)mcusercontent\.com$/i,
  /(^|\.)ck\.page$/i,
  /(^|\.)convertkit-mail\d*\.com$/i,
  /(^|\.)kit-mail\d*\.com$/i,
  /(^|\.)activehosted\.com$/i,
  /(^|\.)acemlna\.com$/i,
  /(^|\.)beehiiv\.com$/i,
  /(^|\.)mlsend\.com$/i,
  /(^|\.)mailerlite\.com$/i,
  /(^|\.)sendgrid\.net$/i,
  /(^|\.)mailchimp\.com$/i,
  /(^|\.)hubspotlinks\.com$/i,
  /(^|\.)klclick\d*\.com$/i,
];

/** Another service's variables: Mailchimp *|X|*, Liquid {{ x }} and {% x %}, and %X%. */
const VARIABLE = /\*\|[^|*\n]{1,60}\|\*|\{\{[^{}\n]{1,80}\}\}|\{%[^%\n]{0,80}%\}|%[A-Z][A-Z0-9_]{1,40}%/g;

/** The named characters emails use most, as the characters themselves. */
const NAMED: Record<string, string> = {
  copy: "\u00a9",
  reg: "\u00ae",
  trade: "\u2122",
  mdash: "\u2014",
  ndash: "\u2013",
  hellip: "\u2026",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201c",
  rdquo: "\u201d",
  euro: "\u20ac",
  pound: "\u00a3",
  middot: "\u00b7",
  bull: "\u2022",
};

const fromCode = (code: number) => (code > 31 && code < 0x110000 && (code < 0xd800 || code > 0xdfff) && code !== 0x200b && code !== 0xfeff ? String.fromCodePoint(code) : "");

const decode = (text: string) =>
  text
    .replace(/&([a-z]{2,8});/gi, (whole, name: string) => NAMED[name.toLowerCase()] ?? whole)
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, hex: string) => fromCode(parseInt(hex, 16)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d{1,7});/g, (_, n: string) => fromCode(Number(n)))
    .replace(/&amp;/gi, "&");

function isTracker(href: string): boolean {
  try {
    const host = new URL(href).hostname;
    return TRACKER_HOSTS.some((pattern) => pattern.test(host));
  } catch {
    return false;
  }
}

/**
 * A body written for another service, as plain text a sequence can send, and
 * what was taken out of it. HTML is read only for its words: nothing of its
 * markup, scripts, styles, images or comments is kept.
 */
export function plainBody(raw: string): { body: string; variables: string[]; trackers: number; images: number } {
  let text = raw.replace(/\r\n?/g, "\n");
  let images = 0;
  let trackers = 0;
  const html = /<\/?[a-z][\s\S]*?>/i.test(text);
  if (html) {
    text = text
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<(script|style|head|title|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, "")
      .replace(/<img\b[^>]*>/gi, () => {
        images += 1;
        return "";
      })
      // A link keeps its words and its address; through a tracker, only its words.
      .replace(/<a\b[^>]*?href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a\s*>/gi, (_, _q, href: string, inner: string) => {
        const words = inner.replace(/<[^>]*>/g, "").trim();
        const address = decode(href.trim());
        if (!/^https?:\/\//i.test(address)) return words;
        if (isTracker(address)) {
          trackers += 1;
          return words;
        }
        return words && words !== address ? `${words} (${address})` : address;
      })
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/li\s*>/gi, "\n")
      .replace(/<\/(p|div|h[1-6]|ul|ol|tr|table|blockquote)\s*>/gi, "\n\n")
      .replace(/<li\b[^>]*>/gi, "- ")
      .replace(/<[^>]*>/g, "");
    text = decode(text);
  }
  // A bare address through a tracker, in a text body too.
  text = text.replace(/https?:\/\/[^\s<>()"']+/g, (address) => {
    if (!isTracker(address)) return address;
    trackers += 1;
    return "";
  });
  const variables = [...new Set(text.match(VARIABLE) ?? [])];
  text = text.replace(VARIABLE, "");
  const body = text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b\ufeff]/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { body, variables, trackers, images };
}

/** Which column of the file is which: by the template's names, and the other services' names for them. */
function columnsOf(header: string[]): Partial<Record<Column, number>> {
  const out: Partial<Record<Column, number>> = {};
  header.forEach((name, index) => {
    const key = name.trim().toLowerCase();
    for (const column of SEQUENCE_TEMPLATE) {
      if (out[column] === undefined && COLUMN_NAMES[column].includes(key)) out[column] = index;
    }
  });
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
    return { ok: false, why: "size", report: [{ line: 0, column: "file", reason: `The file is larger than ${MAX_SEQUENCE_FILE_BYTES / 1000} KB. Split it, or keep the emails' text only.` }] };
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
  // In the file's own order column when every row has a number there; else in the order of the rows.
  const numbered = parsed.rows.map((row, i) => ({ row, line: parsed.lines[i], order: Number(cell(row, "order").trim()) }));
  const byOrder = columns.order !== undefined && numbered.every((r) => cell(r.row, "order").trim() !== "" && Number.isInteger(r.order));
  if (columns.order !== undefined && !byOrder) report.push({ line: 0, column: "order", reason: "Some rows have no whole number in the order column, so the emails are kept in the order of the rows." });
  const ordered = byOrder ? [...numbered].sort((a, b) => a.order - b.order || a.line - b.line) : numbered;

  const steps: SequenceStep[] = [];
  for (const { row, line } of ordered) {
    const days = readDays(cell(row, "days_after"));
    if (days === null) {
      report.push({ line, column: "days_after", reason: "The wait is not a whole number of days from 0 to 365. This email was left out." });
      continue;
    }
    const subject = cell(row, "subject").replace(/\s+/g, " ").trim();
    const subjectVars = subject.match(VARIABLE) ?? [];
    const cleanSubject = subject.replace(VARIABLE, "").replace(/\s+/g, " ").trim();
    if (!cleanSubject) {
      report.push({ line, column: "subject", reason: "The subject is empty. This email was left out." });
      continue;
    }
    if (cleanSubject.length > MAX_SUBJECT) {
      report.push({ line, column: "subject", reason: `The subject is longer than ${MAX_SUBJECT} characters. This email was left out.` });
      continue;
    }
    const read = plainBody(cell(row, "body"));
    if (!read.body) {
      report.push({ line, column: "body", reason: "The body is empty once its markup is taken out. This email was left out." });
      continue;
    }
    if (read.body.length > MAX_MAIL_BODY) {
      report.push({ line, column: "body", reason: `The body is longer than ${MAX_MAIL_BODY.toLocaleString("en-US")} characters. This email was left out.` });
      continue;
    }
    if (steps.length >= MAX_STEPS) {
      report.push({ line, column: "file", reason: `A sequence holds at most ${MAX_STEPS} emails. This one was left out.` });
      continue;
    }
    const variables = [...new Set([...subjectVars, ...read.variables])];
    if (variables.length) report.push({ line, column: "body", reason: `Taken out, because emails here have no merge fields: ${variables.join(", ")}. Read the sentence around it.` });
    if (read.trackers) report.push({ line, column: "body", reason: `${read.trackers} ${read.trackers === 1 ? "link went" : "links went"} through the old service's click tracker and ${read.trackers === 1 ? "was" : "were"} taken out. Add the real address if you need it.` });
    if (read.images) report.push({ line, column: "body", reason: `${read.images} ${read.images === 1 ? "image was" : "images were"} taken out. Upload an image again if you need it.` });
    if (cell(row, "preview").trim()) report.push({ line, column: "preview", reason: "Preview text is not kept yet: a sequence's email has no place for it." });
    steps.push({ delayHours: days * 24, subject: cleanSubject, body: read.body });
  }
  if (parsed.truncated) report.push({ line: 0, column: "file", reason: `Only the first ${MAX_STEPS * 5} rows were read.` });
  return { ok: true, steps, report };
}
