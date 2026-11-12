/**
 * Issue #4080 (money): deleting an extra store whose Store assistant is still running left the add-on's
 * subscription charging every month for a store that no longer exists. The plan's own subscriptions are
 * found and ended by the route, but nothing finds the assistant's once the store's address is released
 * (lib/assistant-billing.ts applyListedAssistant reads storeForHandle, null after the deletion).
 *
 * So deleteStore refuses while the assistant is active and not set to stop ("assistant"), as it refuses a
 * plan in good standing ("paying"). Once the owner sets it to stop at the end of the month paid, nothing more
 * is charged and the store can go. Synthetic only.
 */
import { readFileSync } from "node:fs";
import { claimHandle, createStore, deleteStore, ensureStatsId, setAssistantPlan, storeForId, storeRef } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const running = { subscriptionId: "sub_assistant4080", active: true, period: { start: 1_800_000_000, end: 1_802_592_000, renews: true }, cancelsAtEnd: false, disputedAt: "" };

async function spareStore(owner: string, handle: string) {
  const made = await createStore(owner, handle, `${handle} store`, "");
  if (!made.ok) throw new Error(`no extra store: ${JSON.stringify(made)}`);
  return (await storeForId(made.store.sid))!;
}

async function main(): Promise<void> {
  redis.clear();
  const owner = "maker@example.com";
  await claimHandle(owner, "maker-home", "Maker Home", "");
  await ensureStatsId(owner);

  part("An extra store whose assistant still charges");
  const spare = await spareStore(owner, "maker-spare");
  await setAssistantPlan(storeRef(spare), running);
  const refused = await deleteStore(storeRef(spare));
  is("deleting it is refused, so the add-on is never left charging for a store that is gone",
    refused.ok ? "deleted" : refused.reason, "assistant");
  is("and the store is still there", (await storeForId(spare.sid))?.handle, "maker-spare");

  part("Once the assistant is set to stop");
  await setAssistantPlan(storeRef(spare), { ...running, cancelsAtEnd: true });
  const stopping = await deleteStore(storeRef(spare));
  is("the store can be deleted: nothing more is charged after the month paid", stopping.ok, true);

  part("Controls");
  const ended = await spareStore(owner, "maker-ended");
  await setAssistantPlan(storeRef(ended), { ...running, active: false });
  is("an assistant that has ended does not hold the store back", (await deleteStore(storeRef(ended))).ok, true);
  const none = await spareStore(owner, "maker-none");
  is("a store that never had the assistant is deleted as before", (await deleteStore(storeRef(none))).ok, true);

  part("What the owner is told");
  const studio = readFileSync("app/studio/page.tsx", "utf8");
  is("the studio has its own notice for the refusal, pointing at the assistant's stop button",
    /assistant:\s*\{\s*title: "This store's Store assistant is still running"/.test(studio) && studio.includes("Stop at the end of this month"), true);

  done();
}

void main();
