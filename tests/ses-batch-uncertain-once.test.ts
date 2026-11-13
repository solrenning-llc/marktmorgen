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

  // Codex T on #4361: the "may have gone" mark is written before an email is handed to SES, and confirmed. A mark
  // that is refused, or answered in another shape, sends nothing: no email can go without its mark, so none can be
  // written to twice by a later call.
  for (const [what, fail] of [
    ["refused", async () => { throw new Error("ERR synthetic refusal of the mark"); }],
    ["answered in another shape", async () => []],
  ] as const) {
    part(`A mark ${what} before the wave: nothing is sent`);
    redis.clear();
    mail.clearCaptured();
    await mail.setReady(true, { max24: 50_000, rate: 100 });
    mail.setSesOutcome("ok");
    const plain = redis.pipeline.bind(redis);
    let failed = 0;
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (!failed && commands.some((c) => c[0] === "SET" && String(c[1]).startsWith("nl:ses:maybe:"))) {
        failed += 1;
        return fail();
      }
      return plain(commands);
    }) as typeof redis.pipeline;
    const held = await sendBatch(people.map(message), `upd:synthetic:mark:${what}`, { by: "company" });
    redis.pipeline = plain;
    is("the mark's write failed (diagnostic)", failed, 1);
    is("the batch is not done", held === "sent", false);
    is("no email was handed to SES", people.map(to), [0, 0, 0, 0, 0]);
    const next = await sendBatch(people.map(message), `upd:synthetic:mark:${what}`, { by: "company" });
    is("the next call sends the batch", next, "sent");
    is("once each", people.map(to), [1, 1, 1, 1, 1]);
  }

  // Codex G on #4361: the repeat finds Amazon no longer set up and a Resend fallback open. The marks of the first run
  // are read before any provider is chosen, so the fallback never gets the address SES may already have written to.
  part("A provider change never releases an SES recipient with uncertain acceptance");
  redis.clear();
  mail.clearCaptured();
  mail.configure();
  // One a second: each email is its own wave, so the lost answer stops the run before the fourth and the fifth.
  await mail.setReady(true, { max24: 50_000, rate: 1 });
  mail.setSesOutcome(["ok", "ok", "lost", "ok", "ok"]);
  const lost = await sendBatch(people.map(message), "upd:synthetic:switch:5", { by: "company" });
  is("SES stopped at the lost answer: the fourth and the fifth were not handed to it", people.map(to), [1, 1, 1, 0, 0]);
  is("the first run is not done", lost, "retry");
  mail.disableSes();
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  const toResend = (address: string) => mail.resendAttempts.filter((m) => m.to.includes(address)).length;
  const switched = await sendBatch(people.map(message), "upd:synthetic:switch:5", { by: "company" });
  is("the batch stays held: what became of the third is unknown", switched, "retry");
  is("Resend never gets the address SES may have written to", toResend("three@example.com"), 0);
  is("nor those SES took", [toResend("one@example.com"), toResend("two@example.com")], [0, 0]);
  is("the rest of the batch goes by Resend, once each (the fallback is open)", [toResend("four@example.com"), toResend("five@example.com")], [1, 1]);
  is("and SES is not asked again", people.map(to), [1, 1, 1, 0, 0]);
  delete process.env.RESEND_API_KEY;
  done();
}

void main();
