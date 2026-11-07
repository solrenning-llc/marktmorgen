/**
 * Days without automated marketing emails (383 [TB9], unit 1; added
 * 7 November 2026): the rules, on synthetic settings only. Nothing here
 * reads or writes anything; unit 2 wires the rule into the automations.
 */
import { readFileSync } from "node:fs";
import { MAX_NO_SEND_DATES, MAX_WAIT_DAYS, NO_SEND_PROBLEMS, type NoSendDays, noSendDaysWords, readNoSendDays, whenToSend } from "@/lib/no-send-days";
import { done, is, part } from "./check";

const NY = "America/New_York";
const SP = "America/Sao_Paulo";
const DAY = 86_400_000;
// Saturday 7 November 2026, 7:00 AM in New York (EST).
const NOW = Date.UTC(2026, 10, 7, 12, 0);
const weekend: NoSendDays = { timeZone: NY, weekdays: [0, 6], dates: [] };
/** The clock in `tz` at instant `ms`, as a person there reads it. */
const clock = (ms: number, tz: string) => new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }).format(ms);
/** `n` calendar days from `first` (YYYY-MM-DD), as keys. */
const run = (first: string, n: number) => Array.from({ length: n }, (_, i) => new Date(Date.parse(`${first}T00:00:00Z`) + i * DAY).toISOString().slice(0, 10));

part("Set in the studio");
is("weekdays and dates kept sorted, each once", readNoSendDays({ timeZone: NY, weekdays: [6, 0, 6], dates: ["2026-12-25", "2026-12-24", "2026-12-25"] }, NOW), { ok: true, rule: { timeZone: NY, weekdays: [0, 6], dates: ["2026-12-24", "2026-12-25"] } });
is("nothing picked is allowed: every day open", readNoSendDays({ timeZone: NY }, NOW), { ok: true, rule: { timeZone: NY, weekdays: [], dates: [] } });
is("dates already gone in the store's time zone are dropped, today is kept", readNoSendDays({ timeZone: NY, dates: ["2026-11-06", "2026-11-07"] }, NOW), { ok: true, rule: { timeZone: NY, weekdays: [], dates: ["2026-11-07"] } });
// 10:00 PM on Friday 6 November in New York is already Saturday in UTC: the store's day decides.
is("today is the store's day, not the server's", readNoSendDays({ timeZone: NY, dates: ["2026-11-06"] }, Date.UTC(2026, 10, 7, 3, 0)), { ok: true, rule: { timeZone: NY, weekdays: [], dates: ["2026-11-06"] } });
is("a date up to one year ahead, never further", [readNoSendDays({ timeZone: NY, dates: ["2027-11-07"] }, NOW).ok, readNoSendDays({ timeZone: NY, dates: ["2027-11-08"] }, NOW)], [true, { ok: false, why: "dates" }]);
is("refused: a time zone that is not one, missing or too long", [readNoSendDays({ timeZone: "Not/AZone" }, NOW), readNoSendDays({ weekdays: [0] }, NOW), readNoSendDays({ timeZone: "A".repeat(65) }, NOW)], [{ ok: false, why: "time_zone" }, { ok: false, why: "time_zone" }, { ok: false, why: "time_zone" }]);
is("refused: every day of the week, so nothing could ever go out", readNoSendDays({ timeZone: NY, weekdays: [0, 1, 2, 3, 4, 5, 6] }, NOW), { ok: false, why: "weekdays" });
is("weekdays only as whole numbers 0 to 6, in a list", [[7], [-1], [1.5], ["1"], [true], "1", { 0: 1 }].map((weekdays) => readNoSendDays({ timeZone: NY, weekdays }, NOW)), Array(7).fill({ ok: false, why: "weekdays" }));
is("dates only as real year-month-day dates, in a list", [["2026-02-30"], ["2026-2-3"], ["2026-12-25T00:00"], [20261225], [null], "2026-12-25"].map((dates) => readNoSendDays({ timeZone: NY, dates }, NOW)), Array(6).fill({ ok: false, why: "dates" }));
is(`at most ${MAX_NO_SEND_DATES} dates, counted once each, gone ones not counted`, [readNoSendDays({ timeZone: NY, dates: run("2027-01-04", MAX_NO_SEND_DATES).filter((_, i) => i % 7 < 5) }, NOW).ok, readNoSendDays({ timeZone: NY, dates: [...run("2027-01-04", 91).filter((_, i) => i % 7 < 5).slice(0, MAX_NO_SEND_DATES), "2027-01-04", "2026-01-01"] }, NOW).ok, readNoSendDays({ timeZone: NY, dates: run("2027-01-04", 91).filter((_, i) => i % 7 < 5).slice(0, MAX_NO_SEND_DATES + 1) }, NOW)], [true, true, { ok: false, why: "too_many_dates" }]);
is("refused: not an object", [null, "x", [], 3].map((raw) => readNoSendDays(raw, NOW)), Array(4).fill({ ok: false, why: "shape" }));
// Saturday 19 December to Sunday 3 January: two weekends and the ten weekdays between them.
const holidays = [...run("2026-12-21", 5), ...run("2026-12-28", 5)];
is(`refused: more than ${MAX_WAIT_DAYS} days in a row, with the day the stretch starts`, readNoSendDays({ timeZone: NY, weekdays: [0, 6], dates: holidays }, NOW), { ok: false, why: "too_long", from: "2026-12-19" });
is("one open day in the stretch is enough", readNoSendDays({ timeZone: NY, weekdays: [0, 6], dates: holidays.filter((d) => d !== "2026-12-30") }, NOW).ok, true);
is(`dates alone: ${MAX_WAIT_DAYS} in a row allowed, one more refused`, [readNoSendDays({ timeZone: NY, dates: run("2026-12-01", MAX_WAIT_DAYS) }, NOW).ok, readNoSendDays({ timeZone: NY, dates: run("2026-12-01", MAX_WAIT_DAYS + 1) }, NOW)], [true, { ok: false, why: "too_long", from: "2026-12-01" }]);
is("a stretch that starts today counts from today", readNoSendDays({ timeZone: NY, weekdays: [0, 6], dates: run("2026-11-09", 5).concat(run("2026-11-16", 5)) }, NOW), { ok: false, why: "too_long", from: "2026-11-07" });
is("each problem says how to fix it", [NO_SEND_PROBLEMS.weekdays, NO_SEND_PROBLEMS.too_many_dates, NO_SEND_PROBLEMS.too_long("2026-12-19")], ["Leave at least one day of the week open, so emails can go out.", `Pick at most ${MAX_NO_SEND_DATES} dates.`, `From December 19, 2026, that holds emails for more than ${MAX_WAIT_DAYS} days in a row. Open at least one day in that stretch, so emails do not pile up.`]);

part("When an automated email goes out");
const SAT_10AM = Date.UTC(2026, 10, 7, 15, 0);
is("an email about an order is never held, on any day", whenToSend(weekend, "service", SAT_10AM), { send: "now" });
is("marketing on an open day: now", whenToSend(weekend, "marketing", Date.UTC(2026, 10, 9, 15, 0)), { send: "now" });
const held = whenToSend(weekend, "marketing", SAT_10AM);
is("marketing on a held day: the next open day, at the same time of day", [held, held.send === "later" ? clock(held.at, NY) : ""], [{ send: "later", at: Date.UTC(2026, 10, 9, 15, 0), day: "2026-11-09" }, "Monday, November 9, 2026 at 10:00 AM"]);
// Saturday 31 October 2026, 10:00 AM in New York (EDT); the clocks go back on Sunday 1 November.
const beforeChange = whenToSend(weekend, "marketing", Date.UTC(2026, 9, 31, 14, 0));
is("the same clock time across a change of the clocks", beforeChange.send === "later" ? [beforeChange.at, clock(beforeChange.at, NY)] : beforeChange, [Date.UTC(2026, 10, 2, 15, 0), "Monday, November 2, 2026 at 10:00 AM"]);
// Saturday 7 March 2026, 2:30 AM in New York; on Sunday 8 March 2:30 does not exist.
const skipped = whenToSend({ timeZone: NY, weekdays: [6], dates: [] }, "marketing", Date.UTC(2026, 2, 7, 7, 30));
is("a clock time skipped on the open day: an hour later", skipped.send === "later" ? clock(skipped.at, NY) : skipped, "Sunday, March 8, 2026 at 3:30 AM");
const saturdaySP: NoSendDays = { timeZone: SP, weekdays: [6], dates: [] };
is("the store's day decides: Friday 11 PM in São Paulo goes now, though it is Saturday in UTC", whenToSend(saturdaySP, "marketing", Date.UTC(2026, 10, 7, 2, 0)), { send: "now" });
is("Saturday 1 AM in São Paulo waits for Sunday 1 AM", whenToSend(saturdaySP, "marketing", Date.UTC(2026, 10, 7, 4, 0)), { send: "later", at: Date.UTC(2026, 10, 8, 4, 0), day: "2026-11-08" });
is("a picked date holds that day only", whenToSend({ timeZone: NY, weekdays: [], dates: ["2026-12-25"] }, "marketing", Date.UTC(2026, 11, 25, 14, 0)), { send: "later", at: Date.UTC(2026, 11, 26, 14, 0), day: "2026-12-26" });
const longest = whenToSend({ timeZone: NY, weekdays: [], dates: run("2026-12-01", MAX_WAIT_DAYS) }, "marketing", Date.UTC(2026, 11, 1, 15, 0));
is(`never more than ${MAX_WAIT_DAYS} days late`, longest, { send: "later", at: Date.UTC(2026, 11, 1, 15, 0) + MAX_WAIT_DAYS * DAY, day: "2026-12-15" });
const dues = Array.from({ length: 24 * 21 }, (_, h) => Date.UTC(2026, 9, 25, 0, 7) + h * 3_600_000);
is("never earlier than due, always on an open day, never more than the longest wait", dues.every((due) => {
  const w = whenToSend(weekend, "marketing", due);
  if (w.send === "now") return ![0, 6].includes(new Date(Date.parse(new Intl.DateTimeFormat("en-CA", { timeZone: NY, year: "numeric", month: "2-digit", day: "2-digit" }).format(due))).getUTCDay());
  return w.send === "later" && w.at > due && w.at - due <= (MAX_WAIT_DAYS + 1) * DAY && !weekend.weekdays.includes(new Date(Date.parse(w.day)).getUTCDay());
}), true);
is("no setting: now; a setting that could not be read: unknown, so nothing goes out and nothing is dropped", [whenToSend("none", "marketing", SAT_10AM), whenToSend("unknown", "marketing", SAT_10AM), whenToSend("unknown", "service", SAT_10AM)], [{ send: "now" }, { send: "unknown" }, { send: "now" }]);
is("a kept setting that breaks the rules is unknown, never a guess", [whenToSend({ timeZone: NY, weekdays: [0, 1, 2, 3, 4, 5, 6], dates: [] }, "marketing", SAT_10AM), whenToSend({ timeZone: "Not/AZone", weekdays: [6], dates: [] }, "marketing", SAT_10AM), whenToSend({ timeZone: NY, weekdays: [], dates: run("2026-11-07", MAX_WAIT_DAYS + 1) }, "marketing", SAT_10AM)], [{ send: "unknown" }, { send: "unknown" }, { send: "unknown" }]);

part("What the studio says");
is("weekdays from Monday, then dates, then what happens and what is never held", noSendDaysWords({ timeZone: NY, weekdays: [0, 6, 1], dates: ["2026-12-24", "2026-12-25"] }), "Automated marketing emails wait on Mondays, Saturdays and Sundays and on 2 dates you picked. They go out on the next day you allow, at the same time of day, in your time zone (America/New_York). Emails about an order, like receipts and access links, are never held.");
is("one date, no weekdays", noSendDaysWords({ timeZone: SP, weekdays: [], dates: ["2026-12-25"] }), "Automated marketing emails wait on 1 date you picked. They go out on the next day you allow, at the same time of day, in your time zone (America/Sao_Paulo). Emails about an order, like receipts and access links, are never held.");
is("nothing picked", noSendDaysWords({ timeZone: NY, weekdays: [], dates: [] }), "Automated marketing emails go out on any day.");

part("No new cost");
const source = readFileSync("lib/no-send-days.ts", "utf8");
is("imports only the time zone helpers: no read, no write, no provider", [...source.matchAll(/^import .* from "(.+)";$/gm)].map((m) => m[1]), ["@/lib/call-setup"]);

done();
