/**
 * A call test's booking time on a weekday: one helper for every call test,
 * so the days they book are the same rule everywhere.
 *
 * `days` and `minute` give the time: `minute` minutes after midnight in `tz`
 * on a weekday at least `days` days after `now`, moved forward past a
 * weekend.
 */
import { zonedToUtc } from "@/lib/call-setup";

export const NY = "America/New_York";

export function weekdayAt(days: number, minute: number, now: number = Date.now(), tz: string = NY): number {
  for (let d = days; d < days + 8; d += 1) {
    const day = new Date(now + d * 86_400_000);
    const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(day);
    const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
    if (get("weekday") === "Sat" || get("weekday") === "Sun") continue;
    return zonedToUtc(Number(get("year")), Number(get("month")), Number(get("day")), minute, tz) as number;
  }
  throw new Error("no weekday");
}
