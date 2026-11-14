/**
 * A permanent bounce or a spam complaint on ANY of a store's emails, not only
 * on its list emails, takes that address off the store's list for good
 * (ALL-160, the owner's decision relayed by Claude 1; the HIGH of the #3925
 * hunt). Before, a checkout reminder, a review request, an update notice, a
 * community announcement or a receipt carried no tags, so the sender's notice
 * about it was ignored by heardFromSender and a person who complained kept
 * receiving that store's marketing.
 *
 * What these check, with synthetic stores and the sender stubbed:
 *   - a store's non-list email carries the store's list as a tag the reader
 *     never sees, and never the health tags (it is not counted, nor paused);
 *   - a hard bounce and a complaint on it, through Resend's signed webhook or
 *     an Amazon SES event, take the address off the list (contact `gone`);
 *   - a soft (transient) bounce takes nobody off;
 *   - the store's health counts are not touched by a non-list email;
 *   - a later receipt still goes, as it did (legal necessity, unchanged), and
 *     the address stays off the list.
 */
import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/mail/inbound/route";
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setSubscription, storeForEmail } from "@/lib/store";
import { isMailable, upsertContact } from "@/lib/contacts";
import { sendBatch, sendEmail } from "@/lib/email";
import { sendTo } from "@/lib/mail";
import { LIST_TAG, STORE_TAG, healthId, listHealth } from "@/lib/mail-health";
import { recordSesEvent } from "@/lib/mail-report";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { installSesMailFixture } from "./ses-mail-fixture";

const OWNER = "owner@example.com";
const SECRET_BYTES = Buffer.from("a-stand-in-secret-for-tests-only");
const mail = installSesMailFixture();

let announced = 0;
function announce(type: string, data: Record<string, unknown>): NextRequest {
  announced += 1;
  const id = `msg_tx_${announced}`;
  const at = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({ type, created_at: new Date().toISOString(), data });
  const signature = createHmac("sha256", SECRET_BYTES).update(`${id}.${at}.${body}`).digest("base64");
  return new NextRequest("https://marktmorgen.com/api/mail/inbound", {
    method: "POST",
    headers: { host: "marktmorgen.com", "content-type": "application/json", "content-length": String(Buffer.byteLength(body)), "svix-id": id, "svix-timestamp": at, "svix-signature": `v1,${signature}` },
    body,
  });
}

/** The tags of the last captured email to `to`, as the sender gives them back with its notice. */
function tagsTo(to: string): Record<string, string> {
  const found = [...mail.sent].reverse().find((m) => m.to.includes(to));
  return Object.fromEntries((found?.tags ?? []).map((t) => [t.name, t.value]));
}

async function main(): Promise<void> {
  redis.clear();
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  process.env.RESEND_API_KEY = "re_test_tx_bounce_only_a_stand_in";
  process.env.RESEND_WEBHOOK_SECRET = `whsec_${SECRET_BYTES.toString("base64")}`;
  delete process.env.RESEND_INBOUND_API_KEY;
  delete process.env.SUPPORT_FORWARD_TO;

  const made = await claimHandle(OWNER, "quayside", "Quayside Prints", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_TxOwner0001", subscriptionId: "sub_TxOwner0001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Quayside Prints", address: "1 Main St, Portland, OR 97201" });
  const store = (await storeForEmail(OWNER))!;
  const list = store.listId as string;
  const id = healthId(store);
  const people = ["hard@example.com", "spam@example.com", "soft@example.com", "sesbounce@example.com", "batch@example.com"];
  for (const p of people) await upsertContact(list, p, { agreed: true, explicit: true, source: "free" }, ROOM);
  is("everyone starts on the list", await Promise.all(people.map((p) => isMailable(list, p))), people.map(() => true));

  const transactional = (to: string, subject: string) => sendEmail({
    meter: { by: "store", store, kind: "email" },
    from: "Quayside Prints <hello@marktmorgen.com>",
    to,
    subject,
    text: "You left something in your cart.",
  });

  part("A store's non-list email says whose list it is, without the health tags");
  is("a checkout reminder goes", await transactional("hard@example.com", "Your cart"), true);
  const tags = tagsTo("hard@example.com");
  is("it names the store's list", Object.values(tags).includes(list), true);
  is("it carries neither health tag: a non-list email is not counted or paused for", [STORE_TAG in tags, LIST_TAG in tags], [false, false]);

  part("A permanent bounce on it takes the address off the list (Resend)");
  const hard = await POST(announce("email.bounced", { email_id: "tx_hard", to: ["hard@example.com"], bounce: { type: "Permanent" }, tags: tagsTo("hard@example.com") }));
  is("heard", hard.status, 200);
  is("off the list after a hard bounce on a checkout reminder", await isMailable(list, "hard@example.com"), false);

  part("A complaint on it takes the address off the list (Resend)");
  await transactional("spam@example.com", "Tell us how it went");
  const spam = await POST(announce("email.complained", { email_id: "tx_spam", to: ["spam@example.com"], tags: tagsTo("spam@example.com") }));
  is("heard", spam.status, 200);
  is("off the list after a complaint on a review request", await isMailable(list, "spam@example.com"), false);
  const later = await sendTo(store, ["spam@example.com", "soft@example.com"], "News", "New prints are in.", "tx:news");
  is("the next list email leaves the complainer out", later.done.includes("spam@example.com"), false);

  part("A permanent bounce through Amazon SES does the same");
  await transactional("sesbounce@example.com", "An update to your download");
  await recordSesEvent({ kind: "bounced", permanent: true, recipients: ["sesbounce@example.com"], tags: tagsTo("sesbounce@example.com"), messageId: "ses_tx_hard", occurredAt: Date.now() });
  is("off the list after a hard bounce on an update notice", await isMailable(list, "sesbounce@example.com"), false);

  part("A batch of non-list email (announcements, update notices) carries the same tag");
  await transactional("batch@example.com", "warm-up");
  const batchTags = tagsTo("batch@example.com");
  mail.clearCaptured();
  const batch = await sendBatch([{ from: "Quayside Prints <hello@marktmorgen.com>", to: "batch@example.com", subject: "A new post in the community", text: "Hello.", html: "<p>Hello.</p>", tags: batchTags }], "tx:batch", { by: "monthly" });
  is("the batch goes", batch, "sent");
  await recordSesEvent({ kind: "complained", permanent: false, recipients: ["batch@example.com"], tags: tagsTo("batch@example.com"), messageId: "ses_tx_batch", occurredAt: Date.now() });
  is("off the list after a complaint on a community announcement", await isMailable(list, "batch@example.com"), false);

  part("A soft bounce takes nobody off");
  await transactional("soft@example.com", "Your cart");
  const soft = await POST(announce("email.bounced", { email_id: "tx_soft", to: ["soft@example.com"], bounce: { type: "Transient" }, tags: tagsTo("soft@example.com") }));
  is("heard and ignored", [soft.status, (await soft.json()).result], [200, "ignored"]);
  is("still on the list after a full mailbox", await isMailable(list, "soft@example.com"), true);
  await recordSesEvent({ kind: "bounced", permanent: false, recipients: ["soft@example.com"], tags: tagsTo("soft@example.com"), messageId: "ses_tx_soft", occurredAt: Date.now() });
  is("nor after a transient SES bounce", await isMailable(list, "soft@example.com"), true);

  part("Non-list email never moves the store's health counts");
  is("no bounce or complaint counted for the store", [(await listHealth(id)).bounced, (await listHealth(id)).complained], [0, 0]);

  part("A later receipt still follows the existing rule");
  is("the complainer's receipt still goes (legal necessity)", await sendEmail({ meter: { by: "order" }, from: "Quayside Prints <hello@marktmorgen.com>", to: "spam@example.com", subject: "Your receipt", text: "Thank you for your order." }), true);
  is("and they stay off the list", await isMailable(list, "spam@example.com"), false);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
