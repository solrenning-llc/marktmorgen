/**
 * Discount codes, kept on the creator's own Stripe account.
 *
 * A code here is two Stripe objects on the creator's connected account: a
 * Coupon, which is the discount itself, and a Promotion Code, which is the
 * word a buyer types. Both belong to the creator. That is not an incidental
 * choice — it means the redemption count is Stripe's count, the expiry is
 * Stripe's expiry, and a creator who leaves takes their codes with them. We
 * are not holding a second ledger of who got what off.
 *
 * It also means we never compute a discounted price ourselves. The buyer types
 * the code inside Stripe Checkout, Stripe decides whether it is live and what
 * it takes off, and the amount charged is Stripe's arithmetic on a coupon the
 * creator made. A platform that worked out the discount itself would be a
 * platform that can get somebody's money wrong.
 *
 * On Stan this is behind their $99 plan, checked on their own pricing page on
 * 20 September 2026. Here it is in the one price.
 *
 * ---
 *
 * A note on the API version, because it is the sharp edge in this file.
 *
 * Stripe moved the Promotion Code's `coupon` parameter into a `promotion` hash
 * in version 2025-09-30.clover. Which of the two shapes is accepted depends on
 * the version the request runs at, and left unset that is whatever our platform
 * account happens to default to — which somebody could change in a dashboard
 * next year and break every code created here. So every call below pins the
 * version explicitly. The request and the version can then never disagree.
 */
import { StripeError, onAccount } from "@/lib/stripe-account";
import type { MayComeOff } from "@/lib/platform-share";
import { hasOwnField, ownField, plainObject, readStripePage } from "@/lib/stripe-list";
import { CODE_PATTERN, MAX_CODES, type CodeDuration, type CodeMinimum, type DiscountCode, type Off } from "@/lib/discount-rules";

// The pure rules live in lib/discount-rules.ts, so the studio's editor never carries the Stripe reader above; every server reader still imports them from here.
export { CODE_PATTERN, MAX_CODES, type Off, type CodeProblem, CODE_PROBLEMS, minimumProblem, type CodeDuration, type CodeMinimum, amountProblem, readCode, codeProblem, offLabel, type DiscountCode, codeRules } from "@/lib/discount-rules";

/** Pinned, so the shape we send is the shape this version expects. */
const API_VERSION = "2025-09-30.clover";
/** The version codes are read at, for a reader outside this file (lib/deposit-code.ts). */
export const CODES_API_VERSION = API_VERSION;

export type CodeList =
  /**
   * `complete` is true only when Stripe said the page is the last one
   * (has_more false). A page with more behind it is the newest MAX_CODES
   * codes: what is on it is found, but no code on it is not "no code"
   * (lib/stripe-list.ts), so nothing "none" is concluded or written from it.
   */
  | { state: "ok"; codes: DiscountCode[]; complete: boolean }
  | { state: "unavailable" }
  | { state: "error" };

/** One code looked up by its id: found (live or not), confirmed absent by Stripe, or not known. */
export type FoundCode =
  | { state: "found"; active: boolean }
  | { state: "none" }
  | { state: "error" };

/**
 * Reads what a coupon takes off, whichever shape it arrived in.
 *
 * The version above is pinned, so `promotion.coupon` is what we expect. The
 * older top-level `coupon` is still read because a record made before this
 * file existed, or by the creator in their own Stripe dashboard, is just as
 * real and should still be listed rather than shown as a code that does
 * nothing.
 */
function readOff(row: Record<string, unknown>): Off | null {
  const promotion = row.promotion as { coupon?: unknown } | undefined;
  const raw = (promotion?.coupon ?? row.coupon) as
    | { percent_off?: unknown; amount_off?: unknown; currency?: unknown }
    | string
    | undefined;
  if (!raw || typeof raw === "string") return null;

  if (typeof raw.percent_off === "number" && raw.percent_off > 0) {
    return { kind: "percent", percent: raw.percent_off };
  }
  if (typeof raw.amount_off === "number" && raw.amount_off > 0) {
    return { kind: "amount", cents: raw.amount_off, currency: typeof raw.currency === "string" && raw.currency ? raw.currency : "usd" };
  }
  return null;
}

/** The coupon's `duration`, when the coupon came expanded. */
function readDuration(row: Record<string, unknown>): CodeDuration | null {
  const promotion = row.promotion as { coupon?: unknown } | undefined;
  const raw = (promotion?.coupon ?? row.coupon) as { duration?: unknown; duration_in_months?: unknown } | string | undefined;
  if (!raw || typeof raw === "string") return null;
  if (raw.duration === "once") return { kind: "once" };
  if (raw.duration === "forever") return { kind: "forever" };
  if (raw.duration === "repeating" && typeof raw.duration_in_months === "number" && Number.isSafeInteger(raw.duration_in_months) && raw.duration_in_months > 0) {
    return { kind: "repeating", months: raw.duration_in_months };
  }
  return null;
}

/** The promotion code's `restrictions` that this studio shows. */
function readRestrictions(row: Record<string, unknown>): { minimum: CodeMinimum | null; firstOrder: boolean; otherRules: boolean } {
  const raw = row.restrictions as { minimum_amount?: unknown; minimum_amount_currency?: unknown; first_time_transaction?: unknown; currency_options?: unknown } | null | undefined;
  const cents = raw?.minimum_amount;
  const currency = raw?.minimum_amount_currency;
  const minimum = typeof cents === "number" && Number.isSafeInteger(cents) && cents > 0 && typeof currency === "string" && /^[a-z]{3}$/i.test(currency)
    ? { cents, currency: currency.toLowerCase() }
    : null;
  // A minimum per currency, or a minimum in a shape not read above, is still Stripe's rule: said, never dropped.
  const options = raw?.currency_options;
  const otherRules =
    (options !== undefined && options !== null && !(typeof options === "object" && Object.keys(options as object).length === 0)) ||
    (cents !== undefined && cents !== null && minimum === null);
  return { minimum, firstOrder: raw?.first_time_transaction === true, otherRules };
}

function readRow(row: Record<string, unknown>): DiscountCode | null {
  if (typeof row.id !== "string" || !row.id) return null;
  if (typeof row.code !== "string" || !row.code) return null;
  return {
    ...readRestrictions(row),
    duration: readDuration(row),
    id: row.id,
    code: row.code,
    off: readOff(row),
    timesRedeemed:
      typeof row.times_redeemed === "number" ? row.times_redeemed : 0,
    maxRedemptions:
      typeof row.max_redemptions === "number" ? row.max_redemptions : null,
    expiresAt: typeof row.expires_at === "number" ? row.expires_at : null,
    active: row.active === true,
  };
}

/**
 * The codes on this creator's account: the newest page of them.
 *
 * Read from Stripe on every look rather than copied into our own record, for
 * the same reason the sales list is: there is then no second copy to drift
 * from the real one, and the redemption counts are the ones that actually
 * decide whether a code still works.
 *
 * One page, MAX_CODES codes, newest first, which is all one API read is
 * counted for (lib/api-read-rules.ts, codesWork). Stripe never deletes a
 * code, so a store past MAX_CODES always has a page behind this one: that
 * page is still read and answered, with `complete` false, never refused
 * whole and never taken for the whole list. `active` asks Stripe for the
 * live codes alone, for a reader that only offers live ones.
 */
export async function listCodes(account: string, only: { active?: true } = {}): Promise<CodeList> {
  try {
    const raw = await onAccount(
      "GET",
      account,
      // Expanded, so what each code takes off comes from the coupon itself
      // rather than from anything we wrote down beside it.
      `/promotion_codes?limit=${MAX_CODES}${only.active ? "&active=true" : ""}&expand[]=data.promotion.coupon`,
      undefined,
      API_VERSION,
    );
    // Read in its exact shape (lib/stripe-list.ts): no own `data` list or no
    // `has_more` true/false is not a page at all, and throws.
    const page = readStripePage(raw, (row) => hasOwnField(row, "code") && readRow(row) !== null);
    // One unreadable row refuses the page: the studio and the API show the
    // codes as a list, and a list with a hole in it is not Stripe's list.
    if (page.unreadable > 0) return { state: "error" };
    const codes: DiscountCode[] = [];
    const ids = new Set<string>();
    for (const row of page.rows) {
      const entry = readRow(row);
      if (!entry || ids.has(entry.id)) return { state: "error" };
      ids.add(entry.id);
      codes.push(entry);
    }
    return { state: "ok", codes, complete: !page.hasMore };
  } catch (error) {
    console.error("listing discount codes failed", error);
    return { state: "error" };
  }
}

/**
 * One code on this creator's account, asked for by its id, on whatever page
 * of the list it would be (GET /promotion_codes/:id, one request, the slot
 * the list read used to take). Only Stripe's own "no such object"
 * (404 resource_missing) is "none"; any other failure, or an answer that is
 * not that code with a true/false `active`, is not known.
 */
export async function findCode(account: string, id: string): Promise<FoundCode> {
  try {
    const row = await onAccount("GET", account, `/promotion_codes/${encodeURIComponent(id)}`, undefined, API_VERSION);
    if (!plainObject(row) || hasOwnField(row, "error") || ownField(row, "id") !== id) return { state: "error" };
    const active = ownField(row, "active");
    return typeof active === "boolean" ? { state: "found", active } : { state: "error" };
  } catch (error) {
    if (error instanceof StripeError && error.status === 404 && error.code === "resource_missing") return { state: "none" };
    console.error("looking up a discount code failed", error);
    return { state: "error" };
  }
}

export type MadeCode =
  | { ok: true; code: DiscountCode }
  | { ok: false; reason: "taken" | "stripe" };

/**
 * Makes a code: one coupon, and one promotion code pointing at it.
 *
 * The coupon is created first because the promotion code needs it. If the
 * second call fails, a coupon is left behind with nothing pointing at it — it
 * charges nobody anything and the creator never sees it, which is a better
 * failure than a live code whose discount we could not finish writing.
 */
export async function createCode(
  account: string,
  code: string,
  off: Off,
  maxRedemptions: number | null,
  /**
   * The smallest order it comes off (554 [DS1]), in the store's currency,
   * written as the promotion code's own restriction, so Stripe checks it
   * when the code is typed and works out nothing else here.
   */
  minimum: CodeMinimum | null = null,
  /**
   * A code scheduled ahead (511 [CK3], lib/discount-schedule.ts): made
   * switched off, with Stripe's own expiry as its end, for the five-minute
   * job to switch on at its start.
   */
  later: { expiresAt: number } | null = null,
): Promise<MadeCode> {
  const coupon = new URLSearchParams({
    // Once: the discount applies to the payment it is typed into. On a
    // membership that means the first charge, not every renewal for ever,
    // which is what a launch code is meant to do.
    duration: "once",
    name: code,
  });
  if (off.kind === "percent") {
    coupon.set("percent_off", String(off.percent));
  } else {
    coupon.set("amount_off", String(off.cents));
    coupon.set("currency", off.currency);
  }
  if (maxRedemptions !== null) {
    coupon.set("max_redemptions", String(maxRedemptions));
  }

  try {
    const made = await onAccount(
      "POST",
      account,
      "/coupons",
      coupon,
      API_VERSION,
    );
    if (typeof made.id !== "string") throw new Error("no coupon id");

    const promotion = new URLSearchParams({
      "promotion[type]": "coupon",
      "promotion[coupon]": made.id,
      code,
    });
    if (maxRedemptions !== null) {
      promotion.set("max_redemptions", String(maxRedemptions));
    }
    if (minimum) {
      promotion.set("restrictions[minimum_amount]", String(minimum.cents));
      promotion.set("restrictions[minimum_amount_currency]", minimum.currency);
    }
    if (later) {
      promotion.set("active", "false");
      promotion.set("expires_at", String(later.expiresAt));
    }

    const row = await onAccount(
      "POST",
      account,
      "/promotion_codes",
      promotion,
      API_VERSION,
    );
    const read = readRow(row);
    // The response does not expand the coupon, so what it takes off is filled
    // in from what we just asked for — the same numbers, one call sooner.
    return read
      ? { ok: true, code: { ...read, off: read.off ?? off, duration: read.duration ?? { kind: "once" } } }
      : { ok: false, reason: "stripe" };
  } catch (error) {
    // Stripe refuses a second live code with the same word. That is the one
    // failure a creator can act on, so it gets its own answer.
    if (
      error instanceof StripeError &&
      /already|exists|duplicate/i.test(error.message)
    ) {
      return { ok: false, reason: "taken" };
    }
    console.error("creating a discount code failed", error);
    return { ok: false, reason: "stripe" };
  }
}

/**
 * Switches a code off.
 *
 * Stripe has no delete for a promotion code, and that is right: a code that
 * has been redeemed is part of somebody's receipt. Switching it off stops it
 * being taken from now on and leaves the history alone.
 */
export async function stopCode(
  account: string,
  id: string,
): Promise<boolean> {
  try {
    const row = await onAccount(
      "POST",
      account,
      `/promotion_codes/${encodeURIComponent(id)}`,
      new URLSearchParams({ active: "false" }),
      API_VERSION,
    );
    // HTTP success alone does not prove this specific code was switched off.
    // Preserve uncertainty on partial, contradictory or mismatched replies.
    return !!row && typeof row === "object" && !Array.isArray(row)
      && Object.hasOwn(row, "id") && row.id === id
      && Object.hasOwn(row, "active") && row.active === false
      && !Object.hasOwn(row, "error");
  } catch (error) {
    console.error("switching a discount code off failed", error);
    return false;
  }
}

/**
 * Switches a scheduled code on (511 [CK3]): true only when Stripe's answer
 * names this code and says it is active, nothing else (an error, another
 * code, a partial answer, a timeout) proves it. The idempotency key is the
 * caller's, one for each try, so a repeat of a try is answered with the same
 * result instead of being done again.
 */
export async function activateCode(account: string, id: string, idempotencyKey: string): Promise<boolean> {
  try {
    const row = await onAccount(
      "POST",
      account,
      `/promotion_codes/${encodeURIComponent(id)}`,
      new URLSearchParams({ active: "true" }),
      API_VERSION,
      idempotencyKey,
    );
    return !!row && typeof row === "object" && !Array.isArray(row)
      && Object.hasOwn(row, "id") && row.id === id
      && Object.hasOwn(row, "active") && row.active === true
      && !Object.hasOwn(row, "error");
  } catch (error) {
    console.error("switching a scheduled discount code on failed", error);
    return false;
  }
}

/**
 * The id of the creator's live promotion code written this way, or null.
 *
 * Used when a code arrives in a link (lib/code-link.ts): the checkout applies
 * it by id. Only a code that is active on the creator's own account comes
 * back; whether it fits this particular sale (a minimum, a first order, a
 * product it is limited to) is still Stripe's to decide when the checkout
 * opens, and a refusal there falls back to the box (lib/store-checkout.ts).
 * A failure to ask is a null, never an error: a code is a nicety, a checkout
 * is the sale.
 */
export async function livePromotionId(account: string, code: string): Promise<string | null> {
  if (!CODE_PATTERN.test(code)) return null;
  try {
    const page = await onAccount(
      "GET",
      account,
      `/promotion_codes?limit=1&active=true&code=${encodeURIComponent(code)}`,
      undefined,
      API_VERSION,
    );
    const row = Array.isArray(page.data) ? (page.data[0] as Record<string, unknown> | undefined) : undefined;
    return row && typeof row.id === "string" && row.active !== false ? row.id : null;
  } catch (error) {
    console.error("looking up a code from a link failed", error);
    return null;
  }
}

/**
 * What the codes on this creator's account may take off a checkout in this
 * currency, for the share of the sale (lib/platform-share.ts): the fee set on
 * a checkout must never be more than the buyer pays, and the box on Stripe's
 * page takes any live code on the account, including one the creator made in
 * their own Stripe dashboard. Read fresh on every checkout that needs it, so
 * a code made a minute ago is counted. Anything that cannot be read in full
 * reads as unknown, which sets no fee at all.
 */
export async function codesMayTakeOff(account: string | null, currency: string): Promise<MayComeOff[]> {
  if (!account) return [{ kind: "unknown" }];
  try {
    const page = await onAccount("GET", account, "/promotion_codes?limit=100&active=true&expand[]=data.promotion.coupon", undefined, API_VERSION);
    if (page.has_more === true || !Array.isArray(page.data)) return [{ kind: "unknown" }];
    let percent = 0;
    let cents = 0;
    for (const row of page.data as Record<string, unknown>[]) {
      const off = readOff(row);
      if (!off) return [{ kind: "unknown" }];
      if (off.kind === "percent") percent = Math.max(percent, off.percent);
      else if (off.currency.toLowerCase() === currency.toLowerCase()) cents = Math.max(cents, off.cents);
    }
    const out: MayComeOff[] = [];
    if (percent > 0) out.push({ kind: "percent", percent });
    if (cents > 0) out.push({ kind: "cents", cents });
    return out;
  } catch (error) {
    console.error("reading what a store's codes take off failed", error);
    return [{ kind: "unknown" }];
  }
}
