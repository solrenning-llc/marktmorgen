/**
 * The list of buyers an import brought (nl:imp:who:<statsId>, plain addresses) never gets back an address its
 * person's erasure removed (#4270, Codex L through Claude 1). importedFor backfills the list for a purchase imported
 * before the list existed, from a read made earlier; when the person's erasure (forgetImportedPerson) landed between
 * that read and the backfill, the HSETNX wrote the erased address back, and importedBuyers listed it for good.
 * The in-memory Redis stand-in, with the erasure let in right after importedFor's read. Synthetic only.
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { forgetImportedPerson, importedBuyers, importedFor, importedKey, importedWhoKey } from "@/lib/imported-purchases";
import type { Store } from "@/lib/store";

const STATS = "a".repeat(24);
const EMAIL = "erased-imported@example.com";
const OTHER = "kept-imported@example.com";
const store = { statsId: STATS, listId: "b".repeat(32), pastBuyers: true, sid: "c".repeat(24), handle: "importshop", catalog: { items: [] } } as unknown as Store;
const purchase = JSON.stringify({ at: 1_700_000_000, job: "d".repeat(24), items: null, option: null });

const original = redis.pipeline.bind(redis);
let between: (() => Promise<void>) | null = null;
(redis as unknown as { pipeline: typeof original }).pipeline = async (commands) => {
  const replies = await original(commands);
  const hook = between;
  if (hook && commands.some((c) => c[0] === "HGETALL" && String(c[1]).startsWith(`nl:imp:buy:${STATS}:`))) {
    between = null;
    await hook();
  }
  return replies;
};

async function main(): Promise<void> {
  redis.clear();
  // Two purchases imported before the list of who was brought existed: no entry in nl:imp:who yet.
  await original([["HSET", importedKey(STATS, EMAIL), "prod_1", purchase], ["HSET", importedKey(STATS, OTHER), "prod_1", purchase]]);

  part("Control: a person still here is noted on the list the first time their purchases are read");
  await importedFor(store, OTHER);
  is("noted", (await original([["HEXISTS", importedWhoKey(STATS), OTHER]]))[0], 1);

  part("#4270: the person is erased between importedFor's read and its backfill");
  between = async () => void (await forgetImportedPerson(STATS, EMAIL));
  const read = await importedFor(store, EMAIL);
  is("the read itself saw the purchase", read.length, 1);
  is("their purchases are gone", (await original([["EXISTS", importedKey(STATS, EMAIL)]]))[0], 0);
  is("their address is not written back on the list", (await original([["HEXISTS", importedWhoKey(STATS), EMAIL]]))[0], 0);
  const buyers = await importedBuyers(STATS);
  is("and the creator's imported buyers never list it, only the person still here", [...buyers.keys()], [OTHER]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
