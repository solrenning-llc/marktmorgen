/**
 * A payment plan stops by itself after its last payment (lib/plans.ts,
 * finishPlan and settlePlans; ClickFunnels audit F14, added 17 October 2026).
 *
 * A plan is a subscription on the creator's own Stripe account that must
 * never charge one payment too many. Checked against a stand-in for Stripe:
 *
 *   - three monthly payments end at the close of the third period, from the
 *     cycle's anchor, with no proration;
 *   - a membership set to end after twelve payments counts from the end of
 *     its free trial, where its first payment is taken;
 *   - a plan already given its end, or already canceled, is not touched again;
 *   - a checkout still open waits; one never paid, or that is neither a plan
 *     nor a membership with an end, is let go without any change;
 *   - the job settles each pending plan once and keeps an open one for two days;
 *   - an end already set counts only when it is the plan's own: a later one (set
 *     by hand, or left from before) is brought back to it; an earlier one (the
 *     buyer stopped it) is kept and watched (tests/payment-plan-stuck.test.ts);
 *   - plans the job cannot settle (an account that answers 403) never keep a
 *     new plan from its end: they wait in a line of their own, taken in turn,
 *     and no run reads Stripe for more than its limit;
 *   - a reply that is not the checkout or subscription asked for (another id,
 *     or none) decides nothing: it is never settled, so the job keeps the plan
 *     in its line of plans tried and asks again on its next pass.
 */
import { addPeriods, finishPlan, rememberPlan, settlePlans } from "@/lib/plans";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_plan_end_only";

const ACCOUNT = "acct_1TestPlans0001";
const ANCHOR = Date.UTC(2026, 0, 31, 15, 0, 0) / 1000;
const DAY = 86_400;
const sessions: Record<string, Record<string, unknown>> = {};
const subscriptions: Record<string, Record<string, unknown>> = {};
const updates: { id: string; body: URLSearchParams }[] = [];
/** A connected account that refuses every call, as one disconnected from the platform does. */
const STUCK = "acct_1TestPlansStuck1";
/** How many times each checkout was read, to see which plans a run looked at. */
const reads: Record<string, number> = {};
/** What Stripe answers to an update, when a case needs a reply other than the subscription. */
const updateReplies: Record<string, Record<string, unknown>> = {};

/** A reply given as it is, by "METHOD path", when a case needs one that is not an object (a JSON null, a string, a number). */
const raw = new Map<string, unknown>();

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const path = url.pathname.replace(/^\/v1/, "");
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (raw.has(`${method} ${path}`)) {
    if (method === "POST") updates.push({ id: path.slice(15), body: new URLSearchParams(String(init?.body)) });
    return answer(raw.get(`${method} ${path}`));
  }
  const session = /^\/checkout\/sessions\/(cs_test_[A-Za-z0-9]+)$/.exec(path);
  if (session) reads[session[1]] = (reads[session[1]] ?? 0) + 1;
  if ((init?.headers as Record<string, string> | undefined)?.["Stripe-Account"] === STUCK) {
    return answer({ error: { type: "invalid_request_error", message: "The account does not have access" } }, 403);
  }
  if (session) return sessions[session[1]] ? answer(sessions[session[1]]) : answer({ error: { message: "No such checkout" } }, 404);
  const sub = /^\/subscriptions\/(sub_[A-Za-z0-9]+)$/.exec(path);
  if (sub && method === "GET") return answer(subscriptions[sub[1]] ?? {});
  if (sub && method === "POST") {
    const body = new URLSearchParams(String(init?.body));
    updates.push({ id: sub[1], body });
    subscriptions[sub[1]] = { ...subscriptions[sub[1]], cancel_at: Number(body.get("cancel_at")) };
    return answer(updateReplies[sub[1]] ?? subscriptions[sub[1]]);
  }
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

/** Not settled: neither "done", "gone" nor "open" (those end or age out the pending entry); a throw counts too. */
const unsettled = (work: Promise<string>) => work.then((state) => !["done", "gone", "open"].includes(state), () => true);
const checkout = (id: string, meta: Record<string, string>, over: Record<string, unknown> = {}) => ({ id, status: "complete", subscription: `sub_${id.slice(8)}`, metadata: { store: "harbor", ...meta }, ...over });

async function main(): Promise<void> {
  redis.clear();

  part("Three monthly payments end with the third period");
  sessions.cs_test_plan00000001 = checkout("cs_test_plan00000001", { kind: "plan", plan_payments: "3", plan_interval: "month" });
  subscriptions.sub_plan00000001 = { id: "sub_plan00000001", status: "active", billing_cycle_anchor: ANCHOR, trial_end: null };
  is("given its end", await finishPlan(ACCOUNT, "cs_test_plan00000001"), "done");
  // 31 January, then 28 February and 31 March are paid; it ends on 30 April at the same time.
  is("the end is the close of the third period, the way Stripe counts months", Number(updates[0]?.body.get("cancel_at")), Date.UTC(2026, 3, 30, 15, 0, 0) / 1000);
  is("and it is the same moment addPeriods names", Number(updates[0]?.body.get("cancel_at")), addPeriods(ANCHOR, "month", 3));
  is("nothing is prorated", updates[0]?.body.get("proration_behavior"), "none");
  is("a second pass changes nothing: the plan already has its end", [await finishPlan(ACCOUNT, "cs_test_plan00000001"), updates.length], ["done", 1]);

  part("Weekly plans count weeks");
  sessions.cs_test_plan00000002 = checkout("cs_test_plan00000002", { kind: "plan", plan_payments: "4", plan_interval: "week" });
  subscriptions.sub_plan00000002 = { id: "sub_plan00000002", status: "active", billing_cycle_anchor: ANCHOR };
  await finishPlan(ACCOUNT, "cs_test_plan00000002");
  is("four weeks after the first payment", Number(updates[1]?.body.get("cancel_at")), ANCHOR + 28 * DAY);

  part("A membership that ends after twelve payments counts from its trial's end");
  sessions.cs_test_memb00000001 = checkout("cs_test_memb00000001", { ends_after: "12", ends_interval: "month" });
  subscriptions.sub_memb00000001 = { id: "sub_memb00000001", status: "trialing", billing_cycle_anchor: ANCHOR - 14 * DAY, trial_end: ANCHOR };
  await finishPlan(ACCOUNT, "cs_test_memb00000001");
  is("twelve months after the first payment, not after the trial began", Number(updates[2]?.body.get("cancel_at")), addPeriods(ANCHOR, "month", 12));

  part("What is left alone");
  sessions.cs_test_plan00000003 = checkout("cs_test_plan00000003", { kind: "plan", plan_payments: "3", plan_interval: "month" });
  subscriptions.sub_plan00000003 = { id: "sub_plan00000003", status: "canceled", billing_cycle_anchor: ANCHOR };
  is("a plan already canceled", await finishPlan(ACCOUNT, "cs_test_plan00000003"), "done");
  sessions.cs_test_plan00000004 = checkout("cs_test_plan00000004", { kind: "plan", plan_payments: "3", plan_interval: "month" }, { status: "open", subscription: null });
  is("a checkout still open waits", await finishPlan(ACCOUNT, "cs_test_plan00000004"), "open");
  sessions.cs_test_plan00000005 = checkout("cs_test_plan00000005", { kind: "plan", plan_payments: "3", plan_interval: "month" }, { status: "expired", subscription: null });
  is("one never paid is let go", await finishPlan(ACCOUNT, "cs_test_plan00000005"), "gone");
  sessions.cs_test_memb00000002 = checkout("cs_test_memb00000002", {});
  is("a membership with no end is not given one", await finishPlan(ACCOUNT, "cs_test_memb00000002"), "gone");
  sessions.cs_test_plan00000006 = checkout("cs_test_plan00000006", { kind: "plan", plan_payments: "1", plan_interval: "month" });
  subscriptions.sub_plan00000006 = { id: "sub_plan00000006", status: "active", billing_cycle_anchor: ANCHOR };
  is("a 'plan' of one payment is not one", await finishPlan(ACCOUNT, "cs_test_plan00000006"), "gone");
  is("a checkout Stripe does not know", await finishPlan(ACCOUNT, "cs_test_unknown00001"), "gone");
  is("an address that is not an account", await finishPlan("not-an-account", "cs_test_plan00000001"), "gone");
  is("none of these changed any subscription", updates.length, 3);

  part("The job settles each pending plan once");
  sessions.cs_test_plan00000007 = checkout("cs_test_plan00000007", { kind: "plan", plan_payments: "6", plan_interval: "month" });
  subscriptions.sub_plan00000007 = { id: "sub_plan00000007", status: "active", billing_cycle_anchor: ANCHOR };
  await rememberPlan(ACCOUNT, "cs_test_plan00000007");
  await rememberPlan(ACCOUNT, "cs_test_plan00000004");
  const first = await settlePlans();
  is("the paid one given its end; the open one kept for its two days", [first.done, first.open, updates.length], [1, 1, 4]);
  const second = await settlePlans();
  is("run again: only the open one is looked at, and nothing is changed twice", [second.done, second.open, updates.length], [0, 1, 4]);

  part("An end already set counts only when it is no later than the plan's own");
  sessions.cs_test_late00000001 = checkout("cs_test_late00000001", { kind: "plan", plan_payments: "3", plan_interval: "month" });
  const own = addPeriods(ANCHOR, "month", 3);
  subscriptions.sub_late00000001 = { id: "sub_late00000001", status: "active", billing_cycle_anchor: ANCHOR, cancel_at: addPeriods(ANCHOR, "month", 5) };
  const before8 = updates.length;
  is("an end two payments too late is not the plan's end", await finishPlan(ACCOUNT, "cs_test_late00000001"), "done");
  is("it is brought back to the close of the third period", [updates.length - before8, Number(updates.at(-1)?.body.get("cancel_at")), updates.at(-1)?.id], [1, own, "sub_late00000001"]);
  sessions.cs_test_same00000001 = checkout("cs_test_same00000001", { kind: "plan", plan_payments: "3", plan_interval: "month" });
  subscriptions.sub_same00000001 = { id: "sub_same00000001", status: "active", billing_cycle_anchor: ANCHOR, cancel_at: own };
  sessions.cs_test_soon00000001 = checkout("cs_test_soon00000001", { kind: "plan", plan_payments: "3", plan_interval: "month" });
  // The buyer stopped it after the second payment: ending sooner never charges more, so it is left as it is.
  subscriptions.sub_soon00000001 = { id: "sub_soon00000001", status: "active", billing_cycle_anchor: ANCHOR, cancel_at: addPeriods(ANCHOR, "month", 2) };
  const before9 = updates.length;
  // On this clock the plan's own end (April 2026) has come with the earlier end in place, so it is settled; before
  // its own end an earlier one is "early" and watched (tests/payment-plan-stuck.test.ts, P2).
  is("the plan's own end, and an earlier one, are kept", [await finishPlan(ACCOUNT, "cs_test_same00000001"), await finishPlan(ACCOUNT, "cs_test_soon00000001"), updates.length - before9], ["done", "done", 0]);

  part("Plans that cannot be settled never keep a new one from its end");
  redis.clear();
  const realError = console.error;
  console.error = () => {};
  const realNow = Date.now;
  let clock = Math.floor(realNow() / 1000) * 1000;
  const nextDay = () => {
    clock += DAY * 1000;
    Date.now = () => clock;
  };
  nextDay();
  const stuck = Array.from({ length: 250 }, (_, i) => `cs_test_stuck${String(i).padStart(8, "0")}`);
  for (const id of stuck) await rememberPlan(STUCK, id);
  const day1 = await settlePlans();
  const looked1 = Object.keys(reads).filter((id) => id.startsWith("cs_test_stuck")).length;
  is("a run reads at most its limit", [day1.failed, looked1], [200, 200]);
  nextDay();
  for (const id of stuck) reads[id] = 0;
  sessions.cs_test_newp00000001 = checkout("cs_test_newp00000001", { kind: "plan", plan_payments: "4", plan_interval: "month" });
  subscriptions.sub_newp00000001 = { id: "sub_newp00000001", status: "active", billing_cycle_anchor: ANCHOR };
  await rememberPlan(ACCOUNT, "cs_test_newp00000001");
  reads.cs_test_newp00000001 = 0;
  const before11 = updates.length;
  const day2 = await settlePlans();
  is("the next run gives the new plan its end, with 200 stuck plans already waiting", [updates.length - before11, updates.at(-1)?.id, day2.done], [1, "sub_newp00000001", 1]);
  is("and still reads no more than its limit", stuck.reduce((sum, id) => sum + (reads[id] ?? 0), 0) + (reads.cs_test_newp00000001 ?? 0) <= 200, true);
  nextDay();
  for (const id of stuck) reads[id] = 0;
  await settlePlans();
  nextDay();
  await settlePlans();
  is("taken in turn: over two more runs every stuck plan is tried again", stuck.filter((id) => !reads[id]).length, 0);
  // Review of claude5/plans-stuck-entries (rule 23): stuck plans now wait longer each time, so one more day passes
  // first and every one of the 250 is due again; the share asserted below is unchanged.
  nextDay();
  const fresh = Array.from({ length: 300 }, (_, i) => `cs_test_open${String(i).padStart(9, "0")}`);
  for (const id of fresh) {
    sessions[id] = checkout(id, { kind: "plan", plan_payments: "3", plan_interval: "month" }, { status: "open", subscription: null });
    await rememberPlan(ACCOUNT, id);
  }
  nextDay();
  const busy = await settlePlans();
  is("a busy day of new checkouts shares the run half and half with the plans waiting", [busy.open, busy.failed], [100, 100]);
  Date.now = realNow;
  console.error = realError;

  part("A reply for another checkout or subscription decides nothing");
  const before10 = updates.length;
  sessions.cs_test_plan00000008 = checkout("cs_test_plan00000008", { kind: "plan", plan_payments: "3", plan_interval: "month" });
  subscriptions.sub_plan00000008 = { id: "sub_someoneElse0001", status: "active", cancel_at: ANCHOR + 90 * DAY, billing_cycle_anchor: ANCHOR };
  is("a subscription reply with another id and an end is not taken as this plan's end", await unsettled(finishPlan(ACCOUNT, "cs_test_plan00000008")), true);
  sessions.cs_test_plan00000009 = checkout("cs_test_plan00000009", { kind: "plan", plan_payments: "3", plan_interval: "month" });
  subscriptions.sub_plan00000009 = { status: "canceled", billing_cycle_anchor: ANCHOR };
  is("a subscription reply with no id, canceled, is not taken as this plan's end", await unsettled(finishPlan(ACCOUNT, "cs_test_plan00000009")), true);
  sessions.cs_test_plan00000010 = checkout("cs_test_someoneElse1", { kind: "plan", plan_payments: "3", plan_interval: "month" }, { status: "expired", subscription: null });
  is("a checkout reply for another checkout does not let the plan go", await unsettled(finishPlan(ACCOUNT, "cs_test_plan00000010")), true);
  // Merged with claude5/plans-stuck-entries (rule 23): counted from this part's start, since the parts before it now
  // change more subscriptions; still none here.
  is("none of them changed any subscription", updates.length - before10, 0);
  sessions.cs_test_plan00000011 = checkout("cs_test_plan00000011", { kind: "plan", plan_payments: "3", plan_interval: "month" });
  subscriptions.sub_plan00000011 = { id: "sub_plan00000011", status: "active", billing_cycle_anchor: ANCHOR };
  updateReplies.sub_plan00000011 = { id: "sub_someoneElse0002", cancel_at: addPeriods(ANCHOR, "month", 3) };
  is("an update answered for another subscription is not settled", await unsettled(finishPlan(ACCOUNT, "cs_test_plan00000011")), true);
  delete updateReplies.sub_plan00000011;
  // Codex S's review of #3086: the subscription's own id is not proof that the end was written.
  for (const [i, [name, cancelAt]] of ([["no end", undefined], ["an end of zero", 0], ["an end as text", "1800000000"]] as const).entries()) {
    const n = String(20 + i);
    const id = `sub_plan000000${n}x`;
    sessions[`cs_test_plan000000${n}x`] = checkout(`cs_test_plan000000${n}x`, { kind: "plan", plan_payments: "3", plan_interval: "month" }, { subscription: id });
    subscriptions[id] = { id, status: "active", billing_cycle_anchor: ANCHOR };
    updateReplies[id] = cancelAt === undefined ? { id } : { id, cancel_at: cancelAt };
    is(`an update answered with its own id and ${name} is not settled`, await unsettled(finishPlan(ACCOUNT, `cs_test_plan000000${n}x`)), true);
    delete updateReplies[id];
  }
  // Merged with claude5/plans-stuck-entries: the lines start empty here, as the stuck and open plans above are no
  // part of these counts; an unread plan waits in the line of plans tried and is due again at once.
  redis.clear();
  await rememberPlan(ACCOUNT, "cs_test_plan00000008");
  const third = await settlePlans();
  const fourth = await settlePlans();
  is("the job keeps such a plan and asks again on its next pass", [third.failed, third.done, fourth.failed, fourth.done], [1, 0, 1, 0]);

  // Claude 6 on #3098: a 200 whose JSON body is null (or not an object) is not the object asked for. It is "unread",
  // never a TypeError, and never settles, drops or changes the plan.
  part("A reply that is not an object (null, a string, a number) decides nothing");
  for (const [i, [name, body]] of ([["null", null], ["a string", "sub_plan000000"], ["a number", 7]] as const).entries()) {
    const n = String(30 + i);
    const cs = `cs_test_plan000000${n}y`;
    const id = `sub_plan000000${n}y`;
    sessions[cs] = checkout(cs, { kind: "plan", plan_payments: "3", plan_interval: "month" }, { subscription: id });
    subscriptions[id] = { id, status: "active", billing_cycle_anchor: ANCHOR };
    const before = updates.length;
    raw.set(`GET /checkout/sessions/${cs}`, body);
    is(`a checkout read answered with ${name} is unread, and changes nothing`, [await finishPlan(ACCOUNT, cs), updates.length], ["unread", before]);
    raw.clear();
    raw.set(`GET /subscriptions/${id}`, body);
    is(`a subscription read answered with ${name} is unread, and changes nothing`, [await finishPlan(ACCOUNT, cs), updates.length], ["unread", before]);
    raw.clear();
    raw.set(`POST /subscriptions/${id}`, body);
    is(`an update answered with ${name} is unread`, [await finishPlan(ACCOUNT, cs), updates.length], ["unread", before + 1]);
    raw.clear();
  }
  const nullCs = "cs_test_plan00000040z";
  sessions[nullCs] = checkout(nullCs, { kind: "plan", plan_payments: "3", plan_interval: "month" }, { subscription: "sub_plan00000040z" });
  await rememberPlan(ACCOUNT, nullCs);
  raw.set(`GET /checkout/sessions/${nullCs}`, null);
  const fifth = await settlePlans();
  const sixth = await settlePlans();
  is("the job keeps a plan whose read was answered with null and asks again", [fifth.failed, fifth.done, fifth.dropped, sixth.failed, sixth.dropped], [2, 0, 0, 2, 0]);
  raw.clear();

  done();
}

void main();
