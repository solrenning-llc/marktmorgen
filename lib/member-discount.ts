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
 */
import { StripeUnreadableReply } from "@/lib/stripe-http-error";
import { onAccount } from "@/lib/stripe-account";
import { saleHandles, type Store } from "@/lib/store";
import { listCodes } from "@/lib/discount";

/** The Stripe version lib/discount.ts reads codes with, so `discounts[0][promotion_code]` means the same here. */
const API_VERSION = "2025-09-30.clover";
const CUSTOMER_PATTERN = /^cus_[A-Za-z0-9]{6,64}$/;
const SUB_PATTERN = /^sub_[A-Za-z0-9]{6,64}$/;
const PROMO_PATTERN = /^promo_[A-Za-z0-9]{6,64}$/;
/** The statuses of a membership still running, as lib/membership-manage.ts counts them. */
const LIVE = new Set(["active", "trialing", "past_due", "unpaid", "paused"]);
const MAX_CUSTOMERS = 20;
/**
 * The most Stripe pages one find (or one apply) waits on, the customers' page
 * included: the base's worst, one page of memberships a customer at the most
 * customers read, so the one studio request the route takes still covers it
 * (tests/plan-cost-registry.ts prices a Stripe page waited on). Memberships are
 * read 100 to a page, Stripe's largest, so a customer with more than one page
 * is followed while the budget lasts; past it the answer is unknown.
 */
const STRIPE_PAGES = 1 + MAX_CUSTOMERS;

/** A Stripe list that cannot be read whole: the answer is unknown, never what the rows read so far suggest. */
class UnreadListError extends Error {}

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
  /** Whether a discount already comes off it. */
  discounted: boolean;
};

type Raw = Record<string, unknown>;
const list = (value: unknown): Raw[] => (value && typeof value === "object" && Array.isArray((value as Raw).data) ? ((value as Raw).data as Raw[]) : []);

/**
 * One page of a Stripe list in its exact shape (CX-123 rule 24): a list of
 * rows and a has_more, or it throws. An empty or malformed answer is never
 * read as "none", and more said to come after an empty page is malformed.
 */
function page(value: unknown, what: string): { rows: Raw[]; more: boolean } {
  const listed = value && typeof value === "object" ? (value as Raw) : {};
  const rows = listed.data;
  if (!Array.isArray(rows) || typeof listed.has_more !== "boolean") throw new UnreadListError(`Stripe answered ${what} in a shape that cannot be read`);
  if (rows.some((row) => !row || typeof row !== "object" || Array.isArray(row))) throw new UnreadListError(`Stripe answered ${what} with a row that cannot be read`);
  if (listed.has_more && rows.length === 0) throw new UnreadListError(`Stripe said more ${what} come after an empty page`);
  return { rows: rows as Raw[], more: listed.has_more };
}

/** Whether Stripe says a subscription already has a discount on it (old `discount` or new `discounts`). */
export function hasDiscount(sub: Raw): boolean {
  if (sub.discount && typeof sub.discount === "object") return true;
  return Array.isArray(sub.discounts) && sub.discounts.length > 0;
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
 * customer first; null when Stripe could not be read whole. A list cut short
 * is not a complete one (r24, PR-F): more than MAX_CUSTOMERS customers under
 * the address, more pages of memberships than STRIPE_PAGES leaves, a page
 * that cannot be read or a customer with no id that can be read make the
 * answer unknown, so a running membership past the part read is never taken
 * for "not a member", and no discount is put on or refused on a guess.
 */
export async function memberSubs(store: Store, email: string): Promise<MemberSub[] | null> {
  const account = store.stripeAccountId;
  if (!account) return null;
  const handles = saleHandles(store);
  try {
    const customers = page(await onAccount("GET", account, `/customers?email=${encodeURIComponent(email)}&limit=${MAX_CUSTOMERS}`, undefined, API_VERSION), "customers");
    if (customers.more) throw new UnreadListError(`more than ${MAX_CUSTOMERS} customers under one address`);
    const out: MemberSub[] = [];
    // One budget for the whole find, the customers' page already spent.
    let pages = 1;
    for (const customer of customers.rows) {
      if (typeof customer.id !== "string" || !CUSTOMER_PATTERN.test(customer.id)) throw new UnreadListError("Stripe answered a customer with no id that can be read");
      let after = "";
      for (;;) {
        if (pages === STRIPE_PAGES) throw new UnreadListError(`more than ${STRIPE_PAGES} Stripe pages for one address's memberships`);
        pages += 1;
        const query = `customer=${encodeURIComponent(customer.id)}&status=all&limit=100${after ? `&starting_after=${encodeURIComponent(after)}` : ""}`;
        const subs = page(await onAccount("GET", account, `/subscriptions?${query}`, undefined, API_VERSION), "memberships");
        for (const sub of subs.rows) {
          const row = readMemberSub(sub, handles);
          if (row) out.push(row);
        }
        if (!subs.more) break;
        const last = subs.rows[subs.rows.length - 1].id;
        if (typeof last !== "string" || !SUB_PATTERN.test(last)) throw new UnreadListError("Stripe answered a membership with no id to read on from");
        after = last;
      }
    }
    return out;
  } catch (error) {
    console.error("reading a member's memberships failed", error);
    return null;
  }
}

export type ApplyResult = { ok: true } | { ok: false; reason: "not_member" | "discounted" | "code" | "stripe" | "refused" };

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
  const sub = subs.find((s) => s.id === subscription);
  if (!sub) return { ok: false, reason: "not_member" };
  if (sub.discounted) return { ok: false, reason: "discounted" };
  const codes = await listCodes(account);
  if (codes.state !== "ok") return { ok: false, reason: "stripe" };
  if (!codes.codes.some((c) => c.id === promotion && c.active)) return { ok: false, reason: "code" };
  try {
    await onAccount("POST", account, `/subscriptions/${encodeURIComponent(subscription)}`, new URLSearchParams({ "discounts[0][promotion_code]": promotion }), API_VERSION, `member-discount:${subscription}:${promotion}`);
    return { ok: true };
  } catch (error) {
    // Stripe refusing it by the code's own rules (a first order only, a minimum, used up) is said as such.
    // A page in front of Stripe that is not JSON (lib/stripe-http-error.ts) is not Stripe refusing the code.
    const status = error instanceof StripeUnreadableReply ? null : (error as { status?: unknown }).status;
    if (status === 400) return { ok: false, reason: "refused" };
    console.error("putting a discount on a membership failed", error);
    return { ok: false, reason: "stripe" };
  }
}
