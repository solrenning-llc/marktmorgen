/**
 * A refund that is not final yet never lets gifts and pre-orders pass it by
 * (review of #3188, Claude 3: MEDIUM, inherited).
 *
 * revokeRefundedGifts (lib/gifts.ts) and revokeRefundedPreorders
 * (lib/preorders.ts) took a refund row back only when it read `succeeded`
 * with its charge marked refunded, and moved the anchor past every row read.
 * A full refund Stripe still listed as `pending` was skipped, and once any
 * later refund moved the anchor more than 300 s past it, it was never listed
 * again: the gift recipient or the pre-order buyer kept what the money paid
 * for. Checked against a stand-in for the creator's Stripe account that
 * honours created[gte], through the real gift and pre-order journeys:
 *
 *   - a full refund listed as pending is taken back at once, as the shared
 *     rule rowGivesBack() (lib/refunds.ts) reads it for the other jobs;
 *   - a refund still pending or requiring action whose charge is not yet
 *     refunded in full holds the anchor at its time, so a later refund never
 *     moves the read past it, and it is taken back once it went through;
 *   - controls: a refund that failed or was canceled holds nothing, and a
 *     partial refund that went through takes nothing back.
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

/** The store's refunds, newest first, as Stripe lists them. */
let refunds: Record<string, unknown>[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") return new Response(JSON.stringify({ id: "email_1" }));
  const path = url.pathname.replace(/^\/v1/, "");
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (path === "/refunds") {
    const limit = Number(url.searchParams.get("limit") ?? "10");
    const after = url.searchParams.get("starting_after");
    const since = Number(url.searchParams.get("created[gte]") ?? "0");
    const listed = refunds.filter((row) => typeof row.created === "number" && row.created >= since);
    const from = after ? listed.findIndex((row) => row.id === after) + 1 : 0;
    return answer({ object: "list", data: listed.slice(from, from + limit), has_more: from + limit < listed.length });
  }
  if (path === "/events") return answer({ object: "list", data: [], has_more: false });
  if (path.startsWith("/payment_intents/")) return answer({ id: path.split("/")[2], object: "payment_intent", latest_charge: { object: "charge", refunded: false, amount: 2500, amount_refunded: 0 } });
  return answer({ error: { message: `no stand-in for ${init?.method ?? "GET"} ${path}` } }, 404);
}) as typeof fetch;

/** One refund row, as /refunds lists it with its charge expanded. */
function row(id: string, created: number, status: string, pi: string, refunded: boolean, back = refunded ? 2500 : 0): Record<string, unknown> {
  return { id, object: "refund", created, status, payment_intent: pi, charge: { object: "charge", refunded, amount: 2500, amount_refunded: back } };
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
  const n = job.name;

  part(`${n}: a full refund listed as pending is taken back at once`);
  const pending = await job.make(1);
  refunds = [row(`re_${n}pend000001`, base, "pending", pending.pi, true)];
  is(`${n}: the pending full refund takes it back`, await job.run(), 1);
  is(`${n}: no longer held`, await pending.holds(), false);

  for (const [k, status] of [[2, "pending"], [3, "requires_action"]] as const) {
    part(`${n}: a refund ${status} whose charge is not refunded yet holds the anchor until it goes through`);
    const item = await job.make(k);
    const at = base + 1000 * k;
    refunds = [row(`re_${n}late00000${k}`, at + 600, "succeeded", `pi_${n}other00000${k}`, true), row(`re_${n}wait00000${k}`, at, status, item.pi, false)];
    is(`${n} (${status}): nothing taken back while it has not gone through`, await job.run(), 0);
    is(`${n} (${status}): still held`, await item.holds(), true);
    const anchor = Number(await anchorNow());
    is(`${n} (${status}): the anchor keeps the refund inside the next read (anchor - 300 <= its time)`, anchor - 300 <= at, true);
    // Stripe finishes it: same id and time, now succeeded with its charge refunded in full.
    refunds = [refunds[0], row(`re_${n}wait00000${k}`, at, "succeeded", item.pi, true)];
    is(`${n} (${status}): once it went through, it is taken back`, await job.run(), 1);
    is(`${n} (${status}): no longer held`, await item.holds(), false);
    is(`${n} (${status}): with nothing left waiting, the anchor moves to the newest refund`, await anchorNow(), String(at + 600));
  }

  part(`${n}: controls, a refund failed or canceled holds nothing, and a partial refund takes nothing back`);
  const kept = await job.make(4);
  const at = base + 5000;
  refunds = [
    row(`re_${n}ctrl000003`, at + 600, "succeeded", `pi_${n}other000004`, true),
    row(`re_${n}ctrl000002`, at + 10, "succeeded", kept.pi, false, 1000),
    row(`re_${n}ctrl000001`, at + 5, "failed", kept.pi, false),
    row(`re_${n}ctrl000000`, at, "canceled", kept.pi, false),
  ];
  is(`${n}: nothing taken back`, await job.run(), 0);
  is(`${n}: still held`, await kept.holds(), true);
  is(`${n}: the anchor moves to the newest refund`, await anchorNow(), String(at + 600));
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_pending_refunds_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_pending_refunds_only";

  await claimHandle("owner@pending.example", "pendingshop", "Pending Shop", "");
  await ensureStatsId("owner@pending.example");
  await setStripeAccount("owner@pending.example", "acct_1TestPendRef001", true);
  await setSubscription("owner@pending.example", { customerId: "cus_PendOwner001", subscriptionId: "sub_PendOwner001", active: true, period: paidPeriod() });
  const made = await addProduct("owner@pending.example", "Bread Course", "", "25", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink("owner@pending.example", made.product.id, "https://example.com/course");
  const store = (await storeForEmail("owner@pending.example"))!;
  const product = (await readListing(store, made.product.id))!;
  const deps = {
    base: "https://marktmorgen.com/@pendingshop",
    from: '"Pending Shop" <hello@marktmorgen.com>',
    ordersLink: async (email: string) => `https://marktmorgen.com/@pendingshop/orders?for=${encodeURIComponent(email)}`,
    recordStart: async () => {},
  };
  const holds = async (email: string) => (await importedFor((await storeForEmail("owner@pending.example")) as Store, email)).length > 0;

  await check({
    name: "gift",
    anchor: `nl:gift:${store.statsId}:refunds`,
    run: () => revokeRefundedGifts(store, Date.now() + 60_000, async () => {}),
    make: async (n) => {
      const to = `friend${n}@pending.example`;
      const started = await startGift(store, product as Listing, { to, from: "Ana", message: "" });
      if (!started.ok) throw new Error("no gift");
      const pi = `pi_pendgift${String(n).padStart(8, "0")}`;
      const given = await deliverGift({
        store,
        session: { id: `cs_test_pendgift${String(n).padStart(8, "0")}`, created: NOW - 20_000, amount_total: 2500, currency: "usd", payment_intent: pi, metadata: { store: "pendingshop", product: product.id, gift: started.gift.id }, customer_details: { email: "buyer@pending.example" } } as never,
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
      const email = `buyer${n}@pending.example`;
      const pi = `pi_pendpre${String(n).padStart(8, "0")}`;
      const session = {
        id: `cs_test_pendpre${String(n).padStart(8, "0")}`,
        created: NOW - 20_000,
        status: "complete",
        payment_status: "paid",
        amount_total: 2500,
        currency: "usd",
        payment_intent: pi,
        metadata: { store: "pendingshop", product: product.id, preorder: "yes" },
        customer_details: { email },
      };
      const given = await confirmPreorder(store, session as never, product, deps);
      if (given !== "given") throw new Error(`pre-order ${n} not given: ${given}`);
      return { pi, holds: () => holds(email) };
    },
  }, NOW - 10_000);

  done();
}

void main();
