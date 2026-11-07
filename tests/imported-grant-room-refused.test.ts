/**
 * A grant taken from the store's data room (an import, the API's gift) gives
 * its room back when the write is refused for certain: HSETNX answering 0,
 * the address already holds that product (Claude 5's note on #2576). Before,
 * every refused grant stayed counted, so giving the same product twice, or
 * an import run again, filled the room with nothing. A reply that is not
 * exactly 0 or 1 keeps what was taken, as the room must never be counted
 * below what is held. Synthetic store; no outside request.
 */
import { grantImported } from "@/lib/imported-purchases";
import { dataUsed } from "@/lib/store-data";
import { addProduct, claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

globalThis.fetch = (async () => {
  throw new Error("No outside request in this test");
}) as typeof fetch;

const OWNER = "grant-room@example.com";

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "grantroom", "Synthetic grants", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_GrantRoom", subscriptionId: "sub_GrantRoom", active: true, tier: "creator", period: paidPeriod() });
  const made = await addProduct(OWNER, "Guide", "A guide.", "29", null);
  if (!made.ok) throw new Error("no product");
  const store = (await storeForEmail(OWNER))!;
  const grant = [{ email: "dana@example.com", productId: made.product.id, items: null }];
  const used = async () => (await dataUsed(store))?.used ?? -1;

  part("Given once, then again");
  const empty = await used();
  is("the first gift is new", await grantImported(store.statsId!, "api:key1", grant, 1_800_000_000, "", store), [true]);
  const once = await used();
  is("and takes room", once > empty, true);
  is("the same gift again is not new", await grantImported(store.statsId!, "api:key1", grant, 1_800_000_000, "", store), [false]);
  is("and leaves the room as it was", await used(), once);

  part("A refusal that is not known for certain");
  const pipe = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const replies = await pipe(commands);
    return commands.every((c) => c[0] === "HSETNX") ? replies.map(() => undefined) : replies;
  }) as typeof redis.pipeline;
  const unknown = await grantImported(store.statsId!, "api:key1", grant, 1_800_000_000, "", store);
  redis.pipeline = pipe;
  is("an unknown answer is not new", unknown, [false]);
  is("and keeps what it took", (await used()) > once, true);
  done();
}

void main();
