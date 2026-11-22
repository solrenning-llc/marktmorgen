/**
 * Keys given before the buyers' own lists existed (#5136, Claude 4 3rC's MEDIUM; the coordinator's pattern for #5135,
 * bb02). Stores sold on a trial until 5 October 2026 and keys exist since 26 September, so a key may sit in a product's
 * records with no line in its buyer's list. Until its store's fill is done, the person's copy reads the product's whole
 * records, as main did (complete, never worse); the five-minute sweep fills the missing lines a bounded step at a time
 * and marks the store done only when every product's records were walked to the end; after that the copy reads the
 * person's list only. Synthetic store, Redis stub, no provider.
 */
import { addProduct, claimHandle, ensureStatsId, setProductKeys, setProductLink, setSubscription, storeForEmail, type Listing } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { endHolderFillRound, fillHolderLines, holderFillDone, holderFillLeft, holderFillOn, keyForSale, keysOf, keysWithoutHolderLine, startHolderFillRound } from "@/lib/licence-keys";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "fill-owner@example.com";
const DANA = "dana@example.com";

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  await claimHandle(OWNER, "fillkeys", "Fill Keys", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_FillKeys01", subscriptionId: "sub_FillKeys01", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Fill App", "", "29", null);
  const other = await addProduct(OWNER, "Fill Book", "", "9", null);
  if (!made.ok || !other.ok) throw new Error("no products");
  await setProductLink(OWNER, made.product.id, "https://example.com/fill-app");
  await setProductKeys(OWNER, made.product.id, { source: "generated", prefix: "FIL", groups: 4, groupLength: 4, lowAt: 0 });
  await setProductLink(OWNER, other.product.id, "https://example.com/fill-book");
  await setProductKeys(OWNER, other.product.id, { source: "generated", prefix: "FIB", groups: 4, groupLength: 4, lowAt: 0 });
  const store = (await storeForEmail(OWNER))!;
  const app = (await readListing(store, made.product.id))!;
  const ids = [made.product.id, other.product.id];
  const infoOf = (id: string) => `nl:keys:${store.statsId}:${id}:info`;

  // 250 keys written the way they were before the lists (a record, no line), 125 a product: one of them Dana's.
  const OLD = "OLDK-DANA-0000-0001";
  redis.run(["HSET", infoOf(ids[0]), OLD, JSON.stringify({ r: `cs_test_${"o".repeat(24)}`, e: DANA, at: 1_790_000_000 })]);
  for (let i = 0; i < 249; i += 1) {
    redis.run(["HSET", infoOf(ids[i < 124 ? 0 : 1]), `OLDK-${String(i).padStart(4, "0")}-ZZZZ-ZZZZ`, JSON.stringify({ r: `cs_test_${String(i).padStart(24, "x")}`, e: `buyer${i}@example.com`, at: 1_790_000_000 })]);
  }
  // And one given now, through settle: it has its line.
  const fresh = await keyForSale(store, app as Listing, `cs_test_${"n".repeat(24)}`, DANA);
  if (fresh?.state !== "issued") throw new Error("no fresh key");

  part("Before the fill: the copy reads as main did, and misses nothing");
  is("the store's fill is not done", await holderFillDone(store), false);
  const before = (await keysOf(store, ids, DANA)).map((k) => k.key).sort();
  is("Dana's old key and her new one are both in her copy", before, [OLD, fresh.key].sort());
  is("250 keys have no line yet", (await keysWithoutHolderLine(store, ids)).length, 250);

  part("A fill cut short marks nothing done, and goes on from where it stopped");
  // A budget of 2 commands lets a run take one step (one HSCAN page and its lines), here one product's records.
  const first = await fillHolderLines(store, Date.now() + 60_000, 2);
  is("the first small run is not done", first, false);
  is("so the store is not marked done", await holderFillDone(store), false);
  is("one product's lines were written, the other's not yet", (await keysWithoutHolderLine(store, ids)).length, 125);
  is("the copy still reads every key", (await keysOf(store, ids, DANA)).map((k) => k.key).sort(), [OLD, fresh.key].sort());
  let runs = 1;
  while (!(await fillHolderLines(store, Date.now() + 60_000, 2)) && runs < 100) runs += 1;
  is("the fill ends on the next run, from where the first stopped", runs, 1);

  part("After the fill: every key has its line, and the copy reads the person's list only");
  is("the store is marked done", await holderFillDone(store), true);
  is("no key is left without its line", await keysWithoutHolderLine(store, ids), []);
  const reads: string[] = [];
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    for (const c of commands) reads.push(c.map(String).join(" "));
    return real(commands);
  }) as typeof redis.pipeline;
  let after: string[];
  try {
    after = (await keysOf(store, ids, DANA)).map((k) => k.key).sort();
  } finally {
    redis.pipeline = real;
  }
  is("Dana's two keys, old and new, are in her copy", after, [OLD, fresh.key].sort());
  is("and no product's whole records are read", reads.some((r) => r.startsWith("HGETALL") && r.includes(":info")), false);
  is("a fill already done does nothing more", await fillHolderLines(store, Date.now() + 60_000, 2), true);

  part("The sweep's rounds: only a whole clean round stops the asking");
  is("before any round, the sweep still asks", await holderFillOn(), true);
  await startHolderFillRound();
  await holderFillLeft();
  await endHolderFillRound();
  is("a round where a store was left unfinished sets no mark", await holderFillOn(), true);
  await endHolderFillRound();
  is("a round that did not start at the top of the list sets no mark either", await holderFillOn(), true);
  await startHolderFillRound();
  await endHolderFillRound();
  is("a clean round from the top sets the company's mark: the sweep stops asking", await holderFillOn(), false);

  part("A fill state in a shape no writer writes is unknown, never done");
  redis.run(["HSET", `nl:keys:${store.statsId}:whofill`, "done", "yes"]);
  let threw = false;
  try {
    await holderFillDone(store);
  } catch {
    threw = true;
  }
  is("an unknown mark throws", threw, true);
  done();
}

void main();
