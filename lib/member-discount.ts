/**
 * A creator's discount code put on one member's running membership, from the
 * studio (616 [WP15](8); owner's Whop audit). Everything happens on the
 * creator's own Stripe account: the code is one of theirs (lib/discount.ts),
 * the membership is theirs, and Stripe keeps applying the code's own rules
 * (how long it lasts, a first order only, its minimum), refusing it when
 * they do not fit. Marktmorgen takes nothing and charges nothing here.
 *
 * Read again on the server at the moment of applying, never taken from the
 * page: the member by their address, the membership among this store's live
 * ones of theirs, and the code among the store's active ones. A membership
 * that already has a discount is refused rather than having it replaced
 * without a word: a better one could be lost.
 *
 * Stripe's answers are read in their exact shape (CX-123 rules 24 and 30,
 * lib/stripe-list.ts): a list that is not a whole, readable list is "could
 * not check" ("unreadable"), never "no running membership"; a `discounts`
 * that is not Stripe's own shape is "not known", and the code is not put on,
 * since putting it on would replace whatever is there.
 */
import { types } from "node:util";
import { onAccount } from "@/lib/stripe-account";
import { StripeListUnreadable, hasOwnField, ownField, plainObject, readStripePage, type StripeRow } from "@/lib/stripe-list";
import { saleHandles, type Store } from "@/lib/store";
import { listCodes } from "@/lib/discount";

/** The Stripe version lib/discount.ts reads codes with, so `discounts[0][promotion_code]` means the same here. */
const API_VERSION = "2025-09-30.clover";
const CUSTOMER_PATTERN = /^cus_[A-Za-z0-9]{6,64}$/;
const SUB_PATTERN = /^sub_[A-Za-z0-9]{6,64}$/;
const PROMO_PATTERN = /^promo_[A-Za-z0-9]{6,64}$/;
/** The statuses of a membership still running, as lib/membership-manage.ts counts them. */
const LIVE = new Set(["active", "trialing", "past_due", "unpaid", "paused"]);
/** Every status Stripe gives a subscription; a row with another is not read as anything. */
const STRIPE_STATUSES = new Set(["incomplete", "incomplete_expired", "trialing", "active", "past_due", "canceled", "unpaid", "paused"]);
/** One page of customers under an address: more than that is not checked, and says so. */
const MAX_CUSTOMERS = 20;
/** A customer's subscriptions, read 100 to a page, Stripe's largest. */
const SUB_PAGE = 100;
/**
 * The most Stripe pages one find (or one apply) waits on, the customers' page
 * included: the base's worst, one page of memberships a customer at the most
 * customers read, so the one studio request the route takes still covers it
 * (tests/plan-cost-registry.ts prices a Stripe page waited on; Claude 4 and
 * Claude 1 on #2979). A customer with more than one page is followed while
 * the budget lasts; past it the answer is "unreadable", never "none".
 */
export const STRIPE_PAGES = 1 + MAX_CUSTOMERS;

/** One of a member's running memberships of this store, as the studio shows it. */
export type MemberSub = {
  id: string;
  status: string;
  /** The product it is for, by id; "" when Stripe has none written down. */
  product: string;
  /** What each renewal costs before any discount, in the smallest unit, and how often. */
  amount: number;
  currency: string;
  interval: string;
  /** Whether a discount already comes off it; null when Stripe's answer could not be read (then nothing is put on). */
  discounted: boolean | null;
};

export type Raw = Record<string, unknown>;
const list = (value: unknown): Raw[] => (value && typeof value === "object" && Array.isArray((value as Raw).data) ? ((value as Raw).data as Raw[]) : []);

/**
 * Whether Stripe says a subscription already has a discount on it (old
 * `discount` or new `discounts`), read exactly: `discounts` is a list of
 * discount ids or discount objects, empty when there is none. Anything else
 * (missing, null, a list object, one id as text) is null, "not known", never
 * "no discount": a code put on would replace what is there.
 */
export function hasDiscount(sub: Raw): boolean | null {
  const old = hasOwnField(sub, "discount") ? ownField(sub, "discount") : null;
  if (plainObject(old)) return true;
  if (old !== null) return null;
  const now = ownField(sub, "discounts");
  if (!Array.isArray(now) || types.isProxy(now)) return null;
  if (now.length === 0) return false;
  const known = (d: unknown) => (typeof d === "string" && d.length > 0) || (plainObject(d) && typeof ownField(d, "id") === "string");
  return now.every(known) ? true : null;
}

/** A subscription row is readable when it has a status Stripe gives and its metadata as an object. */
const legibleSub = (row: Record<string, unknown>): boolean => {
  const status = ownField(row, "status");
  return typeof status === "string" && STRIPE_STATUSES.has(status) && plainObject(ownField(row, "metadata"));
};

/**
 * Every row of a Stripe list read to its end, every row readable; otherwise StripeListUnreadable. Each page is taken
 * from `budget`, shared by the whole find: past it the list is not read whole.
 */
async function readWhole(account: string, path: string, limit: number, budget: { pages: number }, pattern: RegExp, legible?: (row: Record<string, unknown>) => boolean): Promise<StripeRow[]> {
  const rows: StripeRow[] = [];
  let after = "";
  for (;;) {
    if (budget.pages <= 0) throw new StripeListUnreadable(`more than ${STRIPE_PAGES} Stripe pages for one address's memberships`);
    budget.pages -= 1;
    const read = readStripePage(await onAccount("GET", account, `${path}&limit=${limit}${after ? `&starting_after=${encodeURIComponent(after)}` : ""}`, undefined, API_VERSION), legible, pattern);
    if (read.unreadable > 0) throw new StripeListUnreadable(`${read.unreadable} row(s) could not be read`);
    rows.push(...read.rows);
    if (!read.hasMore) return rows;
    if (!read.lastId) throw new StripeListUnreadable("no row to read the next page from");
    after = read.lastId;
  }
}

/** A subscription row made safe for the studio, or null when it is not a running membership of this store. */
export function readMemberSub(sub: Raw, handles: Set<string>): MemberSub | null {
  const meta = sub.metadata && typeof sub.metadata === "object" ? (sub.metadata as Record<string, string>) : {};
  if (typeof sub.id !== "string" || !SUB_PATTERN.test(sub.id)) return null;
  if (typeof sub.status !== "string" || !LIVE.has(sub.status)) return null;
  // Only this store's, and never a payment plan: it pays for something already delivered.
  if (!handles.has(meta.store ?? "") || meta.kind === "plan") return null;
  const item = list(sub.items)[0] ?? {};
  const price = item.price && typeof item.price === "object" ? (item.price as Raw) : {};
  const recurring = price.recurring && typeof price.recurring === "object" ? (price.recurring as Raw) : {};
  return {
    id: sub.id,
    status: sub.status,
    product: typeof meta.product === "string" ? meta.product : "",
    amount: typeof price.unit_amount === "number" ? price.unit_amount : 0,
    currency: typeof price.currency === "string" ? price.currency : "",
    interval: typeof recurring.interval === "string" ? recurring.interval : "",
    discounted: hasDiscount(sub),
  };
}

/**
 * Every running membership of this store held under an address, newest
 * customer first; null when Stripe could not be reached, "unreadable" when it
 * answered in a shape that cannot be read whole (not known, never "none").
 */
export async function memberSubs(store: Store, email: string): Promise<MemberSub[] | "unreadable" | null> {
  const rows = await memberSubRows(store, email);
  return rows === null || rows === "unreadable" ? rows : rows.map((r) => r.row);
}

/**
 * The same memberships with what Stripe answered for each, for a reader that
 * needs more of a subscription than the studio row (lib/member-free-days.ts:
 * its next charge). Same reads, same filter, same answers when Stripe could not
 * be reached (null) or read whole ("unreadable").
 */
export async function memberSubRows(store: Store, email: string): Promise<{ row: MemberSub; raw: Raw }[] | "unreadable" | null> {
  const account = store.stripeAccountId;
  if (!account) return null;
  const handles = saleHandles(store);
  try {
    // One budget for the whole find (STRIPE_PAGES), the customers' page included; a second page of customers is more
    // than MAX_CUSTOMERS under one address, so it is not read: unreadable.
    const budget = { pages: STRIPE_PAGES };
    const customers = await readWhole(account, `/customers?email=${encodeURIComponent(email)}`, MAX_CUSTOMERS, { pages: 1 }, CUSTOMER_PATTERN);
    budget.pages -= 1;
    const out: { row: MemberSub; raw: Raw }[] = [];
    for (const customer of customers) {
      const subs = await readWhole(account, `/subscriptions?customer=${encodeURIComponent(customer.id)}&status=all`, SUB_PAGE, budget, SUB_PATTERN, legibleSub);
      for (const sub of subs) {
        const row = readMemberSub(sub, handles);
        if (row) out.push({ row, raw: sub });
      }
    }
    return out;
  } catch (error) {
    if (error instanceof StripeListUnreadable) {
      console.error("a member's memberships could not be read whole", error.message);
      return "unreadable";
    }
    console.error("reading a member's memberships failed", error);
    return null;
  }
}

export type ApplyResult = { ok: true } | { ok: false; reason: "not_member" | "discounted" | "code" | "stripe" | "refused" | "unavailable" };

/**
 * Puts one of the store's active codes on one of the member's running
 * memberships, everything read again first. Once: the same code on the same
 * membership is one request to Stripe whatever the presses (idempotency key).
 */
export async function applyMemberDiscount(store: Store, email: string, subscription: string, promotion: string): Promise<ApplyResult> {
  const account = store.stripeAccountId;
  if (!account || !SUB_PATTERN.test(subscription) || !PROMO_PATTERN.test(promotion)) return { ok: false, reason: "not_member" };
  const subs = await memberSubs(store, email);
  if (subs === null) return { ok: false, reason: "stripe" };
  if (subs === "unreadable") return { ok: false, reason: "unavailable" };
  const sub = subs.find((s) => s.id === subscription);
  if (!sub) return { ok: false, reason: "not_member" };
  // Not known is never "none": the code would replace whatever is there.
  if (sub.discounted === null) return { ok: false, reason: "unavailable" };
  if (sub.discounted) return { ok: false, reason: "discounted" };
  const codes = await listCodes(account);
  if (codes.state !== "ok") return { ok: false, reason: "stripe" };
  if (!codes.codes.some((c) => c.id === promotion && c.active)) return { ok: false, reason: "code" };
  try {
    await onAccount("POST", account, `/subscriptions/${encodeURIComponent(subscription)}`, new URLSearchParams({ "discounts[0][promotion_code]": promotion }), API_VERSION, `member-discount:${subscription}:${promotion}`);
    return { ok: true };
  } catch (error) {
    // Stripe refusing it by the code's own rules (a first order only, a minimum, used up) is said as such.
    const status = (error as { status?: unknown }).status;
    if (status === 400) return { ok: false, reason: "refused" };
    console.error("putting a discount on a membership failed", error);
    return { ok: false, reason: "stripe" };
  }
}
