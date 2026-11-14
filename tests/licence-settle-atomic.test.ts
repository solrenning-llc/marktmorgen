/**
 * A key given to a sale always has its record (audit of lib/licence-keys.ts, 11 November 2026).
 *
 * settle wrote the sale's key line (HSETNX on the sale hash) in one Redis write and the key's record (who, when,
 * which sale, revoked) in a second one. A process that stopped between the two, or a second write that never reached
 * Redis, left the sale with a key and no record: every later look found the key line and gave the same key back, and
 * the creator's software check (checkKey) answered "unknown" for it forever, so the buyer paid for a key that never
 * worked and the creator could not revoke it. Now both are written by one script, so either both are there or
 * neither is, and a sale left with neither is given its key the next time it is looked at.
 *
 * Also held here, unchanged: a sale is given one key however often it is looked at; the loser of a race for the
 * same sale puts its key back (a pooled key at the front of the pool, a made key out of the set of keys ever made)
 * and leaves no record for it; and a reply to the write in a shape not known throws, never "issued".
 *
 * Synthetic only: the Redis stub and the real code.
 */
import { addProduct, claimHandle, ensureStatsId, setProductKeys, setProductLink, setSubscription, storeForEmail, type Listing, type Store } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { addKeys, checkKey, keyForSale } from "@/lib/licence-keys";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "keys@example.com";
type Commands = (string | number)[][];
type Pipeline = (commands: Commands) => Promise<unknown[]>;
const timeout = () => new Error("Synthetic: Redis timed out");

/**
 * How Redis fails while a sale is given its key ("none": it does not):
 *  - "record": the write that carries the key's record never reaches Redis (the process stopped before it);
 *  - "after": once the sale has a key line, nothing more reaches Redis;
 *  - "shape": the write that carries the key's record is applied and answers in a shape not known (rule 24).
 */
type Fault = "none" | "record" | "after" | "shape";

const keysOf = (store: Store, product: Pick<Listing, "id">) => {
  const base = `nl:keys:${store.statsId}:${product.id}`;
  return { pool: `${base}:pool`, all: `${base}:all`, sale: `${base}:sale`, info: `${base}:info`, waiting: `${base}:waiting` };
};

async function give(store: Store, product: Listing, reference: string, fault: Fault): Promise<{ threw: boolean; state: string }> {
  const { sale, info } = keysOf(store, product);
  const pipeline: Pipeline = redis.pipeline.bind(redis);
  const hasLine = async () => typeof (await pipeline([["HGET", sale, reference]]))[0] === "string";
  const writesRecord = (commands: Commands) => commands.some((c) => String(c[0]).toUpperCase() === "EVAL" && c.map(String).includes(info));
  redis.pipeline = (async (commands: Commands) => {
    if (fault === "record" && writesRecord(commands)) throw timeout();
    if (fault === "after" && (await hasLine())) throw timeout();
    const replies = await pipeline(commands);
    if (fault === "shape" && writesRecord(commands)) return [{ result: replies[0] }];
    return replies;
  }) as typeof redis.pipeline;
  try {
    const given = await keyForSale(store, product, reference, "buyer@example.com");
    return { threw: false, state: given?.state ?? "none" };
  } catch {
    return { threw: true, state: "threw" };
  } finally {
    redis.pipeline = pipeline;
  }
}

/** The sale's key line, and whether that key has its record. */
async function lineAndRecord(store: Store, product: Listing, reference: string): Promise<{ key: string | null; record: boolean }> {
  const { sale, info } = keysOf(store, product);
  const [key] = await redis.pipeline([["HGET", sale, reference]]);
  if (typeof key !== "string") return { key: null, record: false };
  const [raw] = await redis.pipeline([["HGET", info, key]]);
  return { key, record: typeof raw === "string" && raw.length > 0 };
}

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  await claimHandle(OWNER, "keyforge", "Key Forge", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_KeyOwner001", subscriptionId: "sub_KeyOwner001", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Forge App", "", "29", null);
  const pooled = await addProduct(OWNER, "Forge Plugin", "", "19", null);
  if (!made.ok || !pooled.ok) throw new Error("no products");
  await setProductLink(OWNER, made.product.id, "https://example.com/forge-app");
  await setProductLink(OWNER, pooled.product.id, "https://example.com/forge-plugin");
  await setProductKeys(OWNER, made.product.id, { source: "generated", prefix: "FRG", groups: 4, groupLength: 4, lowAt: 0 });
  await setProductKeys(OWNER, pooled.product.id, { source: "pool", prefix: "", groups: 4, groupLength: 4, lowAt: 0 });
  const store = (await storeForEmail(OWNER))!;
  const app = (await readListing(store, made.product.id))!;
  const plugin = (await readListing(store, pooled.product.id))!;
  const poolKeys = Array.from({ length: 30 }, (_, i) => `PLUG-KEY-${String(i).padStart(4, "0")}-ZQXW`);
  const upload = await addKeys(store, plugin, poolKeys);
  if (upload.added !== poolKeys.length) throw new Error(`pool not filled: ${JSON.stringify(upload)}`);

  for (const [product, label] of [[app, "a made key"], [plugin, "a key from the pool"]] as [Listing, string][]) {
    part(`Healthy control, ${label}: one key, with its record, however often the sale is looked at`);
    const ok = `cs_test_ok_${product.id}`;
    const first = await keyForSale(store, product, ok, "buyer@example.com");
    const again = await keyForSale(store, product, ok, "buyer@example.com");
    is("issued, and the same key the second time", [first?.state, first?.state === "issued" && again?.state === "issued" && first.key === again.key], ["issued", true]);
    const held = await lineAndRecord(store, product, ok);
    is("the key line has its record, and the creator's check says valid", [held.record, held.key ? await checkKey(store, product, held.key) : "none"], [true, "valid"]);

    for (const [fault, what] of [
      ["record", "the write carrying the key's record never reaches Redis"],
      ["after", "nothing reaches Redis once the sale has its key line"],
    ] as [Fault, string][]) {
      part(`${label}: ${what}`);
      const reference = `cs_test_${fault}_${product.id}`;
      const tried = await give(store, product, reference, fault);
      is("the sale is not told it has a working key", tried.state === "issued" && !(await lineAndRecord(store, product, reference)).record, false);
      const left = await lineAndRecord(store, product, reference);
      is("the sale is never left with a key that has no record", left.key !== null && !left.record, false);
      const later = await keyForSale(store, product, reference, "buyer@example.com");
      is("looked at again with Redis back: issued", later?.state, "issued");
      const key = later?.state === "issued" ? later.key : "";
      is("and that key works in the creator's software check", await checkKey(store, product, key), "valid");
      const after = await lineAndRecord(store, product, reference);
      is("the line and the record stand together", [after.key === key, after.record], [true, true]);
    }

    part(`${label}: a reply to the write in a shape not known`);
    const unknown = `cs_test_shape_${product.id}`;
    const shaped = await give(store, product, unknown, "shape");
    is("throws, never issued", [shaped.threw, shaped.state], [true, "threw"]);
    const read = await lineAndRecord(store, product, unknown);
    is("and what it wrote is whole: a key line only with its record", read.key !== null && !read.record, false);
  }

  part("The loser of a race for the same sale leaves no record and puts its key back");
  for (const [product, label] of [[app, "made"], [plugin, "pool"]] as [Listing, string][]) {
    const { pool, all, sale, info } = keysOf(store, product);
    const reference = `cs_test_race_${product.id}`;
    const winner = label === "pool" ? "WINNER-KEY-0001-RACE" : "FRG-WINR-0001-RACE";
    const pipeline: Pipeline = redis.pipeline.bind(redis);
    let stepped = false;
    redis.pipeline = (async (commands: Commands) => {
      const settles = commands.some((c) => String(c[0]).toUpperCase() === "EVAL" && c.map(String).includes(sale));
      if (settles && !stepped) {
        stepped = true;
        // Another look at the same sale got there first, with its own key and record.
        await pipeline([["HSET", sale, reference, winner], ["HSET", info, winner, JSON.stringify({ r: reference, e: "buyer@example.com", at: 1 })]]);
      }
      return pipeline(commands);
    }) as typeof redis.pipeline;
    const poolBefore = (await pipeline([["LLEN", pool]]))[0];
    const head = (await pipeline([["LINDEX", pool, 0]]))[0];
    const everMade = async () => ((await pipeline([["SMEMBERS", all]]))[0] as string[]).sort();
    const madeBefore = await everMade();
    let got: Awaited<ReturnType<typeof keyForSale>>;
    try {
      got = await keyForSale(store, product, reference, "buyer@example.com");
    } finally {
      redis.pipeline = pipeline;
    }
    is(`${label}: the sale keeps the winner's key`, got?.state === "issued" ? got.key : got?.state, winner);
    const flat = (await redis.pipeline([["HGETALL", info]]))[0] as string[];
    const forSale = flat.filter((_, i) => i % 2 === 0).filter((_, i) => (JSON.parse(flat[2 * i + 1]) as { r?: string }).r === reference);
    is(`${label}: the only record for this sale is the winner's (the losing key has none)`, forSale, [winner]);
    if (label === "pool") {
      is("pool: the popped key is back at the front, the count unchanged", [(await redis.pipeline([["LINDEX", pool, 0]]))[0], (await redis.pipeline([["LLEN", pool]]))[0]], [head, poolBefore]);
    } else {
      is("made: the losing key is out of the set of keys ever made (the set as it was)", await everMade(), madeBefore);
    }
  }

  done();
}

main().catch((error) => {
  console.log(String(error?.stack ?? error));
  process.exit(1);
});
