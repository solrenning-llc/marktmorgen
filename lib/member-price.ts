/**
 * Member and past-buyer prices on the server (620 [SZ4]; the rules are in
 * lib/member-price-rules.ts).
 *
 * A member price is shown and charged only to an address proved now, never
 * claimed without proof:
 *
 *   - the address is proved the way courses are opened (lib/learn.ts,
 *     learnerFrom), but only where the inbox itself was proved: the pass a
 *     link sent to that address gave the browser, or a signed-in session
 *     with it. A pass for some courses only (the browser that paid for
 *     them) proves nothing here: its address was typed at checkout and never
 *     checked, and everything else bought under it may be somebody else's.
 *     It never hides a signed-in session in the same browser, which does.
 *     The creator on their own store is never a member of it;
 *   - what it holds is read from the creator's own Stripe account, at most
 *     two calls (the address as typed and as kept): a membership counts only
 *     while Stripe calls it active and no pause the member chose is running
 *     (not in a free trial, not past due, not cancelled); a one-off purchase
 *     only when it was paid, never refunded in full or in part and never
 *     disputed; never a payment plan, nor a gift, a group place or a
 *     pre-order bought for others. A purchase the creator brought over from
 *     another platform counts as bought; a gift someone else paid for does
 *     not, nor a PayPal sale, whose refunds and disputes are not read here;
 *   - an answer Stripe or the database does not give, or gives in another
 *     shape (lib/stripe-list.ts, lib/redis-reply.ts), proves nothing, and a
 *     check that cannot finish is "unknown": the normal price is shown and
 *     charged.
 *
 * The read is counted before anything about the buyer is read, as
 * MEMBER_PRICE_REQUEST_UNITS of the plan's public requests (the same count
 * and the same bounds as the next product after a purchase,
 * NEXT_OFFER_READ in tests/plan-cost-registry.ts), and only for a product a
 * rule covers, from a browser that carries a pass or a session.
 *
 * The page and the checkout ask the same function (memberPriceFor). The
 * page's form sends the percentage it showed; the checkout proves it again
 * and refuses, before Stripe, a claim that is not what is proved now
 * (memberClaim), so what Stripe charges is what the page said. The
 * checkout then opens with the proved address fixed, so the product at the
 * member price is the member's, never typed over for somebody else.
 *
 * Nothing is kept: no list of members, no answer cached.
 */
import { SESSION_COOKIE, emailForSession, normaliseEmail } from "@/lib/auth";
import { takeBuyerRead } from "@/lib/buyer-actions";
import { readListings } from "@/lib/catalog";
import { deliveredIds } from "@/lib/bundle-rules";
import { importedFrom, importedRead } from "@/lib/imported-purchases";
import { TOKEN_PATTERN, learnerFrom, passCookieName } from "@/lib/learn";
import { memberState } from "@/lib/membership-access";
import { NEXT_OFFER_REQUEST_UNITS } from "@/lib/next-offer-rules";
import { isMemberPercent, memberOffFrom, qualifyingFor } from "@/lib/member-price-rules";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { repliesFor, stringList } from "@/lib/redis-reply";
import { onAccount } from "@/lib/stripe-account";
import { STRIPE_LIST_VERSION, plainObject, readStripePage } from "@/lib/stripe-list";
import { currentMeta } from "@/lib/tier-rules";
import { type Listing, type Store, saleHandles } from "@/lib/store";

/** Public requests one check takes from the store's month, before it reads: the next product after a purchase's own count. */
export const MEMBER_PRICE_REQUEST_UNITS = NEXT_OFFER_REQUEST_UNITS;
/** Calls to the creator's Stripe account one check makes at the most: the address as typed and as kept. */
export const MEMBER_PRICE_STRIPE_CALLS = 2;

const SESSION_ROW = /^cs_(test|live)_[A-Za-z0-9]{10,200}$/;
/**
 * An import's own job (lib/imports.ts): bought on another platform. A gift
 * (someone else paid) is not, nor a PayPal sale (lib/paypal-sales.ts),
 * whose partial refunds and disputes nothing here reads.
 */
const BOUGHT_JOB = /^[0-9a-f]{24}$/;

/** "member" carries the address it was proved for, so the checkout opens with it fixed. */
export type MemberCheck = { state: "none" } | { state: "member"; percent: number; email: string } | { state: "unknown" };
type CookieJar = { get(name: string): { value: string } | undefined };
/** What a qualifying product is, for reading its rows. */
export type QualifyingKind = { recurring: boolean };

const NONE: MemberCheck = { state: "none" };
const UNKNOWN: MemberCheck = { state: "unknown" };

/** A one-off payment paid and kept: succeeded, its charge expanded, nothing refunded, never disputed. Anything else proves nothing. */
function paidAndKept(payment: unknown): boolean {
  if (!plainObject(payment) || payment.status !== "succeeded") return false;
  const charge = payment.latest_charge;
  if (!plainObject(charge)) return false;
  return charge.paid === true && charge.refunded === false && charge.amount_refunded === 0 && charge.disputed === false;
}

/**
 * The qualifying products this address's completed checkouts prove it holds
 * now, from Stripe's rows. Pure: rows in another shape are passed over and
 * prove nothing.
 */
export function heldFromSessions(rows: readonly unknown[], handles: ReadonlySet<string>, kinds: ReadonlyMap<string, QualifyingKind>): Set<string> {
  const held = new Set<string>();
  for (const row of rows) {
    if (!plainObject(row) || row.status !== "complete" || !plainObject(row.metadata)) continue;
    const meta = row.metadata as Record<string, string>;
    // A product sold as itself: never a payment plan, a booking's deposit, a package of calls, a tip, a request or an offer after paying.
    if (meta.kind !== undefined) continue;
    if (row.mode === "subscription") {
      // Paid now is Stripe's "active": a free trial, a retry or a pause is not.
      if (row.payment_status !== "paid" && row.payment_status !== "no_payment_required") continue;
      const now = currentMeta(meta, row as { mode?: unknown; subscription?: unknown });
      if (!handles.has(now.store ?? "")) continue;
      const id = now.product ?? "";
      if (!kinds.get(id)?.recurring) continue;
      if (memberState(row.subscription) !== "active") continue;
      held.add(id);
    } else if (row.mode === "payment") {
      if (row.payment_status !== "paid" || !handles.has(meta.store ?? "")) continue;
      if (!paidAndKept(row.payment_intent)) continue;
      // A gift, a group's places or a pre-order hand over nothing to whoever paid (deliveredIds).
      for (const id of deliveredIds(meta)) {
        const kind = kinds.get(id);
        if (kind && !kind.recurring) held.add(id);
      }
    }
  }
  return held;
}

/** The qualifying products this address holds here, or null when that could not be read. */
async function heldHere(store: Store, email: string, kinds: ReadonlyMap<string, QualifyingKind>): Promise<{ held: Set<string>; complete: boolean } | null> {
  const account = store.stripeAccountId;
  if (!account) return null;
  const handles = saleHandles(store);
  const held = new Set<string>();
  let complete = true;
  // Stripe keeps the address as it was typed at checkout; both reads and the purchases brought over go at once.
  const variants = [...new Set([email.trim(), normaliseEmail(email)])].slice(0, MEMBER_PRICE_STRIPE_CALLS);
  const read = [...kinds.values()].some((kind) => !kind.recurring) ? importedRead(store, email) : null;
  // A store that brought buyers over, with no database to read them from: what was brought over is not known.
  if (read && !isRedisConfigured()) complete = false;
  const readImported = read && isRedisConfigured() ? read : null;
  try {
    const [pages, imported] = await Promise.all([
      Promise.all(
        variants.map(async (variant) => {
          const query = new URLSearchParams({ "customer_details[email]": variant, status: "complete", limit: "100" });
          query.append("expand[]", "data.subscription");
          query.append("expand[]", "data.payment_intent.latest_charge");
          // A "yes" stands from any readable row; a page in another shape throws (lib/stripe-list.ts).
          return readStripePage(await onAccount("GET", account, `/checkout/sessions?${query}`, undefined, STRIPE_LIST_VERSION), plainObject, SESSION_ROW);
        }),
      ),
      readImported ? redisPipeline([readImported]).then((replies) => repliesFor(replies, 1)?.[0]) : Promise.resolve(null),
    ]);
    for (const page of pages) {
      for (const id of heldFromSessions(page.rows, handles, kinds)) held.add(id);
      // Only the newest hundred are read: past them, or past a row in another shape, a "no" is not known.
      if (page.hasMore || page.unreadable > 0) complete = false;
    }
    // HGETALL answers field, value, field, value, all strings: a reply in any other shape (a number, a missing slot, a field with
    // no value) is not "nothing brought over", only not known (rule 24). An empty list is a real "nothing".
    const pairs = readImported ? stringList(imported) : [];
    if (pairs === null || pairs.length % 2 !== 0) complete = false;
    else {
      for (const purchase of importedFrom(pairs)) {
        if (!BOUGHT_JOB.test(purchase.job)) continue;
        for (const id of [purchase.productId, ...(purchase.items ?? [])]) {
          const kind = kinds.get(id);
          // Nothing paid through Stripe keeps a membership running: only a one-off counts.
          if (kind && !kind.recurring) held.add(id);
        }
      }
    }
  } catch (error) {
    console.error("reading who holds a membership failed", error);
    return null;
  }
  return { held, complete };
}

/**
 * The member price this browser's proved address gets on this product now:
 * "none" (the normal price), "member" with the percentage, or "unknown"
 * when it could not be proved (the normal price too). The page and the
 * checkout both ask this.
 */
export async function memberPriceFor(store: Store, product: Listing, cookies: CookieJar): Promise<MemberCheck> {
  const qualifying = qualifyingFor(store.memberPrices, product);
  if (qualifying.length === 0 || !store.stripeAccountId) return NONE;
  // Nobody to prove without a pass in its shape or a session: nothing is read or counted.
  if (!TOKEN_PATTERN.test(cookies.get(passCookieName(store))?.value ?? "") && !cookies.get(SESSION_COOKIE)?.value) return NONE;
  if (!(await takeBuyerRead(store, MEMBER_PRICE_REQUEST_UNITS))) return UNKNOWN;
  const learner = await learnerFrom(store, cookies).then(
    (found) => found,
    () => undefined,
  );
  if (learner === undefined) return UNKNOWN;
  if (!learner || learner.owner) return NONE;
  let email = learner.email;
  if (learner.scope !== "all") {
    // learnerFrom reads a pass for some courses before the session (courses rely on that order); that pass proves nothing here,
    // but a signed-in session in the same browser proves its own inbox.
    const signedIn = await emailForSession(cookies.get(SESSION_COOKIE)?.value).then(
      (found) => found,
      () => undefined,
    );
    if (signedIn === undefined) return UNKNOWN;
    if (!signedIn) return NONE;
    email = signedIn;
  }
  // Only an inbox proved (a link's pass, or signed in), and never the creator, signed in or by a link to their own address.
  if (normaliseEmail(email) === normaliseEmail(store.email)) return NONE;
  let listings: Listing[];
  try {
    listings = await readListings(store, qualifying);
  } catch (error) {
    console.error("reading the products a member price asks for failed", error);
    return UNKNOWN;
  }
  const kinds = new Map<string, QualifyingKind>();
  for (const listing of listings) kinds.set(listing.id, { recurring: listing.recurring !== null });
  if (kinds.size === 0) return NONE;
  const found = await heldHere(store, email, kinds);
  if (found === null) return UNKNOWN;
  const percent = memberOffFrom(store.memberPrices, product, found.held);
  // A larger rule may rest on a purchase not read: said as unknown, never as no.
  const most = memberOffFrom(store.memberPrices, product, new Set(kinds.keys()));
  if (percent < most && !found.complete) return UNKNOWN;
  return percent > 0 ? { state: "member", percent, email } : NONE;
}

/** The percentage a product page's form says it showed as the member price; 0 for none or anything else. */
export function readMemberClaim(raw: unknown): number {
  if (typeof raw !== "string" || !/^\d{1,2}$/.test(raw)) return 0;
  const percent = Number(raw);
  return isMemberPercent(percent) ? percent : 0;
}

/**
 * The page's claim, proved again at checkout: applied only when it is
 * exactly what this address is proved to get now. Anything else is refused
 * before Stripe, so nobody is charged a price the page did not show.
 */
export async function memberClaim(store: Store, product: Listing, claimed: number, cookies: CookieJar): Promise<{ ok: true; member: number; email: string } | { ok: false }> {
  if (!isMemberPercent(claimed)) return { ok: false };
  const check = await memberPriceFor(store, product, cookies);
  if (check.state !== "member" || check.percent !== claimed) return { ok: false };
  return { ok: true, member: claimed, email: check.email };
}
