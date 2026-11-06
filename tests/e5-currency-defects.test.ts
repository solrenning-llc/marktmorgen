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

part("A payment request's own currency (unit 2c)");
const requests = flat("components/payment-requests-studio.tsx");
const list = requests.slice(requests.indexOf("rows.map((r) =>"));
is("the studio list says each request, what was paid and what was refunded in the request's own currency", [list.includes("const its = (cents: number) => formatMoney(cents, r.currency);"), list.includes("{its(r.total)}"), list.includes("`paid ${its(r.amountPaid || r.total)}"), list.includes("`${its(r.refunded)} refunded`"), /money\(r\./.test(list)], [true, true, true, true, false]);

part("An agreement's older version in another currency (unit 2c)");
const studio = flat("components/agreements-studio.tsx");
is("the read says its version's currency; the editor reads the amounts in it, then leaves them empty and says why", [flat("app/api/store/agreements/route.ts").includes("sha256: version.sha256, currency: version.currency }"), studio.includes("const then: Currency = isCurrency(its) ? its : currency;"), studio.includes('lines: read.lines.map((line) => ({ ...line, amount: "" }))'), studio.includes("Type its amounts again in ${currency.toUpperCase()}, your store's currency now.")], [true, true, true, true]);

part("Email revenue and subject tests (unit 2d)");
const studioMail = flat("components/email-studio.tsx");
is("each email and sequence says its sales in another currency, and that their amounts are not in the total", [studioMail.includes("not shown, since amounts here count only your store's currency"), studioMail.includes("not in this total"), studioMail.includes('if (!money.sales && !others) return "No sale from its links yet";')], [true, true, true]);
is("a subject test by sales counts a sale in any currency", flat("lib/broadcasts.ts").includes("a: (by[a]?.sales ?? 0) + (by[a]?.elsewhere ?? 0)"), true);
is("the MCP emails tool says them apart", (flat("lib/mcp-tools.ts").match(/sales_in_another_currency:/g) ?? []).length, 2);

done();
