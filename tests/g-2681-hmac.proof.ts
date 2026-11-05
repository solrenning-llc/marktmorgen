/**
 * Settling a PayPal payout batch whose first answer was not known (decision
 * of Claude 1, C1-20261105-1830-C5-1, option A). The daily settling sends
 * the SAME request again: the same sender_batch_id and the same
 * PayPal-Request-Id. PayPal's own pages, as found on 05/11/2026: the same
 * PayPal-Request-Id gets back the latest state of the batch the first
 * request made; a sender_batch_id used in the last 30 days is refused
 * (400 USER_BUSINESS_ERROR) with a link to the original batch. So:
 *
 *   - the answer was lost after PayPal made it: the retry gets that batch
 *     back; one payment;
 *   - the first request never reached PayPal: the retry makes it, once;
 *   - PayPal says the batch already exists: it is taken as sent, its id
 *     kept when the answer gives it, never paid again; without an id it
 *     needs a manual check;
 *   - any other answer: still on its way, never sent with a new key;
 *   - at most one try a day; after 7 days it needs a manual check and is
 *     not tried again;
 *   - counted by month for the owner's report, with no store or person.
 *
 * Synthetic only: a stand-in for PayPal that keeps idempotency keys and
 * sender_batch_ids as PayPal says it does.
 */
import { createHash, createHmac } from "node:crypto";
import { connectPayPal, onTheirWay, payWithPayPal, settlePayPal } from "@/lib/paypal-payouts";
import { readBook } from "@/lib/affiliates";
import { deriveKey } from "@/lib/secret-box";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";

const STATS = "statsrec01";
const OPEN = `nl:pp:open:${STATS}`;
const CLIENT = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const SECRET = "EFGHijklMNOPqrstUVWXyz0123456789abcd";

/** What the stand-in does with the next POST. */
type Next = "make" | "make-then-drop" | "drop-before" | "server" | "garbled" | "forget-key";
let next: Next = "make";
/** Whether a duplicate sender_batch_id's refusal carries the link to the original batch. */
let duplicateLink = true;
const byKey = new Map<string, { status: number; body: unknown }>();
const bySender = new Map<string, string>();
let batches = 0;
/** Stripe's refunds as readBook reads them (review of Codex G on #2681, second GRAVE). */
const stripeState: "normal" | "down" | "refunded" = "normal";
let posts = 0;
let dropSecretsAtToken = false;
/** The receivers of each POST, in order (review of Codex H2 on #2681). */
let receivers: string[][] = [];
const items = new Map<string, string>();

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.stripe.com") {
    if (stripeState === "down") return json({ error: { message: "synthetic unavailable" } }, 500);
    if (stripeState === "refunded" && url.pathname === "/v1/refunds") return json({ data: [{ id: "re_1", payment_intent: "pi_cs_1", amount: 10000, status: "succeeded" }, { id: "re_2", payment_intent: "pi_cs_2", amount: 5000, status: "succeeded" }], has_more: false });
    return json({ data: [], has_more: false });
  }
  if (url.hostname !== "api-m.paypal.com") return json({ error: "unexpected" }, 404);
  if (url.pathname === "/v1/oauth2/token") { if (dropSecretsAtToken) { delete process.env.NIMBUS_DATA_KEY; delete process.env.STRIPE_SECRET_KEY; } return json({ access_token: "A21AAtoken", token_type: "Bearer", scope: "https://uri.paypal.com/payments/payouts", expires_in: 32400 }); }
  const headers = new Headers(init?.headers);
  if (url.pathname === "/v1/payments/payouts" && init?.method === "POST") {
    posts += 1;
    const mode = next;
    const key = headers.get("paypal-request-id") ?? "";
    const body = JSON.parse(String(init.body)) as { sender_batch_header: { sender_batch_id: string }; items: { sender_item_id: string; receiver: string }[] };
    receivers.push(body.items.map((item) => item.receiver));
    const sender = body.sender_batch_header.sender_batch_id;
    if (mode === "drop-before") throw new TypeError("fetch failed: before PayPal");
    if (mode === "server") return json({ name: "INTERNAL_SERVER_ERROR" }, 500);
    if (mode === "garbled") return new Response("<html>", { status: 201 });
    if (mode === "forget-key") byKey.delete(key);
    const kept = byKey.get(key);
    if (kept) return json(kept.body, kept.status);
    const original = bySender.get(sender);
    if (original) {
      const detail: Record<string, unknown> = { field: "sender_batch_id", issue: "Batch with given sender_batch_id already exists" };
      if (duplicateLink) detail.link = { href: `https://api-m.paypal.com/v1/payments/payouts/${original}`, rel: "self", method: "GET" };
      return json({ name: "USER_BUSINESS_ERROR", message: "User business error.", details: [detail], links: [] }, 400);
    }
    batches += 1;
    const id = `BATCH${batches}REC`;
    bySender.set(sender, id);
    for (const item of body.items) items.set(`${id}:${item.sender_item_id}`, "SUCCESS");
    const made = { status: 201, body: { batch_header: { payout_batch_id: id, batch_status: "PENDING", sender_batch_header: body.sender_batch_header } } };
    byKey.set(key, made);
    if (mode === "make-then-drop") throw new TypeError("fetch failed: the answer was lost");
    return json(made.body, made.status);
  }
  const batch = /^\/v1\/payments\/payouts\/(BATCH\d+REC)$/.exec(url.pathname)?.[1];
  if (batch) {
    const mine = [...items.entries()].filter(([k]) => k.startsWith(`${batch}:`));
    return json({
      batch_header: { payout_batch_id: batch, batch_status: "SUCCESS" },
      total_pages: 1,
      items: mine.map(([k, status], i) => ({ payout_item_id: `ITEM${batch}${i}`, payout_batch_id: batch, transaction_status: status, payout_item: { sender_item_id: k.split(":")[1] } })),
    });
  }
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;

function shop(): Store {
  return {
    sid: "sidrecon01", handle: "harbor", name: "Harbor Kitchen", previousHandles: [], releasedHandles: [],
    statsId: STATS, stripeAccountId: "acct_1TestHarbor0001", currency: "usd",
    affiliates: { enabled: true, percent: 30, days: 30, rates: {}, payday: 5, hold: 0 },
  } as unknown as Store;
}

async function seed(store: Store): Promise<void> {
  redis.clear();
  byKey.clear();
  bySender.clear();
  items.clear();
  batches = 0;
  posts = 0;
  receivers = [];
  duplicateLink = true;
  const at = Math.floor(Date.now() / 1000) - 86_400;
  const person = (id: string, email: string, code: string) => JSON.stringify({ id, email, code, status: "approved", appliedAt: 1, decidedAt: 2, note: "" });
  const sale = (ref: string, aff: string, base: number) => JSON.stringify({ ref, pi: `pi_${ref}`, aff, at, product: "p1", title: "Guide", base, total: base, currency: "usd", rate: 30, self: false });
  await redis.pipeline([
    ["HSET", `nl:aff:${STATS}:people`, "aaaaaaaaaaaa", person("aaaaaaaaaaaa", "sara@example.com", "sara")],
    ["HSET", `nl:aff:${STATS}:people`, "bbbbbbbbbbbb", person("bbbbbbbbbbbb", "tom@example.com", "tom")],
    ["HSET", `nl:aff:${STATS}:sales`, "cs_1", sale("cs_1", "aaaaaaaaaaaa", 10000)],
    ["HSET", `nl:aff:${STATS}:sales`, "cs_2", sale("cs_2", "bbbbbbbbbbbb", 5000)],
  ]);
  const linked = await connectPayPal(store, CLIENT, SECRET);
  if (!linked.ok) throw new Error(`not linked: ${JSON.stringify(linked)}`);
}

const paidCents = async (store: Store) => (await readBook(store)).rows.reduce((n, r) => n + r.paid, 0);
async function main(): Promise<void> {
  process.env.NIMBUS_DATA_KEY = "g-review-synthetic-data-key-123456789";
  process.env.STRIPE_SECRET_KEY = "sk_test_paypal_reconcile_only";
  console.error = () => {};
  const store=shop();
  const kept=async()=>{const [raw]=await redis.pipeline([["HGETALL",OPEN]]); return JSON.parse(String((raw as string[])[1])) as {lines:{a:string,c:number,r?:string}[],m?:number};};
  await seed(store); next="drop-before";
  await payWithPayPal(store);
  const held=await kept();
  const key=deriveKey("paypal-payout-receiver/v1");
  if(!key)throw new Error("synthetic key unavailable");
  is("stored receiver fingerprint is exact purpose-separated HMAC",held.lines[0].r,createHmac("sha256",key).update("sara@example.com").digest("hex"));
  is("stored fingerprint is not plain SHA256",held.lines[0].r===createHash("sha256").update("sara@example.com").digest("hex"),false);
  is("unknown batch stores neither recipient address",JSON.stringify(held).includes("@example.com"),false);
  next="make"; await settlePayPal(store); await settlePayPal(store);
  is("same root and address still recover one payment",[batches,await paidCents(store)],[1,4500]);
  await seed(store);next="drop-before";dropSecretsAtToken=true;
  await payWithPayPal(store);
  const noSecret=await kept();
  is("secret absent at fingerprint time stores no r field",noSecret.lines.every(l=>!Object.hasOwn(l,"r")),true);
  is("secret absent never substitutes address or plain hash",JSON.stringify(noSecret).includes("@example.com")||JSON.stringify(noSecret).includes(createHash("sha256").update("sara@example.com").digest("hex")),false);
  dropSecretsAtToken=false;
  process.env.NIMBUS_DATA_KEY="g-review-synthetic-data-key-123456789";
  process.env.STRIPE_SECRET_KEY="sk_test_paypal_reconcile_only";
  const priorPosts=posts;next="make";await settlePayPal(store);
  is("no original fingerprint means manual check without a second POST",[posts, (await kept()).m, (await onTheirWay(store)).size],[priorPosts,1,2]);
  done();
}
void main();
