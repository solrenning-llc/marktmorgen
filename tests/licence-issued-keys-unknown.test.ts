/**
 * #5285 row #2868 (Codex X6's LOW 1 on #2868 @96f5d99f6e, NOT FIXED): the studio lists the license keys a product has
 * given from one HGETALL of their records (lib/licence-keys.ts, issuedKeys), and keyCounts counts "given" and
 * "revoked" from the same list. A reply in another shape read as an empty hash, so the studio showed "0 keys given"
 * as real. Now it is unknown: issuedKeys throws, keyCounts with it, and the keys route answers an error, never 0.
 * Synthetic data only; no service is contacted.
 */
import { addProduct, claimHandle, ensureStatsId, setProductKeys, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { DEFAULT_KEYS } from "@/lib/key-setup";
import { issuedKeys, keyCounts, keyForSale } from "@/lib/licence-keys";
import { readListing } from "@/lib/catalog";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_issued_keys_unknown_only";
globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }))) as typeof fetch;

let infoReply: unknown = "real";
const realPipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  const replies = await realPipeline(commands);
  if (infoReply === "real") return replies;
  return replies.map((reply, i) => (commands[i][0] === "HGETALL" && String(commands[i][1]).endsWith(":info") ? infoReply : reply));
}) as typeof redis.pipeline;

async function main(): Promise<void> {
  redis.clear();
  const owner = "issuedkeys@example.com";
  await claimHandle(owner, "issuedkeysshop", "Issued Keys Shop", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_1TestIssuedK01", true);
  await setSubscription(owner, { customerId: "cus_IssuedKey001", subscriptionId: "sub_IssuedKey001", active: true, period: paidPeriod() });
  const app = await addProduct(owner, "Desktop app", "", "29", null);
  if (!app.ok) throw new Error("no product");
  await setProductLink(owner, app.product.id, "https://example.com/app");
  const keyed = await setProductKeys(owner, app.product.id, { ...DEFAULT_KEYS, source: "pool" });
  if (!keyed.ok) throw new Error("no keys");
  const store = (await storeForEmail(owner))!;
  const product = (await readListing(store, app.product.id))!;
  await realPipeline([["RPUSH", `nl:keys:${store.statsId}:${app.product.id}:pool`, "KEY-0001", "KEY-0002", "KEY-0003"]]);
  for (const n of [1, 2]) {
    const sale = await keyForSale(store, product, `cs_test_issued${"x".repeat(18)}${n}`, `buyer${n}@example.test`);
    if (sale?.state !== "issued") throw new Error("no key given");
  }

  part("The keys given read as they are");
  is("two keys given", (await issuedKeys(store, product, "", 50)).total, 2);
  is("and counted so", (await keyCounts(store, product)).issued, 2);

  part("A reply of the keys' records in another shape is unknown, never no keys given");
  for (const shape of [null, "OK", 7, { a: 1 }]) {
    infoReply = shape;
    const listed = await issuedKeys(store, product, "", 50).then((list) => list.total, () => "unknown");
    const counted = await keyCounts(store, product).then((counts) => counts.issued, () => "unknown");
    infoReply = "real";
    is(`records answered ${JSON.stringify(shape)}: the list is unknown`, listed, "unknown");
    is(`records answered ${JSON.stringify(shape)}: the count is unknown`, counted, "unknown");
  }
  is("read again in its shape, the list is as before", (await issuedKeys(store, product, "", 50)).total, 2);

  part("A product that has given no key yet still reads as none");
  const other = await addProduct(owner, "Plugin", "", "9", null);
  if (!other.ok) throw new Error("no product");
  await setProductLink(owner, other.product.id, "https://example.com/plugin");
  await setProductKeys(owner, other.product.id, { ...DEFAULT_KEYS, source: "pool" });
  const fresh = (await readListing((await storeForEmail(owner))!, other.product.id))!;
  is("an empty hash is no key given", (await issuedKeys((await storeForEmail(owner))!, fresh, "", 50)).total, 0);
  done();
}

void main();
