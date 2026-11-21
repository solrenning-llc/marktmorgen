/**
 * A waitlist place written before #2576 took room for its link to leave with
 * the store's real handle (main's joinWaitlist). Since #2576 every place is
 * counted as if the store had the longest handle (LONGEST_HANDLE), so a store
 * renamed afterward never gets back more than a place took. Read that way, an
 * older place of a store with a shorter handle gave back up to 24 - length
 * bytes more than it ever took (Codex N1 LEVE, Codex X6 re-check on
 * 03ccf51044). An older place now gives back its link at the shortest handle,
 * never more than it took; a place written since keeps its exact round trip.
 * Synthetic data; no provider is called.
 */
import { forgetWaitlistPerson, leaveWaitlist } from "@/lib/waitlist";
import { dataKey, noteData, type DataStore } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { waitlistTokenKey } from "@/lib/waitlist-tokens";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

const PRODUCT = "prod_legacy1";
const store: DataStore = { ...ROOM, handle: "rye" };
const sid = String(store.statsId);
const listKey = `nl:wl:${sid}:${PRODUCT}`;
const slot = `wl:${PRODUCT}`;
/** What the product's waitlist slot holds now, read from the room's hash. */
const slotHeld = () => Number(redis.run(["HGET", String(dataKey(store)), slot]) ?? 0);
/** Other places already on the list, so a give-back larger than what was taken shows instead of stopping at zero. */
const OTHERS = 1000;

/** A place as main wrote it before #2576, with the room it took then: its link to leave counted with the real handle. */
async function legacyPlace(email: string, token: string): Promise<number> {
  const place = JSON.stringify({ at: 1, ok: 1, c: false, t: token });
  const leave = JSON.stringify({ s: sid, h: store.handle, p: PRODUCT, e: email, k: "leave" });
  redis.run(["HSET", listKey, email, place]);
  redis.run(["SET", waitlistTokenKey(token), leave]);
  const took = dataBytes([email, place], 1) + dataBytes([waitlistTokenKey(token), leave], 1);
  await noteData(store, [{ slot, bytes: took }]);
  return took;
}

async function main(): Promise<void> {
  redis.clear();
  await noteData(store, [{ slot, bytes: OTHERS }]);
  is("the other places are counted", slotHeld(), OTHERS);

  part("An older place deleted with its person gives back no more than it took");
  const took = await legacyPlace("ada@example.com", "a".repeat(48));
  is("it was counted", slotHeld(), OTHERS + took);
  await forgetWaitlistPerson(sid, [PRODUCT], "ada@example.com", store);
  is("the place is gone", redis.run(["HGET", listKey, "ada@example.com"]), null);
  is("the slot keeps at least the other places", slotHeld() >= OTHERS, true);
  is("and gives back no more than the place took", slotHeld() <= OTHERS + took, true);

  part("An older place left by its own link gives back no more than it took");
  const before = slotHeld();
  const took2 = await legacyPlace("bo@example.com", "b".repeat(48));
  is("left", await leaveWaitlist("b".repeat(48), store), true);
  is("the place is gone", redis.run(["HGET", listKey, "bo@example.com"]), null);
  is("the slot keeps at least what it held before the place", slotHeld() >= before, true);
  is("and gives back no more than the place took", slotHeld() <= before + took2, true);

  done();
}

void main();
