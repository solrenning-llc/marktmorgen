/**
 * An extra store whose plan ended is closing: its members' charges are held, and on its closing day they are
 * refunded what they paid for and lost, and told (lib/closing-holds.ts, lib/plan-closing.ts). Deleting it by hand
 * then took its record away, so the daily runs dropped it from every line as "gone": its members stayed paused at
 * Stripe for good, the refunds were never made and the buyers were never told (Claude 7's hunt). It is refused now,
 * as moving it to another sign-in already is (closingUnderway, lib/store.ts); a line that does not read refuses too.
 */
import { claimHandle, createStore, deleteStore, setSubscription, storeForId, storeRef } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  redis.clear();
  const owner = "closer@example.com";
  await claimHandle(owner, "closer-home", "Closer Home", "");

  part("A store whose plan ended is not deleted while it closes");
  const ended = await createStore(owner, "closer-ended", "Closer Ended", "");
  if (!ended.ok) throw new Error("no second store");
  const ref = storeRef(ended.store);
  await setSubscription(ref, { customerId: "cus_closerended1", subscriptionId: "sub_closerended1", active: true, tier: "creator", cycle: "month", trialEnds: 0 });
  await setSubscription(ref, { active: false });
  // Its members' charges are held from the day its plan ended (holdCharges).
  await redis.pipeline([["ZADD", "nl:closing:held", Date.now(), ref]]);
  const refused = await deleteStore(ref);
  is("refused, as closing", refused.ok ? "deleted" : refused.reason, "closing");
  is("its record stays, so the closing can still refund and tell its buyers", (await storeForId(ended.store.sid))?.handle, "closer-ended");

  part("A store in a closing line is not deleted either");
  const lined = await createStore(owner, "closer-lined", "Closer Lined", "");
  if (!lined.ok) throw new Error("no third store");
  await redis.pipeline([["ZADD", "nl:closing:final", Date.now() - 30 * 86_400_000, storeRef(lined.store)]]);
  const inLine = await deleteStore(storeRef(lined.store));
  is("refused while in its closing day", inLine.ok ? "deleted" : inLine.reason, "closing");

  part("A line that does not read is never \"not closing\"");
  const unread = await createStore(owner, "closer-unread", "Closer Unread", "");
  if (!unread.ok) throw new Error("no fourth store");
  const realPipeline = redis.pipeline.bind(redis);
  // Redis answers the held line's ZSCORE with something that is not a score or nil.
  redis.pipeline = async (commands: Parameters<typeof realPipeline>[0]) => {
    const real = await realPipeline(commands);
    return commands.map((command, i) => (command[0] === "ZSCORE" && command[1] === "nl:closing:held" ? "garbled" : real[i]));
  };
  let outcome = "";
  try {
    const result = await deleteStore(storeRef(unread.store));
    outcome = result.ok ? "deleted" : result.reason;
  } catch {
    outcome = "threw";
  } finally {
    redis.pipeline = realPipeline;
  }
  is("nothing is deleted", [outcome === "deleted", (await storeForId(unread.store.sid))?.handle], [false, "closer-unread"]);

  part("Control: an empty extra store that never had a plan is deleted as before");
  const spare = await createStore(owner, "closer-spare", "Closer Spare", "");
  if (!spare.ok) throw new Error("no fifth store");
  is("deleted", (await deleteStore(storeRef(spare.store))).ok, true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
