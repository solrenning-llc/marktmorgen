import { advanceBroadcast } from "@/lib/broadcasts";
import { claimHandle, ensureListId, setMailSettings, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { upsertContact } from "@/lib/contacts";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { installSesMailFixture } from "./ses-mail-fixture";
async function main() {
  redis.clear();
  const owner = "batch-owner@example.com";
  await claimHandle(owner, "batch-check", "Batch Check", "");
  await ensureListId(owner);
  await setSubscription(owner, { customerId: "cus_Batch00001", subscriptionId: "sub_Batch00001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(owner, { fromName: "Batch Check", address: "1 Test Street, Test City" });
  const store = (await storeForEmail(owner))!;
  const emails = ["reader0@example.com", "reader1@example.com", "reader2@example.com"];
  for (const email of emails) await upsertContact(store.listId!, email, { agreed: true, explicit: true, source: "free" }, ROOM);
  process.env.RESEND_API_KEY = "re_test_recipient_batch_only";
  const mail = installSesMailFixture();
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  const messages = mail.ses;
  const id = "111111111111111111111111", key = "nl:mail:bc:" + id, toKey = key + ":to";
  const base = { id, listId: store.listId, handle: store.handle, subject: "Subject", body: "Message", productId: null, notProductId: null, who: "all", narrow: null, status: "sending", createdAt: 100, sendAt: 100, finishedAt: 0, total: 2, sent: 0, note: "", failures: 0, listed: true, tagged: true, test: null };
  const original = redis.pipeline;
  const normal = Symbol("normal");
  let reply: unknown = normal, saveReply: unknown = normal, applySave = false;
  redis.pipeline = async commands => {
    if (commands.some(c => c[0] === "LRANGE" && c[1] === toKey) && reply !== normal) {
      if (reply instanceof Error) throw reply;
      return reply as unknown[];
    }
    if (commands.some(c => c[0] === "SET" && c[1] === key) && saveReply !== normal) {
      if (applySave) await original.call(redis, commands);
      return saveReply as unknown[];
    }
    return original.call(redis, commands);
  };
  const seed = async (over: Record<string, unknown> = {}, recipients = emails.slice(0, 2)) => {
    mail.clearCaptured();
    mail.clearBatch(`bc:${id}:0:0:2`, recipients);
    mail.clearBatch(`bc:${id}:1:0:2`, recipients);
    reply = normal; saveReply = normal; applySave = false;
    await original.call(redis, [["SET", key, JSON.stringify({ ...base, ...over })], ["DEL", toKey], ["RPUSH", toKey, ...recipients], ["SADD", "nl:mail:queue", id]]);
  };
  const advance = () => advanceBroadcast(id, storeForHandle, Date.now() + 5000);
  try {
    part("Incomplete or invalid recipient reads pause before sending");
    for (const invalid of [null, {}, [], [null], [{}], [[]], [[emails[0]]], [[...emails]], [[emails[0], null]], [[emails[0], emails[0]]], [[" reader0@example.com ", emails[1]]], [["READER0@example.com", emails[1]]], [["invalid", emails[1]]], [["x".repeat(255) + "@example.com", emails[1]]], [[emails[0], emails[1]], []], [Array(2)], new Error("read response lost")]) {
      await seed(); reply = invalid;
      const result = await advance();
      is("campaign waits for a complete batch", result?.status, "waiting");
      is("recipient offset does not advance", result?.sent, 0);
      is("no provider messages for an invalid batch", mail.attempts.length, 0);
      is("campaign remains queued for retry", (await original.call(redis, [["SISMEMBER", "nl:mail:queue", id]]))[0], 1);
      const saved = JSON.parse(String((await original.call(redis, [["GET", key]]))[0]));
      is("waiting state and unchanged offset are persisted", [saved.status, saved.sent, Boolean(saved.note)], ["waiting", 0, true]);
    }
    part("A restored read resumes from the confirmed offset");
    reply = normal;
    const restored = await advance();
    is("restored complete batch finishes", restored?.status, "sent");
    is("both recipients are processed", restored?.sent, 2);
    is("each expected address receives one SES message and no Resend fallback", [messages.flatMap(m => m.to).sort(), mail.resend.length], [emails.slice(0, 2), 0]);
    await seed({ sent: 1, total: 3 }, emails); reply = [[emails[1]]];
    is("partial batch preserves earlier progress", (await advance())?.sent, 1);
    is("partial batch sends nothing more", messages.length, 0);
    reply = normal;
    is("resumed campaign reaches its original total", (await advance())?.sent, 3);
    is("resume uses SES without repeating the earlier offset or switching provider", [messages.flatMap(m => m.to).sort(), mail.resend.length], [emails.slice(1), 0]);
    part("A batch cannot cross a subject-test boundary");
    await seed({ total: 3, test: { subjectB: "Other", share: 20, hours: 4, by: "visits", a: 1, b: 1, endsAt: 0, winner: "", visits: null, sales: null, why: "", skipped: false } }, emails);
    reply = [[emails[0], emails[1]]];
    is("oversized test batch waits", (await advance())?.status, "waiting");
    is("oversized test batch sends no mixed variants", messages.length, 0);
    part("Progress writes require explicit acknowledgement");
    for (const invalid of [[], [null], [true], ["ok"], ["OK", "OK"]]) {
      await seed(); reply = [[]]; saveReply = invalid;
      let failed = false;
      try { await advance(); } catch { failed = true; }
      is("uncertain progress is not returned as confirmed", failed, true);
      is("no send after an invalid batch", messages.length, 0);
      is("uncertain progress is not dequeued", (await original.call(redis, [["SISMEMBER", "nl:mail:queue", id]]))[0], 1);
    }
    await seed(); reply = [[]]; saveReply = []; applySave = true;
    let lost = false;
    try { await advance(); } catch { lost = true; }
    is("applied progress with lost acknowledgement stays uncertain", lost, true);
    const retained = JSON.parse(String((await original.call(redis, [["GET", key]]))[0]));
    is("applied waiting status is not rolled back", [retained.status, retained.sent], ["waiting", 0]);
  } finally { redis.pipeline = original; mail.restore(); }
  done();
}
void main();
