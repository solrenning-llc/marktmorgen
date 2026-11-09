/**
 * Gifts and pre-orders read every page of the creator's refunds since their
 * anchor (CX-123 rule 24; r24 money inventory, item 1).
 *
 * revokeRefundedGifts (lib/gifts.ts) and revokeRefundedPreorders
 * (lib/preorders.ts) asked Stripe for one page of refunds (limit 100) and
 * never for the next. Stripe lists the newest first, so with more than 100
 * refunds since the anchor the older ones were never read, the read still
 * counted as whole, and the anchor moved past them: a gift or a pre-order
 * whose payment was refunded in full kept its access. Checked against a
 * stand-in for the creator's Stripe account that pages as Stripe does,
 * through the real gift and pre-order journeys:
 *
 *   - a refund on the second page is read and takes back what it paid for,
 *     and the anchor moves once the list was read to its end;
 *   - past the per-run bound of pages, the read is unsure: the anchor stays,
 *     and no more than the bound is asked of Stripe in a run;
 *   - a later page in another shape, or a page without has_more, is unknown,
 *     never "no more refunds": the anchor stays, and a refund read on a
 *     readable page is still taken back.
 */
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail, type Listing, type Store } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { deliverGift, revokeRefundedGifts, startGift } from "@/lib/gifts";
import { importedFor } from "@/lib/imported-purchases";
import { confirmPreorder, revokeRefundedPreorders } from "@/lib/preorders";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const NOW = Math.floor(Date.now() / 1000);
/** The pages of refunds one run may read per store, in each of the two jobs (GIFT_ and PREORDER_REFUND_PAGES_PER_STORE). */
const BOUND = 3;

/** The store's refunds, newest first, as Stripe lists them. */
let refunds: Record<string, unknown>[] = [];
/** A page (0-based) answered in another shape; -1 for none. */
let brokenPage = -1;
/** Answer pages without has_more. */
let noHasMore = false;
const refundCalls: URLSearchParams[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") return new Response(JSON.stringify({ id: "email_1" }));
  const path = url.pathname.replace(/^\/v1/, "");
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (path === "/refunds") {
    refundCalls.push(url.searchParams);
    const limit = Number(url.searchParams.get("limit") ?? "10");
    const after = url.searchParams.get("starting_after");
    const from = after ? refunds.findIndex((row) => row.id === after) + 1 : 0;
    const pageIndex = Math.floor(from / limit);
    if (pageIndex === brokenPage) return answer({ object: "list", data: null, has_more: false });
    const data = refunds.slice(from, from + limit);
    return answer(noHasMore ? { object: "list", data } : { object: "list", data, has_more: from + limit < refunds.length });
  }
  if (path === "/events") return answer({ object: "list", data: [], has_more: false });
  if (path.startsWith("/payment_intents/")) return answer({ id: path.split("/")[2], object: "payment_intent", latest_charge: { object: "charge", refunded: false, amount: 2500, amount_refunded: 0 } });
  return answer({ error: { message: `no stand-in for ${init?.method ?? "GET"} ${path}` } }, 404);
}) as typeof fetch;

/** `count` full refunds, newest first, created from `newest` down; the one at `at` paid with `pi`, the rest unrelated. */
function list(tag: string, count: number, newest: number, at: number, pi: string): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `re_${tag}${String(i).padStart(6, "0")}`,
    object: "refund",
    created: newest - i,
    status: "succeeded",
    // Rule 23 (decision 18, lib/refunds.ts refundRowState): the refund and its charge carry their amounts, as Stripe
    // sends them, so a refund of the whole charge reads as given back by itself.
    amount: 2500,
    payment_intent: i === at ? pi : `pi_${tag}other${String(i).padStart(6, "0")}`,
    charge: { object: "charge", refunded: true, amount: 2500 },
  }));
}

type Job = {
  name: string;
  anchor: string;
  run: () => Promise<number>;
  /** Makes one paid item (a gift given, or a pre-order handed over) and returns its payment and whether it is still held. */
  make: (n: number) => Promise<{ pi: string; holds: () => Promise<boolean> }>;
};

async function check(job: Job, base: number): Promise<void> {
  const anchorNow = async () => (await redis.pipeline([["GET", job.anchor]]))[0];

  part(`${job.name}: a full refund on the second page is read and taken back`);
  const second = await job.make(1);
  refunds = list(`${job.name}a`, 150, base, 149, second.pi);
  refundCalls.length = 0;
  is(`${job.name}: the refund past the first 100 takes it back`, await job.run(), 1);
  is(`${job.name}: no longer held`, await second.holds(), false);
  is(`${job.name}: the second page was asked from the first's last row`, refundCalls.map((q) => q.get("starting_after")), [null, `re_${job.name}a000099`]);
  is(`${job.name}: read to its end, the anchor moves to the newest refund`, await anchorNow(), String(base));

  part(`${job.name}: past the per-run bound, the read is unsure and the anchor stays`);
  const far = await job.make(2);
  const before = await anchorNow();
  refunds = list(`${job.name}b`, 100 * BOUND + 50, base + 600, 100 * BOUND + 49, far.pi);
  refundCalls.length = 0;
  is(`${job.name}: nothing past the bound is taken back in this run`, await job.run(), 0);
  is(`${job.name}: at most ${BOUND} pages asked of Stripe in a run`, refundCalls.length, BOUND);
  is(`${job.name}: pages remain, so the anchor does not move past them`, await anchorNow(), before);
  is(`${job.name}: still held, read again on a later run`, await far.holds(), true);

  part(`${job.name}: a later page in another shape is unknown, never "no more refunds"`);
  const near = await job.make(3);
  refunds = list(`${job.name}c`, 120, base + 1200, 5, near.pi);
  brokenPage = 1;
  refundCalls.length = 0;
  is(`${job.name}: the refund on the readable first page is still taken back`, await job.run(), 1);
  is(`${job.name}: the second page was asked`, refundCalls.length, 2);
  is(`${job.name}: the anchor stays before the page that could not be read`, await anchorNow(), before);
  brokenPage = -1;

  part(`${job.name}: a page without has_more is unknown`);
  refunds = list(`${job.name}d`, 5, base + 1800, -1, "pi_unused");
  noHasMore = true;
  await job.run();
  is(`${job.name}: the anchor stays when Stripe does not say whether more pages follow`, await anchorNow(), before);
  noHasMore = false;

  part(`${job.name}: control, the same list in Stripe's shape`);
  await job.run();
  is(`${job.name}: read to its end, the anchor moves`, await anchorNow(), String(base + 1800));
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_paged_refunds_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_paged_refunds_only";

  await claimHandle("owner@paged.example", "pagedshop", "Paged Shop", "");
  await ensureStatsId("owner@paged.example");
  await setStripeAccount("owner@paged.example", "acct_1TestPagedRef01", true);
  await setSubscription("owner@paged.example", { customerId: "cus_PagedOwner01", subscriptionId: "sub_PagedOwner01", active: true, period: paidPeriod() });
  const made = await addProduct("owner@paged.example", "Bread Course", "", "25", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink("owner@paged.example", made.product.id, "https://example.com/course");
  const store = (await storeForEmail("owner@paged.example"))!;
  const product = (await readListing(store, made.product.id))!;
  const deps = {
    base: "https://marktmorgen.com/@pagedshop",
    from: '"Paged Shop" <hello@marktmorgen.com>',
    ordersLink: async (email: string) => `https://marktmorgen.com/@pagedshop/orders?for=${encodeURIComponent(email)}`,
    recordStart: async () => {},
  };
  const holds = async (email: string) => (await importedFor((await storeForEmail("owner@paged.example")) as Store, email)).length > 0;

  await check({
    name: "gift",
    anchor: `nl:gift:${store.statsId}:refunds`,
    run: () => revokeRefundedGifts(store, Date.now() + 60_000, async () => {}),
    make: async (n) => {
      const to = `friend${n}@paged.example`;
      const started = await startGift(store, product as Listing, { to, from: "Ana", message: "" });
      if (!started.ok) throw new Error("no gift");
      const pi = `pi_pagedgift${String(n).padStart(8, "0")}`;
      const given = await deliverGift({
        store,
        session: { id: `cs_test_pagedgift${String(n).padStart(8, "0")}`, created: NOW - 600, amount_total: 2500, currency: "usd", payment_intent: pi, metadata: { store: "pagedshop", product: product.id, gift: started.gift.id }, customer_details: { email: "buyer@paged.example" } } as never,
        product: product as Listing,
        base: deps.base,
        from: deps.from,
        recordStart: async () => {},
        ordersLink: async () => null,
      });
      if (given !== "given") throw new Error(`gift ${n} not given: ${given}`);
      return { pi, holds: () => holds(to) };
    },
  }, NOW - 10_000);

  await check({
    name: "pre",
    anchor: `nl:pre:${store.statsId}:refunds`,
    run: () => revokeRefundedPreorders(store, Date.now() + 60_000, async () => {}),
    make: async (n) => {
      const email = `buyer${n}@paged.example`;
      const pi = `pi_pagedpre${String(n).padStart(8, "0")}`;
      const session = {
        id: `cs_test_pagedpre${String(n).padStart(8, "0")}`,
        created: NOW - 600,
        status: "complete",
        payment_status: "paid",
        amount_total: 2500,
        currency: "usd",
        payment_intent: pi,
        metadata: { store: "pagedshop", product: product.id, preorder: "yes" },
        customer_details: { email },
      };
      const given = await confirmPreorder(store, session as never, product, deps);
      if (given !== "given") throw new Error(`pre-order ${n} not given: ${given}`);
      return { pi, holds: () => holds(email) };
    },
  }, NOW - 5_000);

  done();
}

void main();
