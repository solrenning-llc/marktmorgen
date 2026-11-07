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
 * content whose buyer gave the art. 16(m) yes, and whose confirmation on a
 * durable medium is known to have gone (art. 16(m)(iii), art. 8(7)(b): the
 * order's confirmation email, read as `confirmed`), loses the right once
 * supply begins: at once, or when a pre-order is actually handed over (its
 * planned release day proves nothing, so until then it keeps the 14 days);
 * the yes without that confirmation known sent keeps the 14 days; a
 * membership is at least partly a service, so it keeps the 14 days; a shipped
 * item's 14 days run from its receipt (art. 9(2)(b)), which is not known here,
 * so it stays offered with no end. When a time cannot be read the function
 * stays offered: it is never hidden on a guess. Nothing here decides a refund
 * or its amount.
 *
 * How the 14 days are counted (withdrawalEnd; Claude 5's review of #2827),
 * on the protective reading of Regulation (EEC, Euratom) No 1182/71, which
 * recital 41 of Directive 2011/83/EU applies to its periods, art. 3(1), 3(2)(b)
 * and 3(4) as the reviewer recalls them: NOT verified against the official
 * text, because EUR-Lex could not be reached from here
 * (docs/kb9-eu-withdrawal-2026-11-06.md). The day of payment is not counted,
 * and it is taken as the latest calendar day anywhere on Earth at that moment
 * (the date at UTC+14), so a buyer east of UTC who paid late in the UTC day
 * does not lose one of their days (Claude 5's focal return on #2827); the
 * period ends at the end of the 14th calendar day after it; a last day on a
 * Saturday or a Sunday moves to the following Monday; and "the end of the
 * day" is the end of that calendar day anywhere on Earth (23:59:59 at UTC-12,
 * 11:59:59 UTC the next calendar day). So neither the buyer's first day nor
 * their last is cut short, wherever they are. Public holidays differ by
 * country and are not known here, so they are not applied.
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
  /**
   * The order's confirmation email (art. 8(7), the durable medium of art. 16(m)(iii)) is known to have gone: true only
   * when its mark read exactly "sent" (lib/withdrawal.ts, withConfirmations). Absent or false keeps the 14 days.
   */
  confirmed?: boolean;
};

/**
 * Whether the function is offered now, and until when (seconds; null when the
 * end cannot be read, such as a shipped item's receipt, and then it stays
 * offered).
 */
export type WithdrawalWindow = { open: true; until: number | null } | { open: false; why: "not-here" | "supplied" | "ended" };

/** The end of the day anywhere on Earth: the last place a calendar day ends is UTC-12, 12 hours after UTC's. */
const EARTH_DAY_END = 12 * 3600 - 1;
/** The most advanced time zone on Earth, UTC+14: its date is the latest calendar day anywhere at a given moment. */
const EARTH_DAY_AHEAD = 14 * 3600;

/**
 * The last moment of the withdrawal period for a contract made at `paidAt` (seconds), as the file's comment counts it:
 * the end, anywhere on Earth, of the 14th calendar day after the day of payment (the latest calendar day anywhere at
 * that moment, the date at UTC+14), a Saturday or a Sunday moved to the Monday.
 */
export function withdrawalEnd(paidAt: number): number {
  const paid = new Date((paidAt + EARTH_DAY_AHEAD) * 1000);
  const last = new Date(Date.UTC(paid.getUTCFullYear(), paid.getUTCMonth(), paid.getUTCDate() + WITHDRAWAL_DAYS));
  const weekday = last.getUTCDay();
  const moved = weekday === 6 ? 2 : weekday === 0 ? 1 : 0;
  return Date.UTC(last.getUTCFullYear(), last.getUTCMonth(), last.getUTCDate() + moved + 1) / 1000 + EARTH_DAY_END;
}

/** The last day of the period whose end is `until` (withdrawalEnd), as the midnight UTC that starts it, in seconds: the day a page promises. */
export function lastWithdrawalDay(until: number): number {
  return until - EARTH_DAY_END - DAY;
}

/** Whether the art. 16(m) yes would end the right once supplied: digital content sold once, handed over (a pre-order only once it is). */
export function yesEndsOnSupply(facts: WithdrawalFacts): boolean {
  if (facts.kind === "imported" || facts.givenByStore || facts.shipped) return false;
  const membership = facts.member || facts.consent?.kind === "membership";
  return !membership && facts.consent?.kind === "digital" && (!facts.preorder || facts.preorder.given);
}

/** When the withdrawal function is offered for one purchase (see the file's comment). */
export function withdrawalWindow(facts: WithdrawalFacts, nowSeconds: number): WithdrawalWindow {
  if (facts.kind === "imported" || facts.givenByStore) return { open: false, why: "not-here" };
  const paid = Number.isSafeInteger(facts.paidAt) && facts.paidAt > 0 ? facts.paidAt : null;
  // A shipped item's 14 days run from its receipt, not known here: no end is invented.
  if (facts.shipped) return { open: true, until: null };
  const until: number | null = paid === null ? null : withdrawalEnd(paid);
  // The yes ends the right once supply actually begins (at once, or when a pre-order is handed over, never on its planned
  // day), and only with the confirmation on a durable medium known sent (art. 16(m)(iii)): never hidden on a guess.
  if (yesEndsOnSupply(facts) && facts.confirmed === true) return { open: false, why: "supplied" };
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
  /** Whether the statement reached the store: only then does the acknowledgement say it was passed on. */
  told = true,
): { subject: string; text: string; when: string } {
  const when = utcMoment(submittedMs);
  return {
    when,
    subject: w.ackSubject(product),
    text: [
      told ? w.ackReceived(when, store) : w.ackReceivedUntold(when, store),
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
