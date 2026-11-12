/**
 * #4270 (Codex L, hidden #3945): importedFor (lib/imported-purchases.ts) backfills the list of buyers an import brought
 * (nl:imp:who:<statsId>, plain addresses) with an HSETNX taken from a read made before the person's erasure; landing
 * after forgetImportedPerson, it writes the erased address back, past the erasure print that grantImported respects.
 * Synthetic only (in-memory Redis stand-in).
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { forgetImportedPerson, importedBuyers, importedFor, importedKey, importedWhoKey } from "@/lib/imported-purchases";
import { suppressCommand } from "@/lib/suppression";
import type { Store } from "@/lib/store";

const STATS = "zz3945stats";
const LIST = "zz3945list";
const EMAIL = "erased-imported@example.com";
const store = { statsId: STATS, listId: LIST, pastBuyers: true, sid: "zz3945sid", handle: "zz3945", catalog: { items: [] } } as unknown as Store;

async function main(): Promise<void> {
  redis.clear();
  // An imported purchase written before the list of who was brought existed (no entry in nl:imp:who yet).
  await redis.pipeline([["HSET", importedKey(STATS, EMAIL), "prod_1", JSON.stringify({ at: 1_700_000_000, job: "a".repeat(24), items: null, option: null })]]);

  part("a page reads the buyer's imported purchases; the person's erasure completes before the backfill write");
  const original = redis.pipeline.bind(redis);
  let erased = -1;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const replies = await original(commands);
    if (erased < 0 && commands[0]?.[0] === "HGETALL" && commands[0]?.[1] === importedKey(STATS, EMAIL)) {
      // The erasure, as person-erasure.ts runs it: the print first, then this module's eraser.
      await original([suppressCommand(LIST, EMAIL)]);
      erased = await forgetImportedPerson(STATS, EMAIL);
    }
    return replies;
  }) as typeof redis.pipeline;
  const found = await importedFor(store, EMAIL).catch((error: unknown) => String(error));
  redis.pipeline = original;

  is("(control) the read was taken before the erasure and saw the purchase", Array.isArray(found) ? found.length : found, 1);
  is("(control) the erasure deleted the purchase", redis.run(["EXISTS", importedKey(STATS, EMAIL)]), 0);
  is("after completed erasure, the erased address is not among the buyers an import brought", redis.run(["HGET", importedWhoKey(STATS), EMAIL]), null);
  is("after completed erasure, the creator's imported-buyer list does not name them", (await importedBuyers(STATS)).has(EMAIL), false);

  part("a buyer who was not deleted is still noted the first time their imported purchases are read");
  const KEPT = "kept-imported@example.com";
  await redis.pipeline([["HSET", importedKey(STATS, KEPT), "prod_1", JSON.stringify({ at: 1_700_000_100, job: "b".repeat(24), items: null, option: null })]]);
  is("(control) not on the list of buyers brought before the read", redis.run(["HGET", importedWhoKey(STATS), KEPT]), null);
  is("(control) the read finds the purchase", (await importedFor(store, KEPT)).length, 1);
  is("and their address is noted among the buyers an import brought, at when it was brought", redis.run(["HGET", importedWhoKey(STATS), KEPT]), "1700000100");
  is("so the creator's imported-buyer list names them", (await importedBuyers(STATS)).has(KEPT), true);
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
