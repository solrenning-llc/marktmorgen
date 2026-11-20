/**
 * The daily PayPal reconciliation (settlePayPal) books a payout only on unambiguous evidence for that line.
 *
 * #4656: two lines of one batch that came back SUCCESS with the same payout_item_id were both dropped from the
 * batch, although the book's once-only write (by that item id) held only one of them: the other was owed again and
 * the next payday paid it twice. A sender_item_id read twice let the last row overwrite the first. A read that
 * repeats either id now keeps the whole batch on its way, read again next time.
 *
 * #4657: a SUCCESS item whose receiver is another address was booked as paid to the affiliate. A line that kept
 * its receiver's print when it was sent is now booked only when the receiver PayPal answers has that same print.
 *
 * Test by Codex X8 (X8-20261113-1727 and -1817 reports), transcribed by Claude 2; PayPal, Stripe, Redis and the
 * book are synthetic.
 */
import { connectPayPal, payWithPayPal, settlePayPal } from "@/lib/paypal-payouts";
import { readBook } from "@/lib/affiliates";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { markLive } from "./live-store";
import { done, is, part } from "./check";

const STATS = "statsrec01";
const OPEN = `nl:pp:open:${STATS}`;
const CLIENT = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const SECRET = "EFGHijklMNOPqrstUVWXyz0123456789abcd";
const DAY = 86_400_000;

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
let posts = 0;
/** The receivers of each POST, in order (review of Codex H2 on #2681). */
let receivers: string[][] = [];
const items = new Map<string, { status: string; receiver: string }>();
/** Tamper with what the stand-in answers for a batch read. */
let tamper: ((body: { items: { payout_item_id: string; payout_item: { sender_item_id: string; receiver?: string } }[] }) => void) | null = null;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.stripe.com") {
    if (stripeState === "down") return json({ error: { message: "synthetic unavailable" } }, 500);
    if (stripeState === "refunded" && url.pathname === "/v1/refunds") return json({ object: "list", data: [{ id: "re_1", object: "refund", payment_intent: "pi_cs_1", amount: 10000, currency: "usd", status: "succeeded" }, { id: "re_2", object: "refund", payment_intent: "pi_cs_2", amount: 5000, currency: "usd", status: "succeeded" }], has_more: false });
    return json({ object: "list", data: [], has_more: false });
  }
  if (url.hostname !== "api-m.paypal.com") return json({ error: "unexpected" }, 404);
  if (url.pathname === "/v1/oauth2/token") return json({ access_token: "A21AAtoken", token_type: "Bearer", scope: "https://uri.paypal.com/payments/payouts", expires_in: 32400 });
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
    for (const item of body.items) items.set(`${id}:${item.sender_item_id}`, { status: "SUCCESS", receiver: item.receiver });
    const made = { status: 201, body: { batch_header: { payout_batch_id: id, batch_status: "PENDING", sender_batch_header: body.sender_batch_header } } };
    byKey.set(key, made);
    if (mode === "make-then-drop") throw new TypeError("fetch failed: the answer was lost");
    return json(made.body, made.status);
  }
  const batch = /^\/v1\/payments\/payouts\/(BATCH\d+REC)$/.exec(url.pathname)?.[1];
  if (batch) {
    const mine = [...items.entries()].filter(([k]) => k.startsWith(`${batch}:`));
    const body = {
      batch_header: { payout_batch_id: batch, batch_status: "SUCCESS" },
      total_pages: 1,
      items: mine.map(([k, { status, receiver }], i) => ({ payout_item_id: `ITEM${batch}${i}`, payout_batch_id: batch, transaction_status: status, payout_item: { sender_item_id: k.split(":")[1], receiver } })),
    };
    tamper?.(body);
    return json(body);
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
  await markLive(store);
  const linked = await connectPayPal(store, CLIENT, SECRET);
  if (!linked.ok) throw new Error(`not linked: ${JSON.stringify(linked)}`);
}

/** The open batch fields, the unknown ones as "?". */
async function fields(): Promise<string[]> {
  const [raw] = await redis.pipeline([["HKEYS", OPEN]]);
  return (raw as string[]).map((f) => (f.startsWith("?") ? "?" : f)).sort();
}

const paidCents = async (store: Store) => (await readBook(store)).rows.reduce((n, r) => n + r.paid, 0);

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_paypal_reconcile_only";
  console.error = () => {};
  const store = shop();

  for (const alias of ["provider-item", "sender-item"] as const) {
    part(`A batch whose read repeats an identity (${alias}) stays on its way`);
    await seed(store);
    next = "make";
    is("control: a batch is made", (await payWithPayPal(store)).ok, true);
    tamper = (body) => {
      const [first, second] = body.items;
      if (alias === "provider-item") second.payout_item_id = first.payout_item_id;
      else second.payout_item.sender_item_id = first.payout_item.sender_item_id;
    };
    const held = await settlePayPal(store);
    tamper = null;
    is("no payout booked on ambiguous evidence", [held.paid, held.released, held.waiting], [0, 0, 2]);
    is("the batch remains open", await fields(), ["BATCH1REC"]);
    is("nothing was written to the book", await paidCents(store), 0);
    await settlePayPal(store);
    is("the healthy read books both amounts exactly once", [await paidCents(store), await fields()], [4500, []]);
  }

  part("A SUCCESS item whose receiver is another address stays on its way");
  await seed(store);
  next = "make";
  is("control: a batch is made", (await payWithPayPal(store)).ok, true);
  tamper = (body) => { body.items[0].payout_item.receiver = "different@example.test"; };
  const wrong = await settlePayPal(store);
  tamper = null;
  is("the mismatched line is not booked and stays waiting", [wrong.paid, wrong.waiting, wrong.released], [1, 1, 0]);
  is("the batch remains open", await fields(), ["BATCH1REC"]);
  const healthy = await settlePayPal(store);
  is("the next healthy read books the line it held, once", [healthy.paid, await paidCents(store), await fields()], [1, 4500, []]);

  part("A paid receiver PayPal gives back in another letter case is the same receiver (Claude 4's MÉDIO on #4682)");
  await seed(store);
  next = "make";
  is("control: a batch is made", (await payWithPayPal(store)).ok, true);
  tamper = (body) => { for (const item of body.items) if (item.payout_item.receiver) item.payout_item.receiver = ` ${item.payout_item.receiver.toUpperCase()} `; };
  const cased = await settlePayPal(store);
  tamper = null;
  is("both paid lines are booked, none left waiting", [cased.paid, cased.waiting, cased.released], [2, 0, 0]);
  is("the book holds both amounts once, and the batch is closed", [await paidCents(store), await fields()], [4500, []]);

  // Claude 5 on #4682 (6920583705, MÉDIO, money): an item that did NOT pay (FAILED, RETURNED, BLOCKED, REFUNDED,
  // REVERSED) released its line whatever receiver PayPal named, so the next payday paid the affiliate again. A read of
  // another receiver's item proves neither the payment nor its failure: the line stays on its way, as for SUCCESS.
  type Item = { transaction_status?: string; payout_item: { receiver?: string } };
  for (const status of ["FAILED", "RETURNED", "BLOCKED", "REFUNDED", "REVERSED", "FAILED, no receiver"]) {
    part(`A ${status} item whose receiver is not the one it was sent to stays on its way`);
    await seed(store);
    next = "make";
    is("control: a batch is made", (await payWithPayPal(store)).ok, true);
    tamper = (body) => {
      const first = body.items[0] as unknown as Item;
      first.transaction_status = status.split(",")[0];
      if (status.includes("no receiver")) delete first.payout_item.receiver;
      else first.payout_item.receiver = "different@example.test";
    };
    const held = await settlePayPal(store);
    tamper = null;
    is("the mismatched line is not released (stays on its way); the other is booked", [held.paid, held.waiting, held.released], [1, 1, 0]);
    posts = 0;
    receivers = [];
    await payWithPayPal(store);
    is("no second payment is sent to the same affiliate", receivers.flat().includes("sara@example.com"), false);
  }

  part("Control: a FAILED item for the receiver it was sent to is released, as before");
  await seed(store);
  next = "make";
  is("control: a batch is made", (await payWithPayPal(store)).ok, true);
  tamper = (body) => { (body.items[0] as unknown as Item).transaction_status = "FAILED"; };
  const failed = await settlePayPal(store);
  tamper = null;
  is("released, owed again; the other booked", [failed.paid, failed.waiting, failed.released], [1, 0, 1]);
  done();
}

void main();
