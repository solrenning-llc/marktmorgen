/**
 * Audit R51, third review of #3393 (synthetic, no real provider): a person's own erasure (erasePerson, kind
 * "person") when one review record among the newest of the store cannot be read, so the store page's quotes
 * (lib/store-quotes.ts) cannot be kept again from the reviews.
 *
 * What fails here:
 *   - the quotes are taken off (nothing is quoted at all), yet the erasure answers incomplete, on every retry and for
 *     every other person of that store, while that record stays unreadable.
 * Controls: when taking the quotes off is not confirmed either, the erasure is not done, and the retry is; once the
 * record reads again, the next refresh quotes the other buyer again.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { reviewId, saveReview } from "@/lib/reviews";
import { refreshStoreQuotes } from "@/lib/store-quotes";
import { erasePerson } from "@/lib/person-erasure";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

type Command = (string | number)[];
const STORE_KEY = "nl:store:owner:";
const real = redis.pipeline.bind(redis);

const hook: {
  /** Once the reviews' index is read for the quotes, every store record write fails. */
  failWritesAfterList?: boolean;
  /** Every store record write fails while set. */
  failing?: boolean;
} = {};

const writesStore = (commands: Command[]) => commands.some(([name, ...args]) => name !== "GET" && name !== "GETRANGE" && args.some((arg) => String(arg).startsWith(STORE_KEY)));
const readsList = (commands: Command[]) => commands.some(([name, key]) => name === "ZREVRANGEBYSCORE" && String(key).startsWith("nl:rev:all:"));

redis.pipeline = (async (commands: Command[]) => {
  if (hook.failWritesAfterList && readsList(commands)) {
    hook.failWritesAfterList = false;
    hook.failing = true;
  }
  if (hook.failing && writesStore(commands)) throw new Error("Redis request failed with status 503 (synthetic)");
  return real(commands);
}) as typeof redis.pipeline;

const DAY = 86_400_000;
const OTHER = "r51u-other@example.test";
const ERASED = "r51u-erased@example.test";
const NOBODY = "r51u-nobody@example.test";

async function world(owner: string, handle: string) {
  redis.clear();
  hook.failWritesAfterList = false;
  hook.failing = false;
  await claimHandle(owner, handle, "R51 Unreadable", "");
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
  const other = await saveReview(statsId, { productId, email: OTHER, reference: "cs_test_R51UOther01", pi: "pi_R51UOther01", rating: 4, text: "Clear steps and a friendly tone all the way through.", name: "Other Reader" }, ROOM, base);
  const erased = await saveReview(statsId, { productId, email: ERASED, reference: "cs_test_R51UErased01", pi: "pi_R51UErased01", rating: 5, text: "My own words on this book, in full and at length.", name: "Erased Person" }, ROOM, base + DAY);
  if (other.state !== "created" || erased.state !== "created") throw new Error("review not written");
  await refreshStoreQuotes((await storeForEmail(owner))!);
  // The other buyer's record no longer reads (a stale or damaged entry among the newest).
  const key = `nl:rev:${statsId}:${productId}`;
  const otherId = reviewId(statsId, productId, OTHER);
  const [kept] = (await real([["HGET", key, otherId]])) as [string];
  await real([["HSET", key, otherId, "{not json"]]);
  const erasedId = reviewId(statsId, productId, ERASED);
  return {
    restore: async () => void (await real([["HSET", key, otherId, kept]])),
    erasedKept: async () => ((await real([["HGET", key, erasedId]])) as [unknown])[0] !== null,
  };
}

const names = async (owner: string) => (await storeForEmail(owner))!.quotes.map((q) => q.n);
const mine = async (owner: string) => (await storeForEmail(owner))!.quotes.some((q) => q.n === "Erased Person" || q.t.includes("My own words"));
const incomplete = (result: Awaited<ReturnType<typeof erasePerson>>) => !result.ok && result.reason === "incomplete" && result.failed.includes("lib/reviews.ts");

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_r51_unreadable_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_r51_unreadable_only_a_stand_in";
  globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

  part("One unreadable review record: the quotes are taken off and the erasure is done, again and for others");
  {
    const owner = "r51u-a@example.com";
    const w = await world(owner, "r51ua");
    is("control: both buyers quoted before", await names(owner), ["Erased Person", "Other Reader"]);
    const first = await erasePerson((await storeForEmail(owner))!, ERASED, { kind: "person" });
    is("the erasure says done", first.ok, true);
    is("their review is gone", await w.erasedKept(), false);
    is("no quote carries their name or words", await mine(owner), false);
    is("nothing is quoted while the reviews cannot be read", await names(owner), []);
    const again = await erasePerson((await storeForEmail(owner))!, ERASED, { kind: "person" });
    is("a retry is done too", again.ok, true);
    const nobody = await erasePerson((await storeForEmail(owner))!, NOBODY, { kind: "person" });
    is("another person's erasure in that store is done", nobody.ok, true);
    is("still nothing is quoted", await names(owner), []);
    await w.restore();
    await refreshStoreQuotes((await storeForEmail(owner))!);
    is("control: once the record reads again, the next refresh quotes the other buyer", await names(owner), ["Other Reader"]);
  }

  part("Control: taking the quotes off is not confirmed either: the erasure is not done, the retry is");
  {
    const owner = "r51u-b@example.com";
    const w = await world(owner, "r51ub");
    hook.failWritesAfterList = true;
    const first = await erasePerson((await storeForEmail(owner))!, ERASED, { kind: "person" });
    const ranOut = hook.failing;
    hook.failing = false;
    is("control: the store writes failed from the quotes' read on", ranOut, true);
    is("the first run is not done, and names the reviews' part", incomplete(first), true);
    is("control: their review went on the first run", await w.erasedKept(), false);
    const again = await erasePerson((await storeForEmail(owner))!, ERASED, { kind: "person" });
    is("the retry is done", again.ok, true);
    is("after it, nothing is quoted", await names(owner), []);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
