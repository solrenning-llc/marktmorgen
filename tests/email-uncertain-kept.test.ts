/**
 * A batch the email service may have taken is never given back to the store's monthly emails (lib/email.ts,
 * sendBatchOutcome): an SES acknowledgement lost, or a Resend post whose answer never came, may have written to
 * everyone in it, and the same batch tried again writes only to whoever the service did not take. Giving the count
 * back on such an answer let a send that went count nothing. Only a batch nothing of which went gives its count back.
 * Synthetic data only (tests/community-mail-read-world.ts).
 */
import { advanceAnnouncement, type AnnouncementJob } from "@/lib/community-mail";
import { batchKeptKey } from "@/lib/batch-count";
import { db, members, released, reserved, reset, sent, setBatchAnswer, store } from "./community-mail-read-world";
import { done, is, part } from "./check";

const id = "e".repeat(24);
const keys = members.map((m) => m.k);
const job = { id, community: store.community!.id, handle: store.handle, post: "f".repeat(12),
  subject: "Synthetic announcement", body: "Synthetic body", total: 2, done: 0, sent: 0, status: "sending", note: "", failures: 0,
} as AnnouncementJob;
const held = () => reserved.reduce((a, b) => a + b, 0) - released.reduce((a, b) => a + b, 0);

function seed(): void {
  reset();
  db.run(["SET", "nl:cm:mail:" + id, JSON.stringify(job)]);
  db.run(["RPUSH", "nl:cm:mail:" + id + ":to", ...keys]);
  db.run(["SADD", "nl:cm:mailq", id]);
}

async function main(): Promise<void> {
  part("An announcement batch the email service may have taken keeps its count");
  seed();
  setBatchAnswer("uncertain");
  const unknown = await advanceAnnouncement(id, async () => store, Date.now() + 10_000);
  is("the answer was not known: the two emails stay counted, the job tried again later", [held(), unknown?.status, unknown?.failures], [2, "sending", 1]);

  part("A batch nothing of which went gives its count back");
  seed();
  setBatchAnswer("retry");
  const notSent = await advanceAnnouncement(id, async () => store, Date.now() + 10_000);
  is("nothing went: given back, the job tried again later", [held(), notSent?.status, notSent?.failures], [0, "sending", 1]);

  seed();
  setBatchAnswer("sent");
  const sentJob = await advanceAnnouncement(id, async () => store, Date.now() + 10_000);
  is("sent: counted once", [held(), sentJob?.status], [2, "sent"]);

  /*
   * The same batch tried again after an answer not known is the same request to the email service, under the same
   * key and to the same people: the service drops it if it took the first, so it writes to them once. Counting it
   * again took the creator's monthly emails twice (five times, after five unknown answers) for emails that went once
   * (reviews of #4073). The count kept for the batch is used for its retry, never reserved again.
   */
  part("A batch tried again after an answer not known is counted once");
  seed();
  setBatchAnswer("uncertain");
  await advanceAnnouncement(id, async () => store, Date.now() + 10_000);
  setBatchAnswer("sent");
  const retried = await advanceAnnouncement(id, async () => store, Date.now() + 10_000);
  is("unknown, then sent under the same key: two emails, counted two, not four", [held(), retried?.status, retried?.sent], [2, "sent", 2]);
  is("the batch was handed to the service twice, under one count", sent.length, 2);

  seed();
  setBatchAnswer("uncertain");
  let last: AnnouncementJob | null = null;
  for (let i = 0; i < 5; i += 1) last = await advanceAnnouncement(id, async () => store, Date.now() + 10_000);
  is("five unknown answers: the batch is counted once, not five times", [held(), last?.status], [2, "failed"]);

  // A later answer that says nothing went cannot prove the first did not: the count stays, never given back.
  seed();
  setBatchAnswer("uncertain");
  await advanceAnnouncement(id, async () => store, Date.now() + 10_000);
  setBatchAnswer("retry");
  await advanceAnnouncement(id, async () => store, Date.now() + 10_000);
  is("unknown, then not taken: still counted once, never given back", held(), 2);
  setBatchAnswer("sent");
  const after = await advanceAnnouncement(id, async () => store, Date.now() + 10_000);
  is("and sent after that: still counted once", [held(), after?.status], [2, "sent"]);

  // Once sent, the batch's mark goes: nothing is left to excuse a later batch from its count.
  is("no mark is left once the batch was sent", db.run(["EXISTS", batchKeptKey(`cm:${id}:0:${keys.length}`, members.map((m) => m.e))]), 0);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
