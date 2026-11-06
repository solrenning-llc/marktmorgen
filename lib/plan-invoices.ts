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
 * billing requests of the day instead (the counter countStudio keeps for
 * "billing"), each priced with a heavy request and two Stripe GETs in
 * tests/plan-cost-registry.ts; tests/plan-cost-registry.test.ts holds
 * PLAN_INVOICES_READ under it. A count that could not be read asks nothing
 * and says so, never "too many". A store with no plan subscription asks
 * Stripe nothing and takes nothing.
 *
 * Unknown is never none (lib/stripe-list.ts): an answer Stripe could not
 * give, or gave in another shape, is "unknown"; rows that are not readable
 * are counted and keep the page from saying there are no invoices.
 */
import { onPlatformAt } from "@/lib/billing";
import { CUSTOMER_PATTERN, SUBSCRIPTION_PATTERN, type Store } from "@/lib/store";
import { essentialLimitState } from "@/lib/request-guard";
import { ESSENTIAL_PER_DAY } from "@/lib/studio-allowance-rules";
import { STRIPE_LIST_VERSION, hasOwnField, ownField, plainObject, readStripePage } from "@/lib/stripe-list";

/** One page of the most recent invoices: two years of a monthly plan. */
export const PLAN_INVOICES_SHOWN = 24;
/** What a refusal past the day's billing requests says. */
export const PLAN_INVOICES_USED = `Your store has used its ${ESSENTIAL_PER_DAY} billing requests for today, so your invoices are not read again until tomorrow (UTC). Nothing was changed.`;

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
  totalCents: number;
  currency: string;
  /** Stripe's hosted page for it, or null when Stripe gave none at its own https host. */
  page: string | null;
  /** Stripe's PDF of it, or null the same way. */
  pdf: string | null;
};

export type PlanInvoices =
  /** No plan subscription: Stripe was not asked. */
  | { state: "none" }
  | { state: "listed"; invoices: PlanInvoice[]; more: boolean; unreadable: number }
  /** The studio's requests are used: Stripe was not asked. */
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

function link(value: unknown, pattern: RegExp): string | null {
  return typeof value === "string" && value.length <= 2048 && pattern.test(value) ? value : null;
}

/**
 * One page of Stripe's invoice list, read in its exact shape (it throws
 * StripeListUnreadable otherwise). A row counts only when it is this
 * customer's and this subscription's, with every field shown in a value
 * Stripe gives; drafts are not invoices yet and are left out.
 */
export function readPlanInvoicePage(page: unknown, owner: Owner): { invoices: PlanInvoice[]; more: boolean; unreadable: number } {
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
      currency: ownField(row, "currency") as string,
      page: link(ownField(row, "hosted_invoice_url"), INVOICE_PAGE),
      pdf: link(ownField(row, "invoice_pdf"), INVOICE_PDF),
    }));
  return { invoices, more: read.hasMore, unreadable: read.unreadable };
}

type Take = () => Promise<"within" | "exceeded" | "unknown">;

/** One of the store's billing requests of the day: the very counter countStudio(store, "billing") takes (lib/studio-route.ts). */
export function takeBillingRequest(store: Pick<Store, "sid" | "handle">): Promise<"within" | "exceeded" | "unknown"> {
  return essentialLimitState("studio-essential", store.sid || store.handle, ESSENTIAL_PER_DAY, 86_400);
}

/**
 * The store's plan invoices. `take` counts one billing request of the day
 * before Stripe is asked (takeBillingRequest, by default).
 */
export async function planInvoicesOf(
  store: Pick<Store, "stripeCustomerId" | "subscriptionId" | "sid" | "handle">,
  take: Take = () => takeBillingRequest(store),
): Promise<PlanInvoices> {
  const customer = store.stripeCustomerId;
  const subscription = store.subscriptionId;
  if (!customer || !subscription || !CUSTOMER_PATTERN.test(customer) || !SUBSCRIPTION_PATTERN.test(subscription)) return { state: "none" };
  let taken: Awaited<ReturnType<Take>>;
  try {
    taken = await take();
  } catch (error) {
    console.error("counting the billing request for the plan's invoices failed", error);
    return { state: "unknown" };
  }
  if (taken === "exceeded") return { state: "used", message: PLAN_INVOICES_USED };
  if (taken !== "within") return { state: "unknown" };
  try {
    const query = new URLSearchParams({ customer, subscription, limit: String(PLAN_INVOICES_SHOWN) });
    const page = await onPlatformAt(STRIPE_LIST_VERSION, "GET", `/invoices?${query}`);
    return { state: "listed", ...readPlanInvoicePage(page, { customer, subscription }) };
  } catch (error) {
    console.error("reading the plan's invoices failed", error);
    return { state: "unknown" };
  }
}
