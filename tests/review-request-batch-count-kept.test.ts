/**
 * A review request batch whose answer was not known keeps the store's monthly count and the company's day it
 * reserved, and marks them (lib/batch-count.ts; #4073, Codex X6's LOW: the lost-ack retry held for every batch-email
 * caller, not only announcements). Its claims stay stretched, as for any batch that may have gone (#4360; the
 * coordinator's option (A), 20261122T025459Z-claude-1-coord-4e56): the email is never handed over again, under this
 * key or another, and it is counted once. Drives the real sendReviewRequests with the batch answer stubbed
 * (tests/batch-answer-world.ts). Synthetic data only: Stripe and Redis are stand-ins.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, setMailSettings, setProductLink, setReviewAsk, setStripeAccount, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { sendReviewRequests } from "@/lib/review-requests";
import { ASK_DUE_KEY, scheduleReviewAsk } from "@/lib/review-ask";
import { mailDay } from "@/lib/mail";
import { answerBatches, batchAnswers, type BatchAnswer } from "./batch-answer-world";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const NOW = Math.floor(Date.now() / 1000);
const PAID_AT = NOW - 8 * 86_400;
let productId = "";
let handle = "";
/** The checkout of each order, by its reference: the person who paid. */
const orders = new Map<string, string>();
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname !== "api.stripe.com") throw new Error("No real provider call allowed");
  const reference = url.pathname.replace(/^\/v1\/checkout\/sessions\//, "");
  const person = orders.get(reference);
  if (person) return Response.json({
    id: reference, object: "checkout.session", mode: "payment", status: "complete", payment_status: "paid",
    created: PAID_AT, amount_total: 2700, currency: "usd", customer_details: { email: person },
    metadata: { store: handle, product: productId },
    payment_intent: { id: `pi_${reference}`, status: "succeeded", latest_charge: { id: `ch_${reference}`, amount: 2700, amount_refunded: 0, disputed: false, refunded: false } },
  });
  return Response.json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

// MemoryRedis lacks ZADD XX: the same stand-in for native Redis as tests/l9-review-request-exact.test.ts.
const base = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (!commands.some((c) => c[0] === "ZADD" && c[1] === ASK_DUE_KEY && c[2] === "XX")) return base(commands);
  const replies: unknown[] = [];
  for (const c of commands) {
    if (c[0] === "ZADD" && c[1] === ASK_DUE_KEY && c[2] === "XX" && c.length === 5) {
      if (redis.run(["ZSCORE", ASK_DUE_KEY, c[4]]) !== null) redis.run(["ZADD", ASK_DUE_KEY, c[3], c[4]]);
      replies.push(0);
    } else replies.push(...(await base([c])));
  }
  return replies;
}) as typeof redis.pipeline;

const read = async (key: string) => Number((await redis.pipeline([["GET", key]]))[0] ?? 0);
/** The store's month (lib/mail.ts usedKey) and the company's day, as counted. */
const counted = async () => {
  let month = 0;
  for (const key of redis.keys().filter((k) => k.startsWith("nl:mail:used:"))) month += await read(key);
  return { month, day: await read(mailDay()()) };
};
const marks = () => redis.keys().filter((k) => k.startsWith("nl:mail:kept:")).length;

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_reviews_only_a_stand_in";
  // A sender with room (lib/mail.ts senderRoom); the batch itself never reaches it (tests/batch-answer-world.ts).
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  process.env.MARKETING_DAILY_CAP = "1000";

  for (const unknown of ["unconfirmed", "uncertain"] as BatchAnswer[]) {
    part(`A review request batch answered "${unknown}", then sent`);
    redis.clear();
    orders.clear();
    const owner = `owner-${unknown}@example.com`;
    handle = `review${unknown}`;
    await claimHandle(owner, handle, "Review Kitchen", "");
    await ensureStatsId(owner);
    await ensureListId(owner);
    await setStripeAccount(owner, "acct_1TestHarbor0001", true);
    await setSubscription(owner, { customerId: "cus_Review00001", subscriptionId: "sub_Review00001", active: true, tier: "pro", period: paidPeriod() });
    await setMailSettings(owner, { fromName: "Review Kitchen", address: "1 Main St, Portland, OR 97201" });
    await setReviewAsk(owner, { days: 7 });
    const made = await addProduct(owner, "Weekly Planner", "", "27", null);
    if (!made.ok) throw new Error("no product");
    productId = made.product.id;
    await setProductLink(owner, productId, "https://example.com/planner");
    const shop = (await storeForEmail(owner))!;
    for (const who of ["ana", "bo"]) {
      const reference = `cs_test_${unknown}${who}Order01`;
      orders.set(reference, `${who}-${unknown}@example.com`);
      is(`(${who}'s order is due for its request)`, await scheduleReviewAsk(shop, reference, PAID_AT), true);
    }

    const before = await counted();
    answerBatches(unknown, "sent");
    const first = await sendReviewRequests(storeForHandle, Date.now() + 20_000, NOW);
    is("the answer was not known: nothing counted as sent", first.sent, 0);
    const held = await counted();
    is("the two emails stay counted, in the store's month and the company's day", [held.month - before.month, held.day - before.day], [2, 2]);
    is("and the batch is marked as holding its count", marks(), 1);

    for (const at of [NOW + 3_600, NOW + 6 * 3_600]) {
      const again = await sendReviewRequests(storeForHandle, Date.now() + 20_000, at);
      is("a later run never sends it again", again.sent, 0);
    }
    is("the provider was handed the batch once", batchAnswers.handed.length, 1);
    const after = await counted();
    is("counted once, not twice", [after.month - before.month, after.day - before.day], [2, 2]);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
