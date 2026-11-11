/**
 * 649 [WG9], unit 2: the refund the creator gives from the buyer's record,
 * through the real route (app/api/store/person-refund/route.ts) and
 * lib/creator-refund.ts, with Stripe simulated (an in-memory account that
 * keeps idempotency keys as Stripe does: a repeat answers the first refund,
 * a key still being worked on answers 409) and the in-memory Redis double.
 *
 * Checked: only the payments role refunds, and nothing is asked of Stripe
 * otherwise; the charge is read on the creator's account and must be a sale
 * of this store; the amount is checked against what is left before sending;
 * two simultaneous clicks of the same form give back once, and so does a
 * repeat later; Stripe's answer is "done" only when it is this refund and it
 * succeeded, and an answer that cannot be read is said as unknown, never as
 * done; the team's activity log gets one line for each refund, saying who,
 * when and how much, never the buyer's address.
 */
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { readLogWhole } from "@/lib/team";
import { TOLD_DAYS, giveRefund } from "@/lib/creator-refund";
import { POST } from "@/app/api/store/person-refund/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "rowan@example.com";
const HANDLE = "rowanshop";
const ACCOUNT = "acct_1rowanrefund42";
const CHARGE = "ch_wg9action1";
const T1 = "1".repeat(32);
const T2 = "2".repeat(32);
const T3 = "3".repeat(32);

type Made = { id: string; amount: number; status: string; action: string | null; form: string | null };
const stripe = {
  charge: { amount: 5_000, refunded: 0, disputed: false, store: HANDLE, status: "succeeded" },
  keys: new Map<string, { busy: boolean; reply: Record<string, unknown> | null; params: string }>(),
  made: [] as Made[],
  calls: [] as { method: string; path: string; key: string | null; body: string }[],
  /** What the next refund answers with instead of a real one: a status, a whole body, or a failure of the network. */
  next: null as null | { status?: string; body?: Record<string, unknown>; network?: boolean },
};
function reset(): void {
  stripe.charge = { amount: 5_000, refunded: 0, disputed: false, store: HANDLE, status: "succeeded" };
  stripe.keys.clear();
  stripe.made = [];
  stripe.calls = [];
  stripe.next = null;
}
const chargeBody = () => ({
  id: CHARGE,
  object: "charge",
  status: stripe.charge.status,
  paid: stripe.charge.status === "succeeded",
  amount: stripe.charge.amount,
  captured: true,
  amount_captured: stripe.charge.amount,
  amount_refunded: stripe.charge.refunded,
  currency: "usd",
  disputed: stripe.charge.disputed,
  refunded: stripe.charge.refunded === stripe.charge.amount,
  billing_details: { email: "buyer@example.com" },
  payment_intent: { id: "pi_wg9action1", object: "payment_intent", metadata: { store: stripe.charge.store, product: "p1" } },
});
/** Refund ids never repeat across the parts, as Stripe's do not. */
let refundIds = 0;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const path = url.pathname.replace(/^\/v1/, "");
  const headers = new Headers(init?.headers);
  const key = headers.get("Idempotency-Key");
  const body = typeof init?.body === "string" ? init.body : init?.body ? String(init.body) : "";
  stripe.calls.push({ method: init?.method ?? "GET", path, key, body });
  if (headers.get("Stripe-Account") !== ACCOUNT) return Response.json({ error: { type: "invalid_request_error", message: "no such account" } }, { status: 400 });
  if (path === `/charges/${CHARGE}` && (init?.method ?? "GET") === "GET") return Response.json(chargeBody());
  if (path.startsWith("/charges/")) return Response.json({ error: { type: "invalid_request_error", code: "resource_missing", message: "No such charge" } }, { status: 404 });
  // The charge's refunds, newest first, each with the metadata it was made with (Stripe keeps them for good).
  if (path === "/refunds" && (init?.method ?? "GET") === "GET" && url.searchParams.get("charge") === CHARGE) {
    const data = [...stripe.made].reverse().map((m) => ({ id: m.id, object: "refund", amount: m.amount, charge: CHARGE, currency: "usd", status: m.status, metadata: m.action ? { mm_action: m.action, mm_form: m.form } : {} }));
    return Response.json({ object: "list", data, has_more: false });
  }
  if (path === "/refunds" && init?.method === "POST") {
    const params = new URLSearchParams(body);
    if (key) {
      const seen = stripe.keys.get(key);
      if (seen?.busy) return Response.json({ error: { type: "idempotency_error", code: "idempotency_key_in_use", message: "in use" } }, { status: 409 });
      if (seen) return seen.params === body ? Response.json(seen.reply) : Response.json({ error: { type: "idempotency_error", message: "different parameters" } }, { status: 400 });
      stripe.keys.set(key, { busy: true, reply: null, params: body });
    }
    await pause(25);
    if (stripe.next?.network) {
      if (key) stripe.keys.delete(key);
      throw new TypeError("fetch failed");
    }
    if (stripe.charge.disputed) return Response.json({ error: { type: "invalid_request_error", code: "charge_disputed", message: "disputed" } }, { status: 400 });
    const amount = Number(params.get("amount"));
    const status = stripe.next?.status ?? "succeeded";
    refundIds += 1;
    const made = { id: `re_wg9_${refundIds}`, amount, status, action: params.get("metadata[mm_action]"), form: params.get("metadata[mm_form]") };
    stripe.made.push(made);
    if (status === "succeeded" || status === "pending") stripe.charge.refunded += amount;
    const reply = stripe.next?.body ?? { id: made.id, object: "refund", amount, charge: params.get("charge"), currency: "usd", status, reason: params.get("reason") };
    if (key) stripe.keys.set(key, { busy: false, reply, params: body });
    return Response.json(reply);
  }
  return Response.json({ error: { message: "unexpected synthetic request" } }, { status: 404 });
}) as typeof fetch;

let cookie = "";
async function post(body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await POST(new NextRequest("https://marktmorgen.com/api/store/person-refund", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }));
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}
async function logLines(store: Store): Promise<string[]> {
  return ((await readLogWhole(store.sid as string))?.lines ?? []).map((l) => `${l.who}|${l.role}|${l.what}`);
}
const refundPosts = () => stripe.calls.filter((c) => c.method === "POST" && c.path === "/refunds");

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_wg9_synthetic_only";
  redis.clear();
  await claimHandle(OWNER, HANDLE, "Rowan store", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_rowan", subscriptionId: "sub_rowan", active: true, tier: "pro", period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  cookie = `${SESSION_COOKIE}=${await openSession(OWNER)}`;

  part("The owner gives back part of a payment: once, the amount asked, with the action's key");
  reset();
  const first = await post({ charge: CHARGE, token: T1, amount: "12.50", reason: "requested_by_customer" });
  is("done, for the amount and currency asked", [first.status, first.body], [200, { ok: true, state: "done", cents: 1_250, currency: "usd" }]);
  const sent = refundPosts();
  is("one refund asked of Stripe, on the creator's account", sent.length, 1);
  const params = new URLSearchParams(sent[0]?.body ?? "");
  is("for this charge, this amount and this reason", [params.get("charge"), params.get("amount"), params.get("reason")], [CHARGE, "1250", "requested_by_customer"]);
  is("under the key of this action", sent[0]?.key, `mm:refund:${store.sid}:${CHARGE}:${T1}`);
  is("the team member's address never goes to Stripe", (sent[0]?.body ?? "").includes("rowan"), false);
  is("the payment now has 12.50 given back", stripe.charge.refunded, 1_250);
  const afterFirst = await logLines(store);
  is("one line in the team's log: who, and how much on which payment", afterFirst, [`${OWNER}|owner|Refunded $12.50 on payment ${CHARGE}`]);
  is("the buyer's address is not in the log", afterFirst.join(" ").includes("buyer@example.com"), false);

  part("The same form sent again later: Stripe answers the first refund, nothing is given back twice");
  const again = await post({ charge: CHARGE, token: T1, amount: "12.50", reason: "requested_by_customer" });
  is("said done again", [again.status, again.body.state], [200, "done"]);
  is("still one refund made at Stripe, and 12.50 given back", [stripe.made.length, stripe.charge.refunded], [1, 1_250]);
  is("and still one line in the log", (await logLines(store)).length, 1);

  part("The same form sent again a day later, once Stripe has forgotten its key: still one refund (Claude 3 and Codex G on #3678)");
  stripe.keys.clear();
  const nextDay = await post({ charge: CHARGE, token: T1, amount: "12.50", reason: "requested_by_customer" });
  is("said done, as the first refund", [nextDay.status, nextDay.body.state], [200, "done"]);
  is("no second refund made at Stripe, still 12.50 given back", [stripe.made.length, stripe.charge.refunded], [1, 1_250]);
  is("each refund carries this action's mark, never the key or the token itself", [stripe.made[0]?.action?.length, (stripe.made[0]?.action ?? "").includes(T1)], [40, false]);
  is("still one line in the log", (await logLines(store)).length, 1);
  const otherFigures = await post({ charge: CHARGE, token: T1, amount: "5", reason: "requested_by_customer" });
  is("the same form with other figures a day later: refused, nothing sent", [otherFigures.status, otherFigures.body.error, stripe.made.length], [409, "form_used", 1]);
  const stripeFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.pathname.endsWith("/refunds") && (init?.method ?? "GET") === "GET") return Response.json({ object: "list", data: [], has_more: true });
    return stripeFetch(input, init);
  }) as typeof fetch;
  try {
    const unread = await post({ charge: CHARGE, token: "6".repeat(32), amount: "1" });
    is("the charge's refunds not read whole: unavailable, never \"none yet\", nothing sent", [unread.body.error, stripe.made.length], ["unavailable", 1]);
  } finally {
    globalThis.fetch = stripeFetch;
  }

  part("Two clicks at the same moment on a new form: one refund");
  const [a, b] = await Promise.all([post({ charge: CHARGE, token: T2, amount: "10" }), post({ charge: CHARGE, token: T2, amount: "10" })]);
  is("one refund more made at Stripe, for 10.00", [stripe.made.length, stripe.charge.refunded], [2, 2_250]);
  const states = [a.body.state ?? a.body.error, b.body.state ?? b.body.error].sort();
  is("one says done; the other done or still being worked on, never a second refund", states[0] === "done" && (states[1] === "done" || states[1] === "in_progress"), true);
  is("one log line for it", (await logLines(store)).length, 2);

  part("Checked before Stripe is asked to give anything back");
  const asked = refundPosts().length;
  const over = await post({ charge: CHARGE, token: T3, amount: "27.51" });
  is("more than is left (27.50): refused, nothing sent", [over.status, over.body.error, refundPosts().length], [400, "over_refundable", asked]);
  const typed = await post({ charge: CHARGE, token: T3, amount: "$5" });
  is("an amount that is not plain: refused", [typed.status, typed.body.error], [400, "not_an_amount"]);
  const badToken = await post({ charge: CHARGE, token: "abc", amount: "5" });
  is("no form token: refused before any read", [badToken.status, badToken.body.error], [400, "invalid"]);
  const badReason = await post({ charge: CHARGE, token: T3, amount: "5", reason: "because" });
  is("a reason Stripe does not take: refused, said as the reason (Claude 3 on #3678, LEVE)", [badReason.status, badReason.body.error], [400, "reason"]);
  stripe.charge.store = "someoneelse";
  const other = await post({ charge: CHARGE, token: T3, amount: "5" });
  is("a payment of another store on the same account: not found, nothing sent", [other.status, other.body.error, refundPosts().length], [404, "not_found", asked]);
  stripe.charge.store = HANDLE;
  const missing = await post({ charge: "ch_wg9nothere", token: T3, amount: "5" });
  is("a payment Stripe does not know: not found", [missing.status, missing.body.error], [404, "not_found"]);
  stripe.charge.disputed = true;
  const disputed = await post({ charge: CHARGE, token: T3, full: true });
  is("a disputed payment: refused, defended in the dispute instead", [disputed.status, disputed.body.error, refundPosts().length], [409, "disputed", asked]);
  stripe.charge.disputed = false;

  part("Refused by Stripe before anything was made: said so, and no line in the log");
  const linesBefore = (await logLines(store)).length;
  const changed = await post({ charge: CHARGE, token: T1, amount: "5" });
  is("the first form's key with another amount: said as a form already used, the first refund stands (Claude 3 on #3678, LEVE)", [changed.status, changed.body.error, stripe.made.length], [409, "form_used", 2]);
  stripe.next = { body: undefined };
  const refusedBody = { error: { type: "invalid_request_error", code: "parameter_invalid_integer", message: "Invalid integer" } };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
    init?.method === "POST" ? Response.json(refusedBody, { status: 400 }) : realFetch(input, init)) as typeof fetch;
  const refused = await post({ charge: CHARGE, token: T3, amount: "5" });
  globalThis.fetch = realFetch;
  stripe.next = null;
  is("any other 4xx from Stripe: refused by Stripe, never unknown or done", [refused.status, refused.body.error, stripe.made.length], [409, "stripe_refused", 2]);
  is("neither writes a line in the log", (await logLines(store)).length, linesBefore);

  part("Stripe's answer, read exactly");
  reset();
  stripe.next = { status: "pending" };
  const pending = await post({ charge: CHARGE, token: T1, full: true });
  is("pending at Stripe: said pending, not done", [pending.status, pending.body], [200, { ok: true, state: "pending", cents: 5_000, currency: "usd" }]);
  reset();
  stripe.next = { status: "failed" };
  const failed = await post({ charge: CHARGE, token: T2, full: true });
  is("refused by Stripe: never ok, its own error (Claude 3 on #3678, LEVE)", [failed.status, failed.body.ok, failed.body.error], [409, false, "refund_failed"]);
  reset();
  stripe.next = { body: { id: "re_odd", object: "refund", amount: 5_000, charge: CHARGE, currency: "usd", status: "ok" } };
  const odd = await post({ charge: CHARGE, token: T3, full: true });
  is("a status Stripe does not send: unknown, never done", [odd.status, odd.body.ok, odd.body.error], [502, false, "unknown"]);
  reset();
  stripe.next = { body: { id: "re_odd2", object: "refund", amount: 4_000, charge: CHARGE, currency: "usd", status: "succeeded" } };
  const short = await post({ charge: CHARGE, token: "4".repeat(32), full: true });
  is("a refund of another amount: unknown, never done", [short.status, short.body.error], [502, "unknown"]);
  reset();
  stripe.next = { network: true };
  const lost = await post({ charge: CHARGE, token: "5".repeat(32), full: true });
  is("no answer at all: unknown, never done", [lost.status, lost.body.error], [502, "unknown"]);
  const lines = await logLines(store);
  is("the log says what Stripe answered, and never 'Refunded' for an unknown answer", lines.slice(0, 5), [
    `${OWNER}|owner|Sent a refund of $50 on payment ${CHARGE}; Stripe's answer could not be read`,
    `${OWNER}|owner|Sent a refund of $50 on payment ${CHARGE}; Stripe's answer could not be read`,
    `${OWNER}|owner|Sent a refund of $50 on payment ${CHARGE}; Stripe's answer could not be read`,
    `${OWNER}|owner|Refund of $50 on payment ${CHARGE} refused by Stripe`,
    `${OWNER}|owner|Refund of $50 on payment ${CHARGE} waiting at Stripe`,
  ]);

  part("Who may: only the payments role, and nothing is asked of Stripe otherwise");
  reset();
  for (const role of ["admin", "editor", "support"] as const) {
    is(`${role}: forbidden`, await giveRefund(store, { email: "team@example.com", role }, { charge: CHARGE, token: T1, full: true }), { ok: false, error: "forbidden" });
  }
  is("no Stripe call for them", stripe.calls.length, 0);
  is("a store with no Stripe account: said so, nothing asked", await giveRefund({ ...store, stripeAccountId: null }, { email: OWNER, role: "owner" }, { charge: CHARGE, token: T1, full: true }), { ok: false, error: "no_stripe" });
  const signedOut = await POST(new NextRequest("https://marktmorgen.com/api/store/person-refund", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ charge: CHARGE, token: T1, full: true }) }));
  is("signed out: 401, nothing asked", [signedOut.status, stripe.calls.length], [401, 0]);

  part("What is kept: one mark per refund told, for as long as Stripe keeps a key");
  is("two days, past Stripe's 24 hours", TOLD_DAYS, 2);
  const marks = redis.keys().filter((k) => k.startsWith("nl:crefund:"));
  is("marks were kept, and no other key family", [marks.length > 0, marks.every((k) => k.startsWith("nl:crefund:told:"))], [true, true]);

  done();
}

void main();
