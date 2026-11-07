import { KEPT_CHECKINS, localDay, validPathDay, validTimeZone } from "@/lib/path-rules";

export type PathWeeklySummary = {
  state: "available";
  timeZone: string;
  today: string;
  monday: string;
  sunday: string;
  days: readonly string[];
} | { state: "unavailable" };

/** Civil-date arithmetic, never elapsed local hours: a DST day can have 23 or 25 hours. */
const shift = (day: string, by: number) => new Date(new Date(`${day}T12:00:00Z`).getTime() + by * 86_400_000).toISOString().slice(0, 10);

/** Only dates already saved in the owner's existing Path record; no new reading, check-in or history. */
export function pathWeeklySummary(input: { timeZone: string; checkins: readonly string[] }, now: number): PathWeeklySummary {
  if (!validTimeZone(input.timeZone) || !Number.isFinite(now) || Math.abs(now) >= 8.64e15 || !Array.isArray(input.checkins) || input.checkins.length > KEPT_CHECKINS) return { state: "unavailable" };
  try {
    const today = localDay(input.timeZone, now);
    if (!validPathDay(today)) return { state: "unavailable" };
    const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
    const monday = shift(today, -((weekday + 6) % 7)), sunday = shift(monday, 6);
    if (!validPathDay(monday) || !validPathDay(sunday)) return { state: "unavailable" };
    const days = new Set<string>();
    for (let i = 0; i < input.checkins.length; i++) {
      const day = input.checkins[i];
      if (!Object.hasOwn(input.checkins, i) || !validPathDay(day) || day > today) return { state: "unavailable" };
      if (day >= monday && day <= sunday) days.add(day);
    }
    return { state: "available", timeZone: input.timeZone, today, monday, sunday, days: [...days].sort() };
  } catch {
    return { state: "unavailable" };
  }
}
