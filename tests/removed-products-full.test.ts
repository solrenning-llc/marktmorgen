/**
 * The list of removed products is bounded (MAX_REMOVED_PRODUCTS), and it used to keep only the
 * newest: a store that removed more than that lost its oldest ids, and a person's data kept under
 * one of them (a license key sold) dropped out of their data copy and was left behind by their
 * erasure, without a word (Codex X3 on #4436). Now no id is ever dropped: a removal that would
 * need room the list does not have is refused, the product stays listed (it can be unpublished
 * instead), and the data under the first product removed is still copied and erased.
 * Synthetic data only.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, removeProduct, storeForEmail } from "@/lib/store";
import { erasePerson, erasureScope } from "@/lib/person-erasure";
import { COPIERS } from "@/lib/person-copy";
import { MAX_REMOVED_PRODUCTS, noteRemovedProduct, removedProductIds } from "@/lib/removed-products";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }))) as typeof fetch;
const OWNER = "fullowner@example.com";

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "fullshop", "Full Shop", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await addProduct(OWNER, "Plugin", "", "19", null);
  let store = (await storeForEmail(OWNER))!;
  const plugin = store.catalog.items[0].id;
  const statsId = store.statsId!;
  await redis.pipeline([
    ["HSET", `nl:keys:${statsId}:${plugin}:info`, "ABCD-EFGH-IJKL", JSON.stringify({ r: "cs_test_aaaaaaaaaaaa", e: "ada@example.com", at: 1_790_000_000 })],
    ["HSET", `nl:wl:${statsId}:${plugin}`, "ada@example.com", JSON.stringify({ at: 1_790_000_000, ok: 0, c: false, t: "t".repeat(32) })],
  ]);
  is("the plugin is removed first", (await removeProduct(OWNER, plugin)).ok, true);
  // Then as many other removals as the list holds, all after it.
  for (let i = 0; i < MAX_REMOVED_PRODUCTS - 1; i += 1) is(`removal ${i} noted`, await noteRemovedProduct(statsId, `gone${i}`, Date.now() + 1 + i), "noted");
  is("the list is full", (await removedProductIds(statsId)).length, MAX_REMOVED_PRODUCTS);

  await addProduct(OWNER, "One more", "", "9", null);
  store = (await storeForEmail(OWNER))!;
  const more = store.catalog.items[0].id;
  const refused = await removeProduct(OWNER, more);
  is("one more removal is refused, never made by dropping an older id", refused, { ok: false, reason: "removed_full" });
  store = (await storeForEmail(OWNER))!;
  is("and the product stays listed", store.catalog.items.map((item) => item.id), [more]);
  const ids = await removedProductIds(statsId);
  is("the first product removed is still on the list", ids.includes(plugin), true);
  is("which did not grow", ids.length, MAX_REMOVED_PRODUCTS);
  is("a product already on it is noted again (its time updated)", await noteRemovedProduct(statsId, plugin), "noted");
  is("and a new one is still refused", await noteRemovedProduct(statsId, "another1"), "full");

  const scope = (await erasureScope(store, "ada@example.com"))!;
  is("the key under the first product removed is in her copy", (await COPIERS["lib/licence-keys.ts"](scope)).length, 1);
  is("and her waitlist place under it", (await COPIERS["lib/waitlist.ts"](scope)).length, 1);
  // A store holding this many products pays for its erasure's size from the largest plan's studio requests.
  const paid = { ...store, tier: "scale" as const, subscriptionActive: true };
  const erased = await erasePerson(paid, "ada@example.com", { kind: "person" });
  is("her erasure finishes", erased.ok, true);
  is("and erases her waitlist place under the first product removed", (await redis.pipeline([["HEXISTS", `nl:wl:${statsId}:${plugin}`, "ada@example.com"]]))[0], 0);
  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
