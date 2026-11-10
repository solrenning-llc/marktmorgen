/**
 * "Apply first" (604 [WP3]), as rules with no I/O: an offer whose page shows
 * an application form in place of the buy button. The creator approves or
 * declines each application; an approved applicant gets a personal link to
 * buy that is
 *
 *   - single use: once a purchase starts on it, the application is "used"
 *     and the link never opens anything again;
 *   - tied to the address that applied: the buyer types it at the link, and
 *     only that address (trimmed, lower case) passes;
 *   - bounded in time: it expires a whole number of days the creator chose
 *     after the approval (7 unless they choose otherwise), at that instant.
 *
 * The token in the link is 24 random bytes in hex, the same shape as the
 * waitlist's (lib/waitlist-tokens.ts). It carries no personal data and no
 * meaning: it is not derived from the address, the offer or the store. The
 * record keeps only a digest of it and a digest of the address, never either
 * one in plain text, so a copy of the record opens nothing and names nobody.
 *
 * Unknown is never a yes (CX-123 rule 24): a record that does not parse
 * exactly, a state this file does not know, a clock that is not a whole
 * number of milliseconds or runs before the decision, all answer "unknown"
 * and never allow the purchase. Nothing here opens a checkout, takes money
 * or changes a price: the checkout comes in a later unit, and it will call
 * `purchaseWith` and keep its result with a mark taken once
 * (lib/claim-mark.ts) before any session is made.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { EMAIL_PATTERN, MAX_EMAIL_LENGTH, normaliseEmail } from "@/lib/auth";

const DAY_MS = 86_400_000;
/** The link's life when the creator chooses nothing. */
export const APPLY_LINK_DAYS_DEFAULT = 7;
/** The shortest and longest life the creator may choose, in whole days. */
export const APPLY_LINK_DAYS_MIN = 1;
export const APPLY_LINK_DAYS_MAX = 30;
/** A link token: 24 random bytes, lower-case hex. */
export const APPLY_TOKEN = /^[0-9a-f]{48}$/;
/** An application's own id (16 random bytes, hex), made by whoever stores it. */
export const APPLICATION_ID = /^[0-9a-f]{32}$/;
/** An offer (a product id in the store), never anything personal. */
const OFFER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const DIGEST = /^[0-9a-f]{64}$/;
/** A record longer than this was not written by this file. */
const MAX_RECORD_BYTES = 2_048;

export type ApplicationState = "submitted" | "approved" | "declined" | "used";

export type Application = {
  version: 1;
  id: string;
  offer: string;
  /** Digest of the address that applied (applicantDigest), never the address. */
  applicant: string;
  state: ApplicationState;
  /** When it was sent, in milliseconds. */
  at: number;
  /** When the creator approved or declined it; 0 until then. */
  decidedAt: number;
  /** When the link stops opening; 0 unless approved or used. */
  expiresAt: number;
  /** Digest of the link's token (applyTokenDigest); "" unless approved or used. */
  tokenDigest: string;
  /** When a purchase started on the link; 0 until then. */
  usedAt: number;
};

export type Step =
  | { kind: "approve"; now: number; days: number; token: string }
  | { kind: "decline"; now: number };

export type StepAnswer =
  | { ok: true; next: Application }
  | { ok: false; why: "unknown" | "final" | "bad-input" | "still-open" | "same-token" };

export type PurchaseRefusal =
  | "unknown" | "not-approved" | "declined" | "used" | "expired"
  | "wrong-token" | "wrong-email" | "wrong-offer";

export type PurchaseAnswer = { ok: true } | { ok: false; why: PurchaseRefusal };

/** A fresh link token. Random only: nothing about the person or the offer goes in. */
export function newApplyToken(): string {
  return randomBytes(24).toString("hex");
}

/** What the record keeps of a token: its digest, under this file's own label. */
export function applyTokenDigest(token: string): string {
  return createHash("sha256").update(`nimbus-apply-first-token:${token}`).digest("hex");
}

/** What the record keeps of an address, or null for one that is not an address. */
export function applicantDigest(email: string): string | null {
  if (typeof email !== "string") return null;
  const clean = normaliseEmail(email);
  if (!clean || clean.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(clean)) return null;
  return createHash("sha256").update(`nimbus-apply-first-applicant:${clean}`).digest("hex");
}

const clock = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

function sameDigest(a: string, b: string): boolean {
  if (!DIGEST.test(a) || !DIGEST.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

/** Whether a record holds together for its state; anything else is unknown. */
function coherent(a: Application): boolean {
  if (a.version !== 1 || !APPLICATION_ID.test(a.id) || !OFFER_ID.test(a.offer) || !DIGEST.test(a.applicant)) return false;
  if (![a.at, a.decidedAt, a.expiresAt, a.usedAt].every(clock) || a.at <= 0) return false;
  const life = a.expiresAt - a.decidedAt;
  const link = DIGEST.test(a.tokenDigest) && a.decidedAt >= a.at &&
    life >= APPLY_LINK_DAYS_MIN * DAY_MS && life <= APPLY_LINK_DAYS_MAX * DAY_MS && life % DAY_MS === 0;
  switch (a.state) {
    case "submitted":
      return a.decidedAt === 0 && a.expiresAt === 0 && a.tokenDigest === "" && a.usedAt === 0;
    case "declined":
      return a.decidedAt >= a.at && a.decidedAt > 0 && a.expiresAt === 0 && a.tokenDigest === "" && a.usedAt === 0;
    case "approved":
      return link && a.usedAt === 0;
    case "used":
      return link && a.usedAt >= a.decidedAt && a.usedAt < a.expiresAt && a.usedAt > 0;
    default:
      return false;
  }
}

const FIELDS = ["version", "id", "offer", "applicant", "state", "at", "decidedAt", "expiresAt", "tokenDigest", "usedAt"] as const;

/** A copy of only the known fields, or null when the value is not exactly an application. */
function exact(value: unknown): Application | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const copy = {
    version: row.version, id: row.id, offer: row.offer, applicant: row.applicant, state: row.state,
    at: row.at, decidedAt: row.decidedAt, expiresAt: row.expiresAt, tokenDigest: row.tokenDigest, usedAt: row.usedAt,
  } as Application;
  if (typeof copy.id !== "string" || typeof copy.offer !== "string" || typeof copy.applicant !== "string" ||
      typeof copy.state !== "string" || typeof copy.tokenDigest !== "string") return null;
  return coherent(copy) ? copy : null;
}

/**
 * Reads a stored record. Anything that is not exactly one, or names a field twice, is null: unknown.
 *
 * Every field this file writes is drawn from characters JSON never escapes (hex, the offer's letters, digits,
 * the state's words), so a record written here holds no backslash. One that does was not written here, and an
 * escape is how one name can be spelled two ways ("state" and "state") that JSON.parse folds into one
 * field, keeping the last (Codex C2 on #3526): refused before the count below, so each name is counted as it
 * decodes, never only as it is spelled.
 */
export function parseApplication(raw: unknown): Application | null {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > MAX_RECORD_BYTES || raw.includes("\\")) return null;
  for (const field of FIELDS) {
    if ((raw.match(new RegExp(`"${field}"\\s*:`, "g")) ?? []).length > 1) return null;
  }
  try {
    return exact(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** A new application from the form, or null when any part of it is not right. */
export function newApplication(input: { id: string; offer: string; email: string; now: number }): Application | null {
  const applicant = applicantDigest(input.email);
  if (!applicant) return null;
  return exact({
    version: 1, id: input.id, offer: input.offer, applicant, state: "submitted",
    at: input.now, decidedAt: 0, expiresAt: 0, tokenDigest: "", usedAt: 0,
  });
}

/**
 * The creator's decision. Approve: submitted → approved, or an approved link
 * that has expired → approved again with a new token. Decline: submitted or
 * approved → declined, which drops the link. Declined and used are final.
 */
export function nextApplication(current: Application | null, step: Step): StepAnswer {
  const app = exact(current);
  if (!app) return { ok: false, why: "unknown" };
  if (app.state === "declined" || app.state === "used") return { ok: false, why: "final" };
  if (!clock(step.now) || step.now < app.at || step.now < app.decidedAt) return { ok: false, why: "bad-input" };
  if (step.kind === "decline") {
    const next = exact({ ...app, state: "declined", decidedAt: Math.max(step.now, 1), expiresAt: 0, tokenDigest: "" });
    return next ? { ok: true, next } : { ok: false, why: "unknown" };
  }
  if (step.kind !== "approve") return { ok: false, why: "bad-input" };
  if (!Number.isSafeInteger(step.days) || step.days < APPLY_LINK_DAYS_MIN || step.days > APPLY_LINK_DAYS_MAX ||
      typeof step.token !== "string" || !APPLY_TOKEN.test(step.token)) return { ok: false, why: "bad-input" };
  const tokenDigest = applyTokenDigest(step.token);
  if (app.state === "approved") {
    if (step.now < app.expiresAt) return { ok: false, why: "still-open" };
    if (sameDigest(app.tokenDigest, tokenDigest)) return { ok: false, why: "same-token" };
  }
  const next = exact({ ...app, state: "approved", decidedAt: step.now, expiresAt: step.now + step.days * DAY_MS, tokenDigest });
  return next ? { ok: true, next } : { ok: false, why: "unknown" };
}

/**
 * Whether the link may start a purchase now. Only an approved record, with
 * its own token, its own address, its own offer and before it expires.
 */
export function canPurchase(
  current: Application | null,
  attempt: { token: string; email: string; offer: string; now: number },
): PurchaseAnswer {
  const app = exact(current);
  if (!app) return { ok: false, why: "unknown" };
  if (!clock(attempt.now) || attempt.now < app.at || attempt.now < app.decidedAt) return { ok: false, why: "unknown" };
  if (app.state === "submitted") return { ok: false, why: "not-approved" };
  if (app.state === "declined") return { ok: false, why: "declined" };
  if (app.state === "used") return { ok: false, why: "used" };
  if (app.state !== "approved") return { ok: false, why: "unknown" };
  if (typeof attempt.token !== "string" || !APPLY_TOKEN.test(attempt.token) ||
      !sameDigest(app.tokenDigest, applyTokenDigest(attempt.token))) return { ok: false, why: "wrong-token" };
  if (attempt.now >= app.expiresAt) return { ok: false, why: "expired" };
  const applicant = applicantDigest(attempt.email);
  if (!applicant || !sameDigest(app.applicant, applicant)) return { ok: false, why: "wrong-email" };
  if (attempt.offer !== app.offer) return { ok: false, why: "wrong-offer" };
  return { ok: true };
}

/** approved → used, when canPurchase says yes; the only way a link is spent. */
export function purchaseWith(
  current: Application | null,
  attempt: { token: string; email: string; offer: string; now: number },
): { ok: true; next: Application } | { ok: false; why: PurchaseRefusal } {
  const may = canPurchase(current, attempt);
  if (!may.ok) return may;
  const next = exact({ ...(current as Application), state: "used", usedAt: attempt.now });
  return next ? { ok: true, next } : { ok: false, why: "unknown" };
}
