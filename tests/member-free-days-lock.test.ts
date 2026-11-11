/**
 * Codex V's MEDIUM on #2912 (6751485510): giving a member free days did not take the membership's lock that a switch
 * between plans (lib/tier-switch.ts), to yearly and a pause take, so a switch that had read the membership as having
 * no free days could go on and charge after free days were given in between, and the free days crossed the guard
 * that refuses a switch while they run. Now giving free days runs under the same lock, across its fresh read and its
 * write: while a switch holds it, the press answers "busy" and nothing is given. Synthetic only.
 */
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setProductLink, setStoreTiers, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { requestManageLink } from "@/lib/membership-manage";
import { switchTier } from "@/lib/tier-switch";
import { giveFreeDays } from "@/lib/member-free-days";
import { EU_WITHDRAWAL_CONSENT_VERSION } from "@/lib/digital-consent";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const emails: { to: string | string[]; text: string }[] = [];
const subscription = "sub_CX1Member0001", customer = "cus_CX1Member0001";
const DAY = 86_400;
const now = Math.floor(Date.now() / 1000);
const PERIOD_END = now + 20 * DAY;
const consent = { version: EU_WITHDRAWAL_CONSENT_VERSION, at: now };
let product = "";
let chargeRequests = 0;
let duringSwitch: (() => Promise<void>) | null = null;
const why = (result: { ok: boolean }) => ("reason" in result ? String((result as { reason: unknown }).reason) : "ok");
// The subscription as Stripe holds it, changed only by what is posted to it.
const state: { status: string; trial_end: number | null; metadata: Record<string, string> } = { status: "active", trial_end: null, metadata: {} };
const row = () => ({
  id: subscription, object: "subscription", status: state.status, customer, created: now - 90 * DAY,
  start_date: now - 90 * DAY, trial_end: state.trial_end, discount: null, discounts: [], pause_collection: null,
  metadata: { store: "cx1switch", product, ...state.metadata },
  items: { data: [{ id: "si_CX1Member0001", quantity: 1, current_period_end: PERIOD_END, price: { id: "price_CX1Monthly0001", unit_amount: 2000, currency: "usd", metadata: { product }, recurring: { interval: "month", interval_count: 1 } } }] },
});
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input)), method = init?.method ?? "GET";
  const json = (value: unknown) => new Response(JSON.stringify(value));
  if (url.hostname === "api.resend.com") { emails.push(JSON.parse(String(init?.body))); return json({ id: "synthetic_email" }); }
  if (url.hostname !== "api.stripe.com") throw new Error("Unexpected external request");
  const path = url.pathname.replace(/^\/v1/, ""), body = new URLSearchParams(String(init?.body ?? ""));
  if (method === "GET" && path === "/customers") return json({ object: "list", data: [{ id: customer, created: 1 }], has_more: false });
  if (method === "GET" && path === `/customers/${customer}`) return json({ id: customer, email: "member@example.test" });
  if (method === "GET" && path === "/subscriptions") return json({ object: "list", data: [row()], has_more: false });
  if (method === "GET" && path.startsWith("/products")) return json({ object: "list", data: [], has_more: false });
  if (method === "POST" && path === "/prices") return json({ id: "price_CX1Target0001" });
  if (method === "POST" && path === "/invoices/create_preview") return json({ currency: "usd", starting_balance: 0, lines: { object: "list", has_more: false, data: [{ amount: 667, proration: true, period: { start: Number(body.get("subscription_details[proration_date]")) } }] } });
  if (method === "POST" && path === `/subscriptions/${subscription}`) {
    if (body.has("trial_end")) {
      // Free days, as Stripe applies them: trialing to trial_end, metadata merged, an empty value removing its key.
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
    if (!body.has("items[0][price]")) return json(row());
    // The switch's own write, after it read the membership as having no free days: the creator presses
    // "Give free days" in this very moment (Codex V's interleaving on #2912).
    if (duringSwitch) await duringSwitch();
    chargeRequests++;
    return json({ ...row(), pending_update: null, items: { data: [{ id: "si_CX1Member0001", price: { id: body.get("items[0][price]") } }] }, metadata: { ...row().metadata, ...(body.get("metadata[dc]") ? { dc: body.get("metadata[dc]") } : {}) }, latest_invoice: { id: "in_CX1Paid0001", status: "paid", total: 667, amount_paid: 667, currency: "usd" } });
  }
  throw new Error(`Missing synthetic response ${method} ${path}`);
}) as typeof fetch;

async function main() {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_free_days_switch_synthetic_only";
  process.env.RESEND_API_KEY = "re_test_tiers_only";
  const owner = "free-days-switch-owner@example.test";
  await claimHandle(owner, "cx1switch", "Synthetic membership", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1CX1Fake0001", true);
  await setSubscription(owner, { customerId: "cus_CX1Owner0001", subscriptionId: "sub_CX1Owner0001", active: true, period: paidPeriod() });
  const monthly = { interval: "month" as const, trialDays: 0, payments: 0 };
  const a = await addProduct(owner, "Basic", "", "20", monthly), b = await addProduct(owner, "Pro", "", "30", monthly);
  if (!a.ok || !b.ok) throw new Error("Missing products");
  product = a.product.id;
  await setProductLink(owner, product, "https://example.test/basic");
  await setProductLink(owner, b.product.id, "https://example.test/pro");
  await setStoreTiers(owner, [product, b.product.id]);
  const store = (await storeForEmail(owner))!;
  const sent = await requestManageLink({ store, email: "member@example.test", ip: "203.0.113.15", origin: "https://example.test" });
  const token = /token=([0-9a-f]{64})/.exec(String(emails.at(-1)?.text ?? ""))?.[1];
  if (sent !== "sent" || !token) throw new Error("no token");

  part("Free days pressed while a switch between plans is writing: never both");
  let given: Awaited<ReturnType<typeof giveFreeDays>> | null = null;
  duringSwitch = async () => {
    duringSwitch = null;
    given = await giveFreeDays(store, "member@example.test", subscription, 7, PERIOD_END, { who: owner, role: "owner" }, now);
  };
  const switched = await switchTier(store, token, subscription, b.product.id, now, consent);
  const outcome = given as Awaited<ReturnType<typeof giveFreeDays>> | null;
  is("the switch went through", switched.ok, true);
  is("the free days pressed meanwhile are refused as busy, never given", outcome ? why(outcome) : "not pressed", "busy");
  is("so Stripe holds no free days on the switched membership", [state.status, state.metadata.free_days ?? null], ["active", null]);

  part("Control: with no switch under way, free days are given");
  is("given", (await giveFreeDays(store, "member@example.test", subscription, 7, PERIOD_END, { who: owner, role: "owner" }, now)).ok, true);
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
