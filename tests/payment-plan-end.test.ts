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
 *   - the job settles each pending plan once and keeps an open one for two days.
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

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const path = url.pathname.replace(/^\/v1/, "");
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const session = /^\/checkout\/sessions\/(cs_test_[A-Za-z0-9]+)$/.exec(path);
  if (session) return sessions[session[1]] ? answer(sessions[session[1]]) : answer({ error: { message: "No such checkout" } }, 404);
  const sub = /^\/subscriptions\/(sub_[A-Za-z0-9]+)$/.exec(path);
  if (sub && method === "GET") return answer(subscriptions[sub[1]] ?? {});
  if (sub && method === "POST") {
    const body = new URLSearchParams(String(init?.body));
    updates.push({ id: sub[1], body });
    subscriptions[sub[1]] = { ...subscriptions[sub[1]], cancel_at: Number(body.get("cancel_at")) };
    return answer(subscriptions[sub[1]]);
  }
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

const checkout = (id: string, meta: Record<string, string>, over: Record<string, unknown> = {}) => ({ id, object: "checkout.session", status: "complete", subscription: `sub_${id.slice(8)}`, metadata: { store: "harbor", ...meta }, ...over });

async function main(): Promise<void> {
  redis.clear();

  part("Three monthly payments end with the third period");
  sessions.cs_test_plan00000001 = checkout("cs_test_plan00000001", { kind: "plan", plan_payments: "3", plan_interval: "month" });
  subscriptions.sub_plan00000001 = { id: "sub_plan00000001", object: "subscription", status: "active", billing_cycle_anchor: ANCHOR, trial_end: null };
  is("given its end", await finishPlan(ACCOUNT, "cs_test_plan00000001"), "done");
  // 31 January, then 28 February and 31 March are paid; it ends on 30 April at the same time.
  is("the end is the close of the third period, the way Stripe counts months", Number(updates[0]?.body.get("cancel_at")), Date.UTC(2026, 3, 30, 15, 0, 0) / 1000);
  is("and it is the same moment addPeriods names", Number(updates[0]?.body.get("cancel_at")), addPeriods(ANCHOR, "month", 3));
  is("nothing is prorated", updates[0]?.body.get("proration_behavior"), "none");
  is("a second pass changes nothing: the plan already has its end", [await finishPlan(ACCOUNT, "cs_test_plan00000001"), updates.length], ["done", 1]);

  part("Weekly plans count weeks");
  sessions.cs_test_plan00000002 = checkout("cs_test_plan00000002", { kind: "plan", plan_payments: "4", plan_interval: "week" });
  subscriptions.sub_plan00000002 = { id: "sub_plan00000002", object: "subscription", status: "active", billing_cycle_anchor: ANCHOR };
  await finishPlan(ACCOUNT, "cs_test_plan00000002");
  is("four weeks after the first payment", Number(updates[1]?.body.get("cancel_at")), ANCHOR + 28 * DAY);

  part("A membership that ends after twelve payments counts from its trial's end");
  sessions.cs_test_memb00000001 = checkout("cs_test_memb00000001", { ends_after: "12", ends_interval: "month" });
  subscriptions.sub_memb00000001 = { id: "sub_memb00000001", object: "subscription", status: "trialing", billing_cycle_anchor: ANCHOR - 14 * DAY, trial_end: ANCHOR };
  await finishPlan(ACCOUNT, "cs_test_memb00000001");
  is("twelve months after the first payment, not after the trial began", Number(updates[2]?.body.get("cancel_at")), addPeriods(ANCHOR, "month", 12));

  part("What is left alone");
  sessions.cs_test_plan00000003 = checkout("cs_test_plan00000003", { kind: "plan", plan_payments: "3", plan_interval: "month" });
  subscriptions.sub_plan00000003 = { id: "sub_plan00000003", object: "subscription", status: "canceled", billing_cycle_anchor: ANCHOR };
  is("a plan already canceled", await finishPlan(ACCOUNT, "cs_test_plan00000003"), "done");
  sessions.cs_test_plan00000004 = checkout("cs_test_plan00000004", { kind: "plan", plan_payments: "3", plan_interval: "month" }, { status: "open", subscription: null });
  is("a checkout still open waits", await finishPlan(ACCOUNT, "cs_test_plan00000004"), "open");
  sessions.cs_test_plan00000005 = checkout("cs_test_plan00000005", { kind: "plan", plan_payments: "3", plan_interval: "month" }, { status: "expired", subscription: null });
  is("one never paid is let go", await finishPlan(ACCOUNT, "cs_test_plan00000005"), "gone");
  sessions.cs_test_memb00000002 = checkout("cs_test_memb00000002", {});
  is("a membership with no end is not given one", await finishPlan(ACCOUNT, "cs_test_memb00000002"), "gone");
  sessions.cs_test_plan00000006 = checkout("cs_test_plan00000006", { kind: "plan", plan_payments: "1", plan_interval: "month" });
  subscriptions.sub_plan00000006 = { id: "sub_plan00000006", object: "subscription", status: "active", billing_cycle_anchor: ANCHOR };
  is("a 'plan' of one payment is not one", await finishPlan(ACCOUNT, "cs_test_plan00000006"), "gone");
  is("a checkout Stripe does not know", await finishPlan(ACCOUNT, "cs_test_unknown00001"), "gone");
  is("an address that is not an account", await finishPlan("not-an-account", "cs_test_plan00000001"), "gone");
  is("none of these changed any subscription", updates.length, 3);

  part("The job settles each pending plan once");
  sessions.cs_test_plan00000007 = checkout("cs_test_plan00000007", { kind: "plan", plan_payments: "6", plan_interval: "month" });
  subscriptions.sub_plan00000007 = { id: "sub_plan00000007", object: "subscription", status: "active", billing_cycle_anchor: ANCHOR };
  await rememberPlan(ACCOUNT, "cs_test_plan00000007");
  await rememberPlan(ACCOUNT, "cs_test_plan00000004");
  const first = await settlePlans();
  is("the paid one given its end; the open one kept for its two days", [first.done, first.open, updates.length], [1, 1, 4]);
  const second = await settlePlans();
  is("run again: only the open one is looked at, and nothing is changed twice", [second.done, second.open, updates.length], [0, 1, 4]);

  done();
}

void main();
