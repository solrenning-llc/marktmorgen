/**
 * Codex L-20261120-0838 (MEDIUM, #5010 row 42): the refund sweep (lib/review-proof.ts markRefundedReviews) keeps the
 * Store and waits on Stripe's pages before marking each refunded review (lib/reviews.ts markRefunded, creatorChange).
 * When the store's erasure ended between the sweep's read of a review (HGET) and its writes, a plain HSET/ZADD wrote
 * the person's name, words, purchase reference and indexes, and the product's numbers, back after the closing walk
 * had passed them, with no live store left to clean them again. Now those writes go through the store's fence
 * (lib/live-fence.ts WRITE_IF_STORE_LIVE, one step with the fence's reads): a store erasing or gone meanwhile gets
 * nothing written, and the review is answered as missing. Synthetic store, product, reviews and Redis stand-in only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ReviewStoreGoneError, markRefunded, saveReview } from "@/lib/reviews";
import { markRefundedReviews } from "@/lib/review-proof";
import { setStripeAccount } from "@/lib/store";
import { storeLiveFence } from "@/lib/store-live-cache";
import { ERASING_KEY, claimHandle, closeStoreRecord, ensureStatsId, ensureStoreId, erasingField, storeForEmail, storeIdCommand, storeRef } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";

type Batch = (string | number)[][];
const original = redis.pipeline.bind(redis);
const PRODUCT = "synthbread01";
const NOW = 1_780_100_000_000;
const reviewRead = (batch: Batch) => batch.length === 1 && batch[0][0] === "HGET" && /^nl:rev:[0-9a-f]{32}:/.test(String(batch[0][1]));
const plainReviewWrite = (batch: Batch) => batch.some((c) => (c[0] === "HSET" || c[0] === "ZADD" || c[0] === "ZREM") && String(c[1]).startsWith("nl:rev:"));
const fencedWrite = (batch: Batch) => batch.length === 1 && batch[0][0] === "EVAL" && String(batch[0][1]).startsWith("-- marktmorgen:store-write-live:v1\n");

let shops = 0;
/** A store with an id and a statsId, one refundable review of its product, and the keys the closing walk deletes. */
async function shop() {
  shops += 1;
  const owner = `refund-row-${shops}@example.com`;
  await claimHandle(owner, `refundrow${shops}`, "Erased Shop", "Gone soon.");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  const store = (await storeForEmail(owner))!;
  const statsId = store.statsId!;
  const pi = `pi_refundrow${shops}`;
  const saved = await saveReview(statsId, { productId: PRODUCT, email: `buyer${shops}@example.com`, reference: `cs_test_refundrow${shops}0000`, pi, rating: 5, text: "Clear lessons.", name: "Ana", paidAt: 1_780_000_000 }, ROOM, NOW);
  assert.equal(saved.state, "created");
  const keys = [`nl:rev:${statsId}:${PRODUCT}`, `nl:rev:vis:${statsId}:${PRODUCT}`, `nl:rev:all:${statsId}`, `nl:rev:sum:${statsId}`, `nl:rev:new:${statsId}`, `nl:rev:pay:${statsId}`];
  return { store, statsId, pi, keys, fence: await storeLiveFence(store), field: await erasingField(storeRef(store)) };
}

/** Runs `during` once the sweep has read the review and before it writes, and records how the writes went. */
async function racing(during: () => Promise<void>, mark: () => Promise<number>) {
  let reads = 0;
  let plainWrites = 0;
  const answers: unknown[] = [];
  redis.pipeline = (async (batch: Batch) => {
    if (plainReviewWrite(batch)) plainWrites += 1;
    const reply = await original(batch);
    if (reviewRead(batch)) {
      reads += 1;
      if (reads === 1) await during();
    }
    if (fencedWrite(batch)) answers.push((reply as unknown[])[0]);
    return reply;
  }) as typeof redis.pipeline;
  try {
    return { marked: await mark(), plainWrites, answers };
  } catch (error) {
    return { error, plainWrites, answers };
  } finally {
    redis.pipeline = original;
  }
}

const exists = async (keys: string[]) => (await original(keys.map((key) => ["EXISTS", key]))).map(Number);
const row = async (statsId: string) => {
  const raw = (await original([["HGETALL", `nl:rev:${statsId}:${PRODUCT}`]]))[0] as string[];
  return raw.length ? (JSON.parse(raw[1]) as { refunded?: boolean; name?: string }) : null;
};

test("control: a live store's refunded review is marked through the fence, never by a plain write", async () => {
  const { statsId, pi, fence } = await shop();
  const live = await racing(async () => undefined, () => markRefunded(statsId, pi, fence));
  assert.deepEqual([live.marked, live.plainWrites, live.answers], [1, 0, [1, 1]], "the review and the product's numbers, each written once the fence answered 1");
  assert.equal((await row(statsId))?.refunded, true);
});

test("a store erasing after the sweep's read gets nothing written, and the review is as the walk will find it", async () => {
  const { statsId, pi, fence, field } = await shop();
  const erasing = await racing(
    async () => { await original([["HSET", ERASING_KEY, field, String(NOW)]]); },
    () => markRefunded(statsId, pi, fence),
  );
  await original([["HDEL", ERASING_KEY, field]]);
  assert.ok(erasing.error instanceof ReviewStoreGoneError, "the mark says the store is gone, so the sweep writes nothing more");
  assert.deepEqual([erasing.marked, erasing.plainWrites, erasing.answers], [undefined, 0, [0]], "the fenced write answered gone, nothing marked, no plain write");
  assert.equal((await row(statsId))?.refunded, false, "the review is untouched, for the closing walk");
});

test("a store closed after the sweep's read: the review, its indexes and the product's numbers stay gone (Codex L-20261120-0838)", async () => {
  const { store, statsId, pi, fence, keys } = await shop();
  const closed = await racing(
    async () => {
      const done = await closeStoreRecord(store, keys);
      if (!done) throw new Error("synthetic close did not complete");
    },
    () => markRefunded(statsId, pi, fence),
  );
  assert.equal((await original([storeIdCommand(store.sid)]))[0], null, "control: the store's id key is gone");
  assert.ok(closed.error instanceof ReviewStoreGoneError, "the mark says the store is gone");
  assert.deepEqual([closed.marked, closed.plainWrites, closed.answers], [undefined, 0, [0]], "the fenced write answered gone, nothing marked, no plain write");
  assert.deepEqual(await exists(keys), keys.map(() => 0), "no review row, index, queue, payment list or summary came back");
});

test("without a fence (the creator's own actions), the writes are as before", async () => {
  const { statsId, pi } = await shop();
  const plain = await racing(async () => undefined, () => markRefunded(statsId, pi));
  assert.deepEqual([plain.marked, plain.answers], [1, []]);
  assert.ok(plain.plainWrites >= 1, "written in a plain request");
  assert.equal((await row(statsId))?.refunded, true);
});

// Claude 1 c1-revisoes-f's MÉDIO on #5092: the whole pass, with the store closed in the middle. The sweep used to take
// the refund as seen (SADD + EXPIRE), confirm the lost disputes' place and set its anchor after the mark came back
// "gone", so nl:rev:refunds:seenat:<statsId> (with the refund's id) and nl:rev:refunds:since:<statsId> came back after
// the closing walk passed them. Now a gone store stops the pass before any of those writes.
process.env.STRIPE_SECRET_KEY = "sk_test_review_refund_row_sweep";
const refundsAt: { id: string; object: "refund"; created: number; status: string; amount: number; payment_intent: string; charge: Record<string, unknown> }[] = [];
const listOf = (data: unknown[]) => new Response(JSON.stringify({ object: "list", data, has_more: false }), { status: 200 });
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname !== "api.stripe.com") return new Response(JSON.stringify({ error: "nothing leaves this test" }), { status: 500 });
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/refunds") {
    if (duringRefunds) {
      const run = duringRefunds;
      duringRefunds = null;
      await run();
    }
    const since = Number(url.searchParams.get("created[gte]") ?? 0);
    return listOf(refundsAt.filter((r) => r.created >= since));
  }
  return listOf([]);
}) as typeof fetch;
/** Run once, while Stripe's refunds are being read, before the pass has read any review. */
let duringRefunds: (() => Promise<void>) | null = null;
const refundOf = (pi: string, n: number) => ({ id: `re_rowsweep${String(n).padStart(6, "0")}`, object: "refund" as const, created: Math.floor(Date.now() / 1000) - 7_200, status: "succeeded", amount: 4900, payment_intent: pi, charge: { object: "charge", id: `ch_rowsweep${n}`, amount: 4900, amount_refunded: 4900, refunded: true, disputed: false } });

test("the whole pass, with the store closed after its read: the read refunds and the anchor stay gone too (Claude 1 on #5092)", async () => {
  const { store, statsId, pi, keys } = await shop();
  await setStripeAccount(store.email, "acct_1RowSweep1", true);
  const swept = (await storeForEmail(store.email))!;
  refundsAt.push(refundOf(pi, 1));
  const seen = `nl:rev:refunds:seenat:${statsId}`;
  const since = `nl:rev:refunds:since:${statsId}`;
  const closed = await racing(
    async () => {
      const done = await closeStoreRecord(swept, [...keys, seen, since]);
      if (!done) throw new Error("synthetic close did not complete");
    },
    () => markRefundedReviews(swept, Date.now() + 60_000),
  );
  assert.equal((await original([storeIdCommand(swept.sid)]))[0], null, "control: the store's id key is gone");
  assert.deepEqual([closed.marked, closed.plainWrites, closed.answers], [0, 0, [0]], "the mark answered gone, nothing marked, no plain write");
  assert.deepEqual(await exists([...keys, seen, since]), [...keys, seen, since].map(() => 0), "no review row, index, summary, read refund or anchor came back");
});

test("control: a live store's pass takes the refund as seen and keeps its anchor", async () => {
  const { store, statsId, pi } = await shop();
  await setStripeAccount(store.email, "acct_1RowSweep2", true);
  const swept = (await storeForEmail(store.email))!;
  refundsAt.length = 0;
  refundsAt.push(refundOf(pi, 2));
  const live = await racing(async () => undefined, () => markRefundedReviews(swept, Date.now() + 60_000));
  assert.deepEqual([live.marked, live.plainWrites, live.answers], [1, 0, [1, 1, 1, 1]], "the review, the product's numbers, the read refund and the anchor, each through the fence");
  assert.deepEqual(await exists([`nl:rev:refunds:seenat:${statsId}`, `nl:rev:refunds:since:${statsId}`]), [1, 1], "the read refund and the anchor are kept");
});

test("a store erasing before the page's rows are counted gets no count of the month written, and the pass stops (10th audit, LEVE 5)", async () => {
  const { store, statsId, pi, field } = await shop();
  await setStripeAccount(store.email, "acct_1RowSweep4", true);
  const swept = (await storeForEmail(store.email))!;
  refundsAt.length = 0;
  refundsAt.push(refundOf(pi, 4));
  await original([["HSET", ERASING_KEY, field, String(NOW)]]);
  const month = new Date().toISOString().slice(0, 7);
  const erasing = await racing(async () => undefined, () => markRefundedReviews(swept, Date.now() + 60_000));
  await original([["HDEL", ERASING_KEY, field]]);
  assert.deepEqual([erasing.marked, erasing.plainWrites], [0, 0], "nothing marked, no plain write");
  assert.deepEqual(await exists([`nl:rev:refunds:rows:${statsId}:${month}`, `nl:rev:refunds:marks:${statsId}:${month}`, `nl:rev:refunds:seenat:${statsId}`]), [0, 0, 0], "no count of the month, no payment taken, no seen row: the count went through the fence and answered gone");
});

test("the store closed during the Stripe read, before any review was read: the read refunds and the anchor stay gone (Claude 1 E on #5092)", async () => {
  const { store, statsId, pi, keys } = await shop();
  await setStripeAccount(store.email, "acct_1RowSweep3", true);
  const swept = (await storeForEmail(store.email))!;
  refundsAt.length = 0;
  refundsAt.push(refundOf(pi, 3));
  const seen = `nl:rev:refunds:seenat:${statsId}`;
  const since = `nl:rev:refunds:since:${statsId}`;
  duringRefunds = async () => {
    const done = await closeStoreRecord(swept, [...keys, seen, since]);
    if (!done) throw new Error("synthetic close did not complete");
  };
  const closed = await racing(async () => undefined, () => markRefundedReviews(swept, Date.now() + 60_000));
  assert.equal(duringRefunds, null, "control: the store was closed while Stripe was read");
  assert.equal((await original([storeIdCommand(swept.sid)]))[0], null, "control: the store's id key is gone");
  assert.deepEqual([closed.error, closed.marked, closed.plainWrites], [undefined, 0, 0], "the pass ends with nothing marked and no plain write");
  assert.deepEqual(await exists([...keys, seen, since]), [...keys, seen, since].map(() => 0), "no read refund, anchor, review or index came back");
});
