/**
 * Rule 24 in the refund walk that revokes license keys (lib/licence-keys.ts, revokeRefunded):
 *
 *   - the key a refunded sale was given (HGET) read in another shape is unknown: the refund is not taken as read
 *     (nothing added to the seen set, the place does not move), so the next run revokes the key, instead of the
 *     refunded buyer keeping a valid key for good;
 *   - the walk's place (the anchor, GET) read in another shape stops the run with the place as it was, never "no
 *     place yet": that started from a newer date and then wrote it over the real, older place, so refunds in between
 *     were never read.
 *
 * Synthetic only: a stand-in for the creator's Stripe account.
 */
import { addProduct, claimHandle, ensureStatsId, setProductKeys, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { checkKey, keyForSale, revokeRefunded } from "@/lib/licence-keys";
import { readListing } from "@/lib/catalog";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
const OWNER = "potter@example.com";
const ACCOUNT = "acct_1TestDoors00001";
const NOW = Math.floor(Date.now() / 1000);

const sessions: Record<string, Record<string, unknown>[]> = {};
const sessionsByPayment: Record<string, Record<string, unknown>[]> = {};
const oneSession: Record<string, Record<string, unknown>> = {};
const intents: Record<string, Record<string, unknown>[]> = {};
const paymentIntents: Record<string, Record<string, unknown>> = {};
const disputes: Record<string, { charge: string; status: string; amount?: number }[]> = {};
const charges: Record<string, Record<string, unknown>> = {};
const closings: Record<string, unknown>[] = [];
let refunds: Record<string, unknown>[] = [];
const eventsStatus = 200;
const disputesDown = false;
let disputeReads = 0;
let chargeReads = 0;
let eventReads = 0;
/** When set, the clock jumps past every job's deadline as soon as /refunds has answered, before /events is asked. */
const lateAfterRefunds = false;
const realNow = Date.now;
const lookedUp: string[] = [];

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const list = (data: unknown[]) => answer({ object: "list", data, has_more: false });
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions") {
    const pi = url.searchParams.get("payment_intent");
    if (pi) {
      lookedUp.push(pi);
      return list(sessionsByPayment[pi] ?? []);
    }
    return list(sessions[url.searchParams.get("customer_details[email]") ?? ""] ?? []);
  }
  const one = /^\/checkout\/sessions\/(cs_[A-Za-z0-9_]+)$/.exec(path);
  if (one) return oneSession[one[1]] ? answer(oneSession[one[1]]) : answer({ error: { message: "no such" } }, 404);
  if (path === "/payment_intents") return list(intents[url.searchParams.get("customer") ?? ""] ?? []);
  const pi = /^\/payment_intents\/(pi_[A-Za-z0-9]+)$/.exec(path);
  if (pi) return answer(paymentIntents[pi[1]] ?? {});
  if (path === "/disputes") {
    disputeReads += 1;
    if (disputesDown) return answer({ error: { message: "rate limited" } }, 429);
    return list(disputes[url.searchParams.get("charge") ?? ""] ?? []);
  }
  if (path === "/events") {
    eventReads += 1;
    if (eventsStatus !== 200) return answer({ error: { type: "invalid_request_error", message: "This API key does not have the rak_event_read permission" } }, eventsStatus);
    return list(url.searchParams.get("type") === "charge.dispute.closed" ? closings : []);
  }
  const read = /^\/charges\/(ch_[A-Za-z0-9]+)$/.exec(path);
  if (read) chargeReads += 1;
  if (read) return answer(charges[read[1]] ?? { object: "charge", id: read[1], amount: 4900, amount_refunded: 0, disputed: true });
  if (path === "/refunds") {
    if (lateAfterRefunds) Date.now = () => realNow() + 3_600_000;
    return list(refunds);
  }
  return list([]);
}) as typeof fetch;

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_refund_anchors_only";
  redis.clear();
  await claimHandle(OWNER, "kilnworks", "Kiln Works", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_Owner00002", subscriptionId: "sub_Owner00002", active: true, period: paidPeriod() });
  const tool = await addProduct(OWNER, "Firing App", "", "29", null);
  if (!tool.ok) throw new Error("no product");
  await setProductLink(OWNER, tool.product.id, "https://example.com/firing-app");
  await setProductKeys(OWNER, tool.product.id, { source: "generated", prefix: "FIRE", groups: 4, groupLength: 4, lowAt: 0 });
  const store = (await storeForEmail(OWNER))!;
  const app = (await readListing(store, tool.product.id))!;
  const anchorKey = `nl:keys:${store.statsId}:refunds:since`;
  type Batch = (string | number)[][];
  const pipeline = redis.pipeline.bind(redis);
  const run = () => revokeRefunded(store, Date.now() + 10_000).then((n) => n, () => "stopped");

  part("The key of a refunded sale read in another shape: the refund is read again next run");
  const given = await keyForSale(store, app, "cs_test_keyrefund0001", "buyer@example.com");
  if (given?.state !== "issued") throw new Error("no key");
  sessionsByPayment.pi_TestKeyRefund1 = [{ id: "cs_test_keyrefund0001", metadata: { store: "kilnworks", product: tool.product.id } }];
  refunds = [{ id: "re_TestKeyRefund1", object: "refund", created: NOW - 30, status: "succeeded", payment_intent: "pi_TestKeyRefund1", charge: { object: "charge", amount: 2900, amount_refunded: 2900, refunded: true } }];
  const saleRead = (b: Batch) => b.length === 1 && b[0][0] === "HGET" && String(b[0][1]).includes(":sale") && b[0][2] === "cs_test_keyrefund0001";
  for (const [label, reply] of [["no reply", []], ["a number", [7]], ["an object", [{}]]] as [string, unknown[]][]) {
    redis.pipeline = (async (b: Batch) => (saleRead(b) ? reply : pipeline(b))) as typeof redis.pipeline;
    try {
      await run();
    } finally {
      redis.pipeline = pipeline;
    }
    is(`${label}: the refund is not taken as read`, (await pipeline([["SISMEMBER", `nl:keys:${store.statsId}:refunds:seen`, "re_TestKeyRefund1"]]))[0], 0);
  }
  is("the next run, read exactly, revokes the key", [await run(), await checkKey(store, app, given.key)], [1, "revoked"]);

  part("The walk's place read in another shape: stopped, the place kept");
  const older = String(NOW - 20 * 86_400);
  await pipeline([["SET", anchorKey, older, "EX", 86_400 * 60]]);
  const anchorRead = (b: Batch) => b.length === 1 && b[0][0] === "GET" && b[0][1] === anchorKey;
  for (const [label, reply] of [["no reply", []], ["a number", [7]], ["text that is not a time", ["soon"]]] as [string, unknown[]][]) {
    redis.pipeline = (async (b: Batch) => (anchorRead(b) ? reply : pipeline(b))) as typeof redis.pipeline;
    let ran: unknown;
    try {
      ran = await run();
    } finally {
      redis.pipeline = pipeline;
    }
    is(`${label}: the run stops`, ran, "stopped");
    is(`${label}: the older place is kept`, (await pipeline([["GET", anchorKey]]))[0], older);
  }
}

main().then(done, (error) => {
  console.error(error);
  process.exit(1);
});
