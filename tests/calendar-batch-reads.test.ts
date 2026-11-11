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
import { KIND, LISTINGS_PER_MGET, MAX_PRODUCT_BYTES, readListings } from "@/lib/catalog";
import { ROOM_KEYS_PER_MGET, ROOM_NAME_LENGTH, VIDEO_ROOM_BASE, roomsFor } from "@/lib/call-rooms";
import { MGET_CONCURRENCY } from "@/lib/redis-mget";
import { CALENDAR_BUILD_SHAPE, CALENDAR_CALLS, CALENDAR_POLL_SHAPE, LISTING_READ_BYTES, calendarBuildCommands } from "@/lib/read-ceilings";
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
    is("the listings in 1,000 MGETs of at most 2, the rooms in 3 of at most 400 keys", [listingMgets.length, Math.max(...listingMgets.map((c) => c.length - 1)), roomMgets.length, Math.max(...roomMgets.map((c) => c.length - 1))], [1_000, 2, 3, 400]);
    const recordGets = made.sent.filter((c) => c[0] === "GET" && /^nl:meet:r:/.test(String(c[1]))).length;
    is("each booking's two meeting records read with a GET each (no byte cap where they are written)", recordGets, 2 * CALENDAR_CALLS);
    const commands = made.sent.length;
    is(`measured (${commands}) within the answer and the making as priced (${CALENDAR_POLL_SHAPE.commands} + ${calendarBuildCommands(MAX_PRODUCTS, CALENDAR_CALLS)})`, commands <= CALENDAR_POLL_SHAPE.commands + calendarBuildCommands(MAX_PRODUCTS, CALENDAR_CALLS), true);
    is("the making's shape at its worst: 3,039 commands (5,531 when every listing and every room read was a GET)", CALENDAR_BUILD_SHAPE.commands, 3_039);
    is(`and the measured making is within that figure (${commands} <= ${CALENDAR_POLL_SHAPE.commands} + 3,039)`, commands <= CALENDAR_POLL_SHAPE.commands + 3_039, true);
  }

  part("The listing MGETs are sent a few at a time, never all at once (MGET_CONCURRENCY)");
  {
    fresh();
    // Each trip to the database waits a turn of the event loop, so trips sent side by side are seen in flight together.
    const real = redis.pipeline;
    let inFlight = 0;
    let most = 0;
    redis.pipeline = async (batch: Batch) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      try {
        await new Promise((resolve) => setImmediate(resolve));
        return await real(batch);
      } finally {
        inFlight -= 1;
      }
    };
    try {
      const answer = await ask();
      is("the file is still made", answer.status, 200);
    } finally {
      redis.pipeline = real;
    }
    is(`at most MGET_CONCURRENCY (${MGET_CONCURRENCY}) trips to the database at once (seen: ${most}), not the 1,000 listing MGETs together`, most <= MGET_CONCURRENCY, true);
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

  part("One MGET's reply fits 1 MiB at the most a record can be written, not at the bytes it is priced at (review: Codex Z, reply size)");
  {
    // A listing record is written up to MAX_PRODUCT_BYTES (lib/catalog.ts, with its extras), and its JSON text can double
    // when the REST answer escapes it (a string of quote characters): an MGET's worst reply is its keys × 2 × that.
    is("LISTINGS_PER_MGET × 2 × MAX_PRODUCT_BYTES within 1 MiB", [LISTINGS_PER_MGET * 2 * MAX_PRODUCT_BYTES <= 1_048_576, LISTINGS_PER_MGET >= 1], [true, true]);
    // Real records over LISTING_READ_BYTES in one chunk: 50 call listings, each a valid listing padded with quote
    // characters (kept by JSON.stringify as \" , escaped again in the answer), far over 16,384 bytes.
    const big = (i: number) => JSON.stringify({ ...listing(i), padding: '"'.repeat(25_000) });
    const heavy = Array.from({ length: 50 }, (_, i) => i);
    for (const i of heavy) redis.run(["SET", `nl:catalog:${CATALOG}:l:${productId(i)}`, big(i)]);
    is("each planted record is a valid listing over LISTING_READ_BYTES, under MAX_PRODUCT_BYTES", [Buffer.byteLength(big(0)) > LISTING_READ_BYTES, Buffer.byteLength(big(0)) <= MAX_PRODUCT_BYTES, (await readListings(store, [productId(0)]))[0]?.id], [true, true, productId(0)]);
    fresh();
    const replyBytes: number[] = [];
    const made = await counted(ask, (batch, replies) => {
      if (batch.length === 1 && batch[0][0] === "MGET" && LISTING_KEY.test(String(batch[0][1]))) {
        replyBytes.push(Buffer.byteLength(JSON.stringify(replies.map((result) => ({ result })))));
      }
      return replies;
    });
    const file = await made.value.text();
    is("the file is still made, every booking in it", [made.value.status, file.split("BEGIN:VEVENT").length - 1], [200, CALENDAR_CALLS]);
    is(`every listing MGET's reply, as the REST answer's JSON, within 1 MiB (largest ${Math.max(...replyBytes)} bytes)`, replyBytes.length > 0 && replyBytes.every((n) => n <= 1_048_576), true);
    const mgets = made.sent.filter((c) => c[0] === "MGET");
    // A meeting record (lib/meet-records.ts) has no byte cap where it is written (writeRecord): up to MAX_GUESTS guests'
    // and added addresses, whose length the code does not bound. No chunk can bound its reply, so none is in an MGET.
    is("no MGET carries a meeting record's key", mgets.some((c) => c.slice(1).some((k) => /^nl:meet:r:/.test(String(k)))), false);
    const roomValue = VIDEO_ROOM_BASE.length + ROOM_NAME_LENGTH;
    const roomMgets = mgets.filter((c) => ROOM_KEY.test(String(c[1])));
    is("every room MGET carries only room keys, whose worst reply (keys × 2 × a room's address) is within 1 MiB", [roomMgets.length > 0, roomMgets.every((c) => c.slice(1).every((k) => ROOM_KEY.test(String(k))) && (c.length - 1) * 2 * roomValue <= 1_048_576)], [true, true]);
    for (const i of heavy) redis.run(["SET", `nl:catalog:${CATALOG}:l:${productId(i)}`, JSON.stringify(listing(i))]);
  }

  /**
   * A making whose batched reply holds, for the first key matching `what`, a value that is there but is not what was
   * asked for: refused as an unknown, nothing kept, never a file with that listing or that room taken for absent.
   */
  const planted = async (what: RegExp, value: string) => {
    fresh();
    let placed = false;
    const answer = await counted(ask, (batch, replies) => {
      if (batch.some((c) => c[0] === "SET")) return replies;
      return batch.map((command, i) => {
        const reply = replies[i];
        if (placed) return reply;
        if (command[0] === "MGET" && Array.isArray(reply)) {
          const at = command.slice(1).findIndex((k) => what.test(String(k)));
          if (at < 0) return reply;
          placed = true;
          return reply.map((v, j) => (j === at ? value : v));
        }
        if (command[0] === "GET" && what.test(String(command[1]))) {
          placed = true;
          return value;
        }
        return reply;
      });
    });
    const text = await answer.value.text();
    return [placed, answer.value.status, text.includes("BEGIN:VCALENDAR"), redis.run(["GET", `nl:cal:out:${store.statsId}`]) === null];
  };
  part("A batched value that is there but is not the record asked for fails the making as an unknown (review: Codex Z, fail closed)");
  is("listings: text that is not JSON fails the making (503), nothing kept", await planted(LISTING_KEY, "not json"), [true, 503, false, true]);
  is("listings: {} fails the making, nothing kept", await planted(LISTING_KEY, "{}"), [true, 503, false, true]);
  is("listings: empty text fails the making, nothing kept", await planted(LISTING_KEY, ""), [true, 503, false, true]);
  is("listings: another product's record under this key fails the making, nothing kept", await planted(LISTING_KEY, JSON.stringify(listing(1))), [true, 503, false, true]);
  is("rooms: a booking's room key holding an address no room here has fails the making, nothing kept", await planted(/^nl:call:room:[0-9a-f]{32}:b:/, "https://example.com/not-a-room"), [true, 503, false, true]);
  is("meeting records: text that is not JSON fails the making, nothing kept", await planted(/^nl:meet:r:/, "not json"), [true, 503, false, true]);
  is("meeting records: {} fails the making, nothing kept", await planted(/^nl:meet:r:/, "{}"), [true, 503, false, true]);
  const otherScope = { provider: "google", scope: `c:${CALLS_ID}:b:cs_test_someone_else`, link: "https://meet.google.com/abc-defg-hij" };
  is("meeting records: another booking's record under this key fails the making, nothing kept", await planted(/^nl:meet:r:/, JSON.stringify(otherScope)), [true, 503, false, true]);

  {
    // And the record that is its key's own is read, its link given: the check refuses only what is not.
    fresh();
    let placed = false;
    const own = await counted(ask, (batch, replies) =>
      batch.map((command, i) => {
        if (placed || command[0] !== "GET" || !/^nl:meet:r:c:/.test(String(command[1])) || batch.some((c) => c[0] === "SET")) return replies[i];
        placed = true;
        return JSON.stringify({ provider: "google", scope: String(command[1]).slice("nl:meet:r:".length), link: "https://meet.google.com/abc-defg-hij" });
      }),
    );
    const text = await own.value.text();
    is("meeting records: a booking's own record is read and its link given", [placed, own.value.status, text.includes("meet.google.com/abc-defg-hij")], [true, 200, true]);
  }

  part("Each reply stays within 1 MiB at the bytes it is priced at; every reader shares the same MGET reader (one reader, #3545)");
  is(`${LISTINGS_PER_MGET} listings at LISTING_READ_BYTES, ${ROOM_KEYS_PER_MGET} room keys at 1,024 bytes: each MGET's reply within 1 MiB`, [LISTINGS_PER_MGET * LISTING_READ_BYTES <= 1_048_576, ROOM_KEYS_PER_MGET * 1_024 <= 1_048_576], [true, true]);
  {
    const ids = [productId(0), productId(1), productId(2)];
    const plain = await counted(() => readListings(store, ids));
    const rooms = await counted(() => roomsFor(CALLS_ID, [{ product: productId(0), setup: listing(0).call as never, session: "cs_test_other", start: hour + 3_600_000, end: hour + 5_400_000 }]));
    // The making has no reader of its own (lib/catalog.ts, getMany; lib/call-rooms.ts, roomsFor): every other reader
    // reads product records LISTINGS_PER_MGET at one MGET and a booking's room keys in an MGET, its meeting records a
    // GET each, as the making does.
    const roomCommands = rooms.sent.filter((c) => ROOM_KEY.test(String(c[1])) || /^nl:meet:r:/.test(String(c[1])));
    is(
      "readListings and roomsFor, for every other reader, read as the making does",
      [plain.value.length, plain.sent.map((c) => [c[0], c.length - 1]), roomCommands.slice(0, 3).map((c) => [c[0], c.length - 1])],
      [3, [["MGET", LISTINGS_PER_MGET], ["MGET", 3 - LISTINGS_PER_MGET]], [["MGET", 2], ["GET", 1], ["GET", 1]]],
    );
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
