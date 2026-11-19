/**
 * #4871, Codex L (MEDIUM, privacy): this PR keeps the exact paths of a person's files still to be deleted in
 * nl:erase:files:<listId>:<suppressionPrint> until a deletion finishes. Those paths are data about the person, but the
 * copy (lib/person-copy.ts) named the module "marks" and never read them, so a copy asked for before the repeat was
 * "complete" without them. The module is now copied: the set is read exactly, and a reply that does not read is
 * unknown, never a copy that leaves it out. Synthetic store and Redis only; a fictional address.
 */
import { claimHandle, ensureListId, ensureStatsId, storeForEmail } from "@/lib/store";
import { erasureScope } from "@/lib/person-erasure";
import { COPIERS, COPY_PLAN, copyPerson } from "@/lib/person-copy";
import { suppressionPrint } from "@/lib/suppression";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "pending-copy@example.com";
const PERSON = "pending-person@example.com";
const original: typeof redis.pipeline = redis.pipeline.bind(redis);

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "pendingcopy", "Pending Copy", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  const store = (await storeForEmail(OWNER))!;
  const scope = (await erasureScope(store, PERSON))!;
  const key = `nl:erase:files:${scope.listId}:${suppressionPrint(scope.listId as string, PERSON)}`;
  const path = `stores/${store.statsId}/tasks/course/lesson/person/${"b".repeat(32)}.pdf`;

  part("The paths kept while a deletion is not finished are data the copy reads");
  is("the module is copied, not an empty mark", COPY_PLAN["lib/person-erasure.ts"]?.how, "copied");
  await original([["SADD", key, path], ["EXPIRE", key, 30 * 86_400]]);
  const copy = await copyPerson(scope);
  is("the copy holds the exact pending path", copy.sections.find((s) => s.module === "lib/person-erasure.ts")?.records, [path]);

  part("Nothing pending: an empty section, never an error");
  await original([["DEL", key]]);
  is("no paths, no records", await COPIERS["lib/person-erasure.ts"]?.(scope), []);

  part("A reply that does not read is unknown, never a copy without it");
  for (const [what, reply] of [["no reply", []], ["not a list", ["x"]], ["a member that is not text", [[1]]]] as [string, unknown[]][]) {
    redis.pipeline = (async (batch: (string | number)[][]) => (batch[0]?.[0] === "SMEMBERS" && batch[0]?.[1] === key ? reply : original(batch))) as typeof redis.pipeline;
    let said: string;
    try {
      await COPIERS["lib/person-erasure.ts"]?.(scope);
      said = "read";
    } catch (error) {
      said = error instanceof UnknownReplyError ? "unknown" : `other: ${String(error)}`;
    } finally {
      redis.pipeline = original;
    }
    is(`${what}: unknown`, said, "unknown");
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
