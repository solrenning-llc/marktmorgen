/**
 * Payment plans the daily job cannot settle, and plans the buyer ends sooner
 * (lib/plans.ts, settlePlans; the review before claude5/plans-stuck-entries,
 * proof P1–P4, and its item 6):
 *
 *   - P1: a plan leaves the pending set only once its ZADD to the line of
 *     plans tried answered 0 or 1. Upstash runs each command of a pipeline on
 *     its own, so a refused ZADD next to a SREM that ran would leave the plan
 *     in neither line, and its buyer charged past the last payment.
 *   - P2: an end earlier than the plan's own (the buyer stopped it) is not the
 *     plan's settled end. The plan stays in the line of plans tried until the
 *     subscription is canceled, or the plan's own end has come with that end
 *     still in place; when the earlier end is taken away first, the agreed end
 *     is set again before it comes.
 *   - P3: a plan stuck at 403 is tried at growing intervals and, after
 *     PLAN_GIVE_UP_DAYS with no good answer, leaves both lines with a line in
 *     the log and a mark in nl:plans:given-up. A plan watched for its earlier
 *     end counts those days from when it was due to be read again, so one
 *     failure after a long wait does not drop it.
 *   - P4: a run stops at the deadline it is given, and every plan it did not
 *     reach is still in its line; the cron route passes it one.
 *   - Item 6: a reply of unknown shape is not an empty line: the run throws
 *     UnknownReplyError, so the route answers not ok.
 *   - A run's cost is the one tests/plan-cost-registry.ts declares
 *     (PLAN_SETTLE_RUN, NOT_A_COST.PLANS_PER_RUN).
 *
 * The proof's P2 and P4 are taken over with two changes (rule 23): P2 runs on
 * a clock before the plan's own end (on the real clock that end was already
 * past, where keeping the earlier end is right), and day by day up to that
 * end, so it checks the outcome (the agreed end set in time) and not one
 * schedule; P4 gives the run a deadline and a Stripe that takes a second a
 * call, since a run on a clock that never moves cannot stop at a time budget.
 */
import { readFileSync } from "node:fs";
import * as plans from "@/lib/plans";
import { addPeriods, rememberPlan, settlePlans } from "@/lib/plans";
import * as registry from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_prerev";
const ACCOUNT = "acct_1TestPlans0001";
const STUCK = "acct_1TestPlansStuck1";
const FLAKY = "acct_1TestPlansFlaky1";
const ANCHOR = Date.UTC(2026, 0, 31, 15, 0, 0) / 1000;
const DAY = 86_400;
const sessions: Record<string, Record<string, unknown>> = {};
const subscriptions: Record<string, Record<string, unknown>> = {};
const updates: { id: string; body: URLSearchParams; at: number }[] = [];
let stripeCalls = 0;
/** Milliseconds each Stripe call takes on the test clock (P4). */
let callMs = 0;
/** While true, the flaky account answers 500. */
let flakyDown = false;
const realNow = Date.now;
let clock = Math.floor(realNow() / 1000) * 1000;
const setClock = (seconds: number) => {
  clock = seconds * 1000;
  Date.now = () => clock;
};
const tick = (days: number) => setClock(clock / 1000 + days * DAY);

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  stripeCalls += 1;
  clock += callMs;
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const path = url.pathname.replace(/^\/v1/, "");
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const on = (init?.headers as Record<string, string> | undefined)?.["Stripe-Account"];
  if (on === STUCK) return answer({ error: { message: "no access" } }, 403);
  if (on === FLAKY && flakyDown) return answer({ error: { message: "try later" } }, 500);
  const session = /^\/checkout\/sessions\/(cs_test_[A-Za-z0-9]+)$/.exec(path);
  if (session) return sessions[session[1]] ? answer(sessions[session[1]]) : answer({ error: { message: "No such checkout" } }, 404);
  const sub = /^\/subscriptions\/(sub_[A-Za-z0-9]+)$/.exec(path);
  if (sub && method === "GET") return answer(subscriptions[sub[1]] ?? {});
  if (sub && method === "POST") {
    const body = new URLSearchParams(String(init?.body));
    updates.push({ id: sub[1], body, at: Math.floor(Date.now() / 1000) });
    subscriptions[sub[1]] = { ...subscriptions[sub[1]], cancel_at: Number(body.get("cancel_at")) };
    return answer(subscriptions[sub[1]]);
  }
  return answer({ error: { message: "none" } }, 404);
}) as typeof fetch;

const checkout = (id: string, meta: Record<string, string>, over: Record<string, unknown> = {}) => ({ id, status: "complete", subscription: `sub_${id.slice(8)}`, metadata: { store: "harbor", ...meta }, ...over });
const inPending = async (m: string) => (await redis.pipeline([["SISMEMBER", "nl:plans:pending", m]]))[0] === 1;
const retryMembers = async () => (await redis.pipeline([["ZRANGEBYSCORE", "nl:plans:retry", "-inf", "+inf"]]))[0] as string[];
/** Whether a plan (account|session) is still in one of the two lines, whatever time it carries. */
const inALine = async (account: string, session: string) => {
  const [pending] = await redis.pipeline([["SMEMBERS", "nl:plans:pending"]]);
  return [...(pending as string[]), ...(await retryMembers())].some((m) => m.startsWith(`${account}|${session}|`));
};
const givenUp = async () => (await redis.pipeline([["ZRANGEBYSCORE", "nl:plans:given-up", "-inf", "+inf"]]))[0] as string[];
type Pipe = (commands: (string | number)[][]) => Promise<unknown[]>;
const real: Pipe = redis.pipeline.bind(redis);
const swapPipeline = (next: Pipe) => {
  (redis as unknown as { pipeline: Pipe }).pipeline = next;
};

async function main(): Promise<void> {
  const realError = console.error;
  const logged: string[] = [];
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  setClock(clock / 1000);

  part("P1: a refused ZADD never loses the plan");
  redis.clear();
  sessions.cs_test_open00000001 = checkout("cs_test_open00000001", { kind: "plan", plan_payments: "3", plan_interval: "month" }, { status: "open", subscription: null });
  await rememberPlan(ACCOUNT, "cs_test_open00000001");
  const [member] = (await redis.pipeline([["SMEMBERS", "nl:plans:pending"]]))[0] as string[];
  swapPipeline(async (commands) => {
    if (commands.some((c) => c[0] === "ZADD" && c[1] === "nl:plans:retry")) {
      // Upstash runs each command of /pipeline on its own: ZADD refused (e.g. data size limit, OOM), the rest still runs.
      await real(commands.filter((c) => c[0] !== "ZADD"));
      throw new Error("Redis error: ERR max data size exceeded");
    }
    return real(commands);
  });
  await settlePlans();
  swapPipeline(real);
  is("the open plan is still in one of the two lines", (await inPending(member)) || (await retryMembers()).includes(member), true);
  swapPipeline(async (commands) => {
    if (commands.some((c) => c[0] === "ZADD" && c[1] === "nl:plans:retry")) {
      await real(commands.filter((c) => c[0] !== "ZADD"));
      return commands.map((c) => (c[0] === "ZADD" ? null : 1));
    }
    return real(commands);
  });
  await settlePlans();
  swapPipeline(real);
  is("a ZADD answered in an unknown shape leaves it in the pending set too", await inPending(member), true);
  await settlePlans();
  is("a ZADD that answers moves it to the line of plans tried", [await inPending(member), await inALine(ACCOUNT, "cs_test_open00000001")], [false, true]);

  part("P2: an earlier end is watched; taken away, the agreed end is set again before it comes");
  redis.clear();
  setClock(ANCHOR + 10 * DAY);
  sessions.cs_test_soon00000001 = checkout("cs_test_soon00000001", { ends_after: "6", ends_interval: "month" });
  subscriptions.sub_soon00000001 = { id: "sub_soon00000001", status: "active", billing_cycle_anchor: ANCHOR, cancel_at: addPeriods(ANCHOR, "month", 2) };
  await rememberPlan(ACCOUNT, "cs_test_soon00000001");
  const first = await settlePlans();
  is("an earlier end is not settled: the plan stays in a line, with nothing written", [first.done, await inALine(ACCOUNT, "cs_test_soon00000001"), updates.length], [0, true, 0]);
  tick(5);
  subscriptions.sub_soon00000001.cancel_at = null; // the buyer renews in the portal, or the creator clears it
  const agreed = addPeriods(ANCHOR, "month", 6);
  const before = updates.length;
  while (clock / 1000 < agreed - DAY) {
    tick(1);
    await settlePlans();
  }
  is("the agreed end (6 payments) is set again, once, before it comes", [updates.length - before, Number(updates.at(-1)?.body.get("cancel_at")), (updates.at(-1)?.at ?? Infinity) < agreed], [1, agreed, true]);
  is("and then the plan leaves the lines", await inALine(ACCOUNT, "cs_test_soon00000001"), false);

  redis.clear();
  setClock(ANCHOR + 10 * DAY);
  sessions.cs_test_kept00000001 = checkout("cs_test_kept00000001", { ends_after: "6", ends_interval: "month" });
  const stop = addPeriods(ANCHOR, "month", 2);
  subscriptions.sub_kept00000001 = { id: "sub_kept00000001", status: "active", billing_cycle_anchor: ANCHOR, cancel_at: stop };
  await rememberPlan(ACCOUNT, "cs_test_kept00000001");
  const calls0 = stripeCalls;
  const before2 = updates.length;
  for (let d = 0; d < 80; d += 1) {
    tick(1);
    if (clock / 1000 >= stop) subscriptions.sub_kept00000001.status = "canceled";
    await settlePlans();
  }
  is("an earlier end that is kept: the plan leaves once Stripe has canceled it, nothing written", [await inALine(ACCOUNT, "cs_test_kept00000001"), updates.length - before2], [false, 0]);
  is("and while it waits it is not read every day", stripeCalls - calls0 <= 8, true);

  redis.clear();
  setClock(ANCHOR + 10 * DAY);
  sessions.cs_test_last00000001 = checkout("cs_test_last00000001", { ends_after: "3", ends_interval: "month" });
  subscriptions.sub_last00000001 = { id: "sub_last00000001", status: "active", billing_cycle_anchor: ANCHOR, cancel_at: addPeriods(ANCHOR, "month", 2) };
  await rememberPlan(ACCOUNT, "cs_test_last00000001");
  await settlePlans();
  setClock(addPeriods(ANCHOR, "month", 3) + DAY);
  const late = await settlePlans();
  is("the plan's own end has come with the earlier end still there: settled", [late.done, await inALine(ACCOUNT, "cs_test_last00000001")], [1, false]);

  part("P3: a plan stuck at 403 is tried less often, then let go with a log line and a mark");
  redis.clear();
  setClock(Math.floor(realNow() / 1000));
  await rememberPlan(STUCK, "cs_test_dead00000001");
  const deadMember = ((await redis.pipeline([["SMEMBERS", "nl:plans:pending"]]))[0] as string[])[0];
  logged.length = 0;
  const calls1 = stripeCalls;
  const giveUp = (plans as Record<string, unknown>).PLAN_GIVE_UP_DAYS;
  is("PLAN_GIVE_UP_DAYS is 30", giveUp, 30);
  let leftOn = -1;
  for (let d = 1; d <= 60; d += 1) {
    tick(1);
    await settlePlans();
    if (leftOn < 0 && !(await inALine(STUCK, "cs_test_dead00000001"))) leftOn = d;
  }
  const [n] = await redis.pipeline([["ZCARD", "nl:plans:retry"]]);
  is("after 60 days the stuck plan is gone from the lines", [n, await inPending(deadMember)], [0, false]);
  is("it left on day 30, not before", leftOn, 30);
  is("tried at growing intervals: far fewer than one try a day", stripeCalls - calls1 <= 12, true);
  is("a mark names it in nl:plans:given-up", await givenUp(), [deadMember]);
  is("and the log says so, once", logged.filter((line) => line.includes("no longer tried")).length, 1);

  redis.clear();
  setClock(ANCHOR + DAY);
  sessions.cs_test_flky00000001 = checkout("cs_test_flky00000001", { ends_after: "24", ends_interval: "month" });
  const own = addPeriods(ANCHOR, "month", 24);
  const early = addPeriods(ANCHOR, "month", 3);
  subscriptions.sub_flky00000001 = { id: "sub_flky00000001", status: "active", billing_cycle_anchor: ANCHOR, cancel_at: early };
  await rememberPlan(FLAKY, "cs_test_flky00000001");
  await settlePlans();
  setClock(early - DAY);
  subscriptions.sub_flky00000001.cancel_at = null;
  flakyDown = true;
  for (let d = 0; d < 3; d += 1) {
    tick(1);
    await settlePlans();
  }
  is("a watched plan read again months later, answering 500, is kept", await inALine(FLAKY, "cs_test_flky00000001"), true);
  flakyDown = false;
  for (let d = 0; d < 10; d += 1) {
    tick(1);
    await settlePlans();
  }
  is("and once Stripe answers, it is given its own end", [updates.at(-1)?.id, Number(updates.at(-1)?.body.get("cancel_at")), await inALine(FLAKY, "cs_test_flky00000001")], ["sub_flky00000001", own, false]);

  part("P4: a run stops at its deadline, and loses nothing");
  redis.clear();
  setClock(Math.floor(realNow() / 1000));
  const many = Array.from({ length: 250 }, (_, i) => `cs_test_d${String(i).padStart(11, "0")}`);
  for (const id of many) await rememberPlan(STUCK, id);
  stripeCalls = 0;
  tick(1);
  callMs = 1000;
  await (settlePlans as (limit?: number, deadline?: number) => ReturnType<typeof settlePlans>)(200, clock + 30_000);
  callMs = 0;
  is("calls in one run stop at its deadline (30 s, a second a call)", stripeCalls <= 31, true);
  const still = await Promise.all(many.map((id) => inALine(STUCK, id)));
  is("every plan is still in one of the two lines", still.filter(Boolean).length, 250);
  const route = readFileSync("app/api/cron/plans/route.ts", "utf8");
  is("the cron route gives the plans a deadline of their own", /settlePlans\(PLANS_PER_RUN, Math\.min\(deadline, Date\.now\(\) \+ PLANS_MS\)\)/.test(route), true);

  part("Item 6: a reply of unknown shape is not an empty line");
  redis.clear();
  await rememberPlan(ACCOUNT, "cs_test_open00000001");
  for (const [name, reply] of [["a word for the new plans", ["x", []]], ["a number in the line", [[], [7]]], ["one reply for two commands", [[]]]] as const) {
    swapPipeline(async (commands) => (commands.some((c) => c[0] === "SRANDMEMBER") ? (reply as unknown as unknown[]) : real(commands)));
    const outcome = await settlePlans().then(() => "settled", (error: Error) => error.name);
    swapPipeline(real);
    is(`${name}: the run throws UnknownReplyError`, outcome, "UnknownReplyError");
  }

  part("A run costs what the registry says");
  const declared = (registry as Record<string, unknown>).PLAN_SETTLE_RUN as Record<string, number> | undefined;
  const perRun = (plans as Record<string, unknown>).PLANS_PER_RUN;
  is("PLAN_SETTLE_RUN is in tests/plan-cost-registry.ts", typeof declared, "object");
  is("NOT_A_COST.PLANS_PER_RUN names settlePlans", (registry.NOT_A_COST.PLANS_PER_RUN ?? "").includes("settlePlans"), true);
  is("the run's limit is PLANS_PER_RUN", [perRun, declared?.plansPerRun], [200, 200]);
  redis.clear();
  setClock(Math.floor(realNow() / 1000));
  // Every way a plan can come out of a try: given its end, gone, open, watched, failing, and given up.
  sessions.cs_test_cost00000001 = checkout("cs_test_cost00000001", { kind: "plan", plan_payments: "3", plan_interval: "month" });
  subscriptions.sub_cost00000001 = { id: "sub_cost00000001", status: "active", billing_cycle_anchor: ANCHOR + 400 * DAY };
  sessions.cs_test_cost00000002 = checkout("cs_test_cost00000002", { kind: "plan", plan_payments: "3", plan_interval: "month" }, { status: "open", subscription: null });
  sessions.cs_test_cost00000003 = checkout("cs_test_cost00000003", { kind: "plan", plan_payments: "6", plan_interval: "month" });
  subscriptions.sub_cost00000003 = { id: "sub_cost00000003", status: "active", billing_cycle_anchor: ANCHOR + 400 * DAY, cancel_at: ANCHOR + 430 * DAY };
  for (const id of ["cs_test_cost00000001", "cs_test_cost00000002", "cs_test_cost00000003", "cs_test_costgone0001"]) await rememberPlan(ACCOUNT, id);
  await rememberPlan(STUCK, "cs_test_cost00000004");
  const old = `${STUCK}|cs_test_cost00000005|${Math.floor(clock / 1000) - 31 * DAY}`;
  await redis.pipeline([["ZADD", "nl:plans:retry", Math.floor(clock / 1000) - DAY, old]]);
  let commands = 0;
  swapPipeline(async (sent) => {
    commands += sent.length;
    return real(sent);
  });
  stripeCalls = 0;
  const run = await settlePlans();
  swapPipeline(real);
  const tried = run.done + run.open + run.dropped + run.failed + ((run as Record<string, number>).givenUp ?? 0) + ((run as Record<string, number>).watched ?? 0);
  is("all six were tried", tried, 6);
  is("Redis commands within readCommandsPerRun + tried x ownCommandsPerPlanTried", commands <= (declared?.readCommandsPerRun ?? 0) + tried * (declared?.ownCommandsPerPlanTried ?? 0), true);
  is("Stripe calls within tried x stripeCallsPerPlanTried", stripeCalls <= tried * (declared?.stripeCallsPerPlanTried ?? 0), true);
  is("the registry's figures", declared && [declared.readCommandsPerRun, declared.ownCommandsPerPlanTried, declared.stripeCallsPerPlanTried, declared.runMs], [2, 4, 3, 25_000]);
  is("the route's budget is the registry's", new RegExp(`const PLANS_MS = ${(declared?.runMs ?? 0).toLocaleString("en-US").replace(",", "_")};`).test(route), true);

  Date.now = realNow;
  console.error = realError;
  done();
}
void main();
