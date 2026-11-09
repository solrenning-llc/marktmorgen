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
import { addMonthsMs, allowanceWindow, anchorAfter, windowAt, windowId, type AllowanceWindow } from "@/lib/allowance-window";
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
/** The one item of a stand-in subscription, with the fields read here. */
type Item = { current_period_start: number; current_period_end: number; price: { id: string } };
const itemOf = (subscription: Record<string, unknown>): Item => (subscription.items as { data: Item[] }).data[0];
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
    const item = itemOf(held);
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
  const item = itemOf(held);
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
    const fresh = itemOf(held);
    await setSubscription(owner, { subscriptionId: "sub_SwitchKeeps0002", active: true, tier: "creator", cycle: "month", trialEnds: 0, shared: false,
      period: { start: fresh.current_period_start, end: fresh.current_period_end, renews: true } });
    after = (await storeForEmail(owner))!;
    is("a new subscription drops the old anchor and counts in its own period", [after.allowanceAnchor ?? null, windowId(after, clock)], [null, "2026-12-07"]);
    // A plan that stops and runs again on the same subscription keeps its anchor: no fresh window by going through inactive.
    clock = START + 7 * DAY;
    after = await switchTo(owner, "creator", "year");
    const anchored = windowId(after, clock);
    await setSubscription(owner, { active: false });
    const item = itemOf(held);
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
    const moved = { ...unreadable, cycle: "month" as const, period: { start: clock / 1000, end: addMonthsMs(clock, 1) / 1000, renews: true } };
    is("a later write of the same subscription keeps it as read, never drops it to the period's window", anchorAfter(unreadable, moved, clock), unreadable.allowanceAnchor);
    is("another subscription leaves it behind", anchorAfter(unreadable, { ...moved, subscriptionId: "sub_SwitchKeeps0009" }, clock), null);

    part("6. The months after an anchor are cut as Stripe cuts them, from the anchor's day");
    // A yearly plan begun on 31 January, switched to monthly on 10 February: its window of 31 January to 28 February runs
    // on, and then 28 February to 31 March and 31 March to 30 April, never a month from a cut 28th.
    const jan31 = Date.UTC(2027, 0, 31, 9);
    const yearly = { subscriptionActive: true, subscriptionId: SUB, trialEnds: 0, planEndedAt: "", cycle: "year" as const,
      period: { start: jan31 / 1000, end: addMonthsMs(jan31, 12) / 1000, renews: true } };
    const switchedAt = Date.UTC(2027, 1, 10, 9);
    const monthly = { ...yearly, cycle: "month" as const, period: { start: switchedAt / 1000, end: addMonthsMs(switchedAt, 1) / 1000, renews: true } };
    const cut = { ...monthly, allowanceAnchor: anchorAfter(yearly, monthly, switchedAt) };
    is("the anchor is the open yearly month", cut.allowanceAnchor, { subscriptionId: SUB, start: jan31, end: Date.UTC(2027, 1, 28, 9) });
    is("then whole months from the anchor's day", [Date.UTC(2027, 1, 27), Date.UTC(2027, 2, 1), Date.UTC(2027, 3, 1)].map((t) => shape(allowanceWindow({ ...cut, period: { start: switchedAt / 1000, end: addMonthsMs(switchedAt, 3) / 1000, renews: true } }, t))),
      [{ id: "2027-01-31", start: "2027-01-31T09:00:00.000Z", end: "2027-02-28T09:00:00.000Z" },
        { id: "2027-02-28", start: "2027-02-28T09:00:00.000Z", end: "2027-03-31T09:00:00.000Z" },
        { id: "2027-03-31", start: "2027-03-31T09:00:00.000Z", end: "2027-04-30T09:00:00.000Z" }]);
    is("a renewal of the same subscription writes no other anchor", anchorAfter(cut, { ...cut, period: { start: monthly.period.end, end: addMonthsMs(monthly.period.end * 1000, 1) / 1000, renews: true } }, monthly.period.end * 1000 + 60_000), cut.allowanceAnchor);
    is("past a period that does not renew, its anchor opens nothing", allowanceWindow({ ...cut, period: { ...monthly.period, renews: false } }, monthly.period.end * 1000 + 60_000), null);

    // Periods as Stripe sends them, and a plan written as the daily job writes it.
    const per = (startMs: number, months: number, renews = true) => ({ start: startMs / 1000, end: addMonthsMs(startMs, months) / 1000, renews });
    const plan = (cycle: Cycle, period: ReturnType<typeof per>) => ({ active: true, tier: "scale" as const, cycle, trialEnds: 0, shared: false, period });
    const read = async () => (await storeForEmail(owner))!;
    // A yearly plan begun 1 December, switched to monthly on 10 December (anchor: December's yearly month, from the 1st),
    // renewed and paid on 10 January.
    const switchedOn10December = async () => {
      redis.clear();
      clock = START;
      owner = await newStore("scale", "year");
      clock = Date.UTC(2026, 11, 10, 12);
      await setSubscription(owner, plan("month", per(clock, 1)));
      clock = Date.UTC(2027, 0, 10, 12);
      await setSubscription(owner, plan("month", per(clock, 1)));
    };

    part("7. A plan stopped and paid again on the same subscription: one payment, one window, and nothing used opens again");
    await switchedOn10December();
    is("7a: the switch kept December's yearly month", (await read()).allowanceAnchor, { subscriptionId: SUB, start: START, end: Date.UTC(2027, 0, 1, 12) });
    // The 10 February renewal is not paid: Stripe says unpaid, the plan stops. On 20 March the creator pays only the
    // latest invoice (10 March to 10 April); February's stays open. Same subscription.
    clock = Date.UTC(2027, 1, 12, 12);
    await setSubscription(owner, { active: false });
    clock = Date.UTC(2027, 2, 20, 12);
    await setSubscription(owner, plan("month", per(Date.UTC(2027, 2, 10, 12), 1, false)));
    const idsA = new Set<string>();
    let wholeA = 0;
    for (const at of [Date.UTC(2027, 2, 20, 12), Date.UTC(2027, 3, 5, 12)]) { // both inside the one period paid
      clock = at;
      store = await read();
      idsA.add(String(windowId(store, clock)));
      wholeA += await drain(store);
    }
    is("7a: a payment after a skipped period (10 March to 10 April) opens one window, its own", [...idsA], ["2027-03-10"]);
    is("7a: and gives each allowance kind whole once", wholeA, 8);
    is("7a: the anchor is left behind", store.allowanceAnchor ?? null, null);

    // The overdue invoice itself is paid (10 February to 10 March): no period skipped, the window used before the stop goes on.
    await switchedOn10December();
    clock = Date.UTC(2027, 1, 5, 12);
    store = await read();
    is("7b: early February counts in the anchor's month", [windowId(store, clock), await drain(store)], ["2027-02-01", 8]);
    clock = Date.UTC(2027, 1, 12, 12);
    await setSubscription(owner, { active: false });
    clock = Date.UTC(2027, 1, 20, 12);
    await setSubscription(owner, plan("month", per(Date.UTC(2027, 1, 10, 12), 1)));
    store = await read();
    is("7b: paying the overdue period keeps the window used before the stop, and what was used stays used", [windowId(store, clock), await drain(store)], ["2027-02-01", 0]);
    clock = Date.UTC(2027, 2, 5, 12);
    store = await read();
    is("7b: the next window is the anchor's next month, whole", [windowId(store, clock), await drain(store)], ["2027-03-01", 8]);

    // The plan is seen stopped only on 5 March, after March's window of the anchor was counted in; then a later period
    // is paid. The window that holds its first day was used before the stop: it goes on, never opened again.
    await switchedOn10December();
    clock = Date.UTC(2027, 1, 10, 13);
    await setSubscription(owner, plan("month", per(Date.UTC(2027, 1, 10, 12), 1)));
    clock = Date.UTC(2027, 2, 1, 13);
    store = await read();
    is("7c: March's window of the anchor is used", [windowId(store, clock), await drain(store)], ["2027-03-01", 8]);
    clock = Date.UTC(2027, 2, 5, 12);
    await setSubscription(owner, { active: false });
    clock = Date.UTC(2027, 2, 20, 12);
    await setSubscription(owner, plan("month", per(Date.UTC(2027, 2, 10, 12), 1)));
    store = await read();
    is("7c: a period that begins inside a window used before the stop goes on in it, nothing whole again", [windowId(store, clock), await drain(store)], ["2027-03-01", 0]);
    clock = Date.UTC(2027, 3, 5, 12);
    store = await read();
    is("7c: and the anchor's next month is whole", [windowId(store, clock), await drain(store)], ["2027-04-01", 8]);

    part("8. A switch written late, after the window turned (a 3DS confirmation, the next day's job, a write that failed)");
    // A yearly plan begun 1 December; on 31 January at 20:00 it is switched to monthly and paid on the invoice's page:
    // the route answers "confirm" and writes nothing, so the record stays yearly.
    const lateSwitch = Date.UTC(2027, 0, 31, 20);
    redis.clear();
    clock = START;
    owner = await newStore("scale", "year");
    clock = Date.UTC(2027, 1, 1, 13);
    store = await read();
    const idsB = new Set<string>([String(windowId(store, clock))]);
    let wholeB = await drain(store);
    // 2 February, 09:00: the daily job writes the monthly period Stripe began on 31 January at 20:00.
    clock = Date.UTC(2027, 1, 2, 9);
    await setSubscription(owner, plan("month", per(lateSwitch, 1)));
    store = await read();
    idsB.add(String(windowId(store, clock)));
    wholeB += await drain(store);
    is("8a: the late write opens no second window in the month", [...idsB], ["2027-02-01"]);
    is("8a: the anchor is the old record's window that holds the new period's first day", store.allowanceAnchor ?? null, { subscriptionId: SUB, start: Date.UTC(2027, 0, 1, 12), end: Date.UTC(2027, 1, 1, 12) });
    is("8a: each allowance kind whole once", wholeB, 8);
    is("8a: an hour after the switch still reads January's month, and March's follows February's on the anchor's day",
      [windowId(store, lateSwitch + 3_600_000), shape(allowanceWindow(store, Date.UTC(2027, 2, 1, 13)))],
      ["2027-01-01", { id: "2027-03-01", start: "2027-03-01T12:00:00.000Z", end: "2027-04-01T12:00:00.000Z" }]);

    // The route's write fails (the store write throws) and is made again by the next day's job, after the turn; then again.
    redis.clear();
    clock = START;
    owner = await newStore("scale", "year");
    clock = lateSwitch;
    const realPipeline = redis.pipeline.bind(redis);
    let failed = 0;
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (/cycle\\*":\\*"month/.test(JSON.stringify(commands))) { failed += 1; throw new Error("synthetic write failure"); }
      return realPipeline(commands);
    }) as typeof redis.pipeline;
    let thrown = false;
    try { await setSubscription(owner, plan("month", per(lateSwitch, 1))); } catch { thrown = true; } finally { redis.pipeline = realPipeline; }
    store = await read();
    is("8b: the failed write left the yearly record as it was", [thrown, failed > 0, store.cycle, store.allowanceAnchor ?? null], [true, true, "year", null]);
    clock = Date.UTC(2027, 1, 1, 13);
    store = await read();
    is("8b: February's window is used on the yearly record", [windowId(store, clock), await drain(store)], ["2027-02-01", 8]);
    clock = Date.UTC(2027, 1, 2, 9);
    await setSubscription(owner, plan("month", per(lateSwitch, 1)));
    store = await read();
    is("8b: made again after the turn: the same window, nothing whole again", [windowId(store, clock), await drain(store)], ["2027-02-01", 0]);
    clock = Date.UTC(2027, 1, 3, 9);
    await setSubscription(owner, plan("month", per(lateSwitch, 1)));
    store = await read();
    is("8b: written once more the next day: the anchor and the window stay", [store.allowanceAnchor ?? null, windowId(store, clock)],
      [{ subscriptionId: SUB, start: Date.UTC(2027, 0, 1, 12), end: Date.UTC(2027, 1, 1, 12) }, "2027-02-01"]);

    // The other way, over a stale snapshot: monthly from 10 January, switched to yearly on 9 February, written on 13
    // February, after the renewal's grace; the window counted in that grace keeps its name.
    redis.clear();
    clock = Date.UTC(2027, 0, 10, 12);
    owner = await newStore("scale", "month");
    clock = Date.UTC(2027, 1, 10, 13);
    store = await read();
    is("8c: the renewal's window is used in its grace", [windowId(store, clock), await drain(store)], ["2027-02-10", 8]);
    clock = Date.UTC(2027, 1, 13, 9);
    await setSubscription(owner, plan("year", per(Date.UTC(2027, 1, 9, 12), 12)));
    store = await read();
    is("8c: the yearly period written late keeps the window used, nothing whole again", [windowId(store, clock), await drain(store)], ["2027-02-10", 0]);
    is("8c: anchored on the old record's month that holds the switch", store.allowanceAnchor ?? null, { subscriptionId: SUB, start: Date.UTC(2027, 0, 10, 12), end: Date.UTC(2027, 1, 10, 12) });

    // Never from an older snapshot written late: a period that begins before the record's own is no switch.
    const record = { subscriptionActive: true, subscriptionId: SUB, trialEnds: 0, planEndedAt: "", cycle: "month" as const, period: per(Date.UTC(2027, 1, 10, 12), 1) };
    is("8d: an older period written over a newer one writes no anchor", anchorAfter(record, { ...record, period: per(Date.UTC(2027, 0, 10, 12), 1) }, Date.UTC(2027, 1, 11, 12)), null);

    part("9. Unknown, and every day of the month: nothing used opens again");
    // A stop whose day cannot be read is taken as late as it can be: the anchor is kept, never dropped to a fresh window.
    const decemberAnchor = { subscriptionId: SUB, start: START, end: Date.UTC(2027, 0, 1, 12) };
    const restarted = { ...record, period: per(Date.UTC(2027, 2, 10, 12), 1) };
    is("9a: a stop with no readable day keeps the anchor", ["", "soon"].map((planEndedAt) =>
      anchorAfter({ ...record, subscriptionActive: false, period: null, planEndedAt, allowanceAnchor: decemberAnchor }, restarted, Date.UTC(2027, 2, 20, 12))), [decemberAnchor, decemberAnchor]);
    is("9a: a plan still stopped keeps it as it is", anchorAfter({ ...record, subscriptionActive: false, period: null, planEndedAt: new Date(Date.UTC(2027, 1, 12)).toISOString(), allowanceAnchor: decemberAnchor },
      { ...restarted, subscriptionActive: false, period: null }, Date.UTC(2027, 2, 20, 12)), decemberAnchor);
    // A switch either way, begun on any day (the 29th to the 31st cut in short months), made at any point of the window,
    // written at once, in the grace or days late: the window counted when it is written keeps its name.
    let checked = 0;
    const renamed: string[] = [];
    for (const from of ["month", "year"] as const) for (const startDay of [1, 15, 28, 29, 30, 31]) for (const afterHours of [1, 100, 300, 600]) for (const lateHours of [0, 13, 30, 47, 49, 75]) {
      const begun = Date.UTC(2027, 0, startDay, 9);
      const was = { subscriptionActive: true, subscriptionId: SUB, trialEnds: 0, planEndedAt: "", cycle: from, period: per(begun, from === "year" ? 12 : 1) };
      const to = from === "year" ? "month" as const : "year" as const;
      const switchedAt = begun + afterHours * 3_600_000, writtenAt = switchedAt + lateHours * 3_600_000;
      const moved = { ...was, cycle: to, period: per(switchedAt, to === "year" ? 12 : 1) };
      const open = windowAt(was, writtenAt);
      if (!open?.billing) continue;
      checked += 1;
      const id = allowanceWindow({ ...moved, allowanceAnchor: anchorAfter(was, moved, writtenAt) }, writtenAt)?.id ?? null;
      if (id !== open.id) renamed.push(`${from} ${startDay} +${afterHours}h +${lateHours}h: ${open.id} -> ${id}`);
    }
    is("9b: 288 switches checked, none renames the window counted when it is written", [checked, renamed], [288, []]);

    part("10. A skipped renewal whose stop the record does not show: one payment, one window (reviews of #3396)");
    // One payment's windows, read inside its period from the moment it is written, and the allowance kinds they give whole.
    const resumed = async (from: number, to: number) => {
      const ids = new Set<string>();
      let whole = 0;
      for (const at of [from, to]) { clock = at; store = await read(); ids.add(String(windowId(store, clock))); whole += await drain(store); }
      return [[...ids], whole];
    };
    // 10a (probe P2): the 10 February renewal is not paid and the stop never reaches the record (a lost webhook, the daily
    // job not run); on 20 March only 10 March to 10 April is paid and written, straight over January's active period.
    await switchedOn10December();
    clock = Date.UTC(2027, 2, 20, 12);
    await setSubscription(owner, plan("month", per(Date.UTC(2027, 2, 10, 12), 1, false)));
    is("10a: no stop recorded: the payment after the skipped period opens one window, its own, each kind whole once",
      await resumed(Date.UTC(2027, 2, 20, 12), Date.UTC(2027, 3, 5, 12)), [["2027-03-10"], 8]);
    // 10b (probe P3): the stop is written on 12 February, then a Stripe read made before it (10 January to 10 February,
    // active) lands after it and wipes the stop's day; on 20 March the paid 10 March to 10 April is written.
    await switchedOn10December();
    clock = Date.UTC(2027, 1, 12, 12);
    await setSubscription(owner, { active: false });
    await setSubscription(owner, plan("month", per(Date.UTC(2027, 0, 10, 12), 1)));
    clock = Date.UTC(2027, 2, 20, 12);
    await setSubscription(owner, plan("month", per(Date.UTC(2027, 2, 10, 12), 1, false)));
    is("10b: a late active write over the stop: still one window for the one payment, each kind whole once",
      await resumed(Date.UTC(2027, 2, 20, 12), Date.UTC(2027, 3, 5, 12)), [["2027-03-10"], 8]);
    is("10b: the anchor is left behind", (await read()).allowanceAnchor ?? null, null);
    // 10c: every day of the month, switch time, length of the skip and day the payment is written, the stop never
    // recorded or wiped by a late active write: the period paid after the skip names one window, its own.
    let swept = 0;
    const twice: string[] = [];
    for (const startDay of [1, 10, 15, 28, 29, 30, 31]) for (const afterHours of [1, 100, 300, 600]) for (const skipped of [1, 2, 3])
      for (const lateDays of [0, 1, 5, 20]) for (const renews of [true, false]) for (const stop of ["never", "wiped"] as const) {
        const begun = Date.UTC(2027, 0, startDay, 9);
        const yearlyRecord = { subscriptionActive: true, subscriptionId: SUB, trialEnds: 0, planEndedAt: "", cycle: "year" as const, period: per(begun, 12) };
        const switchedAt = begun + afterHours * 3_600_000;
        const monthlyRecord = { ...yearlyRecord, cycle: "month" as const, period: per(switchedAt, 1) };
        let rec: typeof monthlyRecord & { allowanceAnchor?: ReturnType<typeof anchorAfter> } = { ...monthlyRecord, allowanceAnchor: anchorAfter(yearlyRecord, monthlyRecord, switchedAt) };
        // The one renewal paid, written on its day.
        const paid = addMonthsMs(switchedAt, 1);
        const renewed = { ...rec, period: per(paid, 1) };
        rec = { ...renewed, allowanceAnchor: anchorAfter(rec, renewed, paid) };
        if (stop === "wiped") {
          // The stop is written after the unpaid renewal's grace, and a read made before it lands right after.
          const stoppedAt = addMonthsMs(paid, 1) + 3 * DAY;
          const stopped = { ...rec, subscriptionActive: false, period: null, planEndedAt: new Date(stoppedAt).toISOString() };
          const stoppedRec = { ...stopped, allowanceAnchor: rec.allowanceAnchor };
          const stale = { ...rec, planEndedAt: "" };
          rec = { ...stale, allowanceAnchor: anchorAfter(stoppedRec, stale, stoppedAt + 60_000) };
        }
        const resumes = addMonthsMs(switchedAt, 2 + skipped);
        const writtenAt = resumes + lateDays * DAY + 3_600_000;
        const back = { ...rec, period: per(resumes, 1, renews) };
        const after = { ...back, allowanceAnchor: anchorAfter(rec, back, writtenAt) };
        const ids = new Set<string>();
        for (let at = writtenAt; at < back.period.end * 1000; at += DAY) ids.add(String(windowId(after, at)));
        swept += 1;
        if (ids.size !== 1 || !ids.has(new Date(resumes).toISOString().slice(0, 10))) twice.push(`${startDay} +${afterHours}h skip ${skipped} late ${lateDays}d ${renews} ${stop}: ${[...ids].join(",")}`);
      }
    is("10c: 1,344 resumed periods, none opens a second window or the anchor's", [swept, twice.length, twice.slice(0, 3)], [1344, 0, []]);
    // What the gap must not catch: the overdue invoice itself paid (7b) and a renewal paid in its grace keep the anchor.
    await switchedOn10December();
    clock = Date.UTC(2027, 1, 11, 12);
    await setSubscription(owner, plan("month", per(Date.UTC(2027, 1, 10, 12), 1)));
    is("10d: a renewal written in its grace keeps the anchor", (await read()).allowanceAnchor, { subscriptionId: SUB, start: START, end: Date.UTC(2027, 0, 1, 12) });
  } finally {
    Date.now = realNow;
  }
  done();
}
void main();
