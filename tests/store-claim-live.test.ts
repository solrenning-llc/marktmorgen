/**
 * claimWhileStoreLive (lib/store-live-cache.ts): a mark taken once, as claimMark takes it, but only while the store is
 * its own and not erasing (Codex L-20261120-1852 and L-20261120-1842). The same identity rule as setWhileStoreLive:
 * a store with an id is fenced on its id key; one from before ids on its owner's record carrying its own statsId.
 * Synthetic stores and the in-memory Redis only.
 */
import { ERASING_KEY, claimHandle, ensureStatsId, ensureStoreId, erasingField, ownerKey, storeForEmail, storeIdCommand, storeRef, type Store } from "@/lib/store";
import { claimWhileStoreLive } from "@/lib/store-live-cache";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

async function shop(email: string, handle: string): Promise<Store> {
  redis.clear();
  await claimHandle(email, handle, "Claim shop", "");
  await ensureStoreId(email);
  await ensureStatsId(email);
  return (await storeForEmail(email))!;
}
const read = async (key: string) => (await redis.pipeline([["GET", key]]))[0];

async function main(): Promise<void> {
  part("A live store with an id");
  const live = await shop("claim-live@example.com", "claimlive");
  is("taken: ours", await claimWhileStoreLive(live, "nl:test:mark:a", 60, "v1"), "ours");
  is("written with its value", await read("nl:test:mark:a"), "v1");
  is("again: taken", await claimWhileStoreLive(live, "nl:test:mark:a", 60, "v2"), "taken");
  is("the first value kept", await read("nl:test:mark:a"), "v1");

  part("Erasing, or its id gone: gone, nothing written");
  await redis.pipeline([["HSET", ERASING_KEY, await erasingField(storeRef(live)), "1"]]);
  is("erasing: gone", await claimWhileStoreLive(live, "nl:test:mark:b", 60), "gone");
  is("nothing written", await read("nl:test:mark:b"), null);
  const gone = await shop("claim-gone@example.com", "claimgone");
  await redis.pipeline([["DEL", storeIdCommand(gone.sid)[1]]]);
  is("id key gone: gone", await claimWhileStoreLive(gone, "nl:test:mark:c", 60), "gone");
  is("nothing written", await read("nl:test:mark:c"), null);

  part("A store from before ids: its owner's record must still be its own");
  const made = await shop("claim-legacy@example.com", "claimlegacy");
  const legacy: Store = { ...made, sid: "", extra: false };
  is("its own record: ours", await claimWhileStoreLive(legacy, "nl:test:mark:d", 60), "ours");
  const owner = await ownerKey(storeRef(legacy));
  const record = JSON.parse(String(await read(owner))) as Record<string, unknown>;
  await redis.pipeline([["SET", owner, JSON.stringify({ ...record, statsId: "s_another_store_0001" })]]);
  is("another store's record under the same key: gone", await claimWhileStoreLive(legacy, "nl:test:mark:e", 60), "gone");
  is("nothing written", await read("nl:test:mark:e"), null);
  await redis.pipeline([["SET", owner, "not json"]]);
  is("a record that does not parse: unknown", await claimWhileStoreLive(legacy, "nl:test:mark:f", 60), "unknown");
  is("nothing written", await read("nl:test:mark:f"), null);
  is("no statsId: unknown before any call", await claimWhileStoreLive({ ...legacy, statsId: null }, "nl:test:mark:g", 60), "unknown");

  part("A lost answer is read back by the value");
  const lost = await shop("claim-lost@example.com", "claimlost");
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const out = await real(commands);
    return commands[0]?.[0] === "EVAL" ? [undefined] : out;
  }) as typeof redis.pipeline;
  try {
    is("written but its answer lost: ours, by the value read back", await claimWhileStoreLive(lost, "nl:test:mark:h", 60, "mine"), "ours");
    is("someone else's value read back: taken", await claimWhileStoreLive(lost, "nl:test:mark:h", 60, "other"), "taken");
  } finally {
    redis.pipeline = real;
  }
  done();
}

void main();
