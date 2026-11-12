/**
 * The invoices of a creator's own Marktmorgen plan (601 [KB22] unit U5), read
 * from our platform Stripe account for the studio (app/studio/invoices).
 *
 * Only the store's own customer and its own plan subscription are asked for
 * (`customer` and `subscription` on Stripe's invoice list), and every row is
 * checked again for both: a row of any other customer or subscription, of
 * another store of the same person included, is never shown. One page of
 * PLAN_INVOICES_SHOWN, the most recent first.
 *
 * The page itself counts STUDIO_PAGE_UNITS of the store's studio requests,
 * as every page does and as the Terms say, and nothing more of that figure
 * (owner's decision on the studio totals, inbox C4: a page costs what the
 * Terms say). Reading Stripe takes one of the store's ESSENTIAL_PER_DAY
 * requests of the day instead (the counter countStudio keeps for leaving and
 * paying), each priced with a heavy request and two Stripe GETs in
 * tests/plan-cost-registry.ts; tests/plan-cost-registry.test.ts holds
 * PLAN_INVOICES_READ under it. It is taken only while fewer than
 * PLAN_INVOICES_PER_DAY of them were taken in that counter's window, in one
 * script on the same key (takeEssentialBelow), so reading invoices never
 * leaves fewer than ESSENTIAL_PER_DAY - PLAN_INVOICES_PER_DAY for leaving or
 * paying, whatever came first. A count that could not be read asks nothing
 * and says so, never "too many". A store with no plan subscription asks
 * Stripe nothing and takes nothing.
 *
 * Unknown is never none (lib/stripe-list.ts): an answer Stripe could not
 * give, or gave in another shape, is "unknown"; rows that are not readable
 * are counted and keep the page from saying there are no invoices.
 */
import { onPlatformAt } from "@/lib/billing";
import { CUSTOMER_PATTERN, SUBSCRIPTION_PATTERN, type Store } from "@/lib/store";
import type { LimitState } from "@/lib/request-guard";
import { ESSENTIAL_PER_DAY } from "@/lib/studio-allowance-rules";
import { takeEssentialBelow } from "@/lib/studio-route";
import { STRIPE_LIST_VERSION, hasOwnField, ownField, plainObject, readStripePage } from "@/lib/stripe-list";

/** One page of the most recent invoices: two years of a monthly plan. */
export const PLAN_INVOICES_SHOWN = 24;
/** A read is taken only while fewer than this many of ESSENTIAL_PER_DAY were taken: at most half, so leaving or paying always keeps the rest. */
export const PLAN_INVOICES_PER_DAY = 5;
/** The essential figure, said as what it is for (ESSENTIAL_NEEDS: billing, delete, export, member). */
export const ESSENTIAL_WORDS = `the ${ESSENTIAL_PER_DAY} requests your store has in 24 hours for its plan, deleting it, downloading its data and team changes`;
/** What a refusal says: the counter runs 24 hours from its first request, not from midnight. */
export const PLAN_INVOICES_USED = `Your invoices are read only while fewer than ${PLAN_INVOICES_PER_DAY} of ${ESSENTIAL_WORDS} have been used, so the rest always stays for changing or canceling your plan. ${PLAN_INVOICES_PER_DAY} or more have been used, so they were not read. Nothing was changed. Try again tomorrow.`;

const INVOICE_ID = /^in_[A-Za-z0-9]{3,250}$/;
/** Stripe's hosted invoice page and its PDF, at Stripe's own hosts over https only. */
const INVOICE_PAGE = /^https:\/\/invoice\.stripe\.com\/[^\s"'<>]+$/;
const INVOICE_PDF = /^https:\/\/pay\.stripe\.com\/invoice\/[^\s"'<>]+$/;
const SHOWN_STATUSES = ["open", "paid", "uncollectible", "void"] as const;

export type PlanInvoice = {
  id: string;
  /** Stripe's invoice number; null only if Stripe gave none. */
  number: string | null;
  /** When Stripe made it, in seconds. */
  created: number;
  status: (typeof SHOWN_STATUSES)[number];
  /** The invoice's total, before any credit on the customer's balance (Stripe's `total`): negative for a credit to that balance. */
  totalCents: number;
  /** What was paid on it (`amount_paid`): a balance credit Stripe applied is not in it. */
  paidCents: number;
  /** What is still owed on it (`amount_remaining`). */
  remainingCents: number;
  currency: string;
  /** Stripe's hosted page for it, or null when Stripe gave none at its own https host. */
  page: string | null;
  /** Stripe's PDF of it, or null the same way. */
  pdf: string | null;
};

export type PlanInvoices =
  /** No plan subscription: Stripe was not asked. */
  | { state: "none" }
  | { state: "listed"; invoices: PlanInvoice[]; more: boolean; unreadable: number; drafts: number }
  /** The day's requests for this are used: Stripe was not asked. */
  | { state: "used"; message: string }
  /** Stripe could not be asked, or answered in another shape. */
  | { state: "unknown" };

type Owner = { customer: string; subscription: string };

function subscriptionOf(row: Record<string, unknown>): unknown {
  const parent = ownField(row, "parent");
  if (!plainObject(parent)) return undefined;
  const details = ownField(parent, "subscription_details");
  return plainObject(details) ? ownField(details, "subscription") : undefined;
}

/** A whole number of cents that is not negative, as Stripe gives `amount_paid` and `amount_remaining`. */
function cents(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function link(value: unknown, pattern: RegExp): string | null {
  return typeof value === "string" && value.length <= 2048 && pattern.test(value) ? value : null;
}

/**
 * One page of Stripe's invoice list, read in its exact shape (it throws
 * StripeListUnreadable otherwise). A row counts only when it is this
 * customer's and this subscription's, with every field shown in a value
 * Stripe gives; drafts are not invoices yet and are left out. What was
 * paid and what is still owed are read with the total (#2990, Claude 2's
 * MEDIUM 1): a credit on the customer's balance comes off them, never off
 * `total`, so a row without them is not shown with a guessed amount.
 */
export function readPlanInvoicePage(page: unknown, owner: Owner): { invoices: PlanInvoice[]; more: boolean; unreadable: number; drafts: number } {
  const read = readStripePage(
    page,
    (row) => {
      const status = ownField(row, "status");
      const number = ownField(row, "number");
      const created = ownField(row, "created");
      const total = ownField(row, "total");
      const currency = ownField(row, "currency");
      return (
        ownField(row, "customer") === owner.customer &&
        subscriptionOf(row) === owner.subscription &&
        (status === "draft" || (SHOWN_STATUSES as readonly unknown[]).includes(status)) &&
        hasOwnField(row, "number") && (number === null || (typeof number === "string" && number.length > 0 && number.length <= 100)) &&
        typeof created === "number" && Number.isSafeInteger(created) && created > 0 &&
        typeof total === "number" && Number.isSafeInteger(total) &&
        cents(ownField(row, "amount_paid")) && cents(ownField(row, "amount_remaining")) &&
        typeof currency === "string" && /^[a-z]{3}$/.test(currency)
      );
    },
    INVOICE_ID,
  );
  const invoices = read.rows
    .filter((row) => ownField(row, "status") !== "draft")
    .map((row) => ({
      id: row.id,
      number: ownField(row, "number") as string | null,
      created: ownField(row, "created") as number,
      status: ownField(row, "status") as PlanInvoice["status"],
      totalCents: ownField(row, "total") as number,
      paidCents: ownField(row, "amount_paid") as number,
      remainingCents: ownField(row, "amount_remaining") as number,
      currency: ownField(row, "currency") as string,
      page: link(ownField(row, "hosted_invoice_url"), INVOICE_PAGE),
      pdf: link(ownField(row, "invoice_pdf"), INVOICE_PDF),
    }));
  return { invoices, more: read.hasMore, unreadable: read.unreadable, drafts: read.rows.length - invoices.length };
}

type Take = () => Promise<LimitState>;

/** One read of the plan's invoices: one essential request, only while fewer than PLAN_INVOICES_PER_DAY were taken. */
export function takeInvoicesRead(store: Pick<Store, "sid" | "handle">): Promise<LimitState> {
  return takeEssentialBelow(store, PLAN_INVOICES_PER_DAY);
}

/**
 * The store's plan invoices. `take` counts one essential request before
 * Stripe is asked (takeInvoicesRead, by default).
 */
export async function planInvoicesOf(
  store: Pick<Store, "stripeCustomerId" | "subscriptionId" | "sid" | "handle">,
  take: Take = () => takeInvoicesRead(store),
): Promise<PlanInvoices> {
  const customer = store.stripeCustomerId;
  const subscription = store.subscriptionId;
  if (!customer || !subscription || !CUSTOMER_PATTERN.test(customer) || !SUBSCRIPTION_PATTERN.test(subscription)) return { state: "none" };
  let taken: Awaited<ReturnType<Take>>;
  try {
    taken = await take();
  } catch (error) {
    console.error("counting the read of the plan's invoices failed", error);
    return { state: "unknown" };
  }
  if (taken === "exceeded") return { state: "used", message: PLAN_INVOICES_USED };
  if (taken !== "within") return { state: "unknown" };
  try {
    const query = new URLSearchParams({ customer, subscription, limit: String(PLAN_INVOICES_SHOWN) });
    const page = await onPlatformAt(STRIPE_LIST_VERSION, "GET", `/invoices?${query}`);
    const read = readPlanInvoicePage(page, { customer, subscription });
    // An empty page that says more follow is not an answer: never read as none, by any caller.
    if (read.more && read.invoices.length === 0 && read.unreadable === 0 && read.drafts === 0) return { state: "unknown" };
    return { state: "listed", ...read };
  } catch (error) {
    console.error("reading the plan's invoices failed", error);
    return { state: "unknown" };
  }
}
