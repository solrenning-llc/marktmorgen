/**
 * 416 [KX3]: a module or a lesson that opens at a date and time the creator
 * fixes, for a class that starts together, on top of what exists: `dripDays`
 * (days after each student's clock starts) and the course's `startsAt` (one
 * clock for a whole cohort; lib/course.ts).
 *
 * The creator types a local date and time and picks the zone it is in. It is
 * turned into ONE instant before anything is kept, and kept with the zone
 * and the clock it was typed as, so the date never moves by itself when the
 * zone is changed later (inZone keeps the instant and says how its clock now
 * reads). A time the clocks skip that day, or show twice, is refused with
 * what to do, never guessed: the whole class opens at one moment.
 *
 * A module opens either on a fixed date or some days after joining, never
 * both (scheduleProblem); a lesson never opens before its module (releaseAt
 * takes the later of the two). Rule 24: a schedule that cannot be read, or a
 * time that is not one, is "unknown", which is never open. Whether a student
 * may see a lesson at all stays with the course's own access checks: an open
 * date gives nothing to somebody who does not have the course.
 *
 * Pure: no storage, no network, so the studio, the course page and the
 * server read the same rule.
 */
import { partsIn } from "@/lib/call-setup";

/** A date fixed by the creator: the instant (seconds), the zone, and the local clock as it was typed. */
export type FixedRelease = { at: number; zone: string; wall: string };

export type ReleaseProblem = "format" | "zone" | "skipped" | "ambiguous" | "both" | "before-module";

/** What the studio says beside the field, with what to do. */
export const RELEASE_PROBLEMS: Record<ReleaseProblem, string> = {
  format: "Pick a date and a time from the calendar, between the years 2000 and 2100.",
  zone: "Pick the time zone from the list, like America/New_York.",
  skipped: "The clocks skip that time that day, when they move forward. Pick another time, like an hour later.",
  ambiguous: "That time happens twice that day, when the clocks move back. Pick another time, like an hour later, so everyone gets it at the same moment.",
  both: "A module opens on a fixed date or some days after each student joins. Pick one or the other.",
  "before-module": "A lesson cannot open before its module. Pick a date on or after the module's date.",
};

export const FIRST_YEAR = 2000;
export const LAST_YEAR = 2100;

/** As a date-and-time field gives it: 2027-01-11T09:00. */
const WALL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** The zone's own name, or null when it is not a zone. */
function zoneName(zone: unknown): string | null {
  if (typeof zone !== "string" || !zone.trim()) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

const two = (n: number) => String(n).padStart(2, "0");

/** The local clock in `zone` at instant `at` (seconds), as 2027-01-11T09:00; null when `zone` is not one. */
export function wallIn(at: number, zone: string): string | null {
  if (!Number.isFinite(at) || !zoneName(zone)) return null;
  const p = partsIn(at * 1000, zone);
  return `${p.year}-${two(p.month)}-${two(p.day)}T${two(p.hour)}:${two(p.minute)}`;
}

/** How far `zone` is ahead of UTC at instant `ms`, in minutes. */
function offsetAt(ms: number, zone: string): number {
  const p = partsIn(ms, zone);
  return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(ms / MINUTE_MS) * MINUTE_MS) / MINUTE_MS);
}

/** A local date and time in a zone, as the one instant it names, or why not. */
export function fixedRelease(wall: unknown, zone: unknown): { ok: true; release: FixedRelease } | { ok: false; problem: ReleaseProblem } {
  const m = typeof wall === "string" ? WALL.exec(wall) : null;
  if (!m) return { ok: false, problem: "format" };
  const [year, month, day, hour, minute] = m.slice(1).map(Number);
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const back = new Date(naive);
  if (
    year < FIRST_YEAR || year > LAST_YEAR || hour > 23 || minute > 59 ||
    back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day
  ) {
    return { ok: false, problem: "format" };
  }
  const name = zoneName(zone);
  if (!name) return { ok: false, problem: "zone" };
  // Every instant whose clock there reads this: the offsets of the days around it cover a change that day.
  const found = new Set<number>();
  for (const probe of [naive - 2 * DAY_MS, naive, naive + 2 * DAY_MS]) {
    const at = naive - offsetAt(probe, name) * MINUTE_MS;
    if (wallIn(at / 1000, name) === m[0]) found.add(at);
  }
  if (found.size === 0) return { ok: false, problem: "skipped" };
  if (found.size > 1) return { ok: false, problem: "ambiguous" };
  return { ok: true, release: { at: [...found][0] / 1000, zone: name, wall: m[0] } };
}

/**
 * Whether a module's schedule, or a lesson's date against its module's, can
 * be kept. A module with both a fixed date and days after joining is refused:
 * which one wins would be a guess.
 */
export function scheduleProblem(unit: { dripDays: number; fixed: FixedRelease | null }, moduleFixed?: FixedRelease | null): ReleaseProblem | null {
  // Days after joining that are not a whole number from zero up cannot be read: never taken as "no drip" (rule 24;
  // Claude 3 and Codex G on #3653).
  if (!Number.isInteger(unit.dripDays) || unit.dripDays < 0) return "format";
  if (unit.fixed && unit.dripDays > 0) return "both";
  if (unit.fixed && moduleFixed && unit.fixed.at < moduleFixed.at) return "before-module";
  return null;
}

/**
 * When a lesson opens: its module's fixed date, or else the module's drip
 * date (lib/course.ts opensAt), and never before that even when the lesson
 * has a date of its own. Null when the schedule cannot be read: days after
 * joining that are not a whole number from zero, or a drip time of zero or
 * less (the caller passes lib/course.ts opensAt, never 0 for "open now").
 */
export function releaseAt(input: {
  module: { dripDays: number; fixed: FixedRelease | null };
  lesson: FixedRelease | null;
  dripOpensAt: number;
}): number | null {
  if (scheduleProblem(input.module)) return null;
  const moduleAt = input.module.fixed ? input.module.fixed.at : input.dripOpensAt;
  // A drip time is lib/course.ts opensAt: the time the student joined plus the days, always after 1970. Zero or less is
  // a time that was not read (a missing field read as 0), never "open to everyone" (Claude 3 on #3653).
  if (!Number.isFinite(moduleAt) || (!input.module.fixed && moduleAt <= 0)) return null;
  if (!input.lesson) return moduleAt;
  return Number.isFinite(input.lesson.at) ? Math.max(moduleAt, input.lesson.at) : null;
}

/** Open from the instant on, for whoever comes then or later; unknown is never open. */
export function releaseState(at: number | null, now: number): "open" | "waits" | "unknown" {
  if (at === null || !Number.isFinite(at) || !Number.isFinite(now)) return "unknown";
  return now >= at ? "open" : "waits";
}

/** What a student reads before it opens, in the zone the creator set: "Opens Monday, January 11, 2027 at 9:00 AM EST". */
export function releaseWords(release: FixedRelease): string {
  const ms = release.at * 1000;
  const date = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: release.zone }).format(ms);
  const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZoneName: "short", timeZone: release.zone }).format(ms);
  return `Opens ${date} at ${time}`.replace(/[  ]/g, " ");
}

/** The same date in another zone: the instant never moves; the clock it reads there is kept with it. */
export function inZone(release: FixedRelease, zone: string): FixedRelease {
  const name = zoneName(zone);
  const wall = name ? wallIn(release.at, name) : null;
  return name && wall ? { at: release.at, zone: name, wall } : release;
}
