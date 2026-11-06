/**
 * Discount codes through the API (630 [HN6](19), unit 2): read, made and
 * switched off on the creator's own Stripe account, exactly as the studio's
 * discount codes are (lib/discount.ts, app/api/store/discount). A code is
 * never deleted from Stripe, which keeps its redemptions; switching it off
 * is what "remove" means, here as in the studio. Each code goes out field by
 * field (lib/api-read.ts's rule), every time in ISO 8601.
 */
import { CODE_PROBLEMS, type DiscountCode, amountProblem, minimumProblem } from "@/lib/discount";
import type { CodeAskedRefusal } from "@/lib/discount-input";
import {
  MAX_AHEAD_SECONDS,
  MAX_LENGTH_SECONDS,
  MIN_LEAD_SECONDS,
  type ScheduleEntry,
  type ScheduleState,
  type ScheduleWindow,
  readWindow,
  scheduleState,
} from "@/lib/discount-schedule-rules";
import type { Currency } from "@/lib/money";

/** Every field a code goes out with (codeOut), so a field asked for can be checked before anything is read. */
export const CODE_FIELDS = ["id", "code", "off", "times_redeemed", "max_redemptions", "expires_at", "active", "minimum", "first_order", "duration", "other_rules", "state", "starts_at"] as const;

/**
 * Where a code stands, as the studio says it (511 [CK3], lib/discount-schedule-rules.ts): "scheduled" (waiting for
 * its start), "starting" (its start has come and the job is switching it on), "failed" (it could not be switched
 * on and stays off), "live", "ended" or "off". Stripe decides: a code Stripe has live is live.
 */
export type CodeState = ScheduleState;

/**
 * One code as the API gives it out, with where it stands; a code waiting for its start carries its schedule
 * (`starts_at`), every other code null there. Its end is Stripe's own expiry (`expires_at`).
 */
export function codeOut(code: DiscountCode, schedule: ScheduleEntry | null = null, nowSeconds = Math.floor(Date.now() / 1000)): Record<string, unknown> {
  const waiting = schedule && !code.active ? schedule : null;
  return {
    id: code.id,
    code: code.code,
    off: code.off === null ? null : code.off.kind === "percent" ? { kind: "percent", percent: code.off.percent } : { kind: "amount", amount_cents: code.off.cents, currency: code.off.currency },
    times_redeemed: code.timesRedeemed,
    max_redemptions: code.maxRedemptions,
    expires_at: code.expiresAt ? new Date(code.expiresAt * 1000).toISOString() : null,
    active: code.active,
    minimum: code.minimum ? { amount_cents: code.minimum.cents, currency: code.minimum.currency } : null,
    first_order: code.firstOrder,
    duration: code.duration === null ? null : code.duration.kind === "repeating" ? { kind: "repeating", months: code.duration.months } : { kind: code.duration.kind },
    other_rules: code.otherRules,
    state: scheduleState(code, waiting, nowSeconds),
    starts_at: waiting ? new Date(waiting.start * 1000).toISOString() : null,
  };
}

/** Every code as the API gives it out, each beside its schedule, if it has one. */
export function codesOut(codes: readonly DiscountCode[], schedules: readonly ScheduleEntry[], nowSeconds = Math.floor(Date.now() / 1000)): Record<string, unknown>[] {
  const byId = new Map(schedules.map((entry) => [entry.id, entry]));
  return codes.map((code) => codeOut(code, byId.get(code.id) ?? null, nowSeconds));
}

/**
 * An ISO 8601 moment with its date, its time to the minute at least and its offset (Z or ±hh:mm), read as whole
 * seconds since the epoch; anything else (no offset, words, a number, a day that does not exist) is null, never
 * guessed. A local time with no offset could be read in either of two time zones, so it is refused.
 */
const ISO_MOMENT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
export function readMoment(raw: unknown): number | null {
  if (typeof raw !== "string" || raw.length > 40) return null;
  const parts = ISO_MOMENT.exec(raw);
  if (!parts) return null;
  const [, y, mo, d, h, mi, se] = parts;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  // The date as written must be a real one: Date.parse rolls 30 February over to March in some engines.
  const day = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (day.getUTCFullYear() !== Number(y) || day.getUTCMonth() !== Number(mo) - 1 || day.getUTCDate() !== Number(d)) return null;
  if (Number(h) > 23 || Number(mi) > 59 || (se !== undefined && Number(se) > 59)) return null;
  return Math.floor(ms / 1000);
}

/** The words for a start or an end the API cannot take. */
export const SCHEDULE_WORDS = {
  starts_at: `starts_at must be an ISO 8601 time with its offset (for example 2026-12-24T09:00:00-05:00), at least ${MIN_LEAD_SECONDS / 60} minutes from now and no more than ${Math.floor(MAX_AHEAD_SECONDS / 86_400)} days ahead.`,
  ends_at: `ends_at must be an ISO 8601 time with its offset, sent with starts_at, after it and no more than ${Math.floor(MAX_LENGTH_SECONDS / 86_400)} days after it.`,
} as const;

/**
 * The start and the end asked for (511 [CK3]): none when neither is sent (a code live at once, as before), else
 * both read with the studio's own rules (readWindow), or which of the two is wrong. An end with no start is a
 * start missing.
 */
export function readScheduleAsked(
  body: Record<string, unknown>,
  nowSeconds: number,
): { ok: true; window: ScheduleWindow | null } | { ok: false; error: keyof typeof SCHEDULE_WORDS; message: string } {
  const hasStart = Object.hasOwn(body, "starts_at") && body.starts_at !== null;
  const hasEnd = Object.hasOwn(body, "ends_at") && body.ends_at !== null;
  if (!hasStart && !hasEnd) return { ok: true, window: null };
  const refuse = (error: keyof typeof SCHEDULE_WORDS) => ({ ok: false as const, error, message: SCHEDULE_WORDS[error] });
  const start = readMoment(body.starts_at);
  if (start === null) return refuse("starts_at");
  const end = readMoment(body.ends_at);
  const read = readWindow({ start: String(start), end: end === null ? "" : String(end) }, nowSeconds);
  if (!read.ok) return refuse(read.reason === "start" ? "starts_at" : "ends_at");
  return { ok: true, window: { start: read.start, end: read.end } };
}

/** What is wrong with a code asked for, in the words the studio uses, in the store's currency. */
export function refusalWords(refusal: CodeAskedRefusal, currency: Currency): string {
  if (refusal.reason === "amount") return amountProblem(currency);
  if (refusal.reason === "minimum") return minimumProblem(currency);
  return CODE_PROBLEMS[refusal.reason];
}
