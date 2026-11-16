/**
 * The rules of discount codes (lib/discount.ts keeps them): what a code may
 * look like, the twenty-code cap, what a code takes off and its other rules,
 * and the words for each. Pure, with nothing that reads Stripe or a secret,
 * so the studio's editor (components/discount-editor.tsx) can import them
 * without carrying the server's Stripe reader into the browser.
 */
import { type Currency, formatMoney, rangeWords } from "@/lib/money";

/**
 * What a code may look like.
 *
 * Stripe accepts letters, digits and dashes, and treats the code as
 * case-insensitive. Codes are held upper case here so that what the creator
 * sees in the studio is what a buyer would type on a poster.
 */
export const CODE_PATTERN = /^[A-Z0-9-]{3,24}$/;
export const MAX_CODES = 20;

/**
 * The two ways a code can take money off. An amount is in one currency,
 * Stripe's rule for a coupon: it only comes off a checkout in that currency.
 */
export type Off =
  | { kind: "percent"; percent: number }
  | { kind: "amount"; cents: number; currency: string };

export type CodeProblem =
  /** Nothing was typed. */
  | "empty"
  /** Characters Stripe will not take, or a length it will not take. */
  | "shape"
  /** Not a percentage between 1 and 100. */
  | "percent"
  /** Not an amount of money we can charge. */
  | "amount"
  /** A cap on redemptions that is not a whole positive number. */
  | "uses"
  /** A minimum order that is not an amount the store can charge. */
  | "minimum";

export const CODE_PROBLEMS: Record<CodeProblem, string> = {
  empty: "Type the code a buyer will enter, like LAUNCH20.",
  shape:
    "A code is 3 to 24 characters, and only letters, numbers and dashes.",
  percent: "Type a percentage between 1 and 100.",
  amount: "Type an amount between 1 and 5000, like 10 or 7.50.",
  uses: "Leave the limit empty, or type a whole number of uses above zero.",
  minimum: "Leave the minimum empty, or type an amount between 1 and 5000, like 50.",
};

/** The minimum sentence for a store in another currency than the dollar. */
export function minimumProblem(currency: Currency): string {
  return currency === "usd"
    ? CODE_PROBLEMS.minimum
    : `Leave the minimum empty, or type an amount ${rangeWords(currency)}, in ${currency.toUpperCase()}${currency === "jpy" ? ", with no decimals" : ""}.`;
}

/**
 * How long a code keeps coming off a membership, as Stripe has it on the
 * coupon (its `duration`): the first charge, the first months, or every
 * charge. A code made here is always the first charge; the others are read
 * back from a code the creator made in their own Stripe dashboard, so the
 * studio says what Stripe will really do.
 */
export type CodeDuration = { kind: "once" } | { kind: "repeating"; months: number } | { kind: "forever" };

/** A minimum order, as Stripe checks it before the code comes off: the amount and its currency. */
export type CodeMinimum = { cents: number; currency: string };

/** The amount sentence for a store in another currency than the dollar. */
export function amountProblem(currency: Currency): string {
  return currency === "usd"
    ? CODE_PROBLEMS.amount
    : `Type an amount ${rangeWords(currency)}, in ${currency.toUpperCase()}${currency === "jpy" ? ", with no decimals" : ""}.`;
}

/** The code as it will be stored and shown: trimmed and upper case. */
export function readCode(raw: string): string {
  return (raw ?? "").trim().toUpperCase();
}

export function codeProblem(code: string): CodeProblem | null {
  if (!code) return "empty";
  if (!CODE_PATTERN.test(code)) return "shape";
  return null;
}

/** "20% off" / "$10 off" / "€10 off" — how a code reads to a person. */
export function offLabel(off: Off): string {
  if (off.kind === "percent") return `${off.percent}% off`;
  return `${formatMoney(off.cents, off.currency)} off`;
}

/** One code as the studio shows it, read back from Stripe every time. */
export type DiscountCode = {
  /** Stripe's own id for the promotion code, used to switch it off. */
  id: string;
  code: string;
  off: Off | null;
  /** How many times Stripe says it has been used. */
  timesRedeemed: number;
  /** The cap the creator set, if any. */
  maxRedemptions: number | null;
  /** Seconds since the epoch, as Stripe counts them. */
  expiresAt: number | null;
  /** Whether Stripe will still take it. Stripe decides, not us. */
  active: boolean;
  /** The smallest order it comes off, as Stripe checks it (`restrictions.minimum_amount`), or null for any. */
  minimum: CodeMinimum | null;
  /** Only for a buyer Stripe counts as new (`restrictions.first_time_transaction`): read back, never set here. */
  firstOrder: boolean;
  /** How long it comes off a membership, when the coupon could be read. */
  duration: CodeDuration | null;
  /** Stripe has a restriction on it that this page cannot read (a minimum per currency, or one in a shape not known here). */
  otherRules: boolean;
};

/**
 * What else decides when a code comes off, in plain words, from what Stripe
 * has: its minimum, a first order only, and how long on a membership. Empty
 * when it is the plain code made here.
 */
export function codeRules(entry: Pick<DiscountCode, "minimum" | "firstOrder" | "duration" | "otherRules">): string[] {
  const out: string[] = [];
  if (entry.minimum) out.push(`When the first payment is ${formatMoney(entry.minimum.cents, entry.minimum.currency)} or more.`);
  // Stripe treats a checkout with no customer of its own as a first one, and this store's checkouts never name one.
  if (entry.firstOrder) out.push("First order only, as Stripe counts it. Checkouts in this store are always new to Stripe, so this rule does not stop a buyer who has bought before.");
  if (entry.duration?.kind === "repeating") out.push(`On a membership: the first ${entry.duration.months} ${entry.duration.months === 1 ? "month" : "months"} of charges.`);
  if (entry.duration?.kind === "forever") out.push("On a membership: every charge, for as long as it lasts.");
  if (entry.otherRules) out.push("It has other rules, set in your Stripe dashboard, that this page cannot show.");
  return out;
}
