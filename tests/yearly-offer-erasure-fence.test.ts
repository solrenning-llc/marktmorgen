/**
 * Codex L-20261120-1745 (MEDIUM, erasure and a personal address; #5010 row 28). noteFirstSale (lib/yearly-offer.ts)
 * gets a Store, checks its two marks, then reads the store's Stripe account for earlier sales, page by page. When the
 * store's erasure began while those pages were read:
 * - past the ceiling of pages, nl:soldbefore:<store> (the store's own data, erased with it) was written back;
 * - with no earlier sale, the yearly offer was claimed and emailed to the address that Store held.
 * Both marks are now taken through claimWhileStoreLive (lib/store-live-cache.ts): only while the store is still its
 * own and not erasing, in one step, so neither comes back and nothing is sent. Synthetic store and Stripe only.
 */
import { ERASING_KEY, claimHandle, ensureStatsId, ensureStoreId, erasingField, setStripeAccount, setSubscription, storeForEmail, storeRef } from "@/lib/store";
import { noteFirstSale } from "@/lib/yearly-offer";
import { redisPipeline } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_yearly_offer_only";
// The existing allowlisted synthetic credentials of tests/yearly-offer.test.ts; never a live account.
process.env.RESEND_API_KEY = "re_test_yearly_offer_only";

const NOW = 1_791_700_000;
/** The ceiling of pages soldBefore follows (SOLD_BEFORE_PAGES in lib/yearly-offer.ts). */
const SOLD_BEFORE_PAGES = 5;
const emails: string[] = [];
const pages = new Map<string, { after: string; body: unknown }[]>();
/** Run once, on the first page of checkouts read: the store's erasure begins while Stripe answers. */
let duringRead: (() => Promise<void>) | null = null;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.stripe.com") {
    const account = String((init?.headers as Record<string, string> | undefined)?.["Stripe-Account"] ?? "");
    if (url.pathname === "/v1/checkout/sessions") {
      const hook = duringRead;
      duringRead = null;
      if (hook) await hook();
      const after = url.searchParams.get("starting_after") ?? "";
      const page = (pages.get(account) ?? []).find((p) => p.after === after);
      if (!page) return new Response(JSON.stringify({ error: { message: "no such page" } }), { status: 400 });
      return new Response(JSON.stringify(page.body), { status: 200 });
    }
    const sub = /^\/v1\/subscriptions\/(sub_\w+)$/.exec(url.pathname)?.[1];
    if (sub) {
      return new Response(JSON.stringify({
        id: sub,
        status: "active",
        cancel_at: null,
        cancel_at_period_end: false,
        items: { data: [{ current_period_end: NOW + 20 * 86_400, price: { lookup_key: "nimbus_labs_creator_month", unit_amount: 2900, recurring: { interval: "month" } } }] },
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { message: "no such" } }), { status: 404 });
  }
  if (url.hostname === "api.resend.com") {
    emails.push(String(JSON.parse(String(init?.body ?? "{}")).to));
    return new Response(JSON.stringify({ id: "re_1" }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const sale = (handle: string) => ({ created: NOW - 60, amount_total: 1900, payment_status: "paid", metadata: { store: handle } });
const free = (handle: string, page: number) =>
  Array.from({ length: 100 }, (_, n) => ({ id: `cs_free_${page}_${n}`, created: NOW - 600 - page * 1000 - n, amount_total: 0, payment_status: "no_payment_required", metadata: { store: handle } }));
function freePages(handle: string, count: number, end?: unknown): { after: string; body: unknown }[] {
  const out: { after: string; body: unknown }[] = Array.from({ length: count }, (_, page) => ({ after: page === 0 ? "" : `cs_free_${page - 1}_99`, body: { object: "list", data: free(handle, page), has_more: true } }));
  if (end !== undefined) out.push({ after: `cs_free_${count - 1}_99`, body: end });
  return out;
}

let made = 0;
async function shop() {
  made += 1;
  const n = String(made).padStart(2, "0");
  const email = `yearlyfence${n}@example.com`;
  const account = `acct_1TestYearFnce${n}`;
  await claimHandle(email, `yearlyfence${n}`, "A store", "");
  await ensureStoreId(email);
  await ensureStatsId(email);
  await setStripeAccount(email, account);
  await setSubscription(email, { subscriptionId: `sub_yearlyfence${n}`, active: true, tier: "creator", cycle: "month" });
  return { store: (await storeForEmail(email))!, account, email };
}

const exists = async (key: string) => Number((await redisPipeline([["EXISTS", key]]))[0]);
/** What closeStoreRecord writes first: the store's erasing mark. */
const beginErasure = (ref: string) => async () => {
  await redisPipeline([["HSET", ERASING_KEY, await erasingField(ref), String(NOW)]]);
};

async function main() {
  part("Past the ceiling of pages, the store's erasure begins while Stripe is read");
  {
    const { store, account } = await shop();
    pages.set(account, freePages(store.handle, SOLD_BEFORE_PAGES + 1));
    duringRead = beginErasure(storeRef(store));
    await noteFirstSale(store, [sale(store.handle)], true);
    is("nl:soldbefore (the store's own data) is not written back", await exists(`nl:soldbefore:${store.sid}`), 0);
  }

  part("No earlier sale, and the store's erasure begins while Stripe is read");
  {
    const { store, account, email } = await shop();
    pages.set(account, [{ after: "", body: { object: "list", data: [], has_more: false } }]);
    duringRead = beginErasure(storeRef(store));
    const sent = emails.length;
    await noteFirstSale(store, [sale(store.handle)], true);
    is("no yearly offer is emailed to the address that Store held", emails.slice(sent).includes(email), false);
    is("and the once-per-subscription mark is not taken", await exists(`nl:yearly-offer:${store.subscriptionId}`), 0);
  }

  part("A live store still gets its first sale noted and the offer, once (control)");
  {
    const { store, account, email } = await shop();
    pages.set(account, [{ after: "", body: { object: "list", data: [], has_more: false } }]);
    const sent = emails.length;
    await noteFirstSale(store, [sale(store.handle)], true);
    is("one offer to the store's address", emails.slice(sent).filter((to) => to === email).length, 1);
    is("the offer's mark is kept for good", Number((await redisPipeline([["TTL", `nl:yearly-offer:${store.subscriptionId}`]]))[0]), -1);
    await noteFirstSale(store, [sale(store.handle)], true);
    is("a later pass sends nothing more", emails.slice(sent).filter((to) => to === email).length, 1);
  }

  part("Past the ceiling on a live store: the stop mark is kept for good (control)");
  {
    const { store, account } = await shop();
    pages.set(account, freePages(store.handle, SOLD_BEFORE_PAGES + 1));
    await noteFirstSale(store, [sale(store.handle)], true);
    is("nl:soldbefore written, with no expiry", [await exists(`nl:soldbefore:${store.sid}`), Number((await redisPipeline([["TTL", `nl:soldbefore:${store.sid}`]]))[0])], [1, -1]);
  }

  done();
}

void main();
