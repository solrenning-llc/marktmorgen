/**
 * CX-116 second money review of PR #3006 (CK3), head 2ff01a20. Proof tests only:
 * each `is` below states the behaviour a correct head must have, and FAILS on
 * this head. Synthetic clock, the in-memory Redis stand-in and a stateful
 * stand-in Stripe; no network.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";
import { store as redis } from "./redis-stub";

const originalFetch = globalThis.fetch;
process.env.STRIPE_SECRET_KEY = "sk_test_local_cx116_only";
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
  if (path === "/coupons") return json(200, { id: "coupon_cx116" });
  if (path === "/promotion_codes") {
    const p = new URLSearchParams(body);
    serial += 1;
    const id = `promo_cx116_${serial}`;
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
const ACCOUNT = "acct_cx116synthetic";
const shop = { sid: SID, statsId: STATS, stripeAccountId: ACCOUNT };
const asked = { code: "HOLIDAY25", off: { kind: "percent" as const, percent: 25 }, maxRedemptions: null, minimum: null };
const NOW = 1_800_000_000;
const HOUR = 3600;
const start = NOW + 2 * HOUR;
const end = start + 48 * HOUR;
const reset = () => redis.pipeline([["DEL", `nl:dsched:${STATS}`, "nl:dsched:due", `nl:dsched:lock:${STATS}`]]);
const due = async () => (await redis.pipeline([["ZRANGEBYSCORE", "nl:dsched:due", "0", "9999999999"]]))[0] as string[];

async function main() {
  try {
    const sched = await import("@/lib/discount-schedule");

    part("P1 (first reviewer's MÉDIO, :275-281): a failed switch-on of the checkout's code box is lost for good");
    await reset();
    const m1 = await sched.scheduleCode(shop, asked, { start, end }, NOW);
    const m1id = m1.ok ? m1.code.id : "";
    let marked = 0;
    let markFails = true;
    const deps = {
      findStore: async (sid: string) => (sid === SID ? shop : null),
      markDiscounts: async () => {
        if (markFails) throw Error("synthetic store write failure");
        marked += 1;
      },
    };
    const r1 = await sched.activateScheduledCodes(Date.now() + 10_000, start, deps);
    is("P1 Stripe has the code live", live.get(m1id), true);
    is("P1 a run whose code box was never switched on is not counted as activated", r1.activated, 0);
    markFails = false;
    await sched.activateScheduledCodes(Date.now() + 10_000, start + 300, deps);
    is("P1 a later healthy run switches the code box on (hasDiscounts true)", marked, 1);

    part("P2 (new): Cancel on a code the job has just switched on says 'canceled, stays off' and leaves it live");
    await reset();
    const m2 = await sched.scheduleCode(shop, { ...asked, code: "SPRING40" }, { start, end }, NOW);
    const m2id = m2.ok ? m2.code.id : "";
    // The job switches it on at its start; the creator's page, read at start - 60 s, still shows "Starting"/"Cancel SPRING40".
    await sched.activateScheduledCodes(Date.now() + 10_000, start, { findStore: async () => shop, markDiscounts: async () => null });
    is("P2 setup: Stripe has the code live", live.get(m2id), true);
    calls = [];
    const canceled = await sched.cancelSchedule(shop, m2id);
    const route = readFileSync("app/api/store/discount/route.ts", "utf8");
    const editor = readFileSync("components/discount-editor.tsx", "utf8");
    const routeTakesNoneAsSuccess = /canceled !== "done" && canceled !== "none"/.test(route);
    const editorToastsStaysOff = editor.includes("canceled. It stays off.");
    is("P2 after Cancel the code is not live on Stripe (or the creator is not told it stays off)",
      live.get(m2id) === false || !(canceled === "none" && routeTakesNoneAsSuccess && editorToastsStaysOff), true);
    is("P2 (detail) cancelSchedule result / Stripe calls made", { canceled, calls: calls.length }, { canceled: "done", calls: 1 });

    part("P3 (new, rule 24 in the caller): an unknown store read drops the schedule for good (default findStore = storeForId)");
    await reset();
    const m3 = await sched.scheduleCode(shop, { ...asked, code: "WINTER30" }, { start, end }, NOW);
    const m3id = m3.ok ? m3.code.id : "";
    const member = `${SID}|${STATS}|${m3id}`;
    const realPipeline = redis.pipeline.bind(redis);
    // One partial pipeline answer for the store-id read ([{}] from Upstash -> result undefined): unknown, not "gone".
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

    part("P4 (first reviewer's LEVE, :261/:300): unreadable records hold the head of the due list for ever");
    await reset();
    // The healthy code is scheduled first (the cap counts the bad records too), then 25 unreadable records due a second earlier.
    const m4 = await sched.scheduleCode(shop, { ...asked, code: "GOOD10" }, { start, end }, NOW);
    const m4id = m4.ok ? m4.code.id : "";
    for (let i = 0; i < 25; i += 1) {
      const id = `promo_bad${i}`;
      await redis.pipeline([["HSET", `nl:dsched:${STATS}`, id, "{not json"], ["ZADD", "nl:dsched:due", start - 1, `${SID}|${STATS}|${id}`]]);
    }
    for (let i = 0; i < 10; i += 1) await sched.activateScheduledCodes(Date.now() + 10_000, start + i * 300, { findStore: async () => shop, markDiscounts: async () => null });
    is("P4 a healthy code behind 25 unreadable entries is switched on within 10 runs", live.get(m4id), true);
    is("P4 unreadable entries leave the due list after a bounded number of runs", (await due()).length <= 1, true);

    part("P5 (new, LEVE): a code Stripe made live at once whose stop is not confirmed is reported as a plain Stripe failure and left live, untracked");
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
    const m5id = `promo_cx116_${serial}`;
    const tracked = Number((await redis.pipeline([["HLEN", `nl:dsched:${STATS}`]]))[0]);
    is("P5 the scheduled code is not usable before its start, or it is kept/told so it can be stopped", live.get(m5id) === false || tracked > 0 || (!m5.ok && m5.reason !== "stripe"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
  done();
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
