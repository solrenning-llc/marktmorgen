/**
 * A package's spent sessions are kept as long as the package (Claude 6, R40, MEDIUM): a package of calls with
 * "No time limit" (days 0) is kept with no expiry, but its spent sessions were counted only by
 * nl:call:confirmed:<session>, which expires 430 days after confirmation (CONFIRMED_SECONDS). Once those marks
 * expired, every session already used counted as unused again and could be booked for free.
 *
 *   - a confirmed session stays spent when its call's mark is gone, on Redis's clock alone and on both clocks
 *     with nothing read in between;
 *   - a session whose time ran out unpaid still comes back, while its mark could still be there, and for good once
 *     a reading has been sure it was never confirmed (Claude 6 on #3487);
 *   - an answer that is neither 1 nor 0 about a mark is not known, so the session stays spent (rule 24);
 *   - the record of spent sessions never expires before its package, and is among the package's keys a closing
 *     store deletes.
 */
import { addProduct, claimHandle, ensureStatsId, setCallPackage, setProductCall, setStripeAccount, setSubscription, storeForEmail, type Listing, type Store } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { holdSession, packageKeys, packageState, prepareSession, readBought, recordPackage } from "@/lib/call-packages";
import { CONFIRMED_SECONDS } from "@/lib/calls";
import type { CallSetup } from "@/lib/call-setup";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") return new Response(JSON.stringify({ id: "e" }));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  if (method === "POST" && path === "/coupons") return new Response(JSON.stringify({ id: "co_Session1" }));
  if (path.startsWith("/checkout/sessions/")) {
    const id = decodeURIComponent(path.slice("/checkout/sessions/".length));
    return new Response(JSON.stringify({ id, status: "complete", payment_status: "paid", payment_intent: { latest_charge: { refunded: false, amount: 50000, amount_refunded: 0 } } }));
  }
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${method} ${path}` } }), { status: 404 });
}) as typeof fetch;

const weekly = {
  kind: "weekly", minutes: 60, tz: "America/New_York", weekly: [[], [[540, 1020]], [], [], [], [], []],
  noticeHours: 12, horizonDays: 30, bufferMinutes: 0, room: "https://example.com/room", video: false, meet: null, seats: 1, sessions: [],
} as unknown as CallSetup;
const DAY = 86_400;
const realNow = Date.now;
const checkoutId = (tag: string) => `cs_test_${tag}${"q".repeat(24 - tag.length)}`;
const sessionId = (tag: string, i: number) => `cs_test_${tag}${i}${"x".repeat(20)}`;
/** confirmBooking's own write: SET confirmedKey NX EX CONFIRMED_SECONDS (lib/calls.ts). */
const confirm = (session: string) => redis.run(["SET", `nl:call:confirmed:${session}`, "1", "NX", "EX", CONFIRMED_SECONDS]);
const nowSeconds = () => Math.floor(Date.now() / 1000);

async function setUp(): Promise<{ store: Store; product: Listing }> {
  redis.clear();
  Date.now = realNow;
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
  return { store, product: (await readListing(store, call.product.id))! };
}

async function buy(store: Store, product: Listing, checkout: string, days: number) {
  is(`a package of ${days || "no"} days is offered`, (await setCallPackage("owner@example.com", product.id, { sessions: 3, priceCents: 30000, days })).ok, true);
  const listing = (await readListing(store, product.id))!;
  const session = { id: checkout, status: "complete", payment_status: "paid", created: nowSeconds(), amount_total: 30000, currency: "usd", metadata: { store: "harbor", product: listing.id, kind: "package", sessions: "3", days: String(days) }, customer_details: { email: "dana@example.com" } };
  const bought = await recordPackage({ store, session, product: listing, base: "https://marktmorgen.com/@harbor", from: "hello@marktmorgen.com" });
  if (!bought) throw new Error("not recorded");
  return bought;
}

/** Both clocks, the app's and Redis's, moved together. */
function moveBothClocks(seconds: number): void {
  const at = Date.now() + seconds * 1000;
  Date.now = () => at;
  redis.now = () => Date.now();
}

async function main(): Promise<void> {
  part("No time limit: the marks expire on Redis's clock, after the package was read once");
  {
    const { store, product } = await setUp();
    const PAID = checkoutId("a");
    const bought = await buy(store, product, PAID, 0);
    const past = nowSeconds() - 3_600;
    for (let i = 0; i < 3; i += 1) {
      await holdSession(store, PAID, sessionId("a", i), past);
      confirm(sessionId("a", i));
    }
    is("nothing left today", (await packageState((await readBought(PAID))!)).left, 0);
    is("the package record has no expiry (days 0)", redis.run(["TTL", `nl:pkg:${PAID}`]), -1);
    redis.advance(431 * 86_400_000);
    is("the package is still there", (await readBought(PAID)) !== null, true);
    is("sessions used stay used", (await packageState((await readBought(PAID))!)).left, 0);
    const again = await prepareSession(store, bought.token, "https://marktmorgen.com");
    is("a new free session is refused", again.ok ? "prepared" : again.reason, "used");
  }

  part("No time limit: both clocks move 431 days and nothing read the package after its last call was confirmed");
  {
    const { store, product } = await setUp();
    const PAID = checkoutId("b");
    const bought = await buy(store, product, PAID, 0);
    const past = nowSeconds() - 3_600;
    for (let i = 0; i < 3; i += 1) await holdSession(store, PAID, sessionId("b", i), past);
    // Confirmed only after the last hold was taken, and never read again.
    for (let i = 0; i < 3; i += 1) confirm(sessionId("b", i));
    moveBothClocks(431 * DAY);
    is("the confirmation marks are gone", redis.run(["EXISTS", `nl:call:confirmed:${sessionId("b", 0)}`]), 0);
    is("sessions used stay used, on both clocks", (await packageState((await readBought(PAID))!)).left, 0);
    const again = await prepareSession(store, bought.token, "https://marktmorgen.com");
    is("no free session after 431 days", again.ok ? "prepared" : again.reason, "used");
  }

  part("A hold that ran out unpaid still comes back while its mark could be there");
  {
    const { store, product } = await setUp();
    const PAID = checkoutId("c");
    await buy(store, product, PAID, 0);
    await holdSession(store, PAID, sessionId("c", 0), nowSeconds() - 3_600);
    confirm(sessionId("c", 0));
    await holdSession(store, PAID, sessionId("c", 1), nowSeconds() - 3_600);
    is("one used, one left unpaid: two left", (await packageState((await readBought(PAID))!)).left, 2);
    moveBothClocks(200 * DAY);
    is("200 days on: still two left", (await packageState((await readBought(PAID))!)).left, 2);
    moveBothClocks(231 * DAY);
    is("431 days on, read with certainty before: the unpaid hold is still free", (await packageState((await readBought(PAID))!)).left, 2);
  }

  part("A hold left unpaid, read for sure only within its first days, then confirmed late: spent");
  {
    const { store, product } = await setUp();
    const PAID = checkoutId("f");
    await buy(store, product, PAID, 0);
    await holdSession(store, PAID, sessionId("f", 0), nowSeconds() - 3_600);
    moveBothClocks(10 * DAY);
    is("ten days on, never confirmed: three left", (await packageState((await readBought(PAID))!)).left, 3);
    confirm(sessionId("f", 0));
    is("confirmed after all: two left", (await packageState((await readBought(PAID))!)).left, 2);
    moveBothClocks(431 * DAY);
    is("and still two left once its mark is gone", (await packageState((await readBought(PAID))!)).left, 2);
  }

  part("A reading at the moment a closing store deletes the package leaves nothing behind for good");
  {
    const { store, product } = await setUp();
    const PAID = checkoutId("g");
    const bought = await buy(store, product, PAID, 0);
    await holdSession(store, PAID, sessionId("g", 0), nowSeconds() - 3_600);
    confirm(sessionId("g", 0));
    const record = (await readBought(PAID))!;
    // The closing store deletes the package's keys between the reading and what it writes down.
    for (const key of packageKeys(PAID, bought.token)) redis.run(["DEL", key]);
    await packageState(record);
    is("no key of the package is left without an expiry", redis.keys().filter((key) => key.startsWith("nl:pkg:") && !key.startsWith("nl:pkg:s:") && Number(redis.run(["TTL", key])) === -1), []);
  }

  part("An answer about a mark that is neither 1 nor 0 is not known: the session stays spent");
  {
    const { store, product } = await setUp();
    const PAID = checkoutId("d");
    const bought = await buy(store, product, PAID, 0);
    for (let i = 0; i < 3; i += 1) {
      await holdSession(store, PAID, sessionId("d", i), nowSeconds() - 3_600);
      confirm(sessionId("d", i));
    }
    const pipeline = redis.pipeline.bind(redis);
    redis.pipeline = (async (commands: (string | number)[][]) => {
      const answers = await pipeline(commands);
      return answers.map((answer, i) => (commands[i][0] === "EXISTS" && String(commands[i][1]).startsWith("nl:call:confirmed:") ? "garbled" : answer));
    }) as typeof redis.pipeline;
    try {
      is("a garbled answer leaves nothing free", (await packageState((await readBought(PAID))!)).left, 0);
      const again = await prepareSession(store, bought.token, "https://marktmorgen.com");
      is("and books nothing free", again.ok ? "prepared" : again.reason, "used");
    } finally {
      redis.pipeline = pipeline;
    }
  }

  part("A package with a last day: what it spent is kept as long as the package, and deleted with it");
  {
    const { store, product } = await setUp();
    const PAID = checkoutId("e");
    const bought = await buy(store, product, PAID, 30);
    for (let i = 0; i < 3; i += 1) {
      await holdSession(store, PAID, sessionId("e", i), nowSeconds() - 3_600);
      confirm(sessionId("e", i));
    }
    is("nothing left", (await packageState((await readBought(PAID))!)).left, 0);
    const record = Number(redis.run(["TTL", `nl:pkg:${PAID}`]));
    const own = packageKeys(PAID, bought.token);
    const kept = redis.keys().filter((key) => key.startsWith("nl:pkg:") && !key.startsWith("nl:pkg:s:"));
    is("every key the package keeps is among the keys a closing store deletes", kept.filter((key) => !own.includes(key)), []);
    const spentKeys = kept.filter((key) => key !== `nl:pkg:${PAID}` && !key.endsWith(":lock") && redis.run(["TYPE", key]) === "set");
    is("its spent sessions are kept in a record of their own", spentKeys.length, 1);
    is("which never expires before the package", spentKeys.every((key) => Number(redis.run(["TTL", key])) >= record - 5), true);
    is("and is small: one short member a session", spentKeys.every((key) => (redis.run(["SMEMBERS", key]) as string[]).every((m) => m.length <= 16)), true);
  }

  Date.now = realNow;
  done();
}

void main();
