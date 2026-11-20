/**
 * 511 [CK3], issue #4466: a scheduled code that Stripe confirmed live, while
 * the store never confirmed the checkout's code box on, must not be kept as
 * a certain failure while it is still live on the creator's Stripe account.
 * At the last try the code is switched off first, and only a confirmed stop
 * makes the failure final; a stop Stripe does not confirm keeps the schedule
 * pending (still due) for the next run, never "failed" with the code live.
 * Synthetic clock, the in-memory Redis stand-in and a stateful stand-in
 * Stripe (the code's active flag is kept between calls); no network.
 */
import { done, is, part } from "./check";
import { store as redis } from "./redis-stub";

process.env.STRIPE_SECRET_KEY = "sk_test_local_4466_only";
process.env.STRIPE_CONNECT_API_BASE = "http://127.0.0.1:4996";
const originalFetch = globalThis.fetch;
let active = false;
let stopFails = false;
let stops = 0;
/** A switch-on that lands at Stripe but whose answer is lost (a 500 after the write), as #4466's other door. */
let onLost = false;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (!url.startsWith("http://127.0.0.1:4996/")) throw Error("Unexpected external request " + url);
  const path = url.replace(/^http:\/\/127\.0\.0\.1:4996(\/v1)?/, "");
  const body = init?.body ? String(init.body) : "";
  const method = init?.method ?? "GET";
  const json = (status: number, v: unknown) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
  if (path === "/coupons") return json(200, { id: "coupon_4466" });
  if (path === "/promotion_codes" && method === "POST") {
    active = new URLSearchParams(body).get("active") !== "false";
    return json(200, { id: "promo_Fixture4466", code: "TESTCODE", active });
  }
  if (path.startsWith("/promotion_codes/")) {
    const want = new URLSearchParams(body).get("active") === "true";
    if (want && onLost) {
      active = true;
      return json(500, { error: { message: "synthetic outage after the write" } });
    }
    if (!want) {
      stops += 1;
      if (stopFails) return json(500, { error: { message: "synthetic outage" } });
    }
    active = want;
    return json(200, { id: "promo_Fixture4466", active });
  }
  if (path.startsWith("/promotion_codes?")) return json(200, { data: active ? [{ id: "promo_Fixture4466", active: true }] : [] });
  throw Error("Unexpected Stripe path " + path);
}) as typeof fetch;

const SID = "a".repeat(32);
const STATS = "b".repeat(32);
const shop = { sid: SID, statsId: STATS, stripeAccountId: "acct_4466synthetic", email: "c@example.test", extra: false };
const NOW = 1_800_000_000;
const HOUR = 3600;
const MEMBER = `${SID}|${STATS}|promo_Fixture4466`;
const reset = () => redis.pipeline([["DEL", `nl:dsched:${STATS}`, "nl:dsched:due", `nl:dsched:lock:${STATS}`]]);
const isDue = async () => (await redis.pipeline([["ZSCORE", "nl:dsched:due", MEMBER]]))[0] !== null;

async function main() {
  try {
    const { ACTIVATION_TRIES, RETRY_SECONDS, NOTICE_TRIES } = await import("@/lib/discount-schedule-rules");
    const sched = await import("@/lib/discount-schedule");
    const { livePromotionId } = await import("@/lib/discount");
    const start = NOW + 2 * HOUR;
    const end = start + 48 * HOUR;
    const asked = { code: "TESTCODE", off: { kind: "percent" as const, percent: 25 }, maxRedemptions: null, minimum: null };
    const deps = { findStore: async () => shop, markDiscounts: async () => null };
    const failedFlag = async () => {
      const st = await sched.readSchedules(STATS);
      return st.ok ? st.schedules[0]?.failed ?? null : "unreadable";
    };

    part("Stripe confirms live, the code box is never confirmed: switched off before the failure is final");
    await reset();
    const made = await sched.scheduleCode(shop, asked, { start, end }, NOW);
    is("scheduled", made.ok, true);
    is("no link before the start", await livePromotionId(shop.stripeAccountId, "TESTCODE"), null);
    let clock = start;
    for (let i = 0; i < ACTIVATION_TRIES; i += 1) {
      await sched.activateScheduledCodes(Date.now() + 10_000, clock, deps);
      clock += RETRY_SECONDS;
    }
    const failed = await failedFlag();
    const link = await livePromotionId(shop.stripeAccountId, "TESTCODE");
    is("kept as failed", failed, true);
    is("out of the due list", await isDue(), false);
    is("a failed schedule leaves no usable code", link, null);
    is("the failure was made final only after Stripe confirmed it off", active, false);

    part("A stop Stripe does not confirm keeps the schedule pending, never failed while live");
    await reset();
    active = false;
    stops = 0;
    await sched.scheduleCode(shop, asked, { start, end }, NOW);
    stopFails = true;
    clock = start;
    try {
      for (let i = 0; i < ACTIVATION_TRIES; i += 1) {
        await sched.activateScheduledCodes(Date.now() + 10_000, clock, deps);
        clock += RETRY_SECONDS;
      }
    } finally {
      stopFails = false;
    }
    is("Stripe was asked to switch it off", stops > 0, true);
    is("the code is still live on Stripe", active, true);
    is("not recorded as failed while it may be live", await failedFlag(), false);
    is("still due, so the next run settles it", await isDue(), true);
    const settle = await sched.activateScheduledCodes(Date.now() + 10_000, clock, deps);
    is("the next run switches it off and only then records the failure", [settle.failed, active, await failedFlag(), await isDue()], [1, false, true, false]);
    is("and the link finds no code", await livePromotionId(shop.stripeAccountId, "TESTCODE"), null);

    part("RED (Claude 6 on #4522): a stop that never confirms stops calling Stripe after the paid tries, never shown as plainly failed");
    await reset();
    await redis.pipeline([["DEL", "nl:dsched:tell"]]);
    active = false;
    await sched.scheduleCode(shop, asked, { start, end }, NOW);
    // The creator's email, caught here: every notice the job sends is kept, and each is answered as sent.
    const notices: { code: string; failed: boolean; stopUnconfirmed?: boolean }[] = [];
    const telling = { ...deps, tell: async (_store: unknown, entry: { code: string; failed: boolean; stopUnconfirmed?: boolean }) => (notices.push(entry), true) };
    const rules = (await import("@/lib/discount-schedule-rules")) as { STOP_TRIES?: number; NOTICE_TRIES: number; SCHEDULE_UNITS: number };
    const stopTries = rules.STOP_TRIES ?? 3;
    stopFails = true;
    stops = 0;
    clock = start;
    try {
      // Every five minutes for the whole 48-hour window: far more runs than the tries paid for.
      while (clock < end - RETRY_SECONDS) {
        await sched.activateScheduledCodes(Date.now() + 10_000, clock, telling as typeof deps);
        clock += RETRY_SECONDS;
      }
    } finally {
      stopFails = false;
    }
    const kept = await sched.readSchedules(STATS);
    const entry = kept.ok ? (kept.schedules[0] as { failed: boolean; stopUnconfirmed?: boolean }) : null;
    // Two stop calls a run: in the last switch-on try (paid as that try), then in each of the STOP_TRIES runs after it.
    is("RED: Stripe is asked to stop it at most twice a run, in the last try and the paid stop tries", stops <= 2 * (stopTries + 1), true);
    is("RED: every try is paid for at scheduling (with the failure email's tries, from main)", rules.SCHEDULE_UNITS, ACTIVATION_TRIES + stopTries + rules.NOTICE_TRIES);
    is("RED: out of the due list once its stop tries are used", await isDue(), false);
    is("RED: kept as failed with its stop unconfirmed, never a plain failure", [entry?.failed, entry?.stopUnconfirmed], [true, true]);
    // Codex X6 on #4522 (MEDIUM): the worst state for money is told to the creator, once, with words of its own.
    is("RED: the creator is told, once, that its stop was not confirmed", notices.map((n) => [n.code, n.failed, n.stopUnconfirmed === true]), [["TESTCODE", true, true]]);
    is("and nothing is left to tell", (await redis.pipeline([["ZCARD", "nl:dsched:tell"]]))[0], 0);
    const { failureNotice } = await import("@/lib/discount-schedule-notice");
    const mail = failureNotice({ sid: SID }, { code: "TESTCODE", start, end, stopUnconfirmed: true }, start + HOUR);
    is("RED: the email says it may still be on, never that it is off", [/may still be on/.test(mail.subject), /may still be able to use it until its end/.test(mail.text), /still off/.test(mail.text)], [true, true, false]);
    const plain = failureNotice({ sid: SID }, { code: "TESTCODE", start, end }, start + HOUR);
    is("control: a plain failure keeps its own words", [/did not switch on/.test(plain.subject), /still off/.test(plain.text)], [true, true]);

    part("An interrupted terminal write cannot leave the creator with no warning pending");
    await reset();
    await redis.pipeline([["DEL", "nl:dsched:tell"]]);
    await sched.scheduleCode(shop, asked, { start, end }, NOW);
    notices.length = 0;
    const realRun = redis.run.bind(redis);
    let interrupted = false;
    redis.run = (command) => {
      if (!interrupted && command[0] === "ZADD" && command[1] === sched.TELL_KEY) {
        interrupted = true;
        throw new Error("synthetic write interruption before the notice was queued");
      }
      return realRun(command);
    };
    stopFails = true;
    clock = start;
    try {
      while (clock < start + HOUR && !interrupted) {
        await sched.activateScheduledCodes(Date.now() + 10_000, clock, telling as typeof deps);
        clock += RETRY_SECONDS;
      }
      is("an interrupted transition keeps the failed decision and leaves its notice recoverable", [interrupted, await isDue(), await failedFlag()], [true, true, true]);
      const tried = stops;
      await sched.activateScheduledCodes(Date.now() + 10_000, clock, telling as typeof deps);
      await sched.activateScheduledCodes(Date.now() + 10_000, clock + RETRY_SECONDS, telling as typeof deps);
      is("after recovery the creator receives one warning", notices.map((n) => [n.code, n.stopUnconfirmed === true]), [["TESTCODE", true]]);
      is("recovering the warning does not spend another paid stop attempt", stops, tried);
    } finally {
      stopFails = false;
      redis.run = realRun;
    }

    part("A repeatedly failed notice enqueue spends the existing finite notice budget");
    await reset();
    await redis.pipeline([["DEL", sched.TELL_KEY]]);
    await sched.scheduleCode(shop, asked, { start, end }, NOW);
    let failedEnqueues = 0;
    const beforeBudgetRun = redis.run.bind(redis);
    redis.run = (command) => {
      if (command[0] === "ZADD" && command[1] === sched.TELL_KEY) {
        failedEnqueues++;
        throw new Error("synthetic persistent notice enqueue failure");
      }
      return beforeBudgetRun(command);
    };
    stopFails = true;
    clock = start;
    try {
      for (let i = 0; i < ACTIVATION_TRIES + NOTICE_TRIES + 10; i++) {
        await sched.activateScheduledCodes(Date.now() + 10_000, clock, telling as typeof deps);
        clock += RETRY_SECONDS;
      }
      is("failed enqueues cannot exceed the existing notice attempts", failedEnqueues <= NOTICE_TRIES, true);
      is("a notice with its budget spent does not occupy the activation queue forever", await isDue(), false);
      const [kept] = await redis.pipeline([["HGET", `nl:dsched:${STATS}`, "promo_Fixture4466"]]);
      is("failed enqueue work is recorded in the existing notice budget", JSON.parse(String(kept)).n, NOTICE_TRIES);
      const atEnd = failedEnqueues;
      await sched.activateScheduledCodes(Date.now() + 10_000, end + 86400, telling as typeof deps);
      is("even after code expiry no unbudgeted enqueue is retried", failedEnqueues, atEnd);
    } finally { stopFails = false; redis.run = beforeBudgetRun; }

    // Claude 4 cloud U on #4522 (6894719098, MEDIUM): activateCode answers false for a refusal and for a 5xx, a
    // timeout or a lost reply alike; in the last three the switch-on may have landed. The last try then kept the
    // schedule as failed with the code possibly live, and a code link still applied it.
    part("A switch-on whose answer is lost may be live: the last try switches it off before the failure is final");
    await reset();
    active = false;
    await sched.scheduleCode(shop, asked, { start, end }, NOW);
    onLost = true;
    clock = start;
    try {
      for (let i = 0; i < ACTIVATION_TRIES; i += 1) {
        await sched.activateScheduledCodes(Date.now() + 10_000, clock, deps);
        clock += RETRY_SECONDS;
      }
    } finally {
      onLost = false;
    }
    is("control: Stripe holds the switch-on whose answer was lost", stops > 0 || active, true);
    is("kept as failed", await failedFlag(), true);
    is("a failed schedule leaves no usable code", [active, await livePromotionId(shop.stripeAccountId, "TESTCODE")], [false, null]);

    part("A pending stop past the end is left to Stripe's own expiry, with no call");
    await reset();
    active = false;
    await sched.scheduleCode(shop, asked, { start, end }, NOW);
    stopFails = true;
    clock = start;
    try {
      for (let i = 0; i < ACTIVATION_TRIES; i += 1) {
        await sched.activateScheduledCodes(Date.now() + 10_000, clock, deps);
        clock += RETRY_SECONDS;
      }
    } finally {
      stopFails = false;
    }
    stops = 0;
    await sched.activateScheduledCodes(Date.now() + 10_000, end + 1, deps);
    is("past the end: kept as failed, out of the due list, Stripe not asked", [await failedFlag(), await isDue(), stops], [true, false, 0]);

    done();
  } finally {
    globalThis.fetch = originalFetch;
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
