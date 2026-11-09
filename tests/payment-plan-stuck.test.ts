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
 *     PLAN_GIVE_UP_DAYS with no good answer, is never let go (the review of
 *     19ff2c726c, M2, the coordinator's decision): it stays in its line, tried
 *     once every PLAN_STUCK_RETRY_DAYS, its creator told once by email, and
 *     settled as soon as the account answers again. A plan watched for its
 *     earlier end counts those days from when it was due to be read again, so
 *     one failure after a long wait does not slow it.
 *   - P5 (the review's proof, M1): only the creator's own account refusing
 *     (a 403, a 401 naming the account, a reply not its own) counts toward
 *     PLAN_GIVE_UP_DAYS. Stripe down (500), too many requests (429), our own
 *     key refused (401) or missing, for longer than PLAN_GIVE_UP_DAYS, leave
 *     the plan in the line at its usual pace, its creator not told, and it
 *     gets its end once Stripe answers. The cron route does not run the plans
 *     at all without the platform's key.
 *   - An end earlier than the plan's own by less than a day is read again two
 *     days before the plan's own (two daily runs), never minutes before it
 *     (the review's item 3).
 *   - P4: a run stops at the deadline it is given, and every plan it did not
 *     reach is still in its line; the cron route passes it one.
 *   - The review of #3367 (Claude 2, 09/11/2026): (1) under the run's
 *     deadline the plans due again and the new ones are taken in turn, the
 *     one due first first, so new checkouts cannot keep a due plan waiting;
 *     (2) a stuck plan whose notice email could not be sent is logged; (3) a
 *     plan whose own end is already past is ended at once, never sent a
 *     cancel_at in the past (which Stripe documents as a future time).
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
 *
 * Changed with the review of 19ff2c726c (rule 23): P3 asserted the stuck plan
 * left the lines on day 30 with a mark in nl:plans:given-up and a log line;
 * that silent letting go is the defect (M2), so it now asserts the plan stays,
 * is tried once a week from day 30, its creator emailed once, nothing written
 * to nl:plans:given-up (the family is gone: nothing read it), and that it is
 * settled once the account answers. The run's counts name `stuck` and `told`
 * instead of `givenUp`, and "the registry's figures" also holds
 * tellCommandsPerPlan, the once-per-plan telling's commands.
 */
import { readFileSync } from "node:fs";
import * as plans from "@/lib/plans";
import { addPeriods, rememberPlan, settlePlans } from "@/lib/plans";
import { StripeError } from "@/lib/stripe-account";
import { addProduct, claimHandle, ensureStatsId, setStripeAccount, storeForEmail } from "@/lib/store";
import * as registry from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_prerev";
// A synthetic credential the Resend fixture knows (tests/resend-fixture-credentials.ts).
process.env.RESEND_API_KEY = "re_test_store_alerts_stand_in";
process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
const OWNER = "plans-stuck-owner@example.com";
const ACCOUNT = "acct_1TestPlans0001";
const STUCK = "acct_1TestPlansStk1";
const FLAKY = "acct_1TestPlansFlk1";
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
/** Accounts that refuse us (a 403, as a disconnected account does). */
const refusing = new Set<string>([STUCK]);
/** When set, every Stripe call answers this (Stripe down, too many requests, our own key refused). */
let platform: { status: number; body: unknown } | null = null;
const emails: { to: string; subject: string; text: string }[] = [];
let resendFails = false;
/** Every checkout session read, in order: which plans a run reached (the review of #3367, item 1). */
const sessionReads: string[] = [];
/** Subscriptions ended at once (DELETE), with the time on the test clock. */
const cancels: { id: string; at: number }[] = [];
const realNow = Date.now;
let clock = Math.floor(realNow() / 1000) * 1000;
const setClock = (seconds: number) => {
  clock = seconds * 1000;
  Date.now = () => clock;
};
const tick = (days: number) => setClock(clock / 1000 + days * DAY);

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    if (resendFails) return answer({ message: "down" }, 500);
    const body = JSON.parse(String(init?.body)) as { to: string | string[]; subject: string; text: string };
    emails.push({ to: [body.to].flat()[0], subject: body.subject, text: body.text });
    return answer({ id: `email_${emails.length}` });
  }
  if (url.hostname !== "api.stripe.com") return answer({ object: "list", data: [], has_more: false });
  stripeCalls += 1;
  clock += callMs;
  const method = init?.method ?? "GET";
  const path = url.pathname.replace(/^\/v1/, "");
  const on = (init?.headers as Record<string, string> | undefined)?.["Stripe-Account"];
  if (platform) return answer(platform.body, platform.status);
  if (on && refusing.has(on)) return answer({ error: { message: "no access" } }, 403);
  if (on === FLAKY && flakyDown) return answer({ error: { message: "try later" } }, 500);
  const session = /^\/checkout\/sessions\/(cs_test_[A-Za-z0-9]+)$/.exec(path);
  if (session) sessionReads.push(session[1]);
  if (session) return sessions[session[1]] ? answer(sessions[session[1]]) : answer({ error: { message: "No such checkout" } }, 404);
  const sub = /^\/subscriptions\/(sub_[A-Za-z0-9]+)$/.exec(path);
  if (sub && method === "GET") return answer(subscriptions[sub[1]] ?? {});
  if (sub && method === "DELETE") {
    cancels.push({ id: sub[1], at: Math.floor(Date.now() / 1000) });
    subscriptions[sub[1]] = { ...subscriptions[sub[1]], status: "canceled" };
    return answer(subscriptions[sub[1]]);
  }
  // Rule 23 (the owner's decision of 9 November 2026, item 12): a plan ended past its end now asks for its paid
  // invoices from the end on, to give back what was taken after it (lib/plan-late-refunds.ts); this stand-in had none
  // and answered 404. Its plans here took no payment after their end: an empty, whole list
  // (tests/payment-plan-late-refund.test.ts holds the refunds).
  if (path === "/invoices" && method === "GET") return answer({ object: "list", data: [], has_more: false });
  if (sub && method === "POST") {
    const body = new URLSearchParams(String(init?.body));
    // Stripe documents cancel_at as a future time (docs.stripe.com/billing/subscriptions/cancel): one already past is
    // refused here, the case the review of #3367 (item 3) asked about.
    updates.push({ id: sub[1], body, at: Math.floor(Date.now() / 1000) });
    if (Number(body.get("cancel_at")) <= Math.floor(Date.now() / 1000)) {
      return answer({ error: { type: "invalid_request_error", message: "cancel_at must be in the future" } }, 400);
    }
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
const givenUpKey = async () => (await redis.pipeline([["EXISTS", "nl:plans:given-up"]]))[0];
/** A store of OWNER's on `account`, with one product: what rememberPlan is told about the plan. */
async function planStore(account: string): Promise<{ sid: string; product: string }> {
  await claimHandle(OWNER, "plansstuck", "Harbor Plans", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, account, true);
  const made = await addProduct(OWNER, "Twelve-week coaching", "", "300", null);
  const store = (await storeForEmail(OWNER))!;
  return { sid: store.sid, product: made.ok ? made.product.id : "" };
}
type Remember = (account: string, session: string, about?: { sid: string; product: string }) => Promise<void>;
const remember = rememberPlan as unknown as Remember;
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

  redis.clear();
  setClock(ANCHOR + 10 * DAY);
  sessions.cs_test_edge00000001 = checkout("cs_test_edge00000001", { ends_after: "3", ends_interval: "month" });
  const edgeEnd = addPeriods(ANCHOR, "month", 3);
  subscriptions.sub_edge00000001 = { id: "sub_edge00000001", status: "active", billing_cycle_anchor: ANCHOR, cancel_at: edgeEnd - 3600 };
  await rememberPlan(ACCOUNT, "cs_test_edge00000001");
  await settlePlans();
  const [edgeMember] = await retryMembers();
  const [edgeScore] = await redis.pipeline([["ZSCORE", "nl:plans:retry", edgeMember ?? ""]]);
  is("an end an hour sooner than its own: read again two days before its own end (two daily runs ahead)", [Number(edgeMember?.split("|")[2]), Number(edgeScore)], [edgeEnd - 2 * DAY, edgeEnd - 2 * DAY]);

  part("P3: a plan stuck at 403 is never let go: tried less often, then once a week, its creator told once");
  redis.clear();
  emails.length = 0;
  setClock(Math.floor(realNow() / 1000));
  const about = await planStore(STUCK);
  await remember(STUCK, "cs_test_dead00000001", about);
  logged.length = 0;
  const giveUp = (plans as Record<string, unknown>).PLAN_GIVE_UP_DAYS;
  const weekly = (plans as Record<string, unknown>).PLAN_STUCK_RETRY_DAYS;
  is("PLAN_GIVE_UP_DAYS is 30, PLAN_STUCK_RETRY_DAYS 7", [giveUp, weekly], [30, 7]);
  const triedOn: number[] = [];
  const emailedOn: number[] = [];
  for (let d = 1; d <= 90; d += 1) {
    const calls = stripeCalls;
    const sent = emails.length;
    tick(1);
    await settlePlans();
    if (stripeCalls > calls) triedOn.push(d);
    if (emails.length > sent) emailedOn.push(d);
  }
  is("after 90 days the stuck plan is still in its line", await inALine(STUCK, "cs_test_dead00000001"), true);
  is("tried at growing intervals for its first 30 days: far fewer than one try a day", triedOn.filter((d) => d < 30).length <= 12, true);
  is("from day 30, once every 7 days", triedOn.filter((d) => d >= 30), [30, 37, 44, 51, 58, 65, 72, 79, 86]);
  is("its creator is emailed once, on day 30", emailedOn, [30]);
  const told = emails[0];
  is("to the store's owner, naming the store and that the plan's end could not be saved", [told?.to, /Harbor Plans/.test(told?.subject ?? ""), /payment plan/i.test(told?.subject ?? "")], [OWNER, true, true]);
  is("the email names the product, the account, the risk and the fix", [
    (told?.text ?? "").includes("Twelve-week coaching"),
    (told?.text ?? "").includes(STUCK),
    /keep charging the buyer/.test(told?.text ?? ""),
    /reconnect/i.test(told?.text ?? ""),
  ], [true, true, true, true]);
  is("and nothing about the buyer: no address in it at all", /@/.test(told?.text ?? ""), false);
  is("nothing is written to nl:plans:given-up", await givenUpKey(), 0);
  is("the log says so, once", logged.filter((line) => line.includes("tried once a week from now on, its creator emailed")).length, 1);
  sessions.cs_test_dead00000001 = checkout("cs_test_dead00000001", { kind: "plan", plan_payments: "12", plan_interval: "month" });
  subscriptions.sub_dead00000001 = { id: "sub_dead00000001", status: "active", billing_cycle_anchor: ANCHOR + 400 * DAY };
  const back = updates.length;
  // The creator reconnects the account: it answers again.
  refusing.delete(STUCK);
  const settledOn = await (async () => {
    for (let d = 1; d <= 7; d += 1) {
      tick(1);
      await settlePlans();
      if (!(await inALine(STUCK, "cs_test_dead00000001"))) return d;
    }
    return -1;
  })();
  is("once the account answers again, the plan is given its end within a week and leaves the line", [settledOn > 0, updates.length - back, Number(updates.at(-1)?.body.get("cancel_at"))], [true, 1, addPeriods(ANCHOR + 400 * DAY, "month", 12)]);
  is("and the creator was told only that once", emails.length, 1);
  refusing.add(STUCK);

  redis.clear();
  emails.length = 0;
  setClock(Math.floor(realNow() / 1000));
  await remember(STUCK, "cs_test_tell00000001", await planStore(STUCK));
  resendFails = true;
  const mailedOn: number[] = [];
  for (let d = 1; d <= 40; d += 1) {
    const sent = emails.length;
    if (d === 31) resendFails = false;
    tick(1);
    await settlePlans();
    if (emails.length > sent) mailedOn.push(d);
  }
  is("an email that could not be sent on day 30 is sent at the next weekly try, once", mailedOn, [37]);
  // Rule 23: new assertion, red at d62a81f1 (the review of #3367, item 2: an unsent notice left no log line at all).
  is("the stuck plan whose email could not be sent is logged, not let go in silence", logged.filter((line) => line.includes("could not be emailed now")).length >= 1, true);

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

  part("P5: only the creator's own account refusing counts toward PLAN_GIVE_UP_DAYS");
  const refusal = (plans as Record<string, unknown>).isAccountRefusal as ((error: unknown) => boolean) | undefined;
  is("a 403 from the account, a 401 or 403 naming the account, and account_invalid count", [
    new StripeError(403, "unknown", "no access"),
    new StripeError(401, "unknown", "The provided key 'sk_test_***' does not have access to account 'acct_1TestPlansPrf01' (or that account does not exist). Application access may have been revoked."),
    new StripeError(400, "account_invalid", "The account is invalid."),
  ].map((e) => refusal?.(e) ?? null), [true, true, true]);
  is("Stripe down, too many requests, our own key refused or short of a permission, a timeout, no key: none counts", [
    new StripeError(500, "api_error", "api down"),
    new StripeError(429, "rate_limit_error", "Too many requests"),
    new StripeError(401, "unknown", "Invalid API Key provided: sk_test_****abcd"),
    new StripeError(401, "api_key_expired", "Expired API Key provided: sk_test_****abcd"),
    new StripeError(403, "unknown", "The provided key 'rk_test_***' does not have the required permissions for this endpoint on account 'acct_1TestPlansPrf01'."),
    new Error("Selling is not configured"),
    Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }),
  ].map((e) => refusal?.(e) ?? null), [false, false, false, false, false, false, false]);
  const PROOF = "acct_1TestPlansPrf01";
  const failures: [string, { status: number; body: unknown } | null][] = [
    ["Stripe down (500)", { status: 500, body: { error: { message: "api down", type: "api_error" } } }],
    ["too many requests (429)", { status: 429, body: { error: { message: "Too many requests", type: "rate_limit_error" } } }],
    ["our own key refused (401)", { status: 401, body: { error: { message: "Invalid API Key provided: sk_test_****abcd", type: "invalid_request_error" } } }],
    ["our restricted key short of a permission (403)", { status: 403, body: { error: { message: `The provided key 'rk_test_***' does not have the required permissions for this endpoint on account '${PROOF}'.`, type: "invalid_request_error" } } }],
    ["the platform's key missing", null],
  ];
  for (const [name, failure] of failures) {
    redis.clear();
    emails.length = 0;
    setClock(ANCHOR);
    sessions.cs_test_prof00000001 = checkout("cs_test_prof00000001", { kind: "plan", plan_payments: "12", plan_interval: "month" });
    subscriptions.sub_prof00000001 = { id: "sub_prof00000001", status: "active", billing_cycle_anchor: ANCHOR };
    await remember(PROOF, "cs_test_prof00000001", await planStore(PROOF));
    if (failure) platform = failure;
    else delete process.env.STRIPE_SECRET_KEY;
    for (let d = 0; d < 31; d += 1) {
      tick(1);
      await settlePlans();
    }
    platform = null;
    process.env.STRIPE_SECRET_KEY = "sk_test_prerev";
    is(`${name} for 31 days: the plan is still in its line, its creator not told`, [await inALine(PROOF, "cs_test_prof00000001"), emails.length], [true, 0]);
    for (let d = 0; d < 5; d += 1) {
      tick(1);
      await settlePlans();
    }
    is(`${name}: once Stripe answers, the plan gets its agreed end within days`, [subscriptions.sub_prof00000001.cancel_at, await inALine(PROOF, "cs_test_prof00000001")], [addPeriods(ANCHOR, "month", 12), false]);
  }
  const cron = readFileSync("app/api/cron/plans/route.ts", "utf8");
  is("the cron route runs the plans only with the platform's key", /if \(isBillingConfigured\(\)\) \{\s*try \{\s*plans = await settlePlans\(/.test(cron), true);

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

  part("The review of #3367, item 1: under the run's deadline, the plans due again are not kept waiting by new ones");
  redis.clear();
  setClock(Math.floor(realNow() / 1000));
  const newIds = Array.from({ length: 6 }, (_, i) => `cs_test_new${String(i).padStart(9, "0")}`);
  const dueIds = Array.from({ length: 6 }, (_, i) => `cs_test_due${String(i).padStart(9, "0")}`);
  for (const id of [...newIds, ...dueIds]) sessions[id] = checkout(id, { kind: "plan", plan_payments: "3", plan_interval: "month" }, { status: "open", subscription: null });
  for (const id of newIds) await rememberPlan(ACCOUNT, id);
  const nowS = Math.floor(clock / 1000);
  await redis.pipeline(dueIds.map((id, i) => ["ZADD", "nl:plans:retry", nowS - 60 + i, `${ACCOUNT}|${id}|${nowS - 5 * DAY}`]));
  sessionReads.length = 0;
  callMs = 1000;
  // A second a Stripe call, one call a plan here, and 4.5 s: five plans are reached, of the twelve.
  await (settlePlans as (limit?: number, deadline?: number) => ReturnType<typeof settlePlans>)(200, clock + 4_500);
  callMs = 0;
  const reachedDue = sessionReads.filter((id) => dueIds.includes(id));
  const reachedNew = sessionReads.filter((id) => newIds.includes(id));
  // Rule 23: new assertions, red at d62a81f1 (all six new plans first, no due plan reached before the deadline).
  is("the plan due first is the first reached", sessionReads[0], dueIds[0]);
  is("both lines are reached, taken in turn: at least two of each in five", [reachedDue.length >= 2, reachedNew.length >= 2, sessionReads.length], [true, true, 5]);

  part("The review of #3367, item 3: a plan whose own end is already past is ended at once, never given an end in the past");
  for (const [name, payments, interval, ago, cancelAt] of [
    ["a weekly plan of 2 payments, stuck past its end", "2", "week", 30, 0],
    ["a monthly plan of 2 payments, past its end", "2", "month", 70, 0],
    ["a plan past its end with a later end set by hand", "3", "month", 100, 1],
  ] as const) {
    redis.clear();
    updates.length = 0;
    cancels.length = 0;
    setClock(Math.floor(realNow() / 1000));
    const id = `cs_test_past${name.length.toString().padStart(8, "0")}`;
    const anchorAt = Math.floor(clock / 1000) - ago * DAY;
    const own = addPeriods(anchorAt, interval, Number(payments));
    sessions[id] = checkout(id, { kind: "plan", plan_payments: payments, plan_interval: interval });
    subscriptions[`sub_${id.slice(8)}`] = { id: `sub_${id.slice(8)}`, status: "active", billing_cycle_anchor: anchorAt, ...(cancelAt ? { cancel_at: own + 60 * DAY } : {}) };
    await rememberPlan(ACCOUNT, id);
    const run = await settlePlans();
    // Rule 23: new assertions, red at d62a81f1 (a cancel_at in the past is sent, refused, and the plan tried every day).
    is(`${name}: no end at or before now is sent`, updates.filter((u) => Number(u.body.get("cancel_at")) <= u.at).length, 0);
    is(`${name}: the subscription is ended at once, the plan settled and out of its lines`, [cancels.map((c) => c.id), run.done, await inALine(ACCOUNT, id)], [[`sub_${id.slice(8)}`], 1, false]);
  }

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
  // Every way a plan can come out of a try: given its end, gone, open, watched, failing, and stuck past PLAN_GIVE_UP_DAYS.
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
  const tried = run.done + run.open + run.dropped + run.failed + ((run as Record<string, number>).stuck ?? 0) + ((run as Record<string, number>).watched ?? 0);
  is("all six were tried", tried, 6);
  is("Redis commands within readCommandsPerRun + tried x ownCommandsPerPlanTried", commands <= (declared?.readCommandsPerRun ?? 0) + tried * (declared?.ownCommandsPerPlanTried ?? 0), true);
  is("Stripe calls within tried x stripeCallsPerPlanTried", stripeCalls <= tried * (declared?.stripeCallsPerPlanTried ?? 0), true);
  // Rule 23 (item 12 of 9 November 2026): stripeCallsPerPlanTried was 3; a plan past its end now also gives back its
  // late payments, at most LATE_REFUND_CALLS (8) more calls: 11.
  is("the registry's figures", declared && [declared.readCommandsPerRun, declared.ownCommandsPerPlanTried, declared.stripeCallsPerPlanTried, declared.runMs, declared.tellCommandsPerPlan], [2, 4, 11, 25_000, 15]);
  redis.clear();
  emails.length = 0;
  setClock(Math.floor(realNow() / 1000));
  const owned = await planStore(STUCK);
  await redis.pipeline([["ZADD", "nl:plans:retry", Math.floor(clock / 1000) - DAY, `${STUCK}|cs_test_cost00000006|${Math.floor(clock / 1000) - 31 * DAY}|${owned.sid}|${owned.product}`]]);
  let tellCommands = 0;
  swapPipeline(async (sent) => {
    tellCommands += sent.length;
    return real(sent);
  });
  stripeCalls = 0;
  const telling = await settlePlans();
  swapPipeline(real);
  is("a stuck plan whose creator is told: one email, within readCommandsPerRun + ownCommandsPerPlanTried + tellCommandsPerPlan", [telling.told, emails.length, tellCommands <= (declared?.readCommandsPerRun ?? 0) + (declared?.ownCommandsPerPlanTried ?? 0) + (declared?.tellCommandsPerPlan ?? 0), stripeCalls], [1, 1, true, 1]);
  is("the route's budget is the registry's", new RegExp(`const PLANS_MS = ${(declared?.runMs ?? 0).toLocaleString("en-US").replace(",", "_")};`).test(route), true);

  Date.now = realNow;
  console.error = realError;
  done();
}
void main();
