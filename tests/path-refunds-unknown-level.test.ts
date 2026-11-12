/**
 * Refunds that cannot be read move no level (Claude 1's MEDIUM on #3443).
 *
 * When a store's refunds are unknown (a PayPal refund range or a Stripe refund
 * list read off its shape or not in full), the money is null. A sale that may
 * have been refunded in full must not count as a real sale kept either: the
 * first level ("sunrise") is reached on the count alone, and a level reached
 * is never lowered, so one Redis hiccup on the visit after a refund would mark
 * "Your first real sale" for good on a sale the buyer got back. Pure: the
 * reading the Path builds, and the level it reaches from it.
 */
import { moneyFrom } from "@/lib/path-facts";
import { levelNow, NO_FACTS } from "@/lib/path-rules";
import { done, is } from "./check";

const sale = (intent: string, cents = 4900) => ({ cents, currency: "usd", intent, live: true as const });
const facts = (money: ReturnType<typeof moneyFrom>) => ({ ...NO_FACTS, currency: "usd", realSales: money.real, revenueCents: money.cents });

// Control: refunds read in full, the only sale refunded in full.
const known = moneyFrom([sale("PAY-1")], [{ cents: 4900, currency: "usd", paymentIntent: "PAY-1" }], "usd", 1);
is("refunds known: the refunded sale is not kept", [known.real, known.cents], [0, 0]);
is("refunds known: no level from it", levelNow(facts(known)), -1);

// Refunds unknown: the same sale may have been refunded, so it is not counted as kept.
const unknown = moneyFrom([sale("PAY-1")], null, "usd", 1);
is("refunds unknown: the money is unknown", unknown.cents, null);
is("refunds unknown: no sale counted as kept", unknown.real, 0);
is("refunds unknown: the first level is not reached", levelNow(facts(unknown)), -1);

// A sale with no payment named (a membership's first payment) is no different.
const unnamed = moneyFrom([sale("")], null, "usd", 1);
is("refunds unknown, sale naming no payment: not counted as kept", unnamed.real, 0);

// A test purchase is still seen as one: unknown refunds do not hide it.
const test = moneyFrom([{ cents: 100, currency: "usd", intent: "pi_t", live: false }], null, "usd", 1);
is("refunds unknown: a test purchase is still a test purchase", test.test, true);

done();
