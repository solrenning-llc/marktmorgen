/**
 * The studio's list and count of license keys given (lib/licence-keys.ts,
 * issuedKeys) read the key records with HGETALL. Before, a reply in another
 * shape was read as no records: the studio showed 0 keys given and 0 revoked
 * as real (CX-123 rule 24, unknown is never zero). Now only a list of strings
 * in pairs reads; anything else throws UnknownReplyError and the keys route
 * answers an error. Synthetic data only.
 */
import { addProduct, claimHandle, ensureStatsId, setProductKeys, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { DEFAULT_KEYS } from "@/lib/key-setup";
import { issuedKeys, keyForSale } from "@/lib/licence-keys";
import { readListing } from "@/lib/catalog";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_issued_keys_exact_only";
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
  const owner = "issuedexact@example.com";
  await claimHandle(owner, "issuedexactshop", "Issued Exact Shop", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_1TestIssuedEx1", true);
  await setSubscription(owner, { customerId: "cus_IssuedEx0001", subscriptionId: "sub_IssuedEx0001", active: true, period: paidPeriod() });
  const app = await addProduct(owner, "Desktop app", "", "29", null);
  if (!app.ok) throw new Error("no product");
  await setProductLink(owner, app.product.id, "https://example.com/app");
  const keyed = await setProductKeys(owner, app.product.id, DEFAULT_KEYS);
  if (!keyed.ok) throw new Error("no keys");
  const store = (await storeForEmail(owner))!;
  const product = (await readListing(store, app.product.id))!;
  for (let i = 0; i < 2; i += 1) {
    const sale = await keyForSale(store, product, `cs_test_issuedexact${"x".repeat(14)}${i}`, `buyer${i}@example.test`);
    if (sale?.state !== "issued") throw new Error("no key given");
  }

  part("Key records that read are shown as they are");
  is("two keys given", (await issuedKeys(store, product, "", 50)).total, 2);

  part("Key records in another shape are unknown, never 0 given");
  const shapes: unknown[] = [null, "many", 7, { a: "b" }, ["only-a-field"], [1, 2]];
  for (const shape of shapes) {
    infoReply = shape;
    const read = await issuedKeys(store, product, "", 50).then((l) => l.total, (error) => (error instanceof UnknownReplyError ? "unknown" : String(error)));
    infoReply = "real";
    is(`records answered ${JSON.stringify(shape)}: unknown`, read, "unknown");
  }
  infoReply = [];
  is("no records at all (an empty list) is 0 given", (await issuedKeys(store, product, "", 50)).total, 0);
  infoReply = "real";
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
