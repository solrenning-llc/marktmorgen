/**
 * A batch Amazon SES answered in part with an answer that is not known (lib/ses.ts, sesBatch; lib/email.ts,
 * sendBatch), then tried again under the same key, as the queue workers do on "retry" (lib/waitlist.ts runLaunches,
 * lib/product-updates.ts advanceUpdates, lib/community-mail.ts, lib/community-event-mail.ts) (webhooks/cron audit,
 * Claude 1, 12/11/2026). Whoever SES took was marked so a retry leaves them out (nl:ses:did), but the address whose
 * answer was lost (a 5xx, a reply that never came) was not: the retry five minutes later wrote to them again.
 * Now that address is marked too, as one that may have been written to: a retry never writes to it a second time
 * (rule 30), the rest of the batch still goes, and the batch stays held as uncertain (never answered "sent").
 * Synthetic only: the Redis stub and the SES mail fixture.
 */
import { sendBatch } from "@/lib/email";
import { store as redis } from "./redis-stub";
import { installSesMailFixture } from "./ses-mail-fixture";
import { done, is, part } from "./check";

const mail = installSesMailFixture();

const message = (to: string) => ({
  from: "Harbor Kitchen <hello@marktmorgen.com>",
  to,
  subject: "A new chapter is out",
  text: "It is ready.",
  html: "<p>It is ready.</p>",
});
const to = (address: string) => mail.sesAttempts.filter((m) => m.to.includes(address)).length;

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  delete process.env.RESEND_API_KEY;
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  const people = ["one@example.com", "two@example.com", "three@example.com", "four@example.com", "five@example.com"];

  part("The first run: SES takes two, loses its answer for the third");
  mail.setSesOutcome(["ok", "ok", "lost", "ok", "ok"]);
  const first = await sendBatch(people.map(message), "upd:synthetic:0:5", { by: "company" });
  is("the batch is not done", first, "retry");
  is("the third was handed to SES once", to("three@example.com"), 1);

  part("Five minutes on, the same batch under the same key");
  mail.setSesOutcome("ok");
  const second = await sendBatch(people.map(message), "upd:synthetic:0:5", { by: "company" });
  is("the batch is still held: what became of the third is unknown", second, "retry");
  is("the address whose answer was lost is never written to a second time", to("three@example.com"), 1);
  is("those SES took are not written to again", [to("one@example.com"), to("two@example.com")], [1, 1]);
  is("and the rest of the batch goes, once each", [to("four@example.com"), to("five@example.com")], [1, 1]);

  part("And again: the held batch still writes to nobody twice");
  const third = await sendBatch(people.map(message), "upd:synthetic:0:5", { by: "company" });
  is("still held, never answered sent", third, "retry");
  is("nobody is written to a second time", people.map(to), [1, 1, 1, 1, 1]);
  done();
}

void main();
