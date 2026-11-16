/**
 * 641 [WG1], concurrency (Codex V on #2912, comment 6751485510, MEDIUM). Free
 * days given to a paid member read "trialing" on Stripe, and a switch of tier
 * or to yearly is refused while they run (tests/member-free-days-switch.test.ts).
 * That refusal held only one press after another: a switch read the
 * membership as running, then waited on Stripe to make the new tier's price,
 * and in that wait the creator's free days landed; the switch then sent its
 * charging update anyway and told the member it was done. The same gap let
 * free days land on a membership whose pause was being set.
 *
 * Giving free days now takes the membership's own lock (nl:tier:<sub>:lock),
 * the one the switches, the yearly move and the pause already share, so each
 * change reads the membership after the one before it landed. Checked here,
 * with Stripe held in the middle of each change:
 *
 *   - a tier switch waiting on its price: no charging update is sent after
 *     the free days were given, the switch is not "ok" over them, and no
 *     receipt says it was made over them;
 *   - the same for the move to yearly;
 *   - a pause being set: the membership never ends up both paused and in
 *     paid free days;
 *   - controls: the free days are still given once the other change is done,
 *     with their marks, and a lock held by somebody else for longer than the
 *     wait refuses as "busy" with nothing sent.
 *
 * Synthetic transport only; no request leaves the process.
 */
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setPauseMonths, setProductLink, setProductYearly, setStoreTiers, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { requestManageLink } from "@/lib/membership-manage";
import { switchTier } from "@/lib/tier-switch";
import { switchYearly } from "@/lib/yearly-switch";
import { pauseMembership } from "@/lib/membership-pause";
import { giveFreeDays } from "@/lib/member-free-days";
import { FREE_DAYS_UNTIL, TRIAL_END_BEFORE } from "@/lib/member-free-days-rules";
import { membershipWords } from "@/lib/buyer-words/membership";
import { EU_WITHDRAWAL_CONSENT_VERSION } from "@/lib/digital-consent";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const emails: { to: string | string[]; subject: string; text: string }[] = [];
const subscription = "sub_RaceMember0001", customer = "cus_RaceMember0001";
const DAY = 86_400;
const now = Math.floor(Date.now() / 1000);
const consent = { version: EU_WITHDRAWAL_CONSENT_VERSION, at: now };
let product = "";
/** What reached Stripe or the member, in the order it landed. */
const log: string[] = [];
// The subscription as Stripe holds it, changed only by what is posted to it.
const state: { status: string; trial_end: number | null; periodEnd: number; pause: Record<string, unknown> | null; metadata: Record<string, string> } = {
  status: "active", trial_end: null, periodEnd: now + 20 * DAY, pause: null, metadata: {},
};
const row = () => ({
  id: subscription, object: "subscription", status: state.status, customer, created: now - 90 * DAY,
  start_date: now - 90 * DAY, trial_end: state.trial_end, discount: null, discounts: [], pause_collection: state.pause,
  metadata: { store: "racefree", product, ...state.metadata },
  items: { data: [{ id: "si_RaceMember0001", quantity: 1, current_period_end: state.periodEnd, price: { id: "price_RaceMonthly0001", unit_amount: 2000, currency: "usd", metadata: { product }, recurring: { interval: "month", interval_count: 1 } } }] },
});

type Hold = { gate: Promise<void>; arrived: () => void };
/** A Stripe request held until the test lets it go: "prices" (a switch's new price), "pause" (setting a pause). */
const holds: { prices: Hold | null; pause: Hold | null } = { prices: null, pause: null };
function hold(which: keyof typeof holds): { arrived: Promise<void>; release: () => void } {
  let release = () => {};
  let arrived = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const reached = new Promise<void>((resolve) => (arrived = resolve));
  holds[which] = { gate, arrived };
  return { arrived: reached, release: () => { holds[which] = null; release(); } };
}
async function waitAt(which: keyof typeof holds) {
  const h = holds[which];
  if (!h) return;
  h.arrived();
  await h.gate;
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input)), method = init?.method ?? "GET";
  const json = (value: unknown) => new Response(JSON.stringify(value));
  if (url.hostname === "api.resend.com") {
    const sent = JSON.parse(String(init?.body));
    emails.push(sent);
    log.push(`email:${sent.subject}`);
    return json({ id: "synthetic_email" });
  }
  if (url.hostname !== "api.stripe.com") throw new Error("Unexpected external request");
  const path = url.pathname.replace(/^\/v1/, ""), body = new URLSearchParams(String(init?.body ?? ""));
  if (method === "GET" && path === "/customers") return json({ object: "list", data: [{ id: customer, created: 1 }], has_more: false });
  if (method === "GET" && path === `/customers/${customer}`) return json({ id: customer, email: "member@example.test" });
  if (method === "GET" && path === "/subscriptions") return json({ object: "list", data: [row()], has_more: false });
  if (method === "GET" && path.startsWith("/products")) return json({ object: "list", data: [], has_more: false });
  if (method === "POST" && path === "/prices") {
    await waitAt("prices");
    return json({ id: "price_RaceTarget0001" });
  }
  if (method === "POST" && path === `/subscriptions/${subscription}`) {
    if (body.has("pause_collection[behavior]")) {
      await waitAt("pause");
      state.pause = { behavior: body.get("pause_collection[behavior]"), resumes_at: Number(body.get("pause_collection[resumes_at]")) };
      for (const name of ["pause_from", "paused_at"]) state.metadata[name] = String(body.get(`metadata[${name}]`));
      log.push("pause");
      return json(row());
    }
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
      log.push("free-days");
      return json(row());
    }
    if (!body.has("items[0][price]")) return json(row());
    log.push("charge");
    return json({ ...row(), pending_update: null, items: { data: [{ id: "si_RaceMember0001", price: { id: body.get("items[0][price]") } }] }, metadata: { ...row().metadata, ...(body.get("metadata[dc]") ? { dc: body.get("metadata[dc]") } : {}) }, latest_invoice: { id: "in_RacePaid0001", status: "paid", total: 667, amount_paid: 667, currency: "usd" } });
  }
  throw new Error(`Missing synthetic response ${method} ${path}`);
}) as typeof fetch;

/** The membership running and paid again, with a next charge no earlier press has claimed. */
function fresh(periodEnd: number) {
  Object.assign(state, { status: "active", trial_end: null, periodEnd, pause: null, metadata: {} });
  log.length = 0;
  emails.length = 0;
}
/** Lets the other press run for a moment while the first is held: long enough to finish, if nothing stops it. */
const aMoment = () => new Promise((resolve) => setTimeout(resolve, 400));
/** Whether something landed after the free days did. */
const after = (what: string) => log.includes("free-days") && log.lastIndexOf(what) > log.indexOf("free-days");

async function main() {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_free_days_race_synthetic_only";
  process.env.RESEND_API_KEY = "re_test_tiers_only";
  const owner = "free-days-race-owner@example.test";
  await claimHandle(owner, "racefree", "Synthetic membership", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1RaceFake0001", true);
  await setSubscription(owner, { customerId: "cus_RaceOwner0001", subscriptionId: "sub_RaceOwner0001", active: true, period: paidPeriod() });
  const monthly = { interval: "month" as const, trialDays: 0, payments: 0 };
  const a = await addProduct(owner, "Basic", "", "20", monthly), b = await addProduct(owner, "Pro", "", "30", monthly);
  if (!a.ok || !b.ok) throw new Error("Missing products");
  product = a.product.id;
  await setProductLink(owner, product, "https://example.test/basic");
  await setProductLink(owner, b.product.id, "https://example.test/pro");
  await setStoreTiers(owner, [product, b.product.id]);
  let store = (await storeForEmail(owner))!;
  const sent = await requestManageLink({ store, email: "member@example.test", ip: "203.0.113.16", origin: "https://example.test" });
  const token = /token=([0-9a-f]{64})/.exec(String(emails.at(-1)?.text ?? ""))?.[1];
  if (sent !== "sent" || !token) throw new Error(`no token: ${sent} ${emails.length}`);
  const by = { who: owner, role: "owner" as const };
  const switchedSubject = membershipWords(store.language).switchedSubject("Pro");

  part("A tier switch waiting on Stripe for its price while the creator gives free days");
  fresh(now + 20 * DAY);
  {
    const held = hold("prices");
    const switching = switchTier(store, token, subscription, b.product.id, now, consent);
    await held.arrived;
    const giving = giveFreeDays(store, "member@example.test", subscription, 7, state.periodEnd, by, now);
    await aMoment();
    held.release();
    const [switched, given] = await Promise.all([switching, giving]);
    is("no charging update reaches Stripe after the free days were given", after("charge"), false);
    is("the switch is not 'ok' over free days given while it waited", switched.ok && log.indexOf("charge") > log.indexOf("free-days") && log.includes("free-days"), false);
    is("no receipt tells the member the switch was made over their free days", after(`email:${switchedSubject}`), false);
    is("control: the free days are given, once the switch is done", given.ok, true);
    is(
      "control: Stripe holds the free days and their marks (paid membership, no real trial before)",
      [state.status, state.trial_end, state.metadata[FREE_DAYS_UNTIL], state.metadata[TRIAL_END_BEFORE]],
      ["trialing", now + 27 * DAY, String(now + 27 * DAY), "0"],
    );
  }

  part("A move to yearly waiting on Stripe for its price while the creator gives free days");
  await setStoreTiers(owner, []);
  const yearly = await setProductYearly(owner, product, { cents: 20000 });
  if (!yearly.ok) throw new Error("no yearly price");
  store = (await storeForEmail(owner))!;
  fresh(now + 21 * DAY);
  {
    const held = hold("prices");
    const moving = switchYearly(store, token, subscription, now, consent);
    await held.arrived;
    const giving = giveFreeDays(store, "member@example.test", subscription, 5, state.periodEnd, by, now);
    await aMoment();
    held.release();
    const [moved, given] = await Promise.all([moving, giving]);
    is("no charging update reaches Stripe after the free days were given", after("charge"), false);
    is("the move is not 'ok' over free days given while it waited", moved.ok && log.indexOf("charge") > log.indexOf("free-days") && log.includes("free-days"), false);
    is("control: the free days are given, once the move is done", [given.ok, state.trial_end, state.metadata[FREE_DAYS_UNTIL]], [true, now + 26 * DAY, String(now + 26 * DAY)]);
  }

  part("A pause being set while the creator gives free days");
  await setPauseMonths(owner, 3);
  store = (await storeForEmail(owner))!;
  fresh(now + 22 * DAY);
  {
    const held = hold("pause");
    const pausing = pauseMembership(store, token, subscription, 1, now);
    await held.arrived;
    const giving = giveFreeDays(store, "member@example.test", subscription, 7, state.periodEnd, by, now);
    await aMoment();
    held.release();
    const [paused, given] = await Promise.all([pausing, giving]);
    is("control: the pause is set", paused.ok, true);
    is("the membership is never both paused and in paid free days", Boolean(state.pause) && state.status === "trialing", false);
    is("the free days are refused for the pause, read after it landed", given, { ok: false, reason: "blocked", blocked: "paused" });
    is("nothing was sent to Stripe for them", log.includes("free-days"), false);
  }

  part("Control: the membership's lock held longer than the wait refuses as busy, with nothing sent");
  fresh(now + 23 * DAY);
  await redis.pipeline([["SET", `nl:tier:${subscription}:lock`, "somebody-else", "EX", 60]]);
  const busy = await giveFreeDays(store, "member@example.test", subscription, 7, state.periodEnd, by, now);
  is("busy", busy, { ok: false, reason: "busy" });
  is("nothing was sent to Stripe or the member", [log, state.status], [[], "active"]);
  await redis.pipeline([["DEL", `nl:tier:${subscription}:lock`]]);
  is("once it is let go, the same free days go through", (await giveFreeDays(store, "member@example.test", subscription, 7, state.periodEnd, by, now)).ok, true);
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
