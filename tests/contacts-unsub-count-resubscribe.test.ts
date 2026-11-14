/**
 * The list's count of people who left (`:unsub`) holds only people who had
 * agreed and then left: an unsubscribe, a bounce, an erasure and an import
 * each move it only for somebody who agreed. A contact brought in already
 * unsubscribed from another platform (agreed false, unsub true) was never in
 * it, yet their own later yes took one from it, so the studio showed one more
 * person who can be emailed than there is. Synthetic data only.
 */
import { importContactRows, listCounts, unsubKey, upsertContact } from "@/lib/contacts";
import { claimHandle, ensureListId, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";

const OWNER = "unsub-count@example.com";

async function main(): Promise<void> {
  redis.clear();
  const made = await claimHandle(OWNER, "unsub-count", "Unsub Count", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_UnsubCnt01", subscriptionId: "sub_UnsubCnt01", active: true, tier: "pro", period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  const listId = store.listId as string;

  part("Somebody who agreed and left, then said yes again, as before");
  await upsertContact(listId, "kept@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  await importContactRows(listId, [{ email: "left@example.com", name: "", tags: [], consent: "unsubscribed" }], store);
  const start = await listCounts(listId);
  is("one agreed, nobody who agreed has left", [start.agreed, start.left, start.mailable], [1, 0, 1]);

  part("Brought in unsubscribed, then their own yes: the count of those who left is not touched");
  await upsertContact(listId, "left@example.com", { agreed: true, explicit: true, source: "buyer", at: new Date(Date.now() + 60_000).toISOString() }, ROOM);
  const after = await listCounts(listId);
  is("two agreed, two to email, nobody left", [after.agreed, after.left, after.mailable], [2, 0, 2]);
  // Read as shown it is clamped at nothing; stored at -1, the next person who leaves would be counted as nobody.
  is("the stored count of those who left stays at nothing, never -1", Number((await redis.pipeline([["GET", unsubKey(listId)]]))[0] ?? 0), 0);
  done();
}

void main();
