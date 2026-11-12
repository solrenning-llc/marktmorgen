/**
 * A batch the email service may have taken is never given back to the store's monthly emails (lib/email.ts,
 * sendBatchOutcome): an SES acknowledgement lost, or a Resend post whose answer never came, may have written to
 * everyone in it, and the same batch tried again writes only to whoever the service did not take. Giving the count
 * back on such an answer let a send that went count nothing. Only a batch nothing of which went gives its count back.
 * Synthetic data only (tests/community-mail-read-world.ts).
 */
import { advanceAnnouncement, type AnnouncementJob } from "@/lib/community-mail";
import { db, members, released, reserved, reset, setBatchAnswer, store } from "./community-mail-read-world";
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

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
