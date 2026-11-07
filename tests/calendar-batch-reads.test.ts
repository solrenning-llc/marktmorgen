/**
 * The booking calendar's making reads its call listings and its bookings'
 * rooms with MGETs in chunks, not one GET a key (cost review, option O5):
 * Upstash bills every command of a pipeline, and an MGET of many keys is one.
 *
 * Measured through the feed's own route, with a store at MAX_PRODUCTS call
 * listings (none on the record's first page, so every one is read) and
 * CALENDAR_CALLS bookings, each at its own time in a product that makes video
 * rooms (so every booking's four room reads and its room's making are sent).
 * And an MGET reply that is not whole, or holds anything but text or nothing,
 * fails the making as an unknown: never a listing or a room taken for absent.
 */
import { createHash } from "node:crypto";
import { GET as feedRoute } from "@/app/api/store/calendar/[token]/route";
import { newFeedToken } from "@/lib/calendar-sync";
import { MAX_PRODUCTS } from "@/lib/catalog-rules";
import { KIND } from "@/lib/catalog";
import { CALENDAR_BUILD_SHAPE, CALENDAR_CALLS, CALENDAR_POLL_SHAPE, calendarBuildCommands } from "@/lib/read-ceilings";
import { claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "batched@example.com";
const CATALOG = "a".repeat(32);
const CALLS_ID = "b".repeat(32);
const LISTING_KEY = /^nl:catalog:[0-9a-f]{32}:l:/;
const ROOM_KEY = /^nl:call:room:/;

/** Booked calls the stand-in for Stripe lists. */
let callSessions: unknown[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const data = String(input).includes("/checkout/sessions") ? callSessions : [];
  return new Response(JSON.stringify({ object: "list", data, has_more: false }));
}) as typeof fetch;

type Batch = (string | number)[][];
/** What the database is sent while `work` runs: every command, and each command's name. */
async function counted<T>(work: () => Promise<T>, alter?: (batch: Batch, replies: unknown[]) => unknown[]) {
  const real = redis.pipeline;
  const sent: Batch = [];
  redis.pipeline = async (batch: Batch) => {
    sent.push(...batch);
    const replies = await real(batch);
    return alter ? alter(batch, replies) : replies;
  };
  try {
    return { value: await work(), sent };
  } finally {
    redis.pipeline = real;
  }
}

const WEEK = [[], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], []];
const productId = (i: number) => `call${String(i).padStart(5, "0")}`;
const listing = (i: number) => ({
  id: productId(i), title: `Call ${i}`, priceCents: 5000, createdAt: "2026-11-01T00:00:00.000Z",
  call: { kind: "weekly", minutes: 30, tz: "UTC", weekly: WEEK, noticeHours: 1, horizonDays: 30, bufferMinutes: 0, room: null, video: true, meet: null, seats: 1, sessions: [] },
});

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_batched_only_a_stand_in";
  await claimHandle(OWNER, "batched", "Batched Calls", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestBatched001", true);
  await setSubscription(OWNER, { customerId: "cus_Batched0001", subscriptionId: "sub_Batched0001", active: true, tier: "pro", period: paidPeriod() });
  // MAX_PRODUCTS call listings, kept in their own records (none on the first page), and the store's calls id.
  const ownerKey = `nl:store:owner:${createHash("sha256").update(`nimbus-store:${OWNER.toLowerCase()}`).digest("hex").slice(0, 40)}`;
  const record = JSON.parse(String(redis.run(["GET", ownerKey])));
  const items = Array.from({ length: MAX_PRODUCTS }, (_, i) => [productId(i), KIND.call | KIND.paid]);
  redis.run(["SET", ownerKey, JSON.stringify({ ...record, callsId: CALLS_ID, catalog: { id: CATALOG, items, head: [] } })]);
  for (let i = 0; i < MAX_PRODUCTS; i += 1) redis.run(["SET", `nl:catalog:${CATALOG}:l:${productId(i)}`, JSON.stringify(listing(i))]);
  const store = (await storeForEmail(OWNER))!;
  is("the stand-in store has every call listing and its calls id", [store.catalog.items.length, store.callsId], [MAX_PRODUCTS, CALLS_ID]);
  const url = (await newFeedToken(store)).subscribeUrl ?? "";
  const token = url.slice(url.lastIndexOf("/") + 1);
  const ask = () => feedRoute(new Request(url), { params: Promise.resolve({ token }) });
  // CALENDAR_CALLS bookings, each at its own time, each in a product that makes rooms: every room read and made.
  const hour = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  callSessions = Array.from({ length: CALENDAR_CALLS }, (_, i) => ({
    id: `cs_test_batched${String(i).padStart(6, "0")}`, object: "checkout.session", status: "complete", payment_status: "paid", mode: "payment",
    created: Math.floor(Date.now() / 1000) - 3_600, amount_total: 5000, currency: "usd", customer_details: { email: `b${i}@example.com`, name: `B ${i}` },
    metadata: { store: store.handle, kind: "call", product: productId(i % MAX_PRODUCTS), start: String(hour + (i + 24) * 3_600_000), end: String(hour + (i + 24) * 3_600_000 + 1_800_000) },
    payment_intent: { id: `pi_${i}`, status: "succeeded", latest_charge: { refunded: false, amount_refunded: 0 } },
  }));
  const fresh = () => {
    redis.run(["DEL", `nl:cal:out:${store.statsId}`, `nl:cal:pace:${store.statsId}`]);
    for (const suffix of ["", ":a", ":r", ":c"]) redis.run(["DEL", `nl:cal:builds:${store.statsId}:${new Date().toISOString().slice(0, 10)}${suffix}`]);
  };

  part("A store at MAX_PRODUCTS call listings and CALENDAR_CALLS bookings makes its file in a few MGETs");
  {
    fresh();
    const made = await counted(ask);
    const file = await made.value.text();
    is("the file is made, every booking in it with its room", [made.value.status, file.split("BEGIN:VEVENT").length - 1, (file.match(/LOCATION:https:\/\/meet\.jit\.si\//g) ?? []).length], [200, CALENDAR_CALLS, CALENDAR_CALLS]);
    const gets = made.sent.filter((c) => c[0] === "GET" && (LISTING_KEY.test(String(c[1])) || ROOM_KEY.test(String(c[1]))));
    const makingGets = made.sent.filter((c) => c[0] === "SET" && ROOM_KEY.test(String(c[1]))).length;
    // The rooms' making (SET NX and GET, a booking each) stays as it was: its GETs are the only room GETs left.
    is("no listing or room is read with a GET of its own, besides the rooms' making (SET NX and GET)", [gets.filter((c) => LISTING_KEY.test(String(c[1]))).length, gets.length, makingGets], [0, CALENDAR_CALLS, CALENDAR_CALLS]);
    const mgets = made.sent.filter((c) => c[0] === "MGET");
    const listingMgets = mgets.filter((c) => LISTING_KEY.test(String(c[1])));
    const roomMgets = mgets.filter((c) => ROOM_KEY.test(String(c[1])));
    is("the listings in 40 MGETs of at most 50, the rooms in 5 of at most 400 keys", [listingMgets.length, Math.max(...listingMgets.map((c) => c.length - 1)), roomMgets.length, Math.max(...roomMgets.map((c) => c.length - 1))], [40, 50, 5, 400]);
    const commands = made.sent.length;
    is(`measured (${commands}) within the answer and the making as priced (${CALENDAR_POLL_SHAPE.commands} + ${calendarBuildCommands(MAX_PRODUCTS, CALENDAR_CALLS)})`, commands <= CALENDAR_POLL_SHAPE.commands + calendarBuildCommands(MAX_PRODUCTS, CALENDAR_CALLS), true);
    is("the making's shape at its worst: 1,081 commands (5,531 when every listing and every room read was a GET)", CALENDAR_BUILD_SHAPE.commands, 1_081);
    is(`and the measured making is within that figure (${commands} <= ${CALENDAR_POLL_SHAPE.commands} + 1,081)`, commands <= CALENDAR_POLL_SHAPE.commands + 1_081, true);
  }

  /** A making whose listing or room reads are answered wrong: refused, nothing kept, never a file without them. */
  const broken = async (what: RegExp, how: "short" | "number") => {
    fresh();
    const answer = await counted(ask, (batch, replies) =>
      batch.map((command, i) => {
        const reply = replies[i];
        if (batch.some((c) => c[0] === "SET")) return reply;
        if (command[0] === "MGET" && what.test(String(command[1])) && Array.isArray(reply)) return how === "short" ? reply.slice(0, -1) : [42, ...reply.slice(1)];
        if (command[0] === "GET" && what.test(String(command[1]))) return 42;
        return reply;
      }),
    );
    const text = await answer.value.text();
    return [answer.value.status, text.includes("BEGIN:VCALENDAR"), redis.run(["GET", `nl:cal:out:${store.statsId}`])];
  };
  part("An MGET reply that is not whole, or holds anything but text or nothing, fails the making as an unknown");
  is("listings: a reply one short fails the making (503), nothing kept", await broken(LISTING_KEY, "short"), [503, false, null]);
  is("listings: a number among the replies fails the making, nothing kept", await broken(LISTING_KEY, "number"), [503, false, null]);
  is("rooms: a reply one short fails the making, nothing kept", await broken(ROOM_KEY, "short"), [503, false, null]);
  is("rooms: a number among the replies fails the making, nothing kept", await broken(ROOM_KEY, "number"), [503, false, null]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
