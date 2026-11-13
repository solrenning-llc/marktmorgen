/**
 * Defect #4379 (Codex L): a refresh of the buyers' ledger after an erasure leaves the erased buyer out of the ledger
 * and out of its one-hour copy, and a refresh already under way when an erasure finishes never writes the buyer back
 * (lib/segments.ts, buyerLedger). The Stripe stand-in (ana, ben, cy, eve) and shop() are tests/segments.test.ts's
 * own. Synthetic records only.
 */
import { buyerLedger, forgetLedgerCopy } from "@/lib/segments";
import { suppressCommand } from "@/lib/suppression";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const NOW = Date.parse("2026-10-12T12:00:00Z");
const DAY = 86_400;
const now = Math.floor(NOW / 1000);
let stripeCalls = 0;

const session = (id: string, email: string, daysAgo: number, cents: number, meta: Record<string, string> = {}, currency = "usd") => ({
  id: `cs_test_${id.padEnd(12, "0")}`,
  status: "complete",
  payment_status: "paid",
  created: now - daysAgo * DAY,
  amount_total: cents,
  currency,
  customer_details: { email },
  payment_intent: `pi_${id.padEnd(14, "0")}`,
  metadata: { store: "bakery", product: "p1", ...meta },
});

const sessions = [
  session("ana1", "Ana@Example.com", 200, 20000, { channel: "instagram" }),
  session("ana2", "ana@example.com", 10, 5000, { channel: "youtube" }),
  session("ben1", "ben@example.com", 120, 3000, { channel: "tiktok" }),
  session("cy01", "cy@example.com", 5, 9000),
  session("tip1", "dee@example.com", 3, 50000, { kind: "tip" }),
  session("eur1", "eve@example.com", 3, 50000, {}, "eur"),
  session("oth1", "fay@example.com", 3, 50000, { store: "somebody-else" }),
];
const intents = [
  { id: "pi_extra000000001", status: "succeeded", created: now - 120 * DAY, amount: 4000, currency: "usd", receipt_email: "BEN@example.com", metadata: { kind: "upsell", store: "bakery", product: "kit" } },
];

// Renewals, refunds and disputes (270 [GR1], unit 2), filled in by their own part below.
const invoices: Record<string, unknown>[] = [];
const refunds: Record<string, unknown>[] = [];
const disputes: Record<string, unknown>[] = [];
const invoicePayments: Record<string, unknown>[] = [];
const invoicePaymentsFail = false;

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname !== "api.stripe.com") return new Response("{}", { status: 404 });
  stripeCalls += 1;
  if (url.pathname === "/v1/checkout/sessions") return new Response(JSON.stringify({ data: sessions, has_more: false }));
  if (url.pathname === "/v1/payment_intents") return new Response(JSON.stringify({ data: intents, has_more: false }));
  if (url.pathname === "/v1/invoices") return new Response(JSON.stringify({ data: invoices, has_more: false }));
  if (url.pathname === "/v1/refunds") return new Response(JSON.stringify({ data: refunds, has_more: false }));
  if (url.pathname === "/v1/disputes") return new Response(JSON.stringify({ data: disputes, has_more: false }));
  if (url.pathname === "/v1/invoice_payments") return invoicePaymentsFail ? new Response("{}", { status: 500 }) : new Response(JSON.stringify({ data: invoicePayments, has_more: false }));
  return new Response(JSON.stringify({ data: [], has_more: false }));
}) as typeof fetch;

function shop(): Store {
  return {
    sid: "sidbake00001",
    handle: "bakery",
    previousHandles: [],
    releasedHandles: [],
    statsId: "s".repeat(32),
    listId: "list0001",
    currency: "usd",
    stripeAccountId: "acct_test_segments1",
    catalog: { id: null, head: [], items: [{ id: "p1", kind: 0, options: [] }], inline: [{ id: "p1", title: "Bread School", options: [] }] },
  } as unknown as Store;
}



async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_segments_only_a_stand_in";
  const store = shop();
  const cacheHas = async (email: string) => {
    const [kept] = await redis.pipeline([["GET", `nl:stats:${store.statsId}:ledger`]]);
    return typeof kept === "string" && kept.includes(email);
  };

  part("Codex L's reproduction: a ledger refresh after an erasure");
  const warm = await buyerLedger(store);
  is("control: both buyers in the warm ledger", [warm.buyers.has("ana@example.com"), warm.buyers.has("ben@example.com")], [true, true]);
  // Erasure of ana: the suppression print first, then the ledger copy goes (lib/person-erasure.ts).
  await redis.pipeline([suppressCommand(store.listId as string, "ana@example.com")]);
  await forgetLedgerCopy(store.statsId);
  const rebuilt = await buyerLedger(store);
  is("the erased buyer is not in the rebuilt ledger", rebuilt.buyers.has("ana@example.com"), false);
  is("control: the other buyer is still there", rebuilt.buyers.has("ben@example.com"), true);
  is("the erased buyer's address is not written back to the ledger cache", await cacheHas("ana@example.com"), false);
  is("the rebuilt copy is kept for the others", await cacheHas("ben@example.com"), true);
  const asked = stripeCalls;
  const again = await buyerLedger(store);
  is("read from the copy: still without the erased buyer", [again.buyers.has("ana@example.com"), again.buyers.has("ben@example.com")], [false, true]);
  is("and the copy is used: Stripe is not asked again", stripeCalls, asked);

  part("A refresh already under way when an erasure finishes never writes the buyer back");
  await forgetLedgerCopy(store.statsId);
  // ben is erased between the refresh's look-up of the deleted people and its write of the copy.
  const original = redis.pipeline.bind(redis);
  let erasedMidway = false;
  (redis as unknown as { pipeline: unknown }).pipeline = async (batch: (string | number)[][]) => {
    if (!erasedMidway && batch.some((c) => c[0] === "EVAL" || c[0] === "SET")) {
      erasedMidway = true;
      await original([suppressCommand(store.listId as string, "ben@example.com")]);
      await original([["DEL", `nl:stats:${store.statsId}:ledger`]]);
    }
    return original(batch);
  };
  let racing;
  try {
    racing = await buyerLedger(store);
  } finally {
    (redis as unknown as { pipeline: unknown }).pipeline = original;
  }
  is("the erasure did happen mid-refresh", erasedMidway, true);
  is("the buyer erased mid-refresh is not written into the copy", await cacheHas("ben@example.com"), false);
  is("nor shown by that refresh", racing.buyers.has("ben@example.com"), false);
  done();
}

void main();
