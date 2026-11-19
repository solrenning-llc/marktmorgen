/**
 * Codex L-20261119-1003 (erasure, MEDIUM): a reading of the affiliate book that started while the store was live keeps
 * its invoices (nl:aff:<statsId>:invoices) only while the store is still live. When the store's erasure has begun
 * (its field in nl:closed:erasing) or is done (its id key gone with its record), the late write is dropped, so the
 * invoice, payment and affiliate ids never come back after the erasure. A live store still keeps its walk.
 * Synthetic only: Stripe, PayPal and Resend stand-ins, the in-memory Redis.
 */
import { NO_AFFILIATES, RECURRING_ALWAYS } from "@/lib/affiliate-setting";
import { readBook } from "@/lib/affiliates";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, erasingField, ERASING_KEY, setAffiliateSetting, setStripeAccount, setSubscription, storeForEmail, storeRef } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_invoice_keep_erased";
process.env.RESEND_API_KEY = "re_test_invoice_keep_erased";

const OWNER = "owner@example.com";
const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);
const SARA = "0123456789ab";
let all: Record<string, unknown>[] = [];
const unreadable = false;
let asked = 0;
const payouts: Record<string, unknown>[] = [];
const emails: { subject: string; text: string }[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { subject?: string; text?: string };
    emails.push({ subject: String(body.subject), text: String(body.text) });
    return answer({ id: `email_${emails.length}` });
  }
  if (url.hostname === "api-m.paypal.com") {
    if (url.pathname === "/v1/oauth2/token") return answer({ access_token: "A21AAtoken", token_type: "Bearer", scope: "https://uri.paypal.com/payments/payouts openid", expires_in: 32400 });
    if (url.pathname === "/v1/payments/payouts" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      payouts.push(body);
      return answer({ batch_header: { payout_batch_id: `BATCH${payouts.length}ABC`, batch_status: "PENDING", sender_batch_header: body.sender_batch_header } }, 201);
    }
    return answer({ name: "RESOURCE_NOT_FOUND" }, 404);
  }
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/invoices") {
    asked += 1;
    if (unreadable) return answer({ object: "list", has_more: false });
    const q = url.searchParams;
    const num = (name: string) => (q.has(name) ? Number(q.get(name)) : null);
    const [gte, gt, lte, lt] = [num("created[gte]"), num("created[gt]"), num("created[lte]"), num("created[lt]")];
    const rows = all.filter((i) => {
      const at = Number(i.created);
      return (!q.get("status") || i.status === q.get("status")) && (gte === null || at >= gte) && (gt === null || at > gt) && (lte === null || at <= lte) && (lt === null || at < lt);
    });
    const after = q.get("starting_after");
    const from = after ? rows.findIndex((i) => i.id === after) + 1 : 0;
    if (after && from === 0) return answer({ error: { message: "No such invoice" } }, 400);
    const limit = Number(q.get("limit") ?? 10);
    return answer({ object: "list", data: rows.slice(from, from + limit), has_more: from + limit < rows.length });
  }
  if (path === "/invoice_payments") asked += 1;
  if ((init?.method ?? "GET") === "GET") return answer({ object: "list", data: [], has_more: false });
  return answer({}, 404);
}) as typeof fetch;

const inv = (id: string, at: number, meta: Record<string, string>, status = "paid") => ({
  id, object: "invoice", status, billing_reason: "subscription_cycle", amount_paid: status === "paid" ? 2000 : 0, currency: "usd", customer_email: "m@example.com",
  created: at, status_transitions: { paid_at: status === "paid" ? at : null }, total_taxes: [],
  parent: { subscription_details: { metadata: { store: "harbor", ...meta } } },
  payments: { object: "list", has_more: false, data: status === "paid" ? [{ object: "invoice_payment", status: "paid", payment: { type: "payment_intent", payment_intent: `pi_${id}` } }] : [] },
});

/** What happens to the store just before its invoices are written: nothing, its erasure begun, or its id gone with its record. */
let before: null | "erasing" | "gone" = null;
const real = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  const touches = commands.some((c) => c.map(String).some((w) => /^nl:aff:[0-9a-f]+:invoices$/.test(w)) && (c[0] === "SET" || c[0] === "EVAL"));
  if (touches && before) {
    const store = (await storeForEmail(OWNER))!;
    const now = before;
    before = null;
    if (now === "erasing") await real([["HSET", ERASING_KEY, await erasingField(storeRef(store)), String(Date.now())]]);
    else await real([["DEL", `nl:store:id:${store.sid}`]]);
  }
  return real(commands);
}) as typeof redis.pipeline;

async function setUp(): Promise<string> {
  redis.clear();
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHarbor0001", true);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, tier: "creator", period: paidPeriod() });
  const club = await addProduct(OWNER, "Supper Club", "", "20", { interval: "month", trialDays: 0, payments: 0 });
  if (!club.ok) throw new Error("no product");
  await setAffiliateSetting(OWNER, { ...NO_AFFILIATES, enabled: true, percent: 30, recurring: RECURRING_ALWAYS, hold: 0, payday: new Date().getUTCDate() });
  const store = (await storeForEmail(OWNER))!;
  await redis.pipeline([["HSET", `nl:aff:${store.statsId}:people`, SARA, JSON.stringify({ id: SARA, email: "sara@example.com", paypal: "sara.pay@example.com", code: "sara", status: "approved", appliedAt: (NOW - 400 * DAY) * 1000, decidedAt: 1, note: "" })]]);
  const product = club.product.id;
  const terms = { product, via: SARA, via_rate: "30", via_months: String(RECURRING_ALWAYS), via_at: String(NOW - 300 * DAY) };
  // More paid invoices than one reading's pages: the reading keeps its walk for the next one.
  all = [];
  for (let i = 0; i < 1000; i += 1) all.push(inv(`in_Other${String(i).padStart(6, "0")}`, NOW - 1000 - i, { product }));
  for (let i = 0; i < 50; i += 1) all.push(inv(`in_Sara0${String(i).padStart(6, "0")}`, NOW - 200 * DAY - i, terms));
  return store.statsId as string;
}

const keptOf = async (statsId: string) => (await real([["GET", `nl:aff:${statsId}:invoices`]]))[0];

async function main(): Promise<void> {
  part("Control: a live store keeps its walk between readings");
  {
    const statsId = await setUp();
    await readBook((await storeForEmail(OWNER))!).catch(() => null);
    is("the invoices are kept", typeof (await keptOf(statsId)), "string");
  }
  for (const [label, what] of [["its erasure has begun", "erasing"], ["its id is gone with its record", "gone"]] as const) {
    part(`A reading in flight when ${label}`);
    const statsId = await setUp();
    before = what;
    await readBook((await storeForEmail(OWNER))!).catch(() => null);
    is("the erasure step ran during the reading", before, null);
    is("the store's invoices are not written back", await keptOf(statsId), null);
  }
  done();
}

void main();
