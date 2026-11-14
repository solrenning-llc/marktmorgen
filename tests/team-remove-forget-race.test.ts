/**
 * #2036, Claude 5's focal 6731867647 (b): removing a teammate forgets what they could do with each pipeline under the
 * team's lock, so someone added back at once and restricted again never has that new restriction deleted by the
 * removal's cleanup. Without a record accessOf reads "edit" for every pipeline, so a lost restriction is a widened
 * permission. The teammate is added back and restricted on the first command after the lock, the index's SREM.
 * Synthetic store and Redis only.
 */
import { readPipelineAccess, setPipelineAccess } from "@/lib/pipeline-access";
import { claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { putMember, removeMember } from "@/lib/team";
import { ROOM } from "./data-room";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  redis.clear();
  const owner = "forgetrace@example.com";
  const sam = "sam@example.com";
  await claimHandle(owner, "forgetrace", "Forget Race", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setSubscription(owner, { customerId: "cus_ForgetRace01", subscriptionId: "sub_ForgetRace01", active: true, tier: "pro", period: paidPeriod() });
  const store = (await storeForEmail(owner))!;
  await putMember(store, sam, "support");
  await setPipelineAccess(store.statsId!, sam, ["sales0"], "sales0", "view", ROOM);

  part("Added back and restricted again while the removal finishes");
  const pipe = redis.pipeline.bind(redis);
  let raced = false;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (!raced && commands.some((c) => c[0] === "SREM" && String(c[1]).startsWith("nl:team:of:"))) {
      raced = true;
      await putMember(store, sam, "support");
      await setPipelineAccess(store.statsId!, sam, ["sales0"], "sales0", "none", ROOM);
    }
    return pipe(commands);
  }) as typeof redis.pipeline;
  const removed = await removeMember(store, sam).finally(() => { redis.pipeline = pipe; });
  is("the removal happened, and the re-add ran in its cleanup", [removed, raced], [true, true]);
  is("the new restriction is kept, never widened to edit", await readPipelineAccess(store.statsId, sam), { sales0: "none" });

  part("Control: a removal with nobody added back forgets their access");
  await setPipelineAccess(store.statsId!, sam, ["sales0"], "sales0", "view", ROOM);
  is("removed", await removeMember(store, sam), true);
  is("nothing kept for someone no longer on the team", await readPipelineAccess(store.statsId, sam), {});
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
