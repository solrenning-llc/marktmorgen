/**
 * A payment plan is never let go on a reply of unknown shape (CX-123 rule 24;
 * lib/plans.ts, rememberPlan, finishPlan and settlePlans).
 *
 * A plan that leaves `nl:plans:pending` without its `cancel_at` keeps charging
 * after its last payment. So:
 *
 *   - the checkout writes the plan down only when Redis says the SADD added
 *     it; any other reply throws before the buyer is sent to Stripe;
 *   - a checkout or a subscription Stripe answered 200 in a shape that is not
 *     the documented one (object, id, status, metadata, a whole anchor) throws:
 *     counted as failed, kept pending, never "gone", and nothing is written;
 *   - the end is taken as written only when Stripe's reply to it says so;
 *   - the daily job refuses a pending list of unknown shape instead of
 *     settling nothing and calling it done.
 *
 * Only a confirmed 404, an expired checkout, a checkout that is neither a plan
 * nor a membership with an end, or a plan whose own terms are not a plan, lets
 * a plan go. Stripe is a stand-in here; nothing real is called.
 */
import { finishPlan, rememberPlan, settlePlans } from "@/lib/plans";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_plan_unknown_only";
const ACCOUNT = "acct_1TestPlanUnk01";
const ANCHOR = Date.UTC(2026, 0, 31, 15, 0, 0) / 1000;
const DAY = 86_400;
const PENDING = "nl:plans:pending";

let session: unknown = null;
let sessionStatus = 200;
let subscription: unknown = null;
let postReply: ((sent: number) => unknown) | null = null;
const posts: number[] = [];
let requests = 0;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname !== "api.stripe.com") throw new Error(`unexpected request to ${url}`);
  requests += 1;
  const method = init?.method ?? "GET";
  const path = url.pathname.replace(/^\/v1/, "");
  const answer = (body: unknown, status = 200) => new Response(body === undefined ? "null" : JSON.stringify(body), { status });
  if (/^\/checkout\/sessions\/cs_test_[A-Za-z0-9]+$/.test(path)) {
    return sessionStatus === 200 ? answer(session) : answer({ error: { message: "No such checkout session" } }, sessionStatus);
  }
  if (/^\/subscriptions\/sub_[A-Za-z0-9]+$/.test(path) && method === "GET") return answer(subscription);
  if (/^\/subscriptions\/sub_[A-Za-z0-9]+$/.test(path) && method === "POST") {
    const sent = Number(new URLSearchParams(String(init?.body)).get("cancel_at"));
    posts.push(sent);
    return answer(postReply ? postReply(sent) : { ...(subscription as Record<string, unknown>), cancel_at: sent });
  }
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

const SESSION = "cs_test_planunk00001";
const SUB = "sub_planunk00001";
const goodSession = (over: Record<string, unknown> = {}) => ({
  id: SESSION,
  object: "checkout.session",
  status: "complete",
  subscription: SUB,
  metadata: { store: "harbor", kind: "plan", plan_payments: "3", plan_interval: "month" },
  ...over,
});
const goodSub = (over: Record<string, unknown> = {}) => ({ id: SUB, object: "subscription", status: "active", billing_cycle_anchor: ANCHOR, trial_end: null, cancel_at: null, ...over });
/** A copy of a reply with the named fields left out. */
const without = (reply: Record<string, unknown>, ...keys: string[]) => Object.fromEntries(Object.entries(reply).filter(([key]) => !keys.includes(key)));
const pending = async () => ((await redis.pipeline([["SMEMBERS", PENDING]]))[0] as string[]).length;

/** One plan, written down fresh, settled once by the daily job. */
async function settleOne(): Promise<{ counts: { done: number; open: number; dropped: number; failed: number }; posts: number; pending: number }> {
  redis.clear();
  posts.length = 0;
  await rememberPlan(ACCOUNT, SESSION);
  const counts = await settlePlans();
  return { counts, posts: posts.length, pending: await pending() };
}

async function finishThrows(): Promise<boolean> {
  try {
    await finishPlan(ACCOUNT, SESSION);
    return false;
  } catch {
    return true;
  }
}

function reset(): void {
  session = goodSession();
  sessionStatus = 200;
  subscription = goodSub();
  postReply = null;
}

async function main(): Promise<void> {
  const quiet = console.error;
  console.error = () => {};

  part("Controls: the documented replies");
  reset();
  is("a paid plan: done, its end written once, no longer pending", await settleOne(), { counts: { done: 1, open: 0, dropped: 0, failed: 0 }, posts: 1, pending: 0 });
  is("the end is the close of the third period", posts[0], Date.UTC(2026, 3, 30, 15, 0, 0) / 1000);
  reset();
  subscription = goodSub({ status: "trialing", billing_cycle_anchor: ANCHOR - 14 * DAY, trial_end: ANCHOR });
  is("after a trial: counted from the trial's end", [await finishPlan(ACCOUNT, SESSION), posts.at(-1)], ["done", Date.UTC(2026, 3, 30, 15, 0, 0) / 1000]);
  reset();
  subscription = goodSub({ cancel_at: ANCHOR + 90 * DAY });
  is("a plan that already has its end: done, nothing written", await settleOne(), { counts: { done: 1, open: 0, dropped: 0, failed: 0 }, posts: 0, pending: 0 });
  reset();
  subscription = goodSub({ status: "canceled" });
  is("a plan already canceled: done, nothing written", await settleOne(), { counts: { done: 1, open: 0, dropped: 0, failed: 0 }, posts: 0, pending: 0 });
  reset();
  sessionStatus = 404;
  is("a checkout Stripe confirms it does not know (404): let go", await settleOne(), { counts: { done: 0, open: 0, dropped: 1, failed: 0 }, posts: 0, pending: 0 });
  reset();
  session = goodSession({ status: "expired", subscription: null });
  is("an expired checkout: let go", await settleOne(), { counts: { done: 0, open: 0, dropped: 1, failed: 0 }, posts: 0, pending: 0 });
  reset();
  session = goodSession({ metadata: { store: "harbor" } });
  is("a checkout that is neither a plan nor a membership with an end: let go", await settleOne(), { counts: { done: 0, open: 0, dropped: 1, failed: 0 }, posts: 0, pending: 0 });
  reset();
  session = goodSession({ status: "open", subscription: null });
  is("a checkout still open: kept for its two days", await settleOne(), { counts: { done: 0, open: 1, dropped: 0, failed: 0 }, posts: 0, pending: 1 });
  reset();
  session = goodSession({ metadata: { store: "harbor", kind: "plan", plan_payments: "1", plan_interval: "month" } });
  is("a 'plan' of one payment by its own terms: let go, nothing written", await settleOne(), { counts: { done: 0, open: 0, dropped: 1, failed: 0 }, posts: 0, pending: 0 });

  const kept = { counts: { done: 0, open: 0, dropped: 0, failed: 1 }, posts: 0, pending: 1 };

  part("A checkout answered 200 in an unknown shape: failed, kept pending, nothing written");
  const sessions: [string, unknown][] = [
    ["{}", {}],
    ["null", null],
    ["a list", []],
    ["a string", "cs_test_planunk00001"],
    ["no object", without(goodSession(), "object")],
    ["another object", goodSession({ object: "subscription" })],
    ["another id", goodSession({ id: "cs_test_planunk00002" })],
    ["no metadata", without(goodSession(), "metadata")],
    ["metadata null", goodSession({ metadata: null })],
    ["metadata a list", goodSession({ metadata: [] })],
    ["metadata a string", goodSession({ metadata: "plan" })],
    ["no status", without(goodSession(), "status")],
    ["status null", goodSession({ status: null })],
    ["a status Stripe does not name", goodSession({ status: "processing" })],
    ["complete without a subscription", goodSession({ subscription: null })],
    ["complete with a subscription that is not an id", goodSession({ subscription: { id: SUB } })],
    ["only object and id", { id: SESSION, object: "checkout.session" }],
  ];
  for (const [name, shape] of sessions) {
    reset();
    session = shape;
    is(`checkout ${name}: finishPlan throws`, await finishThrows(), true);
    is(`checkout ${name}: the daily job keeps it pending`, await settleOne(), kept);
  }

  part("A subscription answered 200 in an unknown shape: failed, kept pending, nothing written");
  const subs: [string, unknown][] = [
    ["{}", {}],
    ["null", null],
    ["a list", []],
    ["no object", without(goodSub(), "object")],
    ["another object", goodSub({ object: "checkout.session" })],
    ["another id", goodSub({ id: "sub_planunk00002" })],
    ["no status", without(goodSub(), "status")],
    ["no billing_cycle_anchor or trial_end", without(goodSub(), "billing_cycle_anchor", "trial_end")],
    ["no billing_cycle_anchor", without(goodSub(), "billing_cycle_anchor")],
    ["billing_cycle_anchor as text", goodSub({ billing_cycle_anchor: String(ANCHOR) })],
    ["billing_cycle_anchor 0", goodSub({ billing_cycle_anchor: 0 })],
    ["billing_cycle_anchor not whole", goodSub({ billing_cycle_anchor: ANCHOR + 0.5 })],
    ["billing_cycle_anchor null", goodSub({ billing_cycle_anchor: null })],
    ["trial_end as text", goodSub({ trial_end: String(ANCHOR) })],
    ["cancel_at as text", goodSub({ cancel_at: String(ANCHOR + 30 * DAY) })],
  ];
  for (const [name, shape] of subs) {
    reset();
    subscription = shape;
    is(`subscription ${name}: finishPlan throws`, await finishThrows(), true);
    is(`subscription ${name}: the daily job keeps it pending, no end written over it`, await settleOne(), kept);
  }

  part("Stripe's reply to the end that is not that end: failed, kept pending");
  const replies: [string, (sent: number) => unknown][] = [
    ["{}", () => ({})],
    ["null", () => null],
    ["no cancel_at", () => goodSub()],
    ["another cancel_at", (sent) => goodSub({ cancel_at: sent + DAY })],
    ["another id", (sent) => goodSub({ id: "sub_planunk00002", cancel_at: sent })],
    ["another object", (sent) => ({ ...goodSub({ cancel_at: sent }), object: "checkout.session" })],
  ];
  for (const [name, reply] of replies) {
    reset();
    postReply = reply;
    is(`reply ${name}: written once, then kept pending as failed`, await settleOne(), { counts: { done: 0, open: 0, dropped: 0, failed: 1 }, posts: 1, pending: 1 });
  }

  part("Written down at checkout only when the SADD added it");
  const real = redis.pipeline.bind(redis);
  for (const shape of [[], [undefined], [null], ["QUEUED"], [0], [2], ["1"], [1, 1], {}, null] as unknown[]) {
    reset();
    redis.clear();
    requests = 0;
    redis.pipeline = (async (commands: (string | number)[][]) => (commands[0]?.[0] === "SADD" ? shape : real(commands))) as typeof redis.pipeline;
    let threw = false;
    try {
      await rememberPlan(ACCOUNT, SESSION);
    } catch {
      threw = true;
    }
    redis.pipeline = real;
    is(`SADD answered ${JSON.stringify(shape)}: rememberPlan throws, so the buyer is not sent to Stripe`, [threw, requests], [true, 0]);
  }
  reset();
  redis.clear();
  await rememberPlan(ACCOUNT, SESSION);
  is("SADD answered 1: written down, no Stripe call", [await pending(), requests], [1, 0]);

  part("The daily job refuses a pending list of unknown shape");
  for (const shape of [null, "x", {}, [1], [null], 0] as unknown[]) {
    reset();
    redis.clear();
    await rememberPlan(ACCOUNT, SESSION);
    requests = 0;
    redis.pipeline = (async (commands: (string | number)[][]) => (commands[0]?.[0] === "SMEMBERS" ? [shape] : real(commands))) as typeof redis.pipeline;
    let threw = false;
    try {
      await settlePlans();
    } catch {
      threw = true;
    }
    redis.pipeline = real;
    is(`SMEMBERS answered ${JSON.stringify(shape)}: settlePlans throws (the job reports not ok), plan kept, no Stripe call`, [threw, await pending(), requests], [true, 1, 0]);
  }
  reset();
  redis.clear();
  is("a confirmed empty pending list: nothing to do", await settlePlans(), { done: 0, open: 0, dropped: 0, failed: 0 });

  console.error = quiet;
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
