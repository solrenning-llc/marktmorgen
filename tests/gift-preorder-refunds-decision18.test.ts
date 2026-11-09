/**
 * Gifts and pre-orders under the owner's decision 18 (9 November 2026, C1-20261109-1029-C5-52): a full refund still
 * pending takes nothing back; only a refund confirmed (succeeded) or a dispute lost does. On failed or canceled the
 * gift or pre-order stays. A refund made in parts takes back only once the succeeded parts add up to the charge.
 * A pre-order not handed over yet whose payment has a full refund still pending is not marked refunded for good:
 * its hand-over waits, and once the refund failed it is handed over.
 *
 * Probe of Claude 5's money review of #3302 (8 checks, 6 failing on main), through the real gift and pre-order
 * journeys, against a stand-in for the creator's Stripe account that honours created[gte] and charge=. Before:
 * revokeRefundedGifts / revokeRefundedPreorders took a pending full refund back at once (lib/refunds.ts rowGivesBack
 * counted "pending"), and runPreorderReleases marked a pre-order refunded for good on a refund still pending.
 *
 * Synthetic only: Stripe is a stand-in fetch and Redis is tests/redis-stub.ts. Nothing real is reached.
 */
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail, type Listing, type Store } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { deliverGift, revokeRefundedGifts, startGift } from "@/lib/gifts";
import { importedFor } from "@/lib/imported-purchases";
import { confirmPreorder, revokeRefundedPreorders, runPreorderReleases } from "@/lib/preorders";
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
    const charge = url.searchParams.get("charge");
    if (charge) return answer({ object: "list", data: refunds.filter((row) => (row.charge as { id?: unknown } | null)?.id === charge).map((row) => ({ ...row, charge })), has_more: false });
    const listed = refunds.filter((row) => typeof row.created === "number" && row.created >= since);
    const from = after ? listed.findIndex((row) => row.id === after) + 1 : 0;
    return answer({ object: "list", data: listed.slice(from, from + limit), has_more: from + limit < listed.length });
  }
  if (path === "/events") return answer({ object: "list", data: [], has_more: false });
  if (path.startsWith("/payment_intents/")) {
    const pi = path.split("/")[2];
    const back = backOf(pi);
    return answer({ id: pi, object: "payment_intent", latest_charge: { object: "charge", id: chargeOf(pi), payment_intent: pi, refunded: back >= 2500, amount: 2500, amount_refunded: back, disputed: false } });
  }
  return answer({ error: { message: `no stand-in for ${init?.method ?? "GET"} ${path}` } }, 404);
}) as typeof fetch;

/** The charge of a payment in this stand-in. */
const chargeOf = (pi: string) => `ch_${pi.slice(3)}`;
/** What the charge of a payment reads as refunded, from the refunds listed now (Stripe counts pending ones too). */
const backOf = (pi: string) =>
  refunds.filter((r) => r.payment_intent === pi && r.status !== "failed" && r.status !== "canceled").reduce((sum, r) => sum + (r.amount as number), 0);

/** One refund row, as /refunds lists it with its charge expanded; `back` is what the charge reads as refunded. */
function row(id: string, created: number, status: string, pi: string, refunded: boolean, back = refunded ? 2500 : 0, amount = 2500): Record<string, unknown> {
  return { id, object: "refund", created, status, amount, payment_intent: pi, charge: { object: "charge", id: chargeOf(pi), refunded, amount: 2500, amount_refunded: back } };
}

type Job = {
  name: string;
  anchor: string;
  run: () => Promise<number>;
  /** Makes one paid item (a gift given, or a pre-order handed over) and returns its payment and whether it is still held. */
  make: (n: number) => Promise<{ pi: string; holds: () => Promise<boolean> }>;
};

async function check(job: Job, base: number): Promise<void> {
  const n = job.name;
  part(`${n}: S1 a full refund pending, which Stripe then fails, never takes access away (owner decision 18)`);
  const a = await job.make(1);
  refunds = [row(`re_${n}s1pend00001`, base, "pending", a.pi, true)];
  await job.run();
  is(`${n} S1: held while pending`, await a.holds(), true);
  refunds = [row(`re_${n}s1pend00001`, base, "failed", a.pi, false)];
  await job.run();
  is(`${n} S1: held after the refund failed`, await a.holds(), true);
  refunds = [row(`re_${n}s1okay00001`, base + 10, "succeeded", a.pi, true)];
  await job.run();
  is(`${n} S1: a later full refund that succeeded takes it back`, await a.holds(), false);

  part(`${n}: S3 a partial refund that succeeded, plus a pending one that would complete it, never takes access away yet`);
  const b = await job.make(2);
  const at = base + 2000;
  refunds = [row(`re_${n}s3pend00002`, at + 5, "pending", b.pi, true, 2500, 1500), row(`re_${n}s3part00002`, at, "succeeded", b.pi, true, 2500, 1000)];
  await job.run();
  is(`${n} S3: held while the rest is pending`, await b.holds(), true);
  refunds = [row(`re_${n}s3pend00002`, at + 5, "succeeded", b.pi, true, 2500, 1500), row(`re_${n}s3part00002`, at, "succeeded", b.pi, true, 2500, 1000)];
  await job.run();
  is(`${n} S3: once the parts that succeeded add up to the charge, it is taken back`, await b.holds(), false);

  part(`${n}: S5 control, requires_action full refund holds`);
  const c = await job.make(3);
  refunds = [row(`re_${n}s5act000003`, base + 4000, "requires_action", c.pi, true)];
  await job.run();
  is(`${n} S5: held while requires_action`, await c.holds(), true);
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_pending_refunds_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_pending_refunds_only";

  await claimHandle("owner@sonda.example", "sondashop", "Pending Shop", "");
  await ensureStatsId("owner@sonda.example");
  await setStripeAccount("owner@sonda.example", "acct_1TestSondaRef01", true);
  await setSubscription("owner@sonda.example", { customerId: "cus_PendOwner001", subscriptionId: "sub_PendOwner001", active: true, period: paidPeriod() });
  const made = await addProduct("owner@sonda.example", "Bread Course", "", "25", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink("owner@sonda.example", made.product.id, "https://example.com/course");
  const store = (await storeForEmail("owner@sonda.example"))!;
  const product = (await readListing(store, made.product.id))!;
  const deps = {
    base: "https://marktmorgen.com/@sondashop",
    from: '"Pending Shop" <hello@marktmorgen.com>',
    ordersLink: async (email: string) => `https://marktmorgen.com/@sondashop/orders?for=${encodeURIComponent(email)}`,
    recordStart: async () => {},
  };
  const holds = async (email: string) => (await importedFor((await storeForEmail("owner@sonda.example")) as Store, email)).length > 0;

  await check({
    name: "gift",
    anchor: `nl:gift:${store.statsId}:refunds`,
    run: () => revokeRefundedGifts(store, Date.now() + 60_000, async () => {}),
    make: async (n) => {
      const to = `friend${n}@sonda.example`;
      const started = await startGift(store, product as Listing, { to, from: "Ana", message: "" });
      if (!started.ok) throw new Error("no gift");
      const pi = `pi_pendgift${String(n).padStart(8, "0")}`;
      const given = await deliverGift({
        store,
        session: { id: `cs_test_pendgift${String(n).padStart(8, "0")}`, created: NOW - 20_000, amount_total: 2500, currency: "usd", payment_intent: pi, metadata: { store: "sondashop", product: product.id, gift: started.gift.id }, customer_details: { email: "buyer@sonda.example" } } as never,
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
      const email = `buyer${n}@sonda.example`;
      const pi = `pi_pendpre${String(n).padStart(8, "0")}`;
      const session = {
        id: `cs_test_pendpre${String(n).padStart(8, "0")}`,
        created: NOW - 20_000,
        status: "complete",
        payment_status: "paid",
        amount_total: 2500,
        currency: "usd",
        payment_intent: pi,
        metadata: { store: "sondashop", product: product.id, preorder: "yes" },
        customer_details: { email },
      };
      const given = await confirmPreorder(store, session as never, product, deps);
      if (given !== "given") throw new Error(`pre-order ${n} not given: ${given}`);
      return { pi, holds: () => holds(email) };
    },
  }, NOW - 10_000);

  part("pre-order release: a full refund still pending waits; it is never marked refunded for good");
  const sid = store.statsId as string;
  const entries = `nl:pre:${sid}:${product.id}`;
  const member = `${sid}|${product.id}|${store.handle}`;
  const waitPi = "pi_pendrel00000001";
  const backPi = "pi_pendrel00000002";
  const waitSession = "cs_test_pendrel00000001";
  const backSession = "cs_test_pendrel00000002";
  redis.run(["HSET", entries, waitSession, JSON.stringify({ to: "late1@sonda.example", at: NOW - 100, pi: waitPi })]);
  redis.run(["HSET", entries, backSession, JSON.stringify({ to: "late2@sonda.example", at: NOW - 100, pi: backPi })]);
  redis.run(["SADD", "nl:pre:jobs", member]);
  const entry = (session: string) => JSON.parse(String(redis.run(["HGET", entries, session]))) as { given?: number; revoked?: number };
  const release = () => runPreorderReleases(async () => store, async () => product as Listing, () => deps, Date.now() + 60_000);
  refunds = [row("re_pendrel00000001", NOW - 50, "pending", waitPi, true), row("re_pendrel00000002", NOW - 40, "succeeded", backPi, true)];
  await release();
  is("release: a pre-order whose full refund is pending is not marked refunded", entry(waitSession).revoked ?? null, null);
  is("release: nor handed over while its refund is pending", entry(waitSession).given ?? null, null);
  is("release: the job is kept for it", (redis.run(["SMEMBERS", "nl:pre:jobs"]) as string[]).includes(member), true);
  is("release control: a full refund that succeeded is marked refunded", typeof entry(backSession).revoked, "number");
  refunds = [row("re_pendrel00000001", NOW - 50, "failed", waitPi, false), row("re_pendrel00000002", NOW - 40, "succeeded", backPi, true)];
  await release();
  is("release: once the refund failed, the pre-order is handed over", typeof entry(waitSession).given, "number");
  is("release: and never marked refunded", entry(waitSession).revoked ?? null, null);

  done();
}

void main();
