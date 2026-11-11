/**
 * 240 [CF3], unit 1: the rules of starting from the email on the home page
 * (docs/home-email-start.md): the two unchecked boxes, the one reminder and
 * its ceiling, and no newsletter without the company's postal address.
 * Pure, off, synthetic.
 */
import {
  HOME_EMAIL_START_ON,
  NEWSLETTER_BOX,
  NEWSLETTER_SENDS_MONTHLY,
  REMINDER_BOX,
  REMINDER_DELAY_SECONDS,
  SIGNUP_REMINDERS_DAILY,
  newsletterBoxShown,
  reminderDue,
} from "@/lib/home-email-start-rules";
import { done, is, part } from "./check";

const now = 1_800_000_000;
const askedAt = now - REMINDER_DELAY_SECONDS;
const base = {
  consent: { version: REMINDER_BOX.version, at: askedAt - 5 },
  askedAt,
  finished: false,
  suppressed: false,
  stopped: false,
  postalAddress: "100 Main St, Dover, DE 19901, USA",
  alreadySent: false,
  sentToday: 0,
  now,
};

part("Off, and the boxes");
is("off until the owner chooses the home field", HOME_EMAIL_START_ON, false);
is("each box has its own words and a version", [(REMINDER_BOX.text as string) !== NEWSLETTER_BOX.text, REMINDER_BOX.version > 0, NEWSLETTER_BOX.version > 0], [true, true, true]);
is("the reminder box says one reminder", /one reminder/i.test(REMINDER_BOX.text), true);
is("the ceilings are the proposal's", [SIGNUP_REMINDERS_DAILY, NEWSLETTER_SENDS_MONTHLY], [1_000, 20_000]);
is("the reminder waits a day", REMINDER_DELAY_SECONDS, 86_400);

part("The one reminder");
is("all in place, a day after: send", reminderDue(base), "send");
is("before the day is over: wait", reminderDue({ ...base, now: askedAt + REMINDER_DELAY_SECONDS - 1 }), "wait");
for (const [what, change] of [
  ["the box was not checked", { consent: null }],
  ["the yes was for other words", { consent: { version: REMINDER_BOX.version + 1, at: askedAt - 5 } }],
  ["the sign-up was finished", { finished: true }],
  ["the address bounced, complained or is suppressed", { suppressed: true }],
  ["the person asked to stop", { stopped: true }],
  ["no postal address of the company", { postalAddress: "" }],
  ["one was already sent", { alreadySent: true }],
] as const) {
  is(`${what}: never`, reminderDue({ ...base, ...change } as never), "never");
}
is("the day's ceiling reached: not today", reminderDue({ ...base, sentToday: SIGNUP_REMINDERS_DAILY }), "wait");
for (const [what, change] of [
  ["sign-up finished unknown", { finished: null }],
  ["suppression unknown", { suppressed: null }],
  ["stop unknown", { stopped: null }],
  ["sent before unknown", { alreadySent: null }],
  ["today's count unknown", { sentToday: null }],
  ["asked time not a number", { askedAt: Number.NaN }],
  ["the yes given in the future", { consent: { version: REMINDER_BOX.version, at: now + 10 } }],
] as const) {
  is(`${what}: unknown, nothing sent (rule 24)`, reminderDue({ ...base, ...change } as never), "unknown");
}

part("No newsletter without the postal address");
is("an empty address: the box is not shown", newsletterBoxShown(""), false);
is("spaces only: not shown", newsletterBoxShown("   "), false);
is("an address: shown", newsletterBoxShown("100 Main St, Dover, DE 19901, USA"), true);

done();
