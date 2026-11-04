/**
 * One explanation, read from the code, for things the public pages describe
 * in more than one place (389 [TB15]).
 *
 * The blog and the comparison pages used to explain the same thing in their
 * own words, and drifted: the blog said PayPal was missing because Stripe
 * does not support it for direct charges, while the comparisons said it was
 * built and waiting on PayPal's approval; the blog said affiliates are not
 * paid automatically, while the comparisons said they are, from the
 * creator's own PayPal on payday; the Stan table said a checkout cannot ask
 * for a phone number, which it can since 11 October 2026. Each sentence here
 * is made from the setting or the list it describes, so the pages say the same
 * thing and change on the day the code does.
 *
 * Pure: it reads the environment and two constant lists, nothing else. The
 * blog module is also imported by a client component (components/blog-browser.tsx),
 * so this must not pull the PayPal client, Redis or email in.
 */
import { FIELD_TYPES, MAX_CHECKOUT_FIELDS, type FieldType } from "@/lib/checkout-fields";

/** The same test as partner() in lib/paypal-sales.ts; tests/public-explanations.test.ts holds the two together. */
const MERCHANT_ID = /^[A-Z0-9]{8,20}$/;

/**
 * Whether a buyer can pay with PayPal on this deployment: PayPal hands a
 * platform its partner credentials only once it approves it.
 */
export function paypalAtCheckout(env: Record<string, string | undefined> = process.env): boolean {
  const client = env.PAYPAL_PARTNER_CLIENT_ID?.trim() ?? "";
  const secret = env.PAYPAL_PARTNER_SECRET?.trim() ?? "";
  const merchant = env.PAYPAL_PARTNER_MERCHANT_ID?.trim() ?? "";
  const bn = env.PAYPAL_BN_CODE?.trim() ?? "";
  return Boolean(client && secret && MERCHANT_ID.test(merchant) && bn);
}

/** Why PayPal is not at checkout yet, said one way everywhere. */
export const PAYPAL_WAITS = "it is built and waits on PayPal approving us as a platform";

/** For a row on what a buyer can pay with, while PayPal is off. */
export const PAYPAL_NOT_YET = `No PayPal yet: ${PAYPAL_WAITS}`;

/** How a creator pays affiliates here (lib/paypal-payouts.ts: one press, or by itself on payday). */
export const AFFILIATES_PAID = "paid from your own PayPal, in one press or automatically on your payday";

/**
 * Our own PayPal connection (lib/paypal-sales.ts), apart from Stripe: on, what
 * it sells; off, why not yet. Stripe's PayPal is a different thing, not
 * offered for the direct charges every sale here is made with.
 */
export function paypalConnectionWords(on: boolean = paypalAtCheckout()): string {
  return on
    ? "A separate PayPal connection is on: the buyer pays straight into your own PayPal account, for one-time products at one price."
    : `A separate PayPal connection, where the buyer pays straight into your own PayPal account, is not on yet: ${PAYPAL_WAITS}.`;
}

/** What Stan has that we do not, on affiliates: theirs need no PayPal account of the creator's. */
export const STAN_AFFILIATES_AHEAD = "affiliates paid with no PayPal account of your own";

const NUMBER_WORDS = ["none", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

/** Each kind of checkout question, as a buyer-facing noun. A new kind fails the type check until it has words. */
const QUESTION_KIND_WORDS: Record<FieldType, string> = {
  text: "a short answer",
  numeric: "a number",
  dropdown: "a list to choose from",
  phone: "a phone number in Stripe's own box",
};

function orList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}

/** What a checkout can ask, from lib/checkout-fields.ts, e.g. for a comparison row. */
export function checkoutQuestionWords(): string {
  const count = NUMBER_WORDS[MAX_CHECKOUT_FIELDS] ?? String(MAX_CHECKOUT_FIELDS);
  const kinds = orList(FIELD_TYPES.map((type) => QUESTION_KIND_WORDS[type]));
  const noCheckbox = (FIELD_TYPES as readonly string[]).includes("checkbox") ? "" : ". No checkbox question";
  return `Up to ${count}: ${kinds}${noCheckbox}`;
}
