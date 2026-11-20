/**
 * A person who hosts on another store's team and also sells ordinary calls in their own store is booked once for any
 * hour. Team bookings are written to the host's own claims (lib/host-claims.ts); an ordinary weekly booking in the
 * host's own store reads the claims other stores made on its owner at the hold, inside the order (lib/calls.ts,
 * holdAndCheckout), and writes its own claim on the owner in the same atomic script (CLAIM_HOST_TIMES), kept for a paid
 * booking, moved with a move and let go when the hold is given back or the booking is refunded in full. A claims list
 * that cannot be read is never read as free (rule 24). Audit proof (Claude 5, 9 November 2026, ALTO 1), kept as its
 * regression test. Owner's decision of 16 November 2026 on #3490 ("ler só no checkout"): the call's page and the move
 * page no longer read her claims on every visit; the hold and the move refuse a time sold on another store, and the
 * buyer is told the time was just taken, to pick another, with nothing charged.
 */
import { addProduct, claimHandle, ensureStatsId, setProductCall, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import type { Product, Store } from "@/lib/store";
import { readListing, readProduct } from "@/lib/catalog";
import { bookingNotice, bookingWords } from "@/lib/buyer-words/booking";
import { type CallListing, confirmBooking, holdAndCheckout, moveBooking, releaseOwnHold, slotsForMove, slotsForProduct } from "@/lib/calls";
import type { CallSetup } from "@/lib/call-setup";
import { putMember } from "@/lib/team";
import type { TeamHost } from "@/lib/team-scheduling-rules";
import { movedKey } from "@/lib/call-records";
import { CLAIM_MARGIN_MS, claimsKey, hostId, readClaims } from "@/lib/host-claims";
import { HOLD_SECONDS } from "@/lib/stripe-account";
import { writeTeam } from "@/lib/team-booking";
import { advance, store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { weekdayAt } from "./weekday";
import { paidPeriod } from "./billing-period-fixture";

const HOUR = 3_600_000;
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
/** What `run` returns, and how many times it read Maya's claims (one HGETALL each). */
async function claimReads<T>(run: () => Promise<T>): Promise<[T, number]> {
  const real = redis.pipeline;
  let reads = 0;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    reads += commands.filter((c) => c[0] === "HGETALL" && c[1] === claimsKey(hostId(MAYA))).length;
    return real.call(redis, commands);
  }) as typeof redis.pipeline;
  try {
    return [await run(), reads];
  } finally {
    redis.pipeline = real;
  }
}
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
  // Rule 23 (owner's decision, 16 November 2026, on #3490: "ler só no checkout"): her own store's page read her claims on
  // every visit and left that hour out; it reads none now, and the hold, inside the order, reads them and refuses it.
  const [shown, pageReads] = await claimReads(() => offered(lantern.store, lantern.product, S));
  is("her own store's page reads none of her claims on a visit (the hour is shown)", [pageReads, shown], [0, true]);
  const [own, holdReads] = await claimReads(() => hold(lantern.store, lantern.product, S));
  is("a buyer of her own call cannot hold it: the hold reads her claims and refuses", [own.ok ? "held" : own.reason, holdReads > 0], ["taken", true]);
  const told = bookingNotice(bookingWords("en"), own.ok ? "held" : own.reason, [], 60);
  is("the buyer is told the time was just taken, to pick another, and that nothing was charged", [told?.title, /Pick another; nothing was charged\./.test(told?.body ?? "")], ["That time was just taken", true]);

  part("An ordinary booking in Maya's own store takes her hour");
  const T = weekdayAt(4, 660);
  const first = await hold(lantern.store, lantern.product, T);
  is("held in her own store", first.ok, true);
  // Claude 6's MEDIUM 1 (confirmed by Claude 1, 6799341330): the owner's hold claim lapsed with the hold itself, with
  // no CLAIM_MARGIN_MS, so a buyer confirmed only by the mail job left her free on other stores meanwhile.
  const heldUntil = ((await readClaims([hostId(MAYA)])).get(hostId(MAYA)) ?? []).find((c) => c.start === T)?.until ?? 0;
  is("her hold claim outlasts the hold by the team holds' margin", heldUntil >= Date.now() + HOLD_SECONDS * 1000 + CLAIM_MARGIN_MS - 60_000, true);
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
  const [moveOffer, moveReads] = await claimReads(() => slotsForMove(lantern.store, lantern.product, first.session, T, HOUR));
  is("the move page offers the next hour", Boolean(moveOffer?.days.some((d) => d.starts.includes(T2))), true);
  // Rule 23 (owner's decision, 16 November 2026, on #3490): the move page left Harbor's hour out by reading her claims on
  // every visit; it reads none now, and the move itself (below) reads them and refuses that hour.
  is("the move page reads none of her claims on a visit", moveReads, 0);
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

  // Codex V's HIGH on #3490 (V-20261117-0216-review-3490.md): the move's SET and its read-back answer in an unknown
  // shape while Redis did apply it. The move may be written, so its new time must stay protected, never given back.
  part("An unacknowledged persisted move keeps the new time protected");
  {
    const before = T;
    const after = T2;
    const booking = await hold(lantern.store, lantern.product, before);
    if (!booking.ok) throw new Error("no hold for the isolated move");
    await confirmBooking({ store: lantern.store, product: lantern.product, session: booking.session, start: before, end: before + HOUR, buyerEmail: "buyer@example.com", buyerTz: NY, due: null, cancel: null, origin: "https://marktmorgen.com" });
    listed.push(paidRow(booking.session, lantern.store, lantern.product, before, false));
    const moveKey = movedKey(booking.session);
    const pipeline = redis.pipeline;
    redis.pipeline = async (commands) => {
      const out = await pipeline.call(redis, commands);
      return commands.some((c) => (c[0] === "SET" || c[0] === "GET") && c[1] === moveKey) ? ["unknown"] : out;
    };
    try {
      const result = await moveBooking({ store: lantern.store, product: lantern.product, session: booking.session, booked: { start: before, end: before + HOUR, email: "buyer@example.com", buyerTz: NY }, start: after, origin: "https://marktmorgen.com" });
      is("the move is reported unconfirmed", result.ok ? "moved" : result.reason, "error");
      const written = JSON.parse(String(redis.run(["GET", moveKey]))) as { s: number };
      is("the authoritative move nevertheless points to the new time", written.s, after);
      is("the new time remains protected until the move can be reconciled", (await mayaClaims()).some((c) => c.start === after), true);
      is("and the old time stays protected too while the move is not known", (await mayaClaims()).some((c) => c.start === before), true);
      redis.pipeline = pipeline;
      // The same move asked again finishes it (the "same move" step): counted once, the old time let go.
      const again = await moveBooking({ store: lantern.store, product: lantern.product, session: booking.session, booked: { start: before, end: before + HOUR, email: "buyer@example.com", buyerTz: NY }, start: after, origin: "https://marktmorgen.com" });
      is("the same move asked again is done", again.ok ? "moved" : again.reason, "moved");
      is("counted once", (JSON.parse(String(redis.run(["GET", moveKey]))) as { n: number }).n, 1);
      is("its new time is kept for good", (await mayaClaims()).some((c) => c.start === after && !c.held), true);
      is("and its old time is let go", (await mayaClaims()).some((c) => c.start === before), false);
    } finally {
      redis.pipeline = pipeline;
      listed.length = 0;
    }
  }

  part("A move whose write surely did not land gives its new time back (control)");
  {
    const before = weekdayAt(4, 900);
    const after = before + HOUR;
    const booking = await hold(lantern.store, lantern.product, before);
    if (!booking.ok) throw new Error("no hold for the control move");
    await confirmBooking({ store: lantern.store, product: lantern.product, session: booking.session, start: before, end: before + HOUR, buyerEmail: "buyer@example.com", buyerTz: NY, due: null, cancel: null, origin: "https://marktmorgen.com" });
    listed.push(paidRow(booking.session, lantern.store, lantern.product, before, false));
    const moveKey = movedKey(booking.session);
    const pipeline = redis.pipeline;
    // The SET answers in another shape and does nothing; the read-back answers exactly: no key.
    redis.pipeline = async (commands) => (commands.some((c) => c[0] === "SET" && c[1] === moveKey) ? ["unknown"] : pipeline.call(redis, commands));
    try {
      const result = await moveBooking({ store: lantern.store, product: lantern.product, session: booking.session, booked: { start: before, end: before + HOUR, email: "buyer@example.com", buyerTz: NY }, start: after, origin: "https://marktmorgen.com" });
      is("the move is refused", result.ok ? "moved" : result.reason, "error");
      is("nothing was written", redis.run(["GET", moveKey]), null);
      is("its new time is given back", (await mayaClaims()).some((c) => c.start === after), false);
      is("and the old one stays", (await mayaClaims()).some((c) => c.start === before && !c.held), true);
    } finally {
      redis.pipeline = pipeline;
      listed.length = 0;
    }
  }

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
  // Rule 23 (owner's decision, 16 November 2026, on #3490): her own store's page offered nothing while her claims could
  // not be read; it does not read them on a visit now, so it is the hold that reads them and refuses.
  is("her own store's page does not read them on a visit", Boolean(await slotsForProduct(lantern.store, lantern.product)), true);
  const blind = await hold(lantern.store, lantern.product, V);
  is("and the hold holds nothing", blind.ok ? "held" : blind.reason, "error");
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

  part("A seat paid while another seat's hold is being written keeps the shared claim for good (cloud J's review of #3490, MEDIUM)");
  // confirmBooking takes no store lock: seat A's payment can land between seat B's read of the owner's claims and its
  // claim script, which wrote B's hold over A's "kept for good", so the shared claim lapsed with B's unpaid hold and
  // Harbor sold Maya's hour while seat A was paid.
  const H = weekdayAt(8, 900);
  const seatA = await hold(lanternNow, group, H);
  if (!seatA.ok) throw new Error("no seat A");
  const plain = redis.pipeline;
  let armed = true;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (armed && commands.some((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:host-claim:"))) {
      armed = false;
      await confirmBooking({ store: lanternNow, product: group, session: seatA.session, start: H, end: H + HOUR, buyerEmail: "seat-a@example.com", buyerTz: NY, due: null, cancel: null, origin: "https://marktmorgen.com" });
    }
    return plain(commands);
  }) as typeof redis.pipeline;
  let seatB: Awaited<ReturnType<typeof hold>>;
  try {
    seatB = await hold(lanternNow, group, H);
  } finally {
    redis.pipeline = plain;
  }
  is("seat A was paid while seat B's hold was written, and seat B is held", [armed, seatB.ok], [false, true]);
  is("[CORRETO] the shared claim on her is still kept for good", (await mayaClaims()).filter((c) => c.start === H), [{ start: H, held: false }]);
  const realNow = Date.now;
  const later = realNow() + HOLD_SECONDS * 1000 + CLAIM_MARGIN_MS + 60_000;
  Date.now = () => later;
  try {
    is("[CORRETO] after seat B's hold would have lapsed, Harbor still does not offer her then", await offered(harbor.store, harbor.product, H), false);
    const sold = await hold(harbor.store, harbor.product, H);
    is("[CORRETO] and a Harbor buyer cannot hold her for it", sold.ok ? "held" : sold.reason, "taken");
  } finally {
    Date.now = realNow;
  }

  // Claude 6's money review of #3490 (LOW 1): a group call whose seats were all refunded kept its shared claim on her
  // until the call was over, and her own store read it as another store's: that time was not offered there again.
  part("A group time whose every seat was refunded is offered again in her own store");
  const X = weekdayAt(9, 960);
  const only = await hold(lanternNow, group, X);
  if (!only.ok) throw new Error("no hold");
  listed.push(paidRow(only.session, lanternNow, group, X, false));
  await confirmBooking({ store: lanternNow, product: group, session: only.session, start: X, end: X + HOUR, buyerEmail: "buyer@example.com", buyerTz: NY, due: null, cancel: null, origin: "https://marktmorgen.com" });
  is("paid: the group's claim on her is kept for good", (await mayaClaims()).filter((c) => c.start === X), [{ start: X, held: false }]);
  listed.length = 0;
  listed.push(paidRow(only.session, lanternNow, group, X, true));
  is("refunded in full, no seat left: her own store offers that group time again", await offered(lanternNow, group, X), true);
  // Rule 23 (owner's decision, 16 November 2026, on #3490): her own store's page no longer reads her claims, so her other
  // call is refused that hour at the hold, which reads them, instead of left out of its page.
  const other = await hold(lanternNow, lantern.product, X);
  is("her other call still does not take that hour", other.ok ? "held" : other.reason, "taken");
  is("Harbor's team still does not offer her then (the shared claim stays, failing closed)", await offered(harbor.store, harbor.product, X), false);
  const resold = await hold(lanternNow, group, X);
  is("a new buyer holds a seat", resold.ok, true);
  is("still one claim on her for that hour", (await mayaClaims()).filter((c) => c.start === X).length, 1);
  listed.length = 0;
  // Codex L HIGH, revalidated by X4 at the current head: a durable move must never outlive its destination claim.
  part("A failed destination promotion cannot publish a move protected only by a short hold");
  {
    const before = weekdayAt(10, 660);
    const after = before + HOUR;
    const booking = await hold(lantern.store, lantern.product, before);
    if (!booking.ok) throw new Error("no hold for the promotion failure");
    await confirmBooking({ store: lantern.store, product: lantern.product, session: booking.session, start: before, end: before + HOUR, buyerEmail: "buyer@example.com", buyerTz: NY, due: null, cancel: null, origin: "https://marktmorgen.com" });
    listed.push(paidRow(booking.session, lantern.store, lantern.product, before, false));
    const moveKey = movedKey(booking.session);
    const claimKey = claimsKey(hostId(MAYA));
    const pipeline = redis.pipeline;
    let wroteMove = false;
    let permanentAtWrite = false;
    let blockedPromotions = 0;
    redis.pipeline = async (commands) => {
      if (commands.some((c) => c[0] === "HSET" && c[1] === claimKey && String(c[3]).startsWith(`${after}|${after + HOUR}|0|`))) {
        blockedPromotions += 1;
        // Neither write applies; read-back sees the original temporary claim.
        return commands.map(() => "unknown");
      }
      const writing = commands.some((c) => c[0] === "SET" && c[1] === moveKey);
      if (writing) permanentAtWrite = (await mayaClaims()).some((c) => c.start === after && !c.held);
      const result = await pipeline.call(redis, commands);
      if (writing) wroteMove = true;
      // The move SET lands, but neither its answer nor its GET read-back can confirm it.
      return commands.some((c) => (c[0] === "SET" || c[0] === "GET") && c[1] === moveKey) ? ["unknown"] : result;
    };
    try {
      const result = await moveBooking({ store: lantern.store, product: lantern.product, session: booking.session, booked: { start: before, end: before + HOUR, email: "buyer@example.com", buyerTz: NY }, start: after, origin: "https://marktmorgen.com" });
      is("promotion failure reports error", result.ok ? "moved" : result.reason, "error");
      is("both promotion attempts were exercised", blockedPromotions, 2);
      is("a move can be published only after its destination is permanent", !wroteMove || permanentAtWrite, true);
      redis.pipeline = pipeline;
      const savedNow = Date.now;
      const wait = HOLD_SECONDS * 1000 + CLAIM_MARGIN_MS + 60_000;
      const later = savedNow() + wait;
      Date.now = () => later;
      advance(wait);
      try {
        const rival = await hold(harbor.store, harbor.product, after);
        is("no authoritative moved booking competes with the other store after the hold expires", !wroteMove || !rival.ok, true);
        if (rival.ok) await releaseOwnHold(harbor.store, rival.session);
        is("the unchanged original time stays permanently protected", (await mayaClaims()).some((c) => c.start === before && !c.held), true);
      } finally {
        Date.now = savedNow;
      }
    } finally {
      redis.pipeline = pipeline;
      listed.length = 0;
    }
  }
  done();
}

void main();
