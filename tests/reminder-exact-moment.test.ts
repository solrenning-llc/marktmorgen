/**
 * The trial-ending and yearly-renewal reminders (lib/billing-reminders.ts) said only the day of the charge, as UTC
 * reads it, without saying so: "Your free trial ends on December 1" for a charge at 2:00 AM UTC on 1 December. A
 * creator in California reads it as the whole of 1 December and cancels on the evening of 30 November their time,
 * which is already past the charge: they are charged though the email let them think they were in time. The body
 * now says the exact moment, with its time zone named in full. Found with the date and time tests of ALL-154.
 * Synthetic, no email sent.
 */
import { reminderEmail } from "@/lib/billing-reminders";
import { done, is, part } from "./check";

const at = Date.UTC(2026, 11, 1, 2, 0) / 1000;

function main(): void {
  for (const kind of ["trial", "renewal"] as const) {
    part(`The ${kind} reminder`);
    const mail = reminderEmail({ kind, subscription: "sub_moment", email: "creator@example.com", at, tier: "creator", cycle: "year", amountCents: 69_000 });
    is("says the exact moment of the charge, its time zone named", mail.text.includes("December 1, 2026, at 2:00 AM UTC (Coordinated Universal Time)"), true);
    is("never the bare day alone where it says when to cancel by", /on December 1, 2026[.,] (?!at)/.test(mail.text), false);
    is("the subject keeps the day, short", mail.subject.includes("December 1, 2026"), true);
  }
  done();
}

main();
