/**
 * A payment request's record and its counts are read exactly (rule 24).
 *
 *   - readRequest / requestOf: only a GET that answers exactly null is "no such
 *     request". A reply cut short, of another shape, or a record that is not
 *     JSON or not a request throws, so a paid checkout's webhook is answered
 *     with an error and tried again by Stripe, never "skip" (which left a paid
 *     request open, without a receipt, for the buyer to pay again);
 *   - markPaid on such a read throws too, and writes nothing;
 *   - createRequest: the open, kept and per-person counts (ZCARD, SCARD) must
 *     each come back as a whole number from 0 up; null, "" or a list is not 0,
 *     so the plan's caps are never passed on a count that was not read.
 *
 * Synthetic only: the in-memory Redis, no Stripe.
 */
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { createRequest, markPaid, requestOf } from "@/lib/payment-request-store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const OWNER = "request-exact@example.com";
type Batch = (string | number)[][];
const pipeline = redis.pipeline.bind(redis);
const outcome = <T>(promise: Promise<T>) => promise.then((value) => ({ value }), () => "threw" as const);
const recordGet = (id: string) => (batch: Batch) => batch.length === 1 && batch[0][0] === "GET" && batch[0][1] === `nl:payreq:r:${id}`;

async function withAnswer<T>(pick: (batch: Batch) => boolean, answer: (batch: Batch, real: unknown[]) => unknown[], run: () => Promise<T>): Promise<T> {
  redis.pipeline = (async (batch: Batch) => {
    const real = await pipeline(batch);
    return pick(batch) ? answer(batch, real) : real;
  }) as typeof redis.pipeline;
  try {
    return await run();
  } finally {
    redis.pipeline = pipeline;
  }
}

async function main(): Promise<void> {
  const made = await claimHandle(OWNER, "requestexact", "Request Exact", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_1RequestExact01", true);
  await setSubscription(OWNER, { customerId: "cus_requestexact01", subscriptionId: "sub_requestexact01", active: true, tier: "creator", period: paidPeriod() });
  const store = (await storeForEmail(OWNER)) as Store;
  const draft = { email: "buyer@example.com", name: "Sam", lines: [{ text: "Menu plan", quantity: 1, cents: 5000 }], note: "", dueDate: "", autoReminders: 0, total: 5000 } as Parameters<typeof createRequest>[1];
  const asked = await createRequest(store, draft);
  if (!asked.ok) throw new Error(`no request: ${asked.reason}`);
  const id = asked.request.id;
  const session = { id: "cs_test_requestexact01", amount_total: 5000, currency: "usd", payment_intent: "pi_requestexact01", payment_status: "paid", status: "complete" } as unknown as Parameters<typeof markPaid>[2];

  part("Healthy reads");
  is("the request is found", (await requestOf(store, id))?.id, id);

  part("A record read in another shape is never \"no such request\"");
  for (const [label, alter] of [
    ["cut short", () => []],
    ["a number", () => [7]],
    ["a list", () => [["x"]]],
    ["not JSON", () => ["{not json"]],
    ["JSON that is not a request", () => ["[1,2]"]],
  ] as [string, (batch: Batch, real: unknown[]) => unknown[]][]) {
    is(`requestOf: ${label} throws`, await withAnswer(recordGet(id), alter, () => outcome(requestOf(store, id))), "threw");
    is(`markPaid: ${label} throws, never null`, await withAnswer(recordGet(id), alter, () => outcome(markPaid(store, id, session))), "threw");
    is(`(${label}: nothing was written as paid)`, (await requestOf(store, id))?.state, "open");
  }
  is("an exact null is still no such request", await withAnswer(recordGet(id), () => [null], () => outcome(requestOf(store, id))), { value: null });

  part("A count read in another shape never passes the plan's caps");
  const countsBatch = (batch: Batch) => batch.some((c) => c[0] === "ZCARD") && batch.some((c) => c[0] === "SCARD");
  for (const [label, at, value] of [
    ["open count null", 5, null],
    ["kept count empty text", 6, ""],
    ["person's count a list", 7, []],
    ["open count a number as text", 5, "1"],
    ["the reply cut short", -1, undefined],
  ] as [string, number, unknown][]) {
    const before = await pipeline([["ZCARD", `nl:payreq:s:${store.sid}`]]);
    const made = await withAnswer(countsBatch, (_batch, real) => (at < 0 ? real.slice(0, 6) : real.map((r, i) => (i === at ? value : r))), () => createRequest(store, draft));
    is(`${label}: not created`, made.ok ? "created" : made.reason, "unavailable");
    is(`(${label}: the store's requests are as before)`, await pipeline([["ZCARD", `nl:payreq:s:${store.sid}`]]), before);
  }
  const fine = await createRequest(store, draft);
  is("an exact read still creates", fine.ok, true);
}

main().then(done, (error) => {
  console.error(error);
  process.exit(1);
});
