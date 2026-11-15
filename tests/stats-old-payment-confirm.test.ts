/**
 * A refund or dispute of a membership payment older than the invoices a reading of a store's numbers reads is
 * confirmed as the store's by its own invoice payment (lib/stats.ts, paymentOfStoreInvoice; #4549): GET
 * /v1/invoice_payments filtered by the payment, the invoice expanded. Only an exact answer naming that payment, paid,
 * on a paid membership invoice of this store confirms it; any other shape, another payment, another store, an
 * invoice not paid or of another reason, or an error, does not, so the kept total stays unknown rather than reduced
 * on a guess. At most OLD_PAYMENT_LOOKUPS_PER_READING lookups a reading. Synthetic store, mocked Stripe only.
 */
import { readFileSync } from "node:fs";
import { claimHandle, setStripeAccount, storeForEmail } from "@/lib/store";
import { OLD_PAYMENT_LOOKUPS_PER_READING, paymentOfStoreInvoice } from "@/lib/stats";
import { done, is, part } from "./check";
import { NOT_A_COST } from "./plan-cost-registry";

const PI = "pi_OldRenewal0001";
let reply: unknown = null;
let status = 200;
const asked: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  asked.push(`${url.pathname}?${url.searchParams.toString()}`);
  return new Response(JSON.stringify(reply), { status });
}) as typeof fetch;

const invoice = (over: Record<string, unknown> = {}) => ({
  id: "in_OldRenewal0001", object: "invoice", status: "paid", billing_reason: "subscription_cycle",
  parent: { type: "subscription_details", subscription_details: { metadata: { store: "oldpay" } } }, ...over,
});
const row = (over: Record<string, unknown> = {}) => ({ object: "invoice_payment", id: "inpay_1", status: "paid", invoice: invoice(), payment: { type: "payment_intent", payment_intent: PI }, ...over });
const list = (rows: unknown[], extra: Record<string, unknown> = {}) => ({ object: "list", data: rows, has_more: false, ...extra });

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_old_payment_confirm";
  await claimHandle("oldpay@example.com", "oldpay", "Old Pay", "");
  await setStripeAccount("oldpay@example.com", "acct_1OldPayConfirm", true);
  const store = (await storeForEmail("oldpay@example.com"))!;

  part("Confirmed: that payment, paid, on a paid membership invoice of this store");
  reply = list([row()]);
  is("a renewal's payment", await paymentOfStoreInvoice(store, PI), true);
  is("asked by the payment, with the invoice expanded", /payment%5Btype%5D=payment_intent&payment%5Bpayment_intent%5D=pi_OldRenewal0001&limit=1&expand%5B%5D=data.invoice/.test(asked.at(-1) ?? ""), true);
  reply = list([row({ invoice: invoice({ billing_reason: "subscription_create" }) })]);
  is("the checkout's own invoice of a membership", await paymentOfStoreInvoice(store, PI), true);
  reply = list([row({ invoice: invoice({ billing_reason: "subscription_update" }) })]);
  is("a plan change charged at once", await paymentOfStoreInvoice(store, PI), true);

  part("Not confirmed: every other answer");
  const cases: [string, unknown, number?][] = [
    ["no invoice payment", list([])],
    ["two rows", list([row(), row()])],
    ["not a list", { object: "invoice_payment" }],
    ["data not an array", { object: "list", data: { rows: [row()] }, has_more: false }],
    ["has_more missing", { object: "list", data: [row()] }],
    ["the payment not paid", list([row({ status: "open" })])],
    ["another payment", list([row({ payment: { type: "payment_intent", payment_intent: "pi_Another00001" } })])],
    ["a charge, not a payment intent", list([row({ payment: { type: "charge", charge: "ch_1" } })])],
    ["the invoice not expanded", list([row({ invoice: "in_OldRenewal0001" })])],
    ["the invoice not paid", list([row({ invoice: invoice({ status: "open" }) })])],
    ["a manual invoice", list([row({ invoice: invoice({ billing_reason: "manual" }) })])],
    ["another store's invoice", list([row({ invoice: invoice({ parent: { subscription_details: { metadata: { store: "othershop" } } } }) })])],
    ["no metadata", list([row({ invoice: invoice({ parent: null }) })])],
    ["null", null],
  ];
  for (const [label, body] of cases) {
    reply = body;
    is(label, await paymentOfStoreInvoice(store, PI), false);
  }
  status = 500;
  reply = { error: { message: "down" } };
  is("Stripe down: thrown, the reading's caller counts it as not confirmed", await paymentOfStoreInvoice(store, PI).then(() => "resolved", () => "thrown"), "thrown");
  status = 200;
  reply = list([row()]);
  is("not a payment intent id: nothing asked", [await paymentOfStoreInvoice(store, "ch_NotAnIntent1"), asked.at(-1)?.includes("ch_NotAnIntent1")], [false, false]);
  is("no Stripe account: nothing asked", await paymentOfStoreInvoice({ ...store, stripeAccountId: undefined } as never, PI), false);

  part("Bounded: at most OLD_PAYMENT_LOOKUPS_PER_READING lookups a reading, and a failed one proves nothing");
  is("ten at most", OLD_PAYMENT_LOOKUPS_PER_READING, 10);
  is("the lookups are in the cost registry, by name", typeof NOT_A_COST.OLD_PAYMENT_LOOKUPS_PER_READING, "string");
  const src = readFileSync("lib/stats.ts", "utf8");
  is("the reading slices the unknown payments to the cap", /unknownPayments\.slice\(0, OLD_PAYMENT_LOOKUPS_PER_READING\)/.test(src), true);
  is("a lookup that throws is read as not confirmed", /paymentOfStoreInvoice\(store, pi\)\.catch\(\(error\) => \{[\s\S]{0,120}return false;/.test(src), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
