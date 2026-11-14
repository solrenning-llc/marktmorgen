/**
 * The booking page's admission, after the pre-review of claude5/public-admission-book (9 November 2026):
 *
 *   (a) the calendar embedded on a creator's listed site (app/embed/[handle]/[product]) read the open times with only
 *       the frame's one request taken; a Referer is easy to forge, so the times are paid for there as on the page;
 *   (d) a made-up ?pkg= or ?move= made a visitor a buyer: past the public share it spent the buyers' reserve (the page
 *       and its times) and asked Stripe. A buyer is now proved first, cheaply, from Redis: a package bought for this
 *       store's call, or a booking in this store's diary; anyone else is the public page;
 *   (c) a reading of the times costs fewer of the store's requests: the creator's calendars are waited on beside Stripe,
 *       not after it, and the first call listings are inside the base;
 *   light: the tab title follows the page when the times could not be paid for, and a buyer moving a booking whose
 *       times could not be paid for still sees their booking.
 *
 * Each check marked "(fact)" holds before the fix as well.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import BookPage, { generateMetadata as bookMeta } from "@/app/[handle]/book/[product]/page";
import { POST as bookRoute } from "@/app/api/store/book/route";
import { POST as moveRoute } from "@/app/api/store/book/move/route";
import EmbedCard from "@/app/embed/[handle]/[product]/page";
import { StoreResting } from "@/components/store-resting";
import { bookTimesUnits, bookingDiaryKey } from "@/lib/book-page-rules";
import { speech } from "@/lib/buyer-words";
import { bookingWords } from "@/lib/buyer-words/booking";
import { readSetup, type CallSetup } from "@/lib/call-setup";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setEmbedSites, setProductCall, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { publicVisitLimit, requestLimitFor } from "@/lib/traffic-rules";
import { takePublicRequest } from "@/lib/traffic";
import { answering } from "./security/next-headers";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

let stripe = 0;
let unitsNow = 0;
let firstAt: number | null = null;
// The window's units taken when each Stripe call was made, on the request being watched.
let atStripe: number[] = [];
let netNow = 0;
// A paid booking's checkout, as Stripe answers it for a buyer's move; anything else is an empty list.
const paidSessions = new Map<string, Record<string, unknown>>();
globalThis.fetch = (async (input: RequestInfo | URL) => {
  stripe += 1;
  if (firstAt === null) firstAt = unitsNow;
  atStripe.push(unitsNow);
  const url = String(input);
  for (const [id, session] of paidSessions) if (url.includes(`/checkout/sessions/${id}`)) return new Response(JSON.stringify(session), { status: 200 });
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
}) as typeof fetch;
process.env.STRIPE_SECRET_KEY = "sk_test_book_admission";

const NY = "America/New_York";
const WEEKDAYS: [number, number][][] = [[], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], []];
const weekly = { kind: "weekly", minutes: 30, tz: NY, weekly: WEEKDAYS, noticeHours: 1, horizonDays: 14, bufferMinutes: 0, room: "https://example.com/room", video: false, meet: null, seats: 1, sessions: [] };

type Watched = { stripe: number; units: number; net: number; firstAt: number | null; atStripe: number[]; result: unknown };

async function watch(headers: Record<string, string>, run: () => Promise<unknown>): Promise<Watched> {
  answering(new Request("https://marktmorgen.com/x", { headers }));
  const original = redis.pipeline.bind(redis);
  const before = stripe;
  unitsNow = 0;
  netNow = 0;
  firstAt = null;
  atStripe = [];
  redis.pipeline = async (cmds) => {
    for (const c of cmds) {
      if (!String(c[1]).startsWith("nl:traffic:r:")) continue;
      if (c[0] === "INCRBY") { unitsNow += Number(c[2]); netNow += Number(c[2]); }
      if (c[0] === "DECRBY") netNow -= Number(c[2]);
    }
    return original(cmds);
  };
  let result: unknown = null;
  try {
    result = await run();
    const el = result as { type?: unknown; props?: unknown } | null;
    if (el && typeof el.type === "function" && (el.type as { name?: string }).name === "MovePage") result = await (el.type as (p: unknown) => Promise<unknown>)(el.props);
  } catch {
    // redirect() or notFound(): what counts here is what was read.
  } finally {
    redis.pipeline = original;
  }
  return { stripe: stripe - before, units: unitsNow, net: netNow, firstAt, atStripe, result };
}

const resting = (result: unknown) => (result as { type?: unknown } | null)?.type === StoreResting;
const html = (result: unknown) => {
  try {
    return renderToStaticMarkup(result as never);
  } catch {
    return "";
  }
};
/** Every text in an element tree as the page returned it, its components not run (the move page holds async ones). */
const texts = (node: unknown): string[] => {
  if (typeof node === "string") return [node];
  if (Array.isArray(node)) return node.flatMap(texts);
  const props = (node as { props?: Record<string, unknown> } | null)?.props;
  return props ? Object.values(props).flatMap(texts) : [];
};

type Shop = { store: Store; call: string; owner: string };
async function shop(handle: string): Promise<Shop> {
  const owner = `${handle}@example.com`;
  await claimHandle(owner, handle, `Store ${handle}`, "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setSubscription(owner, { customerId: `cus_${handle}01`, subscriptionId: `sub_${handle}01`, active: true, tier: "creator", period: paidPeriod() });
  await setStripeAccount(owner, `acct_1Test${handle.slice(0, 10)}`, true);
  const made = await addProduct(owner, "Coaching", "", "45", null);
  if (!made.ok) throw new Error("setup");
  await setProductCall(owner, made.product.id, readSetup(weekly) as CallSetup);
  return { store: (await storeForEmail(owner)) as Store, call: made.product.id, owner };
}

/** Uses the store's window up to `used` requests, taken for everybody at once. */
async function spendWindow(store: Store, used: number): Promise<void> {
  if (used > 0) await takePublicRequest(store, "buyer", Date.now(), used, { shared: true });
}

const book = (s: Shop, query: Record<string, string>, ip: string) =>
  watch({ "x-forwarded-for": ip, "user-agent": "curl/8" }, () => BookPage({ params: Promise.resolve({ handle: `@${s.store.handle}`, product: s.call }), searchParams: Promise.resolve(query) }));

/** A package of sessions bought for this call, as lib/call-packages.ts keeps it. */
function package_(s: Shop, token: string, checkout: string): void {
  const bought = { s: s.store.statsId, h: s.store.handle, p: s.call, e: "buyer@example.com", total: 3, at: Math.floor(Date.now() / 1000), until: 0, token, holds: [] };
  redis.run(["SET", `nl:pkg:${checkout}`, JSON.stringify(bought)]);
  redis.run(["SET", `nl:pkg:t:${createHash("sha256").update(token).digest("hex")}`, checkout]);
}

/** A paid booking in the store's diary, and its checkout as Stripe answers it. */
function booking(s: Shop, session: string): void {
  const start = Date.now() + 3 * 86_400_000;
  const end = start + 30 * 60_000;
  redis.run(["HSET", `nl:call:busy:${s.store.callsId}`, session, JSON.stringify({ s: start, e: end, until: 0, session, p: s.call })]);
  paidSessions.set(session, {
    id: session, object: "checkout.session", status: "complete", payment_status: "paid", mode: "payment", created: Math.floor(Date.now() / 1000),
    amount_total: 4500, currency: "usd", customer_details: { email: "buyer@example.com", name: "Buyer" },
    metadata: { store: s.store.handle, product: s.call, kind: "call", start: String(start), end: String(end), tz: NY },
    payment_intent: { id: "pi_1TestMove", latest_charge: { id: "ch_1TestMove", refunded: false, amount_refunded: 0, disputed: false } },
  });
}

async function main(): Promise<void> {
  redis.clear();

  part("(a) The calendar embedded on the creator's listed site (a forged Referer is enough to open it)");
  const embed = await shop("admitembed");
  if (!(await setEmbedSites(embed.owner, ["https://coach.example.com"])).ok) throw new Error("embed setup");
  const framed = await watch({ "x-forwarded-for": "198.51.100.40", "user-agent": "curl/8", referer: "https://coach.example.com/page" },
    () => EmbedCard({ params: Promise.resolve({ handle: "@admitembed", product: embed.call }), searchParams: Promise.resolve({ mm: "overlay", view: "times" }) } as never));
  is("(fact) the frame asks Stripe for the times", framed.stripe >= 1, true);
  is("the frame takes the times' requests before Stripe is asked", (framed.firstAt ?? 0) >= 1 + bookTimesUnits(1), true);
  const embedRest = await shop("admitembed2");
  if (!(await setEmbedSites(embedRest.owner, ["https://coach.example.com"])).ok) throw new Error("embed setup");
  // Room for the frame itself, none for its times.
  await spendWindow(embedRest.store, publicVisitLimit(requestLimitFor(embedRest.store)) - 1);
  const short = await watch({ "x-forwarded-for": "198.51.100.41", "user-agent": "curl/8", referer: "https://coach.example.com/page" },
    () => EmbedCard({ params: Promise.resolve({ handle: "@admitembed2", product: embedRest.call }), searchParams: Promise.resolve({ mm: "overlay", view: "times" }) } as never));
  is("with no room for its times, the frame asks Stripe nothing", short.stripe, 0);
  is("and says the times could not be read", html(short.result).includes(bookingWords(embedRest.store.language).timesUnread.replace(/'/g, "&#x27;")), true);

  part("(c) What a reading of the times costs in the store's requests");
  is("a store with one call: 8 requests for its times", bookTimesUnits(1), 8);
  is("a store with twenty calls: still 8", bookTimesUnits(20), 8);

  part("Light: room for the page, not for its times");
  const tight = await shop("admittight");
  await spendWindow(tight.store, publicVisitLimit(requestLimitFor(tight.store)) - 1);
  const title = await watch({ "x-forwarded-for": "198.51.100.50", "user-agent": "curl/8" }, () => bookMeta({ params: Promise.resolve({ handle: "@admittight", product: tight.call }), searchParams: Promise.resolve({}) }));
  is("the tab says the page rests, as the page does, and names no call", (title.result as { title?: string } | null)?.title, `${speech(tight.store).w.restingTitle} — ${tight.store.name}`);
  is("(fact) no time is read for it", title.stripe, 0);

  part("(d) The public share used up, the buyers' reserve whole: made-up buyer links");
  const pub = await shop("admitpkg");
  await spendWindow(pub.store, publicVisitLimit(requestLimitFor(pub.store)));
  is("(fact) a public request is refused", await takePublicRequest(pub.store, "public", Date.now(), 1, { shared: true }), false);
  let calls = 0, most = 0, rested = 0;
  for (let i = 0; i < 20; i += 1) {
    const token = i % 2 ? `made${i}` : createHash("sha256").update(`made-up ${i}`).digest("hex").slice(0, 48);
    const r = await book(pub, { pkg: token }, `203.0.113.${i}`);
    calls += r.stripe;
    most = Math.max(most, r.units);
    if (resting(r.result)) rested += 1;
  }
  console.log(`  measured: 20 made-up packages -> ${calls} Stripe calls, at most ${most} units a load`);
  is("20 made-up packages ask Stripe nothing", calls, 0);
  is("none takes more than the public page's own refused count (nothing as a buyer)", most <= 1, true);
  is("each shows the resting page", rested, 20);
  calls = 0; most = 0; rested = 0;
  for (let i = 0; i < 20; i += 1) {
    const r = await book(pub, { move: `cs_test_${"m".repeat(20)}${i}` }, `203.0.113.${50 + i}`);
    calls += r.stripe;
    most = Math.max(most, r.units);
    if (resting(r.result)) rested += 1;
  }
  console.log(`  measured: 20 made-up moves -> ${calls} Stripe calls, at most ${most} units a load`);
  is("20 made-up moves ask Stripe nothing", calls, 0);
  is("none takes more than the public page's own refused count (nothing as a buyer)", most <= 1, true);
  is("each shows the resting page", rested, 20);

  part("(d) A real buyer is still served from the reserve");
  const TOKEN = "ab".repeat(24);
  package_(pub, TOKEN, `cs_test_${"p".repeat(24)}`);
  const pkg = await book(pub, { pkg: TOKEN }, "203.0.113.150");
  is("a package bought for this call is not the resting page", resting(pkg.result), false);
  is("its times are read, after the page and its times are counted", [pkg.stripe >= 1, (pkg.firstAt ?? 0) >= 1 + bookTimesUnits(1)], [true, true]);
  const MOVE = `cs_test_${"r".repeat(24)}`;
  booking(pub, MOVE);
  const move = await book(pub, { move: MOVE }, "203.0.113.151");
  is("a booking in this store's diary is not the resting page", resting(move.result), false);
  is("(fact) its checkout is read", move.stripe >= 1, true);

  part("Light: a buyer moving a booking, with room for the page but not for its times");
  const last = await shop("admitmove");
  const LAST = `cs_test_${"q".repeat(24)}`;
  booking(last, LAST);
  // Two requests left in the whole window: the public page's refused count, then the buyer's page; none for the times.
  await spendWindow(last.store, requestLimitFor(last.store) - 2);
  const kept = await book(last, { move: LAST }, "203.0.113.160");
  const words = bookingWords(last.store.language);
  is("the buyer still sees their booking", resting(kept.result), false);
  is("and is told the times could not be read", texts(kept.result).includes(words.timesUnread), true);

  part("Review of #3478, MEDIUM 1: the booking form's POST pays for the times it reads");
  const post = (s: Shop, route: (r: NextRequest) => Promise<Response>, path: string, fields: Record<string, string>, ip: string) =>
    watch({ "x-forwarded-for": ip, "user-agent": "curl/8" }, () => route(new NextRequest(`https://marktmorgen.test${path}`, {
      method: "POST",
      headers: { host: "marktmorgen.test", origin: "https://marktmorgen.test", "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": ip },
      body: new URLSearchParams({ handle: s.store.handle, product: s.call, ...fields }).toString(),
    })));
  const START = String(Date.now() + 3 * 86_400_000);
  const form = await shop("admitpost");
  const opened = await post(form, bookRoute, "/api/store/book", { start: START, tz: NY }, "198.51.100.70");
  is("with the window open, a booking takes its times' requests and its own before it reads", opened.units >= bookTimesUnits(1) + 2, true);
  is("none of them before Stripe is asked", opened.atStripe.every((units) => units >= bookTimesUnits(1) + 2), true);
  await spendWindow(form.store, publicVisitLimit(requestLimitFor(form.store)));
  let posted = 0, held = 0;
  for (let i = 0; i < 10; i += 1) {
    const r = await post(form, bookRoute, "/api/store/book", { start: START, tz: NY }, `203.0.113.${100 + i}`);
    posted += r.stripe;
    held += Math.max(0, r.net - 1);
  }
  console.log(`  measured: 10 bookings with the public share used up -> ${posted} Stripe calls`);
  is("with the public share used up, 10 bookings from 10 addresses ask Stripe nothing", posted, 0);
  is("and keep nothing of the buyers' reserve beyond a refused request each", held, 0);
  const forged = await post(form, bookRoute, "/api/store/book", { start: START, tz: NY, pkg: "cd".repeat(24) }, "203.0.113.120");
  is("a made-up package does not book from the buyers' reserve", forged.stripe, 0);

  part("Review of #3478, MEDIUM 1: moving a booking pays for the times it reads, and only a booking in the diary is read");
  const mover = await shop("admitmovepost");
  let made = 0;
  for (let i = 0; i < 10; i += 1) made += (await post(mover, moveRoute, "/api/store/book/move", { session: `cs_test_${"z".repeat(20)}${i}`, start: START }, `203.0.113.${130 + i}`)).stripe;
  is("10 made-up sessions ask Stripe nothing", made, 0);
  const REAL = `cs_test_${"y".repeat(24)}`;
  booking(mover, REAL);
  const real = await post(mover, moveRoute, "/api/store/book/move", { session: REAL, start: START }, "203.0.113.150");
  is("(fact) a booking in the diary is read from Stripe", real.stripe >= 1, true);
  is("its times are paid for before they are read (the times' units after the order's read)", real.units >= 1 + bookTimesUnits(1) && (real.atStripe[1] ?? Infinity) >= 1 + bookTimesUnits(1), true);

  part("Review of #3478, LOW 2: a made-up ?move= with the window open asks Stripe nothing");
  const page = await shop("admitmovepage");
  let asked = 0;
  for (let i = 0; i < 10; i += 1) asked += (await book(page, { move: `cs_test_${"x".repeat(20)}${i}` }, `198.51.100.${80 + i}`)).stripe;
  is("10 made-up moves ask Stripe nothing", asked, 0);

  part("The buyer's proof reads lib/calls.ts's own diary");
  is("the diary key is lib/calls.ts's busyKey", readFileSync("lib/calls.ts", "utf8").includes("const busyKey = (callsId: string) => `nl:call:busy:${callsId}`;") && bookingDiaryKey("abc") === "nl:call:busy:abc", true);

  part("(e) The help says what a call's booking times count");
  is("the help names the booking times' requests", /booking times/.test(readFileSync("lib/help-content.ts", "utf8")), true);
  is("and what booking a time and moving a booking count", /Booking a time[^`]*moving a booking/.test(readFileSync("lib/help-content.ts", "utf8")), true);
  done();
}
main().catch((e) => { console.error(e); process.exit(1); });
