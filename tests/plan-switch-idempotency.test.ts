// A member's switch to another tier or to yearly charges at once (POST /subscriptions/{id} with proration_date and
// always_invoice). A first request whose answer never arrived may still be running, or done, at Stripe: a retry must
// never be a second charge. Synthetic transport only, with Stripe's idempotency rules played by the fake: a repeat of
// a key with the same parameters gets the first answer, with other parameters a 400 idempotency_error, and while the
// first is still running a 409 idempotency_key_in_use. No request is forwarded to a provider.
import { addProduct, claimHandle, ensureStatsId, setProductLink, setProductYearly, setStoreTiers, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { requestManageLink } from "@/lib/membership-manage";
import { membershipWords } from "@/lib/buyer-words/membership";
import { PREVIEW_SECONDS, switchTier } from "@/lib/tier-switch";
import { switchYearly } from "@/lib/yearly-switch";
import { EU_WITHDRAWAL_CONSENT_VERSION } from "@/lib/digital-consent";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { is, done } from "./check";

const emails: { to: string | string[]; text: string }[] = [];
const subscription = "sub_IdemMember0001", customer = "cus_IdemMember0001";
const now = Math.floor(Date.now() / 1000);
let product = "";
let actualPrice = "price_IdemMonthly0001", actualConsent = "";
/** What the fake Stripe does with the next charging update that it runs. */
let mode: "applied" | "lost response" | "in flight" | "known rejection" | "declined" = "applied";
/** Charging updates Stripe actually ran: each one is a charge. */
let executions = 0;
/** The Idempotency-Key header of every charging update sent, "" when none. */
const keysSent: string[] = [];
const kept = new Map<string, { body: string; running: boolean; status: number; reply: string }>();
/** Redis time the next subscription read takes, and the next charging update before it is given up, in ms. */
let slowRead = 0, slowCharge = 0;

const row = () => ({
  id: subscription, object: "subscription", status: "active", customer, created: now - 90 * 86400,
  start_date: now - 90 * 86400, trial_end: null, discount: null, discounts: [], pause_collection: null,
  metadata: { store: "idemswitch", product, ...(actualConsent ? { dc: actualConsent } : {}) },
  items: { data: [{ id: "si_IdemMember0001", quantity: 1, price: { id: actualPrice, unit_amount: 2000, currency: "usd", metadata: { product }, recurring: { interval: "month", interval_count: 1 } } }] },
});
const invoice = { id: "in_IdemPaid0001", status: "paid", total: 1000, amount_paid: 1000, currency: "usd" };

/** One charging update, run by the fake Stripe: what the first request with a key gets, and what is kept under it. */
function run(body: URLSearchParams): { status: number; reply: string; lost: boolean } {
  executions++;
  if (mode === "known rejection") return { status: 400, reply: JSON.stringify({ error: { type: "invalid_request_error", message: "Synthetic refusal, no change applied" } }), lost: false };
  if (mode === "declined") return { status: 200, reply: JSON.stringify({ ...row(), pending_update: { expires_at: now + 100 }, latest_invoice: { ...invoice, id: "in_IdemDeclined0001", status: "open" } }), lost: false };
  // "in flight": Stripe has started it and has not finished; the member's subscription still reads as before.
  if (mode === "in flight") return { status: 0, reply: "", lost: true };
  actualPrice = body.get("items[0][price]")!;
  actualConsent = body.get("metadata[dc]") ?? "";
  return { status: 200, reply: JSON.stringify({ ...row(), pending_update: null, latest_invoice: invoice }), lost: mode === "lost response" };
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input)), method = init?.method ?? "GET";
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
  if (url.hostname === "api.resend.com") { emails.push(JSON.parse(String(init?.body))); return json({ id: "synthetic_email" }); }
  if (url.hostname !== "api.stripe.com") throw new Error("Unexpected external request");
  const path = url.pathname.replace(/^\/v1/, ""), body = new URLSearchParams(String(init?.body ?? ""));
  if (method === "GET" && path === "/customers") return json({ object: "list", data: [{ id: customer, created: 1 }], has_more: false });
  if (method === "GET" && path === `/customers/${customer}`) return json({ id: customer, email: "member@example.test" });
  if (method === "GET" && path === "/subscriptions" && slowRead) { redis.advance(slowRead); slowRead = 0; }
  if (method === "GET" && path === "/subscriptions") return json({ object: "list", data: [row()], has_more: false });
  if (method === "POST" && path === "/prices") return json({ id: body.get("recurring[interval]") === "year" ? "price_IdemYearly0001" : "price_IdemTarget0001" });
  if (method === "POST" && path === `/subscriptions/${subscription}`) {
    if (!body.has("items[0][price]")) return json(row());
    const headers = new Headers(init?.headers);
    const key = headers.get("Idempotency-Key") ?? "";
    keysSent.push(key);
    const sent = body.toString();
    const before = key ? kept.get(key) : undefined;
    if (before) {
      if (before.running) return json({ error: { code: "idempotency_key_in_use", type: "invalid_request_error", message: "Synthetic: the first request with this key is still running" } }, 409);
      if (before.body !== sent) return json({ error: { type: "idempotency_error", message: "Synthetic: keys for idempotent requests can only be used with the same parameters" } }, 400);
      return new Response(before.reply, { status: before.status });
    }
    if (slowCharge) { redis.advance(slowCharge); slowCharge = 0; }
    const done = run(body);
    if (key) kept.set(key, { body: sent, running: done.status === 0, status: done.status, reply: done.reply });
    // The update was sent; its answer never reaches onAccount (a timeout or a cut connection).
    if (done.lost) throw new TypeError("Synthetic connection lost after the update was sent");
    return new Response(done.reply, { status: done.status });
  }
  if (method === "POST" && path.startsWith("/invoices/") && path.endsWith("/void")) return json({ id: "in_IdemDeclined0001", status: "void" });
  throw new Error(`Missing synthetic response ${method} ${path}`);
}) as typeof fetch;

/** The 60-second lock running out (its own expiry), as when the first attempt outlived it. */
const lockRunsOut = () => redis.pipeline([["DEL", `nl:tier:${subscription}:lock`]]);

async function main() {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_idem_synthetic_fixture_only";
  // Existing allowlisted synthetic fixture credential; no account credential.
  process.env.RESEND_API_KEY = "re_test_tiers_only";
  const owner = "idem-switch-owner@example.test";
  await claimHandle(owner, "idemswitch", "Synthetic membership", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_1IdemFake0001", true);
  await setSubscription(owner, { customerId: "cus_IdemOwner0001", subscriptionId: "sub_IdemOwner0001", active: true, period: paidPeriod() });
  const monthly = { interval: "month" as const, trialDays: 0, payments: 0 };
  const a = await addProduct(owner, "Basic", "", "20", monthly), b = await addProduct(owner, "Pro", "", "30", monthly);
  if (!a.ok || !b.ok) throw new Error("Missing products");
  product = a.product.id;
  await setProductLink(owner, product, "https://example.test/basic");
  await setProductLink(owner, b.product.id, "https://example.test/pro");
  await setStoreTiers(owner, [product, b.product.id]);
  let store = (await storeForEmail(owner))!;
  const sent = await requestManageLink({ store, email: "member@example.test", ip: "203.0.113.16", origin: "https://example.test" });
  const token = /token=([0-9a-f]{64})/.exec(emails.at(-1)?.text ?? "")?.[1];
  if (sent !== "sent" || !token) throw new Error(`Missing synthetic member token: ${sent}`);

  // Every retry that carries a preview's second is inside the time Stripe keeps a key (at least 24 hours): an older
  // preview is "stale", so a new one is asked, which reads the subscription again before anything is sent.
  is("a preview's second is usable only inside Stripe's idempotency window", PREVIEW_SECONDS < 24 * 3600, true);

  for (const flow of ["tier", "yearly"] as const) {
    if (flow === "yearly") {
      await setStoreTiers(owner, []);
      const yearly = await setProductYearly(owner, product, { cents: 20000 });
      if (!yearly.ok) throw new Error("Missing yearly offer");
      store = (await storeForEmail(owner))!;
    }
    const target = flow === "tier" ? "price_IdemTarget0001" : "price_IdemYearly0001";
    const attempt = (at: number, consentAt: number) => {
      const consent = { version: EU_WITHDRAWAL_CONSENT_VERSION, at: consentAt };
      return flow === "tier" ? switchTier(store, token, subscription, b.product.id, at, consent) : switchYearly(store, token, subscription, at, consent);
    };
    const reset = async (next: typeof mode) => {
      mode = next; executions = 0; keysSent.length = 0; kept.clear(); emails.length = 0;
      actualPrice = "price_IdemMonthly0001"; actualConsent = "";
      await lockRunsOut();
    };
    const reasonOf = (result: { ok: boolean; reason?: string }) => (result.ok ? "applied" : result.reason);
    const expectedKey = (at: number) => `switch:${subscription}:${at}:${target}`;

    // Controls: an answered switch sends the stable key once; a refusal and a decline are said as before.
    for (const control of ["applied", "known rejection", "declined"] as const) {
      await reset(control);
      const result = await attempt(now, now);
      is(`${flow}: control ${control} — result and charges as before`, [reasonOf(result), executions], [control === "applied" ? "applied" : control === "known rejection" ? "error" : "declined", 1]);
      is(`${flow}: control ${control} — sent once with the stable key`, keysSent, [expectedKey(now)]);
    }

    // 1. The first update is still running at Stripe when its answer is given up; the lock runs out; the member sends
    //    the same preview again (a new tick of the EU box, so a new second on the yes). Stripe still reads the old
    //    tier, so the retry passes every check: without a key it is a second charge.
    await reset("in flight");
    const first = await attempt(now, now);
    await lockRunsOut();
    mode = "applied";
    const retry = await attempt(now, now + 3);
    is(`${flow}: timed-out first, retry while it still runs — results`, [reasonOf(first), reasonOf(retry)], ["unconfirmed", "unconfirmed"]);
    is(`${flow}: timed-out first, retry while it still runs — one charge only`, executions, 1);
    is(`${flow}: timed-out first, retry while it still runs — the same stable key both times`, keysSent, [expectedKey(now), expectedKey(now)]);

    // 2. The first update was made, its answer lost; the lock runs out; the same form is sent again: Stripe answers
    //    the first result under the same key, so it is said as made, with one charge.
    await reset("lost response");
    const lost = await attempt(now, now);
    await lockRunsOut();
    const again = await attempt(now, now);
    is(`${flow}: lost answer, same form again — results`, [reasonOf(lost), reasonOf(again)], ["unconfirmed", "applied"]);
    is(`${flow}: lost answer, same form again — one charge only, same key`, [executions, keysSent], [1, [expectedKey(now), expectedKey(now)]]);

    // 3. The first update was made, its answer lost; the yes is ticked again (other parameters under the same key):
    //    Stripe's idempotency_error is not "nothing was changed", it is unconfirmed.
    await reset("lost response");
    await attempt(now, now);
    await lockRunsOut();
    const ticked = await attempt(now, now + 5);
    const words = membershipWords("en").manageNotices;
    const said = ticked.ok ? "" : ticked.reason === "error" || ticked.reason === "unconfirmed" ? words[ticked.reason].body : "";
    is(`${flow}: idempotency_error on a retry — said unconfirmed, never "Nothing was changed."`, [reasonOf(ticked), said.includes("Nothing was changed."), executions], ["unconfirmed", false, 1]);

    // 4. After an unconfirmed answer, a new preview (a new second, so a new key) inside the lock's term finds the lock
    //    still held: "busy", and nothing is sent while the first may still be running at Stripe.
    await reset("in flight");
    await attempt(now, now);
    mode = "applied";
    const fresh = await attempt(now + 30, now + 30);
    is(`${flow}: new preview right after an unconfirmed switch — busy, nothing sent`, [reasonOf(fresh), executions, keysSent.length], ["busy", 1, 1]);
    // 5. Slow reads before the charge (Claude 2 on #3287): the kept lock's term starts again at the unconfirmed answer,
    //    so it covers a full term after the client gave up however long the reads before it took.
    const lockKey = `nl:tier:${subscription}:lock`;
    for (const [reads, label] of [[30_000, "the lock had 10 s left"], [45_000, "the lock had already run out"]] as const) {
      await reset("in flight");
      slowRead = reads;
      slowCharge = 20_000;
      const slow = await attempt(now, now);
      slowRead = 0;
      slowCharge = 0;
      mode = "applied";
      const [left] = await redis.pipeline([["PTTL", lockKey]]);
      is(`${flow}: slow reads, ${label} — unconfirmed, and held a full term from that answer`, [reasonOf(slow), typeof left === "number" && left > 59_000], ["unconfirmed", true]);
      redis.advance(30_000);
      // Another preview of the same switch (its own second, so its own key).
      const later = await attempt(now - 1, now + 1);
      is(`${flow}: slow reads, ${label} — a new preview 30 s on is busy, nothing sent again`, [reasonOf(later), executions], ["busy", 1]);
    }
    is(`${flow}: busy is said honestly`, membershipWords("en").manageNotices.busy.body.includes("look at your membership"), true);
  }
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
