/**
 * 511 [CK3], review of PR #3006 (the first review's M1/L1 and the second
 * review's five findings). Each check states what the scheduled discount code
 * must do when a write, a read or Stripe does not answer as hoped: never count
 * a code as switched on while the checkout's code box is not, never tell the
 * creator a live code "stays off", never drop a schedule on a store read that
 * was not understood, never let unreadable entries block healthy codes behind
 * them, never leave a code Stripe made live untracked. Synthetic clock, the
 * in-memory Redis stand-in and a stateful stand-in Stripe; no network.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";
import { store as redis } from "./redis-stub";

const originalFetch = globalThis.fetch;
process.env.STRIPE_SECRET_KEY = "sk_test_local_ck3_review";
process.env.STRIPE_CONNECT_API_BASE = "http://127.0.0.1:4997";

type Call = { path: string; body: string };
let calls: Call[] = [];
/** Stripe's truth: promotion code id -> active. */
const live = new Map<string, boolean>();
let serial = 0;
let promotionActiveOverride: boolean | null = null;
let stopFails = false;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (!url.startsWith("http://127.0.0.1:4997/")) throw Error("Unexpected external request " + url);
  const path = url.replace(/^http:\/\/127\.0\.0\.1:4997(\/v1)?/, "");
  const body = init?.body ? String(init.body) : "";
  calls.push({ path, body });
  const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
  if (path === "/coupons") return json(200, { id: "coupon_ck3review" });
  if (path === "/promotion_codes") {
    const p = new URLSearchParams(body);
    serial += 1;
    const id = `promo_ck3rv_${serial}`;
    const active = promotionActiveOverride ?? p.get("active") !== "false";
    live.set(id, active);
    return json(200, { id, code: p.get("code"), active, expires_at: Number(p.get("expires_at")) || null, times_redeemed: 0 });
  }
  if (path.startsWith("/promotion_codes/")) {
    const id = decodeURIComponent(path.slice("/promotion_codes/".length));
    const want = new URLSearchParams(body).get("active") === "true";
    if (!want && stopFails) return json(500, { error: { message: "synthetic outage" } });
    live.set(id, want);
    return json(200, { id, active: want });
  }
  throw Error("Unexpected Stripe path " + path);
}) as typeof fetch;

const SID = "a".repeat(32);
const STATS = "b".repeat(32);
const ACCOUNT = "acct_ck3review01";
const shop = { sid: SID, statsId: STATS, stripeAccountId: ACCOUNT };
const asked = { code: "HOLIDAY25", off: { kind: "percent" as const, percent: 25 }, maxRedemptions: null, minimum: null };
const NOW = 1_800_000_000;
const HOUR = 3600;
const start = NOW + 2 * HOUR;
const end = start + 48 * HOUR;
const reset = () => redis.pipeline([["DEL", `nl:dsched:${STATS}`, "nl:dsched:due", `nl:dsched:lock:${STATS}`]]);
const due = async () => (await redis.pipeline([["ZRANGEBYSCORE", "nl:dsched:due", "0", "9999999999"]]))[0] as string[];
const kept = async (id: string) => (await redis.pipeline([["HGET", `nl:dsched:${STATS}`, id]]))[0];
const marked = { ...shop, hasDiscounts: true };

async function main() {
  try {
    const sched = await import("@/lib/discount-schedule");

    part("P1: the code counts as switched on only once the checkout's code box is confirmed on");
    await reset();
    const m1 = await sched.scheduleCode(shop, asked, { start, end }, NOW);
    const m1id = m1.ok ? m1.code.id : "";
    let markCalls = 0;
    let markAnswer: () => unknown = () => {
      throw Error("synthetic store write failure");
    };
    const deps = {
      findStore: async (sid: string) => (sid === SID ? shop : null),
      markDiscounts: async () => {
        markCalls += 1;
        return markAnswer();
      },
    };
    const r1 = await sched.activateScheduledCodes(Date.now() + 10_000, start, deps);
    is("P1 Stripe has the code live", live.get(m1id), true);
    is("P1 a run whose code box write threw is not counted as activated", { activated: r1.activated, unknown: r1.unknown }, { activated: 0, unknown: 1 });
    is("P1 the schedule is kept for the next run", typeof (await kept(m1id)) === "string" && (await due()).includes(`${SID}|${STATS}|${m1id}`), true);
    markAnswer = () => null;
    const r1b = await sched.activateScheduledCodes(Date.now() + 10_000, start + 300, deps);
    is("P1 a store write that answers null (store not read) is not activation either", r1b.activated, 0);
    is("P1 still kept after the null answer", typeof (await kept(m1id)), "string");
    markAnswer = () => marked;
    const before = markCalls;
    const r1c = await sched.activateScheduledCodes(Date.now() + 10_000, start + 600, deps);
    is("P1 a later healthy run switches the code box on and counts it", { activated: r1c.activated, box: markCalls - before }, { activated: 1, box: 1 });
    is("P1 only then the schedule goes: Stripe holds the rest", [await kept(m1id), (await due()).length], [null, 0]);
    // A store that answers with the box still off is no confirmation either, and the tries stay bounded.
    await reset();
    const m1b = await sched.scheduleCode(shop, { ...asked, code: "BOXOFF5" }, { start, end }, NOW);
    const m1bid = m1b.ok ? m1b.code.id : "";
    markAnswer = () => ({ ...shop, hasDiscounts: false });
    let boxOff = 0;
    for (let i = 0; i < 6; i += 1) boxOff += (await sched.activateScheduledCodes(Date.now() + 10_000, start + i * 300, deps)).activated;
    is("P1 a store that comes back with the box still off is never activation", boxOff, 0);
    const boxRec = await kept(m1bid);
    is("P1 the tries stay bounded: kept as failed, out of the due list", [typeof boxRec === "string" ? JSON.parse(boxRec).f : boxRec, (await due()).length], [1, 0]);
    // The box is marked before the schedule goes, so a box that is on while the schedule write fails is the safe side.
    const lib = readFileSync("lib/discount-schedule.ts", "utf8");
    is("P1 the code box is marked before the schedule is taken away", lib.indexOf("deps.markDiscounts(") > 0 && lib.indexOf("deps.markDiscounts(") < lib.indexOf('["HDEL", scheduleKey(statsId), id], ["ZREM", DUE_KEY, member]'), true);

    part("P2: Cancel on a code the job has just switched on stops it on Stripe, and says what happened");
    await reset();
    const m2 = await sched.scheduleCode(shop, { ...asked, code: "SPRING40" }, { start, end }, NOW);
    const m2id = m2.ok ? m2.code.id : "";
    await sched.activateScheduledCodes(Date.now() + 10_000, start, { findStore: async () => shop, markDiscounts: async () => marked });
    is("P2 setup: Stripe has the code live", live.get(m2id), true);
    calls = [];
    const canceled = await sched.cancelSchedule(shop, m2id);
    is("P2 the code is stopped on Stripe, one call, and the answer says it had no schedule left", { canceled, calls: calls.map((c) => c.body), live: live.get(m2id) }, { canceled: "stopped", calls: ["active=false"], live: false });
    stopFails = true;
    let unstopped: string;
    try {
      unstopped = await sched.cancelSchedule(shop, m2id);
    } finally {
      stopFails = false;
    }
    is("P2 a stop Stripe does not confirm is never said to be off", unstopped, "stripe");
    const route = readFileSync("app/api/store/discount/route.ts", "utf8");
    const editor = readFileSync("components/discount-editor.tsx", "utf8");
    is("P2 the route no longer takes a missing schedule as a quiet success", /canceled !== "none"/.test(route), false);
    is("P2 the route answers with what the cancel did", route.includes("canceled: cancelState"), true);
    is("P2 the editor's message follows the state it is given", editor.includes('"stopped"') && editor.includes("may have started"), true);

    part("P3: a store read that was not understood keeps the schedule (default store reader)");
    await reset();
    const m3 = await sched.scheduleCode(shop, { ...asked, code: "WINTER30" }, { start, end }, NOW);
    const m3id = m3.ok ? m3.code.id : "";
    const member = `${SID}|${STATS}|${m3id}`;
    const realPipeline = redis.pipeline.bind(redis);
    // One partial pipeline answer for the store-id read ([{}] from Upstash reads as undefined): unknown, not "gone".
    redis.pipeline = (async (commands: (string | number)[][]) =>
      commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === `nl:store:id:${SID}` ? [undefined] : realPipeline(commands)) as typeof redis.pipeline;
    let r3: Record<string, number>;
    try {
      r3 = await sched.activateScheduledCodes(Date.now() + 10_000, start);
    } finally {
      redis.pipeline = realPipeline;
    }
    is("P3 an unknown store read is counted unknown, not dropped", { dropped: r3.dropped, unknown: r3.unknown }, { dropped: 0, unknown: 1 });
    is("P3 the code is still due for the next run", (await due()).includes(member), true);
    is("P3 Stripe still has it off (no harm done yet)", live.get(m3id), false);
    // A confirmed absence (the store's id key is not there) still drops it, as before.
    const r3b = await sched.activateScheduledCodes(Date.now() + 10_000, start);
    is("P3 a store confirmed gone is dropped without a Stripe call", { dropped: r3b.dropped, live: live.get(m3id) }, { dropped: 1, live: false });
    is("P3 and leaves the due list", (await due()).includes(member), false);

    part("P4: unreadable records leave the due list and never block a healthy code behind them");
    await reset();
    // The healthy code is scheduled first (the cap counts the bad records too), then 25 unreadable records due a second earlier.
    const m4 = await sched.scheduleCode(shop, { ...asked, code: "GOOD10" }, { start, end }, NOW);
    const m4id = m4.ok ? m4.code.id : "";
    for (let i = 0; i < 25; i += 1) {
      const id = `promo_bad${i}`;
      await redis.pipeline([["HSET", `nl:dsched:${STATS}`, id, "{not json"], ["ZADD", "nl:dsched:due", start - 1, `${SID}|${STATS}|${id}`]]);
    }
    calls = [];
    for (let i = 0; i < 10; i += 1) await sched.activateScheduledCodes(Date.now() + 10_000, start + i * 300, { findStore: async () => shop, markDiscounts: async () => marked });
    is("P4 a healthy code behind 25 unreadable entries is switched on within 10 runs", live.get(m4id), true);
    is("P4 unreadable entries leave the due list after a bounded number of runs", (await due()).length <= 1, true);
    is("P4 no Stripe call for an unreadable entry", calls.every((c) => c.path === `/promotion_codes/${m4id}`), true);
    is("P4 the unreadable records are kept, never erased by the job", await redis.pipeline([["HLEN", `nl:dsched:${STATS}`]]), [25]);

    part("P5: a code Stripe made live at once whose stop is not confirmed is kept and said so");
    await reset();
    promotionActiveOverride = true;
    stopFails = true;
    let m5: Awaited<ReturnType<typeof sched.scheduleCode>>;
    try {
      m5 = await sched.scheduleCode(shop, { ...asked, code: "EARLY50" }, { start, end }, NOW);
    } finally {
      promotionActiveOverride = null;
      stopFails = false;
    }
    const m5id = `promo_ck3rv_${serial}`;
    is("P5 the creator is told it is live, not a plain Stripe failure", m5, { ok: false, reason: "live" });
    const rec = await kept(m5id);
    is("P5 the code is kept so the studio shows it and the creator can switch it off", typeof rec === "string" ? JSON.parse(rec) : rec, { c: "EARLY50", s: start, e: end, t: 0, f: 1 });
    is("P5 it is never due: the job does not switch it on again", (await due()).length, 0);
    const read = await sched.readSchedules(STATS);
    is("P5 the studio reads it back as failed", read.ok && read.schedules.map((s) => [s.id, s.failed]), [[m5id, true]]);
    calls = [];
    is("P5 the creator's Cancel then stops it", await sched.cancelSchedule(shop, m5id), "done");
    is("P5 and Stripe has it off", [calls.map((c) => c.body), live.get(m5id), await kept(m5id)], [["active=false"], false, null]);
  } finally {
    globalThis.fetch = originalFetch;
  }
  done();
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
