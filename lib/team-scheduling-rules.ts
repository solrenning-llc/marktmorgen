/**
 * Team event types: one call that can be booked with any of several people
 * on a store's team (round robin), or only at times all of them are free
 * (collective). The rules, with no network and no secret, so the studio can
 * draw exactly what the server enforces.
 *
 * A team event type is a call with weekly hours and one seat per time
 * (lib/call-setup.ts) plus a team: the people who host it, each with their
 * own week in their own time zone, their own gap between calls, their own
 * notice and a cap on how many of these calls they take in one of their days.
 * The call's own notice, horizon and gap still apply; a host's stricter one
 * wins for that host.
 *
 * A time is offered when, for round robin, at least one host is free for the
 * whole call, or, for a collective call, every host is. A host is free when:
 *
 *   - the call starts after both notices and within the horizon;
 *   - the whole call fits inside one of the host's stretches of that day, on
 *     their clock (daylight saving is asked of the time zone database at the
 *     exact instant, as everywhere else);
 *   - nothing the host is already taken for (a booking or a hold anywhere on
 *     Marktmorgen, or a busy time in their own calendar) comes within the gap;
 *   - fewer than their daily cap of team calls start on that day of theirs;
 *   - their calendar was read recently enough (`blocked` is false). A host
 *     whose calendar could not be read is never offered: a time is lost
 *     rather than booked over a meeting nobody could see. The other hosts'
 *     times stay on offer.
 *
 * Round robin hands the booking to the free host with the fewest bookings of
 * this event so far, then the fewest coming up, then by address, so the
 * order never depends on who asked first. The server claims that host's time
 * atomically (lib/host-claims.ts) and moves to the next free host when the
 * claim loses a race.
 */
import { PLAN_TITLES, type Tier } from "@/lib/plan";
import { type PlanFields, standingOf } from "@/lib/plan-standing";
import { BUFFERS, type Busy, type CallSetup, type Day, MAX_RANGES_PER_DAY, NOTICE_CHOICES, type Range, isTimeZone, zonedToUtc } from "@/lib/call-setup";

export type TeamMode = "round_robin" | "collective";

export const TEAM_MODES: readonly TeamMode[] = ["round_robin", "collective"];

export const TEAM_MODE_NAMES: Record<TeamMode, string> = {
  round_robin: "Round robin",
  collective: "Collective",
};

export const TEAM_MODE_SUMMARIES: Record<TeamMode, string> = {
  round_robin: "Buyers pick a time and get one host: whoever is free, sharing bookings out evenly.",
  collective: "Every host joins every call: only times when all of them are free are offered.",
};

/** Team calls one host may take in one of their days. */
export const DAILY_CAPS = [1, 2, 3, 4, 5, 6, 8, 10, 12] as const;

/** One person who hosts a team event type. */
export type TeamHost = {
  /** Their sign-in address: the store's owner or someone on its team (lib/team.ts). */
  email: string;
  /** Their own time zone, which their week is written in. */
  tz: string;
  /** Seven entries, Sunday first, each up to two stretches, minutes from midnight. */
  weekly: Range[][];
  /** Their own gap between calls; the larger of this and the call's applies. */
  bufferMinutes: number;
  /** Their own notice; the larger of this and the call's applies. */
  noticeHours: number;
  /** Team calls they take at most in one of their days. */
  dailyCap: number;
  /**
   * The name buyers see when they may choose who they book with (520 [LB1],
   * unit 6): the creator's own words, such as "Ana", never their address.
   * Shown only on a team that lets buyers choose (TeamSetup.pick).
   */
  label?: string;
};

export type TeamSetup = {
  mode: TeamMode;
  hosts: TeamHost[];
  /**
   * Round robin only: the buyer may choose who they book with, by each host's
   * label, or "Any available" (520 [LB1], unit 6). Every host has a label
   * then, each a different one.
   */
  pick?: boolean;
  /** When it became a team event, ISO: the oldest ones stay on when a plan allows fewer. */
  createdAt: string;
};

/** What each plan allows: team event types per store, and hosts on one. */
export type TeamLimits = { eventTypes: number; hosts: number };

/**
 * Numeric limits per plan. A store has at most six people (its owner and five
 * on the team, lib/team.ts), so six hosts is everybody. Each host's calendar
 * is read at most once every SYNC_SECONDS (lib/host-calendar.ts), only while
 * somebody is looking at a booking page, so these also bound the reading.
 */
export const TEAM_LIMITS: Record<Tier, TeamLimits> = {
  // One with two hosts until 18 October 2026, when Store's worst month had to
  // make room for the uses priced that day (tests/plan-cost-registry.ts):
  // reading two hosts' calendars all month was the least used of what Store
  // paid for. The price did not change.
  creator: { eventTypes: 0, hosts: 0 },
  pro: { eventTypes: 5, hosts: 4 },
  scale: { eventTypes: 10, hosts: 4 },
};

/** A store in its free trial: what the Store plan allows, none since 18 October 2026. */
export const TRIAL_TEAM_LIMITS: TeamLimits = TEAM_LIMITS.creator;

/** A store with no plan running: no team event types. */
export const SETUP_TEAM_LIMITS: TeamLimits = { eventTypes: 0, hosts: 0 };

export function teamLimitsFor(store: PlanFields & { tier?: Tier }, nowSeconds = Date.now() / 1000): TeamLimits {
  const standing = standingOf(store, nowSeconds);
  if (standing === "paid") return TEAM_LIMITS[store.tier ?? "creator"] ?? TEAM_LIMITS.creator;
  return standing === "trial" ? TRIAL_TEAM_LIMITS : SETUP_TEAM_LIMITS;
}

/** "1 team event type with up to 2 hosts", for the studio and the plan pages. */
export function teamLimitWords(limits: TeamLimits): string {
  if (limits.eventTypes === 0) return `no team event types (they come with ${PLAN_TITLES.pro} and ${PLAN_TITLES.scale})`;
  return `${limits.eventTypes} team event ${limits.eventTypes === 1 ? "type" : "types"}, each with up to ${limits.hosts} ${limits.hosts === 1 ? "host" : "hosts"}`;
}

export type TeamProblem =
  | "team_mode"
  | "team_hosts"
  | "team_host"
  | "team_host_tz"
  | "team_host_hours"
  | "team_host_buffer"
  | "team_host_notice"
  | "team_host_cap"
  | "team_host_label"
  | "team_pick"
  | "team_call";

const EMAIL = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}\.[^\s@<>".]{2,}$/;

function readWeek(raw: unknown, minutes: number): Range[][] | null {
  if (!Array.isArray(raw) || raw.length !== 7) return null;
  const weekly: Range[][] = [];
  let any = false;
  for (const day of raw) {
    if (!Array.isArray(day) || day.length > MAX_RANGES_PER_DAY) return null;
    const ranges: Range[] = [];
    for (const range of day) {
      if (!Array.isArray(range) || range.length !== 2) return null;
      const [start, end] = range.map(Number);
      if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
      if (start < 0 || end > 24 * 60 || start % 5 !== 0 || end % 5 !== 0) return null;
      if (end - start < minutes) return null;
      ranges.push([start, end]);
    }
    ranges.sort((a, b) => a[0] - b[0]);
    if (ranges.length === 2 && ranges[1][0] < ranges[0][1]) return null;
    if (ranges.length) any = true;
    weekly.push(ranges);
  }
  return any ? weekly : null;
}

/**
 * Reads a team sent from the studio or kept in storage, for a call with this
 * setup, or says which part is wrong. Whether each address is really on the
 * store's team, and how many hosts the plan allows, are the server's to check
 * (app/api/store/call-team).
 */
export function readTeamSetup(raw: unknown, setup: Pick<CallSetup, "kind" | "seats" | "minutes"> | null, maxHosts = 6): TeamSetup | TeamProblem {
  if (!setup || setup.kind !== "weekly" || setup.seats !== 1) return "team_call";
  if (!raw || typeof raw !== "object") return "team_mode";
  const value = raw as Record<string, unknown>;
  if (value.mode !== "round_robin" && value.mode !== "collective") return "team_mode";
  if (!Array.isArray(value.hosts) || value.hosts.length === 0 || value.hosts.length > Math.max(1, maxHosts)) return "team_hosts";
  const hosts: TeamHost[] = [];
  const seen = new Set<string>();
  for (const item of value.hosts) {
    if (!item || typeof item !== "object") return "team_host";
    const h = item as Record<string, unknown>;
    const email = typeof h.email === "string" ? h.email.trim().toLowerCase() : "";
    if (!EMAIL.test(email) || email.length > 254 || seen.has(email)) return "team_host";
    seen.add(email);
    if (!isTimeZone(h.tz)) return "team_host_tz";
    const weekly = readWeek(h.weekly, setup.minutes);
    if (!weekly) return "team_host_hours";
    const bufferMinutes = Number(h.bufferMinutes ?? 0);
    if (!(BUFFERS as readonly number[]).includes(bufferMinutes)) return "team_host_buffer";
    const noticeHours = Number(h.noticeHours ?? 1);
    if (!(NOTICE_CHOICES as readonly number[]).includes(noticeHours)) return "team_host_notice";
    const dailyCap = Number(h.dailyCap ?? 4);
    if (!(DAILY_CAPS as readonly number[]).includes(dailyCap)) return "team_host_cap";
    // The name buyers see: absent or empty is none; anything else must be a plain short name.
    const rawLabel = h.label === undefined || h.label === null ? "" : h.label;
    if (typeof rawLabel !== "string") return "team_host_label";
    const label = rawLabel.normalize("NFKC").trim().replace(/\s+/g, " ");
    if (label && !isHostLabel(label)) return "team_host_label";
    hosts.push({ email, tz: h.tz as string, weekly, bufferMinutes, noticeHours, dailyCap, ...(label ? { label } : {}) });
  }
  const createdAt = typeof value.createdAt === "string" && !Number.isNaN(Date.parse(value.createdAt)) ? value.createdAt : new Date().toISOString();
  // Letting buyers choose: round robin only, every host named, each name once.
  const pick = value.pick === true;
  if (pick) {
    const names = hosts.map((h) => (h.label ?? "").normalize("NFKC").toLowerCase());
    if (value.mode !== "round_robin" || names.some((n) => !n) || new Set(names).size !== names.length) return "team_pick";
  }
  return { mode: value.mode, hosts, createdAt, ...(pick ? { pick: true } : {}) };
}

/** Longest name a buyer is shown for a host. */
export const HOST_LABEL_MAX = 40;

/**
 * A host's public name: a plain short name, never an address, a link or
 * markup, so a buyer is shown only what the creator meant them to see.
 */
export function isHostLabel(label: string): boolean {
  const name = label.normalize("NFKC");
  return (
    name.length >= 1 &&
    name.length <= HOST_LABEL_MAX &&
    // No address, link, website or markup: an at sign in any form, a slash, brackets, a scheme, www., or a dot right before a word ("ana.dev").
    !/[@＠﹫<>{}\[\]\\/]|https?:|www\.|\.\p{L}{2,}/iu.test(name) &&
    // No phone number (six digits or more), and no address spelled out ("ana at gmail dot com").
    !/(\d[\s\-().]*){6,}/.test(name) &&
    !/\b(at|arroba)\b.*\b(dot|ponto)\b/i.test(name) &&
    // Nothing invisible or reordering (format and control characters), so two names never look alike.
    !/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(name)
  );
}

/** What a buyer may choose on a team that lets them: each host's position and name, in the team's order. */
export function hostChoices(team: TeamSetup): { key: string; label: string }[] {
  if (!team.pick || team.mode !== "round_robin") return [];
  return team.hosts.map((h, i) => ({ key: String(i), label: h.label ?? "" })).filter((c) => c.label);
}

/**
 * The team narrowed to the host a buyer chose: null for "Any available" (no
 * choice, or a team that does not let buyers choose), "changed" when that
 * position no longer has that name (the team was edited since the page was
 * drawn), so a buyer is never booked with someone they did not pick.
 */
export function chosenTeam(team: TeamSetup, key: string, label: string): TeamSetup | null | "changed" {
  if (!key) return null;
  const choices = hostChoices(team);
  if (!choices.length) return "changed";
  const index = /^[0-5]$/.test(key) ? Number(key) : -1;
  const host = team.hosts[index];
  if (!host || !host.label || host.label !== label) return "changed";
  return { ...team, hosts: [host] };
}

/** Whatever came back from storage, made safe to use, or null. */
export function parseTeamSetup(raw: unknown, setup: Pick<CallSetup, "kind" | "seats" | "minutes"> | null): TeamSetup | null {
  const read = readTeamSetup(raw, setup);
  return typeof read === "string" ? null : read;
}

// ---- Time, with the time zone database asked once per zone -------------------

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
    });
    formatters.set(tz, f);
  }
  return f;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The date and weekday a clock in `tz` shows at instant `ms`. */
export function localDay(ms: number, tz: string): { year: number; month: number; day: number; weekday: number } {
  const parts = formatterFor(tz).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return { year: Number(get("year")), month: Number(get("month")), day: Number(get("day")), weekday: WEEKDAYS.indexOf(get("weekday")) };
}

/** The first instant of a calendar day in `tz`. A zone whose midnight is skipped starts the day at the first minute that exists. */
function startOfDay(year: number, month: number, day: number, tz: string): number {
  for (const minute of [0, 30, 60, 90, 120]) {
    const at = zonedToUtc(year, month, day, minute, tz);
    if (at !== null) return at;
  }
  return Date.UTC(year, month - 1, day);
}

/** The day, on a host's own clock, that an instant falls in: [first instant, first instant of the next day). */
export function dayBounds(ms: number, tz: string): [number, number] {
  const p = localDay(ms, tz);
  const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  return [startOfDay(p.year, p.month, p.day, tz), startOfDay(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), tz)];
}

/** Whether [start, end) fits inside one of the host's stretches on that day of theirs. */
export function inHostHours(host: Pick<TeamHost, "tz" | "weekly">, start: number, end: number): boolean {
  const p = localDay(start, host.tz);
  for (const [from, to] of host.weekly[p.weekday] ?? []) {
    const a = zonedToUtc(p.year, p.month, p.day, from, host.tz);
    const b = zonedToUtc(p.year, p.month, p.day, to, host.tz);
    if (a === null || b === null) continue;
    if (start >= a && end <= b) return true;
  }
  return false;
}

/** What is known about one host right now. */
export type HostState = {
  email: string;
  /** Everything the host is taken for: bookings and holds anywhere, and their own calendar's busy times. */
  busy: Busy[];
  /** Starts of the team calls they already have, each once, for the daily cap. */
  booked: number[];
  /** Their calendar could not be read recently enough: none of their times are offered. */
  blocked: boolean;
};

/** The notice, gap and day of one host for one call. */
export function hostRules(setup: Pick<CallSetup, "noticeHours" | "bufferMinutes">, host: TeamHost): { noticeMs: number; gapMs: number } {
  return {
    noticeMs: Math.max(setup.noticeHours, host.noticeHours) * 3600_000,
    gapMs: Math.max(setup.bufferMinutes, host.bufferMinutes) * 60_000,
  };
}

/** Whether this host can take a call starting at `start`, by every rule above. */
export function hostFree(setup: CallSetup, host: TeamHost, state: HostState | undefined, now: number, start: number): boolean {
  if (!state || state.blocked) return false;
  const length = setup.minutes * 60_000;
  const end = start + length;
  const { noticeMs, gapMs } = hostRules(setup, host);
  if (start < now + noticeMs) return false;
  if (start > now + setup.horizonDays * 86_400_000) return false;
  if (!inHostHours(host, start, end)) return false;
  if (state.busy.some((b) => start < b.end + gapMs && end + gapMs > b.start)) return false;
  const [d0, d1] = dayBounds(start, host.tz);
  const today = state.booked.filter((s) => s >= d0 && s < d1).length;
  return today < host.dailyCap;
}

/** Every start any host's week offers, within the horizon, soonest first. */
function candidateStarts(setup: CallSetup, team: TeamSetup, now: number): number[] {
  const out = new Set<number>();
  const latest = now + setup.horizonDays * 86_400_000;
  const step = setup.minutes + setup.bufferMinutes;
  for (const host of team.hosts) {
    const first = localDay(now, host.tz);
    for (let offset = 0; offset <= setup.horizonDays + 1; offset += 1) {
      const cursor = new Date(Date.UTC(first.year, first.month - 1, first.day + offset));
      const y = cursor.getUTCFullYear();
      const m = cursor.getUTCMonth() + 1;
      const d = cursor.getUTCDate();
      for (const [from, to] of host.weekly[cursor.getUTCDay()] ?? []) {
        for (let t = from; t + setup.minutes <= to; t += step) {
          const start = zonedToUtc(y, m, d, t, host.tz);
          if (start === null || start < now || start > latest) continue;
          out.add(start);
        }
      }
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** The hosts free at one start, in the team's order. */
export function freeHosts(setup: CallSetup, team: TeamSetup, states: Map<string, HostState>, now: number, start: number): string[] {
  return team.hosts.filter((h) => hostFree(setup, h, states.get(h.email), now, start)).map((h) => h.email);
}

/** Whether a booking may take this start: one free host for round robin, every host for a collective call. */
export function teamBookable(setup: CallSetup, team: TeamSetup, states: Map<string, HostState>, now: number, start: number): boolean {
  const free = freeHosts(setup, team, states, now, start);
  return team.mode === "collective" ? free.length === team.hosts.length && free.length > 0 : free.length > 0;
}

/**
 * Every time a buyer may book, grouped by the call's own day (its time zone,
 * as for every call), so the booking page shows them like any other call.
 */
export function teamSlots(setup: CallSetup, team: TeamSetup, states: Map<string, HostState>, now: number): Day[] {
  const days: Day[] = [];
  let current: Day | null = null;
  for (const start of candidateStarts(setup, team, now)) {
    if (!teamBookable(setup, team, states, now, start)) continue;
    const p = localDay(start, setup.tz);
    const date = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
    if (!current || current.date !== date) {
      current = { date, starts: [] };
      days.push(current);
    }
    current.starts.push(start);
  }
  return days;
}

/**
 * The order round robin tries the free hosts in: fewest bookings of this
 * event so far, then fewest team calls coming up, then by address.
 */
export function roundRobinOrder(free: string[], assigned: Record<string, number>, upcoming: Record<string, number>): string[] {
  return [...free].sort((a, b) => (assigned[a] ?? 0) - (assigned[b] ?? 0) || (upcoming[a] ?? 0) - (upcoming[b] ?? 0) || (a < b ? -1 : a > b ? 1 : 0));
}

/** The default week for a new host: the call's own, in the call's time zone. */
export function hostFromCall(email: string, setup: CallSetup): TeamHost {
  return {
    email,
    tz: setup.tz,
    weekly: setup.weekly.map((day) => day.map((r) => [r[0], r[1]] as Range)),
    bufferMinutes: 0,
    noticeHours: 1,
    dailyCap: 4,
  };
}
