/**
 * A busy store still sells calls (audit of Stripe readings, A6).
 *
 * Which times are taken was read from the creator's Stripe account: every
 * completed checkout of the last 120 days, of every product, at most five
 * pages of a hundred. A store with more than five hundred sales in that time
 * (about four a day, of anything) had the reading cut short, and since a paid
 * booking among the unread ones could have been missing from the diary, no
 * time was offered or sold at all.
 *
 * The diary (nl:call:busy:<callsId>) gets every booking's hold before its
 * checkout's address is handed out, and the hold now leaves it only once
 * Stripe shows its checkout can never be paid: it is absent from a reading
 * that covers the time the checkout was opened, or, read on its own, expired.
 * A hold Stripe cannot vouch for keeps its time (CX-123 rule 24). So the diary
 * holds every booking, the reading of Stripe cut short no longer refuses, and
 * no taken time is offered.
 *
 * Against the real code with an in-memory Redis and a stand-in for Stripe;
 * synthetic data only.
 */
import { addProduct, claimHandle, ensureStatsId, setProductCall, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import type { Product, Store } from "@/lib/store";
import { readListing, readProduct } from "@/lib/catalog";
import { type CallListing, holdAndCheckout, slotsForProduct } from "@/lib/calls";
import { type CallSetup, zonedToUtc } from "@/lib/call-setup";
import { HOLD_SECONDS } from "@/lib/stripe-account";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NY = "America/New_York";
const NOW_S = Math.floor(Date.now() / 1000);

/** The account's completed checkouts, newest first, as Stripe lists them. */
const listed = new Map<string, Record<string, unknown>[]>();
/** A checkout read on its own (GET /checkout/sessions/<id>): its body, or a status code to fail with. */
const single = new Map<string, Record<string, unknown> | number>();
let pagesRead = 0;
let singlesRead: string[] = [];
let opened = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") return answer({ id: "e" });
  const path = url.pathname.replace(/^\/v1/, "");
  if (method === "POST" && path === "/checkout/sessions") {
    opened += 1;
    const id = `cs_test_busyread${String(opened).padStart(10, "0")}`;
    return answer({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
  }
  if (method === "GET" && path === "/checkout/sessions") {
    pagesRead += 1;
    const account = new Headers(init?.headers).get("Stripe-Account") ?? "";
    const all = listed.get(account) ?? [];
    const after = url.searchParams.get("starting_after") ?? "";
    const from = after ? all.findIndex((row) => row.id === after) + 1 : 0;
    const limit = Number(url.searchParams.get("limit") ?? "10");
    return answer({ object: "list", data: all.slice(from, from + limit), has_more: from + limit < all.length });
  }
  const one = /^\/checkout\/sessions\/([^/]+)$/.exec(path);
  if (method === "GET" && one) {
    const id = decodeURIComponent(one[1]);
    singlesRead.push(id);
    const body = single.get(id);
    if (typeof body === "number") return answer({ error: { type: "api_error", message: "down" } }, body);
    if (body) return answer(body);
    return answer({ error: { type: "invalid_request_error", code: "resource_missing", message: "No such checkout.session" } }, 404);
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const deletes: string[][] = [];
const run = redis.pipeline;
redis.pipeline = async (commands) => {
  for (const c of commands) if (c[0] === "HDEL" && String(c[1]).startsWith("nl:call:busy:")) deletes.push(c.map(String));
  return run(commands);
};

const WEEKDAYS: [number, number][][] = [[], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], []];
const weekly = {
  kind: "weekly",
  minutes: 60,
  tz: NY,
  weekly: WEEKDAYS,
  noticeHours: 1,
  horizonDays: 30,
  bufferMinutes: 0,
  room: "https://example.com/room",
  video: false,
  meet: null,
  seats: 1,
  sessions: [],
} as unknown as CallSetup;

function weekdayAt(days: number, minute: number): number {
  for (let d = days; d < days + 8; d += 1) {
    const day = new Date(Date.now() + d * DAY);
    const p = new Intl.DateTimeFormat("en-US", { timeZone: NY, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(day);
    const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
    if (get("weekday") === "Sat" || get("weekday") === "Sun") continue;
    return zonedToUtc(Number(get("year")), Number(get("month")), Number(get("day")), minute, NY) as number;
  }
  throw new Error("no weekday");
}

type World = { store: Store; call: CallListing; full: Product & { call: CallSetup }; account: string };

async function callStore(email: string, handle: string, account: string): Promise<World> {
  await claimHandle(email, handle, `${handle} studio`, "");
  await ensureStatsId(email);
  await setStripeAccount(email, account, true);
  await setSubscription(email, { customerId: `cus_${handle}00001`, subscriptionId: `sub_${handle}00001`, active: true, tier: "pro", period: paidPeriod() });
  const made = await addProduct(email, "Strategy call", "", "120", null);
  if (!made.ok) throw new Error("no product");
  await setProductCall(email, made.product.id, weekly);
  const store = (await storeForEmail(email)) as Store;
  const call = (await readListing(store, made.product.id)) as CallListing;
  const full = (await readProduct(store, call.id)) as Product & { call: CallSetup };
  return { store, call, full, account };
}

/** The times on offer, or null when none may be offered. */
async function offered(w: World): Promise<number[] | null> {
  const slots = await slotsForProduct(w.store, w.call);
  return slots ? slots.days.flatMap((d) => d.starts) : null;
}

async function sell(w: World, start: number): Promise<string> {
  const held = await holdAndCheckout({ store: w.store, product: w.full, start, buyerTz: NY, origin: "https://marktmorgen.com" });
  return held.ok ? "opened" : held.reason;
}

const diaryOf = (w: World) => `nl:call:busy:${w.store.callsId}`;

/** `count` completed sales of another product, newest first, one every four hours back from now. */
function otherSales(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `cs_test_othersale${String(i).padStart(10, "0")}`,
    object: "checkout.session",
    status: "complete",
    payment_status: "paid",
    created: NOW_S - 600 - i * 4 * 3600,
    metadata: { kind: "product", store: "elsewhere" },
  }));
}

function bookingRow(w: World, id: string, start: number, created: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    object: "checkout.session",
    status: "complete",
    payment_status: "paid",
    created,
    metadata: { kind: "call", store: w.store.handle, start: String(start), end: String(start + HOUR), product: w.call.id, tz: NY },
    customer_details: { email: "buyer@example.com", name: "A Buyer" },
    amount_total: 12000,
    currency: "usd",
    payment_intent: { id: `pi_${id.slice(3)}`, object: "payment_intent", latest_charge: { id: `ch_${id.slice(3)}`, object: "charge", disputed: false, refunded: false, amount: 12000, amount_refunded: 0 } },
    ...extra,
  };
}

/** A hold in the diary whose time ran out `ago` milliseconds ago, for the hour at `start`. */
async function ranOutHold(w: World, session: string, start: number, ago: number): Promise<void> {
  await run([["HSET", diaryOf(w), session, JSON.stringify({ s: start, e: start + HOUR, until: Date.now() - ago, session, p: w.call.id })]]);
}

async function inDiary(w: World, field: string): Promise<boolean> {
  const [value] = await run([["HGET", diaryOf(w), field]]);
  return typeof value === "string" && value.length > 0;
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_busy_read_only";
  process.env.RESEND_API_KEY = "re_test_busy_read_only";

  part("A store with 600 sales of other products in 120 days still offers and sells its free times");
  const a = await callStore("busyread@example.com", "busyread", "acct_1BusyReadA");
  listed.set(a.account, otherSales(600));
  const B = weekdayAt(9, 600);
  await run([["HSET", diaryOf(a), "cs_test_bookedbusyread0001", JSON.stringify({ s: B, e: B + HOUR, until: 0, session: "cs_test_bookedbusyread0001", p: a.call.id })]]);
  pagesRead = 0;
  const times = await offered(a);
  is("times are offered, not refused", times !== null && times.length > 0, true);
  is("the booked time is not among them", times?.includes(B), false);
  is("the free times around it are", [times?.includes(B - HOUR), times?.includes(B + HOUR)], [true, true]);
  is("Stripe was read for at most five pages", pagesRead <= 5, true);
  let before = opened;
  is("the booked time is not sold again: no checkout", [await sell(a, B), opened - before], ["taken", 0]);
  before = opened;
  is("a free time sells: one checkout", [await sell(a, B + HOUR), opened - before], ["opened", 1]);
  is("…and its hold keeps it from the next buyer", await sell(a, B + HOUR), "taken");

  part("A hold that ran out, whose checkout was paid out of the pages read, keeps its time");
  const b = await callStore("busyreadpaid@example.com", "busyreadpaid", "acct_1BusyReadB");
  const P = weekdayAt(10, 660);
  const paidId = "cs_test_paidunread00000001";
  // Its checkout opened 90 days ago, older than the 500 newest sales read; paid, and its booking never confirmed.
  listed.set(b.account, [...otherSales(600)]);
  single.set(paidId, bookingRow(b, paidId, P, NOW_S - 90 * 86400));
  await ranOutHold(b, paidId, P, 90 * DAY - HOLD_SECONDS * 1000);
  singlesRead = [];
  const paidTimes = await offered(b);
  is("times are offered", paidTimes !== null && (paidTimes?.length ?? 0) > 0, true);
  is("the paid time is not", paidTimes?.includes(P), false);
  is("its checkout was read on its own", singlesRead.includes(paidId), true);
  is("its hold is kept in the diary", await inDiary(b, paidId), true);
  before = opened;
  is("it is not sold again", [await sell(b, P), opened - before], ["taken", 0]);

  part("A hold that ran out, whose checkout cannot be read, keeps its time (unknown is never free)");
  const unknownId = "cs_test_unknownunread0001";
  const U = weekdayAt(10, 780);
  single.set(unknownId, 500);
  await ranOutHold(b, unknownId, U, 90 * DAY - HOLD_SECONDS * 1000);
  const unknownTimes = await offered(b);
  is("times are offered, the unknown one is not", [unknownTimes !== null, unknownTimes?.includes(U)], [true, false]);
  is("its hold is not deleted", await inDiary(b, unknownId), true);
  is("…and it is not sold", await sell(b, U), "taken");

  part("A hold that ran out, whose checkout Stripe says expired unpaid, gives its time back");
  const expiredId = "cs_test_expiredunread0001";
  const X = weekdayAt(10, 900);
  single.set(expiredId, { id: expiredId, object: "checkout.session", status: "expired", payment_status: "unpaid", created: NOW_S - 90 * 86400, metadata: { kind: "call", store: b.store.handle } });
  await ranOutHold(b, expiredId, X, 90 * DAY - HOLD_SECONDS * 1000);
  const expiredTimes = await offered(b);
  is("its time is offered again", expiredTimes?.includes(X), true);
  is("its hold is tidied away", await inDiary(b, expiredId), false);

  part("A hold that ran out minutes ago, covered by the pages read and absent from them, gives its time back without a lookup");
  const recentId = "cs_test_recentabandoned01";
  const R = weekdayAt(11, 600);
  await ranOutHold(b, recentId, R, 10 * 60_000);
  singlesRead = [];
  const recentTimes = await offered(b);
  is("its time is offered again", recentTimes?.includes(R), true);
  is("no checkout was read on its own for it", singlesRead.includes(recentId), false);
  is("its hold is tidied away", await inDiary(b, recentId), false);

  part("A hold that ran out minutes ago whose checkout completed unsettled keeps its time");
  const c = await callStore("busyreadunsettled@example.com", "busyreadunsettled", "acct_1BusyReadC");
  const S = weekdayAt(12, 600);
  const unsettledId = "cs_test_unsettledrecent01";
  listed.set(c.account, [bookingRow(c, unsettledId, S, NOW_S - 40 * 60, { payment_status: "unpaid" })]);
  await ranOutHold(c, unsettledId, S, 5 * 60_000);
  const unsettledTimes = await offered(c);
  is("times are offered, the unsettled one is not", [unsettledTimes !== null, unsettledTimes?.includes(S)], [true, false]);
  is("its hold is kept", await inDiary(c, unsettledId), true);

  part("Holds out of the pages read are looked up a few at a reading, never all at once");
  const d = await callStore("busyreadmany@example.com", "busyreadmany", "acct_1BusyReadD");
  listed.set(d.account, otherSales(600));
  const many: string[] = [];
  for (let i = 0; i < 12; i += 1) {
    const id = `cs_test_manyunread${String(i).padStart(8, "0")}`;
    many.push(id);
    single.set(id, 500);
    await ranOutHold(d, id, weekdayAt(13, 600) + (i % 8) * HOUR, 90 * DAY);
  }
  singlesRead = [];
  const manyTimes = await offered(d);
  is("times are still offered", manyTimes !== null, true);
  is("at most three checkouts read on their own", singlesRead.filter((id) => many.includes(id)).length <= 3, true);
  is("none of the twelve holds is deleted", (await Promise.all(many.map((id) => inDiary(d, id)))).every(Boolean), true);

  part("Control: a booking Stripe lists among the pages read keeps its time, a full refund gives it back");
  const e = await callStore("busyreadctl@example.com", "busyreadctl", "acct_1BusyReadE");
  const K = weekdayAt(9, 720);
  const F = weekdayAt(9, 840);
  const refundedRow = bookingRow(e, "cs_test_refundedlisted001", F, NOW_S - 3600);
  (refundedRow.payment_intent as { latest_charge: Record<string, unknown> }).latest_charge = { id: "ch_refundedlisted001", object: "charge", disputed: false, refunded: true, amount: 12000, amount_refunded: 12000 };
  listed.set(e.account, [bookingRow(e, "cs_test_keptlisted0000001", K, NOW_S - 3600), refundedRow]);
  await run([["HSET", diaryOf(e), "cs_test_refundedlisted001", JSON.stringify({ s: F, e: F + HOUR, until: 0, session: "cs_test_refundedlisted001", p: e.call.id })]]);
  const ctlTimes = await offered(e);
  is("the listed booking's time is taken", ctlTimes?.includes(K), false);
  is("the refunded booking's time is free again", ctlTimes?.includes(F), true);
  is("…and its diary entry is let go", await inDiary(e, "cs_test_refundedlisted001"), false);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
