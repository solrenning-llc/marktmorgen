/**
 * payWithPayPal (lib/paypal-payouts.ts) holds the store's payout lock 120 s, taken once, and reads the commission book
 * from Stripe inside it with no deadline. When that read outlasts the lock, a second press (or payday) can take the
 * lock, read the same book and both mark their batch on its way and send it: every affiliate paid twice, from the
 * creator's PayPal. Now the lock is held again, only while still this press's own, just before the batch is marked
 * on its way; a lock already taken by another sends nothing. Found by Claude 3 (nuvem E)'s money audit, 13/11/2026.
 * Synthetic: stand-ins for PayPal and Stripe.
 */
import { connectPayPal, onTheirWay, payWithPayPal } from "@/lib/paypal-payouts";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const STATS = "statsid1";
const CLIENT = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const SECRET = "EFGHijklMNOPqrstUVWXyz0123456789abcd";
const scope = "https://uri.paypal.com/services/invoicing https://uri.paypal.com/payments/payouts openid";
const tokenStatus = 200;
const funds = true;
const itemStatus: Record<string, string> = {};
const created: { body: Record<string, unknown>; requestId: string | null }[] = [];
let stealOnStripe = false;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.stripe.com") {
    // The book is read slowly: past the lock's term, another press takes the lock (as it would after expiry).
    if (stealOnStripe) await redis.pipeline([["SET", `nl:pp:${STATS}:lock`, "a-later-press", "EX", 120]]);
    return json({ object: "list", data: [], has_more: false });
  }
  if (url.hostname !== "api-m.paypal.com") return json({ error: "unexpected" }, 404);
  const headers = new Headers(init?.headers);
  if (url.pathname === "/v1/oauth2/token") {
    if (tokenStatus !== 200) return json({ error: "invalid_client" }, tokenStatus);
    const basic = Buffer.from(`${CLIENT}:${SECRET}`).toString("base64");
    if (headers.get("authorization") !== `Basic ${basic}`) return json({ error: "invalid_client" }, 401);
    return json({ access_token: "A21AAtoken", token_type: "Bearer", scope, expires_in: 32400 });
  }
  if (headers.get("authorization") !== "Bearer A21AAtoken") return json({ name: "AUTHENTICATION_FAILURE" }, 401);
  if (url.pathname === "/v1/payments/payouts" && init?.method === "POST") {
    if (!funds) return json({ name: "INSUFFICIENT_FUNDS", message: "Sender does not have sufficient funds." }, 422);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    created.push({ body, requestId: headers.get("paypal-request-id") });
    return json({ batch_header: { payout_batch_id: `BATCH${created.length}ABC`, batch_status: "PENDING", sender_batch_header: body.sender_batch_header } }, 201);
  }
  const batch = /^\/v1\/payments\/payouts\/(BATCH\d+ABC)$/.exec(url.pathname)?.[1];
  if (batch) {
    const sent = created[Number(batch.slice(5, -3)) - 1].body.items as { sender_item_id: string; amount: unknown; receiver: string }[];
    return json({
      batch_header: { payout_batch_id: batch, batch_status: "SUCCESS" },
      total_pages: 1,
      items: sent.map((item, i) => ({
        payout_item_id: `ITEM${batch}${i}`,
        payout_batch_id: batch,
        transaction_status: itemStatus[item.sender_item_id] ?? "PENDING",
        payout_item: { sender_item_id: item.sender_item_id, amount: item.amount, receiver: item.receiver },
      })),
    });
  }
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;

function shop(): Store {
  return {
    sid: "sidharbor01",
    handle: "harbor",
    name: "Harbor Kitchen",
    previousHandles: [],
    releasedHandles: [],
    statsId: STATS,
    stripeAccountId: "acct_1TestHarbor0001",
    currency: "usd",
    affiliates: { enabled: true, percent: 30, days: 30, rates: {}, payday: 5, hold: 0 },
  } as unknown as Store;
}

async function seed(): Promise<void> {
  redis.clear();
  const at = Math.floor(Date.now() / 1000) - 86_400;
  const person = (id: string, email: string, code: string) =>
    JSON.stringify({ id, email, code, status: "approved", appliedAt: 1, decidedAt: 2, note: "" });
  const sale = (ref: string, aff: string, base: number) =>
    JSON.stringify({ ref, pi: `pi_${ref}`, aff, at, product: "p1", title: "Guide", base, total: base, currency: "usd", rate: 30, self: false });
  await redis.pipeline([
    ["HSET", `nl:aff:${STATS}:people`, "aaaaaaaaaaaa", person("aaaaaaaaaaaa", "sara@example.com", "sara")],
    ["HSET", `nl:aff:${STATS}:people`, "bbbbbbbbbbbb", person("bbbbbbbbbbbb", "tom@example.com", "tom")],
    ["HSET", `nl:aff:${STATS}:sales`, "cs_1", sale("cs_1", "aaaaaaaaaaaa", 10000)],
    ["HSET", `nl:aff:${STATS}:sales`, "cs_2", sale("cs_2", "bbbbbbbbbbbb", 5000)],
  ]);
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_paypal_payouts_lock_only";
  await seed();
  const store = shop();
  is("connected", (await connectPayPal(store, CLIENT, SECRET)).ok, true);

  part("The lock runs out while the book is read, and a later press takes it");
  stealOnStripe = true;
  const late = await payWithPayPal(store);
  stealOnStripe = false;
  is("nothing is sent by the press whose lock ran out", [late.ok ? "sent" : "not sent", created.length], ["not sent", 0]);
  is("nobody is marked on their way by it", (await onTheirWay(store)).size, 0);
  is("the later press's lock is left alone", (await redis.pipeline([["GET", `nl:pp:${STATS}:lock`]]))[0], "a-later-press");

  part("Control: a press that keeps its lock sends once");
  await redis.pipeline([["DEL", `nl:pp:${STATS}:lock`]]);
  const sent = await payWithPayPal(store);
  is("sent once", [sent.ok, created.length], [true, 1]);
  done();
}

void main();
