/**
 * A list batch tried again under the same key, after Amazon already took all
 * of it (the caller's progress write was lost), sends nobody again: the
 * provider layer answers "sent" with nothing dispatched. The month and the
 * store's health count must not be charged a second time for it.
 */
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setSubscription, storeForEmail } from "@/lib/store";
import { upsertContact } from "@/lib/contacts";
import { sendTo, usedThisMonth } from "@/lib/mail";
import { healthId, listHealth } from "@/lib/mail-health";
import { windowId } from "@/lib/allowance-window";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { installSesMailFixture } from "./ses-mail-fixture";

const OWNER = "recount@example.com";
const mail = installSesMailFixture();

async function main(): Promise<void> {
  redis.clear();
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  const made = await claimHandle(OWNER, "recount", "Recount Kitchen", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_Recount00001", subscriptionId: "sub_Recount00001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Recount Kitchen", address: "1 Main St, Portland, OR 97201" });
  const store = (await storeForEmail(OWNER))!;
  const emails = Array.from({ length: 10 }, (_, i) => `reader${i}@example.com`);
  for (const email of emails) await upsertContact(store.listId as string, email, { agreed: true, explicit: true, source: "free" }, ROOM);

  part("The same batch tried again after its result was lost");
  mail.clearCaptured();
  const first = await sendTo(store, emails, "Hello", "It is ready.", "bc:recount:0");
  const again = await sendTo(store, emails, "Hello", "It is ready.", "bc:recount:0");
  const ses = mail.sent.filter((m) => m.provider === "ses").length;
  is("ten emails went, once each", [first.stopped, again.stopped, ses], [null, null, 10]);
  is("the month is charged for the ten that went, not twenty", await usedThisMonth(store.listId, windowId(store)), 10);
  is("the store's health counts ten sent, not twenty", (await listHealth(healthId(store))).sent, 10);
  done();
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
