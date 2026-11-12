/**
 * An email's narrowing or group that cannot be read exactly is refused, never
 * widened. createBroadcast read `narrow` with readNarrow, which drops a value
 * it does not know (45 quiet days, a negative spend, an unknown buyer group),
 * and `who` fell back to "all" for anything else: a request that asked for a
 * smaller group went to the whole list, while a draft and a kept record with
 * the same narrowing are refused (sameNarrow). Synthetic data only.
 */
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setSubscription, storeForEmail } from "@/lib/store";
import { upsertContact } from "@/lib/contacts";
import { createBroadcast } from "@/lib/broadcasts";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";

const OWNER = "narrow-refused@example.com";

async function main(): Promise<void> {
  redis.clear();
  const made = await claimHandle(OWNER, "narrow-refused", "Narrow Refused", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_NarrowRef1", subscriptionId: "sub_NarrowRef1", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Narrow Refused", address: "1 Main St, Portland, OR 97201" });
  const store = (await storeForEmail(OWNER))!;
  for (const name of ["ana", "ben"]) await upsertContact(store.listId as string, `${name}@example.com`, { agreed: true, explicit: true, source: "free" }, ROOM);
  const base = { subject: "News", body: "Hello.", productId: "", notProductId: "", sendAt: Date.now() + 86_400_000 };
  const reason = (r: Awaited<ReturnType<typeof createBroadcast>>) => (r.ok ? `made for ${r.broadcast.total}, narrow ${JSON.stringify(r.broadcast.narrow)}, who ${r.broadcast.who}` : r.reason);

  part("A narrowing that cannot be read exactly is refused, not dropped");
  is("45 quiet days is not a choice", reason(await createBroadcast(store, { ...base, narrow: { minSpent: 0, channel: "", quietDays: 45 } })), "narrow");
  is("a negative spend", reason(await createBroadcast(store, { ...base, narrow: { minSpent: -1, channel: "", quietDays: 0 } })), "narrow");
  is("an unknown buyer group", reason(await createBroadcast(store, { ...base, narrow: { minSpent: 0, channel: "", quietDays: 0, group: "whales" } })), "narrow");
  is("a narrowing of another shape", reason(await createBroadcast(store, { ...base, narrow: "quiet" })), "narrow");

  part("A group of people that is not one of the three is refused, not everyone");
  is("who: buyer", reason(await createBroadcast(store, { ...base, who: "buyer" })), "who");

  part("What the studio sends is unchanged");
  is("no narrowing", reason(await createBroadcast(store, { ...base, narrow: null })), "made for 2, narrow null, who all");
  is("everyone, said", reason(await createBroadcast(store, { ...base, who: "all" })), "made for 2, narrow null, who all");
  is("an empty narrowing, every field at none", reason(await createBroadcast(store, { ...base, narrow: { minSpent: 0, channel: "", quietDays: 0 } })), "made for 2, narrow null, who all");
  done();
}

void main();
