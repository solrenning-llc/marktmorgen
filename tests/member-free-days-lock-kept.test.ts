/**
 * Claude 4's LOW on #2912 (focal at 89131cc3): giving free days let go of the membership's lock at once even when its
 * Stripe write was not confirmed, so after a timed-out update a switch between plans could take the lock and read the
 * membership before that update landed. A switch that is not confirmed keeps the same lock a full term
 * (lib/tier-switch.ts, keepWhileUnconfirmed); free days now do the same. A write Stripe refused, a write confirmed and
 * a press refused before anything was sent let go of it at once, as before. Synthetic only.
 */
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { giveFreeDays } from "@/lib/member-free-days";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const subscription = "sub_LKMember00001", customer = "cus_LKMember00001";
const LOCK = `nl:tier:${subscription}:lock`;
const DAY = 86_400;
const now = Math.floor(Date.now() / 1000);
const PERIOD_END = now + 20 * DAY;
let product = "";
let mode: "confirmed" | "timeout" | "refused" | "no new date" = "confirmed";
const state: { status: string; trial_end: number | null; metadata: Record<string, string> } = { status: "active", trial_end: null, metadata: {} };
const row = () => ({
  id: subscription, object: "subscription", status: state.status, customer, created: now - 90 * DAY,
  start_date: now - 90 * DAY, trial_end: state.trial_end, discount: null, discounts: [], pause_collection: null,
  metadata: { store: "lkstore", product, ...state.metadata },
  items: { data: [{ id: "si_LKMember00001", quantity: 1, current_period_end: PERIOD_END, price: { id: "price_LKMonthly0001", unit_amount: 2000, currency: "usd", metadata: { product }, recurring: { interval: "month", interval_count: 1 } } }] },
});
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input)), method = init?.method ?? "GET";
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
  if (url.hostname === "api.resend.com") return json({ id: "synthetic_email" });
  if (url.hostname !== "api.stripe.com") throw new Error("Unexpected external request");
  const path = url.pathname.replace(/^\/v1/, ""), body = new URLSearchParams(String(init?.body ?? ""));
  if (method === "GET" && path === "/customers") return json({ object: "list", data: [{ id: customer, created: 1 }], has_more: false });
  if (method === "GET" && path === "/subscriptions") return json({ object: "list", data: [row()], has_more: false });
  if (method === "GET" && path.startsWith("/products")) return json({ object: "list", data: [], has_more: false });
  if (method === "POST" && path === `/subscriptions/${subscription}` && body.has("trial_end")) {
    if (mode === "timeout") throw new Error("the connection was reset after the update was sent");
    if (mode === "refused") return json({ error: { type: "invalid_request_error", message: "No such thing." } }, 400);
    if (mode === "no new date") return json(row());
    // Confirmed, as Stripe applies it: trialing to trial_end, metadata merged, an empty value removing its key.
    state.status = "trialing";
    state.trial_end = Number(body.get("trial_end"));
    for (const [key, value] of body) {
      const name = /^metadata\[(.+)\]$/.exec(key)?.[1];
      if (!name) continue;
      if (value === "") delete state.metadata[name];
      else state.metadata[name] = value;
    }
    return json(row());
  }
  throw new Error(`Missing synthetic response ${method} ${path}`);
}) as typeof fetch;

const held = () => redis.run(["GET", LOCK]) !== null;

async function main() {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_free_days_lock_kept_synthetic_only";
  process.env.RESEND_API_KEY = "re_test_free_days_lock_kept";
  const owner = "free-days-lock-owner@example.test";
  await claimHandle(owner, "lkstore", "Synthetic membership", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1LKFake00001", true);
  await setSubscription(owner, { customerId: "cus_LKOwner00001", subscriptionId: "sub_LKOwner00001", active: true, period: paidPeriod() });
  const made = await addProduct(owner, "Club", "", "20", { interval: "month", trialDays: 0, payments: 0 });
  if (!made.ok) throw new Error("Missing product");
  product = made.product.id;
  const store = (await storeForEmail(owner))!;
  const give = () => giveFreeDays(store, "member@example.test", subscription, 7, PERIOD_END, { who: owner, role: "owner" }, now);
  const reason = (r: Awaited<ReturnType<typeof giveFreeDays>>) => (r.ok ? "ok" : r.reason);

  part("A Stripe write that is not confirmed keeps the membership's lock a full term");
  for (const m of ["timeout", "no new date"] as const) {
    redis.run(["DEL", LOCK]);
    mode = m;
    is(`${m}: not known`, reason(await give()), "unknown");
    is(`${m}: the lock is still held, so a switch waits for the update to land or run out`, held(), true);
  }

  part("Controls: refused, confirmed, or refused before anything was sent, the lock goes at once");
  redis.run(["DEL", LOCK]);
  mode = "refused";
  is("refused by Stripe", reason(await give()), "refused");
  is("and the lock let go", held(), false);
  is("refused before anything was sent (a date that moved)", reason(await giveFreeDays(store, "member@example.test", subscription, 7, PERIOD_END + 1, { who: owner, role: "owner" }, now)), "changed");
  is("and the lock let go", held(), false);
  mode = "confirmed";
  is("confirmed", reason(await give()), "ok");
  is("and the lock let go", held(), false);
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
