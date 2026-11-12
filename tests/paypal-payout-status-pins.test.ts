/**
 * What each PayPal payout status does to an affiliate's commission (lib/paypal-payouts.ts settlePayPal), pinned one by
 * one: only SUCCESS writes the payout into the book, once; FAILED, RETURNED, BLOCKED, REFUNDED and REVERSED, and a
 * batch PayPal DENIED or CANCELED, give the commission back to owed so it can be paid again; PENDING, UNCLAIMED,
 * ONHOLD and any status this code does not know keep it on its way, never paid twice and never written as paid.
 * tests/paypal-payouts.test.ts pinned SUCCESS, UNCLAIMED and RETURNED; the rest were unpinned. A wrong entry either
 * pays an affiliate twice (a paid status read as not paid) or never (a failure read as paid). Same stand-in for
 * PayPal's API as tests/paypal-payouts.test.ts; synthetic data only.
 */
import { connectPayPal, onTheirWay, payWithPayPal, settlePayPal } from "@/lib/paypal-payouts";
import { readBook } from "@/lib/affiliates";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const STATS = "statsid1";
const CLIENT = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const SECRET = "EFGHijklMNOPqrstUVWXyz0123456789abcd";
let scope = "https://uri.paypal.com/services/invoicing https://uri.paypal.com/payments/payouts openid";
let tokenStatus = 200;
let funds = true;
let itemStatus: Record<string, string> = {};
let batchStatus = "SUCCESS";
const created: { body: Record<string, unknown>; requestId: string | null }[] = [];
let fetches = 0;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  fetches += 1;
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.stripe.com") return json({ data: [], has_more: false });
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
      batch_header: { payout_batch_id: batch, batch_status: batchStatus },
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

const owed = async (store: Store) => new Map((await readBook(store)).rows.map((r) => [r.affiliate.email, [r.paid, r.payable]] as const).sort((a, b) => a[0].localeCompare(b[0])));

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_paypal_payouts_only";
  process.env.RESEND_API_KEY = "re_test_only";
  const store = shop();
  // One batch of two: Sara (30.00) and Tom (15.00). Sara's item takes `status`; Tom's stays PENDING throughout.
  const sendOne = async (status: string, batch = "SUCCESS") => {
    await seed();
    created.length = 0;
    itemStatus = {};
    batchStatus = "SUCCESS";
    if (!(await connectPayPal(store, CLIENT, SECRET)).ok) throw new Error("not connected");
    const paid = await payWithPayPal(store);
    if (!paid.ok) throw new Error(`not sent: ${paid.reason}`);
    itemStatus = { aaaaaaaaaaaa: status };
    batchStatus = batch;
    const settled = await settlePayPal(store);
    const sara = (await owed(store)).get("sara@example.com");
    const onTheWay = (await onTheirWay(store)).has("aaaaaaaaaaaa");
    const again = await payWithPayPal(store);
    return { settled, sara, onTheWay, payAgain: again.ok ? again.cents : again.reason };
  };

  part("Paid: written into the book once, never sent again");
  is("SUCCESS", await sendOne("SUCCESS"), { settled: { paid: 1, released: 0, waiting: 1 }, sara: [3000, 0], onTheWay: false, payAgain: "nothing" });

  part("Not paid: back to owed, and paid again on the next press");
  for (const status of ["FAILED", "RETURNED", "BLOCKED", "REFUNDED", "REVERSED"]) {
    is(status, await sendOne(status), { settled: { paid: 0, released: 1, waiting: 1 }, sara: [0, 3000], onTheWay: false, payAgain: 3000 });
  }
  for (const batch of ["DENIED", "CANCELED"]) {
    is(`a batch ${batch}, even with an item read as SUCCESS: nothing paid, both back to owed`, await sendOne("SUCCESS", batch), { settled: { paid: 0, released: 2, waiting: 0 }, sara: [0, 3000], onTheWay: false, payAgain: 4500 });
  }

  part("Not known yet: kept on its way, never written as paid, never sent twice");
  for (const status of ["PENDING", "UNCLAIMED", "ONHOLD", "NEW", "success", ""]) {
    is(status === "" ? "an empty status" : status, await sendOne(status), { settled: { paid: 0, released: 0, waiting: 2 }, sara: [0, 3000], onTheWay: true, payAgain: "nothing" });
  }
  done();
}

void main();
