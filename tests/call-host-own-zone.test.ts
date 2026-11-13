/**
 * A team host is told a booking's time on their own clock (Claude 7's calls hunt, 13 November 2026).
 *
 * The creator-side emails of a booking go to its team host when the store's owner is not one of its hosts
 * (lib/calls.ts, hostRecipient). They said the time on the store's clock and called it "your time zone": a host in
 * London of a New York store was told 10:00 AM EST, "your time zone", for a call at 3:00 PM on their own clock. The
 * calendar file was right; the words were not. Now the new-booking email and the moved email to a host give the time
 * in that host's own zone (the one their week is written in, lib/team-scheduling-rules.ts TeamHost.tz), and the
 * store owner's emails stay on the store's clock.
 *
 * Against the real code with an in-memory Redis and stand-ins for Stripe and Resend.
 */
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setProductCall, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import type { Product, Store } from "@/lib/store";
import { readListing, readProduct } from "@/lib/catalog";
import { type CallListing, confirmBooking, holdAndCheckout, moveBooking } from "@/lib/calls";
import { type CallSetup, readableTime, zoneName } from "@/lib/call-setup";
import type { TeamHost } from "@/lib/team-scheduling-rules";
import { writeTeam } from "@/lib/team-booking";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { weekdayAt } from "./weekday";
import { paidPeriod } from "./billing-period-fixture";

const HOUR = 3_600_000;
const NY = "America/New_York";
const LONDON = "Europe/London";

const sent: { to: string[]; subject: string; text: string }[] = [];
let sessions = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { to: string | string[]; subject: string; text: string };
    sent.push({ to: Array.isArray(body.to) ? body.to : [body.to], subject: body.subject, text: body.text });
    return answer({ id: `e${sent.length}` });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  if (method === "POST" && path === "/checkout/sessions") {
    sessions += 1;
    const id = `cs_test_hostzone${String(sessions).padStart(10, "0")}`;
    return answer({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const ALL_DAY: [number, number][][] = [[], [[0, 1440]], [[0, 1440]], [[0, 1440]], [[0, 1440]], [[0, 1440]], []];
const weekly = {
  kind: "weekly", minutes: 60, tz: NY, weekly: ALL_DAY, noticeHours: 1, horizonDays: 30, bufferMinutes: 0,
  room: "https://example.com/room", video: false, meet: null, seats: 1, sessions: [],
} as unknown as CallSetup;
const ana: TeamHost = { email: "ana@example.com", tz: LONDON, weekly: ALL_DAY, bufferMinutes: 0, noticeHours: 1, dailyCap: 4 };

const toAna = () => sent.filter((m) => m.to.includes("ana@example.com"));

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_host_zone_only";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  const owner = "harbor@example.com";
  await claimHandle(owner, "harbor", "Harbor studio", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1TestHarbor0001", true);
  await setSubscription(owner, { customerId: "cus_harbor00001", subscriptionId: "sub_harbor00001", active: true, tier: "pro", period: paidPeriod() });
  const made = await addProduct(owner, "Strategy call", "", "120", null);
  if (!made.ok) throw new Error("no product");
  await setProductCall(owner, made.product.id, weekly);
  const store = (await storeForEmail(owner)) as Store;
  // Ana is on the store's team (lib/team.ts), so she may host its calls.
  await redis.pipeline([["SET", `nl:team:${store.sid}`, JSON.stringify({ members: [{ email: "ana@example.com", role: "admin", joinedAt: "2026-10-06T00:00:00.000Z" }], invites: [] })]]);
  const call = (await readListing(store, made.product.id)) as CallListing;
  // The owner is not a host: the creator-side emails go to Ana, in London.
  await writeTeam(store, call.id, { mode: "round_robin", hosts: [ana], createdAt: "2026-10-06T00:00:00.000Z" });

  const start = weekdayAt(9, 600);
  const full = (await readProduct(store, call.id)) as Product & { call: CallSetup };
  const held = await holdAndCheckout({ store, product: full, start, buyerTz: NY, origin: "https://marktmorgen.com" });
  if (!held.ok) throw new Error(`no hold: ${held.reason}`);

  part("The new-booking email to a host in another zone");
  // Read again: the hold gave the store its calls diary.
  const kept = (await storeForEmail(owner)) as Store;
  is("control: the store has its calls diary", Boolean(kept.callsId), true);
  await confirmBooking({ store: kept, product: call, session: held.session, start, end: start + HOUR, buyerEmail: "lee@example.com", buyerTz: NY, cancel: null, amountCents: 12000, currency: "usd", origin: "https://marktmorgen.com" });
  const booked = toAna().find((m) => m.subject.startsWith("New booking:"));
  is("control: the creator-side email goes to the host", Boolean(booked), true);
  is("its subject gives the time on the host's clock", booked?.subject, `New booking: Strategy call, ${readableTime(start, LONDON)}`);
  is("its body gives the time and the host's own zone", booked?.text.includes(`${readableTime(start, LONDON)} (${zoneName(start, LONDON)}, your time zone)`), true);
  is("never the store's clock called the host's", booked?.text.includes(`(${zoneName(start, NY)}, your time zone)`), false);

  part("The moved email to that host");
  const to = start + 2 * HOUR;
  const moved = await moveBooking({ store: kept, product: call, session: held.session, booked: { start, end: start + HOUR, email: "lee@example.com", buyerTz: NY }, start: to, origin: "https://marktmorgen.com" });
  is("control: the booking moved", moved.ok, true);
  const told = toAna().find((m) => m.subject.startsWith("Moved:"));
  is("control: the host is told", Boolean(told), true);
  is("its subject gives the new time on the host's clock", told?.subject, `Moved: Strategy call, now ${readableTime(to, LONDON)}`);
  is("its body gives both times on the host's clock", [told?.text.includes(`Now: ${readableTime(to, LONDON)} (${zoneName(to, LONDON)}), your time zone`), told?.text.includes(`Was: ${readableTime(start, LONDON)} (${zoneName(start, LONDON)})`)], [true, true]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
