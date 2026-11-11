/**
 * 289 [H4-3], unit 1: a weekly progress email to a student, as pure rules
 * (lib/weekly-progress-rules.ts). Off unless the student chose it ("yes"
 * exactly) and the store allows it; never on a week with nothing new; at
 * most one weekly message per person, never on top of a reminder to an idle
 * member the same week. The week is the store's (ISO, in its time zone).
 * Anything that cannot be read is not sent. Nothing is wired yet.
 */
import { progressWeekOf, shouldSendWeeklyProgress } from "@/lib/weekly-progress-rules";
import { done, is, part } from "./check";

const base = { choice: "yes", storeAllows: true, lessonsDone: 2, eventsAhead: 0, alreadyThisWeek: false };

part("Off unless the student chose it and the store allows it");
is("both: sent", shouldSendWeeklyProgress(base), "send");
is("never chosen", shouldSendWeeklyProgress({ ...base, choice: undefined }), "skip");
for (const other of ["no", "Yes", "", null, true]) is(`chosen as ${JSON.stringify(other)}: not`, shouldSendWeeklyProgress({ ...base, choice: other }), "skip");
is("the store turned it off", shouldSendWeeklyProgress({ ...base, storeAllows: false }), "skip");

part("A week with nothing new is never emailed");
is("no lesson done and no event ahead", shouldSendWeeklyProgress({ ...base, lessonsDone: 0, eventsAhead: 0 }), "skip");
is("only an event ahead", shouldSendWeeklyProgress({ ...base, lessonsDone: 0, eventsAhead: 1 }), "send");

part("One weekly message per person");
is("already had one this week (this or a reminder)", shouldSendWeeklyProgress({ ...base, alreadyThisWeek: true }), "skip");

part("Unknown is never sent");
is("lessons that cannot be counted", shouldSendWeeklyProgress({ ...base, lessonsDone: -1 }), "unknown");
is("events that cannot be counted", shouldSendWeeklyProgress({ ...base, eventsAhead: Number.NaN }), "unknown");
is("whether the store allows it is unknown", shouldSendWeeklyProgress({ ...base, storeAllows: undefined as unknown as boolean }), "unknown");
is("whether one was sent this week is unknown", shouldSendWeeklyProgress({ ...base, alreadyThisWeek: null as unknown as boolean }), "unknown");

part("The store's ISO week");
const NY = "America/New_York";
is("a Monday morning", progressWeekOf(Date.parse("2026-11-09T15:00:00Z"), NY), "2026-W46");
is("Sunday night in New York is still the same week, though Monday in UTC", progressWeekOf(Date.parse("2026-11-16T03:00:00Z"), NY), "2026-W46");
is("the first days of January can be the last week of the year before", progressWeekOf(Date.parse("2027-01-01T15:00:00Z"), NY), "2026-W53");
is("a time zone that is not one", progressWeekOf(Date.parse("2026-11-09T15:00:00Z"), "Nowhere/Here"), null);
done();
