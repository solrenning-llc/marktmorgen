/**
 * Issue #4080: deleting a store left its Store assistant add-on ($69 a month)
 * renewing for good. The plan's subscription is looked for before a store is
 * deleted, the add-on's was not; once the store's address is let go, the daily
 * billing sync no longer finds its store (lib/assistant-billing.ts
 * applyListedAssistant reads it by `assistant_for`) and nothing ever stops it.
 *
 *   - a store whose add-on is running and renews is not deleted (reason
 *     "assistant"), under the store's lock in lib/store.ts deleteStore;
 *   - one whose add-on is set to stop at the end of the month paid, has ended,
 *     or was never bought, is deleted as before;
 *   - the studio's delete brings the add-on in line with Stripe first
 *     (syncAssistant, which sets it to stop when the plan is not paid), and the
 *     studio says why nothing was deleted.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { claimHandle, createStore, deleteStore, ensureStatsId, setAssistantPlan, storeForHandle, storeRef } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const SUB = "sub_" + "a".repeat(14);

async function spareStore(owner: string, handle: string) {
  const made = await createStore(owner, handle, "Spare", "");
  if (!made.ok) throw new Error(`no store ${handle}`);
  return made.store;
}

async function main(): Promise<void> {
  redis.clear();
  const owner = "maker@example.com";
  await claimHandle(owner, "maker-home", "Maker Home", "");
  await ensureStatsId(owner);

  part("A store whose add-on still renews is not deleted");
  const renewing = await spareStore(owner, "maker-renewing");
  await setAssistantPlan(storeRef(renewing), { subscriptionId: SUB, active: true, period: { start: 1, end: 2_000_000_000, renews: true }, cancelsAtEnd: false, disputedAt: "" });
  const refused = await deleteStore(storeRef(renewing));
  is("refused, with the add-on as the reason", refused.ok ? "deleted" : refused.reason, "assistant");
  is("the store is still there, so the daily sync still finds its add-on", (await storeForHandle("maker-renewing"))?.handle, "maker-renewing");

  part("Deleted once the add-on cannot charge again");
  const stopping = await spareStore(owner, "maker-stopping");
  await setAssistantPlan(storeRef(stopping), { subscriptionId: SUB, active: true, period: { start: 1, end: 2_000_000_000, renews: false }, cancelsAtEnd: true, disputedAt: "" });
  is("one set to stop at the end of the month paid", (await deleteStore(storeRef(stopping))).ok, true);
  const ended = await spareStore(owner, "maker-ended");
  await setAssistantPlan(storeRef(ended), { subscriptionId: SUB, active: false, period: null, cancelsAtEnd: false, disputedAt: "" });
  is("one whose add-on has ended", (await deleteStore(storeRef(ended))).ok, true);
  const never = await spareStore(owner, "maker-never");
  is("one that never had it", (await deleteStore(storeRef(never))).ok, true);

  part("The studio's delete");
  const route = readFileSync(join(process.cwd(), "app/api/store/stores/route.ts"), "utf8");
  is("asks Stripe about the add-on before deleting", /syncAssistant\(/.test(route) && route.indexOf("syncAssistant(") < route.indexOf("deleteStore(ref)"), true);
  const page = readFileSync(join(process.cwd(), "app/studio/page.tsx"), "utf8");
  is("and the studio says why nothing was deleted", /\n  assistant: \{\n    title: "This store still has its Store assistant running"/.test(page), true);

  done();
}

main();
