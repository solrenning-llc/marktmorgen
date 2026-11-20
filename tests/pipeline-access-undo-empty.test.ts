/**
 * Putting back what the new address held before a copy (undoPipelineAccessCopy): a stored empty record is put back
 * as it was, never deleted, since an empty record opens nothing and a deleted one reads as no restriction (Claude 4,
 * cloud I, on #2036). The same on the path of a copy that could not be confirmed (undoUnconfirmedCopy; Claude 7's
 * quality review of #2036 @89ea77991f, LEVE 1).
 */
import { PipelineAccessCopyUnconfirmed, readPipelineAccess, undoPipelineAccessCopy, undoUnconfirmedCopy } from "@/lib/pipeline-access";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  part("An empty record held before the copy is put back as it was");
  redis.clear();
  const store = { ...ROOM, statsId: ROOM.statsId ?? "stats_undo_empty" };
  const key = `nl:crm:pacc:${store.statsId}`;
  await redis.pipeline([["HSET", key, "sam2@example.com", JSON.stringify({ sales0: "view" })]]);
  await undoPipelineAccessCopy(store, "sam2@example.com", { prior: "", now: JSON.stringify({ sales0: "view" }) });
  const [kept] = await redis.pipeline([["HGET", key, "sam2@example.com"]]);
  is("the field holds the empty record again, which opens nothing", [kept, await readPipelineAccess(store.statsId, "sam2@example.com")], ["", null]);

  part("An empty record held before a copy that could not be confirmed is put back as it was");
  redis.clear();
  await redis.pipeline([["HSET", key, "sam3@example.com", JSON.stringify({ sales0: "view" })]]);
  await undoUnconfirmedCopy(store, "sam3@example.com", new PipelineAccessCopyUnconfirmed({ prior: "", now: JSON.stringify({ sales0: "view" }) }, 0));
  const [held] = await redis.pipeline([["HGET", key, "sam3@example.com"]]);
  is("the field holds the empty record again, never deleted into no restriction", [held, await readPipelineAccess(store.statsId, "sam3@example.com")], ["", null]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
