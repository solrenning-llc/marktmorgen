/**
 * Claude 4's two MEDIUM findings on #3479 (6785126898, the second also 6749899830, confirmed by Codex L 6758703691),
 * against the real readers, with the in-memory Redis double:
 *
 *   - a membership's first payment credited when its pending link was decided is written `how: "recurring"`
 *     (creditFirstPayment), which the program's public numbers (programNumbers, exactReferral) refused as a record of
 *     an unknown shape, so the store's numbers were unreadable for good after the first one;
 *   - the sweep of pending orders (notePendingDue) took a store whose record did not read for "gone" and dropped the
 *     order from its list, untold; now only a store answered for sure as absent drops it, and an unknown one is kept
 *     for the next run.
 */
import { notePendingDue, programNumbers } from "@/lib/affiliates";
import { NO_AFFILIATES, parseAffiliateSetting } from "@/lib/affiliate-setting";
import { claimHandle, ensureStatsId, ensureStoreId, setAffiliateSetting, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_review5_pending";
process.env.RESEND_API_KEY = "re_test_review5_pending";

const OWNER = "baker@example.com";
const NOW = Math.floor(Date.now() / 1000);
const ANA = "aaaaaaaaaaaa";
const DUE = "nl:aff:pend:due";

globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: "no stand-in" } }), { status: 404 })) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "bakery", "The Bakery", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestReview5", true);
  await setAffiliateSetting(OWNER, parseAffiliateSetting({ ...NO_AFFILIATES, enabled: true, percent: 30 }));
  const store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;

  part("A membership's first payment, written as creditFirstPayment writes it, is read by the program's numbers");
  await redis.pipeline([
    ["HSET", `nl:aff:${statsId}:people`, ANA, JSON.stringify({ id: ANA, email: "ana@example.com", code: "ana", status: "approved", appliedAt: (NOW - 90 * 86_400) * 1000, decidedAt: (NOW - 90 * 86_400) * 1000, note: "" })],
    ["HSET", `nl:aff:${statsId}:sales`, "in_first0001", JSON.stringify({ ref: "in_first0001", pi: "pi_first0001", aff: ANA, at: NOW - 3_600, product: "prod01", title: "Bread club", base: 4_000, total: 4_000, currency: "usd", rate: 30, self: false, how: "recurring" })],
  ]);
  let numbers: unknown;
  try {
    numbers = await programNumbers(store);
  } catch (error) {
    numbers = `threw: ${error instanceof Error ? error.message : String(error)}`;
  }
  is("the numbers read, with the sale in them", typeof numbers === "object" && numbers !== null, true);

  part("A pending order whose store does not read is kept on the sweep's list, never dropped as gone");
  const member = `${store.sid}|cs_test_${"p".repeat(24)}`;
  await redis.pipeline([["ZADD", DUE, NOW - 3_600, member]]);
  const pipeline = redis.pipeline.bind(redis);
  let bent = false;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const answers = await pipeline(commands);
    return answers.map((answer, i) => (!bent && commands[i][0] === "GET" && commands[i][1] === `nl:store:id:${store.sid}` ? ((bent = true), 42) : answer));
  }) as typeof redis.pipeline;
  let failed: unknown;
  try {
    failed = await notePendingDue(NOW, undefined, async () => "sent" as never);
  } finally {
    redis.pipeline = pipeline;
  }
  is("the store's record was read (and bent)", bent, true);
  is("the order is still on the list", (await redis.pipeline([["ZSCORE", DUE, member]]))[0] !== null, true);
  is("and the run says one was left for the next one", failed, 1);

  part("Control: a store that is gone for sure takes its order off the list");
  const goneMember = `${"0".repeat(32)}|cs_test_${"g".repeat(24)}`;
  await redis.pipeline([["ZADD", DUE, NOW - 3_600, goneMember]]);
  await notePendingDue(NOW, undefined, async () => "sent" as never);
  is("off the list", (await redis.pipeline([["ZSCORE", DUE, goneMember]]))[0], null);

  done();
}

void main();
