/**
 * Revenue figures read in their exact shape (CX-123 rule 24, 6 November 2026).
 *
 * What a store kept (lib/retained-revenue.ts) and recurring revenue month by
 * month (lib/mrr-movements.ts) are shown to the creator as facts. A reading
 * Stripe gave in a shape these rules cannot read must never become a figure:
 *
 *   - a refund, renewal or dispute whose amount, currency or day could not be
 *     read makes its reading incomplete, so the kept figure is not shown and
 *     the page names the reading, instead of the money silently left out;
 *   - an invoice line whose amount, price, quantity or time could not be read
 *     stops the movements (the memberships page then leaves them out, as it
 *     does when the invoices cannot be read at all), instead of a member worth
 *     nothing for a month: a cancellation and a comeback that never happened.
 *
 * Healthy readings and confirmed-empty ones read exactly as before.
 * Synthetic data and a stand-in for Stripe only.
 */
import { keptIn, type Entry, type Readings } from "@/lib/retained-revenue";
import { movementsFrom, pricesFrom, UnreadInvoiceError, type Invoice } from "@/lib/mrr-movements";
import type { Sub } from "@/lib/membership-numbers";
import { readSales } from "@/lib/stats";
import { claimHandle, ensureStatsId, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

part("Kept: an entry that could not be read is a reading not made, never money left out");
const day = "2026-10-13";
const from = "2026-10-07";
const base = (): Readings => ({
  sales: { complete: true, entries: [{ day, cents: 5000, currency: "usd", source: "instagram" }, { day, cents: 0, currency: "usd", source: "" }] },
  renewals: { complete: true, entries: [{ day, cents: 1500, currency: "usd", source: "" }] },
  refunds: { complete: true, entries: [{ day, cents: 1000, currency: "usd", source: "instagram" }] },
  disputes: { complete: true, entries: [{ day, cents: 500, currency: "usd", source: "" }] },
});
const healthy = keptIn(base(), from, "usd");
is("healthy: reconciled, a free checkout keeps nothing and blocks nothing", [healthy.lines[0].keptCents, healthy.lines[0].missing, healthy.lines[0].sales], [5000, [], 1]);
is("healthy: kept by channel", healthy.byChannel, [{ source: "instagram", keptCents: 4000 }, { source: "direct", keptCents: 1000 }]);
const odd: [string, Partial<Entry>][] = [
  ["zero", { cents: 0 }],
  ["negative", { cents: -1000 }],
  ["fractional", { cents: 10.5 }],
  ["not a number", { cents: Number.NaN }],
  ["a string", { cents: "1000" as unknown as number }],
  ["no currency", { currency: "" }],
  ["a currency that is not text", { currency: 840 as unknown as string }],
  ["a day that is not a day", { day: "13/10/2026" }],
  ["no day", { day: undefined as unknown as string }],
];
for (const reading of ["refunds", "renewals", "disputes"] as const) {
  for (const [label, over] of odd) {
    const r = base();
    r[reading] = { complete: true, entries: [{ ...r[reading]!.entries[0], ...over }] };
    const w = keptIn(r, from, "usd");
    is(`${reading}, amount ${label}: no kept figure, the reading named`, [w.lines.every((l) => l.keptCents === null), w.lines[0].missing, w.byChannel], [true, [reading], null]);
  }
}
for (const [label, over] of odd.filter(([label]) => label !== "zero")) {
  const r = base();
  r.sales = { complete: true, entries: [r.sales.entries[0], { ...r.sales.entries[0], ...over }] };
  const w = keptIn(r, from, "usd");
  is(`sales, amount ${label}: no kept figure, the reading named`, [w.lines.every((l) => l.keptCents === null), w.lines[0].missing], [true, ["sales"]]);
}
{
  const r = base();
  r.refunds = { complete: true, entries: [...r.refunds!.entries, { day: "2026-06-01", cents: 0, currency: "usd", source: "" }] };
  is("an odd amount on a day before the window does not hide the window's figure", keptIn(r, from, "usd").lines[0].keptCents, 5000);
}
is(
  "confirmed empty readings still show nothing kept",
  keptIn({ sales: { entries: [], complete: true }, renewals: null, refunds: { entries: [], complete: true }, disputes: { entries: [], complete: true } }, from, "usd").lines.map((l) => [l.currency, l.keptCents, l.missing]),
  [["usd", 0, []]],
);

part("Recurring revenue: an invoice line that could not be read stops the movements");
const at = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d, 12) / 1000;
const NOW_S = at(2026, 10, 12);
const sub = (id: string, start: number, amount: number): Sub => ({
  id, customer: `cus_${id}`, status: "active", product: "club", amount, currency: "usd", interval: "month", count: 1,
  start, ended: 0, trialEnd: 0, channel: "direct", canceledAt: 0, cancelCause: "", feedback: "", comment: "",
});
const subs = [sub("sub_ana", at(2026, 6, 5), 2000)];
const byId = new Map(subs.map((s) => [s.id, s]));
const line = (start: number, over: Record<string, unknown> = {}) => ({
  subscription: "sub_ana", amount: 2000, quantity: 1, proration: false, period: { start },
  price: { unit_amount: 2000, recurring: { interval: "month", interval_count: 1 } }, ...over,
});
const invoicesWith = (july: unknown): Invoice[] => [
  { created: at(2026, 6, 5), lines: { data: [line(at(2026, 6, 5))] } },
  july as Invoice,
  { created: at(2026, 8, 5), lines: { data: [line(at(2026, 8, 5))] } },
];
const healthyJuly = { created: at(2026, 7, 5), lines: { data: [line(at(2026, 7, 5))] } };
const good = movementsFrom(subs, pricesFrom(invoicesWith(healthyJuly), byId), "usd", NOW_S);
const july = (m: typeof good) => m.months.find((r) => r.month === "2026-07")!;
const aug = (m: typeof good) => m.months.find((r) => r.month === "2026-08")!;
is("healthy: Ana pays all along, nothing moves after June", [july(good).canceled, aug(good).reactivated, aug(good).end], [0, 0, 2000]);
is(
  "healthy: the newer shape of a line, a credit and an unpriced proration still read",
  pricesFrom([{ created: at(2026, 7, 5), lines: { data: [
    { amount: 2000, quantity: null, period: { start: at(2026, 7, 5) }, pricing: { unit_amount_decimal: "2000" }, parent: { subscription_item_details: { subscription: "sub_ana", proration: false } } },
    { subscription: "sub_ana", amount: -800, period: { start: at(2026, 7, 6) } },
    { subscription: "sub_ana", amount: 300, proration: true, period: { start: at(2026, 7, 7) } },
    { subscription: "sub_other_store", amount: "?" },
  ] } }, { created: at(2026, 7, 9), lines: null }], byId).get("sub_ana")?.map((e) => e.value),
  [2000],
);
const unreadJulys: [string, unknown][] = [
  ["no amount and no price", { created: at(2026, 7, 5), lines: { data: [line(at(2026, 7, 5), { price: undefined, amount: undefined })] } }],
  ["an amount that is not a number, no price", { created: at(2026, 7, 5), lines: { data: [line(at(2026, 7, 5), { price: null, amount: "two thousand" })] } }],
  ["an amount that is an object", { created: at(2026, 7, 5), lines: { data: [line(at(2026, 7, 5), { amount: { value: 2000 } })] } }],
  ["lines that are text", { created: at(2026, 7, 5), lines: { data: "xy" } }],
  ["lines that are not a list", { created: at(2026, 7, 5), lines: { data: { 0: line(at(2026, 7, 5)) } } }],
  ["lines with no list", { created: at(2026, 7, 5), lines: {} }],
  ["a line that is not an object", { created: at(2026, 7, 5), lines: { data: [null] } }],
  ["a price that is not a number", { created: at(2026, 7, 5), lines: { data: [line(at(2026, 7, 5), { amount: 0, price: { unit_amount: "abc" } })] } }],
  ["a decimal price that is not a number", { created: at(2026, 7, 5), lines: { data: [line(at(2026, 7, 5), { price: null, pricing: { unit_amount_decimal: "abc" } })] } }],
  ["a quantity that is not a number", { created: at(2026, 7, 5), lines: { data: [line(at(2026, 7, 5), { quantity: "three" })] } }],
  ["an interval count that is not a number", { created: at(2026, 7, 5), lines: { data: [line(at(2026, 7, 5), { price: { unit_amount: 2000, recurring: { interval: "month", interval_count: {} } } })] } }],
  ["no time at all", { lines: { data: [line(0, { period: null })] } }],
  ["a time that is not a number", { created: "July", lines: { data: [line(0, { period: { start: "soon" } })] } }],
  ["an invoice that is not an object", "in_123"],
];
for (const [label, bad] of unreadJulys) {
  let moves: typeof good | "refused";
  try {
    moves = movementsFrom(subs, pricesFrom(invoicesWith(bad), byId), "usd", NOW_S);
  } catch {
    moves = "refused";
  }
  is(`July's invoice, ${label}: refused, never a month Ana paid nothing`, moves === "refused" ? "refused" : [july(moves).canceled, aug(moves).reactivated, moves.months.map((m) => m.end)], "refused");
}

part("Recurring revenue: a subscription reference that could not be read stops the movements, never a line of nobody's");
// Bea moves from $20 to $30 in July. Stripe gives a line's subscription as its
// id, as the expanded object with that id, or null on a line of no membership.
const bea = [{ ...sub("sub_bea", at(2026, 6, 5), 3000), customer: "cus_bea" }];
const beaById = new Map(bea.map((s) => [s.id, s]));
const beaLine = (start: number, unit: number, over: Record<string, unknown> = {}) => ({ ...line(start), subscription: "sub_bea", amount: unit, price: { unit_amount: unit, recurring: { interval: "month", interval_count: 1 } }, ...over });
const beaInvoices = (julyLine: Record<string, unknown>, invoice: Record<string, unknown> = {}): Invoice[] => [
  { created: at(2026, 6, 5), lines: { data: [beaLine(at(2026, 6, 5), 2000)] } },
  { created: at(2026, 7, 5), ...invoice, lines: { data: [julyLine] } } as Invoice,
  { created: at(2026, 8, 5), lines: { data: [beaLine(at(2026, 8, 5), 3000)] } },
];
const beaMoves = (invoices: Invoice[]) => {
  try {
    const m = movementsFrom(bea, pricesFrom(invoices, beaById), "usd", NOW_S);
    return { julyExpansion: july(m).expansion, julyEnd: july(m).end, augExpansion: aug(m).expansion };
  } catch (error) {
    return error instanceof UnreadInvoiceError ? "refused" : `threw ${String(error)}`;
  }
};
const moved = { julyExpansion: 1000, julyEnd: 3000, augExpansion: 0 };
is("healthy: the line's id, July shows the $10 expansion", beaMoves(beaInvoices(beaLine(at(2026, 7, 5), 3000))), moved);
is("healthy: the expanded subscription with its id reads as its id", beaMoves(beaInvoices(beaLine(at(2026, 7, 5), 3000, { subscription: { id: "sub_bea", object: "subscription" } }))), moved);
is(
  "healthy: no reference on the line (null), the invoice's own subscription reads",
  beaMoves(beaInvoices(beaLine(at(2026, 7, 5), 3000, { subscription: null, parent: null }), { subscription: "sub_bea" })),
  moved,
);
is(
  "healthy: the newer shape, the invoice's parent holding the expanded subscription",
  beaMoves(beaInvoices(beaLine(at(2026, 7, 5), 3000, { subscription: undefined }), { parent: { subscription_details: { subscription: { id: "sub_bea" } } } })),
  moved,
);
is(
  "healthy: a line of no membership (null everywhere) is not Bea's and moves nothing",
  beaMoves([...beaInvoices(beaLine(at(2026, 7, 5), 3000)), { created: at(2026, 7, 9), subscription: null, lines: { data: [{ subscription: null, amount: 500, period: { start: at(2026, 7, 9) } }] } }]),
  moved,
);
const unreadRefs: [string, Record<string, unknown>, Record<string, unknown>?][] = [
  ["the line's subscription an object with no id", { subscription: { object: "subscription" } }],
  ["the line's subscription an object whose id is a number", { subscription: { id: 42 } }],
  ["the line's subscription a number", { subscription: 42 }],
  ["the line's subscription true", { subscription: true }],
  ["the line's subscription a list", { subscription: ["sub_bea"] }],
  ["the line's subscription empty text", { subscription: "" }],
  ["the line's parent subscription an object with no id", { subscription: undefined, parent: { subscription_item_details: { subscription: { object: "subscription" } } } }],
  ["the line's parent subscription a number", { subscription: undefined, parent: { subscription_item_details: { subscription: 7 } } }],
  ["the invoice's subscription an object with no id", { subscription: undefined }, { subscription: { object: "subscription" } }],
  ["the invoice's subscription a number", { subscription: undefined }, { subscription: 42 }],
  ["the invoice's parent subscription an object with no id", { subscription: undefined }, { parent: { subscription_details: { subscription: {} } } }],
];
for (const [label, over, invoice] of unreadRefs) {
  is(`July's line, ${label}: refused, never skipped as no membership`, beaMoves(beaInvoices(beaLine(at(2026, 7, 5), 3000, over), invoice)), "refused");
}

process.env.STRIPE_SECRET_KEY = "sk_test_r24_revenue_stand_in";
const NOW = Date.parse("2026-10-13T12:00:00Z");
const S = NOW / 1000;
let refund: Record<string, unknown> = {};
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const list = (data: unknown[]) => new Response(JSON.stringify({ data, has_more: false }), { status: 200 });
  if (url.pathname.endsWith("/checkout/sessions")) return list([{
    id: "cs_test_r24rev0001", status: "complete", payment_status: "paid", amount_total: 5000, currency: "usd", created: S, payment_intent: "pi_r24rev1",
    customer_details: { email: "buyer@example.com" }, metadata: { store: "r24rev", product: "p1", channel: "instagram" },
  }]);
  if (url.pathname.endsWith("/refunds")) return list([{ id: "re_r24rev1", status: "succeeded", currency: "usd", created: S, payment_intent: "pi_r24rev1", ...refund }]);
  return list([]);
}) as typeof fetch;

async function main() {
  part("Kept, read from a stand-in for Stripe");
  redis.clear();
  const owner = "r24rev-owner@example.com";
  await claimHandle(owner, "r24rev", "Revenue", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_TestR24Rev01", true);
  const store = (await storeForEmail(owner))!;
  refund = { amount: 1000 };
  const ok = (await readSales(store, NOW))!.keptIn!.d7.lines[0];
  is("healthy refund: $50 paid, $10 back, $40 kept", [ok.salesCents, ok.refundCents, ok.keptCents, ok.missing], [5000, 1000, 4000, []]);
  for (const [label, amount] of [["missing", undefined], ["a string", "1000"], ["null", null], ["an object", { value: 1000 }]] as const) {
    refund = amount === undefined ? {} : { amount };
    const kept = (await readSales(store, NOW))!.keptIn!.d7.lines[0];
    is(`a refund whose amount is ${label}: no kept figure, "refunds could not all be read"`, [kept.keptCents, kept.missing], [null, ["refunds"]]);
  }
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
