/**
 * The EU withdrawal function's rules (queue item 588 [KB9], unit 1a, added
 * 6 November 2026).
 *
 * Directive 2011/83/EU art. 11a, inserted by Directive (EU) 2023/2673 (OJ L
 * 2023/2673, 28.11.2023, applied from 19 June 2026; read from the official
 * text on 6 November 2026, docs/kb9-eu-withdrawal-2026-11-06.md): for a
 * distance contract concluded through an online interface, the trader lets
 * the consumer withdraw through a function labelled "withdraw from contract
 * here", continuously available throughout the withdrawal period; it takes a
 * statement with the consumer's name, the contract and the email for the
 * confirmation, submitted with a function labelled "confirm withdrawal"; the
 * trader then sends, on a durable medium and without undue delay, an
 * acknowledgement with the statement's content and the date and time it was
 * submitted. A statement submitted before the period expired is in time.
 *
 * The creator is the trader for what a store sells (app/terms, section 3);
 * the interface is ours, so the store offers the function on the creator's
 * behalf. By the owner's decision (C4-20261106-2640-DONO-156) a membership's
 * withdrawal only tells the creator, who cancels and refunds from their own
 * Stripe account: nothing here writes to it.
 *
 * When the period runs (Directive 2011/83/EU arts. 9, 16(a), 16(m), as read
 * for item 91 in lib/digital-consent.ts): 14 days from the contract; digital
 * content whose buyer gave the art. 16(m) yes loses the right once supply
 * begins: at once, or when a pre-order is actually handed over (its planned
 * release day proves nothing, so until then it keeps the 14 days); a
 * membership is at least partly a service, so it keeps the 14 days; a shipped
 * item's 14 days run from its receipt (art. 9(2)(b)), which is not known here,
 * so it stays offered with no end. When a time cannot be read the function
 * stays offered: it is never hidden on a guess. Nothing here decides a refund
 * or its amount.
 */
import { EMAIL_PATTERN, MAX_EMAIL_LENGTH, normaliseEmail } from "@/lib/auth";
import type { KeptConsent } from "@/lib/digital-consent";
import { WITHDRAWAL_WORDS, type WithdrawalWords } from "@/lib/buyer-words/withdrawal";

/** The function's label, in the words the law names (art. 11a(1)); other languages use an unambiguous equivalent. */
export const WITHDRAW_FROM_CONTRACT = "Withdraw from contract here";
/** The confirmation's label, in the words the law names (art. 11a(3)). */
export const CONFIRM_WITHDRAWAL = "Confirm withdrawal";
/** The withdrawal period, in days from the contract (art. 9(1)). */
export const WITHDRAWAL_DAYS = 14;

const DAY = 86_400;
/** A Stripe checkout or payment reference, or a PayPal order's, as the store keeps it. */
const REFERENCE = /^[A-Za-z0-9_-]{6,128}$/;
const MAX_NAME = 200;

/** What deciding the period reads from one purchase (lib/buyer-orders.ts, Purchase). */
export type WithdrawalFacts = {
  /** "sale" and "upsell" are contracts made here; "imported" was brought over from another platform. */
  kind: "sale" | "upsell" | "imported";
  /** When it was paid, in seconds; 0 or anything else unreadable is unknown. */
  paidAt: number;
  /** A membership. */
  member: boolean;
  /** Given by the creator's own tools: no payment, no contract with the buyer here. */
  givenByStore: boolean;
  /** The yes kept on the order (lib/digital-consent.ts, readConsentMeta), or null. */
  consent: KeptConsent | null;
  /** A pre-order: its planned release day ("YYYY-MM-DD") when set, and whether it was actually handed over. */
  preorder?: { day: string | null; given: boolean };
  /** Shipped by the creator. */
  shipped?: boolean;
};

/**
 * Whether the function is offered now, and until when (seconds; null when the
 * end cannot be read, such as a shipped item's receipt, and then it stays
 * offered).
 */
export type WithdrawalWindow = { open: true; until: number | null } | { open: false; why: "not-here" | "supplied" | "ended" };

/** When the withdrawal function is offered for one purchase (see the file's comment). */
export function withdrawalWindow(facts: WithdrawalFacts, nowSeconds: number): WithdrawalWindow {
  if (facts.kind === "imported" || facts.givenByStore) return { open: false, why: "not-here" };
  const paid = Number.isSafeInteger(facts.paidAt) && facts.paidAt > 0 ? facts.paidAt : null;
  const membership = facts.member || facts.consent?.kind === "membership";
  // A shipped item's 14 days run from its receipt, not known here: no end is invented.
  if (facts.shipped) return { open: true, until: null };
  const until: number | null = paid === null ? null : paid + WITHDRAWAL_DAYS * DAY;
  // The yes ends the right once supply actually begins: at once, or when a pre-order is handed over, never on its planned day.
  if (!membership && facts.consent?.kind === "digital" && (!facts.preorder || facts.preorder.given)) return { open: false, why: "supplied" };
  if (until !== null && nowSeconds > until) return { open: false, why: "ended" };
  return { open: true, until };
}

/** Whether a statement submitted at this time is in time (art. 11a(5)). */
export function submittedInTime(window: WithdrawalWindow, atSeconds: number): boolean {
  return window.open && (window.until === null || atSeconds <= window.until);
}

/** The online withdrawal statement (art. 11a(2)): the buyer's name, the order and the email for the confirmation. */
export type WithdrawalStatement = { name: string; reference: string; email: string };

/** A statement as a form gave it, checked; null when any part does not read. Nothing else is kept. */
export function readStatement(raw: { name?: unknown; reference?: unknown; email?: unknown } & Record<string, unknown>): WithdrawalStatement | null {
  if (typeof raw.name !== "string" || typeof raw.reference !== "string" || typeof raw.email !== "string") return null;
  const name = raw.name.replace(/\s+/g, " ").trim();
  const reference = raw.reference.trim();
  const email = raw.email.trim();
  if (!name || name.length > MAX_NAME || !REFERENCE.test(reference)) return null;
  if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) return null;
  return { name, reference, email: normaliseEmail(email) };
}

/** A time as the acknowledgement says it: "November 6, 2026 at 18:05:09 UTC". */
function utcMoment(ms: number): string {
  const d = new Date(ms);
  const day = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }).format(d);
  const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZone: "UTC" }).format(d);
  return `${day} at ${time} UTC`;
}

/**
 * The acknowledgement of receipt (art. 11a(4)): the statement's content and
 * the date and time it was submitted, to be sent by email (a durable medium),
 * in the store's words (lib/buyer-words/withdrawal.ts; English by default).
 * It promises nothing about a refund: that is the creator's. `when` is the
 * moment as written, for the creator's notice.
 */
export function acknowledgement(
  statement: WithdrawalStatement,
  product: string,
  store: string,
  submittedMs: number,
  w: WithdrawalWords = WITHDRAWAL_WORDS.en,
): { subject: string; text: string; when: string } {
  const when = utcMoment(submittedMs);
  return {
    when,
    subject: w.ackSubject(product),
    text: [
      w.ackReceived(when, store),
      "",
      w.ackWhatYouSent,
      `${w.ackName}: ${statement.name}`,
      `${w.ackOrder}: ${statement.reference}`,
      `${w.ackProduct}: ${product}`,
      `${w.ackEmail}: ${statement.email}`,
      `${w.ackSentOn}: ${when}`,
      "",
      w.ackNext(store),
    ].join("\n"),
  };
}
