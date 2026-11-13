/**
 * A person's data kept under a product (a license key sold, a PayPal order, a pre-order,
 * a waitlist place) outlives the product's removal from the catalog, but the data copy
 * and the erasure walked only the products the store lists now, so after a removal the
 * copy left that data out and the erasure left it behind. Every product removed is now
 * noted (lib/removed-products.ts), and the copy and the erasure reach those products too.
 * Synthetic data only.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, removeProduct, storeForEmail } from "@/lib/store";
import { erasePerson, erasureScope } from "@/lib/person-erasure";
import { COPIERS } from "@/lib/person-copy";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }))) as typeof fetch;
const OWNER = "keyowner@example.com";

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "keyshop", "Key Shop", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await addProduct(OWNER, "Plugin", "", "19", null);
  await addProduct(OWNER, "Course two", "", "29", null);
  let store = (await storeForEmail(OWNER))!;
  const [plugin, later] = store.catalog.items.map((item) => item.id);
  const statsId = store.statsId!;
  // A key sold to Ada, as lib/licence-keys.ts keeps it, and her place on the second product's waitlist.
  await redis.pipeline([
    ["HSET", `nl:keys:${statsId}:${plugin}:info`, "ABCD-EFGH-IJKL", JSON.stringify({ r: "cs_test_aaaaaaaaaaaa", e: "ada@example.com", at: 1_790_000_000 })],
    ["HSET", `nl:wl:${statsId}:${later}`, "ada@example.com", JSON.stringify({ at: 1_790_000_000, ok: 0, c: false, t: "t".repeat(32) })],
  ]);
  const keys = async () => (await COPIERS["lib/licence-keys.ts"]((await erasureScope(store, "ada@example.com"))!)).length;
  is("the key is in her copy while the product is listed", await keys(), 1);

  is("the plugin is removed", (await removeProduct(OWNER, plugin)).ok, true);
  is("and the second product", (await removeProduct(OWNER, later)).ok, true);
  store = (await storeForEmail(OWNER))!;
  is("nothing is listed now", store.catalog.items.length, 0);
  is("the key is still kept", (await redis.pipeline([["HLEN", `nl:keys:${statsId}:${plugin}:info`]]))[0], 1);
  is("and still in her copy", await keys(), 1);
  const scope = (await erasureScope(store, "ada@example.com"))!;
  is("her waitlist place is in her copy too", (await COPIERS["lib/waitlist.ts"](scope)).length, 1);

  const erased = await erasePerson(store, "ada@example.com", { kind: "person" });
  is("her erasure finishes", erased.ok, true);
  is("and leaves no waitlist place behind", (await redis.pipeline([["HEXISTS", `nl:wl:${statsId}:${later}`, "ada@example.com"]]))[0], 0);
  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
