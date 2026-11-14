/**
 * A call's schedule change and a booking in flight are under the same lock
 * (issue #3983; lib/calls.ts holdAndCheckout, moveBooking, changeCall;
 * app/api/store/call/route.ts).
 *
 * Before: a booking request read the product, then waited for the store's
 * calendar lock and checked the time against that earlier reading; the
 * creator's change was checked against the bookings and written outside that
 * lock. So a request already in flight could sell a seat the creator had just
 * taken away, or a session the creator had removed, and a buyer could book
 * between the creator's check and the creator's write.
 *
 * Now the booking and the move read the call again once the lock is theirs and
 * refuse when it changed since, and the creator's check and write run under
 * the same lock.
 *
 * Against the real code with an in-memory Redis and a stand-in for Stripe;
 * synthetic data only.
 */
import { NextRequest } from "next/server";
import { POST as saveCall } from "@/app/api/store/call/route";
import { addProduct, claimHandle, ensureStatsId, setProductCall, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import type { Product, Store } from "@/lib/store";
import { readListing, readProduct } from "@/lib/catalog";
import { type CallListing, checkCallChange, holdAndCheckout, moveBooking } from "@/lib/calls";
import type { CallSetup } from "@/lib/call-setup";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { weekdayAt } from "./weekday";
import { paidPeriod } from "./billing-period-fixture";

const HOUR = 3_600_000;
const NY = "America/New_York";

/** Run once while Stripe is asked for a listing of checkouts, then forgotten. */
const during: { list?: () => Promise<void> } = {};
let opened = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") return answer({ id: "e" });
  const path = url.pathname.replace(/^\/v1/, "");
  if (method === "POST" && path === "/checkout/sessions") {
    opened += 1;
    const id = `cs_test_changelock${String(opened).padStart(10, "0")}`;
    return answer({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
  }
  if (method === "GET" && path === "/checkout/sessions") {
    const hook = during.list;
    delete during.list;
    if (hook) await hook();
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

type World = { email: string; store: Store; id: string };

async function callStore(email: string, handle: string, account: string, setup: CallSetup): Promise<World> {
  await claimHandle(email, handle, `${handle} studio`, "");
  await ensureStatsId(email);
  await setStripeAccount(email, account, true);
  await setSubscription(email, { customerId: `cus_${handle}00001`, subscriptionId: `sub_${handle}00001`, active: true, tier: "pro", period: paidPeriod() });
  const made = await addProduct(email, "Group session", "", "120", null);
  if (!made.ok) throw new Error("no product");
  const set = await setProductCall(email, made.product.id, setup);
  if (!set.ok) throw new Error(`no call: ${set.reason}`);
  return { email, store: (await storeForEmail(email)) as Store, id: made.product.id };
}

/** The store and product as a request reads them at its start. */
async function read(w: World): Promise<{ store: Store; full: Product & { call: CallSetup }; listing: CallListing }> {
  const store = (await storeForEmail(w.email)) as Store;
  return { store, full: (await readProduct(store, w.id)) as Product & { call: CallSetup }, listing: (await readListing(store, w.id)) as CallListing };
}

async function sell(store: Store, full: Product & { call: CallSetup }, start: number): Promise<string> {
  const held = await holdAndCheckout({ store, product: full, start, buyerTz: NY, origin: "https://marktmorgen.com" });
  return held.ok ? "opened" : held.reason;
}

function live(sessions: { id: string; start: number; seats: number }[]): CallSetup {
  return {
    kind: "live",
    minutes: 60,
    tz: NY,
    weekly: [[], [], [], [], [], [], []],
    noticeHours: 0,
    horizonDays: 30,
    bufferMinutes: 0,
    room: null,
    video: false,
    meet: null,
    seats: 1,
    sessions: sessions.map((s) => ({ ...s, minutes: 60, room: "https://example.com/room" })),
  } as CallSetup;
}

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  process.env.STRIPE_SECRET_KEY = "sk_test_change_lock_only";
  process.env.RESEND_API_KEY = "re_test_change_lock_only";

  const T1 = weekdayAt(5, 600);
  const T2 = weekdayAt(6, 600);

  part("A booking that read the call before the creator changed it is checked against the change");
  const a = await callStore("changelock@example.com", "changelock", "acct_1ChangeLockA", live([{ id: "sessiona1", start: T1, seats: 3 }, { id: "sessiona2", start: T2, seats: 3 }]));
  const stale = await read(a);
  is("control: a first seat of three opens", await sell(stale.store, stale.full, T1), "opened");
  is("control: a second seat of three opens", await sell(stale.store, stale.full, T1), "opened");
  const lower = live([{ id: "sessiona1", start: T1, seats: 2 }]);
  const checked = await checkCallChange(stale.store, a.id, lower);
  is("control: the creator may lower the session to the two seats taken and drop the other", typeof checked === "string" ? checked : "ok", "ok");
  if (typeof checked !== "string") is("control: …and the change is saved", (await setProductCall(a.email, a.id, checked)).ok, true);
  const fresh = await read(a);
  is("control: a request that reads the call after the change is told the third seat is taken", await sell(fresh.store, fresh.full, T1), "taken");
  const before = opened;
  is("a request that read the call before the change is told the third seat is taken", await sell(stale.store, stale.full, T1), "taken");
  is("a request that read the call before the change cannot book the session the creator removed", await sell(stale.store, stale.full, T2), "taken");
  is("…and no checkout was opened for either", opened - before, 0);

  part("A move that read the call before the creator changed the hours is checked against the change");
  const WEEK: [number, number][][] = [[], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], []];
  const weekly = { kind: "weekly", minutes: 60, tz: NY, weekly: WEEK, noticeHours: 1, horizonDays: 30, bufferMinutes: 0, room: "https://example.com/room", video: false, meet: null, seats: 1, sessions: [] } as unknown as CallSetup;
  const m = await callStore("movelock@example.com", "movelock", "acct_1MoveLockA", weekly);
  const M = weekdayAt(7, 600);
  const later = M + 4 * HOUR;
  const was = await read(m);
  const held = await holdAndCheckout({ store: was.store, product: was.full, start: M, buyerTz: NY, origin: "https://marktmorgen.com" });
  if (!held.ok) throw new Error(`no booking to move: ${held.reason}`);
  const mornings: [number, number][][] = [[], [[540, 720]], [[540, 720]], [[540, 720]], [[540, 720]], [[540, 720]], []];
  is("control: the creator cuts the hours to the mornings", (await setProductCall(m.email, m.id, { ...weekly, weekly: mornings })).ok, true);
  const move = (w: { store: Store; listing: CallListing }) =>
    moveBooking({ store: w.store, product: w.listing, session: held.session, booked: { start: M, end: M + HOUR, email: "buyer@example.com", buyerTz: NY }, start: later, origin: "https://marktmorgen.com" });
  is("control: a move that reads the call after the change is told the afternoon is taken", await move(await read(m)), { ok: false, reason: "taken" });
  is("a move that read the call before the change is told the afternoon is taken", await move(was), { ok: false, reason: "taken" });

  part("The creator's check and write are under the lock a booking takes");
  const r = await callStore("routelock@example.com", "routelock", "acct_1RouteLockA", live([{ id: "sessionr1", start: T1, seats: 3 }]));
  const page = await read(r);
  is("control: a first seat of three opens", await sell(page.store, page.full, T1), "opened");
  is("control: a second seat of three opens", await sell(page.store, page.full, T1), "opened");
  const cookie = `${SESSION_COOKIE}=${await openSession(r.email)}`;
  let third = "not tried";
  // A buyer asks for the third seat while the creator's change reads the bookings.
  during.list = async () => {
    third = await sell(page.store, page.full, T1);
  };
  const body = { id: r.id, call: { kind: "live", tz: NY, noticeHours: 0, sessions: [{ id: "sessionr1", start: T1, minutes: 60, seats: 2, room: "https://example.com/room" }] } };
  const response = await saveCall(new NextRequest("https://marktmorgen.com/api/store/call", { method: "POST", headers: { "content-type": "application/json", "x-nimbus-store": page.store.sid, cookie }, body: JSON.stringify(body) }));
  const saved = (await response.json()) as { ok: boolean };
  delete during.list;
  const seats = (await read(r)).full.call.sessions[0].seats;
  is("never three seats sold in a session saved with two", third === "opened" && saved.ok && seats === 2, false);

  done();
}

void main();
