/**
 * A payment request is written only on counts read in their exact shape (Claude 7, 14 November 2026; rule 24).
 * Synthetic only: the in-memory Redis, through the real lib/payment-request-store.ts createRequest.
 *
 * createRequest read the store's open and kept requests and the person's with Number(), so a ZCARD or SCARD answered
 * as null or "" read as 0 and true as 1: the plan's limits on open and kept requests and the limit per person were
 * passed on a count nobody knew. A count must be a whole number, and at least the one just added; anything else is
 * unknown, nothing is kept and the request is refused as unavailable.
 */
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { readDraft } from "@/lib/payment-request-rules";
import { createRequest, openCount } from "@/lib/payment-request-store";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";

/** While set, what a ZCARD or SCARD (the counts createRequest reads) answers instead of its count. */
let swap: { command: "ZCARD" | "SCARD"; value: unknown } | null = null;
const run = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  const replies = await run(commands);
  return swap ? replies.map((reply, i) => (commands[i][0] === swap?.command ? swap.value : reply)) : replies;
}) as typeof redis.pipeline;

const LINE = { text: "Coaching, October (4 sessions)", quantity: 1, amount: "480" };
const draftFor = (email: string, now: number) =>
  (readDraft({ email, name: "Dana", lines: [LINE], note: "", dueDate: "", autoReminders: 0, consent: true }, "usd", now) as { ok: true; draft: Parameters<typeof createRequest>[1] }).draft;

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_payment_request_counts_stand_in";
  const owner = "counts@example.com";
  await claimHandle(owner, "countsexact", "Counts Studio", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1ReqCountsExact", true);
  await setSubscription(owner, { customerId: "cus_counts", subscriptionId: "sub_counts", active: true, tier: "creator", period: paidPeriod() });
  const store = (await storeForEmail(owner)) as Store;
  const now = Date.now();

  part("Control: a request on counts read exactly is written");
  is("written", (await createRequest(store, draftFor("one@example.com", now), now)).ok, true);

  part("A count in another shape is unknown: nothing is written");
  let n = 2;
  for (const [command, value] of [["ZCARD", null], ["ZCARD", ""], ["ZCARD", true], ["SCARD", null], ["SCARD", "0"], ["SCARD", 0]] as const) {
    const before = await openCount(store.sid);
    swap = { command, value };
    const made = await createRequest(store, draftFor(`p${(n += 1)}@example.com`, now), now);
    swap = null;
    is(`${command} answered ${JSON.stringify(value)}: refused`, made.ok, false);
    is(`${command} answered ${JSON.stringify(value)}: nothing kept open`, await openCount(store.sid), before);
  }
  done();
}

void main();
