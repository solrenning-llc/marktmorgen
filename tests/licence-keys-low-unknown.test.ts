/**
 * The creator is told when a product's pool of license keys runs low, once
 * until keys are added (lib/licence-keys.ts, warnIfLow, a mark kept 90 days).
 * Before, a count of the pool Redis answered in another shape read as 0: the
 * warning went out as "No license keys left" about a full pool, and the mark
 * it took (90 days) silenced the real warning when the pool did run low. The
 * studio's counts read the same way, and showed 0 keys left as real. Both now
 * read the count exactly: an unknown count sends nothing, takes no mark, and
 * the studio's read fails (its route answers an error, never 0). Synthetic
 * data only.
 */
import { addProduct, claimHandle, ensureStatsId, setProductKeys, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { DEFAULT_KEYS } from "@/lib/key-setup";
import { keyCounts, keyForSale } from "@/lib/licence-keys";
import { readListing } from "@/lib/catalog";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_keys_low_unknown_only";
globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }))) as typeof fetch;

let poolCount: unknown = "real";
const realPipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  const replies = await realPipeline(commands);
  if (poolCount === "real") return replies;
  return replies.map((reply, i) => (commands[i][0] === "LLEN" && String(commands[i][1]).endsWith(":pool") ? poolCount : reply));
}) as typeof redis.pipeline;

async function main(): Promise<void> {
  redis.clear();
  const owner = "keyslow@example.com";
  await claimHandle(owner, "keyslowshop", "Keys Low Shop", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_1TestKeysLow001", true);
  await setSubscription(owner, { customerId: "cus_KeysLow0001", subscriptionId: "sub_KeysLow0001", active: true, period: paidPeriod() });
  const app = await addProduct(owner, "Desktop app", "", "29", null);
  if (!app.ok) throw new Error("no product");
  await setProductLink(owner, app.product.id, "https://example.com/app");
  const keyed = await setProductKeys(owner, app.product.id, { ...DEFAULT_KEYS, source: "pool", lowAt: 2 });
  if (!keyed.ok) throw new Error("no keys");
  const store = (await storeForEmail(owner))!;
  const product = (await readListing(store, app.product.id))!;
  const pool = `nl:keys:${store.statsId}:${app.product.id}:pool`;
  const warned = `nl:keys:${store.statsId}:${app.product.id}:warned`;
  await realPipeline([["RPUSH", pool, ...Array.from({ length: 50 }, (_, i) => `KEY-${String(i).padStart(4, "0")}`)]]);

  part("A pool count that is not read sends nothing and takes no mark");
  const shapes: unknown[] = ["many", null, -1, 0.5, [3]];
  for (const shape of shapes) {
    poolCount = shape;
    const sale = await keyForSale(store, product, `cs_test_unread${"x".repeat(18)}${String(shapes.indexOf(shape))}`, "buyer@example.test");
    poolCount = "real";
    is(`a count answered ${JSON.stringify(shape)}: the key is still given`, sale?.state, "issued");
    is(`a count answered ${JSON.stringify(shape)}: the warning is not marked as sent`, (await realPipeline([["GET", warned]]))[0], null);
  }

  part("The studio's counts never show an unread pool as empty");
  for (const shape of ["many", null, -1]) {
    poolCount = shape;
    const read = await keyCounts(store, product).then((c) => c.left, () => "unknown");
    poolCount = "real";
    is(`a count answered ${JSON.stringify(shape)}: unknown, never 0 left`, read, "unknown");
  }
  is("a count that reads is shown as it is", (await keyCounts(store, product)).left, 45);

  part("The real warning still comes when the pool runs low");
  await realPipeline([["LTRIM", pool, 0, 2]]);
  is("before it, no warning was ever marked as sent", (await realPipeline([["GET", warned]]))[0], null);
  await keyForSale(store, product, "cs_test_lowpool000000000000000001", "buyer@example.test");
  is("two keys left: the warning is sent and marked, once", (await realPipeline([["GET", warned]]))[0], "1");
  done();
}

void main();
