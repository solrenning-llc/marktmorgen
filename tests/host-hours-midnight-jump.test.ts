/**
 * A team host's hours that end at midnight, or at a time the clocks skip, on
 * the day their zone changes its clocks (lib/team-scheduling-rules.ts,
 * inHostHours). Chile, Cuba and Egypt move their clocks forward at midnight:
 * on the evening before, "24:00" is a time nobody's clock shows, and the whole
 * stretch was thrown away, so a host with "8 p.m. to midnight" was never free
 * that evening. A stretch's edge the clocks skip is now the first instant
 * after it that exists: the moment the clocks jump. Synthetic, no Redis.
 */
import { partsIn, zonedToUtc } from "@/lib/call-setup";
import { inHostHours } from "@/lib/team-scheduling-rules";
import { done, is, part } from "./check";

type Weekly = [number, number][][];
const weeklyOn = (weekday: number, stretch: [number, number]): Weekly => Array.from({ length: 7 }, (_, d) => (d === weekday ? [stretch] : []));
const HOUR = 3600_000;

function main(): void {
  part("The evening before the clocks jump at midnight");
  for (const [tz, y, m, d] of [["America/Santiago", 2026, 9, 5], ["America/Havana", 2026, 3, 7], ["Africa/Cairo", 2026, 4, 23]] as const) {
    const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    const host = { tz, weekly: weeklyOn(weekday, [20 * 60, 24 * 60]) };
    const nine = zonedToUtc(y, m, d, 21 * 60, tz)!;
    const eleven = zonedToUtc(y, m, d, 23 * 60, tz)!;
    is(`${tz}: (setup) the next midnight does not exist there`, zonedToUtc(y, m, d + 1, 0, tz), null);
    is(`${tz}: 9 to 10 p.m. is within 8 p.m. to midnight`, inHostHours(host, nine, nine + HOUR), true);
    is(`${tz}: and 11 p.m. to the jump, the last hour of the day`, inHostHours(host, eleven, eleven + HOUR), true);
    is(`${tz}: an hour past the jump is not`, inHostHours(host, eleven, eleven + 2 * HOUR), false);
  }

  part("A stretch ending inside the hour the clocks skip");
  // New York, 8 March 2026: 2:00 becomes 3:00; "until 2:30" ends at the jump.
  const tz = "America/New_York";
  const host = { tz, weekly: weeklyOn(0, [60, 150]) };
  const one = zonedToUtc(2026, 3, 8, 60, tz)!;
  is("(setup) 2:30 does not exist that day", zonedToUtc(2026, 3, 8, 150, tz), null);
  is("1 a.m. to the jump is within it", inHostHours(host, one, one + HOUR), true);
  is("past the jump is not", inHostHours(host, one, one + 90 * 60_000), false);
  is("(setup) the jump is an hour after 1 a.m.", partsIn(one + HOUR, tz).hour, 3);
  const opensInGap = { tz, weekly: weeklyOn(0, [150, 300]) };
  const three = zonedToUtc(2026, 3, 8, 180, tz)!;
  is("a stretch from 2:30, which does not exist, starts at the jump: 3 to 4 a.m. is within it", inHostHours(opensInGap, three, three + HOUR), true);

  part("Days without a clock change are as before");
  const plain = { tz: "America/Santiago", weekly: weeklyOn(new Date(Date.UTC(2026, 8, 12)).getUTCDay(), [20 * 60, 24 * 60]) };
  const late = zonedToUtc(2026, 9, 12, 23 * 60, "America/Santiago")!;
  is("11 p.m. to midnight fits", inHostHours(plain, late, late + HOUR), true);
  is("past midnight does not", inHostHours(plain, late, late + 2 * HOUR), false);
  done();
}

main();
