/**
 * A discount code with a start and an end set ahead (511 [CK3]): the rules,
 * shared by the studio's page and the server. Browser-safe: no Redis, no
 * Stripe here (lib/discount-schedule.ts does those).
 *
 * The code is made on the creator's own Stripe account switched off, with
 * Stripe's own expiry (`expires_at`) as its end, so the end needs nothing
 * from us. The five-minute job (app/api/cron/imports) switches it on at its
 * start. If that cannot be confirmed after ACTIVATION_TRIES tries, the code
 * stays off and the studio says so, in words, beside the code.
 *
 * What it costs: each try is one call to the creator's Stripe account (which
 * bills no API call) and a few database commands, inside one studio request;
 * SCHEDULE_UNITS of the store's studio requests are taken when the code is
 * scheduled, before anything is asked of Stripe, so every try is paid for
 * ahead and no try is ever made unpaid. No countdown, no scarcity: nothing
 * of the kind is added here.
 */

/** Scheduled codes a store keeps at one time, at the most: each is one small field of one hash. */
export const MAX_SCHEDULED_CODES = 10;
/** Times the job tries to switch a code on before it is shown as failed. */
export const ACTIVATION_TRIES = 3;
/** Seconds between tries: the next five-minute run. */
export const RETRY_SECONDS = 300;
/** Studio requests taken when a code is scheduled, one for each try the job may make. */
export const SCHEDULE_UNITS = ACTIVATION_TRIES;
/**
 * How long past its start a code may still read as starting: every try's
 * run and an hour more. Past it, a code the job has not switched on reads as
 * failed, whatever kept it from being tried, so the studio never shows
 * "Starting" for ever.
 */
export const STARTING_GRACE_SECONDS = ACTIVATION_TRIES * RETRY_SECONDS + 3600;
/** The earliest start, from now: a later run of the five-minute job, so there is something to schedule. */
export const MIN_LEAD_SECONDS = 600;
/** The latest start, from now: a year and a day. */
export const MAX_AHEAD_SECONDS = 366 * 86_400;
/** The longest a scheduled code may run, from its start: a year and a day, as Stripe's expiry holds it. */
export const MAX_LENGTH_SECONDS = 366 * 86_400;

export type ScheduleProblem = "start" | "end" | "full" | "busy";

export const SCHEDULE_PROBLEMS: Record<ScheduleProblem, string> = {
  start: "Pick a start at least 10 minutes from now and no more than a year ahead.",
  end: "Pick an end after the start, no more than a year after it.",
  full: `You have ${MAX_SCHEDULED_CODES} codes waiting to start, the most at one time. Cancel one, or wait until one starts.`,
  busy: "Your codes are being changed right now. Try again in a moment.",
};

/** A start and an end, in seconds since the epoch. */
export type ScheduleWindow = { start: number; end: number };

const whole = (raw: unknown): number | null => {
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  if (!/^\d{9,11}$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
};

/**
 * The window asked for, as whole seconds (the studio's page turns the
 * creator's own local date and time into them, in their own time zone), or
 * which of the two is wrong.
 */
export function readWindow(body: Record<string, unknown>, nowSeconds: number): ({ ok: true } & ScheduleWindow) | { ok: false; reason: "start" | "end" } {
  const start = whole(body.start);
  if (start === null || start < nowSeconds + MIN_LEAD_SECONDS || start > nowSeconds + MAX_AHEAD_SECONDS) return { ok: false, reason: "start" };
  const end = whole(body.end);
  if (end === null || end <= start || end > start + MAX_LENGTH_SECONDS) return { ok: false, reason: "end" };
  return { ok: true, start, end };
}

/** One scheduled code, as the studio is told about it. */
export type ScheduleEntry = { id: string; code: string; start: number; end: number; tries: number; failed: boolean };

export type ScheduleState = "scheduled" | "starting" | "failed" | "live" | "ended" | "off";

export const STATE_LABELS: Record<ScheduleState, string> = {
  scheduled: "Scheduled",
  starting: "Starting",
  failed: "Activation failed",
  live: "Live",
  ended: "Ended",
  off: "Switched off",
};

/**
 * What a code is now, from what Stripe says of it and its schedule, if any.
 * Stripe decides: a code Stripe has live is live, whatever a try thought.
 */
export function scheduleState(
  code: { active: boolean; expiresAt: number | null; timesRedeemed: number; maxRedemptions: number | null },
  schedule: Pick<ScheduleEntry, "start" | "end" | "failed"> | null,
  nowSeconds: number,
): ScheduleState {
  const past = code.expiresAt !== null && code.expiresAt <= nowSeconds;
  const usedUp = code.maxRedemptions !== null && code.timesRedeemed >= code.maxRedemptions;
  if (code.active) return past || usedUp ? "ended" : "live";
  if (schedule) {
    if (schedule.failed || nowSeconds >= schedule.start + STARTING_GRACE_SECONDS) return "failed";
    return nowSeconds < schedule.start ? "scheduled" : "starting";
  }
  return past || usedUp ? "ended" : "off";
}

const plain = (raw: unknown): raw is Record<string, unknown> => Boolean(raw && typeof raw === "object" && !Array.isArray(raw));
const seconds = (raw: unknown): raw is number => typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0;

/** The route's schedules, read in their exact shape, or null: an unreadable list is never an empty one. */
export function readScheduleConfirmation(raw: unknown): ScheduleEntry[] | null {
  if (!plain(raw) || !Object.hasOwn(raw, "schedules") || !Array.isArray(raw.schedules)) return null;
  const out: ScheduleEntry[] = [];
  const ids = new Set<string>();
  for (const row of raw.schedules) {
    if (!plain(row)) return null;
    const { id, code, start, end, tries, failed } = row;
    if (typeof id !== "string" || !id || ids.has(id) || typeof code !== "string" || !code) return null;
    if (!seconds(start) || !seconds(end) || end <= start) return null;
    if (typeof tries !== "number" || !Number.isSafeInteger(tries) || tries < 0 || typeof failed !== "boolean") return null;
    ids.add(id);
    out.push({ id, code, start, end, tries, failed });
  }
  return out;
}
