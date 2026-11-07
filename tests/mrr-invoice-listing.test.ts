/**
 * Recurring revenue's movements (lib/membership-numbers.ts) are drawn only
 * from a whole list of the last thirteen months' invoices (CX-123 rule 24;
 * Claude 5's review of #3048, MEDIUM 3).
 *
 * Stripe lists invoices newest first, 100 a page. A list still saying "more"
 * after the last page read, or a page whose data is not a list, is a reading
 * not finished: the oldest invoices would be missing, and a member would seem
 * new, or never to have changed price. The movements are then left out, as
 * when the invoices cannot be read at all, never drawn from a part.
 *
 * A stand-in for Stripe and synthetic data only; no request leaves.
 */
import { membershipNumbers } from "@/lib/membership-numbers";
import { claimHandle, ensureStatsId, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_mrr_listing_stand_in";
const NOW = Date.parse("2026-10-13T12:00:00Z");
const S = Math.floor(NOW / 1000);
const DAY = 86_400;

type Mode = "whole" | "endless" | "not-a-list" | "page-not-a-list";
let mode: Mode = "whole";
type Subs = "whole" | "not-a-list" | "more-as-text" | "more-without-last";
let subsMode: Subs = "whole";
let invoicePages = 0;
const sub = {
  id: "sub_listing1", object: "subscription", status: "active", currency: "usd", start_date: S - 120 * DAY, customer: "cus_listing1",
  metadata: { store: "mrrlist", product: "p1" },
  items: { data: [{ quantity: 1, price: { unit_amount: 3000, recurring: { interval: "month", interval_count: 1 } } }] },
};
const invoice = (n: number) => ({
  id: `in_listing${String(n).padStart(6, "0")}`, created: S - (n + 1) * DAY,
  lines: { data: [{ subscription: "sub_listing1", amount: 3000, quantity: 1, period: { start: S - (n + 1) * DAY }, price: { unit_amount: 3000, recurring: { interval: "month", interval_count: 1 } } }] },
});
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  if (url.pathname.endsWith("/subscriptions")) {
    if (subsMode === "not-a-list") return json({ data: "sub_listing1", has_more: false });
    if (subsMode === "more-as-text") return json({ data: [sub], has_more: "true" });
    if (subsMode === "more-without-last") return json({ data: [], has_more: true });
    return json({ data: [sub], has_more: false });
  }
  if (url.pathname.endsWith("/invoices")) {
    invoicePages += 1;
    if (mode === "whole") return json({ data: [invoice(1), invoice(30)], has_more: false });
    if (mode === "not-a-list") return json({ data: "in_listing000001", has_more: false });
    if (mode === "page-not-a-list" && invoicePages === 2) return json({ data: { id: "in_x" }, has_more: false });
    return json({ data: [invoice(invoicePages)], has_more: true });
  }
  return json({ data: [], has_more: false });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  const owner = "mrr-listing-owner@example.com";
  await claimHandle(owner, "mrrlist", "Listing", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_TestMrrList1", true);
  const store = (await storeForEmail(owner))!;

  const read = async (m: Mode) => {
    mode = m;
    invoicePages = 0;
    const numbers = await membershipNumbers(store, true, NOW);
    return { movements: numbers?.movements !== undefined, pages: invoicePages, members: numbers === null ? null : "read" };
  };

  part("Control: a whole list of invoices");
  const whole = await read("whole");
  is("the movements are drawn from it", [whole.movements, whole.pages], [true, 1]);

  part("A list still saying more after the last page read");
  const endless = await read("endless");
  is("the movements are left out, never drawn from the newest part", endless.movements, false);
  is("the members themselves are still read", endless.members, "read");
  is("no more pages than the ceiling are asked for", endless.pages, 20);

  part("A page whose data is not a list");
  is("the first page: movements left out, never 'no invoices'", (await read("not-a-list")).movements, false);
  is("a later page: movements left out, never the pages before it alone", (await read("page-not-a-list")).movements, false);

  // The members' own list read the same way (Claude 5's focal return on #3048): a page in an unknown shape is
  // a reading not made, never "no members" with nothing recurring.
  part("The memberships' list in an unknown shape");
  const members = async (m: Subs) => {
    subsMode = m;
    mode = "whole";
    try {
      const numbers = await membershipNumbers(store, true, NOW);
      return numbers === null ? "none" : numbers.mrr;
    } catch {
      return "unread";
    } finally {
      subsMode = "whole";
    }
  };
  is("control: the member is counted", await members("whole"), 3000);
  is("data that is not a list: unread, never no members", await members("not-a-list"), "unread");
  is("more said in text: unread, never the end of the list", await members("more-as-text"), "unread");
  is("more said with no last membership to go on from: unread, never the end of the list", await members("more-without-last"), "unread");
  done();
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
