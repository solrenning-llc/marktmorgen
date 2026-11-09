/**
 * A yearly renewal that did not go through, offered at the same membership's
 * monthly price (630 [HN6](14), unit 1; added 4 November 2026;
 * lib/yearly-fallback-rules.ts). Synthetic subscriptions and invoices only:
 * nothing is sent or charged by these rules.
 */
import { readFileSync } from "node:fs";
import { type FallbackInvoice, type FallbackSub, fallbackLines, monthlyFallback } from "@/lib/yearly-fallback-rules";
import { formatMoney } from "@/lib/money";
import { done, is, part } from "./check";

const NOW = Date.UTC(2026, 10, 4) / 1000;
const product = { id: "p1", priceCents: 2000, recurring: { interval: "month", trialDays: 0, payments: 0 }, options: [], pwyw: false, yearly: { cents: 20000 } };
// Stripe always sends `discounts` on the subscription and on each item (a list, empty when none): every row here lists
// none, so each check below still fails or passes for its own reason, never for a discount not known
// (tests/yearly-discounts-unknown.test.ts, rule 30).
const sub: FallbackSub = {
  status: "past_due",
  discounts: [],
  collection_method: "charge_automatically",
  metadata: { store: "lena" },
  default_payment_method: { id: "pm_1", type: "card" },
  items: { data: [{ quantity: 1, discounts: [], price: { unit_amount: 20000, currency: "usd", recurring: { interval: "year", interval_count: 1 } } }] },
};
const invoice: FallbackInvoice = { subscription: "sub_1", billing_reason: "subscription_cycle", status: "open", amount_due: 20000, currency: "usd" };
const offer = (s: FallbackSub = sub, i: FallbackInvoice = invoice, p: typeof product | null = product, tiers: string[] = []) => monthlyFallback("sub_1", s, i, p, tiers, "usd", NOW);

part("When it is offered");
is("a yearly membership whose renewal failed: one month at the product's own monthly price, the year not charged, and what twelve months cost more", offer(), { monthly: 2000, yearly: 20000, extraPerYear: 4000 });
is(
  "only the membership's own renewal, still open: never another subscription's, a first payment, a paid or voided invoice",
  [
    offer(sub, { ...invoice, subscription: "sub_other" }),
    offer(sub, { ...invoice, billing_reason: "subscription_create" }),
    offer(sub, { ...invoice, status: "paid" }),
    offer(sub, { ...invoice, status: "void" }),
    offer(sub, { ...invoice, currency: "eur" }),
    offer(sub, { ...invoice, amount_due: 0 }),
  ],
  [null, null, null, null, null, null],
);
is(
  "only past due on it and charged automatically: never paid by invoice, canceled, set to end, paused, a payment plan, discounted, or with an affiliate's months still running",
  [
    offer({ ...sub, collection_method: "send_invoice" } as FallbackSub),
    offer({ ...sub, status: "canceled" }),
    offer({ ...sub, status: "active" }),
    offer({ ...sub, cancel_at_period_end: true }),
    offer({ ...sub, cancel_at: NOW + 86_400 }),
    offer({ ...sub, pause_collection: { behavior: "void" } }),
    offer({ ...sub, metadata: { kind: "plan" } }),
    offer({ ...sub, discount: { id: "di_1" } }),
    offer({ ...sub, metadata: { via: "aff1", via_months: "6", via_at: String(NOW - 86_400) } }),
  ],
  [null, null, null, null, null, null, null, null, null],
);
is(
  "never driven by a schedule, never with a discount on its item, never on an invoice partly paid or whose retries were stopped (review, 4 November 2026)",
  [
    offer({ ...sub, schedule: "sub_sched_1" }),
    offer({ ...sub, items: { data: [{ quantity: 1, discounts: ["di_item"], price: { unit_amount: 20000, currency: "usd", recurring: { interval: "year", interval_count: 1 } } }] } }),
    offer(sub, { ...invoice, amount_paid: 5000 }),
    offer(sub, { ...invoice, auto_advance: false }),
  ],
  [null, null, null, null],
);
is("an invoice nothing was paid on, still retried, is offered", offer(sub, { ...invoice, amount_paid: 0, auto_advance: true }) !== null, true);
const paidWith = (own: unknown, theirs?: unknown) => offer({ ...sub, default_payment_method: own, customer: theirs === undefined ? "cus_1" : { invoice_settings: { default_payment_method: theirs } } });
is(
  "only paid with a method that can carry a change made only if paid: never a bank debit, never a method that cannot be read",
  [
    paidWith({ type: "sepa_debit" }),
    paidWith({ type: "us_bank_account" }),
    paidWith({ type: "bacs_debit" }),
    paidWith({ type: "au_becs_debit" }),
    paidWith("pm_unexpanded"),
    paidWith(null),
    paidWith(null, "pm_unexpanded"),
    paidWith(null, { type: "sepa_debit" }),
  ],
  [null, null, null, null, null, null, null, null],
);
is(
  "never with an older source on the membership, which Stripe charges before the customer's default and may be a bank debit",
  [paidWith(null, { type: "card" }), offer({ ...sub, default_payment_method: null, default_source: "ba_old", customer: { invoice_settings: { default_payment_method: { type: "card" } } } })].map((o) => o !== null),
  [true, false],
);
const customerWith = (discount: unknown) => offer({ ...sub, customer: { discount, invoice_settings: { default_payment_method: { type: "card" } } } });
is(
  "never with a coupon on the customer or a discount on the invoice: the email would quote prices nobody is charged",
  [
    customerWith(null) !== null,
    customerWith({ coupon: { percent_off: 50, duration: "forever" } }),
    offer(sub, { ...invoice, discounts: ["di_1"] }),
    offer(sub, { ...invoice, total_discount_amounts: [{ amount: 10000, discount: "di_1" }] }),
    offer(sub, { ...invoice, discounts: [], total_discount_amounts: [] }) !== null,
  ],
  [true, null, null, null, true],
);
is("a card, a wallet or Link, its own or the customer's default", [paidWith({ type: "link" }) !== null, paidWith(null, { type: "card" }) !== null, paidWith({ type: "paypal" }) !== null], [true, true, true]);
is(
  "only once a year, one item of one, in the store's currency",
  [
    offer({ ...sub, items: { data: [{ quantity: 1, discounts: [], price: { unit_amount: 2000, currency: "usd", recurring: { interval: "month", interval_count: 1 } } }] } }),
    offer({ ...sub, items: { data: [{ quantity: 1, discounts: [], price: { unit_amount: 40000, currency: "usd", recurring: { interval: "year", interval_count: 2 } } }] } }),
    offer({ ...sub, items: { data: [{ quantity: 2, discounts: [], price: { unit_amount: 20000, currency: "usd", recurring: { interval: "year", interval_count: 1 } } }] } }),
    offer({ ...sub, items: { data: [{ quantity: 1, discounts: [], price: { unit_amount: 20000, currency: "eur", recurring: { interval: "year", interval_count: 1 } } }] } }),
  ],
  [null, null, null, null],
);
is(
  "only while the product still sells monthly with a yearly price: not gone, not a plan between tiers, no introductory price, no yearly price",
  [offer(sub, invoice, null), offer(sub, invoice, product, ["p1"]), offer(sub, invoice, { ...product, intro: { cents: 500 } } as typeof product), offer(sub, invoice, { ...product, yearly: null } as unknown as typeof product)],
  [null, null, null, null],
);
is(
  "the invoice's subscription read where the current API names it, and where older versions did",
  [offer(sub, { ...invoice, subscription: undefined, parent: { subscription_details: { subscription: "sub_1" } } }) !== null, offer(sub, { ...invoice, subscription: "sub_1", parent: { subscription_details: { subscription: "sub_other" } } })],
  [true, null],
);
is(
  "never offered as a saving: a membership whose own yearly price is more than twelve months at today's monthly price is not offered",
  offer({ ...sub, items: { data: [{ quantity: 1, discounts: [], price: { unit_amount: 30000, currency: "usd", recurring: { interval: "year", interval_count: 1 } } }] } }),
  null,
);
is(
  "compared on one footing, before tax and credit: tax added on the invoice, or a credit taken off it, never changes the figures",
  [offer(sub, { ...invoice, amount_due: 22000 }), offer(sub, { ...invoice, amount_due: 25400 }), offer(sub, { ...invoice, amount_due: 5000 })],
  [{ monthly: 2000, yearly: 20000, extraPerYear: 4000 }, { monthly: 2000, yearly: 20000, extraPerYear: 4000 }, { monthly: 2000, yearly: 20000, extraPerYear: 4000 }],
);
is("the monthly price is the product's own today, never the failed year's amount divided", offer(sub, invoice, { ...product, priceCents: 1800, yearly: { cents: 20000 } })?.monthly, 1800);

part("What the email says");
const money = (cents: number) => formatMoney(cents, "usd");
const lines = fallbackLines({ monthly: 2000, yearly: 20000, extraPerYear: 4000 }, money, false);
is(
  "the monthly price, that the year is then not charged, and what twelve months cost more",
  lines,
  ["If a whole year is too much now, you can stay a member at $20 a month.", "Then the yearly payment of $200 is not charged.", "Twelve months cost $40 more than the year."],
);
is("when twelve months cost the same, it says so, never a saving", fallbackLines({ monthly: 2000, yearly: 24000, extraPerYear: 0 }, money, false).at(-1), "Twelve months cost the same as the year.");
const taxed = fallbackLines({ monthly: 2000, yearly: 20000, extraPerYear: 4000 }, money, true);
is(
  "where the store adds tax on top, every amount says so",
  taxed,
  ["If a whole year is too much now, you can stay a member at $20 plus tax a month.", "Then the yearly payment of $200 plus tax is not charged.", "Twelve months cost $40 more than the year, before tax."],
);
is("in plain words: every sentence under twenty words", [...lines, ...taxed].every((line) => line.split(/\s+/).length <= 20), true);

part("Nothing is sent or charged yet");
const source = readFileSync("lib/yearly-fallback-rules.ts", "utf8").replace(/\/\*\*[\s\S]*?\*\//g, "");
is("rules only: no network, no storage, no Stripe call", /fetch\(|redis|onAccount|stripe\(/i.test(source), false);

done();
