/**
 * A paid call keeps the currency it was paid in (22 [E5], unit 2b; added 2
 * November 2026; docs/e5-money-readers.md). A store can change its currency,
 * so a call booked before that was paid in the old one. Checked in the code:
 * the paid call read from Stripe keeps the checkout session's currency; the
 * creator's phone alert and the bookings API say the amount in it, falling
 * back to the store's only when Stripe said none; and the three places a
 * booking is confirmed pass it on, with no fourth caller. Read from the source, because these run against
 * Stripe's checkout sessions, which this test does not stand in for; the tier
 * switch and the numbers have behavior tests of their own (tests/tiers.test.ts,
 * tests/numbers-five.test.ts).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { done, is, part } from "./check";

const flat = (file: string) => readFileSync(file, "utf8").replace(/\s+/g, " ");
const calls = flat("lib/calls.ts");

part("A paid call's currency");
is("read from the checkout session, lowercased, empty when it says none", calls.includes('currency: typeof row.currency === "string" && row.currency ? row.currency.toLowerCase() : "",'), true);
is("the phone alert says the amount in it", calls.includes("formatMoney(input.amountCents, input.currency || store.currency)"), true);
is("the bookings API says it", flat("lib/api-read.ts").includes("currency: c.currency || store.currency,"), true);
const confirmations = ["app/[handle]/thanks/page.tsx", "lib/calls.ts", "lib/call-reminders.ts"];
is("every place a booking is confirmed (the thanks page, a move, the reminders) passes it on", [
  confirmations.every((f) => flat(f).includes("confirmBooking(")),
  flat("app/[handle]/thanks/page.tsx").includes("amountCents: order.amount, currency: order.currency,"),
  calls.includes("amountCents: call.amount, currency: call.currency,"),
  flat("lib/call-reminders.ts").includes("amountCents: call.amount, currency: call.currency,"),
], [true, true, true, true]);
// Any other caller of confirmBooking must be added above, so none forgets the currency.
const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => { const p = join(dir, name); return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(name) ? [p] : []; });
is("no other caller", ["app", "components", "lib"].flatMap(walk).filter((f) => /confirmBooking\(\{/.test(readFileSync(f, "utf8")) && !confirmations.includes(f)), []);
is("nothing labels a paid call with the store's currency alone any more", /formatMoney\(input\.amountCents, store\.currency\)/.test(calls), false);

done();
