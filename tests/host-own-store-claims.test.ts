/**
 * A person who hosts on another store's team and also sells ordinary calls in their own store is booked once for any
 * hour. Team bookings are written to the host's own claims (lib/host-claims.ts); an ordinary weekly booking in the
 * host's own store reads the claims other stores made on its owner (lib/calls.ts, holdAndCheckout and slotsForProduct)
 * and writes its own claim on the owner in the same atomic script (CLAIM_HOST_TIMES), kept for a paid booking, moved
 * with a move and let go when the hold is given back or the booking is refunded in full. A claims list that cannot be
 * read is never read as free (rule 24). Audit proof (Claude 5, 9 November 2026, ALTO 1), kept as its regression test.
 */
import { addProduct, claimHandle, ensureStatsId, setProductCall, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import type { Product, Store } from "@/lib/store";
import { readListing, readProduct } from "@/lib/catalog";
import { type CallListing, confirmBooking, holdAndCheckout, moveBooking, releaseOwnHold, slotsForMove, slotsForProduct } from "@/lib/calls";
import { type CallSetup, zonedToUtc } from "@/lib/call-setup";
import { putMember } from "@/lib/team";
import type { TeamHost } from "@/lib/team-scheduling-rules";
import { claimsKey, hostId, readClaims } from "@/lib/host-claims";
import { writeTeam } from "@/lib/team-booking";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
let sessions = 0;
/** The completed checkouts Stripe lists, as the test makes them paid or refunded. */
const listed: Record<string, unknown>[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") return answer({ id: "e" });
  const path = url.pathname.replace(/^\/v1/, "");
  if (method === "POST" && path === "/checkout/sessions") {
    sessions += 1;
    const id = `cs_test_own${String(sessions).padStart(12, "0")}`;
    return answer({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
  }
  if (method === "POST" && /\/expire$/.test(path)) return answer({ status: "expired" });
  if (method === "GET" && path === "/checkout/sessions") return answer({ object: "list", data: listed, has_more: false });
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const NY = "America/New_York";
const WEEKDAYS: [number, number][][] = [[], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], []];
const weekly = { kind: "weekly", minutes: 60, tz: NY, weekly: WEEKDAYS, noticeHours: 1, horizonDays: 30, bufferMinutes: 0, room: "https://example.com/room", video: false, meet: null, seats: 1, sessions: [] } as unknown as CallSetup;
const host = (email: string): TeamHost => ({ email, tz: NY, weekly: WEEKDAYS, bufferMinutes: 0, noticeHours: 1, dailyCap: 4 });

function weekdayAt(days: number, minute: number): number {
  for (let d = days; d < days + 8; d += 1) {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: NY, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(new Date(Date.now() + d * DAY));
    const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
    if (get("weekday") === "Sat" || get("weekday") === "Sun") continue;
    return zonedToUtc(Number(get("year")), Number(get("month")), Number(get("day")), minute, NY) as number;
  }
  throw new Error("no weekday");
}

async function storeWithCall(email: string, handle: string, account: string, setup: CallSetup = weekly) {
  await claimHandle(email, handle, `${handle} studio`, "");
  await ensureStatsId(email);
  await setStripeAccount(email, account, true);
  await setSubscription(email, { customerId: `cus_${handle}00001`, subscriptionId: `sub_${handle}00001`, active: true, tier: "pro", period: paidPeriod() });
  const made = await addProduct(email, "Strategy call", "", "120", null);
  if (!made.ok) throw new Error("no product");
  await setProductCall(email, made.product.id, setup);
  const store = (await storeForEmail(email)) as Store;
  return { store, product: (await readListing(store, made.product.id)) as CallListing };
}
async function anotherCall(email: string, setup: CallSetup): Promise<CallListing> {
  const made = await addProduct(email, "Group call", "", "40", null);
  if (!made.ok) throw new Error("no product");
  await setProductCall(email, made.product.id, setup);
  return (await readListing((await storeForEmail(email)) as Store, made.product.id)) as CallListing;
}
const hold = async (store: Store, product: CallListing, start: number) =>
  holdAndCheckout({ store, product: (await readProduct(store, product.id)) as Product & { call: CallSetup }, start, buyerTz: NY, origin: "https://marktmorgen.com" });
const offered = async (store: Store, product: CallListing, start: number) => Boolean((await slotsForProduct(store, product))?.days.some((d) => d.starts.includes(start)));
const MAYA = "maya@example.com";
const mayaClaims = async () => ((await readClaims([hostId(MAYA)])).get(hostId(MAYA)) ?? []).map((c) => ({ start: c.start, held: c.until > 0 })).sort((a, b) => a.start - b.start);
/** A completed checkout of Maya's call, as Stripe lists it, paid or refunded in full. */
function paidRow(session: string, store: Store, product: CallListing, start: number, refunded: boolean): Record<string, unknown> {
  return {
    id: session,
    object: "checkout.session",
    status: "complete",
    payment_status: "paid",
    created: Math.floor(Date.now() / 1000),
    amount_total: 12_000,
    currency: "usd",
    customer_details: { email: "buyer@example.com", name: "Buyer" },
    metadata: { kind: "call", store: store.handle, product: product.id, start: String(start), end: String(start + HOUR), tz: NY },
    payment_intent: { id: "pi_test_own0000001", object: "payment_intent", latest_charge: { id: "ch_test_own0000001", object: "charge", amount: 12_000, amount_refunded: refunded ? 12_000 : 0, refunded } },
  };
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_team_scheduling_only";
  process.env.RESEND_API_KEY = "re_test_team_scheduling_only";
  // Harbor's team event: Maya is its only host.
  const harbor = await storeWithCall("owner@example.com", "harbor", "acct_1TestHarbor0001");
  await putMember(harbor.store, MAYA, "editor");
  await writeTeam(harbor.store, harbor.product.id, { mode: "round_robin", hosts: [host(MAYA)], createdAt: "2026-10-01T00:00:00.000Z" });
  // Maya's own store, with her own ordinary call.
  const lantern = await storeWithCall(MAYA, "lantern", "acct_1TestLantern01");

  part("A team booking on Harbor takes Maya's hour");
  const S = weekdayAt(3, 600);
  const team = await hold(harbor.store, harbor.product, S);
  is("held on Harbor, as Maya's claim", [team.ok, ((await readClaims([hostId(MAYA)])).get(hostId(MAYA)) ?? []).map((c) => c.start)], [true, [S]]);
  is("her own store does not offer that hour", await offered(lantern.store, lantern.product, S), false);
  const own = await hold(lantern.store, lantern.product, S);
  is("and a buyer of her own call cannot hold it", own.ok ? "held" : own.reason, "taken");

  part("An ordinary booking in Maya's own store takes her hour");
  const T = weekdayAt(4, 660);
  const first = await hold(lantern.store, lantern.product, T);
  is("held in her own store", first.ok, true);
  is("Harbor's team no longer offers Maya at that hour", await offered(harbor.store, harbor.product, T), false);
  const second = await hold(harbor.store, harbor.product, T);
  is("and a Harbor buyer cannot hold her for it", second.ok ? "held" : second.reason, "taken");
  is("Maya's claims: Harbor's hold and her own store's hold", await mayaClaims(), [{ start: S, held: true }, { start: T, held: true }]);

  part("Paid, the claim stays; moved, it moves with the booking; refunded, it is let go");
  if (!first.ok) throw new Error("no hold");
  await confirmBooking({ store: lantern.store, product: lantern.product, session: first.session, start: T, end: T + HOUR, buyerEmail: "buyer@example.com", buyerTz: NY, due: null, cancel: null, origin: "https://marktmorgen.com" });
  is("paid: her own store's claim is kept for good", await mayaClaims(), [{ start: S, held: true }, { start: T, held: false }]);
  listed.push(paidRow(first.session, lantern.store, lantern.product, T, false));
  // The next hour, which starts as the booking's own hour ends: its own claim never stands in its way.
  const T2 = T + HOUR;
  const moveOffer = await slotsForMove(lantern.store, lantern.product, first.session, T, HOUR);
  is("the move page offers the next hour", Boolean(moveOffer?.days.some((d) => d.starts.includes(T2))), true);
  is("and not the hour Harbor holds her for", Boolean(moveOffer?.days.some((d) => d.starts.includes(S))), false);
  const toHarbor = await moveBooking({ store: lantern.store, product: lantern.product, session: first.session, booked: { start: T, end: T + HOUR, email: "buyer@example.com", buyerTz: NY }, start: S, origin: "https://marktmorgen.com" });
  is("a move into Harbor's hour is refused", toHarbor.ok ? "moved" : toHarbor.reason, "taken");
  const moved = await moveBooking({ store: lantern.store, product: lantern.product, session: first.session, booked: { start: T, end: T + HOUR, email: "buyer@example.com", buyerTz: NY }, start: T2, origin: "https://marktmorgen.com" });
  is("moved to the next hour", moved.ok, true);
  is("her claim moved with it, still one claim, still kept for good", await mayaClaims(), [{ start: S, held: true }, { start: T2, held: false }]);
  is("Harbor offers the hour she left, and not the one she moved to", [await offered(harbor.store, harbor.product, T), await offered(harbor.store, harbor.product, T2)], [true, false]);
  listed.length = 0;
  listed.push(paidRow(first.session, lantern.store, lantern.product, T, true));
  is("refunded in full: her own store offers the time again", await offered(lantern.store, lantern.product, T2), true);
  is("and her claim for it is let go", await mayaClaims(), [{ start: S, held: true }]);
  is("so Harbor's team offers her then again", await offered(harbor.store, harbor.product, T2), true);
  listed.length = 0;

  part("A hold given back lets her time go");
  const U = weekdayAt(5, 720);
  const given = await hold(lantern.store, lantern.product, U);
  is("held", [given.ok, (await mayaClaims()).some((c) => c.start === U)], [true, true]);
  if (given.ok) await releaseOwnHold(lantern.store, given.session);
  is("given back: no claim left on her for it", (await mayaClaims()).some((c) => c.start === U), false);
  is("and Harbor offers her then", await offered(harbor.store, harbor.product, U), true);

  part("Claims that cannot be read are never read as free");
  const V = weekdayAt(6, 780);
  // Her claims answered in a shape that is not a list (rule 24), every other reply as Redis gives it.
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const replies = await real(commands);
    return replies.map((reply, i) => (commands[i][0] === "HGETALL" && commands[i][1] === claimsKey(hostId(MAYA)) ? "not a list" : reply));
  }) as typeof redis.pipeline;
  is("her own store offers no time at all", await slotsForProduct(lantern.store, lantern.product), null);
  const blind = await hold(lantern.store, lantern.product, V);
  is("and holds nothing", blind.ok ? "held" : blind.reason, "error");
  redis.pipeline = real;
  is("read again, the time is offered", await offered(lantern.store, lantern.product, V), true);

  part("A group call's seats share one claim on her");
  const group = await anotherCall(MAYA, { ...weekly, seats: 3 } as CallSetup);
  const lanternNow = (await storeForEmail(MAYA)) as Store;
  const G = weekdayAt(7, 840);
  const seat1 = await hold(lanternNow, group, G);
  const seat2 = await hold(lanternNow, group, G);
  is("two buyers hold two seats at the same hour", [seat1.ok, seat2.ok], [true, true]);
  is("one claim on her for that hour", (await mayaClaims()).filter((c) => c.start === G).length, 1);
  is("Harbor's team does not offer her then", await offered(harbor.store, harbor.product, G), false);
  if (seat1.ok) await releaseOwnHold(lanternNow, seat1.session);
  is("one seat given back: the other still holds her", [(await mayaClaims()).some((c) => c.start === G), await offered(harbor.store, harbor.product, G)], [true, false]);
  done();
}

void main();
