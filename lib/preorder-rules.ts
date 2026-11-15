/**
 * Pre-orders, as rules the browser can read too (added 10 October 2026). The
 * part that keeps and hands them over is lib/preorders.ts.
 *
 * Gumroad and Payhip take pre-orders. A creator who can sell what they are
 * still making learns whether it is wanted, and is paid while they make it.
 *
 * How it works here:
 *
 *   - A paid product marked "coming soon" (lib/waitlist-rules.ts) may also
 *     take pre-orders, with the day it is expected. The creator agrees, once,
 *     to refund every pre-order in full if it does not come out.
 *   - The buyer pays the price at once, and is told the expected day and that
 *     it is handed over the day it comes out. Nothing is added at checkout
 *     and no offer follows; it cannot be a gift or bought for several people.
 *   - The checkout hands over nothing by itself (lib/bundle-rules.ts,
 *     deliveredIds). When the creator puts the product on sale, every pre-order
 *     still paid is handed over the way a gift is — written down under the
 *     buyer's address (lib/imported-purchases.ts) — and its buyer is emailed
 *     the way to open it. A product cannot be put on sale with nothing in it
 *     while pre-orders wait for it.
 *   - Pre-orders stop by themselves after the expected day. A late product is
 *     not sold to anyone else until the creator sets a new day.
 */

/** A day, as the studio's date field and the record keep it. */
export const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** The furthest ahead a product can be expected. */
export const MAX_PREORDER_DAYS = 365;

/** Today's date in UTC, as a day. */
export function todayOf(nowMs = Date.now()): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** The day `days` after `day`. */
export function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The expected day a creator typed, made safe: a real day, from tomorrow to
 * MAX_PREORDER_DAYS ahead; null otherwise.
 */
export function readExpectedDay(raw: unknown, nowMs = Date.now()): string | null {
  if (typeof raw !== "string" || !DAY_PATTERN.test(raw)) return null;
  const parsed = Date.parse(`${raw}T00:00:00Z`);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== raw) return null;
  const today = todayOf(nowMs);
  return raw > today && raw <= addDays(today, MAX_PREORDER_DAYS) ? raw : null;
}

/** A day kept on the record, read back: any real day, or null. */
export function keptDay(raw: unknown): string | null {
  if (typeof raw !== "string" || !DAY_PATTERN.test(raw)) return null;
  const parsed = Date.parse(`${raw}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === raw ? raw : null;
}

/** Whether pre-orders are taken today: there is an expected day, and it has not passed. */
export function preorderOpen(day: string | null, nowMs = Date.now()): boolean {
  return day !== null && todayOf(nowMs) <= day;
}

/** What a product needs to be for a pre-order: the parts of it this file can hand over later. */
export type PreorderShape = {
  priceCents: number;
  recurring: unknown;
  call: unknown;
  bundle: unknown;
  podcast?: unknown;
  callPackage?: unknown;
  options: unknown[];
  stock: number | null;
  keys: unknown;
  pwyw: unknown;
  plan?: unknown;
};

export type PreorderProblem = "free" | "membership" | "call" | "bundle" | "podcast" | "options" | "stock" | "keys" | "pwyw";

/**
 * Why a product cannot take pre-orders, or null when it can. A pre-order is
 * one price, paid once, for a file, a link or a course: what is handed over
 * later exactly as a gift is.
 */
export function preorderProblem(product: PreorderShape): PreorderProblem | null {
  if (product.priceCents <= 0) return "free";
  if (product.recurring) return "membership";
  if (product.call || product.callPackage) return "call";
  if (product.bundle) return "bundle";
  if (product.podcast) return "podcast";
  if (product.options.length > 0) return "options";
  if (product.stock !== null) return "stock";
  if (product.keys) return "keys";
  if (product.pwyw) return "pwyw";
  return null;
}

/**
 * Whether a product has what a pre-order hands over: its file or link, or a
 * course with a lesson in it. Pure.
 */
export function hasContent(product: { file: unknown; link: unknown; course: { lessons: number } | null }): boolean {
  return product.course ? product.course.lessons > 0 : Boolean(product.file || product.link);
}

/** Said in the studio, for each reason a product cannot take pre-orders. */
export const PREORDER_PROBLEMS: Record<PreorderProblem, string> = {
  free: "Something free is not pre-ordered: use its waitlist.",
  membership: "A membership cannot be pre-ordered.",
  call: "A call is booked for a time, not pre-ordered.",
  bundle: "A bundle cannot be pre-ordered. Pre-order the product that is coming instead.",
  podcast: "A private podcast cannot be pre-ordered.",
  options: "A product with several prices cannot be pre-ordered yet: give it one price first.",
  stock: "A product with a limited number cannot be pre-ordered.",
  keys: "A product that hands out license keys cannot be pre-ordered.",
  pwyw: "A product whose buyers choose the price cannot be pre-ordered.",
};

/** One pre-order, as it is kept: who paid, and what became of it. */
export type Preorder = {
  /** The buyer's address, as Stripe has it. */
  to: string;
  /** When it was paid, in seconds. */
  at: number;
  /** The payment, for a refund to find it. */
  pi: string;
  /**
   * Whether the creator ships it (the checkout's metadata ship=yes), kept so the buyer's list still says so once it is
   * handed over (lib/buyer-orders.ts): its withdrawal period runs from a receipt not known here. Absent on an entry
   * written before it was kept, which is read as not known.
   */
  ship?: boolean;
  /** Once handed over, in seconds. */
  given?: number;
  /** Once refunded before or after it was handed over, in seconds. */
  revoked?: number;
};

export function parsePreorder(raw: unknown): Preorder | null {
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (typeof v.to !== "string" || !v.to) return null;
    return {
      to: v.to,
      at: Number(v.at) || 0,
      pi: typeof v.pi === "string" ? v.pi : "",
      ...(v.ship === true || v.ship === false ? { ship: v.ship } : {}),
      ...(Number(v.given) > 0 ? { given: Number(v.given) } : {}),
      ...(Number(v.revoked) > 0 ? { revoked: Number(v.revoked) } : {}),
    };
  } catch {
    return null;
  }
}

/** How many of a product's pre-orders wait to be handed over, are handed over, or were refunded. */
export function preorderCounts(entries: Preorder[]): { waiting: number; given: number; refunded: number } {
  let waiting = 0;
  let given = 0;
  let refunded = 0;
  for (const entry of entries) {
    if (entry.revoked) refunded += 1;
    else if (entry.given) given += 1;
    else waiting += 1;
  }
  return { waiting, given, refunded };
}

/**
 * The job a handed-over pre-order's grant is made with (lib/imported-purchases.ts, kept with no end, where its entry
 * expires): "pre:<checkout>", and ":s" when it ships or ":d" when it does not, whenever its entry says so at the
 * hand-over (Claude 1's H on #2827). An entry gone later never turns a known digital purchase into an unknown one,
 * whose withdrawal would stay open with no end.
 */
export function preorderJob(checkout: string, ship: boolean | undefined): string {
  return `pre:${checkout}${ship === true ? ":s" : ship === false ? ":d" : ""}`;
}

/** A pre-order grant's job read back: its checkout, and whether it ships (null when the job does not say: an older grant). */
export function readPreorderJob(job: string): { checkout: string; ship: boolean | null } | null {
  const m = /^pre:([^:]+)(?::([sd]))?$/.exec(job);
  if (!m) return null;
  return { checkout: m[1], ship: m[2] === "s" ? true : m[2] === "d" ? false : null };
}
