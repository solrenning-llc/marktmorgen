/**
 * Time-zone edges of call slots (lib/call-setup.ts openSlots / zonedToUtc,
 * lib/team-scheduling-rules.ts dayBounds, lib/booking-link-rules.ts linkEnd).
 * On the day the clocks go forward, openSlots checked only the wall clock
 * (t + minutes <= to), so a call could run past the creator's stretch in real
 * time (New York 01:00-03:00, 120 minutes: 01:00 EST ends 04:00 EDT) and two
 * offered one-to-one calls could overlap (Berlin, 90 minutes). The rest is
 * verified as it stands. Synthetic setups and injected `now` values only.
 */
import { openSlots, isOpenSlot, partsIn, zonedToUtc, readSetup, type CallSetup, type Range } from "@/lib/call-setup";
import { dayBounds } from "@/lib/team-scheduling-rules";
import { linkEnd } from "@/lib/booking-link-rules";
import { done, is, part } from "./check";

const H = 3600_000;
const M = 60_000;

function weeklyOn(weekday: number, ranges: Range[]): Range[][] {
  const w: Range[][] = [[], [], [], [], [], [], []];
  w[weekday] = ranges;
  return w;
}
function allDays(ranges: Range[]): Range[][] {
  return [0, 1, 2, 3, 4, 5, 6].map(() => ranges.map((r) => [r[0], r[1]] as Range));
}
function setup(over: Partial<CallSetup>): CallSetup {
  return {
    kind: "weekly", minutes: 60, tz: "UTC", weekly: allDays([[540, 1020]]), noticeHours: 1, horizonDays: 14,
    bufferMinutes: 0, room: null, video: false, meet: null, seats: 1, sessions: [], ...over,
  };
}
const allStarts = (s: CallSetup, now: number) => openSlots(s, now, []).flatMap((d) => d.starts);
const clockOf = (ms: number, tz: string) => { const p = partsIn(ms, tz); return p.hour * 60 + p.minute; };

part("openSlots: a call that crosses the spring-forward gap overruns the creator's stretch in real time");
{
  // New York, Sunday 8 March 2026: 02:00 EST jumps to 03:00 EDT. Stretch 01:00-03:00, 120-minute call.
  const s = setup({ tz: "America/New_York", minutes: 120, weekly: weeklyOn(0, [[60, 180]]) });
  const now = Date.UTC(2026, 2, 1, 12);
  const starts = allStarts(s, now).filter((t) => partsIn(t, s.tz).month === 3 && partsIn(t, s.tz).day === 8);
  const stretchEnd = zonedToUtc(2026, 3, 8, 180, s.tz)!;
  is("every offered call on 8 March ends by 03:00 EDT, the end of the stretch", starts.every((t) => t + 120 * M <= stretchEnd), true);
}
{
  // Berlin, Sunday 29 March 2026: 02:00 CET jumps to 03:00 CEST. Stretch 00:00-06:00, 90-minute call: offered calls overlap.
  const s = setup({ tz: "Europe/Berlin", minutes: 90, weekly: weeklyOn(0, [[0, 360]]) });
  const now = Date.UTC(2026, 2, 22, 12);
  const starts = allStarts(s, now).filter((t) => partsIn(t, s.tz).month === 3 && partsIn(t, s.tz).day === 29).sort((a, b) => a - b);
  const overlap = starts.some((t, i) => i > 0 && starts[i - 1] + 90 * M > t);
  is("no two offered one-to-one calls on 29 March overlap in real time", overlap, false);
  const stretchEnd = zonedToUtc(2026, 3, 29, 360, s.tz)!;
  is("every offered call on 29 March ends by 06:00 CEST", starts.every((t) => t + 90 * M <= stretchEnd), true);
}
{
  // Lord Howe, Sunday 4 October 2026: 02:00 jumps to 02:30. Stretch 01:00-03:00, 120-minute call.
  const s = setup({ tz: "Australia/Lord_Howe", minutes: 120, weekly: weeklyOn(0, [[60, 180]]) });
  const now = Date.UTC(2026, 8, 27, 0);
  const starts = allStarts(s, now).filter((t) => partsIn(t, s.tz).month === 10 && partsIn(t, s.tz).day === 4);
  const stretchEnd = zonedToUtc(2026, 10, 4, 180, s.tz)!;
  is("Lord Howe: every offered call on 4 October ends by 03:00", starts.every((t) => t + 120 * M <= stretchEnd), true);
}

part("openSlots: the change day still offers every call that fits");
{
  const s = setup({ tz: "America/New_York", minutes: 60, weekly: weeklyOn(0, [[60, 180]]) });
  const starts = allStarts(s, Date.UTC(2026, 2, 1, 12)).filter((t) => partsIn(t, s.tz).month === 3 && partsIn(t, s.tz).day === 8);
  is("New York 8 March, 01:00-03:00, 60 minutes: only 01:00 EST (02:00 does not exist)", starts.map((t) => new Date(t).toISOString()), ["2026-03-08T06:00:00.000Z"]);
}
{
  const s = setup({ tz: "Europe/Berlin", minutes: 90, weekly: weeklyOn(0, [[0, 360]]) });
  const starts = allStarts(s, Date.UTC(2026, 2, 22, 12)).filter((t) => partsIn(t, s.tz).month === 3 && partsIn(t, s.tz).day === 29);
  is("Berlin 29 March, 00:00-06:00, 90 minutes: 00:00 CET, 01:30 CET, 04:30 CEST", starts.map((t) => new Date(t).toISOString()), ["2026-03-28T23:00:00.000Z", "2026-03-29T00:30:00.000Z", "2026-03-29T02:30:00.000Z"]);
}
{
  const s = setup({ tz: "America/Fortaleza", minutes: 60, weekly: weeklyOn(0, [[540, 720]]) });
  const starts = allStarts(s, Date.UTC(2026, 2, 1, 12)).filter((t) => partsIn(t, s.tz).month === 3 && partsIn(t, s.tz).day === 8);
  is("Fortaleza (no clock change) 8 March, 09:00-12:00: three calls", starts.length, 3);
}

part("verified: zonedToUtc and partsIn at odd offsets and DST edges");
{
  is("Kolkata 09:00 = 03:30Z", zonedToUtc(2026, 6, 1, 540, "Asia/Kolkata"), Date.UTC(2026, 5, 1, 3, 30));
  is("Kathmandu 09:00 = 03:15Z", zonedToUtc(2026, 6, 1, 540, "Asia/Kathmandu"), Date.UTC(2026, 5, 1, 3, 15));
  is("Chatham 09:00 in July (+12:45) = 20:15Z the day before", zonedToUtc(2026, 7, 1, 540, "Pacific/Chatham"), Date.UTC(2026, 5, 30, 20, 15));
  is("Fortaleza 23:30 = 02:30Z next day", zonedToUtc(2026, 12, 31, 1410, "America/Fortaleza"), Date.UTC(2027, 0, 1, 2, 30));
  is("NY 02:30 on 8 March 2026 does not exist", zonedToUtc(2026, 3, 8, 150, "America/New_York"), null);
  is("NY 03:00 on 8 March 2026 = 07:00Z", zonedToUtc(2026, 3, 8, 180, "America/New_York"), Date.UTC(2026, 2, 8, 7));
  is("Berlin 02:30 on 29 March 2026 does not exist", zonedToUtc(2026, 3, 29, 150, "Europe/Berlin"), null);
  is("Lord Howe 02:15 on 4 October 2026 does not exist", zonedToUtc(2026, 10, 4, 135, "Australia/Lord_Howe"), null);
  is("Lord Howe 02:30 on 4 October 2026 exists", zonedToUtc(2026, 10, 4, 150, "Australia/Lord_Howe") !== null, true);
  is("Chatham 03:00 on 27 September 2026 does not exist", zonedToUtc(2026, 9, 27, 180, "Pacific/Chatham"), null);
  const amb = zonedToUtc(2026, 11, 1, 90, "America/New_York")!;
  is("NY ambiguous 01:30 on 1 Nov resolves to a real 01:30", clockOf(amb, "America/New_York"), 90);
  const ambB = zonedToUtc(2026, 10, 25, 150, "Europe/Berlin")!;
  is("Berlin ambiguous 02:30 on 25 Oct resolves to a real 02:30", clockOf(ambB, "Europe/Berlin"), 150);
  is("24:00 is next day's midnight", zonedToUtc(2026, 12, 31, 1440, "America/Fortaleza"), Date.UTC(2027, 0, 1, 3));
}

part("verified: fall-back day offers each clock slot once and never overlaps");
for (const [tz, y, mo, d] of [["America/New_York", 2026, 11, 1], ["Europe/Berlin", 2026, 10, 25], ["Australia/Lord_Howe", 2026, 4, 5]] as const) {
  const wd = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  const s = setup({ tz, minutes: 30, weekly: weeklyOn(wd, [[0, 300]]) });
  const now = Date.UTC(y, mo - 1, d - 3);
  const starts = allStarts(s, now).filter((t) => partsIn(t, tz).day === d).sort((a, b) => a - b);
  const clocks = starts.map((t) => clockOf(t, tz));
  is(`${tz}: no clock time offered twice`, new Set(clocks).size, clocks.length);
  is(`${tz}: no overlapping slots`, starts.every((t, i) => i === 0 || starts[i - 1] + 30 * M <= t), true);
  is(`${tz}: every offered slot is accepted by isOpenSlot`, starts.every((t) => isOpenSlot(s, now, [], t)), true);
}

part("verified: calendar rollover and day grouping");
{
  // Fortaleza, stretch whole day, from 30 Dec 2026 across 1 Jan 2027.
  const s = setup({ tz: "America/Fortaleza", minutes: 60, weekly: allDays([[0, 1440]]), horizonDays: 7 });
  const now = Date.UTC(2026, 11, 30, 12);
  const days = openSlots(s, now, []);
  is("31 Dec and 1 Jan both present", ["2026-12-31", "2027-01-01"].every((k) => days.some((d) => d.date === k)), true);
  const dec31 = days.find((d) => d.date === "2026-12-31")!;
  is("31 Dec has 24 hourly slots including 23:00", dec31.starts.length, 24);
  is("each slot's creator date matches its group", days.every((d) => d.starts.every((t) => { const p = partsIn(t, s.tz); return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}` === d.date; })), true);
  const leap = openSlots(setup({ tz: "Asia/Kolkata", horizonDays: 7 }), Date.UTC(2028, 1, 26), []);
  is("29 Feb 2028 offered in Kolkata", leap.some((d) => d.date === "2028-02-29"), true);
  const noLeap = openSlots(setup({ tz: "Asia/Kolkata", horizonDays: 7 }), Date.UTC(2027, 1, 26), []);
  is("no 29 Feb 2027", noLeap.some((d) => d.date === "2027-02-29"), false);
}
{
  // Notice and horizon edges.
  const s = setup({ tz: "UTC", noticeHours: 2, horizonDays: 7, weekly: allDays([[0, 1440]]) });
  const now = Date.UTC(2026, 5, 1, 10, 0);
  const st = allStarts(s, now);
  is("first slot is at notice exactly", Math.min(...st), now + 2 * H);
  is("last slot is at horizon exactly", Math.max(...st), now + 7 * 24 * H);
  is("a slot before the notice is refused", isOpenSlot(s, now, [], now + H), false);
}

part("verified: readSetup refuses bad zones and hours");
{
  const base = { minutes: 60, tz: "America/Fortaleza", noticeHours: 1, horizonDays: 14, weekly: allDays([[540, 1020]]) };
  is("bad tz", readSetup({ ...base, tz: "Mars/Olympus" }), "tz");
  is("end past 24:00", readSetup({ ...base, weekly: allDays([[0, 1445]]) }), "weekly");
  is("stretch shorter than the call", readSetup({ ...base, weekly: allDays([[540, 580]]) }), "weekly");
  is("24:00 end accepted", typeof readSetup({ ...base, weekly: allDays([[1380, 1440]]) }), "object");
  is("live session in the gap refused", readSetup({ kind: "live", tz: "America/New_York", sessions: [{ date: "2026-03-08", time: "02:30", minutes: 60, seats: 3 }] }), "session_time");
}

part("verified: dayBounds and linkEnd across DST");
{
  const [a, b] = dayBounds(Date.UTC(2026, 10, 1, 12), "America/New_York");
  is("NY 1 Nov 2026 is 25 hours", (b - a) / H, 25);
  const [c, e] = dayBounds(Date.UTC(2026, 8, 6, 12), "America/Santiago");
  is("Santiago 6 Sep 2026 starts at 01:00 and lasts 23 hours", [clockOf(c, "America/Santiago"), (e - c) / H], [60, 23]);
  const made = Date.UTC(2026, 9, 29, 14, 7, 33);
  const end = linkEnd(made, 7, "America/New_York");
  is("link made 10:07:33 EDT ends 10:07:33 EST 7 days later", [clockOf(end, "America/New_York"), end - made], [607, 7 * 24 * H + H]);
  const kat = linkEnd(Date.UTC(2026, 5, 1, 6), 1, "Asia/Kathmandu");
  is("Kathmandu link one day", kat - Date.UTC(2026, 5, 1, 6), 24 * H);
  is("bad zone falls back to UTC", linkEnd(Date.UTC(2026, 5, 1), 3, "No/Where"), Date.UTC(2026, 5, 4));
}

done();
