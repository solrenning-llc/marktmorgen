// A refund or a dispute of a store renewal is put under the renewal's channel,
// found by the payment the renewal's invoice names, not under "unrecorded": the
// channel shows what it kept, and the cash-flow reading stays complete
// (issue #4375, Codex X8-2322). A refund that names no payment read stays
// unrecorded, as before.
import { readSales } from "@/lib/stats";
import { claimHandle, ensureStatsId, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_cashflow_stand_in";
const NOW = Date.parse("2026-10-13T12:00:00Z");
let invoices: unknown[] = [];
let refunds: unknown[] = [];
let disputes: unknown[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const list = (data: unknown[]) => new Response(JSON.stringify({ object: "list", data, has_more: false }), { status: 200 });
  if (url.pathname.endsWith("/invoices")) return list(url.searchParams.get("status") === "paid" ? invoices : []);
  if (url.pathname.endsWith("/refunds")) return list(refunds);
  if (url.pathname.endsWith("/disputes")) return list(disputes);
  return list([]);
}) as typeof fetch;
const refund = (pi: string, cents: number) => ({ id: `re_${pi}`, object: "refund", status: "succeeded", amount: cents, currency: "usd", created: NOW / 1000, payment_intent: pi });
const renewal = (paid: Record<string, unknown>) => ({
  id: "in_renew_1", object: "invoice", status: "paid", billing_reason: "subscription_cycle", amount_paid: 5000, currency: "usd",
  created: NOW / 1000 - 3600, subscription_details: { metadata: { store: "cashflow", product: "club", channel: "newsletter" } }, ...paid,
});

type Read = NonNullable<Awaited<ReturnType<typeof readSales>>>;
const usd = (r: Read) => r.keptIn?.d7.lines.find((row) => row.currency === "usd");

async function main() {
  redis.clear();
  const owner = "cashflow-owner@example.com";
  await claimHandle(owner, "cashflow", "Cashflow", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_TestCashflow001", true);
  const store = (await storeForEmail(owner))!;

  for (const [label, paid] of [
    ["the invoice names its payment", { payment_intent: "pi_renewal" }],
    ["the invoice lists its paid payment", { payments: { data: [{ status: "paid", payment: { payment_intent: "pi_renewal" } }] } }],
  ] as const) {
    part(`A refund of a store renewal, ${label}`);
    invoices = [renewal(paid)];
    refunds = [refund("pi_renewal", 1000)];
    disputes = [];
    const read = (await readSales(store, NOW))!;
    is("the refund is attributed to newsletter", read.refundsIn?.d7, [{ source: "newsletter", refunds: 1, cents: 1000 }]);
    is("the cash-flow reading stays complete", read.cashflowComplete, true);
    is("newsletter keeps $40", read.keptIn?.d7.byChannel, [{ source: "newsletter", keptCents: 4000 }]);
  }

  part("A lost dispute of a store renewal");
  invoices = [renewal({ payment_intent: "pi_renewal" })];
  refunds = [];
  disputes = [{ id: "dp_r", object: "dispute", status: "lost", amount: 5000, currency: "usd", created: NOW / 1000, payment_intent: "pi_renewal" }];
  const disputed = (await readSales(store, NOW))!;
  is("the dispute is attributed to newsletter", disputed.disputesIn?.d7.map((d) => d.source), ["newsletter"]);

  part("Control: a refund naming no payment read stays unrecorded");
  invoices = [renewal({ payment_intent: "pi_renewal" })];
  refunds = [refund("pi_somewhere_else", 1000)];
  disputes = [];
  const other = (await readSales(store, NOW))!;
  is("unrecorded", other.refundsIn?.d7.map((r) => r.source), ["unrecorded"]);
  is("$50 kept on newsletter, the refund apart", usd(other)?.refundCents, 1000);
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
