/**
 * C4-36 (B), step 2: the sales numbers made from compact inputs
 * (lib/sales-inputs.ts) are the numbers made from the whole records.
 *
 * What fails here:
 *   - a field of a sale's record that the numbers read (recorded through a
 *     Proxy while they are made) not kept by compactSale;
 *   - any difference in the numbers, for sales of every kind the numbers tell
 *     apart: plain, coded, welcome, comeback, sale price, bump, bundle,
 *     recovered checkout, an offer after paying, a tip, PayPal, another
 *     currency, refunded and disputed.
 */
import { isDeepStrictEqual } from "node:util";
import { renewalsFromInvoices, salesFromInputs, type Sale, type SalesInputs } from "@/lib/stats";
import { compactInvoice, compactSale, compactSalesInputs } from "@/lib/sales-inputs";
import type { Store } from "@/lib/store";
import { done, is, part } from "./check";

const NOW = Date.UTC(2031, 5, 20, 12);
const DAY = 86_400_000;
const store = { handle: "kiln", previousHandles: [], sid: "s1", currency: "usd", stripeAccountId: "acct_1", paypalSeller: null, statsId: "a".repeat(32), catalog: { items: [], head: [], inline: [] } } as unknown as Store;
let n = 0;
function sale(days: number, meta: Record<string, string>, extra: Record<string, unknown> = {}, over: Partial<Sale> = {}): Sale {
  n += 1;
  const created = NOW - days * DAY - n * 60_000;
  const row: Record<string, unknown> = {
    id: `cs_test_${String(n).padStart(6, "0")}`, object: "checkout.session", status: "complete", payment_status: "paid", amount_total: 4_900, currency: "usd",
    customer_details: { email: `buyer${n % 7}@example.com`, name: `Buyer ${n}`, address: { country: "US", line1: "1 Main St" } },
    metadata: { store: "kiln", product: `p${n % 3}`, ...meta }, payment_intent: `pi_${n}`, url: "https://checkout.stripe.com/x", ...extra,
  };
  return { created, product: `p${n % 3}`, cents: 4_900, currency: "usd", row, upsell: false, source: n % 2 ? "instagram" : "", medium: "", campaign: n % 4 ? "" : "spring", first: n % 3 ? "tiktok" : "", content: "", country: "US", paymentIntent: `pi_${n}`, ...over };
}
const read: Sale[] = [
  sale(1, {}), sale(2, { code: "SAVE10" }, { total_details: { amount_discount: 490, amount_tax: 0 } }), sale(3, { welcome: "1" }), sale(4, { winback: "1" }),
  sale(5, { sale: "1" }), sale(6, { intro: "1" }), sale(7, { fair: "1" }), sale(8, { code_off: "700" }), sale(9, { bump: "p2", bundle: "p1", bundle_2: "p2" }),
  sale(10, {}, { recovered_from: "cs_test_old" }), sale(11, { kind: "tip" }), sale(12, {}, { receipt_email: "upsell@example.com" }, { upsell: true }),
  sale(13, { paid_with: "paypal" }, { id: "paypal:ORDER1", object: "paypal.order" }), sale(14, {}, {}, { currency: "eur" }), sale(40, {}), sale(95, {}), sale(150, {}),
  ...Array.from({ length: 30 }, (_, i) => sale(i % 90, i % 5 ? {} : { code: "AGAIN" })),
];
// Paid invoices of memberships and payment plans: renewals (subscription_cycle) and first payments, in both of
// Stripe's places for the subscription's metadata, with what an invoice carries that the renewals never read.
const invoice = (days: number, reason: string, meta: Record<string, string>, newer: boolean): Record<string, unknown> => {
  n += 1;
  const details = { metadata: { store: "kiln", product: `p${n % 3}`, ...meta } };
  return {
    id: `in_test_${String(n).padStart(6, "0")}`, object: "invoice", status: "paid", amount_paid: 1_900 + n, currency: "usd", billing_reason: reason,
    created: Math.floor((NOW - days * DAY) / 1000), customer_email: `member${n % 5}@example.com`, hosted_invoice_url: "https://invoice.stripe.com/x", lines: { data: [{ id: "il_1" }] },
    ...(newer ? { parent: { type: "subscription_details", subscription_details: details } } : { subscription_details: details }),
  };
};
const invoices = [
  invoice(1, "subscription_cycle", {}, false), invoice(5, "subscription_cycle", { channel: "newsletter" }, true), invoice(20, "subscription_create", {}, true),
  invoice(40, "subscription_cycle", { utm_source: "youtube" }, false), invoice(80, "subscription_cycle", {}, true), invoice(3, "subscription_cycle", {}, true),
];
const inputs: SalesInputs = {
  read,
  readPartial: false,
  renewalRead: renewalsFromInvoices(store, invoices, false, NOW),
  refundRead: { rows: [{ created: NOW - 2 * DAY, cents: 4_900, currency: "usd", paymentIntent: "pi_2" }, { created: NOW - DAY, cents: 1_000, currency: "usd", paymentIntent: "pi_9" }], partial: false },
  disputeRead: { rows: [{ created: NOW - 3 * DAY, cents: 4_900, currency: "usd", paymentIntent: "pi_3" }], partial: false },
};

part("Every field of a record the numbers read is kept");
const readFields = new Set<string>();
const watch = (value: unknown, path: string): unknown =>
  value && typeof value === "object"
    ? new Proxy(value as object, {
        get(target, key, receiver) {
          const got = Reflect.get(target, key, receiver);
          if (typeof key === "string") {
            readFields.add(`${path}${key}`);
            return watch(got, `${path}${key}.`);
          }
          return got;
        },
      })
    : value;
const watched: SalesInputs = { ...inputs, read: read.map((s) => ({ ...s, row: watch(s.row, "") as Record<string, unknown> })) };
const invoiceFields = new Set<string>();
const watchInvoice = (value: unknown, path: string): unknown =>
  value && typeof value === "object"
    ? new Proxy(value as object, {
        get(target, key, receiver) {
          const got = Reflect.get(target, key, receiver);
          if (typeof key === "string") {
            invoiceFields.add(`${path}${key}`);
            return watchInvoice(got, `${path}${key}.`);
          }
          return got;
        },
      })
    : value;
const watchedRenewals = renewalsFromInvoices(store, invoices.map((i) => watchInvoice(i, "") as Record<string, unknown>), false, NOW);
const whole = salesFromInputs(store, watched, NOW);
const topRead = [...readFields].map((f) => f.split(".")[0]);
const compactKeys = new Set(read.flatMap((s) => Object.keys(compactSale(s).row)));
const missing = [...new Set(topRead)].filter((f) => !compactKeys.has(f) && read.some((s) => s.row[f] !== undefined));
is(`the numbers read some fields of the records (the watch works): ${[...new Set(topRead)].sort().join(", ")}`, readFields.size > 3, true);
is("each of them is kept (nested: customer_details.email, total_details.amount_discount, metadata whole)", missing, []);
const nested = [...readFields].filter((f) => f.startsWith("customer_details.") || f.startsWith("total_details."));
is("of the nested ones, only what compactSale keeps", nested.filter((f) => !["customer_details.email", "total_details.amount_discount"].includes(f)), []);

const invoiceTop = [...new Set([...invoiceFields].map((f) => f.split(".")[0]))];
const invoiceKept = new Set(invoices.flatMap((i) => Object.keys(compactInvoice(i))));
is(`the renewals read some fields of the invoices: ${invoiceTop.sort().join(", ")}`, invoiceTop.length > 3, true);
is("each of them is kept", invoiceTop.filter((f) => !invoiceKept.has(f) && invoices.some((i) => i[f] !== undefined)), []);
is("of the nested ones, only the subscription's metadata, in either place", [...invoiceFields].filter((f) => f.includes(".") && !/^(subscription_details\.metadata|parent\.subscription_details(\.metadata)?)(\.|$)/.test(f) && !/^(subscription_details|parent)$/.test(f)), []);
is("the renewals made from the watched invoices are the whole ones'", isDeepStrictEqual(watchedRenewals, inputs.renewalRead), true);

part("The numbers are the same");
const compact = salesFromInputs(store, compactSalesInputs(store, inputs, NOW), NOW);
is("made from compact inputs, every number equal", isDeepStrictEqual(compact, salesFromInputs(store, inputs, NOW)), true);
is("and from the watched whole ones", isDeepStrictEqual(compact, whole), true);
const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), "utf8");
is(`smaller: ${bytes(compactSalesInputs(store, inputs, NOW))} bytes against ${bytes(inputs)}`, bytes(compactSalesInputs(store, inputs, NOW)) < bytes(inputs), true);
is("renewals made from compact invoices are the same", isDeepStrictEqual({ ...compactSalesInputs(store, inputs, NOW).renewalRead, invoices: [] }, { ...inputs.renewalRead, invoices: [] }), true);

done();
