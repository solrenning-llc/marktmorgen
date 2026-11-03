/**
 * Proposals and agreements with an electronic signature (HighLevel audit H28;
 * added 18 October 2026): the rules, browser-safe.
 *
 * A creator writes a proposal or an agreement for one person they deal with
 * (a coaching client, a brand): a title, plain text and, if they want, lines
 * with amounts. The person gets one email with a link to a page of the
 * store's that shows the exact text, and signs it there by typing their full
 * name, typing the address it was sent to, and checking that they agree to
 * sign electronically and are the person it was sent to.
 *
 * What is recorded, and nothing more is claimed (docs/agreements-esign.md):
 * the exact text shown, its SHA-256 fingerprint, the version number, the
 * name typed, the time, the consent sentence checked, and a one-way code
 * made from the signer's internet address (never the address itself). It
 * is never called "legally binding" or "court-admissible" here: whether an
 * agreement can be enforced depends on the law where the parties are and on
 * what it says, and every page that shows it says so.
 *
 * A version's text never changes once written (lib/agreement-store.ts keeps
 * it under a key written once). Any edit is a new version, which needs a new
 * signature; an earlier signature stays recorded against the text it signed.
 *
 * No count here is a price figure: each email is one of the store's own
 * emails for the month, each record is counted in the store's data room
 * before it is written, and the caps below only bound what a list reads.
 */
import { type Currency, currencyRule, plainAmount, readMoney } from "@/lib/money";
import type { PlanFields } from "@/lib/plan-standing";
import { standingOf } from "@/lib/plan-standing";

export type AgreementKind = "proposal" | "agreement";

export type AgreementLine = {
  /** What it is for, in the creator's words. */
  text: string;
  quantity: number;
  /** Each, in the store currency's smallest unit. */
  cents: number;
};

/** One version: written once, never changed (lib/agreement-store.ts, versionKey). */
export type AgreementVersion = {
  n: number;
  title: string;
  body: string;
  lines: AgreementLine[];
  currency: Currency;
  total: number;
  /** The exact text the page shows and a signature covers (agreementText). */
  text: string;
  /** SHA-256 of `text` as UTF-8, in hex. */
  sha256: string;
  createdAt: number;
};

export type Signature = {
  /** The full name the signer typed, as typed (spaces tidied). */
  name: string;
  at: number;
  /** HMAC-SHA-256 of the signer's internet address under a key of ours, or "" when no key was set: never the address. */
  ipHash: string;
  /** The consent sentence they checked, word for word, and its version. */
  consent: string;
  consentVersion: number;
  /** The fingerprint of the text they signed, the same as the version's. */
  sha256: string;
};

/** What the record keeps of each version: its fingerprint and, once signed, its signature. */
export type VersionMark = { n: number; sha256: string; createdAt: number; signature: Signature | null };

export type AgreementState = "open" | "withdrawn";
export type AgreementStatus = "open" | "signed" | "expired" | "withdrawn";

export type Agreement = {
  /** 32 hex characters: the agreement's name, and the secret in its link. */
  id: string;
  sid: string;
  kind: AgreementKind;
  /** The person it is for: the only one who may sign it. */
  email: string;
  name: string;
  createdAt: number;
  /** When the latest version's link stops taking a signature. */
  expiresAt: number;
  state: AgreementState;
  versions: VersionMark[];
  /** When the link was emailed to the person (each version, and any resend). */
  sent: number[];
  /** Why the last email did not go ("" when it did). */
  failed: string;
  /** A payment request of the store's (lib/payment-request-rules.ts) shown after signing, or "". */
  payRequest: string;
  /** Signed copies emailed: to the signer and to the creator. */
  copies: number;
  closedAt: number;
};

export const MAX_TITLE = 120;
export const MAX_BODY = 12_000;
export const MAX_LINES = 20;
export const MAX_LINE_TEXT = 120;
export const MAX_QUANTITY = 100;
export const MAX_NAME = 80;
/** The least and the most a signer's typed name may be. */
export const MIN_SIGNED_NAME = 2;
export const MAX_SIGNED_NAME = 100;
/** Versions one agreement may have: an edit after that is a new agreement. */
export const MAX_VERSIONS = 5;
/** How long a version's link takes a signature. */
export const SIGN_DAYS = 30;
/** How long the record is kept, from the day it was made. */
export const KEEP_DAYS = 400;
/** Emails to the person about one agreement in all: each version and resends, and signed copies sent again. */
export const MAX_SENDS = 8;
/** The least time between two resends by hand of the same version. */
export const MIN_HOURS_BETWEEN_SENDS = 24;
/** Agreements kept for one person in one store. */
export const MAX_PER_PERSON = 20;
/** Agreements a store keeps in all, so its list is read in one go. */
export const MAX_KEPT_AGREEMENTS = 200;

/** The sentence a signer checks, stored with the signature word for word; a new wording is a new version. */
export const CONSENT_VERSION = 1;

const DAY = 86_400_000;
export const ID_PATTERN = /^[0-9a-f]{32}$/;
export const SHA_PATTERN = /^[0-9a-f]{64}$/;
const EMAIL = /^[^\s@<>()",;:]{1,64}@[^\s@<>()",;:]{1,190}\.[^\s@<>()",;:]{2,63}$/;

/** Whether a store may send agreements now: a plan or a free trial, as for any email it sends. */
export function agreementsAllowed(store: PlanFields, nowSeconds = Date.now() / 1000): boolean {
  const standing = standingOf(store, nowSeconds);
  return standing === "paid" || standing === "trial";
}

/** Where an agreement stands now. */
export function statusOf(a: Pick<Agreement, "state" | "expiresAt" | "versions">, now = Date.now()): AgreementStatus {
  if (a.state === "withdrawn") return "withdrawn";
  const latest = a.versions[a.versions.length - 1];
  if (latest?.signature) return "signed";
  return now >= a.expiresAt ? "expired" : "open";
}

/** The latest version's mark. */
export function latestOf(a: Pick<Agreement, "versions">): VersionMark | null {
  return a.versions[a.versions.length - 1] ?? null;
}

export function linesTotal(lines: AgreementLine[]): number | null {
  let total = 0;
  for (const line of lines) total += line.cents * line.quantity;
  return Number.isSafeInteger(total) ? total : null;
}

/** One line of words as an agreement keeps it: spaces made one, trimmed, cut at `max` (exported for lib/agreement-template-rules.ts). */
export const clean = (value: unknown, max: number) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "");
/** Plain text as typed: line breaks kept, carriage returns made plain, at most two blank lines in a row, no control characters. */
export function plainText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim()
    .slice(0, max);
}

export type AgreementDraft = { kind: AgreementKind; email: string; name: string; title: string; body: string; lines: AgreementLine[]; total: number; payRequest: string };
export type DraftProblem = "kind" | "email" | "name" | "title" | "body" | "lines" | "line" | "amount" | "total" | "pay" | "consent";

export const DRAFT_PROBLEMS: Record<DraftProblem, string> = {
  kind: "Choose a proposal or an agreement.",
  email: "Type the email address of the person who is to sign it.",
  name: `Keep the name within ${MAX_NAME} characters.`,
  title: `Give it a title of up to ${MAX_TITLE} characters.`,
  body: `Write the text, up to ${MAX_BODY.toLocaleString("en-US")} characters.`,
  lines: `Add no more than ${MAX_LINES} lines.`,
  line: `Each line needs what it is for (up to ${MAX_LINE_TEXT} characters) and a quantity from 1 to ${MAX_QUANTITY}.`,
  amount: "Type each line's amount as a plain number, like 120 or 120.50.",
  total: "The total is outside what one agreement may list in your store's currency.",
  pay: "That payment request is not one of this store's open requests.",
  consent: "Check the box to confirm you deal with this person and they expect this from you.",
};

/**
 * What the studio sent for a new agreement, or a new version of one (`revise`:
 * the person and the kind stay as they were), held to every rule here.
 */
export function readDraft(
  body: Record<string, unknown>,
  currency: Currency,
  revise?: Pick<Agreement, "kind" | "email" | "name">,
): { ok: true; draft: AgreementDraft } | { ok: false; problem: DraftProblem; line?: number } {
  const kind = revise ? revise.kind : body.kind === "proposal" || body.kind === "agreement" ? body.kind : null;
  if (!kind) return { ok: false, problem: "kind" };
  let email = revise?.email ?? "";
  let name = revise?.name ?? "";
  if (!revise) {
    email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!EMAIL.test(email) || email.length > 254) return { ok: false, problem: "email" };
    if (typeof body.name === "string" && body.name.trim().length > MAX_NAME) return { ok: false, problem: "name" };
    name = clean(body.name, MAX_NAME);
  }
  if (typeof body.title !== "string" || body.title.trim().length > MAX_TITLE) return { ok: false, problem: "title" };
  const title = clean(body.title, MAX_TITLE);
  if (!title) return { ok: false, problem: "title" };
  if (typeof body.body !== "string" || body.body.trim().length > MAX_BODY) return { ok: false, problem: "body" };
  const text = plainText(body.body, MAX_BODY);
  if (!text) return { ok: false, problem: "body" };
  const raw = Array.isArray(body.lines) ? body.lines : [];
  if (raw.length > MAX_LINES) return { ok: false, problem: "lines" };
  const lines: AgreementLine[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const row = raw[i] && typeof raw[i] === "object" ? (raw[i] as Record<string, unknown>) : {};
    const what = clean(row.text, MAX_LINE_TEXT + 1);
    const quantity = typeof row.quantity === "number" ? row.quantity : Number(typeof row.quantity === "string" ? row.quantity.trim() : NaN);
    if (!what || what.length > MAX_LINE_TEXT || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) return { ok: false, problem: "line", line: i };
    const typed = typeof row.amount === "string" ? row.amount.trim().replace(/^(\d+),(\d{1,2})$/, "$1.$2") : "";
    const cents = readMoney(typed, currency);
    if (cents === null || cents < 0 || cents > currencyRule(currency).maxPrice) return { ok: false, problem: "amount", line: i };
    lines.push({ text: what, quantity, cents });
  }
  const total = linesTotal(lines);
  if (total === null || total > currencyRule(currency).maxPrice * MAX_LINES) return { ok: false, problem: "total" };
  const payRequest = typeof body.payRequest === "string" ? body.payRequest.trim() : "";
  if (payRequest && !ID_PATTERN.test(payRequest)) return { ok: false, problem: "pay" };
  if (!revise && body.consent !== true) return { ok: false, problem: "consent" };
  return { ok: true, draft: { kind, email, name, title, body: text, lines, total, payRequest } };
}

/** The words the exact text is written in: the store's language, fixed into the text when the version is made. */
export type TextWords = {
  kind: Record<AgreementKind, string>;
  from: string;
  to: string;
  version: (n: number, date: string) => string;
  items: string;
  total: string;
};

/**
 * The exact text of one version, as the page shows it and a signature
 * covers: the kind and title, who it is from and to, its number and date,
 * the creator's text as typed, and the lines with amounts written the same
 * way everywhere ("480.00 USD"). Written once, when the version is made.
 */
export function agreementText(
  input: { kind: AgreementKind; title: string; body: string; lines: AgreementLine[]; currency: Currency; total: number; n: number; createdAt: number },
  parties: { store: string; name: string; email: string },
  words: TextWords,
): string {
  const code = input.currency.toUpperCase();
  const money = (cents: number) => `${plainAmount(cents, input.currency)} ${code}`;
  const out = [
    `${words.kind[input.kind]}: ${input.title}`,
    `${words.from}: ${parties.store}`,
    `${words.to}: ${parties.name ? `${parties.name} <${parties.email}>` : parties.email}`,
    words.version(input.n, new Date(input.createdAt).toISOString().slice(0, 10)),
    "",
    input.body,
  ];
  if (input.lines.length) {
    out.push("", `${words.items}:`);
    for (const line of input.lines) out.push(`- ${line.text}${line.quantity > 1 ? ` × ${line.quantity}` : ""}: ${money(line.cents * line.quantity)}`);
    out.push(`${words.total}: ${money(input.total)}`);
  }
  return out.join("\n");
}

/** A signer's typed name, tidied, or null when it cannot be a name. */
export function readSignedName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.replace(/\s+/g, " ").trim();
  if (name.length < MIN_SIGNED_NAME || name.length > MAX_SIGNED_NAME) return null;
  // At least one letter in any script, and nothing that is markup or a link.
  if (!/\p{L}/u.test(name) || /[<>]|https?:|www\./i.test(name)) return null;
  return name;
}

/** Whether the person may still be emailed about it by hand now, and if not, why. */
export function canSendAgain(a: Pick<Agreement, "state" | "expiresAt" | "versions" | "sent">, now = Date.now()): { ok: true } | { ok: false; why: string } {
  if (statusOf(a, now) !== "open") return { ok: false, why: "Only an agreement waiting for a signature can be sent again." };
  if (a.sent.length >= MAX_SENDS) return { ok: false, why: `One agreement is emailed at most ${MAX_SENDS} times.` };
  const last = a.sent[a.sent.length - 1] ?? 0;
  if (now - last < MIN_HOURS_BETWEEN_SENDS * 3_600_000) return { ok: false, why: `The last email about it went less than ${MIN_HOURS_BETWEEN_SENDS} hours ago.` };
  return { ok: true };
}

/** Whether a new version may be made now, and if not, why. */
export function canRevise(a: Pick<Agreement, "state" | "versions" | "sent">): { ok: true } | { ok: false; why: string } {
  if (a.state === "withdrawn") return { ok: false, why: "A withdrawn agreement can't be changed. Write a new one." };
  if (a.versions.length >= MAX_VERSIONS) return { ok: false, why: `One agreement has at most ${MAX_VERSIONS} versions. Write a new one.` };
  if (a.sent.length >= MAX_SENDS) return { ok: false, why: `One agreement is emailed at most ${MAX_SENDS} times. Write a new one.` };
  return { ok: true };
}

export const STATUS_WORDS: Record<AgreementStatus, string> = { open: "Waiting for a signature", signed: "Signed", expired: "Expired", withdrawn: "Withdrawn" };
export const KIND_WORDS: Record<AgreementKind, string> = { proposal: "Proposal", agreement: "Agreement" };

/** Whatever came back from storage, made safe to use; null when it is not an agreement. */
export function parseAgreement(raw: unknown): Agreement | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  const str = (x: unknown, max = 300) => (typeof x === "string" ? x.slice(0, max) : "");
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
  if (typeof v.id !== "string" || !ID_PATTERN.test(v.id) || typeof v.sid !== "string" || !v.sid) return null;
  const versions = Array.isArray(v.versions)
    ? v.versions.flatMap((m): VersionMark[] => {
        const row = m && typeof m === "object" ? (m as Record<string, unknown>) : null;
        if (!row || !Number.isSafeInteger(row.n) || typeof row.sha256 !== "string" || !SHA_PATTERN.test(row.sha256)) return [];
        const s = row.signature && typeof row.signature === "object" ? (row.signature as Record<string, unknown>) : null;
        const signature: Signature | null =
          s && typeof s.name === "string" && typeof s.at === "number" && typeof s.sha256 === "string"
            ? { name: s.name.slice(0, MAX_SIGNED_NAME), at: s.at, ipHash: str(s.ipHash, 64), consent: str(s.consent, 400), consentVersion: num(s.consentVersion), sha256: s.sha256.slice(0, 64) }
            : null;
        return [{ n: row.n as number, sha256: row.sha256, createdAt: num(row.createdAt), signature }];
      }).slice(0, MAX_VERSIONS)
    : [];
  if (!versions.length) return null;
  return {
    id: v.id,
    sid: str(v.sid, 64),
    kind: v.kind === "proposal" ? "proposal" : "agreement",
    email: str(v.email, 254),
    name: str(v.name, MAX_NAME),
    createdAt: num(v.createdAt),
    expiresAt: num(v.expiresAt),
    state: v.state === "withdrawn" ? "withdrawn" : "open",
    versions,
    sent: Array.isArray(v.sent) ? v.sent.filter((t): t is number => typeof t === "number" && Number.isFinite(t)).slice(0, MAX_SENDS) : [],
    failed: str(v.failed, 200),
    payRequest: typeof v.payRequest === "string" && ID_PATTERN.test(v.payRequest) ? v.payRequest : "",
    copies: num(v.copies),
    closedAt: num(v.closedAt),
  };
}

/** One version as stored under its own key, or null. */
export function parseVersion(raw: unknown): AgreementVersion | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  if (!Number.isSafeInteger(v.n) || typeof v.text !== "string" || typeof v.sha256 !== "string" || !SHA_PATTERN.test(v.sha256)) return null;
  const lines = Array.isArray(v.lines)
    ? v.lines.flatMap((l): AgreementLine[] => {
        const row = l && typeof l === "object" ? (l as Record<string, unknown>) : null;
        return row && typeof row.text === "string" && Number.isSafeInteger(row.quantity) && Number.isSafeInteger(row.cents) ? [{ text: row.text, quantity: row.quantity as number, cents: row.cents as number }] : [];
      })
    : [];
  return {
    n: v.n as number,
    title: typeof v.title === "string" ? v.title : "",
    body: typeof v.body === "string" ? v.body : "",
    lines,
    currency: (typeof v.currency === "string" ? v.currency : "usd") as Currency,
    total: typeof v.total === "number" ? v.total : 0,
    text: v.text,
    sha256: v.sha256,
    createdAt: typeof v.createdAt === "number" ? v.createdAt : 0,
  };
}

/** A new agreement's id: 128 random bits, which is also what keeps its link private. */
export function newAgreementId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const SIGN_MS = SIGN_DAYS * DAY;
export const KEEP_MS = KEEP_DAYS * DAY;
