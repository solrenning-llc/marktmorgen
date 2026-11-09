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
/**
 * Every status Stripe gives a subscription at API_VERSION ("Subscription
 * object", status enum), the same list lib/billing.ts reads plans with. Any
 * other value is not one Stripe sends, so the row is unknown (Codex S
 * corrective focal of #2912, M2 residual): only a recognized status that is
 * not running (canceled, incomplete, incomplete_expired) leaves it out.
 */
const STRIPE_SUB_STATUSES = new Set([...LIVE, "canceled", "incomplete", "incomplete_expired"]);
const MAX_CUSTOMERS = 20;

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

export type Raw = Record<string, unknown>;
const list = (value: unknown): Raw[] => (value && typeof value === "object" && Array.isArray((value as Raw).data) ? ((value as Raw).data as Raw[]) : []);

/**
 * One page of a Stripe list read exactly (rule 24; Claude 4 team review of
 * #2912, M2): its rows when the answer is a whole list on one page. An answer
 * out of shape, without has_more, or saying more pages follow throws, so the
 * caller says Stripe could not be read, never that there is no membership.
 */
function onePage(value: unknown, what: string): Raw[] {
  const page = value && typeof value === "object" ? (value as Raw) : null;
  if (!page || !Array.isArray(page.data) || typeof page.has_more !== "boolean" || !page.data.every((row) => row && typeof row === "object" && !Array.isArray(row))) {
    throw new Error(`Stripe answered ${what} in an unknown shape`);
  }
  if (page.has_more) throw new Error(`Stripe has more ${what} than one page holds`);
  return page.data as Raw[];
}

/**
 * Whether a row is one Stripe could have sent for a customer or a
 * subscription: its id, and for a subscription a status Stripe has and its
 * metadata object, readable (Codex S second review of #2912, residual of M2;
 * its corrective focal: a non-empty status is not enough). A row
 * that is not is unknown, never left out as "not a membership": only a
 * readable row is filtered by status, store or kind.
 */
const readableCustomer = (row: Raw): boolean => typeof row.id === "string" && CUSTOMER_PATTERN.test(row.id);
const readableSub = (row: Raw): boolean =>
  typeof row.id === "string" && SUB_PATTERN.test(row.id) && typeof row.status === "string" && STRIPE_SUB_STATUSES.has(row.status) && !!row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata);

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

/** Every running membership of this store held under an address, newest customer first; null when Stripe could not be read. */
export async function memberSubs(store: Store, email: string): Promise<MemberSub[] | null> {
  const rows = await memberSubRows(store, email);
  return rows === null ? null : rows.map((r) => r.row);
}

/**
 * The same memberships with what Stripe answered for each, for a reader that
 * needs more of a subscription than the studio row (lib/member-free-days.ts:
 * its next charge). Same reads, same filter; null when Stripe could not be read.
 */
export async function memberSubRows(store: Store, email: string): Promise<{ row: MemberSub; raw: Raw }[] | null> {
  const account = store.stripeAccountId;
  if (!account) return null;
  const handles = saleHandles(store);
  try {
    const customers = onePage(await onAccount("GET", account, `/customers?email=${encodeURIComponent(email)}&limit=${MAX_CUSTOMERS}`, undefined, API_VERSION), "customers");
    const out: { row: MemberSub; raw: Raw }[] = [];
    for (const customer of customers) {
      if (!readableCustomer(customer)) throw new Error("Stripe answered a customer row in an unknown shape");
      const subs = onePage(await onAccount("GET", account, `/subscriptions?customer=${encodeURIComponent(customer.id as string)}&status=all&limit=20`, undefined, API_VERSION), "subscriptions");
      for (const sub of subs) {
        if (!readableSub(sub)) throw new Error("Stripe answered a subscription row in an unknown shape");
        const row = readMemberSub(sub, handles);
        if (row) out.push({ row, raw: sub });
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
    const status = (error as { status?: unknown }).status;
    if (status === 400) return { ok: false, reason: "refused" };
    console.error("putting a discount on a membership failed", error);
    return { ok: false, reason: "stripe" };
  }
}
