/** Z independent residual cases, explicitly reusing the author synthetic fixture helpers. */
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
import { type CallListing, holdAndCheckout, slotsForProduct } from "@/lib/calls";
import { type CallSetup, zonedToUtc } from "@/lib/call-setup";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
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
 * lock, its GET, its plain SET (a take-over), and the HGETALL of a diary after
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
  process.env.STRIPE_SECRET_KEY = "sk_test_z_lock_only";
  const w = await callStore("zdiary@example.com", "zdiary", "acct_1ZDiaryReview");
  const T = weekdayAt(9, 600);
  part("A real producer's held entry with a semantically unreadable reply");
  const variants: [string, (entry: Record<string, unknown>) => Record<string, unknown>][] = [
    ["zero duration", e => ({ ...e, e: e.s })],
    ["end before start", e => ({ ...e, e: Number(e.s) - HOUR })],
    ["negative hold expiry", e => ({ ...e, until: -1 })],
  ];
  for (const [name, corrupt] of variants) {
    unswap(); await clear(w);
    const session = await sellSession(w, T);
    const [raw] = await run([["HGET", diaryOf(w), session]]);
    if (typeof raw !== "string") throw Error("missing actual producer hold");
    is(`${name}: healthy actual producer hold blocks its time`, (await offered(w))?.includes(T), false);
    const malformed = JSON.stringify(corrupt(JSON.parse(raw) as Record<string, unknown>));
    swap.diary = { value: [session, malformed] };
    const count = deletes.length;
    is(`${name}: unreadable semantics refuse the whole offer`, await offered(w), null);
    const before = opened;
    is(`${name}: no second checkout`, [await sell(w, T), opened - before], ["error", 0]);
    unswap();
    is(`${name}: a malformed response never deletes the healthy stored producer hold`, [(await run([["HGET", diaryOf(w), session]]))[0], deletes.length - count], [raw, 0]);
  }
  unswap(); await clear(w);
  is("healthy exact empty diary still offers times", ((await offered(w))?.length ?? 0) > 0, true);
  const expiring = await sellSession(w, T);
  const [healthyRaw] = await run([["HGET", diaryOf(w), expiring]]);
  if (typeof healthyRaw !== "string") throw Error("no expiring producer hold");
  const expiry = Number((JSON.parse(healthyRaw) as { until: number }).until);
  const clock = Date.now;
  try {
    Date.now = () => expiry + 1;
    is("healthy positive expiry passed: target can be offered", (await offered(w))?.includes(T), true);
    is("healthy positive expiry passed: real stale hold is removed", (await run([["HGET", diaryOf(w), expiring]]))[0], null);
  } finally { Date.now = clock; }
  done();
}
void main();
