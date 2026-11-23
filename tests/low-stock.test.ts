/**
 * 623 [SZ7], unit 4: the creator's low-stock number, kept per product, and
 * the crossing it watches. The number is taken from the store's data room
 * before it is written; the count last seen is kept beside it, so a fall to
 * the number is said once per crossing (and again only after a restock above
 * it). A count, a record or a reply that cannot be read never says
 * "crossed" and never writes (rule 24); two checks of the same fall at once
 * say it once. No email, phone alert, studio field or job yet: unit 5.
 */
import { addProduct, claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { LOW_STOCK_BYTES, lowStockOf, noteUnitsLeft, setLowStock } from "@/lib/low-stock";
import { MAX_LOW_STOCK } from "@/lib/stock-alert-rules";
import { CLOSING, COUNTED_FAMILIES, closingFamilyOf } from "@/lib/data-families";
import { dataKey, dataUsed, noteData } from "@/lib/store-data";
import { UnknownReplyError } from "@/lib/redis-reply";
import { FAMILIES } from "./store-data-registry";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

/** Answers `reply` to one command on one key, as a database that answered something else would. */
function answer(command: string, key: string, reply: unknown): () => void {
  const run = redis.run.bind(redis);
  redis.run = (c: (string | number)[]) => (String(c[0]).toUpperCase() === command && c[1] === key ? reply : run(c));
  return () => {
    redis.run = run;
  };
}

async function settles(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return await run();
  } catch (error) {
    return error instanceof UnknownReplyError ? "threw unknown" : `threw ${String(error)}`;
  }
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle("owner@example.com", "kiln", "Kiln Goods", "");
  await ensureStatsId("owner@example.com");
  const made = await addProduct("owner@example.com", "Glazed Mug", "", "30", null);
  const other = await addProduct("owner@example.com", "Plate", "", "30", null);
  if (!made.ok || !other.ok) throw new Error("no product");
  const store = (await storeForEmail("owner@example.com"))!;
  const pid = made.product.id;
  const pid2 = other.product.id;
  const key = `nl:ls:${store.statsId}`;

  part("The creator's number, read whole and kept with the count it was set at");
  for (const bad of [-1, 2.5, "abc", MAX_LOW_STOCK + 1, null, {}]) {
    is(`refused: ${JSON.stringify(bad)}`, await setLowStock(store, pid, bad, 10), "invalid");
  }
  is("nothing written for a refused number", redis.run(["EXISTS", key]), 0);
  is("a count that cannot be read writes nothing", await setLowStock(store, pid, 5, "10"), "unknown");
  is("nor a negative count", await setLowStock(store, pid, 5, -1), "unknown");
  is("still nothing written", redis.run(["EXISTS", key]), 0);
  is("not set is off", await lowStockOf(store, pid), null);
  is("set", await setLowStock(store, pid, "5", 10), "saved");
  is("read back", await lowStockOf(store, pid), { low: 5, seen: 10 });
  const used = await dataUsed(store);
  is("its room taken from the store's data room", (used?.used ?? 0) >= LOW_STOCK_BYTES, true);

  part("A fall to the number is said once per crossing");
  is("10 to 6: above it", await noteUnitsLeft(store, pid, 6), "no");
  is("the count seen moves", await lowStockOf(store, pid), { low: 5, seen: 6 });
  is("6 to 5: crossed", await noteUnitsLeft(store, pid, 5), "crossed");
  is("5 to 5 again: nothing new", await noteUnitsLeft(store, pid, 5), "no");
  is("5 to 2: still under it, not again", await noteUnitsLeft(store, pid, 2), "no");
  is("sold out: not again", await noteUnitsLeft(store, pid, 0), "no");
  is("restocked to 20", await noteUnitsLeft(store, pid, 20), "no");
  is("20 to 3: crossed again after the restock", await noteUnitsLeft(store, pid, 3), "crossed");
  is("no longer limited: nothing", await noteUnitsLeft(store, pid, null), "no");
  is("limited again under it: not a crossing", await noteUnitsLeft(store, pid, 4), "no");

  part("Set below the count it is at, it waits for the next fall");
  is("set at 8 while 4 are left", await setLowStock(store, pid2, 8, 4), "saved");
  is("4 to 3: under it, but it never crossed", await noteUnitsLeft(store, pid2, 3), "no");

  part("A product with no number is off and writes nothing");
  const third = await addProduct("owner@example.com", "Bowl", "", "30", null);
  if (!third.ok) throw new Error("no product");
  is("off", await noteUnitsLeft(store, third.product.id, 1), "off");
  is("no field written", redis.run(["HEXISTS", key, third.product.id]), 0);

  part("Unknown is never a crossing and never a write");
  is("a count that cannot be read", await noteUnitsLeft(store, pid, Number.NaN), "unknown");
  is("a count as text", await noteUnitsLeft(store, pid, "2"), "unknown");
  is("the record unchanged", await lowStockOf(store, pid), { low: 5, seen: 4 });
  redis.run(["HSET", key, pid2, "garbage"]);
  is("a record it did not write", await noteUnitsLeft(store, pid2, 1), "unknown");
  is("left as it was", redis.run(["HGET", key, pid2]), "garbage");
  is("and read as unknown, never off", await settles(() => lowStockOf(store, pid2)), "threw unknown");
  const undo = answer("HGET", key, 7);
  is("a read answered with a number", await noteUnitsLeft(store, pid, 1), "unknown");
  is("the reader says so", await settles(() => lowStockOf(store, pid)), "threw unknown");
  undo();
  const pipeline = redis.pipeline.bind(redis);
  redis.pipeline = async (commands) => (commands.some((c) => c[0] === "EVAL") ? [] : pipeline(commands));
  is("a write answered short", await noteUnitsLeft(store, pid, 1), "unknown");
  redis.pipeline = pipeline;
  redis.pipeline = async (commands) => (commands.some((c) => c[0] === "EVAL") ? [["1"]] : pipeline(commands));
  is("a write answered in another shape", await noteUnitsLeft(store, pid, 1), "unknown");
  redis.pipeline = pipeline;
  is("still as it was", await lowStockOf(store, pid), { low: 5, seen: 4 });

  part("Two checks of the same fall at once say it once");
  await setLowStock(store, pid, 5, 9);
  const both = await Promise.all([noteUnitsLeft(store, pid, 5), noteUnitsLeft(store, pid, 5)]);
  is("one crossed", both.filter((r) => r === "crossed").length, 1);
  is("the other is not a crossing", both.filter((r) => r !== "crossed").length, 1);
  await setLowStock(store, pid, 5, 9);
  redis.pipeline = async (commands) => {
    if (commands.some((c) => c[0] === "EVAL")) redis.run(["HSET", key, pid, JSON.stringify({ low: 5, seen: 7 })]);
    return pipeline(commands);
  };
  is("changed between the read and the write: not said", await noteUnitsLeft(store, pid, 5), "unknown");
  redis.pipeline = pipeline;
  is("the other write kept", await lowStockOf(store, pid), { low: 5, seen: 7 });

  part("Off gives the room back in the same step as the number (Codex G and Codex X6 on #3650)");
  const slotKey = dataKey(store)!;
  const slotOf = (id: string) => redis.run(["HGET", slotKey, `ls:${id}`]);
  const totalOf = () => Number(redis.run(["HGET", slotKey, "#"]) ?? 0);
  // The number and its room stand or fall together: a number with no room would be uncounted, a room with no number stranded.
  const together = (id: string) => (redis.run(["HEXISTS", key, id]) === 1) === Number(slotOf(id) ?? 0) >= LOW_STOCK_BYTES;
  const held = Number(slotOf(pid) ?? 0);
  is("its room held while the number is set", held >= LOW_STOCK_BYTES, true);
  const before = totalOf();
  is("off", await setLowStock(store, pid, 0, 7), "off");
  is("gone", redis.run(["HEXISTS", key, pid]), 0);
  is("its slot given back", slotOf(pid), null);
  is("the room's total down by exactly what it held and the slot's own field", totalOf(), before - held - 64);
  is("off again is still off", await setLowStock(store, pid, "", 7), "off");
  is("and gives nothing more back", totalOf(), before - held - 64);

  part("A slot left with no number (a save whose write never came) is given back by the next off");
  const lone = await addProduct("owner@example.com", "Cup", "", "30", null);
  if (!lone.ok) throw new Error("no product");
  const loneId = lone.product.id;
  await noteData(store, [{ slot: `ls:${loneId}`, bytes: LOW_STOCK_BYTES + 10, set: true }]);
  is("a slot held with no number", [redis.run(["HEXISTS", key, loneId]), Number(slotOf(loneId) ?? 0) > 0], [0, true]);
  is("off finds no number", await setLowStock(store, loneId, 0, null), "off");
  is("and still gives the slot back", slotOf(loneId), null);

  part("A save is its room and its number in one step: one never stands without the other");
  const writes = (id: string) => (c: (string | number)[]) =>
    (c[0] === "HSET" && c[1] === key && c[2] === id) || (c[0] === "EVAL" && String(c[1]).includes("low-stock-save") && c.includes(id));
  const offs = (id: string) => (c: (string | number)[]) =>
    (c[0] === "HDEL" && c[1] === key && c[2] === id) || (c[0] === "EVAL" && String(c[1]).includes("low-stock-off") && c.includes(id));
  const pipeline2 = redis.pipeline.bind(redis);
  redis.pipeline = async (commands) => (commands.some(writes(loneId)) ? [["ERR"]] : pipeline2(commands));
  is("a save whose write is not confirmed", await setLowStock(store, loneId, 5, 9), "unknown");
  redis.pipeline = pipeline2;
  is("leaves no number", redis.run(["HEXISTS", key, loneId]), 0);
  is("and no room held for it", slotOf(loneId), null);

  part("A save racing an off: the number and its room stand or fall together, whichever goes first");
  const racing = await addProduct("owner@example.com", "Jug", "", "30", null);
  if (!racing.ok) throw new Error("no product");
  const rid = racing.product.id;
  is("set first", await setLowStock(store, rid, 5, 9), "saved");
  // An off that runs while the save is on its way to its write (Codex G's MEDIUM on #3650).
  let offDuring = false;
  redis.pipeline = async (commands) => {
    if (!offDuring && commands.some(writes(rid))) {
      offDuring = true;
      redis.pipeline = pipeline2;
      await setLowStock(store, rid, 0, 9);
    }
    return pipeline2(commands);
  };
  is("the racing save", await setLowStock(store, rid, 6, 9), "saved");
  redis.pipeline = pipeline2;
  is("an off ran during it", offDuring, true);
  is("the number it wrote is there", typeof redis.run(["HGET", key, rid]), "string");
  is("and its room is held", together(rid), true);
  // A save that runs while the off is on its way to its delete (Codex G's reverse order, and Codex X6's stranded slot).
  let saveDuring = false;
  redis.pipeline = async (commands) => {
    if (!saveDuring && commands.some(offs(rid))) {
      saveDuring = true;
      redis.pipeline = pipeline2;
      await setLowStock(store, rid, 7, 9);
    }
    return pipeline2(commands);
  };
  is("the racing off", await setLowStock(store, rid, 0, 9), "off");
  redis.pipeline = pipeline2;
  is("a save ran during it", saveDuring, true);
  is("no number left", redis.run(["HEXISTS", key, rid]), 0);
  is("and no room left held for it", together(rid), true);
  is("set again", await setLowStock(store, rid, 5, 9), "saved");
  is("with its room", together(rid), true);

  part("A full data room writes nothing for a product whose room is not held");
  const fresh = await addProduct("owner@example.com", "Vase", "", "30", null);
  if (!fresh.ok) throw new Error("no product");
  await noteData(store, [{ slot: "filler", bytes: 10 ** 12, set: true }]);
  is("refused", await setLowStock(store, fresh.product.id, 5, 9), "full");
  is("nothing written", redis.run(["HEXISTS", key, fresh.product.id]), 0);
  is("and no room taken", slotOf(fresh.product.id), null);
  // A product whose number is set holds its room, so changing the number takes nothing more.
  is("a set number changed within the room it holds", await setLowStock(store, rid, 4, 9), "saved");
  // One turned off gave its room back, so it waits for room like any other.
  is("a number turned off and set again in a full room", await setLowStock(store, pid, 5, 9), "full");
  is("writes nothing", redis.run(["HEXISTS", key, pid]), 0);

  part("Its family is counted, said on closing and bounded");
  is("counted in the room", COUNTED_FAMILIES.includes("nl:ls:"), true);
  is("said on closing", [closingFamilyOf(key), CLOSING["nl:ls:"] !== undefined], ["nl:ls:", true]);
  is("in the registry", Object.keys(FAMILIES).some((name) => name.startsWith("nl:ls:@lib/low-stock.ts")), true);
  done();
}

void main();
