/**
 * A plan subscription Stripe answers 404 for is not, by that alone, a plan
 * that ended (plan-lifecycle audit, finding M2). Stripe keeps every
 * subscription it ever made, cancelled ones too, so a 404 almost always means
 * the key asks another account or another mode: a platform account replaced,
 * a test key in production. Read as "ended", the daily job (lib/billing-sync.ts,
 * step 2) would end every paid store in one pass and queue each for closing,
 * where the same key would say 404 again and everything would be deleted.
 *
 * Here: a 404 read on its own is unknown; in the daily job it counts as ended
 * only when the same key reads the store's own customer (the key reaches the
 * account), and never when more than a few plans of one run say 404 at once.
 */
import { readSubscription } from "@/lib/billing";
import { syncSubscriptions } from "@/lib/billing-sync";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail, storeRef } from "@/lib/store";
import { ENDED_INDEX } from "@/lib/plan-standing";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_plan_missing_not_ended";
const NOW = Date.now();
/** Which customers the key can read; every subscription read answers 404. */
let customersReadable = false;
const asked: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  asked.push(`${init?.method ?? "GET"} ${url.pathname}`);
  if (url.hostname === "api.stripe.com") {
    if (url.pathname === "/v1/subscriptions") return Response.json({ object: "list", data: [], has_more: false, url: "/v1/subscriptions" });
    const customer = /^\/v1\/customers\/(cus_[A-Za-z0-9]+)$/.exec(url.pathname);
    if (customer && customersReadable) return Response.json({ id: customer[1], object: "customer", email: "owner@example.com" });
    return new Response(JSON.stringify({ error: { code: "resource_missing", message: "No such object", type: "invalid_request_error" } }), { status: 404 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

async function paidStores(count: number, prefix: string): Promise<string[]> {
  const owners: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const owner = `${prefix}${i}@example.com`;
    await claimHandle(owner, `${prefix}-shop-${i}`, `Shop ${i}`, "");
    await ensureStatsId(owner);
    await setSubscription(owner, { customerId: `cus_${prefix}Shop${i}`, subscriptionId: `sub_${prefix}Shop${i}`, active: true, tier: "pro", cycle: "month", period: paidPeriod(NOW) });
    owners.push(owner);
  }
  return owners;
}

async function endedCount(owners: string[]): Promise<number> {
  let ended = 0;
  for (const owner of owners) {
    const s = (await storeForEmail(owner))!;
    const queued = (await redis.pipeline([["ZSCORE", ENDED_INDEX, storeRef(s)]]))[0];
    if (!s.subscriptionActive || queued !== null) ended += 1;
  }
  return ended;
}

async function main() {
  part("a 404 read on its own");
  redis.clear();
  const one = await readSubscription("sub_missingAlone1");
  is("a subscription read that answers 404 is unknown, not ended", one.state, "unknown");

  part("the key reaches no customer: every paid store answers 404");
  redis.clear();
  customersReadable = false;
  const wrongKey = await paidStores(3, "wrongkey");
  const first = await syncSubscriptions(Date.now() + 20_000);
  is("no paid store is ended when the key reads neither the plan nor its customer", await endedCount(wrongKey), 0);
  is("each such store counts as a failure of the run, not as checked and in line", first.failed >= 3, true);

  part("the key reads the customers, but many plans of one run answer 404");
  redis.clear();
  customersReadable = true;
  const many = await paidStores(5, "manymissing");
  const braked = await syncSubscriptions(Date.now() + 20_000);
  is("five plans missing in one run is a brake: none is ended", await endedCount(many), 0);
  is("and the run says so as failures", braked.failed >= 5, true);

  part("one plan genuinely missing on an account the key reaches");
  redis.clear();
  customersReadable = true;
  const lone = await paidStores(1, "lonemissing");
  asked.length = 0;
  await syncSubscriptions(Date.now() + 20_000);
  is("the store's own customer is read before a 404 ends its plan", asked.includes("GET /v1/customers/cus_lonemissingShop0"), true);
  is("a plan Stripe does not have, on an account the key reaches, still ends", await endedCount(lone), 1);
  done();
}
main();
