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
  const id = "111111111111111111111111", key = "nl:mail:bc:" + id, toKey = key + ":to";
  const base = { id, listId: store.listId, handle: store.handle, subject: "Subject", body: "Message", productId: null, notProductId: null, who: "all", narrow: null, status: "sending", createdAt: 100, sendAt: 100, finishedAt: 0, total: 2, sent: 0, note: "", failures: 0, listed: true, tagged: true, test: null };
  const original = redis.pipeline;
  let finalReply: unknown = ["OK"], applyFinal = false;
  let terminalStatus: "sent" | "failed" = "sent";
  const events: string[] = [];
  redis.pipeline = async commands => {
    for (const c of commands) {
      if (c[0] === "SET" && c[1] === key && JSON.parse(String(c[2])).status === terminalStatus) {
        events.push("terminal-save");
        if (applyFinal) await original.call(redis, commands);
        if (finalReply instanceof Error) throw finalReply;
        return finalReply as unknown[];
      }
      if (c[0] === "DEL" && c[1] === toKey) events.push("snapshot-delete");
    }
    return original.call(redis, commands);
  };
  const seed = async () => {
    mail.clearCaptured();
    mail.setSesOutcome("ok");
    mail.clearBatch(`bc:${id}:0:0:2`, emails.slice(0, 2));
    terminalStatus = "sent"; events.length = 0; applyFinal = false;
    await original.call(redis, [["SET", key, JSON.stringify(base)], ["DEL", toKey], ["RPUSH", toKey, ...emails.slice(0, 2)], ["SADD", "nl:mail:queue", id]]);
  };
  const advance = () => advanceBroadcast(id, storeForHandle, Date.now() + 5000);
  try {
    part("Unconfirmed completion retains the recipient snapshot");
    for (const invalid of [[], [null], [true], ["ok"], ["OK", "OK"], new Error("terminal response lost")]) {
      await seed(); finalReply = invalid;
      let failed = false;
      try { await advance(); } catch { failed = true; }
      is("unconfirmed completion throws", failed, true);
      is("snapshot was not deleted", events, ["terminal-save"]);
      is("snapshot remains readable", (await original.call(redis, [["LRANGE", toKey, 0, -1]]))[0], emails.slice(0, 2));
      is("campaign remains queued", (await original.call(redis, [["SISMEMBER", "nl:mail:queue", id]]))[0], 1);
      const progress = JSON.parse(String((await original.call(redis, [["GET", key]]))[0]));
      is("last confirmed progress retains processed offset", [progress.status, progress.sent], ["sending", 2]);
      is("only the original synthetic SES messages were sent", [mail.ses.length, mail.resend.length], [2, 0]);
      finalReply = ["OK"]; applyFinal = true;
      is("retry completes from saved offset", (await advance())?.status, "sent");
      is("retry does not resend or switch provider", [mail.ses.length, mail.resend.length], [2, 0]);
      is("confirmed completion precedes cleanup", events.slice(-2), ["terminal-save", "snapshot-delete"]);
      is("confirmed completion leaves queue", (await original.call(redis, [["SISMEMBER", "nl:mail:queue", id]]))[0], 0);
    }
    part("Applied terminal write with a lost response is not rolled back");
    await seed(); finalReply = []; applyFinal = true;
    let lost = false;
    try { await advance(); } catch { lost = true; }
    is("lost acknowledgement remains uncertain", lost, true);
    is("snapshot retained after lost acknowledgement", events, ["terminal-save"]);
    is("applied terminal status stays saved", JSON.parse(String((await original.call(redis, [["GET", key]]))[0])).status, "sent");
    is("next run recognizes saved completion", (await advance())?.status, "sent");
    is("completed campaign is not sent twice or through Resend", [mail.ses.length, mail.resend.length], [2, 0]);
    is("next run removes completed campaign from queue", (await original.call(redis, [["SISMEMBER", "nl:mail:queue", id]]))[0], 0);

    part("An uncertain provider outcome stops automatic campaign retries");
    for (const loss of ["lost", "server-error"] as const) {
      await seed();
      mail.setSesOutcome(loss); terminalStatus = "failed"; finalReply = ["OK"]; applyFinal = true;
      await original.call(redis, [["EXPIRE", toKey, 60 * 86_400]]);
      const originalTtl = Number((await original.call(redis, [["TTL", toKey]]))[0]);
      const uncertain = (await advance())!;
      is(`${loss}: the campaign records uncertainty, not confirmed delivery`,
        [uncertain.status, uncertain.sent, uncertain.total, uncertain.failures], ["failed", 0, 2, 0]);
      is(`${loss}: the note explains why automatic retry stopped`,
        [/could not be confirmed/.test(uncertain.note), /may already/.test(uncertain.note), /Automatic retries are stopped/.test(uncertain.note), uncertain.note.length <= 300], [true, true, true, true]);
      is(`${loss}: recipient content and persistent campaign identifiers remain`,
        [uncertain.id, uncertain.subject, uncertain.body, (await original.call(redis, [["LRANGE", toKey, 0, -1]]))[0]],
        [id, base.subject, base.body, emails.slice(0, 2)]);
      const remainingTtl = Number((await original.call(redis, [["TTL", toKey]]))[0]);
      is(`${loss}: existing recipient retention is neither removed nor extended`,
        remainingTtl <= originalTtl && remainingTtl >= originalTtl - 60, true);
      is(`${loss}: one possible provider acceptance and no snapshot deletion`, [mail.calls.ses, mail.sesAttempts.length, mail.ses.length, mail.resendAttempts.length, events], [2, 2, 0, 0, ["terminal-save"]]);
      is(`${loss}: confirmed terminal state precedes existing queue cleanup`,
        (await original.call(redis, [["SISMEMBER", "nl:mail:queue", id]]))[0], 0);
      await advance();
      await advance();
      is(`${loss}: later workers do not repeat the possibly accepted batch`, [mail.calls.ses, mail.sesAttempts.length, mail.resendAttempts.length], [2, 2, 0]);
    }

    part("An applied uncertain-state write with a lost reply stays terminal");
    await seed();
    mail.setSesOutcome("lost"); terminalStatus = "failed"; finalReply = []; applyFinal = true;
    let uncertaintyWriteLost = false;
    try { await advance(); } catch { uncertaintyWriteLost = true; }
    is("unknown terminal acknowledgement throws without cleanup", [uncertaintyWriteLost, events], [true, ["terminal-save"]]);
    is("the uncertain campaign and recipient snapshot stay saved",
      [JSON.parse(String((await original.call(redis, [["GET", key]]))[0])).status, (await original.call(redis, [["LRANGE", toKey, 0, -1]]))[0]], ["failed", emails.slice(0, 2)]);
    is("an unconfirmed acknowledgement keeps the queue entry until the next reader",
      (await original.call(redis, [["SISMEMBER", "nl:mail:queue", id]]))[0], 1);
    is("next reader recognizes terminal uncertainty", (await advance())?.status, "failed");
    is("next reader cleans the queue without another provider attempt",
      [mail.calls.ses, mail.sesAttempts.length, mail.resendAttempts.length, (await original.call(redis, [["SISMEMBER", "nl:mail:queue", id]]))[0]], [2, 2, 0, 0]);

    part("Confirmed refusal keeps the existing bounded retry policy");
    await seed();
    mail.setSesOutcome("refused");
    for (let count = 1; count <= 5; count += 1) {
      const refused = (await advance())!;
      is(`known refusal ${count}: no unknown-acceptance shortcut`,
        [refused.status, refused.failures, refused.sent], [count === 5 ? "failed" : "sending", count, 0]);
    }
    is("known refusals still allow exactly the existing five tries and accept nobody",
      [mail.calls.ses, mail.ses.length, mail.resendAttempts.length], [10, 0, 0]);
  } finally { redis.pipeline = original; mail.restore(); }
  done();
}
void main();
