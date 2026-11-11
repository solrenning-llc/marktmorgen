/**
 * The trial nudges' daily pass inside a 60-second cron (r24 sweep, unit 5.1):
 *
 *   - it stops starting new work at its deadline, and the next run resumes
 *     where it stopped (a cursor), so every trial is reached and each nudge
 *     goes once;
 *   - a run killed after its mark was taken and before it was kept does not
 *     lose the nudge: the mark is pending only for a short while, and the next
 *     run sends it under the same idempotency key, once; the mark is kept long
 *     before the send, so one killed while the provider had the email, or
 *     after it, is never sent a second time
 *     (tests/r24-trial-nudge-mark-before-send.test.ts has the Amazon path);
 *   - an unreadable cursor starts the walk over from the first page (nothing
 *     skipped), and a walk that reaches the end lets the cursor go.
 *
 * Synthetic stores and Stripe answers; no email leaves this machine.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { claimHandle, setSubscription } from "@/lib/store";
import { sendTrialNudges } from "@/lib/trial-nudges";
import { store as redis, advance } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_trial_nudges_deadline_only";
process.env.RESEND_API_KEY = "re_test_trial_nudges_only";

const DAY = 86_400;
const START = 1_791_000_000;
const CURSOR = "nl:trialnudge:cursor";
const PAGE = 2;

let trials: Record<string, unknown>[] = [];
const listedAfter: (string | null)[] = [];
const sends: { to: string; key: string | null }[] = [];
/** Moves the clock the code reads (Date.now) on every email, so a deadline can pass mid-walk. */
let shiftPerSend = 0;
let hang: { reached: () => void; fail: (error: Error) => void } | null = null;
const realNow = Date.now.bind(Date);
let shift = 0;
Date.now = () => realNow() + shift;

const trial = (id: string, handle: string) => ({ id, status: "trialing", trial_start: START, trial_end: START + 14 * DAY, cancel_at_period_end: false, metadata: { store: handle }, customer: { email: "x@example.com" } });

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.stripe.com" && url.pathname === "/v1/subscriptions") {
    const after = url.searchParams.get("starting_after");
    listedAfter.push(after);
    const from = after ? trials.findIndex((row) => row.id === after) + 1 : 0;
    const data = trials.slice(from, from + PAGE);
    return new Response(JSON.stringify({ data, has_more: from + PAGE < trials.length }), { status: 200 });
  }
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const headers = new Headers(init?.headers);
    sends.push({ to: Array.isArray(body.to) ? body.to[0] : body.to, key: headers.get("Idempotency-Key") });
    shift += shiftPerSend;
    if (hang) {
      const held = hang;
      hang = null;
      // The function is stopped here: the provider never answers this run.
      return new Promise<Response>((_, reject) => {
        held.fail = reject;
        held.reached();
      });
    }
    return new Response(JSON.stringify({ id: `re_${sends.length}` }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

let n = 0;
async function trialStores(count: number): Promise<string[]> {
  const emails: string[] = [];
  trials = [];
  for (let i = 0; i < count; i += 1) {
    n += 1;
    const email = `deadline-${n}@example.com`;
    const sub = `sub_Deadline${String(n).padStart(6, "0")}`;
    await claimHandle(email, `deadline${n}`, "Deadline", "");
    await setSubscription(email, { subscriptionId: sub, active: true, tier: "creator", cycle: "month", trialEnds: START + 14 * DAY, period: paidPeriod() });
    trials.push(trial(sub, `deadline${n}`));
    emails.push(email);
  }
  return emails;
}

test("a walk stops at its deadline and the next run resumes where it stopped, each nudge once", async () => {
  const emails = await trialStores(3);
  sends.length = 0;
  listedAfter.length = 0;
  shiftPerSend = 10_000;
  const first = await sendTrialNudges(START + 3 * DAY, Date.now() + 15_000);
  assert.deepEqual(sends.map((s) => s.to), emails.slice(0, 2), "two sent before the deadline, the third left");
  assert.deepEqual({ sent: first.sent, complete: first.complete }, { sent: 2, complete: false });
  assert.equal(await redis.pipeline([["GET", CURSOR]]).then(([v]) => v), trials[1].id, "the cursor holds the last one handled");
  listedAfter.length = 0;
  const second = await sendTrialNudges(START + 3 * DAY, Date.now() + 15_000);
  shiftPerSend = 0;
  assert.equal(listedAfter[0], trials[1].id, "the next run starts after the last one handled");
  assert.deepEqual(sends.map((s) => s.to), emails, "each nudge once, none skipped");
  assert.deepEqual({ sent: second.sent, complete: second.complete }, { sent: 1, complete: true });
  assert.equal(await redis.pipeline([["GET", CURSOR]]).then(([v]) => v), null, "a walk that reached the end lets the cursor go");
});

test("a deadline that passes during a trial's reads leaves it unmarked, and the next run starts at it", async () => {
  const emails = await trialStores(3);
  await redis.pipeline([["DEL", CURSOR]]);
  sends.length = 0;
  listedAfter.length = 0;
  const original = redis.pipeline.bind(redis);
  let reads = 0;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    // The second trial's first-sale read is slow: the deadline passes while it is read.
    if (commands.some((cmd) => cmd[0] === "GET" && String(cmd[1]).startsWith("nl:firstsale:")) && ++reads === 2) shift += 60_000;
    return original(commands);
  }) as typeof redis.pipeline;
  let first: Awaited<ReturnType<typeof sendTrialNudges>>;
  try {
    first = await sendTrialNudges(START + 3 * DAY, Date.now() + 15_000);
  } finally {
    redis.pipeline = original;
  }
  assert.deepEqual({ sends: sends.map((s) => s.to), sent: first.sent }, { sends: emails.slice(0, 1), sent: 1 });
  assert.equal(await redis.pipeline([["GET", CURSOR]]).then(([v]) => v), trials[0].id, "the cursor stays on the last one handled");
  listedAfter.length = 0;
  const second = await sendTrialNudges(START + 3 * DAY, Date.now() + 15_000);
  assert.equal(listedAfter[0], trials[0].id);
  assert.deepEqual({ sends: sends.map((s) => s.to), sent: second.sent }, { sends: emails, sent: 2 }, "the one cut short goes, once");
});

test("a deadline already passed sends nothing and claims nothing", async () => {
  await trialStores(1);
  sends.length = 0;
  listedAfter.length = 0;
  const result = await sendTrialNudges(START + 3 * DAY, Date.now() - 1);
  assert.deepEqual({ sends: sends.length, listed: listedAfter.length, sent: result.sent, complete: result.complete }, { sends: 0, listed: 0, sent: 0, complete: false });
  // The nudge is still due, and goes on the next run with time.
  await redis.pipeline([["DEL", CURSOR]]);
  const next = await sendTrialNudges(START + 3 * DAY, Date.now() + 15_000);
  assert.deepEqual([next.sent, sends.length], [1, 1]);
});

test("a run killed after its mark and before its send began: the next run sends it, once, under the same key", async () => {
  const [email] = await trialStores(1);
  await redis.pipeline([["DEL", CURSOR]]);
  sends.length = 0;
  // The function is stopped right after its mark is taken: the mark lands, and the run never goes on.
  const original = redis.pipeline.bind(redis);
  let reached!: () => void;
  const atKill = new Promise<void>((resolve) => { reached = resolve; });
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const out = await original(commands);
    if (commands.some((cmd) => cmd[0] === "SET" && String(cmd[1]).startsWith("nl:nudge:") && cmd.includes("NX"))) {
      reached();
      return new Promise(() => {});
    }
    return out;
  }) as typeof redis.pipeline;
  void sendTrialNudges(START + 3 * DAY, Date.now() + 15_000);
  await atKill;
  redis.pipeline = original;
  assert.equal(sends.length, 0, "the killed run sent nothing");
  // A day passes before the next scheduled run.
  advance(DAY * 1000);
  const next = await sendTrialNudges(START + 4 * DAY, Date.now() + 15_000);
  assert.deepEqual(sends.map((s) => s.to), [email], "the next run sends the nudge the killed run never sent");
  assert.equal(sends[0].key, "nl-trial-nudge:" + trials[0].id + ":0", "under the nudge's own idempotency key");
  assert.equal(next.sent, 1);
  advance(DAY * 1000);
  const after = await sendTrialNudges(START + 5 * DAY, Date.now() + 15_000);
  assert.deepEqual([after.sent, sends.length], [0, 1], "and never twice");
});

test("a run killed after its send: the next run never posts it again", async () => {
  const [email] = await trialStores(1);
  await redis.pipeline([["DEL", CURSOR]]);
  sends.length = 0;
  // The function is stopped after the provider took the email: the next Redis call it makes never answers.
  const original = redis.pipeline.bind(redis);
  let reached!: () => void;
  const atKill = new Promise<void>((resolve) => { reached = resolve; });
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (sends.length) {
      reached();
      return new Promise(() => {});
    }
    return original(commands);
  }) as typeof redis.pipeline;
  void sendTrialNudges(START + 3 * DAY, Date.now() + 15_000);
  await atKill;
  redis.pipeline = original;
  assert.equal(sends.length, 1, "the killed run's email went");
  // A day passes before the next scheduled run.
  advance(DAY * 1000);
  const next = await sendTrialNudges(START + 4 * DAY, Date.now() + 15_000);
  assert.deepEqual(sends.map((s) => s.to), [email], "not posted again: the mark was kept before the send");
  assert.equal(next.sent, 0, "nothing asked again");
  advance(DAY * 1000);
  const after = await sendTrialNudges(START + 5 * DAY, Date.now() + 15_000);
  assert.deepEqual([after.sent, sends.length], [0, 1], "and never twice");
});

test("a run killed while the provider had the email: the next run never sends it a second time", async () => {
  await trialStores(1);
  await redis.pipeline([["DEL", CURSOR]]);
  sends.length = 0;
  let reached!: () => void;
  const atSend = new Promise<void>((resolve) => { reached = resolve; });
  const held: { reached: () => void; fail: (error: Error) => void } = { reached: () => reached(), fail: () => {} };
  hang = held;
  const killed = sendTrialNudges(START + 3 * DAY, Date.now() + 15_000);
  await atSend;
  advance(DAY * 1000);
  const next = await sendTrialNudges(START + 4 * DAY, Date.now() + 15_000);
  assert.deepEqual({ sends: sends.length, sent: next.sent }, { sends: 1, sent: 0 }, "the same key is not posted again: it may have gone");
  // The killed run's work ends late; it never keeps or lets go of the next run's mark.
  held.fail(new TypeError("fetch failed"));
  await killed;
  advance(DAY * 1000);
  const after = await sendTrialNudges(START + 5 * DAY, Date.now() + 15_000);
  assert.deepEqual([after.sent, sends.length], [0, 1], "and never later either");
});

test("an unreadable cursor starts the walk over from the first page, skipping nobody", async () => {
  const emails = await trialStores(3);
  sends.length = 0;
  listedAfter.length = 0;
  await redis.pipeline([["SET", CURSOR, "not a subscription"]]);
  const result = await sendTrialNudges(START + 3 * DAY, Date.now() + 15_000);
  assert.equal(listedAfter[0], null, "from the first page");
  assert.deepEqual(sends.map((s) => s.to), emails);
  assert.equal(result.complete, true);
});
