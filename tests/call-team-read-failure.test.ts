/**
 * A team booking whose team cannot be read (rule 24, 7 November 2026).
 *
 * The team kept for a call (lib/team-booking.ts, readTeams) is read from
 * Redis. When that read fails, nothing is known about the booking's hosts:
 * it is never taken as "no team".
 *
 *   - confirming a paid team booking: a failed read leaves it unconfirmed,
 *     for the next confirmation (catchUpBookings, the mail job), instead of
 *     marking it confirmed without its hosts, so their claim on the time
 *     would run out with the hold and the time be given again;
 *   - moving a team booking: a failed read refuses the move, instead of
 *     moving it by the store's own hours and letting its hosts' claim go.
 *
 * Against the real code with an in-memory Redis and a stand-in for Stripe.
 */
import { addProduct, claimHandle, ensureStatsId, setProductCall, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import type { Product, Store } from "@/lib/store";
import { readListing, readProduct } from "@/lib/catalog";
import { type CallListing, confirmBooking, holdAndCheckout, isConfirmed, moveBooking } from "@/lib/calls";
import type { CallSetup } from "@/lib/call-setup";
import type { TeamHost } from "@/lib/team-scheduling-rules";
import { hostId, readClaims } from "@/lib/host-claims";
import { writeTeam } from "@/lib/team-booking";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { weekdayAt } from "./weekday";
import { paidPeriod } from "./billing-period-fixture";

const HOUR = 3_600_000;
const NY = "America/New_York";

let sessions = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") return answer({ id: "e" });
  const path = url.pathname.replace(/^\/v1/, "");
  if (method === "POST" && path === "/checkout/sessions") {
    sessions += 1;
    const id = `cs_test_teamread${String(sessions).padStart(10, "0")}`;
    return answer({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

// The team's Redis read fails while `failTeams` is on; every other command runs as it does.
let failTeams = false;
const run = redis.pipeline;
redis.pipeline = async (commands) => {
  if (failTeams && commands.some((c) => c[0] === "HGETALL" && String(c[1]).startsWith("nl:callteam:"))) throw new Error("Redis request failed with status 503");
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

function host(email: string): TeamHost {
  return { email, tz: NY, weekly: WEEKDAYS, bufferMinutes: 0, noticeHours: 1, dailyCap: 4 };
}

async function teamStore(email: string, handle: string, account: string): Promise<{ store: Store; call: CallListing }> {
  await claimHandle(email, handle, `${handle} studio`, "");
  await ensureStatsId(email);
  await setStripeAccount(email, account, true);
  await setSubscription(email, { customerId: `cus_${handle}00001`, subscriptionId: `sub_${handle}00001`, active: true, tier: "pro", period: paidPeriod() });
  const made = await addProduct(email, "Strategy call", "", "120", null);
  if (!made.ok) throw new Error("no product");
  await setProductCall(email, made.product.id, weekly);
  const store = (await storeForEmail(email)) as Store;
  const call = (await readListing(store, made.product.id)) as CallListing;
  await writeTeam(store, call.id, { mode: "round_robin", hosts: [host(email)], createdAt: "2026-10-06T00:00:00.000Z" });
  return { store, call };
}

async function hold(store: Store, call: CallListing, start: number): Promise<string> {
  const full = (await readProduct(store, call.id)) as Product & { call: CallSetup };
  const held = await holdAndCheckout({ store, product: full, start, buyerTz: NY, origin: "https://marktmorgen.com" });
  if (!held.ok) throw new Error(`no hold: ${held.reason}`);
  return held.session;
}

const claimAt = async (email: string, start: number) => ((await readClaims([hostId(email)])).get(hostId(email)) ?? []).find((c) => c.start === start);

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_team_read_only";
  process.env.RESEND_API_KEY = "re_test_team_read_only";

  part("Confirming a paid team booking while its team cannot be read");
  const quay = await teamStore("quay@example.com", "quay", "acct_1TestQuay00001");
  const Q = weekdayAt(9, 600);
  const session = await hold(quay.store, quay.call, Q);
  is("the hold claims its host's time for as long as the checkout can be paid", ((await claimAt("quay@example.com", Q))?.until ?? 0) > 0, true);
  const booked = { store: quay.store, product: quay.call, session, start: Q, end: Q + HOUR, buyerEmail: "lee@example.com", buyerTz: NY, cancel: null, origin: "https://marktmorgen.com" };
  failTeams = true;
  let threw = false;
  try {
    await confirmBooking(booked);
  } catch {
    threw = true;
  }
  failTeams = false;
  // Thrown, not returned (Codex G on #3080): the mail job keeps a confirmation that throws in its queue.
  is("a failed team read throws and leaves the booking unconfirmed, for the next confirmation", [threw, await isConfirmed(session)], [true, false]);
  await confirmBooking(booked);
  is("confirmed once the team can be read, its host's claim is kept for good", [await isConfirmed(session), (await claimAt("quay@example.com", Q))?.until], [true, 0]);

  part("Moving a team booking while its team cannot be read");
  // Its own store and booking, confirmed with its team read, so this part stands on its own.
  const pier = await teamStore("pier@example.com", "pier", "acct_1TestPier00001");
  const P = weekdayAt(10, 600);
  const pierSession = await hold(pier.store, pier.call, P);
  await confirmBooking({ store: pier.store, product: pier.call, session: pierSession, start: P, end: P + HOUR, buyerEmail: "kai@example.com", buyerTz: NY, cancel: null, origin: "https://marktmorgen.com" });
  is("the booking is confirmed with its host's claim for good", [await isConfirmed(pierSession), (await claimAt("pier@example.com", P))?.until], [true, 0]);
  const to = P + 2 * HOUR;
  const move = { store: pier.store, product: pier.call, session: pierSession, booked: { start: P, end: P + HOUR, email: "kai@example.com", buyerTz: NY }, start: to, origin: "https://marktmorgen.com" };
  failTeams = true;
  const moved = await moveBooking(move);
  failTeams = false;
  is(
    "the move is refused, and the host keeps the booked time",
    [moved.ok ? "moved" : moved.reason, (await claimAt("pier@example.com", P))?.until, await claimAt("pier@example.com", to)],
    ["error", 0, undefined],
  );
  const later = await moveBooking(move);
  is("once the team can be read, the move keeps its host at the new time", [later.ok, (await claimAt("pier@example.com", to))?.until, await claimAt("pier@example.com", P)], [true, 0, undefined]);

  done();
}

void main();
