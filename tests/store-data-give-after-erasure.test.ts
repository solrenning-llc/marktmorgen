/**
 * Codex L (relatorios-codex/L-20261120-1036-defect-store-data-give-after-erasure.md): a late give-back
 * (giveData, giveBeside) runs TAKE_DATA on the "never refuses" path. On a room that is no longer there, after the
 * store's erasure took nl:data:<store> away, it read the missing total as 0 and wrote "#" back, recreating a key of
 * the erased store. A give-back only shrinks, so on a room that is not there it writes nothing and answers taken.
 *
 * The other "never refuses" counts (noteData, countData, forceData) count what is written, and may grow it: on a
 * room not there yet they still make it, or a record would be kept uncounted.
 */
import { besideKey, countData, dataKey, forceData, giveBeside, giveData, giveDataBytes, noteData, takeBeside, takeData } from "@/lib/store-data";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is } from "./check";

const NOW = Date.UTC(2026, 10, 20, 12);

async function main(): Promise<void> {
  redis.clear();
  const erased = { ...ROOM, sid: "store-data-erased-fixture" };
  const key = dataKey(erased)!;
  is("control: the erased store's room is not there", redis.run(["EXISTS", key]), 0);

  await giveData(erased, [{ slot: "aff:payouts", bytes: 128 }], NOW);
  is("a late give-back does not recreate an erased store's room", redis.run(["EXISTS", key]), 0);
  await giveDataBytes(erased, "p:one", 64, NOW);
  is("nor does a late one-slot give-back", redis.run(["EXISTS", key]), 0);
  await giveData(erased, [{ slot: "p:two", bytes: 0, set: true }], NOW);
  is("nor one that sets a slot to nothing", redis.run(["EXISTS", key]), 0);

  const pool = besideKey(erased)!;
  await giveBeside(erased, ["prod_a"], NOW);
  is("a late beside-pool give-back does not recreate an erased store's pool", redis.run(["EXISTS", pool]), 0);

  // A live room still shrinks as before.
  const live = { ...ROOM, sid: "store-data-live-fixture" };
  const liveKey = dataKey(live)!;
  is("control: a live write takes its room", (await takeData(live, [{ slot: "p:one", bytes: 1_000 }], NOW)).ok, true);
  is("and the room holds it, with its own field", Number(redis.run(["HGET", liveKey, "#"])), 1_064);
  await giveData(live, [{ slot: "p:one", bytes: 400 }], NOW);
  is("a give-back on a live room still shrinks it", Number(redis.run(["HGET", liveKey, "#"])), 664);
  await giveData(live, [{ slot: "p:one", bytes: 600 }], NOW);
  is("and down to nothing, the room kept with its total", [redis.run(["EXISTS", liveKey]), Number(redis.run(["HGET", liveKey, "#"]))], [1, 0]);

  const livePool = besideKey(live)!;
  is("control: a live beside-pool share is taken", await takeBeside(live, ["prod_a"], 500, NOW), true);
  await giveBeside(live, ["prod_a"], NOW);
  is("and given back on the live pool", Number(redis.run(["HGET", livePool, "#"])), 0);

  // The counts that may grow still make a room that is not there yet.
  const fresh = { ...ROOM, sid: "store-data-fresh-note" };
  await noteData(fresh, [{ slot: "moved", bytes: 300 }], NOW);
  is("noteData still counts a record on a room not there yet", Number(redis.run(["HGET", dataKey(fresh)!, "#"])), 364);
  const counted = { ...ROOM, sid: "store-data-fresh-count" };
  is("countData still counts on a room not there yet", (await countData(counted, [{ slot: "c:one", bytes: 200 }], NOW)).ok, true);
  is("and the room holds it", Number(redis.run(["HGET", dataKey(counted)!, "#"])), 264);
  const forced = { ...ROOM, sid: "store-data-fresh-force" };
  await forceData(forced, [{ slot: "f:one", bytes: 100 }], NOW);
  is("forceData still counts on a room not there yet", Number(redis.run(["HGET", dataKey(forced)!, "#"])), 164);
  done();
}

void main();
