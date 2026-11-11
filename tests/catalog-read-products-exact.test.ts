/**
 * CX-123 rule 24 on lib/catalog.ts readProducts: a product's records read
 * whole. Only Redis's own nil means "no record": a missing listing leaves the
 * product out (it is gone), a missing extras record is a product without
 * checkout questions or funnel. Any other reply (a number, text that is not
 * JSON, JSON that is not a record, a record of another product) is unknown and
 * throws UnknownReplyError, never "this product has no checkout questions" or
 * "this store has no such product".
 *
 * Why it matters: every product edit in lib/store.ts (onProduct) reads the
 * product with readProduct under the store's lock and writes it back whole
 * (productWrites). An extras record read out of shape came back as a product
 * without its questions and funnel, and the next edit (any of them: a note, a
 * page, a price) DELeted the creator's checkout questions and funnel. A store
 * copy reading a batch with readProducts silently dropped a product whose
 * listing read out of shape and moved its cursor past it. Synthetic store.
 */
import { readProducts } from "@/lib/catalog";
import { UnknownReplyError } from "@/lib/redis-reply";
import { addProduct, claimHandle, setProductFields, setProductNote, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const OWNER = "catalog-read-products@example.test";
const real = redis.pipeline.bind(redis);
let rewrite: { key: string; reply: unknown } | null = null;
redis.pipeline = (async (batch: Command[]) => {
  const values = await real(batch);
  if (!rewrite) return values;
  return values.map((value, i) => (batch[i][0] === "GET" && batch[i][1] === rewrite!.key ? rewrite!.reply : value));
}) as typeof redis.pipeline;

async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "answered";
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : `threw ${String(error)}`;
  }
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "readexact", "Read Exact", "");
  const added = await addProduct(OWNER, "Workshop", "", "40", null);
  const other = await addProduct(OWNER, "Guide", "", "9", null);
  if (!added.ok || !other.ok) throw new Error("product fixture");
  const id = added.product.id;
  const fields = [{ label: "Your company", type: "text", optional: false, options: [] }];
  const set = await setProductFields(OWNER, id, fields as never);
  if (!set.ok) throw new Error("fields fixture");
  const store = (await storeForEmail(OWNER))!;
  const catalog = store.catalog.id!;
  const listingKey = `nl:catalog:${catalog}:l:${id}`;
  const extrasKey = `nl:catalog:${catalog}:x:${id}`;
  const [savedExtras] = (await real([["GET", extrasKey]])) as [string];

  part("Confirmed readings");
  const both = await readProducts(store, [id, other.product.id]);
  is("both products read, the workshop with its question", [both.length, both[0]?.fields.length], [2, 1]);
  rewrite = { key: extrasKey, reply: null };
  is("an extras record Redis says is not there is a product without questions", (await readProducts(store, [id]))[0]?.fields.length, 0);
  rewrite = { key: listingKey, reply: null };
  is("a listing Redis says is not there leaves the product out", (await readProducts(store, [id])).length, 0);
  rewrite = null;

  const cases: [string, string, unknown][] = [
    ["extras answered with a number", extrasKey, 7],
    ["extras answered with text that is not JSON", extrasKey, "{\"fields\":"],
    ["extras answered with JSON that is not a record", extrasKey, "[1,2]"],
    ["extras answered with a list", extrasKey, [savedExtras]],
    ["the listing answered with a number", listingKey, 3],
    ["the listing answered with text that is not JSON", listingKey, "{\"id\":"],
    ["the listing answered with another product's", listingKey, JSON.stringify({ ...both[1], id: other.product.id })],
  ];
  for (const [name, key, reply] of cases) {
    part(`Unknown: ${name}`);
    rewrite = { key, reply };
    is("readProducts throws UnknownReplyError, never a product without it", await outcome(() => readProducts(store, [id, other.product.id])), "unknown");
    // The edit that reads the product under the lock and writes it back whole must not run on that reading.
    let wrote = false;
    const edited = await outcome(async () => {
      wrote = (await setProductNote(OWNER, id, true)).ok;
    });
    is("an edit on that reading writes nothing back", [edited === "unknown" || edited === "answered", wrote], [true, false]);
    rewrite = null;
    const [extrasNow] = (await real([["GET", extrasKey]])) as [unknown];
    is("the creator's checkout questions are still stored", extrasNow, savedExtras);
    const after = (await readProducts((await storeForEmail(OWNER))!, [id]))[0];
    is("once read whole again, the product still has its question", after?.fields.map((f) => f.label), ["Your company"]);
    // Each case starts from the creator's records as saved, whatever the one before did.
    await real([["SET", extrasKey, savedExtras]]);
  }
}

main()
  .then(() => done())
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
