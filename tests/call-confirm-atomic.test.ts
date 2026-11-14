/**
 * A paid call's confirmation is never left half done (rules 24 and 30; Claude 5, 9 November 2026).
 *
 * confirmBooking (lib/calls.ts) wrote its once-only mark with a SET NX and only then counted the orders, wrote the
 * affiliate's lead, made the time taken for good (the diary's HDEL and HSET), planned the reminders, queued the
 * webhook and sent the buyer's and the creator's emails. When anything after the mark threw (Redis slow for a moment,
 * an answer lost on the way back), every later try found the mark and did nothing: the paid call kept only its
 * checkout's hold, which ran out, so the time was free again and could be sold twice, and neither email ever went.
 *
 * Checked here, against the real hold, the real confirmation and the real mail job (lib/call-reminders.ts), with an
 * in-memory Redis and stand-ins for Stripe and Resend (Resend keeps one email per Idempotency-Key, as it does for a
 * day), Redis failing from every one of its requests after the mark in turn, and with the mark's own answer lost:
 *
 *   - the mark and the time taken for good are written together or not at all;
 *   - the mail job's next run finishes it: the time is kept for good, the buyer and the creator each get the
 *     confirmation once, the orders are never counted twice;
 *   - later tries (the job, the studio's catch-up, the thanks page) send nothing more.
 *
 * Synthetic only.
 */
import { addProduct, claimHandle, ensureStatsId, setProductCall, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import type { Product, Store } from "@/lib/store";
import { readListing, readProduct } from "@/lib/catalog";
import { type CallListing, type PaidCall, catchUpBookings, confirmBooking, confirmationOwed, confirmedKey, holdAndCheckout } from "@/lib/calls";
import { dataKey } from "@/lib/store-data";
import { type CallSetup, zonedToUtc } from "@/lib/call-setup";
import { sendCallReminders } from "@/lib/call-reminders";
import { CALL_ORDER_UNITS } from "@/lib/order-rules";
import { storeOrdersThisMonth } from "@/lib/orders";
import { HOLD_SECONDS } from "@/lib/stripe-account";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NY = "America/New_York";
const OWNER = "quay@example.com";
const BUYER = "ana@example.com";
const ORIGIN = "https://marktmorgen.com";

let sessions = 0;
const paidRows: Record<string, unknown>[] = [];
const heldMeta = new Map<string, Record<string, string>>();
/** Every POST Resend was sent, and what it kept: one email per Idempotency-Key. */
const posts: { to: string; subject: string; key: string }[] = [];
const kept = new Map<string, string>();
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[]; subject?: string };
    const to = String([body.to].flat()[0]);
    const key = new Headers(init?.headers).get("Idempotency-Key") ?? `none:${posts.length}`;
    posts.push({ to, subject: String(body.subject ?? ""), key });
    if (!kept.has(key)) kept.set(key, to);
    return answer({ id: `email_${kept.size}` });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  if (method === "POST" && path === "/checkout/sessions") {
    sessions += 1;
    const id = `cs_test_confirmatomic${String(sessions).padStart(8, "0")}`;
    const body = new URLSearchParams(String(init?.body));
    heldMeta.set(id, Object.fromEntries([...body].filter(([k]) => k.startsWith("metadata[")).map(([k, v]) => [k.slice(9, -1), v])));
    return answer({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
  }
  if (method === "GET" && path === "/checkout/sessions") return answer({ object: "list", data: paidRows, has_more: false });
  if (method === "GET" && path.startsWith("/checkout/sessions/")) return answer(paidRows.find((r) => r.id === path.split("/").at(-1)) ?? {});
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

/**
 * How Redis fails around one booking's mark while its confirmation runs:
 *  - "count": it does not; the requests made after the mark exists are counted;
 *  - "from": the k-th request made after the mark exists, and every one after it, never reach Redis;
 *  - "lost": the request that writes the mark is applied, but its answer is lost on the way back.
 */
type Fault = { kind: "none" } | { kind: "count"; session: string; after: number } | { kind: "from"; session: string; k: number; after: number } | { kind: "lost"; session: string };
let fault: Fault = { kind: "none" };
const run = redis.pipeline.bind(redis);
const timeout = () => new Error("Synthetic: Redis timed out");
redis.pipeline = (async (commands: (string | number)[][]) => {
  const f = fault;
  if (f.kind === "none") return run(commands);
  const marked = async () => (await run([["EXISTS", confirmedKey(f.session)]]))[0] === 1;
  const before = await marked();
  if (f.kind === "count" || f.kind === "from") {
    if (before) {
      f.after += 1;
      if (f.kind === "from" && f.after >= f.k) throw timeout();
    }
    return run(commands);
  }
  const replies = await run(commands);
  if (!before && (await marked())) throw timeout();
  return replies;
}) as typeof redis.pipeline;

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

/** Distinct free hours, 9:00 to 16:00 on the weekdays from two days on. */
function slots(now: number): number[] {
  const out: number[] = [];
  for (let d = 2; d < 28; d += 1) {
    const day = new Date(now + d * DAY);
    const p = new Intl.DateTimeFormat("en-US", { timeZone: NY, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(day);
    const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
    if (get("weekday") === "Sat" || get("weekday") === "Sun") continue;
    for (let h = 0; h < 8; h += 1) out.push(zonedToUtc(Number(get("year")), Number(get("month")), Number(get("day")), 540 + h * 60, NY) as number);
  }
  return out;
}

async function main(): Promise<void> {
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  const quiet = console.error;
  try {
    redis.clear();
    process.env.STRIPE_SECRET_KEY = "sk_test_confirm_atomic_only";
    process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
    await claimHandle(OWNER, "quay", "Quay Studio", "");
    await ensureStatsId(OWNER);
    await setStripeAccount(OWNER, "acct_1TestQuay00001", true);
    await setSubscription(OWNER, { customerId: "cus_quay00001", subscriptionId: "sub_quay00001", active: true, tier: "pro", period: paidPeriod() });
    const made = await addProduct(OWNER, "Strategy call", "", "120", null);
    if (!made.ok) throw new Error("no product");
    await setProductCall(OWNER, made.product.id, weekly);
    const store = (await storeForEmail(OWNER)) as Store;
    const call = (await readListing(store, made.product.id)) as CallListing;
    const free = slots(clock);
    const diary = `nl:call:busy:${store.callsId}`;
    const entryOf = async (session: string) => {
      const [raw] = await run([["HGET", diary, session]]);
      return typeof raw === "string" ? (JSON.parse(raw) as { until: number }) : null;
    };
    const markOf = async (session: string) => (await run([["EXISTS", confirmedKey(session)]]))[0] === 1;
    const orders = async () => (await storeOrdersThisMonth(store)) ?? 0;

    /** A booking held and paid as a buyer does it: the real hold, its checkout, and Stripe saying it is paid. */
    const book = async (start: number) => {
      const full = (await readProduct(store, call.id)) as Product & { call: CallSetup };
      const held = await holdAndCheckout({ store, product: full, start, buyerTz: NY, origin: ORIGIN });
      if (!held.ok) throw new Error(`no hold: ${held.reason}`);
      paidRows.push({ id: held.session, status: "complete", payment_status: "paid", created: Math.floor(clock / 1000), amount_total: 12000, currency: "usd", customer_details: { email: BUYER }, metadata: heldMeta.get(held.session) });
      return held.session;
    };
    /** The thanks page's confirmation, as the buyer comes back from paying. */
    const thanks = (session: string, start: number) =>
      confirmBooking({ store, product: call, session, start, end: start + HOUR, buyerEmail: BUYER, buyerTz: NY, amountCents: 12000, currency: "usd", origin: ORIGIN });
    const job = () => sendCallReminders(async (handle) => (handle === store.handle ? store : null), clock + 60_000, ORIGIN);
    const postsNow = () => posts.length;
    /** The confirmations Resend kept since `from`: one per Idempotency-Key, the buyer's and the creator's. */
    const confirmations = (from: number) => {
      const since = posts.slice(from);
      const distinct = (prefix: string) => new Set(since.filter((p) => p.subject.startsWith(prefix)).map((p) => p.key)).size;
      return [distinct("Booked: "), distinct("New booking: ")];
    };

    part("Healthy control: one confirmation, the time kept for good, two emails, the orders counted once");
    let slot = 0;
    const control = await book(free[slot]);
    const startCount = await orders();
    const counting: Fault = { kind: "count", session: control, after: 0 };
    fault = counting;
    await thanks(control, free[slot]);
    fault = { kind: "none" };
    const after = counting.after;
    is("the time is kept for good", (await entryOf(control))?.until, 0);
    is("one email to the buyer and one to the creator", confirmations(0), [1, 1]);
    is("the orders counted as the call's units", (await orders()) - startCount, CALL_ORDER_UNITS);
    const settled = postsNow();
    clock += HOLD_SECONDS * 1000 + 120_000;
    await job();
    await catchUpBookings(store, [{ session: control, product: call.id, start: free[slot], end: free[slot] + HOUR, email: BUYER, buyerTz: NY, amount: 12000, currency: "usd" } as unknown as PaidCall], ORIGIN);
    await thanks(control, free[slot]);
    is("later tries send no confirmation again", confirmations(settled), [0, 0]);
    is("Redis is asked something after the mark", after > 0, true);

    const cases: { label: string; make: (session: string) => Fault }[] = [
      { label: "the mark is written but its answer is lost", make: (session) => ({ kind: "lost", session }) },
      ...Array.from({ length: after }, (_, i) => ({ label: `Redis fails from request ${i + 1} of ${after} after the mark`, make: (session: string): Fault => ({ kind: "from", session, k: i + 1, after: 0 }) })),
    ];
    let owed = 0;
    for (const { label, make } of cases) {
      part(`Claude 5: ${label}`);
      slot += 1;
      const start = free[slot];
      const session = await book(start);
      const before = await orders();
      const firstPosts = postsNow();
      fault = make(session);
      console.error = () => {};
      await thanks(session, start).catch(() => {});
      console.error = quiet;
      fault = { kind: "none" };
      const marked = await markOf(session);
      is("the mark and the time kept for good are written together or not at all", marked ? (await entryOf(session))?.until : 0, 0);
      // The hold runs out; the mail job's next run is the next try.
      clock += HOLD_SECONDS * 1000 + 120_000;
      console.error = () => {};
      await job().catch(() => {});
      console.error = quiet;
      const entry = await entryOf(session);
      const [buyer, creator] = confirmations(firstPosts);
      const ok = entry?.until === 0 && buyer === 1 && creator === 1;
      if (!ok) owed += 1;
      is("after the next try the time is kept for good, and each email went once", [entry?.until, buyer, creator], [0, 1, 1]);
      is("the orders are never counted twice", (await orders()) - before <= CALL_ORDER_UNITS, true);
      const settledHere = postsNow();
      clock += 5 * 60_000;
      await job();
      await catchUpBookings(store, [{ session, product: call.id, start, end: start + HOUR, email: BUYER, buyerTz: NY, amount: 12000, currency: "usd" } as unknown as PaidCall], ORIGIN);
      await thanks(session, start);
      is("later tries send no confirmation again", confirmations(settledHere), [0, 0]);
    }
    is("no booking was left half confirmed", owed, 0);

    part("A refreshed page writes and charges nothing more");
    const room = dataKey(store)!;
    const charged = async () => (await run([["HGET", room, "o"]]))[0];
    const roomBefore = await charged();
    await thanks(control, free[0]);
    await thanks(control, free[0]);
    is("the store's room is charged once for the booking", await charged(), roomBefore);

    part("A mark from before this day, one left short of done whose time was let go, and one not known");
    const take = async () => {
      slot += 1;
      return { start: free[slot], session: await book(free[slot]) };
    };
    const legacy = await take();
    await run([["SET", confirmedKey(legacy.session), "1", "EX", 60]]);
    let from = postsNow();
    await thanks(legacy.session, legacy.start);
    is("a mark written before this day (\"1\") reads as done, as it always did", [confirmations(from), await confirmationOwed(legacy.session)], [[0, 0], false]);
    const gone = await take();
    await run([["SET", confirmedKey(gone.session), "sending", "EX", 60], ["HDEL", diary, gone.session]]);
    from = postsNow();
    await thanks(gone.session, gone.start);
    is(
      "a confirmation left short of done whose time was let go since tells nobody it is booked, and is done",
      [confirmations(from), (await run([["GET", confirmedKey(gone.session)]]))[0], await confirmationOwed(gone.session)],
      [[0, 0], "done", false],
    );
    const odd = await take();
    await run([["SET", confirmedKey(odd.session), "maybe", "EX", 60]]);
    from = postsNow();
    const refused = await thanks(odd.session, odd.start).then(() => "returned", (error) => String(error?.name ?? error));
    const owedOdd = await confirmationOwed(odd.session).then(String, (error) => String(error?.name ?? error));
    is("a mark not known is thrown, never taken for done or owed, and sends nothing (rule 24)", [refused, owedOdd, confirmations(from)], ["UnknownReplyError", "UnknownReplyError", [0, 0]]);
    is("the mail job's question: owed when never begun or left short, not once done", [await confirmationOwed("cs_test_never_begun_000001"), await confirmationOwed(control)], [true, false]);
    done();
  } finally {
    console.error = quiet;
    Date.now = realNow;
  }
}

main().catch((error) => {
  console.log(String(error?.stack ?? error));
  process.exit(1);
});
