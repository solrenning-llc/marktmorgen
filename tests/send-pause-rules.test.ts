/**
 * 383 [TB9], unit 1: dates with no marketing email in a store's automations,
 * as pure rules (lib/send-pause-rules.ts). The creator marks dates; a
 * marketing email due on one waits for the next date that is not marked, at
 * the same local time in the store's time zone, daylight saving included (an
 * hour the clocks skip goes to the first time that exists). It waits at most
 * MAX_POSTPONE_DAYS: past that it is held, never dropped or sent twice. A
 * service or required email never waits. Anything that cannot be read is
 * "unknown", and nothing is sent on it. Nothing is wired yet.
 */
import { MAX_PAUSE_DATES, MAX_POSTPONE_DAYS, PAUSE_HORIZON_DAYS, nextSendTime, readPauseDates } from "@/lib/send-pause-rules";
import { partsIn } from "@/lib/call-setup";
import { done, is, part } from "./check";

const NY = "America/New_York";
const at = (iso: string) => Date.parse(iso);
const localOf = (ms: number, tz = NY) => {
  const p = partsIn(ms, tz);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
};

part("The creator's dates, read whole or not at all");
const today = "2026-11-12";
is("a plain list, sorted", readPauseDates(["2026-12-25", "2026-11-26"], today), ["2026-11-26", "2026-12-25"]);
is("an empty list", readPauseDates([], today), []);
is("dates already past are dropped", readPauseDates(["2026-11-01", "2026-11-26"], today), ["2026-11-26"]);
for (const [label, raw] of [
  ["not a list", "2026-11-26"],
  ["a date that does not exist", ["2026-02-30"]],
  ["a date not written in full", ["2026-1-5"]],
  ["a date twice", ["2026-11-26", "2026-11-26"]],
  ["a date with a time", ["2026-11-26T00:00"]],
  ["a number", [20261126]],
  [`more than ${MAX_PAUSE_DATES}`, Array.from({ length: MAX_PAUSE_DATES + 1 }, (_, i) => new Date(Date.UTC(2026, 10, 13 + i)).toISOString().slice(0, 10))],
  [`further than ${PAUSE_HORIZON_DAYS} days`, ["2027-11-20"]],
] as const) is(`refused: ${label}`, readPauseDates(raw, today), null);
is(`exactly ${MAX_PAUSE_DATES} is fine`, readPauseDates(Array.from({ length: MAX_PAUSE_DATES }, (_, i) => new Date(Date.UTC(2026, 10, 13 + i)).toISOString().slice(0, 10)), today)?.length, MAX_PAUSE_DATES);

part("A marketing email on a marked date waits for the next free one, same local time");
const thanksgivingMorning = at("2026-11-26T14:00:00Z"); // 09:00 in New York
is("not marked: sent as due", nextSendTime({ at: thanksgivingMorning, tz: NY, dates: [], kind: "marketing" }), { kind: "send", at: thanksgivingMorning });
const moved = nextSendTime({ at: thanksgivingMorning, tz: NY, dates: ["2026-11-26"], kind: "marketing" });
is("marked: the next day at 09:00 New York", moved.kind === "send" ? localOf(moved.at) : moved.kind, "2026-11-27 09:00");
const twice = nextSendTime({ at: thanksgivingMorning, tz: NY, dates: ["2026-11-26", "2026-11-27"], kind: "marketing" });
is("two marked days in a row: the day after both", twice.kind === "send" ? localOf(twice.at) : twice.kind, "2026-11-28 09:00");
const lateUtc = at("2026-11-27T03:00:00Z"); // 22:00 on the 26th in New York, already the 27th in UTC
const local = nextSendTime({ at: lateUtc, tz: NY, dates: ["2026-11-26"], kind: "marketing" });
is("the store's own date decides, not UTC's", local.kind === "send" ? localOf(local.at) : local.kind, "2026-11-27 22:00");
is("a date marked only in UTC's day is not this store's", nextSendTime({ at: lateUtc, tz: NY, dates: ["2026-11-27"], kind: "marketing" }), { kind: "send", at: lateUtc });

part("Daylight saving");
const beforeSpring = at("2027-03-13T07:30:00Z"); // 02:30 on 13 March 2027 in New York (EST)
const spring = nextSendTime({ at: beforeSpring, tz: NY, dates: ["2027-03-13"], kind: "marketing" });
is("02:30 does not exist on 14 March: the first time that does, 03:00", spring.kind === "send" ? localOf(spring.at) : spring.kind, "2027-03-14 03:00");
const beforeFall = at("2026-10-31T05:30:00Z"); // 01:30 on 31 October 2026 in New York (EDT)
const fall = nextSendTime({ at: beforeFall, tz: NY, dates: ["2026-10-31"], kind: "marketing" });
is("01:30 happens twice on 1 November: sent at one of them, never before the due time", fall.kind === "send" ? [localOf(fall.at), fall.at > beforeFall] : fall.kind, ["2026-11-01 01:30", true]);

part(`At most ${MAX_POSTPONE_DAYS} days, then held, never dropped`);
const run = (n: number) => Array.from({ length: n }, (_, i) => new Date(Date.UTC(2026, 10, 26 + i)).toISOString().slice(0, 10));
const last = nextSendTime({ at: thanksgivingMorning, tz: NY, dates: run(MAX_POSTPONE_DAYS), kind: "marketing" });
is(`${MAX_POSTPONE_DAYS} marked days: sent the day after`, last.kind === "send" ? localOf(last.at) : last.kind, "2026-12-10 09:00");
is(`${MAX_POSTPONE_DAYS + 1} marked days: held`, nextSendTime({ at: thanksgivingMorning, tz: NY, dates: run(MAX_POSTPONE_DAYS + 1), kind: "marketing" }), { kind: "held" });

part("A service or required email never waits");
is("service: sent as due on a marked date", nextSendTime({ at: thanksgivingMorning, tz: NY, dates: ["2026-11-26"], kind: "service" }), { kind: "send", at: thanksgivingMorning });

part("Unknown never sends");
is("a time zone that is not one", nextSendTime({ at: thanksgivingMorning, tz: "Mars/Olympus", dates: [], kind: "marketing" }), { kind: "unknown" });
is("dates that cannot be read", nextSendTime({ at: thanksgivingMorning, tz: NY, dates: ["2026-02-30"], kind: "marketing" }), { kind: "unknown" });
is("dates missing", nextSendTime({ at: thanksgivingMorning, tz: NY, dates: undefined, kind: "marketing" }), { kind: "unknown" });
is("a kind of email it does not know", nextSendTime({ at: thanksgivingMorning, tz: NY, dates: [], kind: "other" }), { kind: "unknown" });
is("a time that is not one", nextSendTime({ at: Number.NaN, tz: NY, dates: [], kind: "marketing" }), { kind: "unknown" });
done();
