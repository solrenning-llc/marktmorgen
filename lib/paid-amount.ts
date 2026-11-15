/**
 * What a paid Stripe checkout session charged, read exactly (#4802 and its siblings, 15 November 2026):
 * `amount_total` a safe whole number of minor units, zero or more, and `currency` an explicit three-letter code as
 * Stripe writes it (lowercase). Anything else is unknown (null): never $0, which would read as a free sale, and never
 * the store's own currency in its place. A really free checkout reads only from Stripe's explicit 0 and its currency.
 */
export type PaidMoney = { cents: number; currency: string };

export function paidMoneyOf(session: { amount_total?: unknown; currency?: unknown } | null | undefined): PaidMoney | null {
  if (!session || typeof session !== "object") return null;
  const cents = session.amount_total;
  const currency = session.currency;
  if (typeof cents !== "number" || !Number.isSafeInteger(cents) || cents < 0) return null;
  if (typeof currency !== "string" || !/^[a-z]{3}$/.test(currency)) return null;
  return { cents, currency };
}
