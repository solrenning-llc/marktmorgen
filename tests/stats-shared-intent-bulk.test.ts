/**
 * Claude 5 on #4549 (MEDIUM, money, rule 30): the account's invoice payments, read in bulk before the one-by-one
 * lookups, confirmed a payment as the store's as soon as one invoice it paid was the store's, even when the same answer
 * listed it paying another invoice too, or when the answer was cut short (partial) and its other invoices may be among
 * those not read. A payment that paid more than one invoice does not say which one a refund gives back (Codex X7), so
 * such a refund leaves the kept total unknown, never reduced on a guess. Synthetic store, Stripe answered here.
 */
import { readSales, type SalesStats } from "@/lib/stats";
import { claimHandle, ensureStatsId, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_cashflow_stand_in";
const NOW = Date.parse("2026-10-13T12:00:00Z");
let sessions: unknown[] = [];
let invoices: unknown[] = [];
let refunds: unknown[] = [];
let invoicePayments: Record<string, unknown>[] = [];
/** Allocations made before the bulk read's window (created[gte]): only the one-by-one lookup by intent lists them. */
let olderPayments: Record<string, unknown>[] = [];
/** The bulk read answers page after page with more behind each (partial), and the one-by-one lookup says more too. */
let endless = false;
let page = 0;
/** Independent lookup of one intent: it can remain incomplete, or prove the whole allocation. */
let filteredReply: Record<string, unknown> | null = null;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const list = (data: unknown[], more = false) => new Response(JSON.stringify({ object: "list", data, has_more: more }), { status: 200 });
  if (url.pathname.endsWith("/checkout/sessions")) return list(sessions);
  if (url.pathname.endsWith("/invoices")) return list(url.searchParams.get("status") === "paid" ? invoices : []);
  if (url.pathname.endsWith("/invoice_payments")) {
    const intent = url.searchParams.get("payment[payment_intent]");
    if (intent) {
      if (filteredReply) return new Response(JSON.stringify(filteredReply), { status: 200 });
      // The one-by-one lookup answers honestly: every invoice payment of that intent, one at a time.
      const rows = [...invoicePayments, ...olderPayments].filter((row) => (row.payment as { payment_intent?: string }).payment_intent === intent);
      return list(rows.slice(0, 1), endless || rows.length > 1);
    }
    if (!endless) return list(invoicePayments);
    page += 1;
    return list(page === 1 ? invoicePayments : [{ id: `inpay_more${page}`, object: "invoice_payment", invoice: `in_other${page}`, status: "paid", payment: { type: "payment_intent", payment_intent: `pi_other${page}000` } }], true);
  }
  if (url.pathname.endsWith("/refunds")) return list(refunds);
  return list([]);
}) as typeof fetch;
const refund = (pi: string, cents: number) => ({ id: `re_${pi}`, object: "refund", status: "succeeded", amount: cents, currency: "usd", created: NOW / 1000, payment_intent: pi });
const pay = (id: string, invoice: string, pi: string) => ({ id, object: "invoice_payment", invoice, status: "paid", payment: { type: "payment_intent", payment_intent: pi } });

async function main() {
  redis.clear();
  const owner = "cashflow-owner@example.com";
  await claimHandle(owner, "cashflow", "Cashflow", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_TestCashflow001", true);
  const store = (await storeForEmail(owner))!;
  const usd = (r: SalesStats) => r.keptIn?.d7.lines.find((row) => row.currency === "usd");
  const renewal = { id: "in_renew_new", object: "invoice", status: "paid", billing_reason: "subscription_cycle", amount_paid: 5000, currency: "usd",
    created: NOW / 1000 - 3600, parent: { subscription_details: { metadata: { store: "cashflow", product: "club", channel: "newsletter" } } } };

  part("Control: the payment paid only the store's renewal");
  invoices = [renewal];
  invoicePayments = [pay("inpay_1", "in_renew_new", "pi_sharedintent01")];
  refunds = [refund("pi_sharedintent01", 1000)];
  is("control: $40 kept, known", usd((await readSales(store, NOW))!)?.keptCents, 4000);

  part("The same payment also paid an invoice that is not the store's (listed in the same answer)");
  invoicePayments = [pay("inpay_1", "in_renew_new", "pi_sharedintent01"), pay("inpay_2", "in_payment_link_x", "pi_sharedintent01")];
  is("a refund of a payment that also paid another invoice: kept unknown", usd((await readSales(store, NOW))!)?.keptCents ?? null, null);
  // Codex X5 on #4549 (MEDIUM, money): a renewal that names the payment is a candidate, not proof of all its allocations.
  invoices = [{ ...renewal, payment_intent: "pi_sharedintent01" }];
  const namedRenewal = usd((await readSales(store, NOW))!);
  is("the same allocation is unknown when the renewal names the intent", [namedRenewal?.keptCents, namedRenewal?.missing], [null, ["refunds"]]);
  invoicePayments = [pay("inpay_1", "in_renew_new", "pi_sharedintent01")];
  is("confirmed allocation of a renewal that names the intent: $40 kept", usd((await readSales(store, NOW))!)?.keptCents, 4000);

  part("A paid allocation names the same payment, but its invoice could not be read");
  // Codex G on #4549 (MEDIUM, money): an allocation whose invoice is unreadable may be another store's.
  invoicePayments = [pay("inpay_1", "in_renew_new", "pi_sharedintent01"), { ...pay("inpay_2", "in_unreadable", "pi_sharedintent01"), invoice: null }];
  is("unreadable invoice on the same payment: kept unknown", usd((await readSales(store, NOW))!)?.keptCents, null);

  part("A row with an unreadable status may be another paid allocation on the same intent");
  for (const status of [null, "open", "canceled"]) {
    invoicePayments = [
      pay("inpay_1", "in_renew_new", "pi_sharedintent01"),
      { ...pay("inpay_2", "in_other_invoice", "pi_sharedintent01"), status },
    ];
    const line = usd((await readSales(store, NOW))!);
    is(`a same-intent allocation with status ${String(status)}`, line?.keptCents, status === null ? null : 4000);
  }

  part("A paid allocation without a readable payment identity cannot complete the bulk proof");
  const unidentified: [string, unknown][] = [
    ["no payment", null],
    ["no type or id", {}],
    ["missing intent id", { type: "payment_intent" }],
    ["null intent id", { type: "payment_intent", payment_intent: null }],
    ["numeric intent id", { type: "payment_intent", payment_intent: 73 }],
    ["empty intent id", { type: "payment_intent", payment_intent: "" }],
    ["an unexpected expanded intent", { type: "payment_intent", payment_intent: { id: "pi_sharedintent01" } }],
    ["unknown payment type", { type: "a_future_type" }],
    ["unidentified charge", { type: "charge" }],
    ["unidentified payment record", { type: "payment_record" }],
  ];
  const scoped = { ...pay("inpay_scoped", "in_renew_new", "pi_sharedintent01"), invoice: renewal };
  filteredReply = { object: "list", data: [scoped], has_more: true };
  for (const [label, payment] of unidentified) {
    invoicePayments = [pay("inpay_1", "in_renew_new", "pi_sharedintent01"), { ...pay("inpay_unknown", "in_other_invoice", "pi_sharedintent01"), payment }];
    is(`${label}: the bulk row cannot prove which intent it paid, and the individual lookup is incomplete`, usd((await readSales(store, NOW))!)?.keptCents, null);
  }
  filteredReply = { object: "list", data: [scoped], has_more: false };
  is("a whole scoped lookup may still prove the intent's only allocation: $40 kept", usd((await readSales(store, NOW))!)?.keptCents, 4000);
  filteredReply = null;
  for (const payment of [{ type: "charge", charge: "ch_OtherPayment01" }, { type: "payment_record", payment_record: "pyr_OtherPayment01" }]) {
    invoicePayments = [pay("inpay_1", "in_renew_new", "pi_sharedintent01"), { ...pay("inpay_other", "in_other_invoice", "pi_sharedintent01"), payment }];
    is(`an identified ${payment.type} is not another allocation of this intent`, usd((await readSales(store, NOW))!)?.keptCents, 4000);
  }

  part("An unreadable invoice on another payment does not taint this payment");
  invoicePayments = [pay("inpay_1", "in_renew_new", "pi_sharedintent01"), { ...pay("inpay_2", "in_unreadable", "pi_other00001"), invoice: null }];
  is("unreadable invoice on another payment: $40 kept, known", usd((await readSales(store, NOW))!)?.keptCents, 4000);

  part("Checkout: the membership's first invoice shares its payment with another invoice");
  invoices = [];
  sessions = [{ id: "cs_test_member0000001", mode: "subscription", status: "complete", payment_status: "paid", amount_total: 5000, currency: "usd",
    created: NOW / 1000 - 3600, payment_intent: null, invoice: "in_first_member", customer_details: { email: "member@example.com" },
    metadata: { store: "cashflow", product: "club", channel: "instagram" } }];
  invoicePayments = [pay("inpay_3", "in_first_member", "pi_firstmember001"), pay("inpay_4", "in_payment_link_y", "pi_firstmember001")];
  refunds = [refund("pi_firstmember001", 1000)];
  is("checkout: a refund of a payment that also paid another invoice: kept unknown", usd((await readSales(store, NOW))!)?.keptCents ?? null, null);
  // Codex X5 again: a subscription checkout that names the payment is attributed to its channel, not proven the store's.
  sessions = [{ ...(sessions[0] as Record<string, unknown>), payment_intent: "pi_firstmember001" }];
  const namedCheckout = usd((await readSales(store, NOW))!);
  is("the same allocation is unknown when the checkout names the intent", [namedCheckout?.keptCents, namedCheckout?.missing], [null, ["refunds"]]);
  invoicePayments = [pay("inpay_3", "in_first_member", "pi_firstmember001")];
  const confirmedCheckout = (await readSales(store, NOW))!;
  is("valid checkout attribution stays on the original channel", [usd(confirmedCheckout)?.keptCents, confirmedCheckout.keptIn?.d7.byChannel], [4000, [{ source: "instagram", keptCents: 4000 }]]);

  part("The bulk read cut short: its other invoices may be among those not read");
  sessions = [];
  invoices = [renewal];
  invoicePayments = [pay("inpay_1", "in_renew_new", "pi_sharedintent01")];
  refunds = [refund("pi_sharedintent01", 1000)];
  endless = true;
  page = 0;
  is("a partial bulk read confirms nothing; the lookup that says more confirms nothing either: kept unknown", usd((await readSales(store, NOW))!)?.keptCents ?? null, null);
  endless = false;
  is("read whole again: $40 kept, known", usd((await readSales(store, NOW))!)?.keptCents, 4000);

  // Codex N1 on #4549 (MEDIUM, money, lot 61): the bulk read lists only allocations since the window's start, so a
  // payment that also paid another invoice before it looked as if it paid only the store's, read whole, and was
  // confirmed. Only the lookup by the payment itself, which lists every allocation, may prove it is the store's alone.
  part("The same payment also paid another invoice before the bulk read's window");
  olderPayments = [pay("inpay_old", "in_other_old", "pi_sharedintent01")];
  const older = usd((await readSales(store, NOW))!);
  is("a refund of a payment that also paid an older invoice: kept unknown", [older?.keptCents ?? null, older?.missing], [null, ["refunds"]]);
  olderPayments = [];
  is("control, no older allocation: the lookup proves it, $40 kept", usd((await readSales(store, NOW))!)?.keptCents, 4000);
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
