/**
 * Audit A5 (Stripe list reads): lib/billing-reminders.ts walks the platform's subscriptions by status (trialing and
 * active for the trial and yearly renewal notices, past_due for the failed payment notice) at most MAX_PAGES pages of
 * 100 a run, from the newest, with no cursor and no deadline. Above 5,000 subscriptions of one status, the oldest are
 * never read: a yearly plan's renewal notice (required by state automatic renewal laws), a trial's notice (card
 * network rules) and a failed payment's notice never reach them, on any run, and the job never says so.
 *
 * What must hold:
 *   - every subscription of each status is reached within a bounded number of daily runs, each run still reading at
 *     most the declared pages a status, newest first, carrying on where the last run stopped (a cursor);
 *   - the walk goes round: a run that reaches the end goes on from the newest, so a subscription created since the
 *     last run is not left waiting a whole lap;
 *   - each status stops at a deadline, and a slow status does not take another's time;
 *   - no notice goes twice across runs and laps (the marks of lib/claim-mark.ts still decide);
 *   - a run that could not read every subscription says so, truthfully (a lap that takes more than one run);
 *   - a cursor not known (an unreadable reply, an id Stripe no longer pages from) starts from the newest, never skips.
 *
 * Synthetic subscriptions, Stripe and Resend answers; no email leaves this machine.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { sendFailedPlanNotices, sendReminders } from "@/lib/billing-reminders";
import { store as redis } from "./redis-stub";

process.env.STRIPE_SECRET_KEY = "sk_test_billing_complete_only";
// A synthetic key the Resend fixture knows (tests/resend-fixture-credentials.ts), shared with tests/plan-payment-failed.test.ts.
process.env.RESEND_API_KEY = "re_test_failed_plan_only";

const NOW = 1_791_700_000;
const DAY = 86_400;
const FAR = () => Date.now() + 3_600_000;
const MONTH_PRICE = { lookup_key: "nimbus_creator_month", unit_amount: 6900, recurring: { interval: "month" } };
const YEAR_PRICE = { lookup_key: "nimbus_creator_year", unit_amount: 69000, recurring: { interval: "year" } };

const emails: string[] = [];
let lists: Record<string, Record<string, unknown>[]> = {};
/** Pages Stripe was asked for, by status. */
const pages: Record<string, number> = {};
/** Advanced by this many ms on every Stripe page, when set (a slow Stripe, on a test clock). */
let msPerPage = 0;
let clock = 0;
const realNow = Date.now;

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  if (url.hostname === "api.stripe.com") {
    if (method === "GET" && url.pathname === "/v1/subscriptions") {
      const status = url.searchParams.get("status") ?? "";
      pages[status] = (pages[status] ?? 0) + 1;
      if (msPerPage) clock += msPerPage;
      const all = lists[status] ?? [];
      const limit = Number(url.searchParams.get("limit") ?? "10");
      const after = url.searchParams.get("starting_after");
      let from = 0;
      if (after) {
        const at = all.findIndex((row) => row.id === after);
        if (at < 0) return json({ error: { type: "invalid_request_error", message: `No such subscription: '${after}'` } }, 400);
        from = at + 1;
      }
      const data = all.slice(from, from + limit);
      return json({ object: "list", data, has_more: from + limit < all.length });
    }
    if (method === "POST" && url.pathname.startsWith("/v1/subscriptions/")) return json({ id: url.pathname.split("/").pop() });
  }
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body ?? "{}"));
    emails.push(Array.isArray(body.to) ? body.to[0] : body.to);
    return json({ id: `re_${emails.length}` });
  }
  return json({}, 404);
}) as typeof fetch;

/** Runs `work` on a test clock that only Stripe's pages move (msPerPage a page). */
async function onTestClock<T>(work: () => Promise<T>): Promise<T> {
  clock = realNow();
  Date.now = () => clock;
  try {
    return await work();
  } finally {
    Date.now = realNow;
    msPerPage = 0;
  }
}

/** Runs `work` and keeps what it logged as an error. */
async function logged<T>(work: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const before = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    return { result: await work(), lines };
  } finally {
    console.error = before;
  }
}

const id = (kind: string, i: number) => `sub_${kind}${String(i).padStart(8, "0")}`;
const sentTo = (sub: string) => emails.filter((to) => to === `${sub}@example.com`).length;

/** A paying monthly plan: never due a notice (no claim, no email), only read. */
const monthly = (sub: string) => ({
  id: sub,
  status: "active",
  cancel_at_period_end: false,
  customer: { email: `${sub}@example.com` },
  items: { data: [{ current_period_start: NOW - 10 * DAY, current_period_end: NOW + 20 * DAY, price: MONTH_PRICE }] },
});
/** A yearly plan renewing in `days`: due its renewal notice while 1 < days <= 30. */
const yearly = (sub: string, days: number) => ({
  id: sub,
  status: "active",
  cancel_at_period_end: false,
  customer: { email: `${sub}@example.com` },
  items: { data: [{ current_period_start: NOW + days * DAY - 365 * DAY, current_period_end: NOW + days * DAY, price: YEAR_PRICE }] },
});
/** A trial ending in `days`: due its notice while 1 < days <= 8. */
const trial = (sub: string, days: number) => ({
  id: sub,
  status: "trialing",
  cancel_at_period_end: false,
  trial_end: NOW + days * DAY,
  customer: { email: `${sub}@example.com` },
  items: { data: [{ current_period_start: NOW - 2 * DAY, current_period_end: NOW + days * DAY, price: MONTH_PRICE }] },
});
/** A past-due plan; only `open` has an invoice that can be paid from an email. */
const pastDue = (sub: string, open: boolean) => ({
  id: sub,
  status: "past_due",
  created: NOW - 90 * DAY,
  trial_end: NOW - 76 * DAY,
  customer: { email: `${sub}@example.com` },
  items: { data: [{ current_period_start: NOW - 2 * DAY, current_period_end: NOW + 28 * DAY, price: MONTH_PRICE }] },
  latest_invoice: {
    id: `in_${sub.slice(4)}inv`,
    status: open ? "open" : "paid",
    amount_due: 6900,
    hosted_invoice_url: `https://invoice.stripe.com/i/${sub}`,
    next_payment_attempt: NOW + 3 * DAY,
  },
});

/** 5,000 newer rows that are read and need nothing, then the oldest one, which does. */
function fiveThousandAndOne(make: (i: number) => Record<string, unknown>, oldest: Record<string, unknown>) {
  return [...Array.from({ length: 5_000 }, (_, i) => make(i)), oldest];
}

function reset(next: Record<string, Record<string, unknown>[]>) {
  redis.clear();
  emails.length = 0;
  for (const key of Object.keys(pages)) delete pages[key];
  lists = next;
}

test("a yearly plan older than the 5,000 newest active subscriptions is warned of its renewal within two daily runs, once", async () => {
  const oldest = id("Year", 1);
  reset({ active: fiveThousandAndOne((i) => monthly(id("Month", i)), yearly(oldest, 20)), trialing: [] });
  const perRun: number[] = [];
  for (let run = 0; run < 2; run += 1) {
    const before = pages.active ?? 0;
    await logged(() => sendReminders(NOW + run * DAY, FAR()));
    perRun.push((pages.active ?? 0) - before);
  }
  assert.equal(sentTo(oldest), 1, "the oldest yearly plan's renewal notice went within two runs");
  assert.ok(perRun.every((n) => n <= 50), `no run reads more than the declared 50 pages of a status (${perRun})`);
  for (let run = 2; run < 6; run += 1) await logged(() => sendReminders(NOW + run * DAY, FAR()));
  assert.equal(sentTo(oldest), 1, "and later runs and laps never send it again");
});

test("a trial older than the 5,000 newest trials is warned before its first charge within two daily runs, once", async () => {
  const oldest = id("Trial", 1);
  // Its notice window (8 days to 1 day before the charge) covers both runs.
  reset({ trialing: fiveThousandAndOne((i) => trial(id("Fresh", i), 13), trial(oldest, 7.5)), active: [] });
  await logged(() => sendReminders(NOW, FAR()));
  await logged(() => sendReminders(NOW + DAY, FAR()));
  assert.equal(sentTo(oldest), 1, "the oldest trial's notice went within two runs");
  for (let run = 2; run < 5; run += 1) await logged(() => sendReminders(NOW + run * DAY, FAR()));
  assert.equal(sentTo(oldest), 1, "never twice");
});

test("a failed payment older than the 5,000 newest past-due plans is told within two runs, once (rule 30: the same walk)", async () => {
  const oldest = id("Late", 1);
  reset({ past_due: fiveThousandAndOne((i) => pastDue(id("Paid", i), false), pastDue(oldest, true)) });
  const perRun: number[] = [];
  for (let run = 0; run < 2; run += 1) {
    const before = pages.past_due ?? 0;
    await logged(() => sendFailedPlanNotices(FAR()));
    perRun.push((pages.past_due ?? 0) - before);
  }
  assert.equal(sentTo(oldest), 1, "the oldest past-due plan was told within two runs");
  assert.ok(perRun.every((n) => n <= 50), `no run reads more than the declared 50 pages (${perRun})`);
  for (let run = 2; run < 5; run += 1) await logged(() => sendFailedPlanNotices(FAR()));
  assert.equal(sentTo(oldest), 1, "never twice");
});

test("a run that could not reach the end of a status says so, and the next run carries on from where it stopped", async () => {
  const oldest = id("Year", 2);
  reset({ active: fiveThousandAndOne((i) => monthly(id("Month", i)), yearly(oldest, 20)), trialing: [] });
  const first = await logged(() => sendReminders(NOW, FAR()));
  assert.ok(
    first.lines.some((line) => line.includes("active") && line.includes("next run")),
    `the incomplete walk is logged truthfully (${first.lines.join(" | ")})`,
  );
  assert.equal(sentTo(oldest), 0, "not reached in the first run: the 5,000 newest come first");
  const before = pages.active ?? 0;
  await logged(() => sendReminders(NOW + DAY, FAR()));
  assert.equal(sentTo(oldest), 1, "the next run read on from the cursor");
  assert.ok((pages.active ?? 0) - before <= 50, "within its own pages");
});

test("a run that reaches the end goes on from the newest: a plan created since the last run is not left a whole lap", async () => {
  const oldest = id("Year", 3);
  const fresh = id("Newyear", 1);
  reset({ active: fiveThousandAndOne((i) => monthly(id("Month", i)), yearly(oldest, 20)), trialing: [] });
  await logged(() => sendReminders(NOW, FAR()));
  // Stripe lists the newest first: the new yearly plan comes before all the others.
  lists.active.unshift(yearly(fresh, 25));
  await logged(() => sendReminders(NOW + DAY, FAR()));
  assert.deepEqual([sentTo(oldest), sentTo(fresh)], [1, 1], "both the oldest and the newest are warned by the second run");
});

test("each status stops at its deadline, and a slow status does not take the next one's time", async () => {
  const due = id("Year", 4);
  reset({ trialing: Array.from({ length: 5_001 }, (_, i) => trial(id("Fresh", i), 13)), active: [yearly(due, 20)] });
  msPerPage = 1_000;
  const result = await onTestClock(() => logged(() => sendReminders(NOW, Date.now() + 60_000)));
  assert.ok((pages.trialing ?? 0) < 50, `the trials stopped at their own deadline, not after 50 pages of a second each (${pages.trialing})`);
  assert.equal(sentTo(due), 1, "the active plans still had their own time, in the same run");
  assert.ok(result.lines.some((line) => line.includes("trialing") && line.includes("next run")), "and the trials' stop is said");

  reset({ trialing: [trial(id("Trial", 9), 7)], active: [yearly(id("Year", 9), 20)] });
  const late = await onTestClock(() => sendReminders(NOW, Date.now() - 1));
  assert.deepEqual([late.seen, pages.trialing ?? 0, pages.active ?? 0, emails.length], [0, 0, 0, 0], "a run past its deadline reads and sends nothing");
});

test("a cursor not known starts from the newest and skips nothing (an unreadable reply; an id Stripe no longer pages from)", async () => {
  const sub = id("Year", 5);
  reset({ active: [monthly(id("Month", 1)), yearly(sub, 20)], trialing: [] });
  await redis.pipeline([["SET", "nl:remind:cursor:active", "not a cursor"]]);
  const odd = await logged(() => sendReminders(NOW, FAR()));
  assert.equal(sentTo(sub), 1, "read from the newest, nothing skipped");
  assert.ok(odd.lines.some((line) => line.includes("cursor")), "and the unreadable cursor is said");

  const other = id("Year", 6);
  reset({ active: [monthly(id("Month", 1)), yearly(other, 20)], trialing: [] });
  // Where a previous run stopped, at a subscription no longer listed under this status: Stripe refuses to page from it.
  await redis.pipeline([["SET", "nl:remind:cursor:active", `sub_Gone00000001 ${NOW - DAY}`]]);
  await logged(() => sendReminders(NOW, FAR()));
  assert.equal(sentTo(other), 1, "the walk starts again from the newest in the same run");
});

test("with fewer than a run's pages, every run reads every subscription from the newest, as before (control)", async () => {
  const sub = id("Year", 7);
  reset({ active: [monthly(id("Month", 1)), yearly(sub, 20)], trialing: [trial(id("Trial", 7), 7)] });
  const first = await logged(() => sendReminders(NOW, FAR()));
  assert.deepEqual([first.result.sent, sentTo(sub)], [2, 1]);
  assert.equal((await redis.pipeline([["GET", "nl:remind:cursor:active"]]))[0], null, "a complete walk keeps no cursor");
  assert.ok(!first.lines.some((line) => line.includes("next run")), "and says nothing is left");
  const again = await logged(() => sendReminders(NOW + DAY, FAR()));
  assert.deepEqual([again.result.sent, again.result.seen], [0, 3], "the next run reads all again and sends nothing twice");
});

test("a claim not known mid-lap ends the pass with the cursor before that subscription, so the next run reads it again", async () => {
  const oldest = id("Year", 8);
  reset({ active: fiveThousandAndOne((i) => monthly(id("Month", i)), yearly(oldest, 20)), trialing: [] });
  await logged(() => sendReminders(NOW, FAR()));
  const original = redis.pipeline.bind(redis);
  // Redis does not answer the claim of the oldest plan's notice (lib/claim-mark.ts reads it as "unknown").
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((command) => command[0] === "SET" && String(command[1]).startsWith(`nl:remind:renewal:${oldest}:`))) throw new Error("synthetic timeout");
    return original(commands);
  }) as typeof redis.pipeline;
  let stopped: Awaited<ReturnType<typeof sendReminders>>;
  try {
    stopped = (await logged(() => sendReminders(NOW + DAY, FAR()))).result;
  } finally {
    redis.pipeline = original;
  }
  assert.deepEqual([stopped.sent, stopped.failed, sentTo(oldest)], [0, 1, 0], "nothing sent on a claim not known");
  assert.match(String((await redis.pipeline([["GET", "nl:remind:cursor:active"]]))[0]), new RegExp(`^${id("Month", 4_999)} \\d+$`), "the cursor stays on the one before it");
  await logged(() => sendReminders(NOW + 2 * DAY, FAR()));
  assert.equal(sentTo(oldest), 1, "the next run reads it again and sends it, once");
});

test("a lap that takes longer than its notices allow is said, with how long it took", async () => {
  reset({ active: fiveThousandAndOne((i) => monthly(id("Month", i)), monthly(id("Month", 9_999))), trialing: [] });
  // A lap begun 20 days ago, stopped at the 4,000th: a yearly renewal reached now may be told fewer than 15 days before.
  await redis.pipeline([["SET", "nl:remind:cursor:active", `${id("Month", 3_999)} ${NOW - 20 * DAY}`]]);
  const { lines } = await logged(() => sendReminders(NOW, FAR()));
  assert.ok(lines.some((line) => line.includes("active") && line.includes("20 days") && line.includes("later than its rule")), lines.join(" | "));
});

test("the declared ceiling: 50 pages a status a run, and the job's runs a day are vercel.json's (rule 24)", async () => {
  const { REMINDER_PAGES_PER_RUN, REMINDER_RUNS_PER_DAY } = await import("@/lib/billing-reminders");
  const { readFileSync } = await import("node:fs");
  const crons = (JSON.parse(readFileSync("vercel.json", "utf8")) as { crons: { path: string; schedule: string }[] }).crons;
  const runs = crons.filter((cron) => cron.path === "/api/cron/reminders");
  assert.deepEqual(runs.map((cron) => cron.schedule), ["0 10 * * *"], "once a day; a new schedule changes REMINDER_RUNS_PER_DAY");
  assert.deepEqual([REMINDER_PAGES_PER_RUN, REMINDER_RUNS_PER_DAY], [50, 1]);
});
