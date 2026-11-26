/**
 * A product update batch whose answer was not known keeps the store's monthly count and the company's day it
 * reserved, and marks them (lib/batch-count.ts); the same batch tried again sends under that count instead of
 * reserving again, and the mark goes once it is sent (#4073, Codex X6's LOW: the lost-ack retry held for every
 * batch-email caller, not only announcements). Drives the real advanceUpdate with the batch answer stubbed
 * (tests/batch-answer-world.ts). Synthetic data only.
 */
import { advanceUpdate, readUpdateJob, startUpdate } from "@/lib/product-updates";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setMailSettings, setProductLink, setStripeAccount, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { mailDay } from "@/lib/mail";
import { answerBatches, batchAnswers, type BatchAnswer } from "./batch-answer-world";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const OWNER = "owner@example.com";
let sessions: Record<string, unknown>[] = [];
// Stripe's checkouts for the update's recipients; no email service is reached (the batch answer is stubbed).
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const list = (data: unknown[]) => new Response(JSON.stringify({ object: "list", data, has_more: false }));
  if (path === "/checkout/sessions") return list(sessions);
  return list([]);
}) as typeof fetch;

const read = async (key: string) => Number((await redis.pipeline([["GET", key]]))[0] ?? 0);
/** The store's month (lib/mail.ts usedKey) and the company's day, as counted. */
const counted = async () => {
  const month = redis.keys().filter((k) => k.startsWith("nl:mail:used:"));
  let used = 0;
  for (const key of month) used += await read(key);
  return { month: used, day: await read(mailDay()()) };
};
const marks = () => redis.keys().filter((k) => k.startsWith("nl:mail:kept:")).length;

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_probe_only_a_stand_in";
  // A sender with room (lib/mail.ts senderRoom); the batch itself never reaches it (tests/batch-answer-world.ts).
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  process.env.MARKETING_DAILY_CAP = "1000";
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHarbor0001", true);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Jenny at Harbor", address: "1 Main St, Portland, OR 97201" });

  for (const unknown of ["unconfirmed", "uncertain"] as BatchAnswer[]) {
    part(`A product update batch answered "${unknown}", then sent`);
    const made = await addProduct(OWNER, `Weekly Planner ${unknown}`, "", "27", null);
    if (!made.ok) throw new Error("no product");
    const id = made.product.id;
    await setProductLink(OWNER, id, "https://example.com/planner");
    sessions = ["ana", "bo"].map((who, i) => ({
      id: `cs_${unknown}_${i}`, object: "checkout.session", status: "complete", payment_status: "paid",
      created: Math.floor(Date.now() / 1000) - 86_400, amount_total: 2700, currency: "usd",
      customer_details: { email: `${who}-${unknown}@example.com` }, metadata: { store: "harbor", product: id },
    }));
    const store = (await storeForEmail(OWNER))!;
    const product = (await readListing(store, id))!;
    const started = await startUpdate(store, product, "New chapter.");
    if (!started.ok) throw new Error(`not started: ${started.reason}`);

    const before = await counted();
    answerBatches(unknown, "sent");
    await advanceUpdate(started.job.id, storeForHandle, Date.now() + 20_000);
    const waiting = await readUpdateJob(started.job.id);
    is("the answer was not known: the update waits, nothing counted as sent", [waiting?.status, waiting?.sent, waiting?.failures], ["sending", 0, 1]);
    const held = await counted();
    is("the two emails stay counted, in the store's month and the company's day", [held.month - before.month, held.day - before.day], [2, 2]);
    is("and the batch is marked as holding its count", marks(), 1);

    await advanceUpdate(started.job.id, storeForHandle, Date.now() + 20_000);
    const sentJob = await readUpdateJob(started.job.id);
    is("tried again and sent", [sentJob?.status, sentJob?.sent], ["sent", 2]);
    is("the same batch, under the same key, handed over twice", [batchAnswers.handed.length, batchAnswers.handed[0]?.key === batchAnswers.handed[1]?.key], [2, true]);
    const after = await counted();
    is("counted once, not twice", [after.month - before.month, after.day - before.day], [2, 2]);
    is("no mark is left once the batch was sent", marks(), 0);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
