/**
 * Benefits a creator hands over by hand on a membership (422 [PT2], unit 1):
 * "a signed print" once, "a call with me" every month. The rules here are
 * plain and run anywhere; lib/tier-benefits.ts keeps the benefits, reads the
 * members from the creator's own Stripe account and keeps the marks.
 *
 * Measured before it was built (Patreon's help center, article 360004710212,
 * read 25 October 2026 by Claude, to be read again before any comparison is
 * published): benefits per tier, delivered once or every month, with a list
 * of who is still owed each one, marked one by one or in bulk.
 *
 * When a benefit is owed, read from the membership as Stripe holds it now:
 *
 *   - Only on the membership it was set on (the product the subscription is
 *     on today, lib/tier-rules.ts productOfSub), and never before it existed.
 *   - Never in a free trial: nothing has been paid for yet.
 *   - "once": owed to a member whose membership has been paid for: running,
 *     or with a renewal Stripe is retrying when it never had a free trial
 *     (its first payment was taken when it began). After a free trial a
 *     failed charge may be the first one, and nothing is known to be paid:
 *     not owed until the membership is running again. A pause does not take
 *     it away. No date is promised, so none is shown.
 *   - "monthly": owed for the month running now, counted in calendar months
 *     from the membership's billing anchor, only while the membership is
 *     paid up (active) and not paused. It belongs to that month: the month's
 *     end is shown as "until", which is the creator's own promise of "every
 *     month", not a deadline Marktmorgen made up.
 *   - A retired benefit is still owed for what was owed before it was
 *     retired: once, to whoever joined before; monthly, for a month that
 *     began before. A change never rewrites a promise already made.
 *
 * Marking "given" is the creator's own record of what they did by hand. It
 * is not proof that anything was sent or received, and nothing here sends,
 * charges, orders or ships anything.
 */
import { addMonths } from "@/lib/membership-pause-rules";

/** Running benefits on one membership. */
export const MAX_BENEFITS_PER_TIER = 5;
/** Benefits a store keeps in all, retired ones included (they stay owed for what came before). */
export const MAX_BENEFITS_KEPT = 40;
/** Characters in a benefit's words. */
export const MAX_BENEFIT_TEXT = 120;
/** Marks one press may make. */
export const MAX_GIVE_AT_ONCE = 200;

export const CADENCES = ["once", "monthly"] as const;
export type Cadence = (typeof CADENCES)[number];
export const CADENCE_NAMES: Record<Cadence, string> = { once: "Once", monthly: "Every month" };

export const BENEFIT_ID = /^b[0-9a-f]{12}$/;
/** "once", or "m" and the second the month began. */
export const PERIOD = /^(once|m\d{9,11})$/;
const PRODUCT_ID = /^[A-Za-z0-9_-]{1,40}$/;

export type Benefit = {
  id: string;
  /** The membership (product id) it is on. */
  product: string;
  text: string;
  cadence: Cadence;
  /** When it was added, in seconds. */
  since: number;
  /** When it was retired, in seconds; 0 while it runs. */
  retired: number;
};

/** A benefit's words: trimmed, spaces run together, 1 to MAX_BENEFIT_TEXT characters, no control characters; null otherwise. */
export function benefitText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (/[\u0000-\u001f\u007f]/.test(raw.replace(/[\t\n\r]/g, " "))) return null;
  const text = raw.replace(/\s+/g, " ").trim();
  return text.length >= 1 && text.length <= MAX_BENEFIT_TEXT ? text : null;
}

export function isCadence(raw: unknown): raw is Cadence {
  return typeof raw === "string" && (CADENCES as readonly string[]).includes(raw);
}

const whole = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** One kept benefit, read in its exact shape; null when it is not one (the caller says the whole list is unknown). */
export function parseBenefit(id: string, raw: unknown): Benefit | null {
  if (!BENEFIT_ID.test(id) || typeof raw !== "string") return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const text = benefitText(v.text);
  if (typeof v.product !== "string" || !PRODUCT_ID.test(v.product) || text === null || text !== v.text || !isCadence(v.cadence)) return null;
  if (!whole(v.since) || !whole(v.retired)) return null;
  return { id, product: v.product, text, cadence: v.cadence, since: v.since, retired: v.retired };
}

export function benefitJson(b: Benefit): string {
  return JSON.stringify({ product: b.product, text: b.text, cadence: b.cadence, since: b.since, retired: b.retired });
}

/** The month running now, counted from the anchor; null before the anchor. */
export function monthWindow(anchor: number, now: number): { from: number; until: number } | null {
  if (!whole(anchor) || anchor <= 0 || now < anchor) return null;
  const start = new Date(anchor * 1000);
  const at = new Date(now * 1000);
  let k = (at.getUTCFullYear() - start.getUTCFullYear()) * 12 + (at.getUTCMonth() - start.getUTCMonth());
  // At most two steps either way: the count of calendar months can be one off at a month's edge.
  for (let step = 0; step < 3 && k > 0 && addMonths(anchor, k) > now; step += 1) k -= 1;
  for (let step = 0; step < 3 && addMonths(anchor, k + 1) <= now; step += 1) k += 1;
  return { from: addMonths(anchor, k), until: addMonths(anchor, k + 1) };
}

/** A running membership as the rules need it. */
export type MemberLike = {
  sub: string;
  /** Stripe's status. */
  status: string;
  /** The product it is on now. */
  product: string;
  /** Its billing anchor (the end of a free trial, or its start), in seconds. */
  anchor: number;
  /** When it started, in seconds. */
  start: number;
  /** When its free trial ended (Stripe's trial_end), in seconds; 0 when it never had one. */
  trialEnd: number;
  /** Inside a pause the member chose (lib/membership-pause-rules.ts pausedNow). */
  paused: boolean;
};

export type NotOwed = "none" | "before" | "retired" | "trial" | "unpaid" | "paused";
export type Owed = { owed: true; period: string; from: number; until: number | null } | { owed: false; why: NotOwed };

/** A renewal being retried: paid for once only when there was no free trial (see owedNow). */
const RETRIED = new Set(["past_due", "unpaid"]);

/** Whether this member is owed this benefit right now, and for which period. */
export function owedNow(benefit: Benefit, member: MemberLike, now: number): Owed {
  if (member.product !== benefit.product) return { owed: false, why: "none" };
  if (benefit.since > now) return { owed: false, why: "before" };
  if (benefit.cadence === "once") {
    if (benefit.retired && member.start >= benefit.retired) return { owed: false, why: "retired" };
    if (member.status === "trialing") return { owed: false, why: "trial" };
    // After a free trial the failed charge may be the first: nothing is known to be paid until it runs again.
    if (member.status !== "active" && !(RETRIED.has(member.status) && !member.trialEnd)) return { owed: false, why: "unpaid" };
    return { owed: true, period: "once", from: member.start, until: null };
  }
  const window = monthWindow(member.anchor, now);
  // Retired before this month began (or before any month did): never owed again, so not counted as waiting either.
  if (benefit.retired && (!window || window.from >= benefit.retired)) return { owed: false, why: "retired" };
  if (member.status === "trialing") return { owed: false, why: "trial" };
  if (!window || benefit.since >= window.until) return { owed: false, why: "before" };
  if (member.status !== "active") return { owed: false, why: "unpaid" };
  if (member.paused) return { owed: false, why: "paused" };
  return { owed: true, period: `m${window.from}`, from: window.from, until: window.until };
}
