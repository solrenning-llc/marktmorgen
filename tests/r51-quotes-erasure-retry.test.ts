/**
 * Audit R51, second review of #3393 (synthetic, no real provider): a person's own erasure (erasePerson, kind
 * "person") and the store page's quotes (lib/store-quotes.ts), when the erasure is retried.
 *
 * What fails here:
 *   - a first run that deleted the review but could not keep the quotes answers incomplete, and the retry, which no
 *     longer finds the review, answers ok while the quote is still on the record;
 *   - a first run that deleted one of two reviews, with a refresh that kept both just before, and then failed on the
 *     second: the retry answers ok while the first one's quote is still on the record;
 *   - the erasure leaves off the newer quote of another buyer of the same product.
 * Controls: the other buyers' quotes stay; an erasure of someone with no review leaves the quotes as they were.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { reviewId, saveReview, summaryOf } from "@/lib/reviews";
import { refreshStoreQuotes } from "@/lib/store-quotes";
import { erasePerson } from "@/lib/person-erasure";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

type Command = (string | number)[];
const STORE_KEY = "nl:store:owner:";
const real = redis.pipeline.bind(redis);

/** Hooks on the requests sent, each cleared once it has run. */
const hook: {
  /** Runs before the deletion of review `id` is sent. */
  beforeDelete?: { id: string; run: () => Promise<void> };
  /** The deletion of review `id` fails, as an unavailable Redis would. */
  failDelete?: string;
  /** Every store record write fails while set. */
  failing?: boolean;
} = {};

const writesStore = (commands: Command[]) => commands.some(([name, ...args]) => name !== "GET" && name !== "GETRANGE" && args.some((arg) => String(arg).startsWith(STORE_KEY)));
// The review's own delete (nl:rev:<stats>:<product>), not the delete of its photo count (nl:rev:<stats>:<product>:photos),
// which names the same id and goes first since #2863.
const deletes = (commands: Command[], id: string) => commands[0]?.[0] === "HDEL" && commands[0][2] === id && !String(commands[0][1]).endsWith(":photos");

redis.pipeline = (async (commands: Command[]) => {
  if (hook.failing && writesStore(commands)) throw new Error("Redis request failed with status 503 (synthetic)");
  const before = hook.beforeDelete;
  if (before && deletes(commands, before.id)) {
    hook.beforeDelete = undefined;
    await before.run();
  }
  if (hook.failDelete && deletes(commands, hook.failDelete)) {
    hook.failDelete = undefined;
    throw new Error("Redis request failed with status 503 (synthetic)");
  }
  return real(commands);
}) as typeof redis.pipeline;

const DAY = 86_400_000;
const OTHER = "r51r-other@example.test";
const NEWER = "r51r-newer@example.test";
const ERASED = "r51r-erased@example.test";

async function world(owner: string, handle: string, products = 1) {
  redis.clear();
  hook.beforeDelete = undefined;
  hook.failDelete = undefined;
  hook.failing = false;
  await claimHandle(owner, handle, "R51 Retry", "");
  await ensureStoreId(owner);
  await ensureStatsId(owner);
  await ensureListId(owner);
  const now = Math.floor(Date.now() / 1000);
  await setSubscription(owner, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true, tier: "pro", period: { start: now - 10 * 86_400, end: now + 20 * 86_400, renews: true } });
  const productIds: string[] = [];
  for (const title of ["Bread Book", "Cake Book"].slice(0, products)) {
    const added = await addProduct(owner, title, "", "19", null);
    if (!added.ok) throw new Error("no product");
    productIds.push(added.product.id);
  }
  const statsId = (await storeForEmail(owner))!.statsId!;
  const base = Date.now() - 5 * DAY;
  const other = await saveReview(statsId, { productId: productIds[0], email: OTHER, reference: "cs_test_R51ROther01", pi: "pi_R51ROther01", rating: 4, text: "Clear steps and a friendly tone all the way through.", name: "Other Reader" }, ROOM, base);
  if (other.state !== "created") throw new Error("review not written");
  for (const [i, productId] of productIds.entries()) {
    const erased = await saveReview(statsId, { productId, email: ERASED, reference: `cs_test_R51RErased${i}`, pi: `pi_R51RErased${i}`, rating: 5, text: `My own words on this book, number ${i + 1}, in full.`, name: "Erased Person" }, ROOM, base + (i + 1) * DAY);
    if (erased.state !== "created") throw new Error("review not written");
  }
  await refreshStoreQuotes((await storeForEmail(owner))!);
  return { statsId, productIds, erasedIds: productIds.map((p) => reviewId(statsId, p, ERASED)) };
}

const names = async (owner: string) => (await storeForEmail(owner))!.quotes.map((q) => q.n);
const mine = async (owner: string) => (await storeForEmail(owner))!.quotes.some((q) => q.n === "Erased Person" || q.t.includes("My own words"));
const incomplete = (result: Awaited<ReturnType<typeof erasePerson>>) => !result.ok && result.reason === "incomplete" && result.failed.includes("lib/reviews.ts");

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_r51_retry_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_r51_retry_only_a_stand_in";
  globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

  part("A review deleted on the first run, its quote kept back by a refresh: the retry still takes the quote off");
  {
    const owner = "r51r-a@example.com";
    const w = await world(owner, "r51ra");
    is("control: both buyers quoted before", await names(owner), ["Erased Person", "Other Reader"]);
    // A refresh keeps the review's quote again just before its delete; then the store record cannot be written.
    hook.beforeDelete = {
      id: w.erasedIds[0],
      run: async () => {
        await refreshStoreQuotes((await storeForEmail(owner))!);
        hook.failing = true;
      },
    };
    const first = await erasePerson((await storeForEmail(owner))!, ERASED, { kind: "person" });
    hook.failing = false;
    is("the refresh ran during the first run", hook.beforeDelete, undefined);
    is("the first run is not done, and names the reviews' part", incomplete(first), true);
    is("control: the review was deleted on the first run", (await summaryOf(w.statsId, w.productIds[0])).count, 1);
    const again = await erasePerson((await storeForEmail(owner))!, ERASED, { kind: "person" });
    is("the retry is done", again.ok, true);
    is("after it, no quote carries their name or words", await mine(owner), false);
    is("the other buyer's quote stays", await names(owner), ["Other Reader"]);
  }

  part("Two reviews, the second delete failing after a refresh: the retry takes both quotes off");
  {
    const owner = "r51r-b@example.com";
    const w = await world(owner, "r51rb", 2);
    is("control: both of their reviews quoted before", (await names(owner)).filter((n) => n === "Erased Person").length, 2);
    hook.beforeDelete = { id: w.erasedIds[0], run: async () => refreshStoreQuotes((await storeForEmail(owner))!) };
    hook.failDelete = w.erasedIds[1];
    const first = await erasePerson((await storeForEmail(owner))!, ERASED, { kind: "person" });
    is("the first run is not done, and names the reviews' part", incomplete(first), true);
    is("control: the first review went, the second stayed", [(await summaryOf(w.statsId, w.productIds[0])).count, (await summaryOf(w.statsId, w.productIds[1])).count], [1, 1]);
    const again = await erasePerson((await storeForEmail(owner))!, ERASED, { kind: "person" });
    is("the retry is done", again.ok, true);
    is("after it, no quote carries their name or words", await mine(owner), false);
    is("and both of their reviews are gone", (await summaryOf(w.statsId, w.productIds[1])).count, 0);
    is("the other buyer's quote stays", await names(owner), ["Other Reader"]);
  }

  part("Another buyer's newer quote of the same product stays after the erasure");
  {
    const owner = "r51r-newer@example.com";
    const w = await world(owner, "r51rnewer");
    const newer = await saveReview(w.statsId, { productId: w.productIds[0], email: NEWER, reference: "cs_test_R51RNewer01", pi: "pi_R51RNewer01", rating: 5, text: "The seeded loaf is now a weekly thing at our house.", name: "Newer Reader" }, ROOM);
    if (newer.state !== "created") throw new Error("review not written");
    await refreshStoreQuotes((await storeForEmail(owner))!);
    is("control: three buyers quoted before, newest first", await names(owner), ["Newer Reader", "Erased Person", "Other Reader"]);
    const erased = await erasePerson((await storeForEmail(owner))!, ERASED, { kind: "person" });
    is("the erasure says done", erased.ok, true);
    is("no quote carries their name or words", await mine(owner), false);
    is("both other buyers' quotes stay, newest first", await names(owner), ["Newer Reader", "Other Reader"]);
  }

  part("Control: an erasure of someone with no review leaves the quotes as they were");
  {
    const owner = "r51r-none@example.com";
    await world(owner, "r51rnone");
    const erased = await erasePerson((await storeForEmail(owner))!, "r51r-nobody@example.test", { kind: "person" });
    is("the erasure says done", erased.ok, true);
    is("the quotes are as they were", await names(owner), ["Erased Person", "Other Reader"]);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
