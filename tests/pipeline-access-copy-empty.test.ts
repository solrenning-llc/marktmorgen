/**
 * Copying a teammate's restrictions to a new sign-in address (copyPipelineAccess) when the old address has none: an
 * empty record the new address held from before is deleted, so the teammate keeps full access. Kept, it would read
 * as a record that opens nothing (Codex X5, MEDIUM on #2036 @cb54a473f4; re-proved by Claude 6 on #2048).
 */
import { copyPipelineAccess, readPipelineAccess } from "@/lib/pipeline-access";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  part("An empty record at the new address goes when the old address has no restriction");
  redis.clear();
  const store = { ...ROOM, statsId: ROOM.statsId ?? "stats_copy_empty" };
  const key = `nl:crm:pacc:${store.statsId}`;
  await redis.pipeline([["HSET", key, "new@example.com", ""]]);
  const copy = await copyPipelineAccess(store, "old@example.com", "new@example.com");
  const [field] = await redis.pipeline([["HGET", key, "new@example.com"]]);
  is("the field is gone and the teammate has full access", [field, await readPipelineAccess(store.statsId, "new@example.com")], [null, {}]);
  is("the copy says what the new address held, for a move that fails after it", copy, { prior: "", now: null });

  part("Nothing at either address changes nothing");
  redis.clear();
  is("no record, no change", await copyPipelineAccess(store, "old@example.com", "new@example.com"), { prior: null, now: null });
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
