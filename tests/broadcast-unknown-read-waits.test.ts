/**
 * j-mail-7 (Claude 3 cloud J, email audit): a broadcast batch stopped because a Redis read came back in an unknown
 * shape (who may still be written to, the month's room, the store's pause) sent nothing, and nobody was told it had
 * gone. It is tried again by the next run, as long as it takes: rule 24, an unknown answer is never an end. It was
 * counted as the email service refusing it, so five such runs (25 minutes of an unwell Redis) stopped the whole
 * broadcast for good, saying "The email service would not take it", and the rest of the list never got it.
 */
import { advanceBroadcast } from "@/lib/broadcasts";
import { claimHandle, ensureListId, setMailSettings, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { leadsKey, upsertContact } from "@/lib/contacts";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { installSesMailFixture } from "./ses-mail-fixture";

async function main() {
  redis.clear();
  const owner = "unknown-read-owner@example.com";
  await claimHandle(owner, "unknown-read", "Unknown Read", "");
  await ensureListId(owner);
  await setSubscription(owner, { customerId: "cus_Unknown0001", subscriptionId: "sub_Unknown0001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(owner, { fromName: "Unknown Read", address: "1 Test Street, Test City" });
  const store = (await storeForEmail(owner))!;
  const emails = ["reader0@example.com", "reader1@example.com"];
  for (const email of emails) await upsertContact(store.listId!, email, { agreed: true, explicit: true, source: "free" }, ROOM);
  process.env.RESEND_API_KEY = "re_test_unknown_read_only";
  const mail = installSesMailFixture();
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  const id = "222222222222222222222222", key = "nl:mail:bc:" + id, toKey = key + ":to";
  const base = { id, listId: store.listId, handle: store.handle, subject: "Subject", body: "Message", productId: null, notProductId: null, who: "all", narrow: null, status: "sending", createdAt: 100, sendAt: 100, finishedAt: 0, total: 2, sent: 0, note: "", failures: 0, listed: true, tagged: true, test: null };
  mail.clearCaptured();
  mail.setSesOutcome("ok");
  await redis.pipeline([["SET", key, JSON.stringify(base)], ["DEL", toKey], ["RPUSH", toKey, ...emails], ["SADD", "nl:mail:queue", id]]);
  const original = redis.pipeline;
  // Who may still be written to (lib/contacts.ts tokensFor, an HMGET of the list's rows) answers in an unknown shape.
  let unwell = true;
  redis.pipeline = async (commands) => {
    if (unwell && commands.some((c) => c[0] === "HMGET" && c[1] === leadsKey(store.listId!))) return [undefined];
    return original.call(redis, commands);
  };
  const advance = () => advanceBroadcast(id, storeForHandle, Date.now() + 5000);
  try {
    part("Six runs while Redis answers in an unknown shape");
    let last = null as Awaited<ReturnType<typeof advance>>;
    for (let run = 0; run < 6; run += 1) last = await advance();
    is("nothing was sent", [mail.ses.length, mail.resend.length], [0, 0]);
    is("the broadcast is still to send, never failed", [last?.status !== "failed", last?.sent, last?.finishedAt], [true, 0, 0]);
    is("it is still queued", (await original.call(redis, [["SISMEMBER", "nl:mail:queue", id]]))[0], 1);
    part("Redis is well again: the next run sends it, once");
    unwell = false;
    is("sent", (await advance())?.status, "sent");
    is("both readers got it once", mail.ses.flatMap((m) => m.to).sort(), emails);
  } finally { redis.pipeline = original; }
  done();
}
void main();
