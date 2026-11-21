/**
 * A workflow's "tell me" step takes one of the store's monthly emails before it emails the owner (lib/flows.ts), and
 * gives it back only when that email was certainly not sent. An answer that is not known (an SES acknowledgement
 * lost) may have sent it, so the email stays counted, as every other send keeps one (lib/email.ts, SendOutcome).
 * Synthetic data only.
 */
import { saveFlow, enroll, sendDueSteps } from "@/lib/flows";
import { upsertContact } from "@/lib/contacts";
import { writeForm } from "@/lib/form-store";
import { parseForm } from "@/lib/forms";
import { windowId } from "@/lib/allowance-window";
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setStripeAccount, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { installSesMailFixture } from "./ses-mail-fixture";

const OWNER = "harbor@example.com";
let loseOwnerReply = false;
const mail = installSesMailFixture({
  fallback: () => new Response(JSON.stringify({ object: "list", data: [], has_more: false })),
  onSes: (message) => {
    if (loseOwnerReply && message.to.includes(OWNER)) throw new TypeError("synthetic SES reply lost after possible acceptance");
    return undefined;
  },
});

const run = () => sendDueSteps((handle) => storeForHandle(handle), Date.now() + 20_000);

async function main(): Promise<void> {
  redis.clear();
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  process.env.STRIPE_SECRET_KEY = "sk_test_notify_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_notify_only_a_stand_in";
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestNotify0001", true);
  await setSubscription(OWNER, { customerId: "cus_Notify0001", subscriptionId: "sub_Notify0001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Harbor Kitchen", address: "1 Main St, Portland, OR 97201" });
  let store = (await storeForEmail(OWNER))!;
  await writeForm(store.statsId!, parseForm({ id: "applyform1", name: "Application", fields: [{ id: "q1mail", type: "email", label: "Email", required: true }] })!);
  const saved = await saveFlow(store, { name: "Applicants", trigger: "form", formId: "applyform1", active: true, steps: [{ delayHours: 0, action: { do: "notify" } }] }, { activate: true });
  is("a sequence whose one step tells the owner", saved.ok, true);
  await upsertContact(store.listId!, "ana@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  store = (await storeForEmail(OWNER))!;
  const used = () => Number(redis.run(["GET", `nl:mail:used:${store.listId}:${windowId(store)}`]) ?? 0);

  part("The email to the owner may have gone: it stays counted");
  loseOwnerReply = true;
  await enroll(store, "ana@example.com", { joined: false, form: "applyform1" });
  for (let i = 0; i < 3; i += 1) await run();
  is("the owner's email was tried, and its answer lost", mail.sesAttempts.some((m) => m.to.includes(OWNER)), true);
  is("one of the month's emails stays taken for it", used(), 1);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
