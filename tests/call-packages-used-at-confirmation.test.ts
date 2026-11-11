/**
 * A package's session is written down as spent by its confirmation itself, never only by a later reading
 * (Claude 4 and Claude 6 on #3487, CX-C2 confirming): before, a hold read for sure as never confirmed was written
 * down as "left unpaid" only when a reading happened to fall between a week and ~428 days after it ended, and only
 * for the first 20 such holds, so on a package with no time limit:
 *
 *   - a checkout left unpaid and never read in that window counted as a used session once its mark could have
 *     expired (Claude 4's MEDIUM 1, residual);
 *   - the 21st checkout left unpaid did too (Claude 6's MEDIUM on FREED_MAX);
 *   - an answer to the token's EXISTS that was not exactly 1 deleted the whole record of how holds ended (Claude 4's
 *     MEDIUM 2).
 *
 * Now confirmBooking, and moveBooking for a move made before the confirmation, write the session down with its
 * package before they write its mark, and throw when they cannot tell, so a mark is never there without it. Past
 * the time a mark could have expired, a hold that is not written down was never confirmed.
 */
import { addProduct, claimHandle, ensureStatsId, setCallPackage, setProductCall, setStripeAccount, setSubscription, storeForEmail, type Listing, type Store } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { holdSession, packageState, readBought, recordPackage } from "@/lib/call-packages";
import { CONFIRMED_SECONDS, confirmBooking, moveBooking, type CallListing } from "@/lib/calls";
import { zonedToUtc } from "@/lib/call-setup";
import type { CallSetup } from "@/lib/call-setup";
import { createHash } from "node:crypto";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") return new Response(JSON.stringify({ id: "e" }));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  // The store's completed checkouts, read by a move (readBusy): none on Stripe in this test.
  if (method === "GET" && path === "/checkout/sessions") return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
  if (path.startsWith("/checkout/sessions/")) {
    const id = decodeURIComponent(path.slice("/checkout/sessions/".length));
    return new Response(JSON.stringify({ id, status: "complete", payment_status: "paid", payment_intent: { latest_charge: { refunded: false, amount: 50000, amount_refunded: 0 } } }));
  }
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${method} ${path}` } }), { status: 404 });
}) as typeof fetch;

const weekly = {
  kind: "weekly", minutes: 60, tz: "America/New_York", weekly: [[], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], []],
  noticeHours: 12, horizonDays: 30, bufferMinutes: 0, room: "https://example.com/room", video: false, meet: null, seats: 1, sessions: [],
} as unknown as CallSetup;
const DAY = 86_400;
const realNow = Date.now;
const checkoutId = (tag: string) => `cs_test_${tag}${"q".repeat(24 - tag.length)}`;
const sessionId = (tag: string, i: number) => `cs_test_${tag}${i}${"x".repeat(20)}`;
const nowSeconds = () => Math.floor(Date.now() / 1000);
const markOf = (session: string) => `nl:call:confirmed:${session}`;

async function setUp(): Promise<{ store: Store; product: Listing }> {
  redis.clear();
  Date.now = realNow;
  redis.now = () => Date.now();
  process.env.STRIPE_SECRET_KEY = "sk_test_packages_only";
  process.env.RESEND_API_KEY = "re_test_packages_only";
  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await setStripeAccount("owner@example.com", "acct_1TestHarbor0001", true);
  await setSubscription("owner@example.com", { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const call = await addProduct("owner@example.com", "Coaching Call", "", "120", null);
  if (!call.ok) throw new Error("no product");
  await setProductCall("owner@example.com", call.product.id, weekly);
  const store = (await storeForEmail("owner@example.com"))!;
  if (!store.callsId) throw new Error("no diary");
  return { store, product: (await readListing(store, call.product.id))! };
}

async function buy(store: Store, product: Listing, checkout: string) {
  is("a package with no time limit is offered", (await setCallPackage("owner@example.com", product.id, { sessions: 3, priceCents: 30000, days: 0 })).ok, true);
  const listing = (await readListing(store, product.id))!;
  const session = { id: checkout, status: "complete", payment_status: "paid", created: nowSeconds(), amount_total: 30000, currency: "usd", metadata: { store: "harbor", product: listing.id, kind: "package", sessions: "3", days: "0" }, customer_details: { email: "dana@example.com" } };
  const bought = await recordPackage({ store, session, product: listing, base: "https://marktmorgen.com/@harbor", from: "hello@marktmorgen.com" });
  if (!bought) throw new Error("not recorded");
  return bought;
}

/** The real confirmation of a session from a package (lib/calls.ts), as the thanks page, catchUpBookings and the mail job call it. */
async function confirmFromPackage(store: Store, product: Listing, pkg: string, session: string): Promise<"confirmed" | "threw"> {
  const start = Date.now() + 2 * DAY * 1000;
  try {
    await confirmBooking({
      store, product: product as CallListing, session, start, end: start + 3_600_000, buyerEmail: "dana@example.com",
      buyerTz: "America/New_York", amountCents: 0, due: null, cancel: null, origin: "https://marktmorgen.com", fromPackage: pkg,
    } as Parameters<typeof confirmBooking>[0]);
    return "confirmed";
  } catch {
    return "threw";
  }
}

/** Both clocks, the app's and Redis's, moved together. */
function moveBothClocks(seconds: number): void {
  const at = Date.now() + seconds * 1000;
  Date.now = () => at;
  redis.now = () => Date.now();
}

/** A weekday at `minute` past midnight in New York, at least `days` from now. */
function weekdayAt(days: number, minute: number): number {
  for (let d = days; d < days + 8; d += 1) {
    const day = new Date(Date.now() + d * DAY * 1000);
    const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(day);
    const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
    if (get("weekday") === "Sat" || get("weekday") === "Sun") continue;
    return zonedToUtc(Number(get("year")), Number(get("month")), Number(get("day")), minute, "America/New_York") as number;
  }
  throw new Error("no weekday");
}

const left = async (checkout: string) => (await packageState((await readBought(checkout))!)).left;

async function main(): Promise<void> {
  part("Claude 4's residual: a checkout left unpaid, read only in its first days, then nothing for 434 days");
  {
    const { store, product } = await setUp();
    const PAID = checkoutId("a");
    await buy(store, product, PAID);
    await holdSession(store, PAID, sessionId("a", 0), nowSeconds() - 3_600);
    is("the paid session is confirmed", await confirmFromPackage(store, product, PAID, sessionId("a", 0)), "confirmed");
    await holdSession(store, PAID, sessionId("a", 1), nowSeconds() - 3_600);
    is("day 0: one used, two left", await left(PAID), 2);
    moveBothClocks(3 * DAY);
    is("day 3: two left", await left(PAID), 2);
    moveBothClocks(431 * DAY);
    is("the marks are gone", redis.run(["EXISTS", markOf(sessionId("a", 0))]), 0);
    is("day 434: still two left (the unpaid checkout never used a session)", await left(PAID), 2);
  }

  part("A confirmed session never read before its mark expires stays spent");
  {
    const { store, product } = await setUp();
    const PAID = checkoutId("b");
    await buy(store, product, PAID);
    for (let i = 0; i < 3; i += 1) {
      await holdSession(store, PAID, sessionId("b", i), nowSeconds() - 3_600);
      is(`session ${i} confirmed`, await confirmFromPackage(store, product, PAID, sessionId("b", i)), "confirmed");
    }
    moveBothClocks(434 * DAY);
    is("the marks are gone", redis.run(["EXISTS", markOf(sessionId("b", 2))]), 0);
    is("nothing left: the three paid sessions stay used", await left(PAID), 0);
  }

  part("Claude 6's cap: 21 checkouts left unpaid on a 3-session package");
  {
    const { store, product } = await setUp();
    const PAID = checkoutId("c");
    await buy(store, product, PAID);
    for (let i = 0; i < 21; i += 1) await holdSession(store, PAID, sessionId(`c${String.fromCharCode(97 + i)}`, i % 10), nowSeconds() - 3_600);
    moveBothClocks(8 * DAY);
    is("day 8: all three left", await left(PAID), 3);
    moveBothClocks(100 * DAY);
    is("day 108: all three left", await left(PAID), 3);
    moveBothClocks(330 * DAY);
    is("day 438: still all three left (nothing was ever used)", await left(PAID), 3);
  }

  part("Claude 4's MEDIUM 2: an EXISTS answer that is not exactly 0 keeps what was written down");
  {
    const { store, product } = await setUp();
    const PAID = checkoutId("d");
    const bought = await buy(store, product, PAID);
    await holdSession(store, PAID, sessionId("d", 0), nowSeconds() - 3_600);
    await holdSession(store, PAID, sessionId("d", 1), nowSeconds() - 3_600);
    // Confirmed by a mark alone (a session confirmed before the confirmation wrote it down): a reading writes it down.
    redis.run(["SET", markOf(sessionId("d", 0)), "1", "NX", "EX", CONFIRMED_SECONDS]);
    const pipeline = redis.pipeline.bind(redis);
    redis.pipeline = (async (commands: (string | number)[][]) => {
      const answers = await pipeline(commands);
      const last = commands[commands.length - 1];
      return commands[0][0] === "SADD" && last[0] === "EXISTS" ? answers.map((a, i) => (i === answers.length - 1 ? "1" : a)) : answers;
    }) as typeof redis.pipeline;
    try {
      is("one used, two left", await left(PAID), 2);
    } finally {
      redis.pipeline = pipeline;
    }
    is("the record of how its holds ended is kept", Number(redis.run(["SCARD", `nl:pkg:t:${createHash("sha256").update(bought.token).digest("hex")}:used`])) >= 1, true);
    moveBothClocks(441 * DAY);
    is("day 441: the used session stays used, the unpaid one free", await left(PAID), 2);
  }

  part("Rule 24: the confirmation cannot tell whether the package is there, so it writes no mark and throws");
  {
    const { store, product } = await setUp();
    const PAID = checkoutId("e");
    await buy(store, product, PAID);
    await holdSession(store, PAID, sessionId("e", 0), nowSeconds() - 3_600);
    const pipeline = redis.pipeline.bind(redis);
    redis.pipeline = (async (commands: (string | number)[][]) => {
      const answers = await pipeline(commands);
      return answers.map((a, i) => (commands[i][0] === "GET" && commands[i][1] === `nl:pkg:${PAID}` ? 7 : a));
    }) as typeof redis.pipeline;
    try {
      is("the confirmation throws, to be tried again", await confirmFromPackage(store, product, PAID, sessionId("e", 0)), "threw");
    } finally {
      redis.pipeline = pipeline;
    }
    is("and no mark was written without the package's record", redis.run(["EXISTS", markOf(sessionId("e", 0))]), 0);
    is("tried again, it confirms", await confirmFromPackage(store, product, PAID, sessionId("e", 0)), "confirmed");
    moveBothClocks(434 * DAY);
    is("and the session stays used after its mark expires", await left(PAID), 2);
  }

  // Codex C2 (6781681699) and Claude 4 (6785022039) on #3487: writeUsed took any number in SADD's place, and any array,
  // as "written down", so the mark went on with no paid session in the package's record.
  for (const [label, answer] of [["SADD answers -1", [-1, 1]], ["one reply only", [1]]] as [string, unknown[]][]) {
    part(`The package's write answered in another shape (${label}): no mark, tried again`);
    const { store, product } = await setUp();
    const PAID = checkoutId(label.startsWith("SADD") ? "s" : "o");
    await buy(store, product, PAID);
    const session = sessionId(label.startsWith("SADD") ? "s" : "o", 0);
    await holdSession(store, PAID, session, nowSeconds() - 3_600);
    const pipeline = redis.pipeline.bind(redis);
    let bent = false;
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (!bent && commands[0]?.[0] === "SADD" && String(commands[0][1]).endsWith(":used")) {
        bent = true;
        return answer as never;
      }
      return pipeline(commands);
    }) as typeof redis.pipeline;
    try {
      is(`${label}: the confirmation throws, to be tried again`, await confirmFromPackage(store, product, PAID, session), "threw");
    } finally {
      redis.pipeline = pipeline;
    }
    is(`${label}: and wrote no mark`, redis.run(["EXISTS", markOf(session)]), 0);
    is(`${label}: tried again, it confirms`, await confirmFromPackage(store, product, PAID, session), "confirmed");
    moveBothClocks(434 * DAY);
    is(`${label}: and the session stays used after its mark expires`, await left(PAID), 2);
  }

  part("A move made before the confirmation writes the session's mark: it writes the session down with its package first");
  {
    const { store, product } = await setUp();
    const PAID = checkoutId("m");
    await buy(store, product, PAID);
    const session = sessionId("m", 0);
    await holdSession(store, PAID, session, nowSeconds() - 3_600);
    const start = weekdayAt(5, 600);
    const moved = await moveBooking({
      store, product: product as CallListing, session, booked: { start, end: start + 3_600_000, email: "dana@example.com", buyerTz: "America/New_York" },
      start: start + 3 * 3_600_000, origin: "https://marktmorgen.com", fromPackage: PAID,
    } as Parameters<typeof moveBooking>[0]);
    is("the move is made", moved.ok, true);
    is("and wrote the session's mark", redis.run(["EXISTS", markOf(session)]), 1);
    moveBothClocks(434 * DAY);
    is("the mark is gone", redis.run(["EXISTS", markOf(session)]), 0);
    is("the moved session stays used", await left(PAID), 2);
  }

  Date.now = realNow;
  done();
}

void main();
