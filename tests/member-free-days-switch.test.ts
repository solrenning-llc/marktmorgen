/**
 * 641 [WG1], second look (Claude 4 team review of #2912, A1; fixed by Claude 4
 * on Claude 5's behalf; fixture from the review's proof, itself from
 * tests/cx1-review-2764-invoice.test.ts). A member who PAID and was given free
 * days reads "trialing" on Stripe. Stripe prorates nothing inside a trial, so
 * a tier switch made then would put the dearer tier on for free until the
 * free days end, and the old code also told the member "You are in your free
 * trial". While a paid member's free days run, a switch of tier or to yearly
 * is refused, with words that say why, and nothing is sent to Stripe; a real
 * free trial still switches as before.
 *
 * Synthetic transport only; no request leaves the process.
 */
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setProductLink, setStoreTiers, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { requestManageLink } from "@/lib/membership-manage";
import { previewSwitch, switchTier } from "@/lib/tier-switch";
import { previewYearly, switchYearly } from "@/lib/yearly-switch";
import { giveFreeDays } from "@/lib/member-free-days";
import { membershipWords } from "@/lib/buyer-words/membership";
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
  // Each customer row holds its own address, the one asked for, as Stripe's exact filter gives it (rule 23: fixture only).
  if (method === "GET" && path === "/customers") return json({ object: "list", data: [{ id: customer, email: "member@example.test", created: 1 }], has_more: false });
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

  part("Control: a paying member with no free days");
  const control = await previewSwitch(store, token, subscription, b.product.id);
  is("the upgrade shows Stripe's prorated amount due", control.ok ? [control.preview.trialing, control.preview.due] : control, [false, 667]);

  part("A paying member given free days");
  const given = await giveFreeDays(store, "member@example.test", subscription, 7, PERIOD_END, { who: owner, role: "owner" }, now);
  is("the free days are given", given.ok, true);
  is("Stripe now says trialing", state.status, "trialing");
  const preview = await previewSwitch(store, token, subscription, b.product.id);
  is("the switch page refuses while the free days run, and says why (never $0, never 'free trial')", preview, { ok: false, reason: "freeDays" });
  emails.length = 0;
  const switched = await switchTier(store, token, subscription, b.product.id, now, consent);
  is("the switch itself is refused the same way", switched, { ok: false, reason: "freeDays" });
  is("nothing was sent to Stripe to switch", chargeRequests, 0);
  is("no receipt says 'You are in your free trial'", emails.some((e) => String(e.text).includes("free trial")), false);
  is("moving to yearly is refused the same way", [why(await previewYearly(store, token, subscription)), why(await switchYearly(store, token, subscription, now, consent))], ["freeDays", "freeDays"]);
  is("nothing was sent to Stripe for yearly either", chargeRequests, 0);
  const languages = ["en", "es", "fr", "de", "it", "nl", "pt"] as const;
  is(
    "the words say so in every language, on the switch page and back on the membership page",
    languages.every((l) => (membershipWords(l).switchProblems.freeDays?.body.length ?? 0) > 40 && (membershipWords(l).manageNotices["free-days"]?.title.length ?? 0) > 10),
    true,
  );

  part("Control: a real free trial still switches as before");
  state.status = "trialing";
  state.trial_end = now + 5 * DAY;
  state.metadata = {};
  const trial = await previewSwitch(store, token, subscription, b.product.id);
  is("in a real trial the switch is offered, nothing to pay now", trial.ok ? [trial.preview.trialing, trial.preview.due] : trial, [true, 0]);
  is("free days given inside a real trial leave it a trial", (await giveFreeDays(store, "member@example.test", subscription, 3, now + 5 * DAY, { who: owner, role: "owner" }, now)).ok, true);
  const trial2 = await previewSwitch(store, token, subscription, b.product.id);
  is("so the switch is still offered as a trial's", trial2.ok ? trial2.preview.trialing : trial2, true);
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
