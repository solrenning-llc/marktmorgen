/**
 * 500 [OX2], unit 1: one polite reminder, at most, for a pitch the creator
 * sent and nobody answered. Pure rules only (lib/outreach-reminder-rules.ts):
 * when the studio may offer the reminder's draft, and what the draft says.
 * Nothing here is sent by Marktmorgen; the draft opens in the creator's own
 * mailbox, as the first email did. Rule 24: a state this code cannot read is
 * "unknown", never a reminder.
 */
import {
  REMINDER_DAY_CHOICES,
  REMINDER_DEFAULT_DAYS,
  cleanReminderDays,
  promisedOnce,
  reminderDraft,
  reminderState,
} from "@/lib/outreach-reminder-rules";
import { MAX_PITCH_SUBJECT, OUTREACH_COUNTRIES, pitchFooter, type CountryRule } from "@/lib/outreach-rules";
import { done, is, part } from "./check";

const DAY = 86_400;
const SENT = 1_800_000_000;
const country = (code: string) => OUTREACH_COUNTRIES.find((c) => c.code === code) as CountryRule;
const footer = (code: string) =>
  pitchFooter({
    sender: { name: "Ana Lima", address: "1 Main St, Austin, TX 78701" },
    storeUrl: "https://marktmorgen.com/ana",
    page: "https://brand.example/contact",
    country: country(code),
    stopUrl: "https://marktmorgen.com/outreach/stop/" + "a".repeat(32),
  });
const base = {
  status: "sent" as const,
  sentAt: SENT,
  footer: footer("CA"),
  remindedAt: 0,
  domainStopped: false,
  refusesProposals: false,
  waitDays: 7,
};

part("The wait the creator chooses: buttons, 7 by default");
is("the default is 7 days", REMINDER_DEFAULT_DAYS, 7);
is("the choices are a few buttons, the default among them", REMINDER_DAY_CHOICES.includes(REMINDER_DEFAULT_DAYS), true);
is("every choice is a whole number of days from 3 to 30", REMINDER_DAY_CHOICES.every((d) => Number.isInteger(d) && d >= 3 && d <= 30), true);
is("a chosen day is kept", cleanReminderDays(14), 14);
is("a day that is not a choice falls back to the default", cleanReminderDays(2), 7);
is("a text, a fraction or nothing falls back to the default", [cleanReminderDays("10"), cleanReminderDays(7.5), cleanReminderDays(undefined)], [7, 7, 7]);

part("Waiting, then due");
is("the day it was sent, it waits, and says when", reminderState({ ...base, now: SENT + 60 }), { state: "waiting", dueAt: SENT + 7 * DAY });
is("a second before the day, it still waits", reminderState({ ...base, now: SENT + 7 * DAY - 1 }).state, "waiting");
is("on the day, the reminder is offered", reminderState({ ...base, now: SENT + 7 * DAY }), { state: "due" });
is("weeks later it is still offered once", reminderState({ ...base, now: SENT + 40 * DAY }).state, "due");
is("the creator's own choice of days decides", reminderState({ ...base, waitDays: 3, now: SENT + 3 * DAY }).state, "due");
is("a wait that is not a choice reads as the default", reminderState({ ...base, waitDays: 1, now: SENT + 2 * DAY }), { state: "waiting", dueAt: SENT + 7 * DAY });

part("At most one");
is("once a reminder was opened to send, there is no other", reminderState({ ...base, remindedAt: SENT + 8 * DAY, now: SENT + 60 * DAY }), { state: "closed", reason: "reminded" });

part("Anything from them, or a no, ends it at once");
for (const status of ["replied", "deal", "stopped"] as const) {
  is(`a pitch that is "${status}" gets no reminder`, reminderState({ ...base, status, now: SENT + 30 * DAY }), { state: "closed", reason: status });
}
is("a stop kept for their domain ends it, even with the pitch still \"sent\"", reminderState({ ...base, domainStopped: true, now: SENT + 30 * DAY }), { state: "closed", reason: "stopped" });
is("a \"no solicitations\" on their site ends it", reminderState({ ...base, refusesProposals: true, now: SENT + 30 * DAY }), { state: "closed", reason: "refused" });
is("a stop wins over a reminder already opened", reminderState({ ...base, domainStopped: true, remindedAt: SENT + 8 * DAY, now: SENT + 30 * DAY }), { state: "closed", reason: "stopped" });
is("a draft never sent has nothing to remind", reminderState({ ...base, status: "draft", sentAt: 0, now: SENT + 30 * DAY }), { state: "closed", reason: "not-sent" });

part("What the first email already promised is kept");
is("the United States footer says \"sent once\"", promisedOnce(footer("US")), true);
is("the other open countries' footers do not", ["CA", "GB", "AU", "IE", "FR", "SE"].map((c) => promisedOnce(footer(c))), [false, false, false, false, false, false]);
is("a pitch whose email said \"sent once\" gets no reminder", reminderState({ ...base, footer: footer("US"), now: SENT + 30 * DAY }), { state: "closed", reason: "promised-once" });

part("Rule 24: what cannot be read is unknown, never a reminder");
is("a \"sent\" pitch with no time it was sent", reminderState({ ...base, sentAt: 0, now: SENT + 30 * DAY }).state, "unknown");
is("a time sent after now", reminderState({ ...base, now: SENT - 10 }).state, "unknown");
is("a stop list that could not be read", reminderState({ ...base, domainStopped: null, now: SENT + 30 * DAY }).state, "unknown");
is("a site that could not be read again", reminderState({ ...base, refusesProposals: null, now: SENT + 30 * DAY }).state, "unknown");
is("a reminder time that is not a number", reminderState({ ...base, remindedAt: Number.NaN, now: SENT + 30 * DAY }).state, "unknown");
is("a now that is not a time", reminderState({ ...base, now: Number.NaN }).state, "unknown");
is("a footer that is not text", reminderState({ ...base, footer: undefined as unknown as string, now: SENT + 30 * DAY }).state, "unknown");
is("a stop still wins over an unreadable site", reminderState({ ...base, domainStopped: true, refusesProposals: null, now: SENT + 30 * DAY }), { state: "closed", reason: "stopped" });

part("The draft: short, polite, honest, with the same way to stop");
const draft = reminderDraft({ subject: "A sponsorship idea for Brand", sentAt: SENT, footer: footer("CA") });
is("the subject says it is a follow-up, never \"Re:\" for a thread that does not exist", draft.subject, "Following up: A sponsorship idea for Brand");
is("the body names the day the first email went", draft.body.includes("on January 15"), true);
is("the body promises no more follow-ups on this email", draft.body.includes("I will not follow up on this email again"), true);
// The same business may get a new pitch after REPITCH_DAYS (lib/outreach-rules.ts): no promise of never again (Claude 3 and Codex G on #3655).
is("never an absolute promise the repitch rule would break", /will not write again|never write again|no more emails/i.test(draft.body), false);
is("the body is short", draft.body.length <= 400, true);
is("no pressure, urgency or figure", /\b(urgent|last chance|only|today|limited|\d+%)\b/i.test(draft.body), false);
is("the whole email keeps the first email's footer, stop link included", draft.text.endsWith(footer("CA")), true);
const long = reminderDraft({ subject: "x".repeat(MAX_PITCH_SUBJECT), sentAt: SENT, footer: footer("CA") });
is("a long subject is cut to the subject limit", long.subject.length, MAX_PITCH_SUBJECT);
is("a cut subject ends with an ellipsis", long.subject.endsWith("…"), true);
is("an empty subject still reads", reminderDraft({ subject: "  ", sentAt: SENT, footer: footer("CA") }).subject, "Following up on my email");

done();
