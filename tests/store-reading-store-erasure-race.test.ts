// A store reading that finishes after its store's erasure began or ended keeps no copy (Codex
// L-20261119-2235, C5-20261120-2305-medicao): the copy is written in the same step that sees the
// store's own key and no erasing mark.
import { claimHandle, ERASING_KEY, erasingField, ownerKey, storeIdCommand, storeRef, type Store } from "@/lib/store";
import { keptReading } from "@/lib/store-readings";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

async function erase(store: Store, how: "gone" | "erasing") {
  if (how === "erasing") {
    await redis.pipeline([["HSET", ERASING_KEY, await erasingField(storeRef(store)), String(Date.now())]]);
  } else {
    await redis.pipeline([["DEL", storeIdCommand(store.sid)[1]], ["DEL", await ownerKey(storeRef(store))]]);
  }
}

async function main() {
  for (const how of ["gone", "erasing"] as const) {
    part(`a reading that finishes after the store is ${how} keeps no copy`);
    redis.clear();
    const made = await claimHandle(`reading-${how}@example.com`, `reading-${how}`, "Synthetic", "");
    if (!made.ok) throw new Error("store not made");
    const store = made.store;
    const statsKey = `nl:reading:stats:${store.statsId}`;
    await keptReading(store, "stats", async () => {
      await erase(store, how);
      return { visits: 42 };
    }, Date.now(), true);
    is("the late stats reading does not recreate its family", redis.run(["GET", statsKey]), null);
  }

  for (const how of ["gone", "erasing"] as const) {
    part(`a reading naming people that finishes after the store is ${how} keeps no copy and names nobody`);
    redis.clear();
    const made = await claimHandle(`named-${how}@example.com`, `named-${how}`, "Synthetic", "");
    if (!made.ok) throw new Error("store not made");
    const store = made.store;
    const salesKey = `nl:reading:sales:${store.statsId}`;
    const guard = {
      listId: `named-list-${how}`,
      names: (v: { top: string[] }) => v.top,
      without: (v: { top: string[] }, gone: Set<string>) => ({ top: v.top.filter((e) => !gone.has(e)) }),
    };
    const kept = await keptReading(store, "sales", async () => {
      await erase(store, how);
      return { top: ["buyer@example.com"] };
    }, Date.now(), true, guard);
    is("the late sales reading does not recreate its family", redis.run(["GET", salesKey]), null);
    is("and it is shown naming nobody", JSON.stringify(kept?.value), JSON.stringify({ top: [] }));
  }

  part("a live store still keeps its reading naming people");
  redis.clear();
  const named = await claimHandle("named-live@example.com", "named-live", "Synthetic", "");
  if (!named.ok) throw new Error("store not made");
  const kept = await keptReading(named.store, "sales", async () => ({ top: ["buyer@example.com"] }), Date.now(), true, {
    listId: "named-list-live",
    names: (v: { top: string[] }) => v.top,
    without: (v: { top: string[] }, gone: Set<string>) => ({ top: v.top.filter((e) => !gone.has(e)) }),
  });
  is("the named copy is kept", typeof redis.run(["GET", `nl:reading:sales:${named.store.statsId}`]), "string");
  is("and shown whole", JSON.stringify(kept?.value), JSON.stringify({ top: ["buyer@example.com"] }));

  part("a live store still keeps its reading");
  redis.clear();
  const made = await claimHandle("reading-live@example.com", "reading-live", "Synthetic", "");
  if (!made.ok) throw new Error("store not made");
  await keptReading(made.store, "stats", async () => ({ visits: 7 }), Date.now(), true);
  is("the copy is kept", typeof redis.run(["GET", `nl:reading:stats:${made.store.statsId}`]), "string");
  done();
}
void main();
