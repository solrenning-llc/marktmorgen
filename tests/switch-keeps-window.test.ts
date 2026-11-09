/**
 * A change of billing interval (month <-> year) never opens a second set of
 * monthly allowances in the month it is made (Claude 5, switch-keeps-window,
 * 9 November 2026).
 *
 * Stripe starts a new period on the day of an interval change
 * (lib/billing.ts switchPlan, always_invoice), the switch route and the daily
 * job write it on the store (lib/store.ts setSubscription), and every monthly
 * allowance is counted in a window named by the day its period began
 * (lib/allowance-window.ts). Before this, each switch named a new window, so
 * every counter keyed by it (AI ceiling, store allowances, visits, orders,
 * emails, uploads, video, imports, quizzes) started again full: one switch a
 * day made 31 windows in one paid month, and each plan ran at a loss from
 * about 21 switches. Now the store keeps the window that was open when the
 * period moved (its allowance anchor) and counts in whole months from it.
 *
 * Real code: switchPlan against a Stripe stand-in that does what Stripe
 * documents for an interval change, setSubscription and storeForEmail on the
 * in-memory Redis stand-in, allowanceWindow/windowAt and takeAllowance.
 * Synthetic only: no network, no real subscription, no real store.
 */
import { switchPlan, lookupKey } from "@/lib/billing";
import { PLAN_PRICES, TRIAL_DAYS, type Cycle, type Tier } from "@/lib/plan";
import { addMonthsMs, allowanceWindow, windowAt, windowId, type AllowanceWindow } from "@/lib/allowance-window";
import { takeAllowance } from "@/lib/store-allowance";
import { ALLOWANCE_KINDS, STORE_ALLOWANCES } from "@/lib/store-allowance-rules";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const DAY = 86_400_000;
const START = Date.UTC(2026, 11, 1, 12, 0, 0); // 1 December 2026, 12:00 UTC
let clock = START;
const realNow = Date.now;
Date.now = () => clock;

// ---------- Stripe stand-in: an interval change starts a new period now; the same interval keeps the period ----------
const SUB = "sub_SwitchKeeps0001";
const priceId = (tier: Tier, cycle: Cycle) => `price_${tier}_${cycle}`;
const fromPrice = (id: string) => { const [, tier, cycle] = id.split("_"); return { tier: tier as Tier, cycle: cycle as Cycle }; };
let held: Record<string, unknown> = {};
function subscription(id: string, tier: Tier, cycle: Cycle, startMs: number, status = "active", trialEnd = 0) {
  const endMs = addMonthsMs(startMs, cycle === "year" ? 12 : 1);
  return {
    id, object: "subscription", status, customer: "cus_SwitchKeeps01", cancel_at_period_end: false, cancel_at: null, metadata: { tier },
    ...(trialEnd ? { trial_start: trialEnd - TRIAL_DAYS * 86_400, trial_end: trialEnd } : {}),
    items: { data: [{ id: "si_SwitchKeeps01", quantity: 1, current_period_start: startMs / 1000, current_period_end: endMs / 1000,
      price: { id: priceId(tier, cycle), lookup_key: lookupKey(tier, cycle), unit_amount: PLAN_PRICES[tier][cycle], currency: "usd", recurring: { interval: cycle, interval_count: 1 } } }] },
  };
}
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const body = new URLSearchParams(String(init?.body ?? ""));
  const answer = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
  if (path === "/prices" && method === "GET") {
    const m = /^nimbus_(\w+)_(month|year)$/.exec(url.searchParams.get("lookup_keys[]") ?? "");
    if (!m) return answer({ data: [] });
    const tier = m[1] as Tier, cycle = m[2] as Cycle;
    return answer({ data: [{ id: priceId(tier, cycle), active: true, product: "prod_x", unit_amount: PLAN_PRICES[tier][cycle], currency: "usd", lookup_key: url.searchParams.get("lookup_keys[]"), recurring: { interval: cycle, interval_count: 1 } }] });
  }
  if (path.startsWith("/products/") && method === "GET") return answer({ id: "prod_x", active: true });
  if (path === `/subscriptions/${String(held.id)}` && method === "GET") return answer(held);
  if (path === `/subscriptions/${String(held.id)}` && method === "POST") {
    const price = body.get("items[0][price]");
    if (!price) return answer(held);
    const item = (held.items as { data: Record<string, any>[] }).data[0];
    const old = fromPrice(item.price.id), next = fromPrice(price);
    const trialEnd = Number(body.get("trial_end") ?? 0);
    // Stripe: an interval change resets the billing cycle anchor to now (outside a trial); the same interval keeps the period.
    const start = old.cycle !== next.cycle && !trialEnd ? clock : item.current_period_start * 1000;
    held = subscription(String(held.id), next.tier, next.cycle, start, String(held.status), trialEnd);
    return answer(held);
  }
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

// ---------- the store, written as the switch route writes it (app/api/billing/switch/route.ts) ----------
let n = 0;
async function newStore(tier: Tier, cycle: Cycle, subId = SUB): Promise<string> {
  n += 1;
  const owner = `switch-keeps-${n}@example.test`;
  await claimHandle(owner, `switchkeeps${n}`, "Switch keeps shop", "");
  await ensureStatsId(owner);
  held = subscription(subId, tier, cycle, clock);
  const item = (held.items as { data: Record<string, any>[] }).data[0];
  await setSubscription(owner, { customerId: "cus_SwitchKeeps01", subscriptionId: subId, active: true, tier, cycle, trialEnds: 0, shared: false,
    period: { start: item.current_period_start, end: item.current_period_end, renews: true } });
  return owner;
}
async function switchTo(owner: string, tier: Tier, cycle: Cycle): Promise<Store> {
  const before = (await storeForEmail(owner))!;
  const result = await switchPlan(before.subscriptionId!, { tier, cycle });
  if (result.kind !== "switched" || result.state.state !== "active") throw new Error("switch refused: " + JSON.stringify(result));
  const state = result.state;
  const written = await setSubscription(owner, { active: true, tier: state.tier, cycle: state.cycle, trialEnds: state.trialing ? state.until : 0, shared: state.shared, period: state.period });
  if (!written) throw new Error("the switched plan was not written");
  return (await storeForEmail(owner))!;
}
/** Takes every store allowance kind whole; how many were granted whole. */
async function drain(store: Store): Promise<number> {
  let whole = 0;
  for (const kind of ALLOWANCE_KINDS) if ((await takeAllowance(store, kind, STORE_ALLOWANCES[store.tier][kind], clock)).ok) whole += 1;
  return whole;
}
const shape = (w: AllowanceWindow | null) => w && { id: w.id, start: new Date(w.start).toISOString(), end: new Date(w.end).toISOString() };

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_switch_keeps_stand_in";
  try {
    part("1. One switch a day for 31 days, per plan: one allowance per month paid, never one per switch");
    for (const tier of ["creator", "pro", "scale"] as const) {
      redis.clear();
      clock = START;
      const owner = await newStore(tier, "month");
      let store = (await storeForEmail(owner))!;
      const windows = new Set<string>([windowId(store, clock)!]);
      let whole = await drain(store);
      const wholeByWindow = new Map<string, number>([[windowId(store, clock)!, whole]]);
      for (let k = 1; k <= 31; k += 1) {
        clock = START + k * DAY;
        store = await switchTo(owner, tier, store.cycle === "month" ? "year" : "month");
        const id = windowId(store, clock);
        if (!id) throw new Error(`no window after switch ${k}`);
        windows.add(id);
        const got = await drain(store);
        whole += got;
        wholeByWindow.set(id, (wholeByWindow.get(id) ?? 0) + got);
      }
      is(`${tier}: the 31 switches name only December's window and January's`, [...windows], ["2026-12-01", "2027-01-01"]);
      is(`${tier}: every allowance kind is given whole once per window, never again after a switch`, Object.fromEntries(wholeByWindow), { "2026-12-01": 8, "2027-01-01": 8 });
      is(`${tier}: allowance kinds given whole in 32 days`, whole, 16);
      // January's window starts where December's ended and is a whole month: no short window, no third allowance.
      is(`${tier}: January's window is the whole month after December's`, shape(allowanceWindow(store, clock)),
        { id: "2027-01-01", start: "2027-01-01T12:00:00.000Z", end: "2027-02-01T12:00:00.000Z" });
      is(`${tier}: a projection agrees with the window counted now`, windowAt(store, clock + 3 * DAY)?.id, "2027-01-01");
    }

    part("2. One switch, either way, mid-window: the open window runs to its end, then whole months follow it");
    for (const [from, to] of [["month", "year"], ["year", "month"]] as const) {
      redis.clear();
      clock = START;
      const owner = await newStore("scale", from);
      const before = allowanceWindow((await storeForEmail(owner))!, clock + 9 * DAY)!;
      clock = START + 9 * DAY;
      const after = await switchTo(owner, "scale", to);
      is(`${from} -> ${to}: the period moved to the day of the switch`, after.period?.start, clock / 1000);
      is(`${from} -> ${to}: the window open before the switch is still the one counted`, shape(allowanceWindow(after, clock)), shape(before));
      is(`${from} -> ${to}: and it ends on its own day, not the new period's`, shape(allowanceWindow(after, Date.UTC(2026, 11, 31, 12))), shape(before));
      is(`${from} -> ${to}: the next window starts exactly at its end and lasts a month`, shape(allowanceWindow(after, Date.UTC(2027, 0, 1, 12))),
        { id: "2027-01-01", start: "2027-01-01T12:00:00.000Z", end: "2027-02-01T12:00:00.000Z" });
      // Either side of the new period's own day (the 10th; a monthly period then renews, in its grace): still January's window.
      is(`${from} -> ${to}: the new period's own day (the 10th) names no window`, [Date.UTC(2027, 0, 9, 13), Date.UTC(2027, 0, 10, 13)].map((t) => windowId(after, t)), ["2027-01-01", "2027-01-01"]);
    }

    part("3. What does not move the window, and what starts a new one");
    redis.clear();
    clock = START;
    let owner = await newStore("creator", "month");
    clock = START + 5 * DAY;
    let after = await switchTo(owner, "pro", "month");
    is("a plan change within the same interval keeps the period and writes no anchor", [after.period?.start, after.allowanceAnchor ?? null], [START / 1000, null]);
    is("its window is the one the period always had", windowId(after, clock), "2026-12-01");
    // A new subscription (a cancelled plan, then a new one paid in full) follows its own period: the anchor was another's.
    clock = START + 6 * DAY;
    after = await switchTo(owner, "pro", "year");
    is("the switch wrote an anchor bound to its subscription", after.allowanceAnchor?.subscriptionId, SUB);
    held = subscription("sub_SwitchKeeps0002", "creator", "month", clock);
    const fresh = (held.items as { data: Record<string, any>[] }).data[0];
    await setSubscription(owner, { subscriptionId: "sub_SwitchKeeps0002", active: true, tier: "creator", cycle: "month", trialEnds: 0, shared: false,
      period: { start: fresh.current_period_start, end: fresh.current_period_end, renews: true } });
    after = (await storeForEmail(owner))!;
    is("a new subscription drops the old anchor and counts in its own period", [after.allowanceAnchor ?? null, windowId(after, clock)], [null, "2026-12-07"]);
    // A plan that stops and runs again on the same subscription keeps its anchor: no fresh window by going through inactive.
    clock = START + 7 * DAY;
    after = await switchTo(owner, "creator", "year");
    const anchored = windowId(after, clock);
    await setSubscription(owner, { active: false });
    const item = (held.items as { data: Record<string, any>[] }).data[0];
    await setSubscription(owner, { active: true, tier: "creator", cycle: "year", trialEnds: 0, shared: false, period: { start: item.current_period_start, end: item.current_period_end, renews: true } });
    after = (await storeForEmail(owner))!;
    is("a plan seen stopped and running again on the same subscription keeps the window it had", windowId(after, clock), anchored);

    part("4. A trial: a switch inside it writes nothing, and its end starts the paid period as before");
    redis.clear();
    clock = START;
    owner = `switch-keeps-trial@example.test`;
    await claimHandle(owner, "switchkeepstrial", "Switch keeps trial", "");
    await ensureStatsId(owner);
    const trialEnd = clock / 1000 + TRIAL_DAYS * 86_400;
    held = subscription("sub_SwitchKeepsT001", "creator", "month", clock, "trialing", trialEnd);
    await setSubscription(owner, { customerId: "cus_SwitchKeeps01", subscriptionId: "sub_SwitchKeepsT001", active: true, tier: "creator", cycle: "month", trialEnds: trialEnd, shared: false, period: null });
    clock = START + 3 * DAY;
    const switched = await switchPlan("sub_SwitchKeepsT001", { tier: "creator", cycle: "year" });
    if (switched.kind !== "switched" || switched.state.state !== "active") throw new Error("trial switch refused");
    await setSubscription(owner, { active: true, tier: "creator", cycle: "year", trialEnds: switched.state.until, shared: false, period: switched.state.period });
    after = (await storeForEmail(owner))!;
    is("a switch inside the trial writes no anchor", after.allowanceAnchor ?? null, null);
    clock = trialEnd * 1000 + 3_600_000;
    await setSubscription(owner, { active: true, tier: "creator", cycle: "year", trialEnds: 0, shared: false, period: { start: trialEnd, end: addMonthsMs(trialEnd * 1000, 12) / 1000, renews: true } });
    after = (await storeForEmail(owner))!;
    is("the first paid month starts at the trial's end", [after.allowanceAnchor ?? null, shape(allowanceWindow(after, clock))?.start], [null, new Date(trialEnd * 1000).toISOString()]);

    part("5. Unknown never opens a window: a stale period, an anchor that cannot be read");
    redis.clear();
    clock = START;
    owner = await newStore("pro", "month");
    let store = (await storeForEmail(owner))!;
    // The snapshot missed the 1 January renewal; the switch on 10 January is the first thing written since.
    clock = Date.UTC(2027, 0, 10, 12);
    is("the stale snapshot has no window past its grace", windowId(store, clock), null);
    held = subscription(SUB, "pro", "month", Date.UTC(2027, 0, 1, 12));
    store = await switchTo(owner, "pro", "year");
    is("a switch written over a stale snapshot keeps the window its renewal opened", shape(allowanceWindow(store, clock)),
      { id: "2027-01-01", start: "2027-01-01T12:00:00.000Z", end: "2027-02-01T12:00:00.000Z" });
    const unreadable = { ...store, allowanceAnchor: { subscriptionId: SUB, start: "soon", end: 0 } as unknown as Store["allowanceAnchor"] };
    is("an anchor that cannot be read lets in to nothing", [allowanceWindow(unreadable, clock), windowAt(unreadable, clock + DAY)], [null, null]);
    is("and a cost asked for under it is refused", (await takeAllowance(unreadable, "studio", 1, clock)).ok, false);
  } finally {
    Date.now = realNow;
  }
  done();
}
void main();
