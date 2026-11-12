/**
 * "Deliver at 9 a.m. in each reader's time zone", the rules only (367 [EZ4],
 * unit 1; added 12 November 2026). Pure and browser-safe; keeping a reader's
 * time zone at sign-up, the option in the scheduler and the sending in groups
 * are later units, and none of it is on yet.
 *
 *   - The creator picks a day; each reader gets the email at 9:00 on that day
 *     where they are. A reader's time zone is only one they gave (an IANA name
 *     the browser reported at sign-up), never guessed from an address; one
 *     that is missing or not a real zone uses the creator's own time zone
 *     (picked when scheduling), and the plan says how many readers that is.
 *   - Readers whose 9:00 is the same moment are one group, so the sending is
 *     a few scheduled groups (at most MAX_GROUPS for any day), never one job
 *     per contact.
 *   - The whole day must still be ahead: the first group (the zone where 9:00
 *     comes first) must be at least MIN_LEAD_MS away when the creator
 *     confirms, else the plan is refused with the first day that works. A
 *     day past the scheduler's own window (lib/mail-schedule.ts) is refused.
 *   - Times are exact across daylight-saving changes, read with the same
 *     helper the booking calendar uses (zonedToUtc in lib/call-setup.ts).
 *
 * It promises a time, not an arrival: the studio says the groups go out at
 * these times, and a mail queue may take a little longer.
 */
import { isTimeZone, zonedToUtc } from "@/lib/call-setup";
import { MAIL_SCHEDULE_WINDOW_MS } from "@/lib/mail-schedule";

export const DELIVERY_HOUR = 9;
/** The least time between confirming and the first group going out. */
export const MIN_LEAD_MS = 15 * 60_000;
/** More distinct 9:00s than the world has on one day (about 40): a bound, never reached by real zones. */
export const MAX_GROUPS = 48;

/** A reader's time zone as kept, or null when there is none or it is not a real zone. */
export function readerZone(raw: unknown): string | null {
  // Any name the time zone data knows, aliases included: a browser may report "Asia/Kolkata" where this
  // runtime's data says "Asia/Calcutta", and both are the same 9:00.
  return isTimeZone(raw) ? raw : null;
}

export type DeliveryGroup = { at: number; zones: string[]; readers: number };

export type DeliveryPlan =
  | { ok: true; day: string; groups: DeliveryGroup[]; readers: number; storeZoneReaders: number; first: number; last: number }
  | { ok: false; reason: "day" | "store-zone" | "past" | "far"; firstDay?: string };

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

function readDay(day: string): { y: number; m: number; d: number } | null {
  const match = DAY.exec(day);
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? { y, m, d } : null;
}

const nextDay = (day: string) => {
  const parsed = readDay(day)!;
  return new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d + 1)).toISOString().slice(0, 10);
};

function groupsFor(day: { y: number; m: number; d: number }, storeZone: string, zones: readonly (string | null)[], hour: number) {
  const byTime = new Map<number, { zones: Set<string>; readers: number }>();
  let storeZoneReaders = 0;
  const atStore = zonedToUtc(day.y, day.m, day.d, hour * 60, storeZone);
  for (const raw of zones) {
    const zone = readerZone(raw);
    let at = zone ? zonedToUtc(day.y, day.m, day.d, hour * 60, zone) : null;
    let used = zone;
    if (at === null) {
      at = atStore;
      used = storeZone;
      storeZoneReaders += 1;
    }
    if (at === null || used === null) continue;
    const group = byTime.get(at) ?? { zones: new Set<string>(), readers: 0 };
    group.zones.add(used);
    group.readers += 1;
    byTime.set(at, group);
  }
  const groups = [...byTime].sort((a, b) => a[0] - b[0]).map(([at, g]) => ({ at, zones: [...g.zones].sort(), readers: g.readers }));
  return { groups, storeZoneReaders };
}

/**
 * The groups for a day: `zones` is each reader's kept time zone (null when
 * none). Refused, with the first day that works when there is one in the
 * next week, when any group would already be due.
 */
export function deliveryPlan(input: { day: string; storeZone: string; zones: readonly (string | null)[]; now: number; hour?: number }): DeliveryPlan {
  const hour = input.hour ?? DELIVERY_HOUR;
  const day = readDay(input.day);
  if (!day) return { ok: false, reason: "day" };
  if (!readerZone(input.storeZone)) return { ok: false, reason: "store-zone" };
  const { groups, storeZoneReaders } = groupsFor(day, input.storeZone, input.zones, hour);
  // With no reader, the day is judged at the store's own 9:00.
  const first = groups[0]?.at ?? zonedToUtc(day.y, day.m, day.d, hour * 60, input.storeZone) ?? 0;
  const last = groups[groups.length - 1]?.at ?? first;
  if (last > input.now + MAIL_SCHEDULE_WINDOW_MS) return { ok: false, reason: "far" };
  if (first < input.now + MIN_LEAD_MS) {
    let next = input.day;
    for (let i = 0; i < 7; i += 1) {
      next = nextDay(next);
      const plan = deliveryPlan({ ...input, day: next });
      if (plan.ok) return { ok: false, reason: "past", firstDay: next };
    }
    return { ok: false, reason: "past" };
  }
  return { ok: true, day: input.day, groups, readers: input.zones.length, storeZoneReaders, first, last };
}

/** What the scheduler says before the creator confirms, in the creator's time zone. */
export function planWords(plan: Extract<DeliveryPlan, { ok: true }>, storeZone: string): string {
  const when = (at: number) => new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: storeZone, timeZoneName: "short" }).format(new Date(at));
  const count = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
  const spread = plan.groups.length <= 1 ? `It goes out at ${when(plan.first)}.` : `It goes out in ${count(plan.groups.length, "group", "groups")}, from ${when(plan.first)} to ${when(plan.last)}, your time.`;
  const fallback = plan.storeZoneReaders ? ` ${count(plan.storeZoneReaders, "reader has", "readers have")} no time zone we know, so they get it at 9:00 AM your time.` : "";
  return `${spread}${fallback}`;
}

/** What the scheduler says for each refusal. */
export const PLAN_PROBLEMS: Record<Extract<DeliveryPlan, { ok: false }>["reason"], string> = {
  day: "Pick a day from the calendar.",
  "store-zone": "Pick your time zone first: readers whose time zone we do not know get the email at 9:00 AM yours.",
  past: "9:00 AM on that day has already started somewhere in the world. Pick a later day.",
  far: "Pick a day within a year from today.",
};
