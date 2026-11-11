/**
 * 416 [KX3], unit 1: a module or a lesson opens at a date and time the
 * creator fixes, in a named time zone, for a class that starts together.
 * Pure rules only (lib/lesson-release-date-rules.ts): the local time becomes
 * one instant, kept with the zone and the clock it was typed as; a time the
 * clock skips or shows twice is refused before it is kept; a fixed date and
 * "days after joining" are never both on one module; a lesson never opens
 * before its module; what cannot be read is unknown, never open.
 */
import {
  RELEASE_PROBLEMS,
  fixedRelease,
  inZone,
  releaseAt,
  releaseState,
  releaseWords,
  scheduleProblem,
  wallIn,
  type FixedRelease,
} from "@/lib/lesson-release-date-rules";
import { done, is, part } from "./check";

const s = (iso: string) => Date.parse(iso) / 1000;
const kept = (wall: string, zone: string): FixedRelease => {
  const r = fixedRelease(wall, zone);
  if (!r.ok) throw new Error(`${wall} ${zone}: ${r.problem}`);
  return r.release;
};

part("A local time becomes one instant, kept with its zone and clock");
is("9:00 AM in New York in winter", fixedRelease("2027-01-11T09:00", "America/New_York"), {
  ok: true,
  release: { at: s("2027-01-11T14:00:00Z"), zone: "America/New_York", wall: "2027-01-11T09:00" },
});
is("9:00 AM in New York in summer", kept("2027-07-12T09:00", "America/New_York").at, s("2027-07-12T13:00:00Z"));
is("the same clock time in Berlin", kept("2027-07-12T09:00", "Europe/Berlin").at, s("2027-07-12T07:00:00Z"));
is("UTC", kept("2027-07-12T09:00", "UTC").at, s("2027-07-12T09:00:00Z"));
is("a zone with a half-hour offset", kept("2027-07-12T09:00", "Asia/Kolkata").at, s("2027-07-12T03:30:00Z"));
is("the instant reads back as the same clock", wallIn(kept("2027-07-12T09:00", "Europe/Berlin").at, "Europe/Berlin"), "2027-07-12T09:00");

part("A time the clock skips or shows twice is refused, with what to do");
is("2:30 AM on the day New York springs forward never happens", fixedRelease("2027-03-14T02:30", "America/New_York"), { ok: false, problem: "skipped" });
is("1:30 AM on the day New York falls back happens twice", fixedRelease("2027-11-07T01:30", "America/New_York"), { ok: false, problem: "ambiguous" });
is("2:30 AM on the day Berlin springs forward", fixedRelease("2027-03-28T02:30", "Europe/Berlin").ok, false);
is("2:30 AM on the day Berlin falls back", fixedRelease("2027-10-31T02:30", "Europe/Berlin"), { ok: false, problem: "ambiguous" });
is("Lord Howe's half-hour change: 1:45 AM shows twice", fixedRelease("2027-04-04T01:45", "Australia/Lord_Howe"), { ok: false, problem: "ambiguous" });
is("an hour later the same day is fine", kept("2027-03-14T03:30", "America/New_York").at, s("2027-03-14T07:30:00Z"));
is("the hour before the fall-back is fine", kept("2027-11-07T00:30", "America/New_York").at, s("2027-11-07T04:30:00Z"));
is("each problem has a sentence that says what to do", Object.values(RELEASE_PROBLEMS).every((w) => w.length > 20 && w.endsWith(".")), true);
is("the skipped hour's sentence asks for another time", /another time/.test(RELEASE_PROBLEMS.skipped), true);

part("What is not a date, a time or a zone is refused, never guessed");
for (const wall of ["2027-02-30T09:00", "2027-13-01T09:00", "2027-01-11T24:00", "2027-01-11T09:60", "2027-01-11", "11/01/2027 09:00", "", "1999-01-11T09:00", "2101-01-11T09:00"]) {
  is(`"${wall}" is not a date and time`, fixedRelease(wall, "UTC"), { ok: false, problem: "format" });
}
is("a number is not a date and time", fixedRelease(1_800_000_000, "UTC"), { ok: false, problem: "format" });
is("a zone that does not exist", fixedRelease("2027-01-11T09:00", "Mars/Olympus"), { ok: false, problem: "zone" });
is("no zone", fixedRelease("2027-01-11T09:00", ""), { ok: false, problem: "zone" });
is("a zone that is not text", fixedRelease("2027-01-11T09:00", 3), { ok: false, problem: "zone" });

part("A fixed date and days after joining are never both on one module");
const jan = kept("2027-01-11T09:00", "America/New_York");
is("days only is fine", scheduleProblem({ dripDays: 7, fixed: null }), null);
is("a fixed date only is fine", scheduleProblem({ dripDays: 0, fixed: jan }), null);
is("both is a conflict", scheduleProblem({ dripDays: 7, fixed: jan }), "both");
is("the conflict says to pick one", /one or the other/.test(RELEASE_PROBLEMS.both), true);
is("a lesson dated before its module is refused", scheduleProblem({ dripDays: 0, fixed: kept("2027-01-04T09:00", "America/New_York") }, jan), "before-module");
is("a lesson dated after its module is fine", scheduleProblem({ dripDays: 0, fixed: kept("2027-01-18T09:00", "America/New_York") }, jan), null);

part("Which date opens a lesson");
const drip = s("2027-02-01T00:00:00Z");
is("no fixed date: the drip date", releaseAt({ module: { dripDays: 7, fixed: null }, lesson: null, dripOpensAt: drip }), drip);
is("the module's fixed date", releaseAt({ module: { dripDays: 0, fixed: jan }, lesson: null, dripOpensAt: drip }), jan.at);
const later = kept("2027-01-18T09:00", "America/New_York");
is("a lesson's own later date", releaseAt({ module: { dripDays: 0, fixed: jan }, lesson: later, dripOpensAt: drip }), later.at);
is("a lesson never opens before its module, even if dated earlier", releaseAt({ module: { dripDays: 7, fixed: null }, lesson: later, dripOpensAt: drip }), drip);
is("a module with both is unknown, never one picked", releaseAt({ module: { dripDays: 7, fixed: jan }, lesson: null, dripOpensAt: drip }), null);
is("a drip date that is not a time is unknown", releaseAt({ module: { dripDays: 7, fixed: null }, lesson: null, dripOpensAt: Number.NaN }), null);


part("Days after joining that cannot be read are unknown, never no drip (Claude 3 and Codex G on #3653)");
for (const days of [Number.NaN, -3, 1.5, Number.POSITIVE_INFINITY, "7" as unknown as number]) {
  is(`days ${String(days)} beside a fixed date: a schedule problem`, scheduleProblem({ dripDays: days, fixed: jan }), "format");
  is(`days ${String(days)} beside a fixed date: never opens on the fixed date`, releaseAt({ module: { dripDays: days, fixed: jan }, lesson: null, dripOpensAt: drip }), null);
  is(`days ${String(days)} alone: unknown`, releaseAt({ module: { dripDays: days, fixed: null }, lesson: null, dripOpensAt: drip }), null);
}
is("control: zero days and a fixed date is still fine", releaseAt({ module: { dripDays: 0, fixed: jan }, lesson: null, dripOpensAt: drip }), jan.at);

part("A drip time of zero or less is not a time: unknown, never open to everyone (Claude 3 on #3653)");
// The caller passes lib/course.ts opensAt (the time the student joined, plus the days), which is always after 1970;
// a missing time read as 0 must not open the lesson for everyone.
is("zero: unknown", releaseAt({ module: { dripDays: 0, fixed: null }, lesson: null, dripOpensAt: 0 }), null);
is("negative: unknown", releaseAt({ module: { dripDays: 0, fixed: null }, lesson: null, dripOpensAt: -5 }), null);
is("and so never open", releaseState(releaseAt({ module: { dripDays: 0, fixed: null }, lesson: null, dripOpensAt: 0 }), jan.at), "unknown");
is("control: the moment a student joined, no days to wait, opens then", releaseAt({ module: { dripDays: 0, fixed: null }, lesson: null, dripOpensAt: drip }), drip);
part("Open, waits, unknown");
is("a second before: waits", releaseState(jan.at, jan.at - 1), "waits");
is("on the instant: open", releaseState(jan.at, jan.at), "open");
is("whoever comes after the date finds it open", releaseState(jan.at, jan.at + 90 * 86_400), "open");
is("an unknown date is never open", releaseState(null, jan.at), "unknown");
is("a now that is not a time is never open", releaseState(jan.at, Number.NaN), "unknown");

part("What the student reads, ahead of time, in words");
is("the date, the time and the zone", releaseWords(jan), "Opens Monday, January 11, 2027 at 9:00 AM EST");
is("in summer the zone says so", releaseWords(kept("2027-07-12T09:00", "America/New_York")), "Opens Monday, July 12, 2027 at 9:00 AM EDT");

part("Changing the zone never moves a date already set");
const moved = inZone(jan, "Europe/Berlin");
is("the instant is the same", moved.at, jan.at);
is("the clock it reads in the new zone", moved.wall, "2027-01-11T15:00");
is("the new zone is kept", moved.zone, "Europe/Berlin");
is("a zone that does not exist keeps the old one", inZone(jan, "Mars/Olympus"), jan);

part("Only a named zone that follows the clocks there, and \"UTC\" (Claude 3 and Codex G on #3653, LEVE)");
is("a fixed offset is not a zone: it never follows summer time", fixedRelease("2027-01-11T09:00", "+05:00"), { ok: false, problem: "zone" });
is("an abbreviation is not a zone: EST is not New York in July", fixedRelease("2027-01-11T09:00", "EST"), { ok: false, problem: "zone" });
is("UTC is", fixedRelease("2027-01-11T09:00", "UTC").ok, true);
is("moving a date to an offset keeps its zone", inZone(jan, "+05:00"), jan);

part("Calendar edges, measured (Claude 3 on #3653, LEVE)");
is("29 February in a leap year", fixedRelease("2028-02-29T09:00", "UTC").ok, true);
is("29 February 2100 does not exist", fixedRelease("2100-02-29T09:00", "UTC"), { ok: false, problem: "format" });
is("the first and last years taken", [fixedRelease("2000-01-01T00:00", "Pacific/Kiritimati").ok, fixedRelease("2100-12-31T23:59", "Pacific/Pago_Pago").ok], [true, true]);
is("a whole day Samoa skipped (30 December 2011) is refused", fixedRelease("2011-12-30T09:00", "Pacific/Apia"), { ok: false, problem: "skipped" });

part("An instant outside what a date can hold is unknown, never a throw (Claude 3 and Codex G on #3653, LEVE)");
is("wallIn past the date range: null", wallIn(8.64e12 + 1, "UTC"), null);
is("words for a kept date past the range: null", releaseWords({ at: 8.64e12 + 1, zone: "UTC", wall: "x" }), null);
is("words for a kept zone that is not one: null", releaseWords({ ...jan, zone: "Mars/Olympus" }), null);
is("moving a date past the range keeps it as it was", inZone({ ...jan, at: 8.64e12 + 1 }, "Europe/Berlin"), { ...jan, at: 8.64e12 + 1 });

done();
