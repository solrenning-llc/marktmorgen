/**
 * Regression: a community announcement whose batch cannot go because the sender has no room (Amazon SES
 * bulk room used up, the Resend fallback at its paid quota) must wait in its queue and go out later, never be
 * dropped (owner, 309 [EM1] unit 2, 31/10/2026: "o e-mail espera na fila ... nunca descartado"; lib/mail.ts
 * SENDER_WAIT_NOTE: "Nothing is lost."). lib/community-mail.ts sends with sendBatch, which answers "retry" for that
 * known no-send, counts it as a failure, and after five runs (25 minutes of the five-minute job) marks the whole
 * announcement failed and takes it out of the queue: every member not yet emailed never gets it.
 * Synthetic data only (tests/flow-community-world.ts).
 */
import { advanceAnnouncement, type AnnouncementJob } from "@/lib/community-mail";
import { db, members, reset, store, batchCalls } from "./flow-community-world";
import { done, is, part } from "./check";

const id = "e".repeat(24);
const job: AnnouncementJob = { id, community: store.community!.id, handle: store.handle, post: "f".repeat(12),
  subject: "Synthetic announcement", body: "Synthetic body", total: members.length, done: 0, sent: 0,
  status: "sending", note: "", failures: 0 };

async function main(): Promise<void> {
  part("an announcement over the sender's room waits, never dropped");
  reset();
  batchCalls.length = 0;
  db.run(["SET", `nl:cm:mail:${id}`, JSON.stringify(job)]);
  db.run(["RPUSH", `nl:cm:mail:${id}:to`, ...members.map((m) => m.k)]);
  db.run(["SADD", "nl:cm:mailq", id]);
  // Six runs of the five-minute job while the sender has no room.
  for (let run = 0; run < 6; run += 1) await advanceAnnouncement(id, async () => store, Date.now() + 10_000);
  const saved = JSON.parse(String(db.run(["GET", `nl:cm:mail:${id}`]))) as AnnouncementJob;
  is("the sender was asked each run, and nothing was handed over", batchCalls.length > 0, true);
  is("the announcement is not marked failed", saved.status === "failed", false);
  is("it is still in the queue for a later run", db.run(["SISMEMBER", "nl:cm:mailq", id]), 1);
  is("no member was skipped past", saved.done, 0);
  done();
}

main().catch((error) => { console.error(error); process.exit(1); });
