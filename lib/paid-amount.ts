/**
 * What a paid Stripe checkout session charged, read exactly (#4802 and its siblings, 15 November 2026):
 * `amount_total` a safe whole number of minor units, zero or more, and `currency` an explicit three-letter code as
 * Stripe writes it (lowercase). Anything else is unknown (null): never $0, which would read as a free sale, and never
 * the store's own currency in its place. A really free checkout reads only from Stripe's explicit 0 and its currency.
 */
export type PaidMoney = { cents: number; currency: string };

/** An amount in minor units read exactly: a safe whole number, zero or more; null otherwise (never 0 in its place). */
export function minorUnits(raw: unknown): number | null {
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 ? raw : null;
}

/**
 * A PaymentIntent's money (`amount`, `currency`), read as paidMoneyOf reads a checkout's: null when either does not
 * read, never $0 or the store's currency.
 */
export function intentMoneyOf(intent: { amount?: unknown; currency?: unknown } | null | undefined): PaidMoney | null {
  return intent && typeof intent === "object" ? paidMoneyOf({ amount_total: intent.amount, currency: intent.currency }) : null;
}

export function paidMoneyOf(session: { amount_total?: unknown; currency?: unknown } | null | undefined): PaidMoney | null {
  if (!session || typeof session !== "object") return null;
  const cents = session.amount_total;
  const currency = session.currency;
  if (typeof cents !== "number" || !Number.isSafeInteger(cents) || cents < 0) return null;
  if (typeof currency !== "string" || !/^[a-z]{3}$/.test(currency)) return null;
  return { cents, currency };
}
