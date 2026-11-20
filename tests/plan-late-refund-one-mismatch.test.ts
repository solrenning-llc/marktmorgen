/**
 * Claude 3's LOW on #4867: one late invoice whose charge does not prove its paid amount (or currency) must not hold
 * back the plan's other late refunds. The mismatched one stays owed (the plan is tried again), nothing is refunded on
 * it, and every invoice that does read is still given back. Synthetic only: an in-memory Stripe.
 */
import { refundLatePayments } from "@/lib/plan-late-refunds";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_late_one_mismatch";
const subscription = "sub_lateMismatch01";
type Row = { id: string; paid: number; charged: number; currency: string; chargeCurrency: string };
let rows: Row[] = [];
const posted: { intent: string; amount: number }[] = [];
const intentOf = (id: string) => `pi_${id.slice(3)}`;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  if (url.hostname !== "api.stripe.com") throw new Error("unexpected synthetic host");
  if (path === "/invoices") {
    return Response.json({
      object: "list",
      has_more: false,
      data: rows.map((r) => ({
        id: r.id, object: "invoice", subscription, status: "paid", created: 200, amount_paid: r.paid, paid_out_of_band: false, currency: r.currency,
        charge: {
          id: `ch_${r.id.slice(3)}`, object: "charge", payment_intent: intentOf(r.id), invoice: null, amount: r.charged, amount_refunded: 0, disputed: false,
          currency: r.chargeCurrency, balance_transaction: { amount: r.charged, currency: r.chargeCurrency }, refunds: { object: "list", data: [], has_more: false },
        },
      })),
    });
  }
  if (path === "/balance") return Response.json({ object: "balance", available: [{ amount: 1_000_000, currency: "usd" }, { amount: 1_000_000, currency: "eur" }] });
  if (path === "/refunds" && init?.method === "POST") {
    const body = new URLSearchParams(String(init.body));
    const intent = String(body.get("payment_intent"));
    const amount = Number(body.get("amount"));
    posted.push({ intent, amount });
    const invoice = String(body.get("metadata[plan_late_refund]"));
    return Response.json({ id: `re_${intent.slice(3)}`, object: "refund", payment_intent: intent, amount, currency: rows.find((r) => intentOf(r.id) === intent)?.chargeCurrency, status: "succeeded", metadata: { plan_late_refund: invoice } });
  }
  if (path === "/refunds") return Response.json({ object: "list", has_more: false, data: [] });
  throw new Error(`unexpected synthetic path ${path}`);
}) as typeof fetch;

async function main(): Promise<void> {
  const good: Row = { id: "in_lateGood00001", paid: 5000, charged: 5000, currency: "usd", chargeCurrency: "usd" };
  for (const [label, bad] of [
    ["a paid amount the charge does not prove", { id: "in_lateBad000001", paid: 1000, charged: 5000, currency: "usd", chargeCurrency: "usd" }],
    ["a currency the charge does not prove", { id: "in_lateBad000002", paid: 5000, charged: 5000, currency: "usd", chargeCurrency: "eur" }],
  ] as const) {
    for (const order of ["mismatched first", "mismatched last"]) {
      part(`${label}, ${order}`);
      rows = order === "mismatched first" ? [bad, good] : [good, bad];
      posted.length = 0;
      const outcome = await refundLatePayments("acct_lateMismatch", subscription, 100).catch(() => null);
      is("the plan's try still answers", outcome !== null, true);
      is("the matching invoice is given back in full", posted, [{ intent: intentOf(good.id), amount: 5000 }]);
      is("nothing is refunded on the mismatched one", posted.some((p) => p.intent === intentOf(bad.id)), false);
      is("the plan stays owed, so it is tried again", outcome?.state, "owed");
      is("the buyer of the matching invoice is told", outcome?.given.map((g) => g.invoice), [good.id]);
      is("the mismatched one is not put on the creator's list of refunds to make", outcome?.short, []);
    }
  }
  done();
}

void main();
