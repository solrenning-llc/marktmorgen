/**
 * 361 [AP1] (e), unit 1: the rules of the reminder a member gets the day before
 * their access ends, and its words. Pure: nothing sends yet; the daily job
 * that sends it (one read of the store's memberships, shared with the
 * come-back email, the store's email quota reserved before each send, the
 * creator's switch, off by default) is the next unit.
 *
 * What fails here:
 *   - a reminder due for a membership that is not running, has no end, has
 *     already ended, or ends more than a day away;
 *   - a date it cannot read taken as one;
 *   - two reminders for the same end; a new end (the member changed their
 *     mind and it was moved) not getting its own;
 *   - the switch on by default, or switched on by anything but `true`;
 *   - the email saying "in 24 hours" instead of the real end date, or any
 *     discount, urgency or scarcity; a buyer language without its words.
 */
import { ACCESS_ENDING_HOURS, endingDue, endingMark, parseEnding } from "@/lib/access-ending-rules";
import { membershipWords } from "@/lib/buyer-words/membership";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { done, is, part } from "./check";

const now = Date.parse("2026-11-15T12:00:00Z");
const s = (ms: number) => Math.floor(ms / 1000);
const H = 3_600_000;

part("When it is due");
is("a day ahead", ACCESS_ENDING_HOURS, 24);
is("running, ending in 20 hours: due", endingDue({ status: "active", endsAt: s(now + 20 * H) }, now), true);
is("ending in exactly 24 hours: due", endingDue({ status: "active", endsAt: s(now + 24 * H) }, now), true);
is("ending in 25 hours: not yet", endingDue({ status: "active", endsAt: s(now + 25 * H) }, now), false);
is("already ended: never", endingDue({ status: "active", endsAt: s(now - H) }, now), false);
is("no end: never", endingDue({ status: "active", endsAt: null }, now), false);
is("an end it cannot read: never", endingDue({ status: "active", endsAt: Number.NaN }, now), false);
is("trialing counts as running", endingDue({ status: "trialing", endsAt: s(now + 5 * H) }, now), true);
for (const status of ["canceled", "past_due", "unpaid", "incomplete", "paused", ""]) is(`${status || "no status"}: never`, endingDue({ status, endsAt: s(now + 5 * H) }, now), false);

part("Once for each end");
is("the mark names the membership and its end", endingMark("st1", "sub_A", 1_763_300_000), "nl:ending:st1:sub_A:1763300000");
is("a moved end has a mark of its own", endingMark("st1", "sub_A", 1_763_300_000) !== endingMark("st1", "sub_A", 1_765_900_000), true);

part("The creator's switch");
is("off by default", parseEnding(undefined), { on: false, address: "" });
is("on only by true, with a postal address", [parseEnding({ on: "yes", address: "1 Main St" }).on, parseEnding({ on: true }).on, parseEnding({ on: true, address: "  1  Main St " })], [false, false, { on: true, address: "1 Main St" }]);

part("The words");
for (const code of LANGUAGE_CODES) {
  const w = membershipWords(code);
  const subject = w.endingSubject("Pottery Club", "November 16, 2026");
  const lead = w.endingLead("Pottery Club", "Kiln Works", "November 16, 2026");
  is(`${code}: the real date, the membership and the store`, [subject.includes("November 16, 2026"), lead.includes("Pottery Club"), lead.includes("Kiln Works")], [true, true, true]);
  is(`${code}: how to keep it`, w.endingKeep.length > 20, true);
  is(`${code}: no "24 hours", discount, urgency or scarcity`, /24|%|hurry|last chance|only|discount|descuento|remise|rabatt|sconto|korting|desconto/i.test(`${subject} ${lead} ${w.endingKeep}`), false);
}

done();
