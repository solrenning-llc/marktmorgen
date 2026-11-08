/**
 * 511 [CK3]: a discount code with a start and an end, set ahead. Made switched
 * off on the creator's own Stripe account (`active=false`, `expires_at` the
 * end), switched on by the five-minute job at its start, retried a bounded
 * number of times and then shown as failed, never in silence. Synthetic clock,
 * the in-memory Redis stand-in and a stand-in Stripe only.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";
import { store as redis } from "./redis-stub";

const originalFetch = globalThis.fetch;
process.env.STRIPE_SECRET_KEY = "sk_test_local_ck3_only";
process.env.STRIPE_CONNECT_API_BASE = "http://127.0.0.1:4998";

type Call = { method: string; path: string; body: string; key: string | null };
let calls: Call[] = [];
/** What the stand-in answers a switch-on with, by try. */
let activateReplies: { status: number; body: unknown }[] = [];
let promotionReply: (body: URLSearchParams) => unknown = (body) => ({ id: "promo_ck3synthetic", code: body.get("code"), active: body.get("active") !== "false", expires_at: Number(body.get("expires_at")) || null, times_redeemed: 0 });

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (!url.startsWith("http://127.0.0.1:4998/")) throw Error("Unexpected external request " + url);
  const path = url.replace(/^http:\/\/127\.0\.0\.1:4998(\/v1)?/, "");
  const headers = new Headers(init?.headers);
  const body = init?.body ? String(init.body) : "";
  calls.push({ method: init?.method ?? "GET", path, body, key: headers.get("Idempotency-Key") });
  const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
  if (path === "/coupons") return json(200, { id: "coupon_ck3synthetic" });
  if (path === "/promotion_codes") return json(200, promotionReply(new URLSearchParams(body)));
  if (path.startsWith("/promotion_codes/")) {
    const id = decodeURIComponent(path.slice("/promotion_codes/".length));
    const params = new URLSearchParams(body);
    if (params.get("active") === "false") return json(200, { id, active: false });
    const next = activateReplies.shift() ?? { status: 200, body: { id, active: true } };
    return json(next.status, next.body);
  }
  throw Error("Unexpected Stripe path " + path);
}) as typeof fetch;

const SID = "a".repeat(32);
const STATS = "b".repeat(32);
const ACCOUNT = "acct_ck3synthetic01";
const shop = { sid: SID, statsId: STATS, stripeAccountId: ACCOUNT, email: "creator@example.test", extra: false };
const asked = { code: "HOLIDAY25", off: { kind: "percent" as const, percent: 25 }, maxRedemptions: null, minimum: null };
const NOW = 1_800_000_000;
const HOUR = 3600;

async function main() {
  try {
    const rules = await import("@/lib/discount-schedule-rules");
    const sched = await import("@/lib/discount-schedule");
    const { MAX_SCHEDULED_CODES, ACTIVATION_TRIES, RETRY_SECONDS, SCHEDULE_UNITS, MIN_LEAD_SECONDS, MAX_AHEAD_SECONDS, readWindow, scheduleState, readScheduleConfirmation } = rules;

    part("The rules: bounded, and paid for before anything is spent");
    is("a store keeps at most a handful of scheduled codes", MAX_SCHEDULED_CODES > 0 && MAX_SCHEDULED_CODES <= 20, true);
    is("activation is tried a bounded number of times", ACTIVATION_TRIES >= 2 && ACTIVATION_TRIES <= 5, true);
    is("each try is one studio request taken when the code is scheduled", SCHEDULE_UNITS, ACTIVATION_TRIES);
    is("retries wait for a later five-minute run", RETRY_SECONDS >= 300, true);

    part("The start and the end, read and refused in words");
    const start = NOW + 2 * HOUR;
    const end = start + 48 * HOUR;
    is("a good window is read", readWindow({ start: String(start), end: String(end) }, NOW), { ok: true, start, end });
    is("a start too soon is refused", readWindow({ start: String(NOW + MIN_LEAD_SECONDS - 1), end: String(end) }, NOW).ok, false);
    is("a start more than a year ahead is refused", readWindow({ start: String(NOW + MAX_AHEAD_SECONDS + 1), end: String(NOW + MAX_AHEAD_SECONDS + 2 * HOUR) }, NOW).ok, false);
    is("an end at or before the start is refused", readWindow({ start: String(start), end: String(start) }, NOW), { ok: false, reason: "end" });
    is("an end is required", readWindow({ start: String(start) }, NOW), { ok: false, reason: "end" });
    is("words are refused", readWindow({ start: "tomorrow", end: String(end) }, NOW), { ok: false, reason: "start" });
    is("fractions are refused", readWindow({ start: String(start + 0.5), end: String(end) }, NOW), { ok: false, reason: "start" });
    is("each refusal has a sentence", typeof rules.SCHEDULE_PROBLEMS.start === "string" && typeof rules.SCHEDULE_PROBLEMS.end === "string", true);

    part("Scheduling makes the code switched off on the creator's own Stripe, with Stripe's own end");
    calls = [];
    const made = await sched.scheduleCode(shop, asked, { start, end }, NOW);
    is("scheduled", made.ok, true);
    const promo = calls.find((c) => c.path === "/promotion_codes");
    const sent = new URLSearchParams(promo?.body ?? "");
    is("the promotion code is made switched off", sent.get("active"), "false");
    is("Stripe's expiry is the end", sent.get("expires_at"), String(end));
    is("two Stripe calls, the coupon and the code", calls.length, 2);
    const record = await redis.pipeline([["HGET", `nl:dsched:${STATS}`, "promo_ck3synthetic"], ["ZSCORE", "nl:dsched:due", `${SID}|${STATS}|promo_ck3synthetic`]]);
    is("the schedule is kept for the store", JSON.parse(String(record[0])), { c: "HOLIDAY25", s: start, e: end, t: 0, f: 0 });
    is("the code is due at its start", Number(record[1]), start);

    part("The studio reads its schedules back");
    const read = await sched.readSchedules(STATS);
    is("read exactly", read, { ok: true, schedules: [{ id: "promo_ck3synthetic", code: "HOLIDAY25", start, end, tries: 0, failed: false }] });
    is("the confirmation reader takes the route's answer", readScheduleConfirmation({ schedules: read.ok ? read.schedules : [] }), read.ok ? read.schedules : null);
    is("the confirmation reader refuses a broken row", readScheduleConfirmation({ schedules: [{ id: "promo_x", code: "A", start: "1", end: 2, tries: 0, failed: false }] }), null);
    is("the confirmation reader refuses no list", readScheduleConfirmation({}), null);

    part("Nothing happens before the start");
    calls = [];
    let found = 0;
    const deps = { findStore: async (sid: string) => { found += 1; return sid === SID ? shop : null; }, markDiscounts: async () => { marked += 1; return { ...shop, hasDiscounts: true }; } };
    let marked = 0;
    let run = await sched.activateScheduledCodes(Date.now() + 10_000, start - 1, deps);
    is("no Stripe call before the start", calls.length, 0);
    is("no store read before the start", found, 0);
    is("nothing activated", run.activated, 0);

    part("At the start the five-minute job switches it on, once, and checks Stripe's exact answer");
    run = await sched.activateScheduledCodes(Date.now() + 10_000, start, deps);
    is("one Stripe call", calls.length, 1);
    is("it switches the code on", calls[0]?.body, "active=true");
    is("with an idempotency key", typeof calls[0]?.key === "string" && calls[0].key.length > 10, true);
    is("activated", run.activated, 1);
    is("the checkout's code box is switched on", marked, 1);
    const after = await redis.pipeline([["HGET", `nl:dsched:${STATS}`, "promo_ck3synthetic"], ["ZSCORE", "nl:dsched:due", `${SID}|${STATS}|promo_ck3synthetic`]]);
    is("the schedule is gone once live: Stripe holds the rest", after, [null, null]);
    calls = [];
    await sched.activateScheduledCodes(Date.now() + 10_000, start + 600, deps);
    is("never switched on twice", calls.length, 0);

    part("An unclear answer is retried, then shown as failed, never in silence");
    await redis.pipeline([["DEL", `nl:dsched:${STATS}`, "nl:dsched:due"]]);
    const made2 = await sched.scheduleCode(shop, { ...asked, code: "SPRING10" }, { start, end }, NOW);
    is("scheduled again", made2.ok, true);
    calls = [];
    activateReplies = [
      { status: 200, body: { id: "promo_ck3synthetic", active: "true" } },
      { status: 500, body: { error: { message: "synthetic" } } },
      { status: 200, body: { id: "promo_other", active: true } },
      { status: 200, body: {} },
      { status: 200, body: { id: "promo_ck3synthetic", active: true, error: { message: "x" } } },
    ];
    let clock = start;
    for (let i = 0; i < ACTIVATION_TRIES; i += 1) {
      run = await sched.activateScheduledCodes(Date.now() + 10_000, clock, deps);
      is(`try ${i + 1} is not activation`, run.activated, 0);
      clock += RETRY_SECONDS;
    }
    is("one Stripe call a try, no more", calls.length, ACTIVATION_TRIES);
    is("a new idempotency key for each try", new Set(calls.map((c) => c.key)).size, ACTIVATION_TRIES);
    const failedNow = await sched.readSchedules(STATS);
    is("marked failed after the last try", failedNow.ok && failedNow.schedules[0]?.failed, true);
    is("out of the due list", await redis.pipeline([["ZSCORE", "nl:dsched:due", `${SID}|${STATS}|promo_ck3synthetic`]]), [null]);
    calls = [];
    await sched.activateScheduledCodes(Date.now() + 10_000, clock + HOUR, deps);
    is("no more tries once failed", calls.length, 0);
    is("the studio says failed", scheduleState({ active: false, expiresAt: end, timesRedeemed: 0, maxRedemptions: null }, failedNow.ok ? failedNow.schedules[0] : null, clock), "failed");
    activateReplies = [];

    part("A start the job never reached before the end fails without a call");
    await redis.pipeline([["DEL", `nl:dsched:${STATS}`, "nl:dsched:due"]]);
    await sched.scheduleCode(shop, asked, { start, end }, NOW);
    calls = [];
    await sched.activateScheduledCodes(Date.now() + 10_000, end + 1, deps);
    is("no Stripe call past the end", calls.length, 0);
    const late = await sched.readSchedules(STATS);
    is("shown as failed", late.ok && late.schedules[0]?.failed, true);

    part("A store that is gone, or not this store, is dropped without a call");
    await redis.pipeline([["DEL", `nl:dsched:${STATS}`, "nl:dsched:due"], ["ZADD", "nl:dsched:due", start, `${"c".repeat(32)}|${STATS}|promo_ck3synthetic`], ["ZADD", "nl:dsched:due", start, "garbage"]]);
    calls = [];
    run = await sched.activateScheduledCodes(Date.now() + 10_000, start, deps);
    is("no Stripe call", calls.length, 0);
    is("both dropped", run.dropped, 2);
    is("the due list is empty", await redis.pipeline([["ZCARD", "nl:dsched:due"]]), [0]);

    part("The creator cancels: the schedule goes and the code stays off");
    await sched.scheduleCode(shop, asked, { start, end }, NOW);
    calls = [];
    is("canceled", await sched.cancelSchedule(shop, "promo_ck3synthetic"), "done");
    is("Stripe is told to keep it off", calls.map((c) => c.body), ["active=false"]);
    is("record and due entry gone", await redis.pipeline([["HGET", `nl:dsched:${STATS}`, "promo_ck3synthetic"], ["ZCARD", "nl:dsched:due"]]), [null, 0]);
    calls = [];
    await sched.activateScheduledCodes(Date.now() + 10_000, start, deps);
    is("a canceled code is never switched on", calls.length, 0);
    calls = [];
    is("canceling what has no schedule left stops it on Stripe and says so", await sched.cancelSchedule(shop, "promo_ck3synthetic"), "stopped");
    is("one call to keep it off", calls.map((c) => c.body), ["active=false"]);

    part("The cap and the store's lock are checked before Stripe is asked");
    await redis.pipeline([["DEL", `nl:dsched:${STATS}`, "nl:dsched:due"]]);
    for (let i = 0; i < MAX_SCHEDULED_CODES; i += 1) await redis.pipeline([["HSET", `nl:dsched:${STATS}`, `promo_fill${i}`, JSON.stringify({ c: `FILL${i}`, s: start, e: end, t: 0, f: 0 })]]);
    calls = [];
    is("full", await sched.scheduleCode(shop, asked, { start, end }, NOW), { ok: false, reason: "full" });
    is("no Stripe call when full", calls.length, 0);
    await redis.pipeline([["DEL", `nl:dsched:${STATS}`], ["SET", `nl:dsched:lock:${STATS}`, "somebody", "EX", 30]]);
    is("busy", await sched.scheduleCode(shop, asked, { start, end }, NOW), { ok: false, reason: "busy" });
    is("no Stripe call when busy", calls.length, 0);
    await redis.pipeline([["DEL", `nl:dsched:lock:${STATS}`]]);

    part("Stripe making it live at once is refused and switched off");
    promotionReply = (body) => ({ id: "promo_ck3synthetic", code: body.get("code"), active: true, expires_at: end, times_redeemed: 0 });
    calls = [];
    is("refused", await sched.scheduleCode(shop, asked, { start, end }, NOW), { ok: false, reason: "stripe" });
    is("and switched off", calls.at(-1)?.body, "active=false");
    is("no schedule kept", await redis.pipeline([["HLEN", `nl:dsched:${STATS}`]]), [0]);

    part("An unreadable due list is unknown: nothing is switched on");
    await sched.scheduleCode(shop, asked, { start, end }, NOW).catch(() => null);
    const realPipeline = redis.pipeline.bind(redis);
    redis.pipeline = (async (commands: (string | number)[][]) => (commands[0]?.[0] === "ZRANGEBYSCORE" ? [{ not: "a list" }] : realPipeline(commands))) as typeof redis.pipeline;
    calls = [];
    run = await sched.activateScheduledCodes(Date.now() + 10_000, start, deps);
    redis.pipeline = realPipeline;
    is("no Stripe call", calls.length, 0);
    is("counted as unknown", run.unknown, 1);

    part("The state the studio shows");
    const sch = { id: "promo_x", code: "X", start, end, tries: 0, failed: false };
    const off = { active: false, expiresAt: end, timesRedeemed: 0, maxRedemptions: null };
    is("before the start: Scheduled", scheduleState(off, sch, start - 1), "scheduled");
    is("past the start, not yet switched on: starting", scheduleState(off, sch, start + 1), "starting");
    is("live on Stripe: Live", scheduleState({ ...off, active: true }, null, start + 1), "live");
    is("Stripe says live even if a try looked failed", scheduleState({ ...off, active: true }, { ...sch, failed: true }, start + 1), "live");
    is("past its end: Ended", scheduleState({ ...off, active: true }, null, end), "ended");
    is("used up: Ended", scheduleState({ ...off, active: true, maxRedemptions: 3, timesRedeemed: 3 }, null, start + 1), "ended");
    is("switched off with no schedule: off", scheduleState({ ...off, expiresAt: null }, null, start + 1), "off");
    is("labels in American English", [rules.STATE_LABELS.scheduled, rules.STATE_LABELS.live, rules.STATE_LABELS.ended, rules.STATE_LABELS.failed], ["Scheduled", "Live", "Ended", "Activation failed"]);

    part("Wiring: the studio route, the five-minute job and the editor");
    const route = readFileSync("app/api/store/discount/route.ts", "utf8");
    is("the route takes the schedule's studio requests before scheduling", route.indexOf("countStudio(store, null, SCHEDULE_UNITS)") > 0 && route.indexOf("countStudio(store, null, SCHEDULE_UNITS)") < route.indexOf("scheduleCode("), true);
    is("the route can cancel a schedule", route.includes('"unschedule"') && route.includes("cancelSchedule("), true);
    is("switching a code off also drops its schedule", route.includes("dropSchedule("), true);
    is("the route answers with the schedules", route.includes("readSchedules("), true);
    const cron = readFileSync("app/api/cron/imports/route.ts", "utf8");
    is("the five-minute job switches due codes on", cron.includes("activateScheduledCodes("), true);
    const editor = readFileSync("components/discount-editor.tsx", "utf8");
    is("the editor has labeled start and end fields", editor.includes('type="datetime-local"') && editor.includes('htmlFor="discount-start"') && editor.includes('htmlFor="discount-end"'), true);
    is("the editor shows each state", ["STATE_LABELS", "scheduleState("].every((word) => editor.includes(word)), true);
    is("the editor says the time zone", editor.includes("timeZoneName"), true);
    is("the editor can cancel a scheduled code", editor.includes('action: "unschedule"'), true);
    is("no countdown or scarcity words", /countdown|hurry|only \d+ left|ends soon/i.test(editor), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
  done();
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
