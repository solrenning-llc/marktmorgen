/**
 * The lock around a call's check and hold, and the readings behind it, read
 * in their exact shape (CX-123 rules 24 and 30; Claude 6, audit round 5, and
 * the three LOW notes of the first money review of #3233).
 *
 * A one-to-one call is sold once because reading the taken times, checking
 * the time and opening the checkout happen under one lock (lib/calls.ts,
 * takeLock). Before:
 *
 *   - a SET NX of the lock answering anything but "OK" or nil counted as the
 *     lock taken, so two buyers could pass the check together, both open a
 *     checkout and both pay for the same time;
 *   - a GET of a held lock in another shape took the other buyer's lock over;
 *   - a Stripe reading cut short after its last page (`partial`) was read as
 *     every paid booking;
 *   - a diary entry that did not parse was read as free, and deleted;
 *   - a move read the diary loosely after writing the move, and deleted on a
 *     reply in another shape.
 *
 * Now only an exact "OK" takes the lock, nil is somebody else's, and anything
 * else refuses (no checkout is opened, no move is written); the lock is taken
 * over only from an exact time that ran out; a reading cut short, or an entry
 * that cannot be read, refuses to offer or sell any time and deletes nothing;
 * after a move is written, a diary in another shape leaves the old entries in
 * place and the move is still reported as done. The healthy readings are
 * unchanged.
 *
 * Against the real code with an in-memory Redis and a stand-in for Stripe;
 * synthetic data only.
 */
import { addProduct, claimHandle, ensureStatsId, setProductCall, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import type { Product, Store } from "@/lib/store";
import { readListing, readProduct } from "@/lib/catalog";
import { type CallListing, holdAndCheckout, moveBooking, slotsForProduct } from "@/lib/calls";
import type { CallSetup } from "@/lib/call-setup";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { weekdayAt } from "./weekday";
import { paidPeriod } from "./billing-period-fixture";

const HOUR = 3_600_000;
const NY = "America/New_York";

/** What Stripe lists as the account's completed checkouts, per account, by the page asked for (its starting_after). */
const listed = new Map<string, (after: string) => unknown>();
let opened = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") return answer({ id: "e" });
  const path = url.pathname.replace(/^\/v1/, "");
  if (method === "POST" && path === "/checkout/sessions") {
    opened += 1;
    const id = `cs_test_lockshape${String(opened).padStart(10, "0")}`;
    return answer({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
  }
  if (method === "GET" && path === "/checkout/sessions") {
    const account = new Headers(init?.headers).get("Stripe-Account") ?? "";
    const page = listed.get(account);
    if (page) return answer(page(url.searchParams.get("starting_after") ?? ""));
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

/**
 * Replies put in place of the real ones, while set: the SET NX of a call's
 * lock, its GET, its take-over (a plain SET before, the swap script now), and the HGETALL of a diary after
 * `skipDiary` readings of it. Every command still runs on the in-memory Redis.
 */
const swap: { nx?: { value: unknown }; get?: { value: unknown }; set?: { value: unknown }; diary?: { value: unknown }; skipDiary?: number } = {};
const deletes: string[][] = [];
const run = redis.pipeline;
redis.pipeline = async (commands) => {
  for (const c of commands) if (c[0] === "HDEL" && String(c[1]).startsWith("nl:call:busy:")) deletes.push(c.map(String));
  const replies = await run(commands);
  return commands.map((c, i) => {
    const key = String(c[1] ?? "");
    if (key.startsWith("nl:call:lock:")) {
      if (c[0] === "SET" && c.includes("NX") && swap.nx) return swap.nx.value;
      if (c[0] === "SET" && !c.includes("NX") && swap.set) return swap.set.value;
      if (c[0] === "GET" && swap.get) return swap.get.value;
    }
    // The take-over is a swap of the old value in one script since the lock has an owner (tests/calls-lock-owner.test.ts).
    if (c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:call-lock-swap:v1\n") && swap.set) return swap.set.value;
    if (c[0] === "HGETALL" && key.startsWith("nl:call:busy:") && swap.diary) {
      if ((swap.skipDiary ?? 0) > 0) {
        swap.skipDiary = (swap.skipDiary ?? 0) - 1;
        return replies[i];
      }
      return swap.diary.value;
    }
    return replies[i];
  });
};
function unswap(): void {
  delete swap.nx;
  delete swap.get;
  delete swap.set;
  delete swap.diary;
  delete swap.skipDiary;
}

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

type World = { store: Store; call: CallListing; full: Product & { call: CallSetup } };

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
  return { store, call, full };
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

async function sellSession(w: World, start: number): Promise<string> {
  const held = await holdAndCheckout({ store: w.store, product: w.full, start, buyerTz: NY, origin: "https://marktmorgen.com" });
  if (!held.ok) throw new Error(`no checkout: ${held.reason}`);
  return held.session;
}

const lockOf = (w: World) => `nl:call:lock:${w.store.callsId}`;
const diaryOf = (w: World) => `nl:call:busy:${w.store.callsId}`;
async function clear(w: World): Promise<void> {
  await run([["DEL", lockOf(w)], ["DEL", diaryOf(w)]]);
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_lock_shape_only";
  process.env.RESEND_API_KEY = "re_test_lock_shape_only";

  part("The lock's SET NX in another shape: no checkout, and never two for one time");
  const a = await callStore("lockshape@example.com", "lockshape", "acct_1LockShape");
  const T = weekdayAt(9, 600);
  is("control: a first buyer opens a checkout for the time", await sell(a, T), "opened");
  let before = opened;
  is("control: a second buyer for the same time is told it is taken, with no checkout", [await sell(a, T), opened - before], ["taken", 0]);
  await clear(a);

  const nxShapes: [string, unknown][] = [
    ["nothing (undefined)", undefined],
    ["an object", {}],
    ["a number", 1],
    ["other text", "QUEUED"],
    ["a list holding OK", ["OK"]],
  ];
  for (const [what, value] of nxShapes) {
    swap.nx = { value };
    before = opened;
    is(`SET NX as ${what}: refused, no checkout is opened`, [await sell(a, T), opened - before], ["error", 0]);
    unswap();
    await clear(a);
  }

  swap.nx = { value: undefined };
  before = opened;
  const both = await Promise.all([sell(a, T), sell(a, T)]);
  is("two buyers of one time while SET NX answers in another shape: neither opens a checkout", [both, opened - before], [["error", "error"], 0]);
  unswap();
  await clear(a);

  part("A held lock read in another shape is never taken over");
  await run([["SET", lockOf(a), String(Date.now()), "EX", 15]]);
  before = opened;
  is("control: a lock held right now turns the buyer away, with no checkout", [await sell(a, T), opened - before], ["taken", 0]);
  await clear(a);
  await run([["SET", lockOf(a), String(Date.now() - 20_000), "EX", 15]]);
  is("control: a lock left 20 seconds ago by a request that died is taken over", await sell(a, T), "opened");
  await clear(a);

  const getShapes: [string, unknown][] = [
    ["a list", [1]],
    ["an object", { t: 1 }],
    ["a number", 7],
    ["text that is not a time", "garbled"],
    ["nothing (undefined)", undefined],
  ];
  for (const [what, value] of getShapes) {
    await run([["SET", lockOf(a), String(Date.now()), "EX", 15]]);
    swap.get = { value };
    before = opened;
    is(`GET of a held lock as ${what}: not taken over, no checkout is opened`, [(await sell(a, T)) === "opened", opened - before], [false, 0]);
    unswap();
    await clear(a);
  }

  await run([["SET", lockOf(a), String(Date.now()), "EX", 15]]);
  swap.get = { value: null };
  before = opened;
  is("a held lock whose GET says it is gone, while SET NX still says held: not taken over", [(await sell(a, T)) === "opened", opened - before], [false, 0]);
  unswap();
  await clear(a);

  for (const [what, value] of [["nothing (undefined)", undefined], ["other text", "QUEUED"]] as [string, unknown][]) {
    await run([["SET", lockOf(a), String(Date.now() - 20_000), "EX", 15]]);
    swap.set = { value };
    before = opened;
    is(`taking over a lock that ran out, its SET answering ${what}: refused, no checkout`, [await sell(a, T), opened - before], ["error", 0]);
    unswap();
    await clear(a);
  }

  part("A move under a lock in another shape is not written");
  const m = await callStore("moveshape@example.com", "moveshape", "acct_1MoveShape");
  const M = weekdayAt(10, 600);
  const later = M + 3 * HOUR;
  const session = await sellSession(m, M);
  const diaryBefore = await run([["HGETALL", diaryOf(m)]]);
  await run([["DEL", lockOf(m)]]);
  swap.nx = { value: undefined };
  const refused = await moveBooking({ store: m.store, product: m.call, session, booked: { start: M, end: M + HOUR, email: "buyer@example.com", buyerTz: NY }, start: later, origin: "https://marktmorgen.com" });
  unswap();
  is("SET NX in another shape: the move is refused", refused, { ok: false, reason: "error" });
  is("…and the diary is as it was", await run([["HGETALL", diaryOf(m)]]), diaryBefore);
  await run([["DEL", lockOf(m)]]);

  part("After a move is written, a diary in another shape deletes nothing and the move is done");
  // A booking of its own, so the case does not hang on the one above.
  const N = weekdayAt(11, 600);
  const second = await sellSession(m, N);
  const farther = N + 4 * HOUR;
  const legacy = JSON.stringify({ e: N + HOUR, until: 0, session: second });
  await run([["HSET", diaryOf(m), String(N), legacy]]);
  // The first reading (the taken times) is the real one; the one after the move is written answers in another shape.
  swap.diary = { value: [String(N), legacy, second, 7] };
  swap.skipDiary = 1;
  const deleted = deletes.length;
  const moved = await moveBooking({ store: m.store, product: m.call, session: second, booked: { start: N, end: N + HOUR, email: "buyer@example.com", buyerTz: NY }, start: farther, origin: "https://marktmorgen.com" });
  unswap();
  is("the move is reported as done", moved.ok ? [moved.start, moved.end] : moved, [farther, farther + HOUR]);
  const [legacyAfter] = await run([["HGET", diaryOf(m), String(N)]]);
  is("the old entry is not deleted on a reply it could not read", [legacyAfter, deletes.slice(deleted).some((d) => d.includes(String(N)))], [legacy, false]);
  const [moveEntry] = await run([["HGET", diaryOf(m), second]]);
  is("the booking's own entry is at the new time", (JSON.parse(String(moveEntry)) as { s: number }).s, farther);

  part("A Stripe reading cut short after its last page refuses to offer or sell");
  const P = "acct_1PartialRd";
  const p = await callStore("partialread@example.com", "partialread", P);
  const B = weekdayAt(11, 660);
  const booking = {
    id: "cs_test_partialbooking00001",
    object: "checkout.session",
    status: "complete",
    payment_status: "paid",
    metadata: { kind: "call", store: "partialread", start: String(B), end: String(B + HOUR), product: p.call.id, tz: NY },
    customer_details: { email: "old@example.com", name: "Old Buyer" },
    amount_total: 12000,
    currency: "usd",
    payment_intent: { id: "pi_test_partial00001", object: "payment_intent", latest_charge: { id: "ch_test_partial00001", object: "charge", disputed: false, refunded: false, amount: 12000, amount_refunded: 0 } },
  };
  const other = (page: number, i: number) => ({ id: `cs_test_other${String(page)}${String(i).padStart(10, "0")}`, object: "checkout.session", status: "complete", payment_status: "paid", metadata: { kind: "product" } });
  /** `pages` full pages of other checkouts, then the booking on the page after them. */
  const pagesThenBooking = (pages: number) => (after: string) => {
    const at = after ? Number(after.slice("cs_test_other".length, "cs_test_other".length + 1)) + 1 : 0;
    if (at < pages) return { object: "list", data: Array.from({ length: 100 }, (_, i) => other(at, i)), has_more: true };
    return { object: "list", data: [booking], has_more: false };
  };

  listed.set(P, pagesThenBooking(4));
  const read = await offered(p);
  is("control: the booking on the fifth page is read, its time not offered, the others are", [read?.includes(B), (read?.length ?? 0) > 0], [false, true]);
  before = opened;
  is("control: …and not sold again", [await sell(p, B), opened - before], ["taken", 0]);

  listed.set(P, pagesThenBooking(5));
  is("five full pages and more said: no time is offered", await offered(p), null);
  before = opened;
  is("five full pages and more said: the time is not sold, no checkout is opened", [await sell(p, B), opened - before], ["error", 0]);
  listed.delete(P);
  await clear(p);

  part("A diary entry that cannot be read is unknown: nothing is offered, sold or deleted");
  const d = await callStore("entryshape@example.com", "entryshape", "acct_1EntryShape");
  const E = weekdayAt(12, 600);
  await run([["HSET", diaryOf(d), String(E), JSON.stringify({ e: E + HOUR, until: 0 })]]);
  const legacyRead = await offered(d);
  is("control: an entry filed by its start before group calls keeps its time, the others are offered", [legacyRead?.includes(E), (legacyRead?.length ?? 0) > 0], [false, true]);
  await clear(d);

  const entries: [string, string, string][] = [
    ["JSON that does not parse", "cs_test_entryshape000000001", "{"],
    ["null", "cs_test_entryshape000000002", "null"],
    ["an end in text", "cs_test_entryshape000000003", JSON.stringify({ s: E, e: "later", until: 0, session: "cs_test_entryshape000000003" })],
    ["a start in text", "cs_test_entryshape000000004", JSON.stringify({ s: "soon", e: E + HOUR, until: 0, session: "cs_test_entryshape000000004" })],
    ["no start, filed under a field that is not one", "cs_test_entryshape000000005", JSON.stringify({ e: E + HOUR, until: 0 })],
    ["until in text", "cs_test_entryshape000000006", JSON.stringify({ s: E, e: E + HOUR, until: "0", session: "cs_test_entryshape000000006" })],
    ["a list", "cs_test_entryshape000000007", JSON.stringify([E, E + HOUR])],
    ["a hold that ran out before 1970 (until -1)", "cs_test_entryshape000000008", JSON.stringify({ s: E, e: E + HOUR, until: -1, session: "cs_test_entryshape000000008" })],
    ["until that is not a whole number", "cs_test_entryshape000000009", JSON.stringify({ s: E, e: E + HOUR, until: Date.now() + 600_000.5, session: "cs_test_entryshape000000009" })],
    ["until past the largest safe whole number", "cs_test_entryshape000000010", JSON.stringify({ s: E, e: E + HOUR, until: 2 ** 60, session: "cs_test_entryshape000000010" })],
    ["no length (its end at its start)", "cs_test_entryshape000000011", JSON.stringify({ s: E, e: E, until: 0, session: "cs_test_entryshape000000011" })],
    ["an end before its start", "cs_test_entryshape000000012", JSON.stringify({ s: E, e: E - HOUR, until: 0, session: "cs_test_entryshape000000012" })],
    ["a start at zero", "cs_test_entryshape000000013", JSON.stringify({ s: 0, e: HOUR, until: 0, session: "cs_test_entryshape000000013" })],
    ["a start that is not a whole number", "cs_test_entryshape000000014", JSON.stringify({ s: E + 0.5, e: E + HOUR, until: 0, session: "cs_test_entryshape000000014" })],
    ["no start, filed under zero", "0", JSON.stringify({ e: HOUR, until: 0 })],
  ];
  for (const [what, field, value] of entries) {
    await run([["HSET", diaryOf(d), field, value]]);
    const count = deletes.length;
    before = opened;
    is(`an entry as ${what}: no time is offered`, await offered(d), null);
    is(`an entry as ${what}: the time is not sold, no checkout is opened`, [await sell(d, E), opened - before], ["error", 0]);
    const [kept] = await run([["HGET", diaryOf(d), field]]);
    is(`an entry as ${what}: it is not deleted`, [kept, deletes.length - count], [value, 0]);
    await clear(d);
  }
  is("once the diary reads again, times are offered", ((await offered(d))?.length ?? 0) > 0, true);

  // Codex Z's first money review of #3240: a real buyer's hold, read back with only its times changed in the reply
  // (the stored entry stays healthy). A negative `until` was read as a hold that ran out: the real hold was deleted,
  // its time offered and a second checkout opened for it. A zero or reversed length was partly trusted.
  part("A real hold read back with times no writer makes is unknown: nothing is offered, sold or deleted");
  const h = await callStore("heldshape@example.com", "heldshape", "acct_1HeldShape");
  const H = weekdayAt(13, 600);
  const readBack: [string, (entry: Record<string, unknown>) => Record<string, unknown>][] = [
    ["no length", (entry) => ({ ...entry, e: entry.s })],
    ["an end before its start", (entry) => ({ ...entry, e: Number(entry.s) - HOUR })],
    ["a negative end of hold", (entry) => ({ ...entry, until: -1 })],
  ];
  for (const [what, change] of readBack) {
    await clear(h);
    const held = await sellSession(h, H);
    const [raw] = await run([["HGET", diaryOf(h), held]]);
    if (typeof raw !== "string") throw new Error("no hold written");
    is(`${what}: control, the real hold keeps its time`, (await offered(h))?.includes(H), false);
    swap.diary = { value: [held, JSON.stringify(change(JSON.parse(raw) as Record<string, unknown>))] };
    const count = deletes.length;
    is(`${what}: no time is offered`, await offered(h), null);
    before = opened;
    is(`${what}: the time is not sold, no second checkout is opened`, [await sell(h, H), opened - before], ["error", 0]);
    unswap();
    is(`${what}: the real hold is not deleted`, [(await run([["HGET", diaryOf(h), held]]))[0], deletes.length - count], [raw, 0]);
  }
  await clear(h);
  const expiring = await sellSession(h, H);
  const [expiringRaw] = await run([["HGET", diaryOf(h), expiring]]);
  if (typeof expiringRaw !== "string") throw new Error("no hold written");
  const until = (JSON.parse(expiringRaw) as { until: number }).until;
  const clock = Date.now;
  try {
    Date.now = () => until + 1;
    is("control: a real hold whose time ran out gives its time back", (await offered(h))?.includes(H), true);
    is("control: …and is tidied away", (await run([["HGET", diaryOf(h), expiring]]))[0], null);
  } finally {
    Date.now = clock;
  }
  await clear(h);

  done();
}

void main();
