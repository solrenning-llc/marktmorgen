/**
 * A team host's hours on the days the clocks change (lib/team-scheduling-rules.ts
 * inHostHours). When the end of a stretch did not exist that day (24:00 the
 * night Santiago skips midnight, or 02:30 the morning New York skips to
 * 03:00), the whole stretch was dropped and every call in it refused, so the
 * host's times vanished for the day. Synthetic hosts only.
 */
import { zonedToUtc, type Range } from "@/lib/call-setup";
import { inHostHours } from "@/lib/team-scheduling-rules";
import { done, is, part } from "./check";

const M = 60_000;
function weeklyOn(weekday: number, ranges: Range[]): Range[][] {
  const w: Range[][] = [[], [], [], [], [], [], []];
  w[weekday] = ranges;
  return w;
}
function allDays(ranges: Range[]): Range[][] {
  return [0, 1, 2, 3, 4, 5, 6].map(() => ranges.map((r) => [r[0], r[1]] as Range));
}

part("inHostHours: a stretch ending at 24:00 the night a midnight is skipped");
{
  // Santiago, 2026: clocks go from 24:00 Saturday 5 September to 01:00 Sunday 6 September.
  const host = { tz: "America/Santiago", weekly: allDays([[1200, 1440]]) };
  const start = zonedToUtc(2026, 9, 5, 1260, host.tz)!; // 21:00 Saturday
  is("a 60-minute call at 21:00 Saturday inside 20:00-24:00 is in the host's hours", inHostHours(host, start, start + 60 * M), true);
}
part("inHostHours: a stretch whose end falls in the spring-forward gap");
{
  // New York, 8 March 2026: stretch 00:00-02:30 (02:30 does not exist that day).
  const host = { tz: "America/New_York", weekly: weeklyOn(0, [[0, 150]]) };
  const start = zonedToUtc(2026, 3, 8, 0, host.tz)!;
  is("a 60-minute call at 00:00 inside 00:00-02:30 is in the host's hours", inHostHours(host, start, start + 60 * M), true);
}

part("inHostHours: what does not fit stays refused");
{
  const host = { tz: "America/New_York", weekly: weeklyOn(0, [[0, 150]]) };
  const start = zonedToUtc(2026, 3, 8, 60, host.tz)!; // 01:00 EST, ends 03:00 EDT: past the 02:30 that became 03:00
  is("a 90-minute call at 01:00 inside 00:00-02:30 on 8 March runs past the stretch", inHostHours(host, start, start + 90 * M), false);
  is("a 60-minute call at 01:00 ends at 03:00 EDT, the stretch's real end", inHostHours(host, start, start + 60 * M), true);
  const ny = { tz: "America/New_York", weekly: allDays([[540, 1020]]) };
  const nine = zonedToUtc(2026, 6, 1, 540, ny.tz)!;
  is("an ordinary day: 09:00-10:00 inside 09:00-17:00", inHostHours(ny, nine, nine + 60 * M), true);
  is("an ordinary day: 16:30-17:30 outside", inHostHours(ny, nine + 450 * M, nine + 510 * M), false);
}

done();
