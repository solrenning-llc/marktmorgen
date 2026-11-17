/**
 * Every answer the PayPal sweep can get about a pending order, overdue or not (the merge of main into #3924, at the
 * coordinator's request): watchPayPal keeps main's handling (VOIDED let go, a capture status that is not text asked
 * again, COMPLETED and PARTIALLY_REFUNDED paid) and this PR's cancellation once overdue (PENDING_GIVE_UP_SECONDS), only
 * on PayPal's readable word that nothing was taken (no capture, an Orders status in NOT_CHARGED) or that the payment is
 * still pending. A paid capture, one taken back, one in a status not known here and one not read as text are never
 * canceled, overdue or not.
 *
 * Synthetic only: a PayPal stand-in, the Redis stub; the cancellation's notices are a stand-in that says "sent".
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { addProduct, claimHandle, ensureStatsId, setPayPalSeller, setProductLink, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { openOrder, readPaid, stillPending, watchPayPal } from "@/lib/paypal-sales";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const SELLER = "7KNGBPH2U58GQ";
const orders = new Map<string, Record<string, unknown>>();
let made = 0;
const orderId = (n: number) => `9T190127TN364${String(n).padStart(4, "0")}`;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname !== "api-m.paypal.com") return json({ error: "unexpected" }, 404);
  const method = init?.method ?? "GET";
  if (url.pathname === "/v1/oauth2/token") return json({ access_token: "A21AApartner", token_type: "Bearer", expires_in: 32400 });
  if (url.pathname === "/v2/checkout/orders" && method === "POST") {
    made += 1;
    const id = orderId(made);
    return json({ id, status: "PAYER_ACTION_REQUIRED", links: [{ href: `https://www.paypal.com/checkoutnow?token=${id}`, rel: "payer-action" }] });
  }
  const read = /^\/v2\/checkout\/orders\/([A-Z0-9]+)$/.exec(url.pathname)?.[1];
  if (read && method === "GET") return orders.has(read) ? json(orders.get(read)) : json({ name: "RESOURCE_NOT_FOUND" }, 404);
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;

type Case = { what: string; body: (order: string) => Record<string, unknown>; fresh: Outcome; overdue: Outcome };
type Outcome = { kept: boolean; canceled: boolean; paid: boolean };
const KEPT: Outcome = { kept: true, canceled: false, paid: false };
const GONE: Outcome = { kept: false, canceled: false, paid: false };
const CANCELED: Outcome = { kept: false, canceled: true, paid: false };
const PAID: Outcome = { kept: false, canceled: false, paid: true };

const noCapture = (status: unknown) => (order: string) => ({ id: order, ...(status === undefined ? {} : { status }) });
const withCapture = (status: unknown) => (order: string) => ({
  id: order,
  status: "COMPLETED",
  payer: { email_address: "buyer@example.com" },
  purchase_units: [{ payee: { merchant_id: SELLER }, payments: { captures: [{ id: `5C679366HH90${order.slice(-4)}`, status, amount: { currency_code: "USD", value: "49.00" } }] } }],
});

const CASES: Case[] = [
  { what: "no capture, VOIDED", body: noCapture("VOIDED"), fresh: GONE, overdue: GONE },
  ...["CREATED", "SAVED", "APPROVED", "PAYER_ACTION_REQUIRED"].map((s): Case => ({ what: `no capture, ${s}`, body: noCapture(s), fresh: KEPT, overdue: CANCELED })),
  { what: "no capture, COMPLETED without its captures", body: noCapture("COMPLETED"), fresh: KEPT, overdue: KEPT },
  { what: "no capture, a status not known here", body: noCapture("MYSTERY"), fresh: KEPT, overdue: KEPT },
  { what: "no capture, no status", body: noCapture(undefined), fresh: KEPT, overdue: KEPT },
  { what: "capture PENDING", body: withCapture("PENDING"), fresh: KEPT, overdue: CANCELED },
  { what: "capture COMPLETED", body: withCapture("COMPLETED"), fresh: PAID, overdue: PAID },
  { what: "capture PARTIALLY_REFUNDED", body: withCapture("PARTIALLY_REFUNDED"), fresh: PAID, overdue: PAID },
  ...["REFUNDED", "REVERSED", "FAILED", "DECLINED"].map((s): Case => ({ what: `capture ${s}`, body: withCapture(s), fresh: GONE, overdue: GONE })),
  { what: "capture in a status not known here", body: withCapture("MYSTERY"), fresh: KEPT, overdue: KEPT },
  { what: "capture status not text", body: withCapture(7), fresh: KEPT, overdue: KEPT },
];

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  delete process.env.PAYPAL_ENV;
  process.env.STRIPE_SECRET_KEY = "sk_test_synthetic_only";
  process.env.PAYPAL_PARTNER_CLIENT_ID = "AZpartnerClientId0123456789";
  process.env.PAYPAL_PARTNER_SECRET = "EPpartnerSecret0123456789";
  process.env.PAYPAL_PARTNER_MERCHANT_ID = "PARTNERMERCH01";
  process.env.PAYPAL_BN_CODE = "NimbusLabs_SP";

  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await setSubscription("owner@example.com", { customerId: "cus_Owner00003", subscriptionId: "sub_Owner00003", active: true, period: paidPeriod() });
  const added = await addProduct("owner@example.com", "Sourdough Guide", "", "49", null);
  if (!added.ok) throw new Error("no product");
  await setProductLink("owner@example.com", added.product.id, "https://example.com/guide");
  await setPayPalSeller("owner@example.com", SELLER);
  const store = (await storeForEmail("owner@example.com"))!;
  const product = (await readListing(store, added.product.id))!;
  const on = { handOver: async () => undefined, dropStart: async () => undefined, canceled: async () => ({ buyer: "sent", creator: "sent" }) as const };

  for (const overdue of [false, true]) {
    part(overdue ? "Overdue: opened more than PENDING_GIVE_UP_SECONDS ago" : "Not overdue: opened just now");
    for (const c of CASES) {
      const opened = await openOrder(store, product, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
      if (!opened.ok) throw new Error(`no order: ${opened.reason}`);
      const order = opened.order;
      const key = `nl:ppsell:o:${order}`;
      const [raw] = await redis.pipeline([["GET", key]]);
      const record = JSON.parse(String(raw)) as { at: number; s: string };
      if (overdue) record.at = Math.floor(Date.now() / 1000) - 30 * 86_400;
      await redis.pipeline([["SET", key, JSON.stringify(record), "EX", 86_400], ["ZADD", `nl:ppsell:pending:${record.s}`, "1", order]]);
      orders.set(order, c.body(order));
      await watchPayPal(store, Date.now() + 20_000, on);
      const [canceledMark] = await redis.pipeline([["GET", `nl:ppsell:canceled:${order}`]]);
      const got: Outcome = { kept: await stillPending(store, order), canceled: canceledMark !== null, paid: (await readPaid(order)) !== null };
      is(`${c.what}`, got, overdue ? c.overdue : c.fresh);
      await redis.pipeline([["ZREM", `nl:ppsell:pending:${record.s}`, order]]);
    }
  }
  done();
}

main().catch((error) => {
  console.log("✗ crashed:", error);
  process.exit(1);
});
