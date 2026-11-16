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

// The objects the newer shape nests the subscription in (`parent`, then
// `subscription_details` or `subscription_item_details`) are read exactly too:
// absent or null is "none there"; any other shape is refused, never read as
// "no membership" and the line skipped (Claude 5's review of #3018).
is(
  "healthy: the line's parent with no item details (null), the invoice's parent reads",
  beaMoves(beaInvoices(beaLine(at(2026, 7, 5), 3000, { subscription: undefined, parent: { subscription_item_details: null } }), { parent: { subscription_details: { subscription: "sub_bea" } } })),
  moved,
);
is(
  "healthy: the invoice's parent with no subscription details (null), the line's own id reads",
  beaMoves(beaInvoices(beaLine(at(2026, 7, 5), 3000), { parent: { subscription_details: null } })),
  moved,
);
is(
  "healthy: the line's parent holding the item details with its id and no proration",
  beaMoves(beaInvoices(beaLine(at(2026, 7, 5), 3000, { subscription: undefined, parent: { subscription_item_details: { subscription: "sub_bea", proration: false } } }))),
  moved,
);
const notObjects: [string, unknown][] = [["a number", 5], ["text", "sub_bea"], ["true", true], ["a list", [{ subscription: "sub_bea" }]]];
for (const [shape, v] of notObjects) {
  is(`July's line, the line's parent ${shape}: refused, never skipped as no membership`, beaMoves(beaInvoices(beaLine(at(2026, 7, 5), 3000, { subscription: undefined, parent: v }))), "refused");
  is(
    `July's line, the line's subscription_item_details ${shape}: refused`,
    beaMoves(beaInvoices(beaLine(at(2026, 7, 5), 3000, { subscription: undefined, parent: { subscription_item_details: v } }))),
    "refused",
  );
  is(`July's invoice, its parent ${shape}: refused`, beaMoves(beaInvoices(beaLine(at(2026, 7, 5), 3000, { subscription: undefined }), { parent: v })), "refused");
  is(
    `July's invoice, its subscription_details ${shape}: refused`,
    beaMoves(beaInvoices(beaLine(at(2026, 7, 5), 3000, { subscription: undefined }), { parent: { subscription_details: v } })),
    "refused",
  );
  // The line's own id is read, but its parent is still read for proration.
  is(`July's line with its own id, its parent ${shape}: refused, not read as "no proration"`, beaMoves(beaInvoices(beaLine(at(2026, 7, 5), 3000, { parent: v }))), "refused");
}

// The same holds for the other objects a line nests what it is read by (rule
// 30): its price, the price's recurring terms, its decimal pricing and its
// period. Absent or null is "none there", read as before; any other shape is
// refused, never read as "no price", "the membership's own terms" or "no time".
is("healthy: the line's price null, read from its amount", beaMoves(beaInvoices(beaLine(at(2026, 7, 5), 3000, { price: null }))), moved);
is("healthy: the line's recurring terms null, read by the membership's", beaMoves(beaInvoices(beaLine(at(2026, 7, 5), 3000, { price: { unit_amount: 3000, recurring: null } }))), moved);
is("healthy: the line's decimal pricing null", beaMoves(beaInvoices(beaLine(at(2026, 7, 5), 3000, { pricing: null }))), moved);
for (const [shape, v] of notObjects) {
  is(`July's line, its price ${shape}: refused, never read as no price`, beaMoves(beaInvoices(beaLine(at(2026, 7, 5), 3000, { price: v }))), "refused");
  is(`July's line, its recurring terms ${shape}: refused`, beaMoves(beaInvoices(beaLine(at(2026, 7, 5), 3000, { price: { unit_amount: 3000, recurring: v } }))), "refused");
  is(`July's line, its decimal pricing ${shape}: refused`, beaMoves(beaInvoices(beaLine(at(2026, 7, 5), 3000, { price: null, pricing: v }))), "refused");
  is(`July's line, its period ${shape}: refused, never read as the invoice's date`, beaMoves(beaInvoices(beaLine(at(2026, 7, 5), 3000, { period: v }))), "refused");
}

// The scalars the same loop reads (rule 30; Claude 5's review of #3048):
// whether a line is a proration, the price's interval and the line's quantity.
// Absent or null reads as before; any other shape is refused, never read as
// "not a proration", "the membership's own terms" or "one".
const proration = (over: Record<string, unknown>) => beaLine(at(2026, 7, 20), 500, { price: null, ...over });
const withProration = (over: Record<string, unknown>): Invoice[] => [
  ...beaInvoices(beaLine(at(2026, 7, 5), 3000)),
  { created: at(2026, 7, 20), lines: { data: [proration(over)] } } as Invoice,
];
is("healthy: a proration line without its price (true) is skipped", beaMoves(withProration({ proration: true })), moved);
is("healthy: a proration line given under its parent (true) is skipped", beaMoves(withProration({ parent: { subscription_item_details: { subscription: "sub_bea", proration: true } } })), moved);
for (const [shape, v] of [["text", "true"], ["a number", 1], ["an object", { value: true }]] as [string, unknown][]) {
  is(`a proration flag given as ${shape}: refused, never a full month`, beaMoves(withProration({ proration: v })), "refused");
  is(`a proration flag under its parent given as ${shape}: refused`, beaMoves(withProration({ parent: { subscription_item_details: { subscription: "sub_bea", proration: v } } })), "refused");
}
for (const interval of ["day", "week", "month", "year"]) {
  is(`healthy: the interval ${interval} reads`, typeof beaMoves(beaInvoices(beaLine(at(2026, 7, 5), 3000, { price: { unit_amount: 3000, recurring: { interval, interval_count: 1 } } }))), "object");
}
is("healthy: no interval (null), read by the membership's terms", beaMoves(beaInvoices(beaLine(at(2026, 7, 5), 3000, { price: { unit_amount: 3000, recurring: { interval: null, interval_count: null } } }))), moved);
for (const [shape, v] of [["a number", 12], ["an unknown word", "fortnight"], ["empty text", ""], ["true", true]] as [string, unknown][]) {
  is(`the interval given as ${shape}: refused, never a month or the membership's terms`, beaMoves(beaInvoices(beaLine(at(2026, 7, 5), 3000, { price: { unit_amount: 3000, recurring: { interval: v, interval_count: 1 } } }))), "refused");
}
{
  const zero = pricesFrom(beaInvoices(beaLine(at(2026, 7, 5), 0, { quantity: 0, price: { unit_amount: 3000, recurring: { interval: "month", interval_count: 1 } } })), beaById).get("sub_bea");
  is("a quantity of 0 is worth nothing that month, never one at the full price", zero?.find((e) => e.at === at(2026, 7, 5))?.value, 0);
}
is("healthy: no quantity (null) counts one", beaMoves(beaInvoices(beaLine(at(2026, 7, 5), 3000, { quantity: null }))), moved);
for (const [shape, v] of [["negative", -1], ["fractional", 1.5]] as [string, unknown][]) {
  is(`a quantity that is ${shape}: refused`, beaMoves(beaInvoices(beaLine(at(2026, 7, 5), 3000, { quantity: v }))), "refused");
}
// Stripe embeds at most 10 lines in an invoice; more of them is a list cut short, not the whole invoice.
{
  const julyWith = (has_more: unknown): Invoice[] => {
    const [june, , august] = beaInvoices(beaLine(at(2026, 7, 5), 3000));
    return [june, { created: at(2026, 7, 5), lines: { data: [beaLine(at(2026, 7, 5), 3000)], has_more } } as Invoice, august];
  };
  is("healthy: an invoice whose lines say there are no more (false) reads", beaMoves(julyWith(false)), moved);
  is("an invoice whose lines say there are more: refused, never read as all of them", beaMoves(julyWith(true)), "refused");
  is("an invoice whose 'more lines' is not a yes or no: refused", beaMoves(julyWith("no")), "refused");
}

// The interval count is a whole number from 1 (Claude 5's focal return on #3048, LOW 1).
const yearly = (count: unknown) => beaInvoices(beaLine(at(2026, 7, 5), 36000, { price: { unit_amount: 36000, recurring: { interval: "year", interval_count: count } } }));
is("healthy: an interval count of 1 reads", typeof beaMoves(yearly(1)), "object");
is("healthy: no interval count (null) reads as one", beaMoves(yearly(null)), beaMoves(yearly(1)));
for (const [shape, v] of [["0", 0], ["negative", -2], ["fractional", 1.5], ["text", "one"]] as [string, unknown][]) {
  is(`an interval count that is ${shape}: refused, never one or a made-up price`, beaMoves(yearly(v)), "refused");
}
// Another business's invoice on the same Stripe account with more than 10 lines
// holds no member's line: it is passed over, never a reason to hide every movement
// (LOW 2). One that may hold a member's line is still refused.
{
  const withOther = (other: Record<string, unknown>): Invoice[] => [...beaInvoices(beaLine(at(2026, 7, 5), 3000)), other as Invoice];
  const others = { data: [{ ...line(at(2026, 7, 9)), subscription: "sub_someone_else", amount: 900 }, { ...line(at(2026, 7, 9)), subscription: null, amount: 100 }], has_more: true };
  is("another business's invoice with more lines: passed over, July still moves", beaMoves(withOther({ created: at(2026, 7, 9), subscription: null, customer: "cus_other", lines: others })), moved);
  is("an invoice of the member's own subscription with more lines: refused", beaMoves(withOther({ created: at(2026, 7, 9), subscription: "sub_bea", lines: others })), "refused");
  is("an invoice of the member as customer with more lines: refused", beaMoves(withOther({ created: at(2026, 7, 9), subscription: null, customer: "cus_bea", lines: others })), "refused");
  is(
    "an invoice with a member's line among those given and more to come: refused",
    beaMoves(withOther({ created: at(2026, 7, 9), subscription: null, customer: "cus_other", lines: { ...others, data: [...others.data, beaLine(at(2026, 7, 9), 3000)] } })),
    "refused",
  );
}

// Claude 5's focal return on #3048 (6704697572), LOW A: an invoice with more lines whose customer is absent or null
// may be a member's (with Accounts v2 it can come with only customer_account): refused, never passed over.
{
  const longOther = (customer: unknown): Invoice[] => [
    ...beaInvoices(beaLine(at(2026, 7, 5), 3000)),
    { created: at(2026, 7, 9), subscription: null, ...(customer === undefined ? {} : { customer }), lines: { data: [{ ...line(at(2026, 7, 9)), subscription: "sub_someone_else", amount: 900 }], has_more: true } } as Invoice,
  ];
  is("an invoice with more lines and no customer: refused, never passed over", beaMoves(longOther(undefined)), "refused");
  is("an invoice with more lines and a null customer: refused", beaMoves(longOther(null)), "refused");
  is("healthy: another business's customer is still passed over", beaMoves(longOther("cus_other")), moved);
}
// LOW B: a count and a quantity are numbers, never text, even text that reads as one.
is("an interval count given as the text \"2\": refused", beaMoves(yearly("2")), "refused");
is("a quantity given as the text \"1\": refused", beaMoves(beaInvoices(beaLine(at(2026, 7, 5), 3000, { quantity: "1" }))), "refused");

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
