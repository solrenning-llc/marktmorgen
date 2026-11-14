/**
 * Whether a store sold before is asked of its Stripe account (soldBefore):
 * a page whose `data` is not a list is not "never sold", found beside the
 * affiliate refund lists (claude5/affiliate-refund-list-exact, rule 30).
 *
 * It used to be read as no earlier sales: noteFirstSale wrote today as the
 * store's first sale and sent the one-time yearly offer to a store that had
 * sold for years. Now the page cannot be read, nothing is written or sent,
 * and the next pass asks again.
 */
import { claimHandle, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { firstSaleAt, noteFirstSale } from "@/lib/yearly-offer";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_yearly_sold_before_only";
process.env.RESEND_API_KEY = "re_test_yearly_sold_before_only";

const NOW = 1_791_700_000;
const emails: string[] = [];
let page: unknown = { object: "list", data: [], has_more: false };

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.stripe.com") {
    if (url.pathname === "/v1/checkout/sessions") return new Response(JSON.stringify(page), { status: 200 });
    if (url.pathname === "/v1/subscriptions/sub_soldbefore01") {
      return new Response(JSON.stringify({
        id: "sub_soldbefore01",
        status: "active",
        cancel_at_period_end: false,
        items: { data: [{ current_period_end: Math.floor(Date.now() / 1000) + 20 * 86_400, price: { lookup_key: "nimbus_labs_creator_month", unit_amount: 2900, recurring: { interval: "month" } } }] },
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { message: "no such" } }), { status: 404 });
  }
  if (url.hostname === "api.resend.com") {
    emails.push(String(JSON.parse(String(init?.body ?? "{}")).subject));
    return new Response(JSON.stringify({ id: "re_1" }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const sale = (handle: string) => ({ created: NOW - 60, amount_total: 1900, payment_status: "paid", metadata: { store: handle } });

async function main() {
  await claimHandle("soldbefore@example.com", "soldbefore", "A store", "");
  await setStripeAccount("soldbefore@example.com", "acct_TestSoldBf01");
  await setSubscription("soldbefore@example.com", { subscriptionId: "sub_soldbefore01", active: true, tier: "creator", cycle: "month" });
  const store = (await storeForEmail("soldbefore@example.com"))!;

  part("A page of earlier checkouts that cannot be read");
  for (const [what, body] of [
    ["data an object", { object: "list", data: { id: "cs_old" }, has_more: false }],
    ["data text", { object: "list", data: "cs_old", has_more: false }],
    ["data absent", { object: "list", has_more: false }],
  ] as const) {
    page = body;
    const noted = await noteFirstSale(store, [sale(store.handle)], true);
    // noted true is the offer being made (offerYearly); the email it sends is held in tests/yearly-offer.test.ts.
    is(`${what}: not a first sale, nothing written, no offer`, [noted, await firstSaleAt(store)], [false, 0]);
  }

  part("A page of earlier checkouts with no paid sale that does not say it is the last");
  // Rule 23: "a full page of free checkouts with more after it" left this list. soldBefore now follows the pages
  // (starting_after) up to SOLD_BEFORE_PAGES and, past them, notes this sale's day without an offer, so it is no
  // longer "nothing written"; tests/yearly-offer-sold-before-pages.test.ts holds that case and the pages before it.
  for (const [what, body] of [
    ["an empty page with has_more absent", { object: "list", data: [] }],
    ["an empty page with has_more as text", { object: "list", data: [], has_more: "false" }],
  ] as const) {
    page = body;
    is(`${what}: not known, not a first sale, nothing written`, [await noteFirstSale(store, [sale(store.handle)], true), await firstSaleAt(store)], [false, 0]);
  }

  part("Control: a page read whole, with no earlier sale");
  page = { object: "list", data: [], has_more: false };
  is("the first sale is noted", await noteFirstSale(store, [sale(store.handle)], true), true);
  is("with its own date", await firstSaleAt(store), NOW - 60);

  done();
}

void main();
