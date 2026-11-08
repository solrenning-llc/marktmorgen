/** Independent Z scenarios. Real readers/moveBooking; fixture setup follows
 * author call-team-read-failure/call-lengths-booking, explicitly credited.
 * No real Stripe, Redis, sender or paid supplier is contacted. */
import { addProduct, claimHandle, ensureStatsId, setProductCall, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { moveBooking, type CallListing } from "@/lib/calls";
import { MAX_MOVES, type CallSetup, zonedToUtc } from "@/lib/call-setup";
import { movedKey, readMoves, writeMove, REMINDER_QUEUE } from "@/lib/call-records";
import { UnknownReplyError } from "@/lib/redis-reply";
import { MOVES_PER_MGET, moveReads } from "@/lib/call-moves-read";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

let http = 0;
globalThis.fetch = (async () => {
  http += 1;
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;
const real = redis.pipeline.bind(redis);
let shape: ((reply: unknown[]) => unknown) | null = null;
const sent: (string | number)[][] = [];
redis.pipeline = (async (commands: (string | number)[][]) => {
  sent.push(...commands);
  const reply = await real(commands);
  return shape && commands.every(c => c[0] === "MGET" && String(c[1]).startsWith("nl:call:moved:")) ? shape(reply) : reply;
}) as typeof redis.pipeline;
async function verdict(run: () => Promise<unknown>): Promise<string> {
  try { await run(); return "returned"; } catch (e) { return e instanceof UnknownReplyError ? "unknown" : String(e); }
}
const NY = "America/New_York", HOUR = 3_600_000;
const weekly: CallSetup = { kind: "weekly", minutes: 60, tz: NY, weekly: [[], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], []], noticeHours: 1, horizonDays: 30, bufferMinutes: 0, room: "https://example.com/room", video: false, meet: null, seats: 1, sessions: [] };
function weekdayAt(): number {
  for (let d = 9; d < 17; d += 1) {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: NY, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(new Date(Date.now() + d * 86_400_000));
    const get = (t: string) => parts.find(x => x.type === t)?.value ?? "";
    if (["Sat", "Sun"].includes(get("weekday"))) continue;
    return zonedToUtc(Number(get("year")), Number(get("month")), Number(get("day")), 600, NY) as number;
  }
  throw Error("no weekday");
}
async function main(): Promise<void> {
  redis.clear();
  part("Executable envelope refusals, no getters or traps executed");
  const keys = Array.from({ length: 101 }, (_, i) => `cs_test_zmoves${String(i).padStart(16, "0")}`);
  await writeMove(keys[100], { s: 1000, e: 2000, n: 0 });
  let traps = 0;
  const bad: [string, (reply: unknown[]) => unknown][] = [
    ["outer extra", r => [...r, []]],
    ["outer sparse", r => { const a = [...r]; delete a[1]; return a; }],
    ["outer inherited", r => { const a = [...r]; delete a[1]; Object.setPrototypeOf(a, { 1: r[1] }); return a; }],
    ["outer getter", r => { const a = [...r]; Object.defineProperty(a, 1, { get() { traps++; return r[1]; } }); return a; }],
    // Async return assimilation necessarily checks then before the reader runs.
    // Count reader traps only; keep this adapter lookup visible in this source.
    ["outer proxy", r => new Proxy(r, { get(t, p, receiver) { if (p !== "then") traps++; return Reflect.get(t, p, receiver); } })],
    ["inner sparse", r => { const a = [...r[1] as unknown[]]; delete a[0]; return [r[0], a]; }],
    ["inner inherited", r => { const a: unknown[] = new Array(1); Object.setPrototypeOf(a, { 0: (r[1] as unknown[])[0] }); return [r[0], a]; }],
    ["inner getter", r => { const a: unknown[] = new Array(1); Object.defineProperty(a, 0, { get() { traps++; return (r[1] as unknown[])[0]; } }); return [r[0], a]; }],
    ["inner proxy", r => [r[0], new Proxy(r[1] as unknown[], { get(t, p, receiver) { traps++; return Reflect.get(t, p, receiver); } })]],
  ];
  for (const [name, inject] of bad) {
    shape = inject; const before = traps;
    is(`${name} refuses`, await verdict(() => readMoves(keys)), "unknown");
    is(`${name} executes no reply code`, traps - before, 0);
  }
  shape = null; sent.length = 0;
  is("101 keys preserve the healthy last slot", [...(await readMoves(keys)).entries()], [[keys[100], { s: 1000, e: 2000, n: 0 }]]);
  is("the same registry batch ceiling is used before reading", [sent.length, sent.map(c => c.length - 1), moveReads(keys.length), MOVES_PER_MGET], [2, [100, 1], 2, 100]);
  part("Actual moveBooking refuses before business writes or HTTP");
  process.env.STRIPE_SECRET_KEY = "sk_test_z_moves_only";
  const owner = "zmoves@example.com";
  await claimHandle(owner, "zmoves", "Z Moves", ""); await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_1ZMovesReview", true);
  await setSubscription(owner, { customerId: "cus_zmoves", subscriptionId: "sub_zmoves", active: true, tier: "creator", period: paidPeriod() });
  const made = await addProduct(owner, "Session", "", "120", null);
  if (!made.ok) throw Error("no product");
  await setProductCall(owner, made.product.id, weekly);
  const store = await storeForEmail(owner) as Store, product = await readListing(store, made.product.id) as CallListing;
  const at = weekdayAt(), session = "cs_test_zmovesbooking000001", busy = `nl:call:busy:${store.callsId}`;
  const move = () => moveBooking({ store, product, session, booked: { start: at, end: at + HOUR, email: null, buyerTz: NY }, start: at + 2 * HOUR, origin: "https://marktmorgen.com" });
  const cases: [string, string | null, ((r: unknown[]) => unknown) | null][] = [
    ["broken JSON", "{bad", null],
    ["negative move count", JSON.stringify({ s: at, e: at + HOUR, n: -1 }), null],
    ["unsafe move count", JSON.stringify({ s: at, e: at + HOUR, n: Number.MAX_SAFE_INTEGER + 1 }), null],
    ["missing outer acknowledgement", null, () => []],
    ["extra MGET value", null, r => [[...(r[0] as unknown[]), null]]],
  ];
  for (const [name, value, inject] of cases) {
    shape = null;
    await real([["DEL", movedKey(session), busy, REMINDER_QUEUE]]);
    if (value !== null) await real([["SET", movedKey(session), value]]);
    else await writeMove(session, { s: at, e: at + HOUR, n: MAX_MOVES });
    const state = () => real([["GET", movedKey(session)], ["HGETALL", busy], ["ZRANGEBYSCORE", REMINDER_QUEUE, "-inf", "+inf", "LIMIT", 0, 10], ["GET", `nl:call:confirmed:${session}`]]);
    const beforeState = await state();
    shape = inject; sent.length = 0; const beforeHttp = http;
    is(`${name}: real move returns error`, await move(), { ok: false, reason: "error" });
    is(`${name}: no move, diary, reminder or confirmation write`, sent.filter(c => {
      const k = String(c[1]); return ["SET", "HSET", "HDEL", "ZADD", "ZREM", "INCRBY"].includes(String(c[0])) && (k === movedKey(session) || k === busy || k === REMINDER_QUEUE || k.startsWith("nl:call:confirmed:"));
    }), []);
    is(`${name}: no downstream HTTP and lock released`, [http - beforeHttp, (await real([["GET", `nl:call:lock:${store.callsId}`]]))[0]], [0, null]);
    shape = null;
    is(`${name}: actual move, diary, reminder and confirmation state unchanged`, await state(), beforeState);
  }
  await real([["DEL", busy, movedKey(session), REMINDER_QUEUE]]);
  await writeMove(session, { s: at, e: at + HOUR, n: MAX_MOVES });
  is("healthy maximum stays refused as limit", await move(), { ok: false, reason: "limit" });
  await writeMove(session, { s: at, e: at + HOUR, n: 0 });
  const healthy = await move();
  is("healthy move still succeeds", healthy, { ok: true, start: at + 2 * HOUR, end: at + 3 * HOUR, moves: 1 });
  is("healthy write remains readable with the actual new count", (await readMoves([session])).get(session), { s: at + 2 * HOUR, e: at + 3 * HOUR, n: 1 });
  done();
}
void main();
