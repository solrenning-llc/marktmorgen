/**
 * A booking's move record read in its exact shape (CX-123 rule 24; hunt 5,
 * fail-open gates). lib/call-records.ts readMoves answered "never moved" both
 * for a booking that was never moved and for a move record it could not read,
 * so lib/calls.ts moveBooking started again from the time Stripe has with
 * moves = 0 (MAX_MOVES no longer refused), and the busy times showed the call
 * at its old time, leaving the time it moved to free for another buyer.
 *
 * Only a key that is gone (MGET's null) is never moved. A value there that is
 * not a move, an MGET reply that is not a list of one slot a key, or a
 * pipeline reply of another length is unknown: readMoves throws
 * UnknownReplyError, and moveBooking, the busy times and paidCall refuse
 * instead of reading the booking at its old time. Every move written since
 * the record began (26 September 2026, "Stores: more than Stan") has had
 * { s, e, n }, so no older shape is left to accept.
 *
 * Synthetic records only; Stripe and the email service are mocked.
 */
import { before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { store as redis } from "./redis-stub";
import { movedKey, readMoves, writeMove } from "@/lib/call-records";
import { MAX_MOVES, readSetup, zonedToUtc, type CallSetup } from "@/lib/call-setup";
import { busyTimes, moveBooking, paidCall, type CallListing } from "@/lib/calls";
import { readListing } from "@/lib/catalog";
import { UnknownReplyError } from "@/lib/redis-reply";
import { addProduct, claimHandle, ensureStatsId, setProductCall, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";

const NY = "America/New_York";
const WEEKDAYS: [number, number][][] = [[], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], []];
const weekly = { kind: "weekly", minutes: 60, tz: NY, weekly: WEEKDAYS, noticeHours: 1, horizonDays: 30, bufferMinutes: 0, room: "https://example.com/room", video: false, meet: null, seats: 1, sessions: [] };
const OWNER = "moves-owner@example.com";
const HANDLE = "movesunknown";

function weekdayAt(days: number, minute: number): number {
  for (let d = days; d < days + 8; d += 1) {
    const day = new Date(Date.now() + d * 86_400_000);
    const p = new Intl.DateTimeFormat("en-US", { timeZone: NY, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(day);
    const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
    if (get("weekday") === "Sat" || get("weekday") === "Sun") continue;
    return zonedToUtc(Number(get("year")), Number(get("month")), Number(get("day")), minute, NY) as number;
  }
  throw new Error("no weekday");
}

const at = weekdayAt(3, 600);
const HOUR = 3_600_000;
/** The paid checkout sessions Stripe lists for the store, as its rows. */
const paidRows: Record<string, unknown>[] = [];
const emails: string[] = [];
const rowFor = (session: string, start: number, product: string) => ({
  id: session,
  object: "checkout.session",
  status: "complete",
  payment_status: "paid",
  payment_intent: `pi_${session.slice(-12)}`,
  amount_total: 4500,
  currency: "usd",
  customer_details: { email: "buyer@example.com", name: "Ana" },
  metadata: { kind: "call", store: HANDLE, product, start: String(start), end: String(start + HOUR), tz: NY },
});

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    emails.push(String(init?.body ?? ""));
    return answer({ id: "e" });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  const one = /^\/checkout\/sessions\/([^/]+)$/.exec(path);
  if (method === "GET" && one) return answer(paidRows.find((r) => r.id === decodeURIComponent(one[1])) ?? { error: { message: "No such session" } }, paidRows.some((r) => r.id === decodeURIComponent(one[1])) ? 200 : 404);
  if (method === "GET" && path === "/checkout/sessions") return answer({ object: "list", data: paidRows, has_more: false });
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

let store: Store;
let listing: CallListing;

before(async () => {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_call_moves_unknown_only";
  process.env.RESEND_API_KEY = "re_test_call_moves_unknown_only";
  await claimHandle(OWNER, HANDLE, "Moves Studio", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestMoves00001", true);
  await setSubscription(OWNER, { customerId: "cus_moves00001", subscriptionId: "sub_moves00001", active: true, tier: "creator", period: paidPeriod() });
  const made = await addProduct(OWNER, "Coaching", "", "45", null);
  if (!made.ok) throw new Error("no product");
  await setProductCall(OWNER, made.product.id, readSetup(weekly) as CallSetup);
  store = (await storeForEmail(OWNER)) as Store;
  listing = (await readListing(store, made.product.id)) as CallListing;
});

beforeEach(() => {
  paidRows.length = 0;
  emails.length = 0;
});

const rawOf = async (session: string) => (await redis.pipeline([["GET", movedKey(session)]]))[0];
const isUnknown = (error: unknown) => error instanceof UnknownReplyError;
const healthy = { s: at + 26 * HOUR, e: at + 27 * HOUR, n: 1 };

/** A value at a move's key that is not a move written by writeMove. */
const garbage = [
  ["n written as text", JSON.stringify({ ...healthy, n: String(MAX_MOVES) })],
  ["n missing", JSON.stringify({ s: healthy.s, e: healthy.e })],
  ["n not a whole number", JSON.stringify({ ...healthy, n: 1.5 })],
  ["n below zero", JSON.stringify({ ...healthy, n: -1 })],
  ["JSON cut short", JSON.stringify(healthy).slice(0, 20)],
  ["end not after start", JSON.stringify({ ...healthy, e: healthy.s })],
  ["start as text", JSON.stringify({ ...healthy, s: String(healthy.s) })],
  ["JSON null", "null"],
  ["a list", JSON.stringify([healthy.s, healthy.e, 1])],
] as const;

test("controls: a readable move is read as written; a key that is gone is never moved", async () => {
  await writeMove("cs_test_movesctrl00001", healthy);
  const moves = await readMoves(["cs_test_movesctrl00001", "cs_test_movesgone00001"]);
  assert.deepEqual(moves.get("cs_test_movesctrl00001"), healthy);
  assert.equal(moves.has("cs_test_movesgone00001"), false);
  assert.equal(moves.size, 1);
});

for (const [name, raw] of garbage) {
  test(`a move record that is not a move (${name}) is unknown, never "never moved"`, async () => {
    const session = `cs_test_moves${name.replace(/\W+/g, "")}`.slice(0, 40);
    await redis.pipeline([["SET", movedKey(session), raw]]);
    await assert.rejects(readMoves([session]), isUnknown);
    // One unknown record among readable ones still refuses the whole read: nothing is half-known.
    await writeMove("cs_test_movesctrl00002", healthy);
    await assert.rejects(readMoves(["cs_test_movesctrl00002", session]), isUnknown);
  });
}

test("an MGET slot that is not a string or null, an MGET reply that is not a list of one slot a key, or a pipeline of another length is unknown", async () => {
  await writeMove("cs_test_movesshape0001", healthy);
  const real = redis.pipeline.bind(redis);
  const shapes: unknown[] = [
    [[5]],
    [[{ s: 1 }]],
    [{ unexpected: true }],
    ["not a list"],
    [null],
    [[]],
    [[JSON.stringify(healthy), null]],
    [],
    [[JSON.stringify(healthy)], [null]],
    { 0: [JSON.stringify(healthy)], length: 1 },
  ];
  try {
    for (const shape of shapes) {
      redis.pipeline = (async () => shape) as unknown as typeof redis.pipeline;
      await assert.rejects(readMoves(["cs_test_movesshape0001"]), isUnknown, JSON.stringify(shape));
    }
  } finally {
    redis.pipeline = real;
  }
  assert.deepEqual((await readMoves(["cs_test_movesshape0001"])).get("cs_test_movesshape0001"), healthy, "the healthy reply still reads");
});

test("moveBooking: a booking at MAX_MOVES is refused; an unknown move record is an error, never a first move", async () => {
  const limit = "cs_test_moveslimit0001";
  await writeMove(limit, { ...healthy, n: MAX_MOVES });
  const refused = await moveBooking({ store, product: listing, session: limit, booked: { start: at, end: at + HOUR, email: "buyer@example.com", buyerTz: NY }, start: at + 4 * HOUR, origin: "https://marktmorgen.com" });
  assert.deepEqual(refused, { ok: false, reason: "limit" }, "control: the limit refuses");

  for (const [name, raw] of garbage) {
    const session = "cs_test_movesbroken001";
    await redis.pipeline([["SET", movedKey(session), raw]]);
    emails.length = 0;
    const result = await moveBooking({ store, product: listing, session, booked: { start: at, end: at + HOUR, email: "buyer@example.com", buyerTz: NY }, start: at + 4 * HOUR, origin: "https://marktmorgen.com" });
    assert.deepEqual(result, { ok: false, reason: "error" }, `${name}: refused as an error`);
    assert.equal(await rawOf(session), raw, `${name}: the record is not written over with a first move`);
    assert.equal(emails.length, 0, `${name}: nobody is told of a move`);
  }
});

test("moveBooking: a booking never moved still moves (healthy control)", async () => {
  const session = "cs_test_movesfresh0001";
  paidRows.push(rowFor(session, at + 2 * HOUR, listing.id));
  const moved = await moveBooking({ store, product: listing, session, booked: { start: at + 2 * HOUR, end: at + 3 * HOUR, email: "buyer@example.com", buyerTz: NY }, start: at + 6 * HOUR, origin: "https://marktmorgen.com" });
  assert.deepEqual(moved, { ok: true, start: at + 6 * HOUR, end: at + 7 * HOUR, moves: 1 });
  assert.equal(await rawOf(session), JSON.stringify({ s: at + 6 * HOUR, e: at + 7 * HOUR, n: 1 }));
});

test("busy times and paidCall: a moved booking is at its new time; with an unknown move record they refuse, never the old time", async () => {
  const session = "cs_test_movesbusy00001";
  paidRows.push(rowFor(session, at + 8 * HOUR, listing.id));
  await writeMove(session, { s: at + 30 * HOUR, e: at + 31 * HOUR, n: 1 });
  const busy = await busyTimes(store);
  assert.deepEqual(busy.filter((b) => b.session === session).map((b) => [b.start, b.end]), [[at + 30 * HOUR, at + 31 * HOUR]], "control: the new time is taken");
  assert.deepEqual([(await paidCall(store, session))?.start, (await paidCall(store, session))?.moves], [at + 30 * HOUR, 1]);

  for (const [name, raw] of garbage) {
    await redis.pipeline([["SET", movedKey(session), raw]]);
    await assert.rejects(busyTimes(store), isUnknown, `${name}: the busy times refuse`);
    await assert.rejects(paidCall(store, session), isUnknown, `${name}: the booking is not read at its old time`);
  }
});
