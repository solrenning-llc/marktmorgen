/**
 * "What buyers say" is kept only on the store whose reviews it quotes (lib/store-quotes.ts keepStoreQuotes; Claude 2
 * lpgvy on #5092, coordinator's decision 26d3).
 *
 * keepQuotes reads and writes the record under the owner's address (lib/store.ts withStore), not the store: a refresh
 * that read a store before it was closed (a review route's after(), the refund sweep, a person's erasure) and runs
 * after the owner opened a new store at the same address put the closed store's buyers' chosen names and words on the
 * new store's page, and when its read failed, its fallback took the new store's own quotes off. Now the list is kept
 * only on the same store (the same sid, or for a store from before ids the same statsId, as lib/store.ts withLiveStore
 * reads it); another store at the address is left as it is, and the call answers done, since the store it read is no longer there.
 *
 * Real code over the in-memory Redis; synthetic records only.
 */
import { addProduct, claimHandle, closeStoreRecord, ensureListId, ensureStatsId, ensureStoreId, setQuotes, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { saveReview } from "@/lib/reviews";
import { keepStoreQuotes, refreshStoreQuotes } from "@/lib/store-quotes";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
/** When set, a read of this statsId's reviews fails, as a Redis outage would. */
let failReviewsOf: string | null = null;
redis.pipeline = (async (commands: Command[]) => {
  if (failReviewsOf && commands.some((command) => command.some((part) => String(part).startsWith("nl:rev:") && String(part).includes(failReviewsOf as string)))) {
    throw new Error("Redis request failed with status 503 (synthetic)");
  }
  return real(commands);
}) as typeof redis.pipeline;

const DAY = 86_400_000;
const GONE_WORDS = "Clear steps and a friendly tone, the bread came out right.";
const NEW_WORDS = "The new course is short and easy to follow from the start.";

/** A store at `owner` with one product and one buyer's review with words; its quotes kept. */
async function storeWithReview(owner: string, handle: string, buyer: string, name: string, words: string): Promise<Store> {
  is(`synthetic store ${handle}`, (await claimHandle(owner, handle, "Quotes", "")).ok, true);
  await ensureStoreId(owner);
  await ensureStatsId(owner);
  await ensureListId(owner);
  const now = Math.floor(Date.now() / 1000);
  await setSubscription(owner, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true, tier: "pro", period: { start: now - 10 * 86_400, end: now + 20 * 86_400, renews: true } });
  const added = await addProduct(owner, "Bread Book", "", "19", null);
  if (!added.ok) throw new Error("no product");
  const statsId = (await storeForEmail(owner))!.statsId!;
  const saved = await saveReview(statsId, { productId: added.product.id, email: buyer, reference: `cs_test_${handle}01`, pi: `pi_${handle}01`, rating: 5, text: words, name }, ROOM, Date.now() - DAY);
  if (saved.state !== "created") throw new Error("review not written");
  await refreshStoreQuotes((await storeForEmail(owner))!);
  return (await storeForEmail(owner))!;
}

const names = async (owner: string) => ((await storeForEmail(owner))?.quotes ?? []).map((quote) => quote.n);
const resolves = async (run: () => Promise<unknown>) => run().then(() => true, () => false);

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_quotes_same_store_stand_in";
  globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

  part("A refresh of a closed store never puts its buyers on the owner's new store");
  {
    redis.clear();
    const owner = "quotes-same@example.com";
    const closed = await storeWithReview(owner, "quotesold", "gone-buyer@example.test", "Gone Buyer", GONE_WORDS);
    is("control: the closed store quoted its buyer", closed.quotes.map((quote) => quote.n), ["Gone Buyer"]);
    is("the store is closed", await closeStoreRecord(closed), true);
    const fresh = await storeWithReview(owner, "quotesnew", "new-buyer@example.test", "New Buyer", NEW_WORDS);
    is("control: the new store quotes its own buyer", await names(owner), ["New Buyer"]);
    is("control: the new store is another store at the same address", [fresh.sid !== closed.sid, fresh.statsId !== closed.statsId], [true, true]);

    await refreshStoreQuotes(closed);
    is("the closed store's late refresh leaves the new store's quotes as they are", await names(owner), ["New Buyer"]);
    is("no quote carries the closed store's buyer's words", ((await storeForEmail(owner))!.quotes).some((quote) => quote.t.includes("bread came out")), false);

    failReviewsOf = closed.statsId;
    is("its refresh whose read fails resolves", await resolves(() => refreshStoreQuotes(closed)), true);
    failReviewsOf = null;
    is("and never takes the new store's own quotes off", await names(owner), ["New Buyer"]);

    is("a caller that must know it worked (a person's erasure) is answered done: the store it read is no longer at this address", await resolves(() => keepStoreQuotes(closed)), true);
    is("and the new store's quotes stay", await names(owner), ["New Buyer"]);

    await refreshStoreQuotes(fresh);
    is("control: the new store's own refresh still keeps its quotes", await names(owner), ["New Buyer"]);
  }

  part("Control: a copy read before the store had an id is the same store by its statsId; another statsId is not");
  {
    redis.clear();
    const owner = "quotes-legacy@example.com";
    const store = await storeWithReview(owner, "quoteslegacy", "legacy-buyer@example.test", "Legacy Buyer", GONE_WORDS);
    // The copy a caller read before the store was given an id (ensureStoreId): no sid, the same statsId.
    const before: Store = { ...store, sid: "" };
    await setQuotes(owner, []);
    await refreshStoreQuotes(before);
    is("that copy's refresh keeps the store's quotes (same statsId)", await names(owner), ["Legacy Buyer"]);
    await refreshStoreQuotes({ ...before, statsId: "f".repeat(32) });
    is("a copy with no sid and another statsId leaves this store's quotes as they are", await names(owner), ["Legacy Buyer"]);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
