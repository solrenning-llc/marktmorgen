/**
 * A moved booking's reminders are planned for its new time even when dropping the old time's reminders fails
 * (Claude 7, 13 November 2026). Synthetic only: the in-memory Redis and a stand-in for Stripe and the mail provider,
 * through the real lib/calls.ts moveBooking.
 *
 * moveBooking ran unplanReminders and planReminders in one try: a Redis failure on the ZREM of the old reminders
 * skipped planning the new ones, so a buyer who moved a call got no reminder a day or an hour before the new time.
 * The old time's reminders, if left, are dropped by the reminder job, which sends only for the booking's current start.
 */
import { addProduct, claimHandle, ensureStatsId, setProductCall, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import type { Product, Store } from "@/lib/store";
import { readListing, readProduct } from "@/lib/catalog";
import { type CallListing, holdAndCheckout, moveBooking } from "@/lib/calls";
import type { CallSetup } from "@/lib/call-setup";
import { REMINDER_QUEUE } from "@/lib/call-records";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { weekdayAt } from "./weekday";
import { paidPeriod } from "./billing-period-fixture";

const HOUR = 3_600_000;
const NY = "America/New_York";

let opened = 0;
let mails = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    mails += 1;
    return answer({ id: `e${mails}` });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  if (method === "POST" && path === "/checkout/sessions") {
    opened += 1;
    const id = `cs_test_movewrite${String(opened).padStart(10, "0")}`;
    return answer({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

/** While true, a ZREM on the reminder queue fails the way a Redis request that did not answer does. */
let zremFails = false;
const run = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (zremFails && commands.some((c) => c[0] === "ZREM" && c[1] === REMINDER_QUEUE)) throw new Error("Redis request failed with status 503");
  return run(commands);
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

type World = { store: Store; call: CallListing; full: Product & { call: CallSetup } };

async function callStore(email: string, handle: string, account: string): Promise<World> {
  return callStoreAs(email, handle, account, "creator");
}

async function callStoreAs(email: string, handle: string, account: string, tier: "creator" | "pro"): Promise<World> {
  await claimHandle(email, handle, `${handle} studio`, "");
  await ensureStatsId(email);
  await setStripeAccount(email, account, true);
  await setSubscription(email, { customerId: `cus_${handle}00001`, subscriptionId: `sub_${handle}00001`, active: true, tier, period: paidPeriod() });
  const made = await addProduct(email, "Strategy call", "", "120", null);
  if (!made.ok) throw new Error("no product");
  await setProductCall(email, made.product.id, weekly);
  const store = (await storeForEmail(email)) as Store;
  const call = (await readListing(store, made.product.id)) as CallListing;
  const full = (await readProduct(store, call.id)) as Product & { call: CallSetup };
  return { store, call, full };
}

async function sellSession(w: World, start: number): Promise<string> {
  const held = await holdAndCheckout({ store: w.store, product: w.full, start, buyerTz: NY, origin: "https://marktmorgen.com" });
  if (!held.ok) throw new Error(`no checkout: ${held.reason}`);
  return held.session;
}

/** The reminder queue's members for a session. */
async function queued(session: string): Promise<string[]> {
  const [rows] = await run([["ZRANGEBYSCORE", REMINDER_QUEUE, "-inf", "+inf"]]);
  return (rows as string[]).filter((m) => m.includes(`|${session}|`)).sort();
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_move_reminders_only";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  const w = await callStore("movereminders@example.com", "movereminders", "acct_1MoveReminders");
  const move = (session: string, from: number, to: number) =>
    moveBooking({ store: w.store, product: w.call, session, booked: { start: from, end: from + HOUR, email: "buyer@example.com", buyerTz: NY }, start: to, origin: "https://marktmorgen.com" });
  const planned = async (session: string, at: number) => (await queued(session)).filter((m) => m.endsWith(`|${at}`) && !m.includes("|c|")).length;

  part("Control: a healthy move plans both reminders at the new time");
  const A = weekdayAt(10, 600);
  const healthy = await sellSession(w, A);
  const moved1 = await move(healthy, A, A + 3 * HOUR);
  is("the move is done", moved1.ok, true);
  is("both reminders are planned at the new time", await planned(healthy, A + 3 * HOUR), 2);

  part("Dropping the old reminders fails: the new ones are still planned");
  const B = weekdayAt(11, 600);
  const second = await sellSession(w, B);
  zremFails = true;
  const moved2 = await move(second, B, B + 3 * HOUR);
  zremFails = false;
  is("the move is done", moved2.ok, true);
  is("both reminders are planned at the new time", await planned(second, B + 3 * HOUR), 2);
  done();
}

void main();
