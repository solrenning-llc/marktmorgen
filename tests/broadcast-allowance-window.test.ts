/**
 * An email to the list that would go past the month is refused before it
 * starts, in the month as the plan counts it (lib/broadcasts.ts,
 * createBroadcast; found by the review of 460 [EL4], 1 November 2026).
 *
 * The check used the calendar month while every batch is reserved in the
 * plan's own window (lib/allowance-window.ts, windowId): for a paid store
 * that is a window starting on its billing day, so the check read a count
 * nothing adds to, let the email start and sent part of it, the rest
 * waiting for the next window. Checked here:
 *
 *   - with fewer emails left in the plan's window than people, the email is
 *     refused with "allowance" and nothing is written;
 *   - with enough left, it is made;
 *   - the calendar month's count no longer decides either way.
 */
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setSubscription, storeForEmail } from "@/lib/store";
import { upsertContact } from "@/lib/contacts";
import { createBroadcast } from "@/lib/broadcasts";
import { monthlyAllowance } from "@/lib/mail";
import { calendarWindow, windowId } from "@/lib/allowance-window";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";

const OWNER = "owner@example.com";
globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  const made = await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, tier: "scale", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Harbor Kitchen", address: "1 Main St, Portland, OR 97201" });
  const store = (await storeForEmail(OWNER))!;
  for (let i = 0; i < 30; i += 1) await upsertContact(store.listId as string, `reader${i}@example.com`, { agreed: true, explicit: true, source: "free" }, ROOM);
  const window = windowId(store);
  const allowance = monthlyAllowance(store);
  is("a paid store's window is its own, not the calendar month", window !== null && window !== calendarWindow().id, true);
  const used = (count: number, id: string) => redis.run(["SET", `nl:mail:used:${store.listId}:${id}`, String(count)]);
  const send = () => createBroadcast(store, { subject: "The plan is here", body: "It is ready.", productId: "", notProductId: "", sendAt: undefined });

  part("Past what is left in the plan's window");
  used(allowance - 10, window!);
  used(0, calendarWindow().id);
  const refused = await send();
  is("thirty people, ten emails left: refused before it starts", refused.ok ? "made" : refused.reason, "allowance");
  is("and nothing was written", redis.keys().some((k) => k.startsWith("nl:mail:bc")), false);

  part("Inside it");
  used(allowance - 40, window!);
  used(allowance, calendarWindow().id);
  const taken = await send();
  is("forty left: made, whatever the calendar month's count says", taken.ok, true);
  is("and written where broadcasts are kept, so the check above looked in the right place", redis.keys().some((k) => k.startsWith("nl:mail:bc")), true);
  done();
}

void main();
