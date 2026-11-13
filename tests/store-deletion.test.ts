/**
 * Deleting one of an account's other stores, and what stops working with it
 * (lib/store.ts deleteStore; ClickFunnels audit F64, added 17 October 2026).
 *
 *   - only an extra store, with no products, no plan in good standing and no
 *     domain of its own, can be deleted; an account's first store never is;
 *   - once deleted, its address cannot be taken by anybody for its quarantine,
 *     so a link already shared leads nowhere rather than to a stranger;
 *   - its API keys open nothing, its team is not handed it, and it is no
 *     longer found by its id or address;
 *   - the defect found here: the route forgot a deleted store's email
 *     platform key, phones and notes, but kept its webhook endpoints — their
 *     addresses, often secret-bearing, and their signing secrets — and its
 *     API keys' records for good. Both are now forgotten with it
 *     (lib/webhooks.ts forgetStoreWebhooks, lib/api-keys.ts revokeAllKeys).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { addProduct, claimHandle, createStore, deleteStore as deleteWith, ensureStatsId, storeForEmail, storeForHandle, storeForId, storeRef } from "@/lib/store";
import { queueDeleted } from "@/lib/closed-store-data";
import { listKeys, makeKey, resolveKey, revokeAllKeys } from "@/lib/api-keys";
import { addEndpoint, forgetStoreWebhooks, webhooksView } from "@/lib/webhooks";
import { dropTeam, memberStores, putMember } from "@/lib/team";
import { resolveAccess } from "@/lib/studio-route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

// As app/api/store/stores deletes a store: its walk entry written first (tests/store-delete-walk.test.ts).
const deleteStore = (ref: string) => deleteWith(ref, queueDeleted);

async function main(): Promise<void> {
  redis.clear();
  const owner = "maker@example.com";
  await claimHandle(owner, "maker-home", "Maker Home", "");
  await ensureStatsId(owner);
  const home = (await storeForEmail(owner))!;

  part("What may be deleted");
  is("an account's first store, never", (await deleteStore(owner)).ok ? "deleted" : (await deleteStore(owner) as { reason: string }).reason, "first");
  const made = await createStore(owner, "maker-spare", "Maker Spare", "");
  if (!made.ok) throw new Error("no second store");
  const spare = made.store;
  const full = await createStore(owner, "maker-full", "Maker Full", "");
  if (!full.ok) throw new Error("no third store");
  await addProduct(storeRef(full.store), "A product", "", "9", null);
  is("an extra store with a product, never", (await deleteStore(storeRef(full.store)) as { reason?: string }).reason, "products");
  const key = await makeKey(spare.sid, "Zapier");
  if (!key.ok) throw new Error("no key");
  is("its key opens it while it stands", (await resolveKey(key.key))?.sid, spare.sid);
  await putMember(spare, "helper@example.com", "editor");
  await ensureStatsId(storeRef(spare));
  const withStats = (await storeForId(spare.sid))!;
  const hook = await addEndpoint(withStats, "https://hooks.example.com/maker", ["sale.completed"]);
  is("its webhook endpoint is added", hook.ok, true);
  // A delivery waiting for its next try, as lib/webhooks.ts emitEvent leaves one for an endpoint that is down.
  const delivery = "dlv_" + "a".repeat(24);
  await redis.pipeline([
    ["SET", `nl:hooks:d:${delivery}`, JSON.stringify({ id: delivery, statsId: withStats.statsId, endpoint: hook.ok ? hook.view.endpoints[0].id : "", eventId: "evt_1", type: "sale.completed", body: "{}", attempts: 1, state: "retrying", next: Date.now() + 300_000, lastStatus: 0, lastError: "", lastAt: Date.now(), createdAt: Date.now() })],
    ["ZADD", "nl:hooks:q", Date.now() + 300_000, `${withStats.statsId}|${delivery}`],
    ["LPUSH", `nl:hooks:log:${withStats.statsId}`, delivery],
  ]);
  const [queued] = await redis.pipeline([["ZCARD", "nl:hooks:q"]]);
  is("and a delivery to it waits for its next try", Number(queued), 1);
  is("its team member is on it while it stands", (await memberStores("helper@example.com")).map((m) => m.store.handle), ["maker-spare"]);

  part("Deleted");
  // The studio deletes a store by the key it is kept under (lib/store.ts storeRef), as app/api/store/stores does.
  const deleted = await deleteStore(storeRef(spare));
  is("an empty extra store is deleted", deleted.ok, true);
  // What app/api/store/stores does next, in the same order.
  await dropTeam(spare);
  await forgetStoreWebhooks(withStats.statsId);
  await revokeAllKeys(spare.sid);
  is("no longer found by its id or its address", [await storeForId(spare.sid), await storeForHandle("maker-spare")], [null, null]);
  is("its address cannot be claimed by somebody else for now", (await claimHandle("stranger@example.com", "maker-spare", "Not Theirs", "")).ok, false);
  is("its API key opens nothing, and no record of it is kept", [await resolveKey(key.key), (await listKeys(spare.sid)).length], [null, 0]);
  is("its webhook endpoints, secrets and log are gone", [(await webhooksView(withStats)).endpoints.length, (await webhooksView(withStats)).log.length, Number((await redis.pipeline([["EXISTS", `nl:hooks:cfg:${withStats.statsId}`]]))[0])], [0, 0, 0]);
  is("and nothing more is sent on its behalf", [Number((await redis.pipeline([["ZCARD", "nl:hooks:q"]]))[0]), Number((await redis.pipeline([["SISMEMBER", "nl:hooks:stores", withStats.statsId!]]))[0])], [0, 0]);
  is("forgetting twice is the same", [await revokeAllKeys(spare.sid), await forgetStoreWebhooks(withStats.statsId)], [0, undefined]);
  const route = readFileSync(join(process.cwd(), "app/api/store/stores/route.ts"), "utf8");
  is("the studio's delete does both", [route.includes("forgetStoreWebhooks(result.store.statsId)"), route.includes("revokeAllKeys(result.store.sid)")], [true, true]);
  is("its team member is not handed it", (await memberStores("helper@example.com")).length, 0);
  is("nor let in by naming it", await resolveAccess("helper@example.com", { pinned: spare.sid }, "products").then((r) => (r.ok ? "open" : r.reason)), "gone");
  is("the account's first store is untouched", (await storeForId(home.sid))?.handle, "maker-home");

  done();
}

void main();
