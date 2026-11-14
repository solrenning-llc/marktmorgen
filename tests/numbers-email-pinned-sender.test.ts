/**
 * The owner's numbers email (app/api/cron/weekly/route.ts and app/api/cron/monthly/route.ts) is tried again, under
 * the same period key, after a send whose answer was lost. lib/email.ts's sendEmail can fall over from Amazon to
 * Resend under that key and, if Resend's answer is lost, a later try reaches Amazon again with its once-key gone, so
 * the same summary is delivered twice. sendEmailPinned keeps the sender for the key, so a retried email never goes
 * to the other sender (its behaviour is held by tests/paypal-receipt-once.test.ts, part H). The owner's email is sent
 * through it; the team copies, sent once only after the owner's was sent, stay on sendEmail (MÉDIO of the rev-odd
 * review of #3297).
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

function ownerSend(file: string): string {
  const source = readFileSync(file, "utf8");
  const at = source.indexOf('sendPart(period, "emailed"');
  return at < 0 ? "" : source.slice(at, at + 160);
}

async function main(): Promise<void> {
  for (const file of ["app/api/cron/weekly/route.ts", "app/api/cron/monthly/route.ts"]) {
    part(file);
    const send = ownerSend(file);
    is("the owner's email is found", send.length > 0, true);
    is("it goes through sendEmailPinned, never sendEmail", [send.includes("sendEmailPinned("), /[^d]sendEmail\(/.test(send)], [true, false]);
    is("under the period's key", readFileSync(file, "utf8").includes("idempotencyKey: `numbers-summary:${period.key}`"), true);
  }
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
