/**
 * Notices about content on a store (added 9 October 2026): what a notice of
 * copyright infringement has to say, as 17 U.S.C. § 512(c)(3) lists it, and
 * what a notice of other illegal content has to say, as the EU's Digital
 * Services Act (Art. 16) lists it — read from the form at /report, which is
 * open to anybody, so every field is held to a length and checked here.
 * Browser-safe; lib/takedown.ts keeps them and acts on them.
 */

export const REPORT_KINDS = ["copyright", "other"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export const MAX_REPORT_URL = 500;
export const MAX_REPORT_TEXT = 3_000;
export const MAX_REPORT_NAME = 120;
export const MAX_REPORT_CONTACT = 300;

export type ReportInput = {
  kind: ReportKind;
  /** Where on this site the content is. */
  url: string;
  /** The work that was copied, or why the content is illegal. */
  work: string;
  /** For a copyright notice, where the original can be seen, when it can. */
  original: string;
  name: string;
  email: string;
  /** A postal address or a telephone number, which a copyright notice must give. */
  contact: string;
  /** The typed name that signs it. */
  signature: string;
  /** "I believe in good faith…" and "accurate, and under penalty of perjury, authorized…". */
  goodFaith: boolean;
  accurate: boolean;
};

export type ReportProblem = "kind" | "url" | "work" | "name" | "email" | "contact" | "signature" | "statements";

const EMAIL = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}\.[a-z]{2,24}$/i;
const clean = (value: unknown, max: number) => (typeof value === "string" ? value.replace(/\r\n?/g, "\n").replace(/[^\S\n]+/g, " ").trim().slice(0, max) : "");

/** The handle a site address names (/@handle/…), or "" when it names none. */
export function handleIn(url: string): string {
  try {
    const first = decodeURIComponent(new URL(url).pathname.split("/")[1] ?? "");
    return /^@[a-z0-9_-]{1,40}$/i.test(first) ? first.slice(1).toLowerCase() : "";
  } catch {
    return "";
  }
}

/** A form's fields made into a notice, or what is missing from it. */
export function readReport(raw: Record<string, unknown>): { ok: true; report: ReportInput } | { ok: false; problem: ReportProblem } {
  const kind = REPORT_KINDS.find((k) => k === raw.kind);
  if (!kind) return { ok: false, problem: "kind" };
  const report: ReportInput = {
    kind,
    url: clean(raw.url, MAX_REPORT_URL),
    work: clean(raw.work, MAX_REPORT_TEXT),
    original: clean(raw.original, MAX_REPORT_URL),
    name: clean(raw.name, MAX_REPORT_NAME),
    email: clean(raw.email, MAX_REPORT_CONTACT),
    contact: clean(raw.contact, MAX_REPORT_CONTACT),
    signature: clean(raw.signature, MAX_REPORT_NAME),
    goodFaith: raw.goodFaith === true || raw.goodFaith === "yes",
    accurate: raw.accurate === true || raw.accurate === "yes",
  };
  // Longer than is kept is refused, never cut: a cut address is a broken one.
  if (typeof raw.url === "string" && raw.url.trim().length > MAX_REPORT_URL) return { ok: false, problem: "url" };
  if (!/^https?:\/\/\S+$/i.test(report.url)) return { ok: false, problem: "url" };
  if (report.work.length < 20) return { ok: false, problem: "work" };
  if (report.name.length < 2) return { ok: false, problem: "name" };
  if (!EMAIL.test(report.email)) return { ok: false, problem: "email" };
  // A copyright notice needs a way to reach its sender beyond email, and a signature (§ 512(c)(3)(A), (D)).
  if (kind === "copyright" && report.contact.length < 6) return { ok: false, problem: "contact" };
  if (report.signature.length < 2) return { ok: false, problem: "signature" };
  if (!report.goodFaith || !report.accurate) return { ok: false, problem: "statements" };
  return { ok: true, report };
}

/** What the form says when a notice is missing something. */
export const REPORT_PROBLEMS: Record<ReportProblem, string> = {
  kind: "Choose what the notice is about.",
  url: "Paste the full address of the page on Marktmorgen, starting with https://.",
  work: "Describe the work, or what is illegal about the content, in at least a sentence.",
  name: "Give your full name.",
  email: "Give an email address we can reply to.",
  contact: "A copyright notice needs a postal address or a telephone number as well.",
  signature: "Type your full name as your signature.",
  statements: "Both statements have to be confirmed for us to act on a notice.",
};
