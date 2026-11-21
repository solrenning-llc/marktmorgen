/**
 * A copy naming people is kept only while that same store is live (lib/store-live-copy.ts, keepUnlessErasedWhileLive,
 * KEEP_UNLESS_ERASED_LIVE; the same rule as setWhileStoreLive v2, Codex X8 on #4951 and X5 on #4942). A store kept from
 * before ids (its sid is "") is fenced on its owner's record. After that store is erased, its owner may make a new store
 * under the same owner key: that record's being there must not let a late copy of the erased store's readings back in.
 * The record's statsId tells the two apart; a legacy store with no statsId cannot be told apart, so nothing is kept.
 * A store with an id is live only while its id key still holds its own ref (v3, the rule of store-claim-live:v1).
 * Every identifier here is a local synthetic stand-in.
 */
import { ERASING_KEY, claimHandle, erasingField, ownerKey, storeIdCommand, storeRef, type Store } from "@/lib/store";
import { keepUnlessErasedWhileLive } from "@/lib/store-live-copy";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

async function shop(email: string, handle: string): Promise<Store> {
  const claimed = await claimHandle(email, handle, "Reading copy shop", "");
  if (!claimed.ok) throw new Error("synthetic store was not made");
  return claimed.store;
}

const read = async (key: string) => (await redis.pipeline([["GET", key]]))[0];
const names = ["buyer-one@example.com"];

async function main(): Promise<void> {
  part("a store from before ids keeps its copy while its own record is there");
  redis.clear();
  const made = await shop("reading-copy-a@example.com", "reading-copy-a");
  const legacy: Store = { ...made, sid: "", extra: false };
  is("the store has a statsId", (legacy.statsId ?? "").length > 0, true);
  const kept = await keepUnlessErasedWhileLive(legacy, "nl:test:copy:a", "list-a", "one", 60, names);
  is("nobody refused", [...kept], []);
  is("and written", await read("nl:test:copy:a"), "one");

  part("its owner key now holds another store's record: a late copy of the erased store is refused");
  const owner = await ownerKey(storeRef(legacy));
  const record = JSON.parse(String(await read(owner))) as Record<string, unknown>;
  // The erased store's record replaced by the owner's new store under the same key, with its own statsId.
  await redis.pipeline([["SET", owner, JSON.stringify({ ...record, statsId: "s_another_store_0002", handle: "reading-copy-b" })]]);
  const late = await keepUnlessErasedWhileLive(legacy, "nl:test:copy:late", "list-a", "erased buyer", 60, names);
  is("everyone refused", [...late], names);
  is("and nothing written", await read("nl:test:copy:late"), null);

  part("a store from before ids with no statsId cannot be told from another: nothing is kept");
  redis.clear();
  const bare = await shop("reading-copy-c@example.com", "reading-copy-c");
  const noId: Store = { ...bare, sid: "", extra: false, statsId: null };
  let threw = false;
  try {
    await keepUnlessErasedWhileLive(noId, "nl:test:copy:c", "list-c", "x", 60, names);
  } catch {
    threw = true;
  }
  is("unknown: it throws, so the caller keeps nothing", threw, true);
  is("and nothing written", await read("nl:test:copy:c"), null);

  part("a store with an id still keeps its copy, fenced on its id key");
  redis.clear();
  const withId = await shop("reading-copy-d@example.com", "reading-copy-d");
  is("nobody refused", [...(await keepUnlessErasedWhileLive(withId, "nl:test:copy:d", "list-d", "two", 60, names))], []);
  is("and written", await read("nl:test:copy:d"), "two");

  // The rule of store-claim-live:v1 (lib/live-fence.ts, Claude 2's MEDIUM on #4937): moveAccount repoints the id key to
  // the new ref, and an erasure begun after the move marks the new ref's field. A copy kept under the old ref must not
  // land on EXISTS alone.
  part("a store with an id whose account moved, then began erasing under the new ref: a late copy is refused");
  const idKey = storeIdCommand(withId.sid)[1];
  const moved = "reading-copy-moved@example.com";
  await redis.pipeline([["SET", idKey, moved], ["HSET", ERASING_KEY, await erasingField(moved), String(Date.now())]]);
  const afterMove = await keepUnlessErasedWhileLive(withId, "nl:test:copy:moved", "list-d", "erased buyer", 60, names);
  is("everyone refused", [...afterMove], names);
  is("and nothing written", await read("nl:test:copy:moved"), null);

  part("control: the id key holds this store's own ref again, nothing erasing under it: the copy is kept");
  await redis.pipeline([["SET", idKey, storeRef(withId)], ["DEL", ERASING_KEY]]);
  is("nobody refused", [...(await keepUnlessErasedWhileLive(withId, "nl:test:copy:back", "list-d", "three", 60, names))], []);
  is("and written", await read("nl:test:copy:back"), "three");

  done();
}

void main();
