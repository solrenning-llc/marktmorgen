/**
 * Notices about content on a store (added 9 October 2026): what a notice of
 * copyright infringement has to say, as 17 U.S.C. § 512(c)(3) lists it, and
 * what a notice of other illegal content has to say, as the EU's Digital
 * Services Act (Art. 16) lists it — read from the form at /report, which is
 * open to anybody, so every field is held to a length and checked here.
 *
 * Two more kinds since 9 November 2026 (lib/child-safety.ts): a report of
 * child sexual exploitation (18 U.S.C. § 2258A), which asks for no name,
 * signature or sworn statement, only where it is and an address to reply to,
 * so nobody is put off reporting; and a request to remove an intimate image
 * shared without consent (TAKE IT DOWN Act), which is signed by the person
 * with the statement that it is shared without their consent.
 * Browser-safe; lib/takedown.ts keeps them and acts on them.
 */

export const REPORT_KINDS = ["copyright", "other", "child_safety", "intimate_image"] as const;
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

/** What each kind of notice is called, in an email subject or a page title. */
export const REPORT_TITLES: Record<ReportKind, string> = {
  copyright: "Copyright notice",
  other: "Notice of illegal content",
  child_safety: "Child safety report",
  intimate_image: "Request to remove an intimate image",
};

/**
 * The two statements a request to remove an intimate image is confirmed with on the form (components/report-form.tsx),
 * in the sender's words. The person shown may send it, or someone authorized to act for them, so both statements cover
 * either (Revisor 2 on #3695); statedBySender says the same in the third person.
 */
export const INTIMATE_IMAGE_STATEMENTS = {
  goodFaith: "I believe in good faith that this intimate image, of me or of the person I represent, was published without the consent of the person shown.",
  accurate: "The information in this request is accurate, and I am the person shown or authorized to act for them.",
} as const;

/**
 * What the sender confirmed on the form (components/report-form.tsx), in the third person, for the inbox and the
 * notice page; null for a child-safety report, which asks for no signature or statement at all (Revisor 2 on #3587:
 * nobody stated "under penalty of perjury" there, and an intimate-image request's statements are its own).
 */
export function statedBySender(kind: ReportKind): string | null {
  if (kind === "copyright") return "They stated, in good faith, that the use is not authorized, and that the notice is accurate and, under penalty of perjury, that they are authorized to act.";
  if (kind === "intimate_image") return "They stated, in good faith, that this intimate image, of them or of the person they represent, was published without the consent of the person shown, and that the request is accurate and that they are the person shown or authorized to act for them.";
  if (kind === "other") return "They stated, in good faith, that the content described is illegal for the reasons they gave, and that the notice is accurate and complete to the best of their knowledge.";
  return null;
}

/**
 * Reports about a child or an intimate image: the reporter's words, and anything they added to the address, are never
 * passed on to the creator, and the urgent email carries none of them (lib/child-safety.ts).
 */
export const privateReport = (kind: ReportKind): boolean => kind === "child_safety" || kind === "intimate_image";

/** The product part of a store address (/@handle/p/<segment>), decoded, or "" when it has none. */
export function productSegmentIn(url: string): string {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    const at = parts.indexOf("p");
    return at >= 0 ? decodeURIComponent(parts[at + 1] ?? "") : "";
  } catch {
    return "";
  }
}

/**
 * A Marktmorgen address rebuilt from what it names, never from what was typed into it: the product's own address,
 * https://marktmorgen.com/@handle/p/<id>, when `productOf` finds one of the store's products in it; else the store's,
 * https://marktmorgen.com/@handle; else the site's. Words in the path (the title words before a product's id, anything
 * after it), the query and the fragment are dropped, since whoever typed the address may have put anything there
 * (Revisor 2 on #3587 and #3695). Null for an address outside Marktmorgen.
 */
export function canonicalAddress(url: string, productOf?: (segment: string) => string | null): string | null {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host !== "marktmorgen.com" && host !== "www.marktmorgen.com") return null;
  const handle = handleIn(url);
  if (!handle) return "https://marktmorgen.com";
  const segment = productSegmentIn(url);
  const id = segment && productOf ? productOf(segment) : null;
  return id ? `https://marktmorgen.com/@${handle}/p/${encodeURIComponent(id)}` : `https://marktmorgen.com/@${handle}`;
}

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
  // A child-safety report needs no words about the content at all: where it is is enough, and asking for more invites
  // a description of the images.
  if (kind !== "child_safety" && report.work.length < 20) return { ok: false, problem: "work" };
  if (!EMAIL.test(report.email)) return { ok: false, problem: "email" };
  // A child-safety report is never held back for a name, a signature or a sworn statement.
  if (kind === "child_safety") return { ok: true, report: { ...report, accurate: false } };
  if (report.name.length < 2) return { ok: false, problem: "name" };
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
  work: "Describe the work, or what is wrong with the content, in at least a sentence. Never describe or attach the images themselves.",
  name: "Give your full name.",
  email: "Give an email address we can reply to.",
  contact: "A copyright notice needs a postal address or a telephone number as well.",
  signature: "Type your full name as your signature.",
  statements: "Both statements have to be confirmed for us to act on a notice.",
};
