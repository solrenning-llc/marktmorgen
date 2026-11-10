/**
 * The lock around a call's check and hold belongs to the request that took it
 * (lib/calls.ts, takeLock; the two open notes of #3240's PR, Claude 6).
 *
 * A one-to-one call is sold once because reading the taken times, checking
 * the time and writing the hold happen under one lock per store. Before:
 *
 *   - two requests that both found the same lock left behind could both take
 *     it over: each read the old time (GET) and wrote its own (plain SET), so
 *     both passed the check, both opened a checkout and both could be paid
 *     for the same time;
 *   - the lock was let go with a plain DEL, so a request that outlasted its
 *     15 seconds (a slow Stripe reading, a slow checkout) deleted the next
 *     holder's lock, and still wrote its hold and handed out its checkout
 *     although the next holder had checked the time without it.
 *
 * Now the lock holds a value only its holder writes (the time it was taken,
 * then a random part); a take-over replaces the old value only if it is still
 * the one read, in one script; it is let go only while it still holds the
 * holder's own value; it is made to last again, only while still ours, before
 * a checkout is opened and before a move is written; and a hold is written
 * only while the lock is still ours, in one script, or the checkout just
 * opened is closed at Stripe and never handed out. Each script's reply is read
 * exactly (CX-123 rule 24): only 1 or 0, anything else refuses.
 *
 * Against the real code with an in-memory Redis and a stand-in for Stripe;
 * synthetic data only.
 */
import { addProduct, claimHandle, ensureStatsId, setProductCall, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import type { Product, Store } from "@/lib/store";
import { readListing, readProduct } from "@/lib/catalog";
import { type CallListing, holdAndCheckout, moveBooking } from "@/lib/calls";
import { type CallSetup, zonedToUtc } from "@/lib/call-setup";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NY = "America/New_York";
const SWAP_SCRIPT = "-- marktmorgen:call-lock-swap:v1\n";
const HOLD_SCRIPT = "-- marktmorgen:call-hold-if-locked:v1\n";

/** Run once while Stripe is being asked, then forgotten: a listing of completed checkouts, or a checkout being opened. */
const during: { list?: () => Promise<void>; open?: () => Promise<void> } = {};
let opened = 0;
const expired: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") return answer({ id: "e" });
  const path = url.pathname.replace(/^\/v1/, "");
  if (method === "POST" && path === "/checkout/sessions") {
    const hook = during.open;
    delete during.open;
    if (hook) await hook();
    opened += 1;
    const id = `cs_test_lockowner${String(opened).padStart(10, "0")}`;
    return answer({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
  }
  const closing = /^\/checkout\/sessions\/([^/]+)\/expire$/.exec(path);
  if (method === "POST" && closing) {
    expired.push(decodeURIComponent(closing[1]));
    return answer({ id: closing[1], object: "checkout.session", status: "expired" });
  }
  if (method === "GET" && path === "/checkout/sessions") {
    const hook = during.list;
    delete during.list;
    if (hook) await hook();
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

/**
 * Hooks on the commands the code sends: `afterGet` runs once right after a GET
 * of a call's lock has been answered (before the code sees the answer), and
 * `script` replaces the reply of one of the two scripts, by its name.
 */
const hooks: { afterGet?: () => Promise<void>; script?: { name: string; value: unknown } } = {};
const run = redis.pipeline;
redis.pipeline = async (commands) => {
  const replies = await run(commands);
  const out = commands.map((c, i) => {
    if (c[0] === "EVAL" && hooks.script && String(c[1]).startsWith(hooks.script.name)) return hooks.script.value;
    return replies[i];
  });
  if (hooks.afterGet && commands.some((c) => c[0] === "GET" && String(c[1]).startsWith("nl:call:lock:"))) {
    const hook = hooks.afterGet;
    delete hooks.afterGet;
    await hook();
  }
  return out;
};
function unhook(): void {
  delete hooks.afterGet;
  delete hooks.script;
  delete during.list;
  delete during.open;
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

type Sold = { result: string; session: string | null };
async function sell(w: World, start: number): Promise<Sold> {
  const held = await holdAndCheckout({ store: w.store, product: w.full, start, buyerTz: NY, origin: "https://marktmorgen.com" });
  return held.ok ? { result: "opened", session: held.session } : { result: held.reason, session: null };
}

const lockOf = (w: World) => `nl:call:lock:${w.store.callsId}`;
const diaryOf = (w: World) => `nl:call:busy:${w.store.callsId}`;
async function clear(w: World): Promise<void> {
  await run([["DEL", lockOf(w)], ["DEL", diaryOf(w)]]);
}
async function lockValue(w: World): Promise<unknown> {
  return (await run([["GET", lockOf(w)]]))[0];
}
async function diaryFields(w: World): Promise<string[]> {
  const [flat] = await run([["HGETALL", diaryOf(w)]]);
  return (flat as string[]).filter((_, i) => i % 2 === 0);
}
/** Another request's lock, taken right now: a value this test writes, which no request of the code under test writes. */
async function takenByAnother(w: World, value: string): Promise<void> {
  await run([["SET", lockOf(w), value, "EX", 15]]);
}
/** A lock left behind 20 seconds ago by a request that died, still there. */
async function leftBehind(w: World): Promise<string> {
  const value = String(Date.now() - 20_000);
  await run([["SET", lockOf(w), value, "EX", 15]]);
  return value;
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_lock_owner_only";
  process.env.RESEND_API_KEY = "re_test_lock_owner_only";

  const a = await callStore("lockowner@example.com", "lockowner", "acct_1LockOwnerA");
  const T = weekdayAt(9, 600);

  part("Controls: a sale, a lock held right now, and a lock left behind");
  let before = opened;
  let seen: unknown = null;
  during.open = async () => {
    seen = await lockValue(a);
  };
  const first = await sell(a, T);
  is("control: a first buyer opens a checkout for the time", [first.result, opened - before], ["opened", 1]);
  is("control: …its hold is in the diary", (await diaryFields(a)).includes(String(first.session)), true);
  is("control: …and its lock is let go afterward", await lockValue(a), null);
  is("while it worked, the lock held the time it was taken and a random part only it writes", typeof seen === "string" && /^\d{13}\.\d{9}$/.test(seen), true);
  before = opened;
  is("control: a second buyer for the same time is told it is taken, with no checkout", [(await sell(a, T)).result, opened - before], ["taken", 0]);
  await clear(a);

  const holding = `${Date.now()}.000000001`;
  await takenByAnother(a, holding);
  before = opened;
  is("control: a lock held right now turns the buyer away, with no checkout", [(await sell(a, T)).result, opened - before], ["taken", 0]);
  is("control: …and that lock is left as it was", await lockValue(a), holding);
  await clear(a);

  await leftBehind(a);
  before = opened;
  const alone = await sell(a, T);
  is("control: a lock left 20 seconds ago is taken over by one buyer, who opens a checkout", [alone.result, opened - before], ["opened", 1]);
  is("control: …and lets it go afterward", await lockValue(a), null);
  await clear(a);

  part("Two buyers who find the same lock left behind: only one takes it over");
  // Buyer B takes the lock over between buyer A's GET of the old time and A's own take-over.
  await leftBehind(a);
  const theirs = `${Date.now()}.000000002`;
  hooks.afterGet = () => takenByAnother(a, theirs);
  before = opened;
  const late = await sell(a, T);
  unhook();
  is("the buyer whose take-over comes second is turned away, with no checkout", [late.result, opened - before], ["taken", 0]);
  is("…and the lock is still the other buyer's", await lockValue(a), theirs);
  await clear(a);

  await leftBehind(a);
  before = opened;
  const both = await Promise.all([sell(a, T), sell(a, T)]);
  is(
    "two buyers of one time, both finding the same lock left behind: one checkout, the other told it is taken",
    [both.map((b) => b.result).sort(), opened - before],
    [["opened", "taken"], 1],
  );
  await clear(a);

  part("A holder whose lock was taken over while it worked deletes nothing of the next holder's, and sells nothing");
  let next = `${Date.now()}.000000003`;
  during.open = () => takenByAnother(a, next);
  before = opened;
  let closedBefore = expired.length;
  const slowOpen = await sell(a, T);
  unhook();
  is("lock taken over while the checkout opened: the booking is refused", slowOpen.result, "error");
  is("…no hold of it is written", (await diaryFields(a)).length, 0);
  is("…the checkout it opened is closed at Stripe", [opened - before, expired.length - closedBefore], [1, 1]);
  is("…and the next holder's lock is not deleted", await lockValue(a), next);
  await clear(a);

  next = `${Date.now()}.000000004`;
  during.list = () => takenByAnother(a, next);
  before = opened;
  const slowRead = await sell(a, T);
  unhook();
  is("lock taken over while Stripe was read: refused, no checkout is opened", [slowRead.result, opened - before], ["error", 0]);
  is("…nothing is written to the diary", (await diaryFields(a)).length, 0);
  is("…and the next holder's lock is not deleted", await lockValue(a), next);
  await clear(a);

  during.open = async () => {
    await run([["DEL", lockOf(a)]]);
  };
  before = opened;
  closedBefore = expired.length;
  const ranOut = await sell(a, T);
  unhook();
  is("lock that ran out while the checkout opened: refused, no hold written, the checkout closed", [ranOut.result, (await diaryFields(a)).length, expired.length - closedBefore], ["error", 0, 1]);
  await clear(a);

  part("A move whose lock was taken over while it worked is not written, and deletes nothing of the next holder's");
  const m = await callStore("moveowner@example.com", "moveowner", "acct_1MoveOwnerA");
  const M = weekdayAt(10, 600);
  const later = M + 3 * HOUR;
  const booked = await sell(m, M);
  if (!booked.session) throw new Error("no booking to move");
  const session = booked.session;
  const entryBefore = await run([["HGET", diaryOf(m), session]]);
  next = `${Date.now()}.000000005`;
  during.list = () => takenByAnother(m, next);
  const refused = await moveBooking({ store: m.store, product: m.call, session, booked: { start: M, end: M + HOUR, email: "buyer@example.com", buyerTz: NY }, start: later, origin: "https://marktmorgen.com" });
  unhook();
  is("lock taken over while the move read Stripe: the move is refused", refused, { ok: false, reason: "error" });
  is("…the diary is as it was", await run([["HGET", diaryOf(m), session]]), entryBefore);
  is("…and the next holder's lock is not deleted", await lockValue(m), next);
  await run([["DEL", lockOf(m)]]);

  const moved = await moveBooking({ store: m.store, product: m.call, session, booked: { start: M, end: M + HOUR, email: "buyer@example.com", buyerTz: NY }, start: later, origin: "https://marktmorgen.com" });
  is("control: the same move with the lock its own is done", moved.ok ? [moved.start, moved.end] : moved, [later, later + HOUR]);
  is("control: …and its lock is let go afterward", await lockValue(m), null);

  part("Each script's reply is read exactly: anything but 1 or 0 refuses");
  const odd: [string, unknown][] = [
    ["nothing (undefined)", undefined],
    ["OK", "OK"],
    ["the text 1", "1"],
    ["2", 2],
    ["a list holding 1", [1]],
  ];
  for (const [what, value] of odd) {
    await leftBehind(a);
    hooks.script = { name: SWAP_SCRIPT, value };
    before = opened;
    is(`taking over a lock left behind, the script answering ${what}: refused, no checkout`, [(await sell(a, T)).result, opened - before], ["error", 0]);
    unhook();
    await clear(a);
  }
  for (const [what, value] of odd) {
    // A lock of its own, made to last again before the checkout is opened.
    hooks.script = { name: SWAP_SCRIPT, value };
    before = opened;
    is(`making its own lock last before opening, the script answering ${what}: refused, no checkout`, [(await sell(a, T)).result, opened - before], ["error", 0]);
    unhook();
    await clear(a);
  }
  for (const [what, value] of odd) {
    hooks.script = { name: HOLD_SCRIPT, value };
    before = opened;
    closedBefore = expired.length;
    const sold = await sell(a, T);
    unhook();
    is(`writing the hold, the script answering ${what}: refused, and the checkout opened is closed`, [sold.result, opened - before, expired.length - closedBefore], ["error", 1, 1]);
    await clear(a);
  }
  hooks.script = { name: SWAP_SCRIPT, value: "OK" };
  const oddMove = await moveBooking({ store: m.store, product: m.call, session, booked: { start: later, end: later + HOUR, email: "buyer@example.com", buyerTz: NY }, start: later + HOUR, origin: "https://marktmorgen.com" });
  unhook();
  is("a move whose lock's script answers OK instead of 1 is refused", oddMove, { ok: false, reason: "error" });
  is("…and is not written", JSON.parse(String((await run([["HGET", diaryOf(m), session]]))[0])).s, later);

  done();
}

void main();
