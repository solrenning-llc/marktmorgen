/**
 * A PayPal batch's status is read only from a reply whose header names the
 * batch asked about (lib/paypal-payouts.ts, settlePayPal): a reply that names
 * another batch is not this one's answer, so its DENIED never releases this
 * batch's lines, and the batch stays recorded for the next read. A DENIED for
 * the batch asked about still releases them (issue #4387, Codex X8). The
 * stand-ins are those of tests/paypal-payouts-reconcile.test.ts.
 */
import { connectPayPal, payWithPayPal, settlePayPal } from "@/lib/paypal-payouts";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

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
const stripeState = "normal" as "normal" | "down" | "refunded";
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
  if (url.pathname === "/v1/oauth2/token") return json({ access_token: "A21AAtoken", token_type: "Bearer", scope: "https://uri.paypal.com/payments/payouts", expires_in: 32400 });
  const headers = new Headers(init?.headers);
  if (url.pathname === "/v1/payments/payouts" && init?.method === "POST") {
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

/** The open batch fields, the unknown ones as "?". */
async function fields(): Promise<string[]> {
  const [raw] = await redis.pipeline([["HKEYS", OPEN]]);
  return (raw as string[]).map((f) => (f.startsWith("?") ? "?" : f)).sort();
}

/** The GET of an open batch answered with another batch's header, or with this one's, DENIED. */
let header: "other" | "denied" | null = null;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const batch = /^\/v1\/payments\/payouts\/(BATCH\d+REC)$/.exec(url.pathname)?.[1];
  if (batch && header) {
    const id = header === "other" ? "BATCHOTHER" : batch;
    return new Response(JSON.stringify({ batch_header: { payout_batch_id: id, batch_status: "DENIED" }, total_pages: 1, items: [] }), { status: 200 });
  }
  return realFetch(input, init);
}) as typeof fetch;

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_paypal_identity_only";
  console.error = () => {};
  const store = shop();
  part("A DENIED that names another batch");
  await seed(store);
  next = "make";
  header = null;
  await payWithPayPal(store);
  is("control: batch A is open", await fields(), ["BATCH1REC"]);
  header = "other";
  const r = await settlePayPal(store);
  is("nothing released, both lines still on their way", [r.released, r.waiting], [0, 2]);
  is("batch A stays recorded", await fields(), ["BATCH1REC"]);

  part("Control: a DENIED for the batch asked about");
  header = "denied";
  const denied = await settlePayPal(store);
  is("both lines released", [denied.released, denied.waiting], [2, 0]);
  is("batch A leaves the record", await fields(), []);
  header = null;
  done();
}

void main();
