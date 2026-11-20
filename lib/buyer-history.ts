import { normaliseEmail } from "@/lib/auth";
import { saleHandles, type Store } from "@/lib/store";
import { onAccount } from "@/lib/stripe-account";

/**
 * 567 [GD1] (f), unit 3: whether the person of an inbox conversation asked
 * this store for a refund, or opened a dispute here, before.
 *
 * Read when the creator asks, from the creator's own Stripe account, on the
 * address of that conversation alone, and never shown to another store.
 * Nothing is kept: no address, no result (the day's count of checks is the
 * only key, lib/request-guard.ts withinLimit).
 *
 * What it reads: the address's complete checkouts here, the newest page under
 * each spelling, with each payment's charge. A charge says whether it was
 * refunded in full (`refunded`), in part (`amount_refunded`), and whether a
 * dispute was ever opened on it (`disputed`, which stays true once opened,
 * won or lost). A subscription's payments are on its invoices, so it is said
 * as not checked, never as clean; so is a payment not made yet. Payments added
 * in one click after a checkout are not read here (the box says so).
 *
 * Rule 30: a reply that is not exactly a list, a row of another address, a
 * payment not expanded, or a paid payment without its charge makes the whole
 * check "could not check", never a count that leaves something out.
 */
export type RefundHistory =
  | {
      state: "known";
      /** Paid checkouts whose charge was read. */
      checked: number;
      /** Refunded in full. */
      refunded: number;
      /** Refunded in part only. */
      partly: number;
      /** A dispute was opened on it. */
      disputed: number;
      /** More checkouts than one page under a spelling: only the newest were read. */
      more: boolean;
      /** Subscriptions, and payments not made yet (a bank payment waiting): not checked. */
      unchecked: number;
      /** The address it was read under, normalised as the conversation keeps it: other spellings are not checked (review of #3841). */
      under: string;
    }
  | { state: "none" }
  | { state: "unknown" };

/**
 * Whether the studio's screen for this look exists (Claude 7's MEDIUM 2 on #3841, rule VR 2: what does not work today
 * does not appear). It does not yet (components/inbox-history.tsx is future work), so the inbox route refuses the
 * "history" action before anything is read, counted or kept, and neither the Privacy Policy nor the person-data list
 * describes it: their words wait in docs/held/inbox-refund-history.md, to come back with the screen. Only the screen's
 * own change turns it on; tests turn it on to exercise the route (tests/buyer-history.test.ts).
 */
export const REFUND_HISTORY_SCREEN: { shown: boolean } = { shown: false };

/** How many checks a store may ask for in a day, each at most two Stripe reads. */
export const REFUND_HISTORY_PER_DAY = 30;

/**
 * The studio requests one check takes before Stripe is asked, on top of the
 * request itself: enough to cover REFUND_HISTORY_READS listings at their
 * worst (tests/plan-cost-registry.ts REFUND_HISTORY_READ, each one waited on
 * for REFUND_HISTORY_READ_MS with an expanded page of the largest size), held
 * by tests/buyer-history-cost.test.ts. Two did not cover them; three do
 * (Claude 7 on #3841). The creator's Stripe account bills none of them.
 */
export const REFUND_HISTORY_UNITS = 3;

/** The newest checkouts one check reads under each spelling of the address: Stripe's largest page. */
export const REFUND_HISTORY_LIST = 100;

/**
 * The most bytes of one listing read (onAccount's maxBytes): an expanded page of REFUND_HISTORY_LIST checkouts at
 * its largest, the size REFUND_HISTORY_READ prices (tests/plan-cost-registry.ts). A heavier answer is stopped as it
 * streams in and said as could not check (Codex X6 on #3841).
 */
export const REFUND_HISTORY_PAGE_BYTES = 1_000_000;

/** A read gives up sooner than a payment would: this is only a look back. */
export const REFUND_HISTORY_READ_MS = 8_000;

/**
 * The most listings one check makes: one per spelling of the address (as typed, and as kept), never more. Each is
 * priced at its worst, waited on for REFUND_HISTORY_READ_MS and an expanded page of the largest size, in
 * tests/plan-cost-registry.ts REFUND_HISTORY_READ, which REFUND_HISTORY_UNITS must cover (Claude 7 on #3841).
 */
export const REFUND_HISTORY_READS = 2;

const UNKNOWN: RefundHistory = { state: "unknown" };

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

class Unreadable extends Error {}

/** One checkout's part in the count, or Unreadable. */
function rowOf(row: unknown, email: string, handles: Set<string>): { id: string; kind: "checked" | "unchecked" | "skip"; refunded: boolean; partly: boolean; disputed: boolean } {
  if (!isObject(row) || typeof row.id !== "string" || !row.id) throw new Unreadable();
  if (row.status !== "complete") throw new Unreadable();
  // Only this address's checkouts: a row of another address is not "nothing found".
  const details = row.customer_details;
  if (!isObject(details) || typeof details.email !== "string" || normaliseEmail(details.email) !== email) throw new Unreadable();
  const none = { id: row.id, refunded: false, partly: false, disputed: false };
  // The creator's Stripe account may serve their other stores, and sales made
  // outside Marktmorgen: only a checkout this store made, under any name it has
  // had (lib/buyer-orders.ts reads it the same way), is counted.
  if (!isObject(row.metadata)) throw new Unreadable();
  const made = row.metadata.store;
  if (typeof made !== "string" || !handles.has(made)) return { ...none, kind: "skip" };
  if (row.mode === "subscription" || row.mode === "setup") return { ...none, kind: "unchecked" };
  if (row.mode !== "payment") throw new Unreadable();
  if (row.payment_status === "no_payment_required") {
    if (row.payment_intent !== null && row.payment_intent !== undefined) throw new Unreadable();
    return { ...none, kind: "skip" };
  }
  // A payment waiting on the buyer's bank is not paid yet, whatever its charge says so far.
  if (row.payment_status === "unpaid") return { ...none, kind: "unchecked" };
  if (row.payment_status !== "paid") throw new Unreadable();
  const intent = row.payment_intent;
  if (!isObject(intent)) throw new Unreadable();
  const charge = intent.latest_charge;
  if (!isObject(charge)) throw new Unreadable();
  const { refunded, disputed, amount_refunded: amount } = charge;
  if (typeof refunded !== "boolean" || typeof disputed !== "boolean") throw new Unreadable();
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0) throw new Unreadable();
  return { id: row.id, kind: "checked", refunded, partly: !refunded && amount > 0, disputed };
}

/** The count from Stripe's listings, one a spelling of the address; any one that cannot be read spoils it. */
export function historyFrom(handles: Set<string>, listings: unknown[], email: string): RefundHistory {
  if (listings.length === 0) return UNKNOWN;
  const address = normaliseEmail(email);
  const seen = new Set<string>();
  const out = { state: "known" as const, checked: 0, refunded: 0, partly: 0, disputed: 0, more: false, unchecked: 0, under: address };
  try {
    for (const listing of listings) {
      if (!isObject(listing) || listing.object !== "list" || !Array.isArray(listing.data) ||
          listing.data.length > REFUND_HISTORY_LIST || typeof listing.has_more !== "boolean" ||
          (listing.has_more && listing.data.length === 0)) return UNKNOWN;
      if (listing.has_more) out.more = true;
      for (const row of listing.data) {
        const read = rowOf(row, address, handles);
        if (seen.has(read.id)) continue;
        seen.add(read.id);
        if (read.kind === "unchecked") out.unchecked += 1;
        if (read.kind !== "checked") continue;
        out.checked += 1;
        if (read.refunded) out.refunded += 1;
        if (read.partly) out.partly += 1;
        if (read.disputed) out.disputed += 1;
      }
    }
  } catch (error) {
    if (error instanceof Unreadable) return UNKNOWN;
    throw error;
  }
  return out;
}

/**
 * The check, read now from the creator's own account. "none" when the store
 * sells through no Stripe account; "unknown" when Stripe did not answer, or
 * answered something that does not read.
 */
export async function refundHistory(store: Store, email: string): Promise<RefundHistory> {
  const account = store.stripeAccountId;
  if (!account) return { state: "none" };
  // Stripe keeps the address as it was typed at checkout (lib/buyer-orders.ts, checkoutsOf). An inbox conversation
  // keeps it in lowercase (lib/inbox.ts, readEmail), so from the studio there is one spelling to ask under. Whether
  // Stripe's filter finds a checkout typed with capitals is not confirmed here: the studio says the check was made
  // under the address as the conversation has it (components/inbox-history.tsx), never "none" for the person.
  const variants = [...new Set([email.trim(), normaliseEmail(email)])].filter(Boolean).slice(0, REFUND_HISTORY_READS);
  if (!variants.length) return UNKNOWN;
  const listings: unknown[] = [];
  try {
    for (const variant of variants) {
      const query = new URLSearchParams({ "customer_details[email]": variant, status: "complete", limit: String(REFUND_HISTORY_LIST) });
      query.append("expand[]", "data.payment_intent.latest_charge");
      // Read up to REFUND_HISTORY_PAGE_BYTES: a heavier answer throws StripeBodyTooLarge, said below as could not check.
      listings.push(await onAccount("GET", account, `/checkout/sessions?${query}`, undefined, undefined, undefined, REFUND_HISTORY_READ_MS, REFUND_HISTORY_PAGE_BYTES));
    }
  } catch (error) {
    console.error("reading a buyer's past refunds and disputes failed", error);
    return UNKNOWN;
  }
  return historyFrom(saleHandles(store), listings, email);
}
