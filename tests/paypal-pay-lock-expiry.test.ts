/**
 * The PayPal pay lock still held when a batch is written down as on its way (#4606's sibling, #4618).
 *
 * payWithPayPal took nl:pp:<statsId>:lock for 120 s, read the book and what is on its way, then asked PayPal for a
 * token, and only then wrote the batch's "?" entry. Nothing checked the lock was still held. When the book read or
 * the token took longer than the lock (a large Stripe account, a slow PayPal, a route with no maxDuration), a second
 * press or the payday cron took the lock, found nobody on their way, and sent the same people; the first run then
 * sent them too, under another sender_batch_id, so PayPal paid each affiliate twice. Synthetic store and PayPal.
 */
import { connectPayPal, payWithPayPal } from "@/lib/paypal-payouts";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { markLive } from "./live-store";
import { done, is, part } from "./check";

const STATS = "statslockx1";
let gate: Promise<void> | null = null;
let entered = false;
const CLIENT = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const SECRET = "EFGHijklMNOPqrstUVWXyz0123456789abcd";
let itemStatus: Record<string, string> = {};
const created: { body: Record<string, unknown> }[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.stripe.com") return json({ object: "list", data: [], has_more: false });
  if (url.hostname !== "api-m.paypal.com") return json({ error: "unexpected" }, 404);
  const headers = new Headers(init?.headers);
  if (url.pathname === "/v1/oauth2/token") {
    // The test holds this answer back while it lets the pay lock run out.
    if (gate) {
      entered = true;
      await gate;
    }
    const basic = Buffer.from(`${CLIENT}:${SECRET}`).toString("base64");
    if (headers.get("authorization") !== `Basic ${basic}`) return json({ error: "invalid_client" }, 401);
    return json({ access_token: "A21AAtoken", token_type: "Bearer", scope: "https://uri.paypal.com/payments/payouts", expires_in: 32400 });
  }
  if (headers.get("authorization") !== "Bearer A21AAtoken") return json({ name: "AUTHENTICATION_FAILURE" }, 401);
  if (url.pathname === "/v1/payments/payouts" && init?.method === "POST") {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    created.push({ body });
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
    sid: "sidlockexp01",
    handle: "lockharbor",
    name: "Lock Harbor",
    previousHandles: [],
    releasedHandles: [],
    statsId: STATS,
    stripeAccountId: "acct_1TestLockExp01",
    currency: "usd",
    affiliates: { enabled: true, percent: 30, days: 30, rates: {}, payday: 5, hold: 0 },
  } as unknown as Store;
}


const pipeline = redis.pipeline.bind(redis);
const SARA = "aaaaaaaaaaaa";

async function seed(store: Store): Promise<void> {
  redis.clear();
  created.length = 0;
  itemStatus = {};
  const at = Math.floor(Date.now() / 1000) - 86_400;
  await pipeline([
    ["HSET", `nl:aff:${STATS}:people`, SARA, JSON.stringify({ id: SARA, email: "sara@example.com", code: "sara", status: "approved", appliedAt: 1, decidedAt: 2, note: "" })],
    ["HSET", `nl:aff:${STATS}:sales`, "cs_1", JSON.stringify({ ref: "cs_1", pi: "pi_cs_1", aff: SARA, at, product: "p1", title: "Guide", base: 10000, total: 10000, currency: "usd", rate: 30, self: false })],
  ]);
  await markLive(store);
  if (!(await connectPayPal(store, CLIENT, SECRET)).ok) throw new Error("synthetic PayPal app not kept");
}

async function main() {
  process.env.STRIPE_SECRET_KEY = "sk_test_paypal_pay_lock_only";
  const store = shop();

  part("The lock runs out while the first press waits on PayPal's token; a second press pays in the meantime");
  await seed(store);
  let release = () => {};
  gate = new Promise<void>((resolve) => { release = resolve; });
  entered = false;
  const first = payWithPayPal(store);
  for (let i = 0; i < 200 && !entered; i += 1) await new Promise((r) => setTimeout(r, 5));
  is("the first press is waiting on the token", entered, true);
  gate = null;
  // The lock's 120 s have passed: it is gone, as Redis lets it run out.
  await pipeline([["DEL", `nl:pp:${STATS}:lock`]]);
  const second = await payWithPayPal(store);
  is("the second press pays the affiliate", second.ok, true);
  release();
  const late = await first;
  is("the first press sends nothing once it no longer holds the lock or its people are on their way", late.ok, false);
  is("PayPal was asked for one batch, never two", created.length, 1);

  part("Control: one press with the lock held pays once");
  await seed(store);
  gate = null;
  is("paid", (await payWithPayPal(store)).ok, true);
  is("one batch", created.length, 1);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
