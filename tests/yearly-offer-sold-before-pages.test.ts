/**
 * Whether a store sold before is asked page by page, up to a ceiling
 * (soldBefore; second money pre-review of claude5/affiliate-refund-list-exact).
 *
 * soldBefore read one page of a store's earlier checkouts. A store with 100
 * or more completed checkouts with no paid sale among them (free lead
 * magnets, say) and more after them was "not known" on every pass: the
 * five-minute sweep asked Stripe again on every pass, for good, and the
 * yearly offer never went out. Now the pages are followed with
 * starting_after up to SOLD_BEFORE_PAGES; past that ceiling the first sale
 * is noted as this sale's day, no offer is made (whether the store sold
 * before is not known, and an offer on a store that has sold for years would
 * be wrong), and later passes stop at the note without asking Stripe.
 */
import { claimHandle, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { firstSaleAt, noteFirstSale } from "@/lib/yearly-offer";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_yearly_sold_before_pages";
process.env.RESEND_API_KEY = "re_test_yearly_sold_before_pages";

const NOW = 1_791_700_000;
/** The ceiling of pages soldBefore follows (SOLD_BEFORE_PAGES in lib/yearly-offer.ts). */
const SOLD_BEFORE_PAGES = 5;
const emails: string[] = [];
/** Every checkout-list request: [account, starting_after]. */
let asked: [string, string][] = [];
/** The pages each account gives, in order; a page's `after` is the starting_after it answers. */
let pages = new Map<string, { after: string; body: unknown }[]>();

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.stripe.com") {
    const account = String((init?.headers as Record<string, string> | undefined)?.["Stripe-Account"] ?? "");
    if (url.pathname === "/v1/checkout/sessions") {
      const after = url.searchParams.get("starting_after") ?? "";
      asked.push([account, after]);
      const page = (pages.get(account) ?? []).find((p) => p.after === after);
      if (!page) return new Response(JSON.stringify({ error: { message: "no such page" } }), { status: 400 });
      return new Response(JSON.stringify(page.body), { status: 200 });
    }
    const sub = /^\/v1\/subscriptions\/(sub_\w+)$/.exec(url.pathname)?.[1];
    if (sub) {
      return new Response(JSON.stringify({
        id: sub,
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
/** A full page of free checkouts (no payment required), named so each page's last id is known. */
const free = (handle: string, page: number) =>
  Array.from({ length: 100 }, (_, n) => ({ id: `cs_free_${page}_${n}`, created: NOW - 600 - page * 1000 - n, amount_total: 0, payment_status: "no_payment_required", metadata: { store: handle } }));
const lastOf = (_handle: string, page: number) => `cs_free_${page}_99`;

let made = 0;
async function shop(): Promise<{ store: NonNullable<Awaited<ReturnType<typeof storeForEmail>>>; account: string }> {
  made += 1;
  const n = String(made).padStart(2, "0");
  const email = `pages${n}@example.com`;
  const account = `acct_1TestSoldPages${n}`;
  await claimHandle(email, `pages${n}`, "A store", "");
  await setStripeAccount(email, account);
  await setSubscription(email, { subscriptionId: `sub_soldpages${n}`, active: true, tier: "creator", cycle: "month" });
  return { store: (await storeForEmail(email))!, account };
}

/** `count` full free pages, each saying there is more, the one after `after` the next. */
function freePages(handle: string, count: number, end?: unknown): { after: string; body: unknown }[] {
  const out: { after: string; body: unknown }[] = Array.from({ length: count }, (_, page) => ({ after: page === 0 ? "" : lastOf(handle, page - 1), body: { object: "list", data: free(handle, page), has_more: true } }));
  if (end !== undefined) out.push({ after: lastOf(handle, count - 1), body: end });
  return out;
}

async function main() {
  part("Every page free, more than the ceiling: asked up to the ceiling once, noted, no offer, never asked again");
  {
    const { store, account } = await shop();
    pages.set(account, freePages(store.handle, SOLD_BEFORE_PAGES + 3));
    asked = [];
    const sent = emails.length;
    const first = await noteFirstSale(store, [sale(store.handle)], true);
    is("pages asked on the first pass, each after the last one read", asked.map(([, after]) => after), Array.from({ length: SOLD_BEFORE_PAGES }, (_, p) => (p === 0 ? "" : lastOf(store.handle, p - 1))));
    is("no offer made", [first, emails.length - sent], [false, 0]);
    is("the first sale noted as this sale's day, so the next pass stops at it", await firstSaleAt(store), NOW - 60);
    asked = [];
    for (let pass = 0; pass < 288; pass += 1) await noteFirstSale(store, [sale(store.handle)], true);
    is("a day of passes after it: no Stripe call, no offer", [asked.length, emails.length - sent], [0, 0]);
  }

  part("A paid sale on a later page: an earlier sale, noted with its day, no offer");
  {
    const { store, account } = await shop();
    const earlier = { id: "cs_paid_1", created: NOW - 50_000, amount_total: 1900, payment_status: "paid", metadata: { store: store.handle } };
    pages.set(account, freePages(store.handle, 2, { object: "list", data: [...free(store.handle, 2).slice(0, 10), earlier], has_more: true }));
    asked = [];
    const sent = emails.length;
    is("not a first sale", await noteFirstSale(store, [sale(store.handle)], true), false);
    is("three pages asked", asked.length, 3);
    is("the earlier sale's day noted", await firstSaleAt(store), NOW - 50_000);
    is("no email", emails.length - sent, 0);
  }

  part("Free pages that end within the ceiling: never sold before, the offer is made");
  {
    const { store, account } = await shop();
    pages.set(account, freePages(store.handle, 2, { object: "list", data: [], has_more: false }));
    asked = [];
    is("a first sale, the offer made", await noteFirstSale(store, [sale(store.handle)], true), true);
    is("three pages asked", asked.length, 3);
    is("with its own day", await firstSaleAt(store), NOW - 60);
  }

  part("A later page that cannot be read is not known: nothing noted, the next pass asks again");
  {
    const { store, account } = await shop();
    for (const [what, end] of [
      ["data not a list", { object: "list", data: { id: "cs_x" }, has_more: false }],
      ["has_more absent", { object: "list", data: [] }],
      ["more with a last row without an id", { object: "list", data: [{ created: NOW - 9_000, payment_status: "no_payment_required", metadata: { store: store.handle } }], has_more: true }],
    ] as const) {
      pages.set(account, freePages(store.handle, 1, end));
      asked = [];
      is(`${what}: not a first sale, nothing noted`, [await noteFirstSale(store, [sale(store.handle)], true), await firstSaleAt(store)], [false, 0]);
      is(`${what}: stopped at that page`, asked.length, 2);
    }
    pages.set(account, freePages(store.handle, 1));
    pages.get(account)!.push({ after: lastOf(store.handle, 0), body: { object: "list", data: [], has_more: false } });
    is("asked again later and read whole: the offer is made", await noteFirstSale(store, [sale(store.handle)], true), true);
  }

  done();
}

void main();
