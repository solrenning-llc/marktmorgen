/**
 * The studio's recent orders (lib/store-checkout.ts, listSales), read like the
 * numbers (lib/stats.ts, readPaidSales) and the API (lib/api-sales.ts) read
 * a store's sales (CX-123 rule 24 siblings; VR 2):
 *
 * 1. Only completed checkouts are asked for (status=complete): the list is one
 *    page of ORDERS_PAGE_SIZE rows, so a store's open and expired checkouts
 *    (a buyer who left the card form) used to fill it, and the studio said "No
 *    orders are available in this recent view", kept its "Buy it once
 *    yourself" step undone and listed no latest buyers while recent paid
 *    orders were on Stripe.
 * 2. A checkout that only saved a card (setup mode, lib/card-update.ts) is
 *    complete and owes nothing: it is no order, as the API already reads it
 *    (isSale), never "A product that is no longer listed" at $0.
 *
 * Synthetic store and a stand-in for Stripe only.
 */
import { done, is, part } from "./check";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

const NOW = Math.floor(Date.now() / 1000);
type Session = Record<string, unknown> & { id: string; created: number; status: string };

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_sales_reads_siblings_only";
  process.env.STRIPE_CONNECT_API_BASE = "http://127.0.0.1:4998";
  let sessions: Session[] = [];
  const asked: URL[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.origin !== "http://127.0.0.1:4998" || (init?.method ?? "GET") !== "GET") throw new Error("Only synthetic order reads are allowed");
    if (url.pathname === "/v1/checkout/sessions") {
      asked.push(url);
      // As Stripe lists them: newest first, `status` honoured when sent, at most `limit`.
      const limit = Math.min(100, Number(url.searchParams.get("limit") ?? 10));
      const status = url.searchParams.get("status");
      const rows = [...sessions].sort((a, b) => b.created - a.created).filter((row) => !status || row.status === status);
      return Response.json({ object: "list", data: rows.slice(0, limit), has_more: rows.length > limit });
    }
    if (url.pathname === "/v1/payment_intents") return Response.json({ object: "list", data: [], has_more: false });
    throw new Error(`Unexpected synthetic endpoint ${url.pathname}`);
  }) as typeof fetch;

  redis.clear();
  const { claimHandle, setStripeAccount, setSubscription, storeForEmail } = await import("@/lib/store");
  const { listSales, ORDERS_PAGE_SIZE } = await import("@/lib/store-checkout");
  const email = "sales-siblings@example.test";
  await claimHandle(email, "salessiblings", "Sales siblings proof", "");
  await setStripeAccount(email, "acct_fixture0sib", true);
  await setSubscription(email, { customerId: "cus_SalesSiblings1", subscriptionId: "sub_SalesSiblings1", active: true, period: paidPeriod() });
  const store = (await storeForEmail(email))!;

  part("The recent orders ask Stripe only for completed checkouts, so open and expired ones do not fill the page");
  const left = (i: number): Session => ({
    id: `cs_test_left_${String(i).padStart(3, "0")}`, object: "checkout.session", status: i % 2 ? "open" : "expired", payment_status: "unpaid", mode: "payment",
    created: NOW - 10 - i, amount_total: 1200, currency: "usd", metadata: { store: store.handle, product: "guide", title: "Guide" }, customer_details: null,
  });
  const paid: Session = {
    id: "cs_test_paid_behind", object: "checkout.session", status: "complete", payment_status: "paid", mode: "payment",
    created: NOW - 5000, amount_total: 1200, currency: "usd", metadata: { store: store.handle, product: "guide", title: "Guide" }, customer_details: { email: "buyer.one@example.test" },
  };
  sessions = [...Array.from({ length: ORDERS_PAGE_SIZE * 2 }, (_, i) => left(i)), paid];
  asked.length = 0;
  const read = await listSales(store);
  is("one list request, asking for completed checkouts only", [asked.length, asked.map((u) => u.searchParams.get("status"))], [1, ["complete"]]);
  is("the paid order behind fifty checkouts left unfinished is listed", read.state === "ok" ? read.sales.map((s) => s.reference) : read.state, ["cs_test_paid_behind"]);

  part("A checkout that only saved a card is no order");
  const card: Session = {
    id: "cs_test_card_saved", object: "checkout.session", status: "complete", payment_status: "no_payment_required", mode: "setup",
    created: NOW - 20, amount_total: null, currency: null, metadata: { store: store.handle, kind: "card", subscription: "sub_member1" }, customer_details: { email: "member@example.test" },
  };
  sessions = [card, paid];
  const withCard = await listSales(store);
  is("the card update is not listed; the paid order is", withCard.state === "ok" ? withCard.sales.map((s) => s.reference) : withCard.state, ["cs_test_paid_behind"]);
  const free: Session = { ...paid, id: "cs_test_free_claim", payment_status: "no_payment_required", amount_total: 0, created: NOW - 30 };
  sessions = [card, free, paid];
  const withFree = await listSales(store);
  is("a completed payment checkout that owed nothing (a 100% code) is still an order", withFree.state === "ok" ? withFree.sales.map((s) => s.reference) : withFree.state, ["cs_test_free_claim", "cs_test_paid_behind"]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
