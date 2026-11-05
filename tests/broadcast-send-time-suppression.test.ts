/**
 * Who an email to the list reaches is decided again at the moment each batch
 * goes (lib/broadcasts.ts advanceBroadcast, lib/mail.ts sendTo,
 * lib/contacts.ts tokensFor; ClickFunnels audit F25 and F27, added
 * 17 October 2026).
 *
 * A broadcast writes down its recipients when it starts, so a long send
 * neither skips anyone nor writes to anyone twice. That snapshot must never
 * outrank somebody's no: a send can outlive one run, a subject test holds
 * the rest of the list back for hours, and a scheduled email is listed long
 * before it goes. Checked here on one listed broadcast:
 *
 *   - an address that unsubscribed through the link after the list was
 *     written down is not written to;
 *   - nor one whose email bounced for good, or that marked an email as spam,
 *     since (the sender's notices, lib/contacts.ts stopWriting);
 *   - nor one that is no longer on the list at all;
 *   - everybody else is written to once, with an unsubscribe link and the
 *     one-click header, and the broadcast completes;
 *   - an unsubscribe that a lost write would undo stays: two unsubscribes
 *     and the send meeting on one contact never put the address back.
 */
import { advanceBroadcast } from "@/lib/broadcasts";
import { claimHandle, ensureListId, setMailSettings, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { leadsKey, stopWriting, tokensFor, unsubscribe, upsertContact } from "@/lib/contacts";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { installSesMailFixture } from "./ses-mail-fixture";

async function main(): Promise<void> {
  redis.clear();
  const owner = "letters@example.com";
  await claimHandle(owner, "letters", "Letters Shop", "");
  await ensureListId(owner);
  await setSubscription(owner, { customerId: "cus_Letters0001", subscriptionId: "sub_Letters0001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(owner, { fromName: "Letters Shop", address: "4 Paper Lane, Boston, MA 02108" });
  const store = (await storeForEmail(owner))!;
  const listId = store.listId!;
  const everyone = ["stays@example.com", "left@example.com", "bounced@example.com", "spam@example.com", "gone@example.com", "also@example.com"];
  for (const email of everyone) await upsertContact(listId, email, { agreed: true, explicit: true, source: "free" }, ROOM);

  process.env.RESEND_API_KEY = "re_test_send_time_suppression_only";
  const mail = installSesMailFixture();
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  const messages = mail.ses;

  part("The list as it was written down when the email started");
  const id = "222222222222222222222222";
  const key = `nl:mail:bc:${id}`;
  const broadcast = { id, listId, handle: store.handle, subject: "New paper is in", body: "Fresh stock this week.", productId: null, notProductId: null, who: "all", narrow: null, status: "sending", createdAt: 100, sendAt: 100, finishedAt: 0, total: everyone.length, sent: 0, note: "", failures: 0, listed: true, tagged: true, test: null };
  await redis.pipeline([["SET", key, JSON.stringify(broadcast)], ["RPUSH", `${key}:to`, ...everyone], ["SADD", "nl:mail:queue", id]]);

  part("Then, before it goes, people change their minds");
  const tokens = await tokensFor(listId, ["left@example.com"], store.handle);
  is("one leaves through the link in an earlier email", (await unsubscribe(tokens.get("left@example.com") ?? ""))?.email, "left@example.com");
  is("one bounces for good", await stopWriting(listId, "bounced@example.com", "bounced"), true);
  is("one marks an email as spam", await stopWriting(listId, "spam@example.com", "complained"), true);
  await redis.pipeline([["HDEL", leadsKey(listId), "gone@example.com"]]);

  part("What goes out");
  const result = await advanceBroadcast(id, storeForHandle, Date.now() + 10_000);
  const reached = messages.flatMap((m) => m.to).sort();
  is("only the two who still may be written to", reached, ["also@example.com", "stays@example.com"]);
  is("each with the one-click unsubscribe header and a working link", messages.every((m) => /^<https:\/\/[^>]+\/api\/mail\/unsubscribe\?t=[0-9a-f]{40}>$/.test(m.headers?.["List-Unsubscribe"] ?? "") && m.headers?.["List-Unsubscribe-Post"] === "List-Unsubscribe=One-Click"), true);
  is("the broadcast completes through SES without Resend fallback", [result?.status, mail.resend.length], ["sent", 0]);
  is("advancing it again sends nothing more", [(await advanceBroadcast(id, storeForHandle, Date.now() + 10_000))?.status, messages.length], ["sent", 2]);

  part("Nobody who left is put back by the send");
  const [left, bounced] = await redis.pipeline([["HGET", leadsKey(listId), "left@example.com"], ["HGET", leadsKey(listId), "bounced@example.com"]]);
  is("still unsubscribed, still stopped as bounced", [JSON.parse(String(left)).unsub, JSON.parse(String(bounced)).unsub, JSON.parse(String(bounced)).gone], [true, true, "bounced"]);
  is("and a second unsubscribe of the same address is the same", (await unsubscribe(tokens.get("left@example.com") ?? ""))?.email, "left@example.com");

  mail.restore();
  done();
}

void main();
