/**
 * One MGET's reply, as the REST answer's JSON, stays within 1 MiB at the most a value under its keys can be written
 * at, not at the bytes a reading is priced at (review of #3079, Codex Z M1, applied to the shared readers of #3545,
 * 11 November 2026). A product record is written up to MAX_PRODUCT_BYTES (lib/catalog.ts, with its extras), and its
 * JSON text can double when the answer escapes it (a string of quote characters), so a lot of product records is sized
 * from that; a meeting record (lib/meet-records.ts, writeRecord) has no byte cap where it is written, so no lot can
 * bound its reply and none is read in an MGET. Each lot is its own trip, and the trips go a few at a time, never a
 * thousand together. Synthetic stores only.
 */
import { MAX_PRODUCT_BYTES, readListings, readProducts } from "@/lib/catalog";
import { roomsFor } from "@/lib/call-rooms";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const MIB = 1_048_576;
const CATALOG = "cat-reply-bound";
const LISTING = /^nl:catalog:cat-reply-bound:l:/;
const RECORD = /^nl:meet:r:/;
const ROOM = /^nl:call:room:/;
const idOf = (i: number) => `p${String(i).padStart(9, "0")}`;
const listing = (id: string, pad = 0) => ({ id, title: `Synthetic ${id}`, summary: "", priceCents: 1000, createdAt: 0, ...(pad ? { padding: '"'.repeat(pad) } : {}) });
const storeOf = (count: number): Store =>
  ({ catalog: { id: CATALOG, items: Array.from({ length: count }, (_, i) => ({ id: idOf(i), kind: 0, options: [] })), head: [], inline: null } }) as unknown as Store;

type Batch = (string | number)[][];
const real = redis.pipeline.bind(redis);

/** Every trip `work` sends, with its REST answer's JSON weight and the weight of each MGET's own reply in it. */
async function watched<T>(work: () => Promise<T>): Promise<{ value: T; trips: { batch: Batch; bytes: number; mgets: number[] }[]; most: number }> {
  const trips: { batch: Batch; bytes: number; mgets: number[] }[] = [];
  let inFlight = 0;
  let most = 0;
  redis.pipeline = (async (batch: Batch) => {
    inFlight += 1;
    most = Math.max(most, inFlight);
    try {
      // A turn of the event loop, so trips sent side by side are seen in flight together.
      await new Promise((resolve) => setImmediate(resolve));
      const replies = await real(batch);
      const mgets = batch.flatMap((c, i) => (c[0] === "MGET" ? [Buffer.byteLength(JSON.stringify({ result: replies[i] }))] : []));
      trips.push({ batch, bytes: Buffer.byteLength(JSON.stringify(replies.map((result) => ({ result })))), mgets });
      return replies;
    } finally {
      inFlight -= 1;
    }
  }) as typeof redis.pipeline;
  try {
    return { value: await work(), trips, most };
  } finally {
    redis.pipeline = real as typeof redis.pipeline;
  }
}

async function main(): Promise<void> {
  redis.clear();
  const N = 2_000;
  // Valid product records padded with quote characters: each written under MAX_PRODUCT_BYTES, far over the 16,384
  // bytes a listing is priced at, and escaped again in the answer.
  const PAD = 100_000;
  const heavy = JSON.stringify(listing(idOf(0), PAD));
  const all: Batch = Array.from({ length: N }, (_, i) => ["SET", `nl:catalog:${CATALOG}:l:${idOf(i)}`, JSON.stringify(listing(idOf(i), i < 300 ? PAD : 0))]);
  for (let i = 0; i < all.length; i += 500) await real(all.slice(i, i + 500));
  const store = storeOf(N);

  part("A store's product records, at their written ceiling: each trip's answer within 1 MiB");
  is("each planted record is under MAX_PRODUCT_BYTES and over the priced 16,384", [Buffer.byteLength(heavy) <= MAX_PRODUCT_BYTES, Buffer.byteLength(heavy) > 16_384], [true, true]);
  for (const [name, read] of [["readListings", () => readListings(store)], ["readProducts", () => readProducts(store)]] as const) {
    const seen = await watched(read as () => Promise<unknown[]>);
    const listingTrips = seen.trips.filter((t) => t.batch.some((c) => c[0] === "MGET" && c.slice(1).some((k) => LISTING.test(String(k)))));
    const largest = Math.max(0, ...listingTrips.map((t) => t.bytes));
    is(`${name}: every product comes back (${seen.value.length})`, seen.value.length, N);
    is(`${name}: every trip reading product records answers within 1 MiB (largest ${largest} bytes)`, listingTrips.length > 0 && largest <= MIB, true);
    is(`${name}: every MGET's own reply within 1 MiB`, listingTrips.every((t) => t.mgets.every((b) => b <= MIB)), true);
    is(`${name}: the trips go a few at a time (seen ${seen.most} in flight), not ${listingTrips.length} together`, seen.most <= 16, true);
  }

  part("A booking's room: the meeting records, which no byte cap bounds, are never read in an MGET");
  {
    const setup = { kind: "weekly", minutes: 30, tz: "UTC", weekly: [], noticeHours: 1, horizonDays: 30, bufferMinutes: 0, room: "", video: true, meet: null, inPerson: false, place: null, seats: 1, sessions: [] } as never;
    const start = Date.UTC(2034, 0, 2, 10);
    const asks = Array.from({ length: 60 }, (_, i) => ({ product: "pv", setup, session: `cs_test_bound${String(i).padStart(4, "0")}`, start: start + i * 3_600_000, end: start + i * 3_600_000 + 1_800_000 }));
    const seen = await watched(() => roomsFor("q".repeat(32), asks));
    const mgets = seen.trips.flatMap((t) => t.batch.filter((c) => c[0] === "MGET"));
    is("every booking gets its room", seen.value.every((r) => typeof r === "string" && r.startsWith("https://meet.jit.si/")), true);
    is("no MGET carries a meeting record's key", mgets.some((c) => c.slice(1).some((k) => RECORD.test(String(k)))), false);
    is("every room MGET carries only room keys, whose worst reply (keys x 2 x a room's 44 bytes) is within 1 MiB", [mgets.length > 0, mgets.every((c) => c.slice(1).every((k) => ROOM.test(String(k))) && (c.length - 1) * 2 * 44 <= MIB)], [true, true]);
  }
}

main().then(done, (error) => {
  console.error(error);
  process.exit(1);
});
