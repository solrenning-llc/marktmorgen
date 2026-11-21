/**
 * Audit R51, review of #3393 (synthetic, no real provider): "What buyers say" on the store page (lib/store-quotes.ts)
 * is kept on the store's own record, with each quoted buyer's chosen name and words.
 *
 * What fails here:
 *   - a person's own erasure (erasePerson, kind "person") deletes their reviews but leaves the store's quotes made from
 *     them, and answers ok; and when those quotes cannot be taken off, it still answers ok and deletes the reviews,
 *     so a retry has nothing left to find them by;
 *   - a refresh started before a hide writes the list it read after the hide took the words off;
 *   - dropReviewQuote deciding from the store as the request read it, not from the record as it is now;
 *   - a refresh that keeps a person's review again while their erasure is under way, left on the record after it.
 * Controls: the other buyer's quote stays; a store's team deleting a person keeps their reviews and so their quotes;
 * dropReviewQuote writes nothing when the record quotes none of the review.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setQuotes, setSubscription, storeForEmail } from "@/lib/store";
import { reviewId, saveReview, setHidden, summaryOf } from "@/lib/reviews";
import { dropReviewQuote, refreshStoreQuotes } from "@/lib/store-quotes";
import { erasePerson } from "@/lib/person-erasure";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

type Command = (string | number)[];
const STORE_KEY = "nl:store:owner:";
const real = redis.pipeline.bind(redis);

/** Hooks on the requests sent, each cleared once it has run. */
const hook: {
  /** The next store record write fails, from the first read of `armedBy`'s review on. */
  failStoreWritesAfter?: string;
  failing?: boolean;
  /** The next read of the reviews a list names is held, once answered, until `release`; `paused` is called then. */
  holdList?: { paused: () => void; release: Promise<void> };
  /** Runs before the deletion of review `id` is sent. */
  beforeDelete?: { id: string; run: () => Promise<void> };
  /** Counts store record writes. */
  writes: number;
} = { writes: 0 };

const writesStore = (commands: Command[]) => commands.some(([name, ...args]) => name !== "GET" && name !== "GETRANGE" && args.some((arg) => String(arg).startsWith(STORE_KEY)));

redis.pipeline = (async (commands: Command[]) => {
  if (hook.failStoreWritesAfter && commands.length && commands.every(([name, , field]) => name === "HGET" && field === hook.failStoreWritesAfter)) {
    hook.failStoreWritesAfter = undefined;
    hook.failing = true;
  }
  if (writesStore(commands)) {
    hook.writes += 1;
    if (hook.failing) throw new Error("Redis request failed with status 503 (synthetic)");
  }
  const before = hook.beforeDelete;
  if (before && commands[0]?.[0] === "HDEL" && commands[0][2] === before.id) {
    hook.beforeDelete = undefined;
    await before.run();
  }
  const replies = await real(commands);
  const hold = hook.holdList;
  if (hold && commands.length && commands.every(([name, key]) => name === "HMGET" && String(key).startsWith("nl:rev:"))) {
    hook.holdList = undefined;
    hold.paused();
    await hold.release;
  }
  return replies;
}) as typeof redis.pipeline;

const DAY = 86_400_000;
const PHONE = "Call me on 555 0100 any time, the book is great.";
const OTHER = "r51e-other@example.test";
const ERASED = "r51e-erased@example.test";

async function world(owner: string, handle: string) {
  redis.clear();
  hook.failStoreWritesAfter = undefined;
  hook.failing = false;
  hook.holdList = undefined;
  hook.beforeDelete = undefined;
  await claimHandle(owner, handle, "R51 Erasure", "");
  await ensureStoreId(owner);
  await ensureStatsId(owner);
  await ensureListId(owner);
  const now = Math.floor(Date.now() / 1000);
  await setSubscription(owner, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true, tier: "pro", period: { start: now - 10 * 86_400, end: now + 20 * 86_400, renews: true } });
  const added = await addProduct(owner, "Bread Book", "", "19", null);
  if (!added.ok) throw new Error("no product");
  const productId = added.product.id;
  const statsId = (await storeForEmail(owner))!.statsId!;
  const base = Date.now() - 5 * DAY;
  const a = await saveReview(statsId, { productId, email: OTHER, reference: "cs_test_R51EOther01", pi: "pi_R51EOther01", rating: 4, text: "Clear steps and a friendly tone all the way through.", name: "Other Reader" }, ROOM, base);
  const b = await saveReview(statsId, { productId, email: ERASED, reference: "cs_test_R51EErased1", pi: "pi_R51EErased1", rating: 5, text: PHONE, name: "Erased Person" }, ROOM, base + DAY);
  if (a.state !== "created" || b.state !== "created") throw new Error("reviews not written");
  await refreshStoreQuotes((await storeForEmail(owner))!);
  return { statsId, productId, other: a.review, erased: b.review, erasedId: reviewId(statsId, productId, ERASED) };
}

const quotes = async (owner: string) => (await storeForEmail(owner))!.quotes;
const names = async (owner: string) => (await quotes(owner)).map((q) => q.n);
const hasPhone = async (owner: string) => (await quotes(owner)).some((q) => q.t.includes("555 0100"));

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_r51_erasure_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_r51_erasure_only_a_stand_in";
  globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

  part("A person's own erasure takes their quotes off the store's record");
  {
    const owner = "r51e-person@example.com";
    const w = await world(owner, "r51eperson");
    is("control: both buyers quoted before", await names(owner), ["Erased Person", "Other Reader"]);
    const erased = await erasePerson((await storeForEmail(owner))!, ERASED, { kind: "person" });
    is("the erasure says done", erased.ok, true);
    is("control: their review left the average", (await summaryOf(w.statsId, w.productId)).count, 1);
    is("no quote carries their chosen name", (await names(owner)).includes("Erased Person"), false);
    is("no quote carries their words", await hasPhone(owner), false);
    is("the other buyer's quote stays", await names(owner), ["Other Reader"]);
  }

  part("Control: a store's team deleting a person keeps their review, and its quote");
  {
    const owner = "r51e-team@example.com";
    await world(owner, "r51eteam");
    const erased = await erasePerson((await storeForEmail(owner))!, ERASED, { kind: "team", who: owner, role: "owner" });
    is("the erasure says done", erased.ok, true);
    is("both quotes stay", await names(owner), ["Erased Person", "Other Reader"]);
  }

  part("Quotes that cannot be taken off: the erasure is not done, the review is kept for the retry");
  {
    const owner = "r51e-fail@example.com";
    const w = await world(owner, "r51efail");
    hook.failStoreWritesAfter = w.erasedId;
    const first = await erasePerson((await storeForEmail(owner))!, ERASED, { kind: "person" });
    hook.failing = false;
    is("the first pass is not done, and names the reviews' part", [first.ok, !first.ok && first.reason === "incomplete" && first.failed.includes("lib/reviews.ts")], [false, true]);
    is("the review is kept, so the retry finds it", (await summaryOf(w.statsId, w.productId)).count, 2);
    const again = await erasePerson((await storeForEmail(owner))!, ERASED, { kind: "person" });
    is("the retry is done", again.ok, true);
    is("after it, no quote carries their name or words", [(await names(owner)).includes("Erased Person"), await hasPhone(owner)], [false, false]);
    is("and their review is gone", (await summaryOf(w.statsId, w.productId)).count, 1);
  }

  part("A refresh that keeps their review again while the erasure runs is not left on the record");
  {
    const owner = "r51e-race@example.com";
    const w = await world(owner, "r51erace");
    hook.beforeDelete = { id: w.erasedId, run: async () => refreshStoreQuotes((await storeForEmail(owner))!) };
    const erased = await erasePerson((await storeForEmail(owner))!, ERASED, { kind: "person" });
    is("the refresh ran during the erasure", hook.beforeDelete, undefined);
    is("the erasure says done", erased.ok, true);
    is("no quote carries their name or words", [(await names(owner)).includes("Erased Person"), await hasPhone(owner)], [false, false]);
  }

  part("A refresh that read the reviews before a hide never writes the hidden words after it");
  {
    const owner = "r51e-stale@example.com";
    const w = await world(owner, "r51estale");
    let paused!: () => void;
    const isPaused = new Promise<void>((resolve) => (paused = resolve));
    let release!: () => void;
    // A new review's refresh (its after()), started before the hide, reads the list and is held there.
    const fresh = await saveReview(w.statsId, { productId: w.productId, email: "r51e-new@example.test", reference: "cs_test_R51ENew001", pi: "pi_R51ENew001", rating: 5, text: "The seeded loaf is now a weekly thing at our house.", name: "New Reader" }, ROOM);
    if (fresh.state !== "created") throw new Error("no new review");
    hook.holdList = { paused: () => paused(), release: new Promise<void>((resolve) => (release = resolve)) };
    const stale = refreshStoreQuotes((await storeForEmail(owner))!);
    await isPaused;
    const hidden = await setHidden(w.statsId, w.productId, w.erased.id, true, "private");
    if (typeof hidden !== "object" || !hidden) throw new Error("not hidden");
    // The hide takes its words off, then its own refresh runs; the held one is let go a moment later.
    const hide = (async () => {
      await dropReviewQuote((await storeForEmail(owner))!, hidden);
      await refreshStoreQuotes((await storeForEmail(owner))!);
    })();
    setTimeout(release, 60);
    await Promise.all([stale, hide]);
    is("the hidden words are not on the record", await hasPhone(owner), false);
    is("the new and the other buyer's quotes stay, newest first", await names(owner), ["New Reader", "Other Reader"]);
  }

  part("dropReviewQuote reads the record as it is now, not as the request read it");
  {
    const owner = "r51e-snap@example.com";
    const w = await world(owner, "r51esnap");
    await setQuotes(owner, []);
    // The request read the store while nothing was quoted; the review was quoted again since.
    const snapshot = (await storeForEmail(owner))!;
    await refreshStoreQuotes(snapshot);
    is("control: quoted again since the request read the store", await hasPhone(owner), true);
    const hidden = await setHidden(w.statsId, w.productId, w.erased.id, true, "private");
    if (typeof hidden !== "object" || !hidden) throw new Error("not hidden");
    await dropReviewQuote(snapshot, hidden);
    is("its words are off the record before the hide answers", await hasPhone(owner), false);
  }
  {
    const owner = "r51e-none@example.com";
    const w = await world(owner, "r51enone");
    hook.writes = 0;
    await dropReviewQuote((await storeForEmail(owner))!, { productId: w.productId, createdAt: Date.now() + DAY });
    is("control: nothing of it quoted, nothing written", hook.writes, 0);
    is("control: the quotes are as they were", await names(owner), ["Erased Person", "Other Reader"]);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
