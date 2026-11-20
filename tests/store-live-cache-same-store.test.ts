/**
 * A store's cache is written only while that same store is live (lib/store-live-cache.ts, setWhileStoreLive; Codex X8
 * on #4951 and X5 on #4942, 20 November 2026). A store kept from before ids (its sid is "") is fenced on its owner's
 * record. After that store is erased, its owner may make a new store, whose record sits under the same owner key: its
 * existence must not let a late write of the erased store's cache back in. The record's statsId, which never changes
 * for a store, tells the two apart; a legacy store with no statsId cannot be told apart, so nothing is written.
 * Every identifier here is a local synthetic stand-in.
 */
import { claimHandle, ownerKey, storeRef, type Store } from "@/lib/store";
import { setWhileStoreLive } from "@/lib/store-live-cache";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

async function shop(email: string, handle: string): Promise<Store> {
  const claimed = await claimHandle(email, handle, "Live cache shop", "");
  if (!claimed.ok) throw new Error("synthetic store was not made");
  return claimed.store;
}

const read = async (key: string) => (await redis.pipeline([["GET", key]]))[0];

async function main(): Promise<void> {
  part("a store from before ids keeps its cache while its own record is there");
  redis.clear();
  const made = await shop("live-cache-a@example.com", "live-cache-a");
  const legacy: Store = { ...made, sid: "", extra: false };
  is("the store has a statsId", legacy.statsId.length > 0, true);
  is("kept", await setWhileStoreLive(legacy, "nl:test:cache:a", "one", 60), "kept");
  is("and written", await read("nl:test:cache:a"), "one");

  part("its owner key now holds another store's record: a late write of the erased store is refused");
  const owner = await ownerKey(storeRef(legacy));
  const record = JSON.parse(String(await read(owner))) as Record<string, unknown>;
  // The erased store's record replaced by the owner's new store under the same key, with its own statsId.
  await redis.pipeline([["SET", owner, JSON.stringify({ ...record, statsId: "s_another_store_0001", handle: "live-cache-b" })]]);
  is("gone", await setWhileStoreLive(legacy, "nl:test:cache:late", "erased buyer", 60), "gone");
  is("and nothing written", await read("nl:test:cache:late"), null);

  part("a store from before ids with no statsId cannot be told from another: unknown, nothing written");
  redis.clear();
  const bare = await shop("live-cache-c@example.com", "live-cache-c");
  const noId: Store = { ...bare, sid: "", extra: false, statsId: "" };
  is("unknown", await setWhileStoreLive(noId, "nl:test:cache:c", "x", 60), "unknown");
  is("and nothing written", await read("nl:test:cache:c"), null);

  part("a store with an id still keeps its cache, fenced on its id key");
  redis.clear();
  const withId = await shop("live-cache-d@example.com", "live-cache-d");
  is("kept", await setWhileStoreLive(withId, "nl:test:cache:d", "two", 60), "kept");
  is("and written", await read("nl:test:cache:d"), "two");

  done();
}

void main();
