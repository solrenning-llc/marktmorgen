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
import { salesFromInputs, type Sale, type SalesInputs } from "@/lib/stats";
import { compactSale, compactSalesInputs } from "@/lib/sales-inputs";
import type { Store } from "@/lib/store";
import { done, is, part } from "./check";

const NOW = Date.UTC(2031, 5, 20, 12);
const DAY = 86_400_000;
const store = { handle: "kiln", sid: "s1", currency: "usd", stripeAccountId: "acct_1", paypalSeller: null, statsId: "a".repeat(32), catalog: { items: [], head: [], inline: [] } } as unknown as Store;
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
const inputs: SalesInputs = {
  read,
  readPartial: false,
  renewalRead: undefined,
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
const whole = salesFromInputs(store, watched, NOW);
const topRead = [...readFields].map((f) => f.split(".")[0]);
const compactKeys = new Set(read.flatMap((s) => Object.keys(compactSale(s).row)));
const missing = [...new Set(topRead)].filter((f) => !compactKeys.has(f) && read.some((s) => s.row[f] !== undefined));
is(`the numbers read some fields of the records (the watch works): ${[...new Set(topRead)].sort().join(", ")}`, readFields.size > 3, true);
is("each of them is kept (nested: customer_details.email, total_details.amount_discount, metadata whole)", missing, []);
const nested = [...readFields].filter((f) => f.startsWith("customer_details.") || f.startsWith("total_details."));
is("of the nested ones, only what compactSale keeps", nested.filter((f) => !["customer_details.email", "total_details.amount_discount"].includes(f)), []);

part("The numbers are the same");
const compact = salesFromInputs(store, compactSalesInputs(inputs), NOW);
is("made from compact inputs, every number equal", isDeepStrictEqual(compact, salesFromInputs(store, inputs, NOW)), true);
is("and from the watched whole ones", isDeepStrictEqual(compact, whole), true);
const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), "utf8");
is(`smaller: ${bytes(compactSalesInputs(inputs))} bytes against ${bytes(inputs)}`, bytes(compactSalesInputs(inputs)) < bytes(inputs), true);

done();
