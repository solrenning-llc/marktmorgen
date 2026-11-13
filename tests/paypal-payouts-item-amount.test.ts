/**
 * #4417 (Codex X8, transcribed by Claude 2): a PayPal payout line is settled
 * into the book only when the batch's SUCCESS item confirms the amount and the
 * currency that were sent (payout_item.amount), compared in the currency's
 * minor units with no floating point. A different value or currency, or none
 * at all, keeps the line on its way for the next reading; nothing is booked.
 * Synthetic PayPal and Stripe stand-ins only (the reconcile test's fixture).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { connectPayPal, onTheirWay, payWithPayPal, payoutUnknownMonth, settlePayPal } from "@/lib/paypal-payouts";
import { readBook } from "@/lib/affiliates";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
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
let stripeState: "normal" | "down" | "refunded" = "normal";
let posts = 0;
/** The receivers of each POST, in order (review of Codex H2 on #2681). */
let receivers: string[][] = [];
const items = new Map<string, string>();
/** What each item was sent for, as the POST's body said it (value, currency), by `${batch}:${sender_item_id}`. */
const sentAmounts = new Map<string, { value: string; currency: string }>();
/** How the GET reports each SUCCESS item's amount (#4417): as sent, a tenth of it, in EUR, or not at all. */
let amountMode: "same" | "tenth" | "eur" | "missing" = "same";

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
    posts += 1;
    const mode = next;
    const key = headers.get("paypal-request-id") ?? "";
    const body = JSON.parse(String(init.body)) as { sender_batch_header: { sender_batch_id: string }; items: { sender_item_id: string; receiver: string; amount: { value: string; currency: string } }[] };
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
    for (const item of body.items) {
      items.set(`${id}:${item.sender_item_id}`, "SUCCESS");
      sentAmounts.set(`${id}:${item.sender_item_id}`, item.amount);
    }
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
      items: mine.map(([k, status], i) => {
        const sent = sentAmounts.get(k) ?? { value: "0.00", currency: "USD" };
        const amount = amountMode === "missing" ? undefined
          : amountMode === "tenth" ? { value: (Number(sent.value) / 10).toFixed(2), currency: sent.currency }
          : amountMode === "eur" ? { value: sent.value, currency: "EUR" }
          : sent;
        return { payout_item_id: `ITEM${batch}${i}`, payout_batch_id: batch, transaction_status: status, payout_item: { sender_item_id: k.split(":")[1], ...(amount ? { amount } : {}) } };
      }),
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

/** The open batch fields, the unknown ones as "?". */
async function fields(): Promise<string[]> {
  const [raw] = await redis.pipeline([["HKEYS", OPEN]]);
  return (raw as string[]).map((f) => (f.startsWith("?") ? "?" : f)).sort();
}

/** Moves every unknown entry's clock back by `ms`, as if that long had passed. */
async function age(field: "at" | "t", ms: number): Promise<void> {
  const [raw] = await redis.pipeline([["HGETALL", OPEN]]);
  const flat = raw as string[];
  for (let i = 0; i < flat.length; i += 2) {
    if (!flat[i].startsWith("?")) continue;
    const entry = JSON.parse(flat[i + 1]) as Record<string, unknown>;
    if (typeof entry[field] === "number") entry[field] = (entry[field] as number) - ms;
    await redis.pipeline([["HSET", OPEN, flat[i], JSON.stringify(entry)]]);
  }
}

const paidCents = async (store: Store) => (await readBook(store)).rows.reduce((n, r) => n + r.paid, 0);
const month = () => new Date().toISOString().slice(0, 7);
const counts = async () => {
  const [raw] = await redis.pipeline([["HGETALL", `nl:pp:unk:month:${month()}`]]);
  const flat = (raw ?? []) as string[];
  const out: Record<string, number> = {};
  for (let i = 0; i < flat.length; i += 2) out[flat[i]] = Number(flat[i + 1]);
  return out;
};

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_paypal_item_amount_only";
  console.error = () => {};
  const store = shop();
  for (const [name, mode] of [
    ["control: each SUCCESS item reports the amount that was sent", "same"],
    ["SUCCESS items report a tenth of the amount (3.00 and 1.50 USD)", "tenth"],
    ["SUCCESS items report the right numbers in EUR", "eur"],
    ["SUCCESS items report no amount at all", "missing"],
  ] as const) {
    part(name);
    await seed(store);
    sentAmounts.clear();
    next = "make";
    amountMode = "same";
    const pressed = await payWithPayPal(store);
    is("the batch was made", pressed.ok, true);
    amountMode = mode;
    const result = await settlePayPal(store);
    const control = mode === "same";
    is("paid / waiting", [result.paid, result.waiting], control ? [2, 0] : [0, 2]);
    is("book holds the payout", await paidCents(store), control ? 4500 : 0);
    is("batch stays open", (await fields()).length, control ? 0 : 1);
    if (!control) {
      amountMode = "same";
      const later = await settlePayPal(store);
      is("read again once PayPal confirms the amount: paid once", [later.paid, await paidCents(store), (await fields()).length], [2, 4500, 0]);
    }
  }
  done();
}

void main();
