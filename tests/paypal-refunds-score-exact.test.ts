/**
 * PayPal refunds as the numbers read them (lib/paypal-sales.ts, readPayPalRefundsWithCoverage): the refunded-sales
 * ZSET is read in its exact shape (CX-123 rules 24 and 30). A score that is not whole seconds, as the refund sweep
 * writes it, is unknown and throws UnknownReplyError, never a refund dated 0; a reply that is not the list asked for
 * throws too, never "no refunds". Synthetic data only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readPayPalRefunds, readPayPalRefundsWithCoverage } from "@/lib/paypal-sales";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";

const STATS = "st_synthetic_refund_score";
const ORDER = "SYNTHORDER0001";
const AT = 1_760_356_800;
const SINCE = AT - 86_400;
const record = JSON.stringify({ store: STATS, order: ORDER, capture: "SYNTHCAPTURE01", cents: 1200, currency: "USD" });

redis.clear();
const fixture = redis.pipeline([
  ["SET", `nl:ppsell:paid:${ORDER}`, record],
  ["ZADD", `nl:ppsell:refunded:${STATS}`, AT, ORDER],
]);

/** Answers the refunded-sales ZRANGEBYSCORE with `reply`; every other command reaches the stand-in. */
async function withRefundList<T>(reply: unknown, run: () => Promise<T>): Promise<T> {
  await fixture;
  const original = redis.pipeline;
  redis.pipeline = async (commands) =>
    commands.length === 1 && commands[0][0] === "ZRANGEBYSCORE" && String(commands[0][1]).startsWith("nl:ppsell:refunded:") ? [reply] : original.call(redis, commands);
  try {
    return await run();
  } finally {
    redis.pipeline = original;
  }
}

test("a healthy refund is read with its own date", async () => {
  await fixture;
  assert.deepEqual(await readPayPalRefundsWithCoverage(STATS, SINCE), {
    rows: [{ order: ORDER, capture: "SYNTHCAPTURE01", cents: 1200, currency: "USD", at: AT }],
    partial: false,
  });
});

test("a store with no refunds is a known empty reading, and no store reads nothing", async () => {
  await fixture;
  assert.deepEqual(await readPayPalRefundsWithCoverage("st_synthetic_no_refunds", SINCE), { rows: [], partial: false });
  assert.deepEqual(await readPayPalRefundsWithCoverage(null, SINCE), { rows: [], partial: false });
});

for (const [label, score] of [
  ["text", "soon"],
  ["empty", ""],
  ["spaces", " "],
  ["hex", "0x10"],
  ["overflow", "1e309"],
  ["infinity", "inf"],
  ["fraction", "1760356800.5"],
  ["zero", "0"],
  ["negative", "-5"],
  ["newline", `${AT}\n`],
  ["number, not text", AT],
  ["null", null],
  ["before the range asked", String(SINCE - 1)],
] as const) {
  test(`a refund score that is ${label} throws, never a refund dated 0`, async () => {
    await withRefundList([ORDER, score], () => assert.rejects(() => readPayPalRefundsWithCoverage(STATS, SINCE), UnknownReplyError));
  });
}

for (const [label, reply] of [
  ["null", null],
  ["an object", {}],
  ["a member without its score", [ORDER]],
  ["a member that is not text", [7, String(AT)]],
  ["longer than asked", Array.from({ length: 2 * 502 }, (_, i) => (i % 2 ? String(AT) : `SYNTHORDER${String(i).padStart(4, "0")}`))],
] as const) {
  test(`a refund list that is ${label} throws, never "no refunds"`, async () => {
    await withRefundList(reply, () => assert.rejects(() => readPayPalRefundsWithCoverage(STATS, SINCE), UnknownReplyError));
  });
}

test("a confirmed empty list stays a complete reading, a well-formed list reads as before", async () => {
  assert.deepEqual(await withRefundList([], () => readPayPalRefundsWithCoverage(STATS, SINCE)), { rows: [], partial: false });
  assert.deepEqual(await withRefundList([ORDER, String(AT)], () => readPayPalRefundsWithCoverage(STATS, SINCE)), {
    rows: [{ order: ORDER, capture: "SYNTHCAPTURE01", cents: 1200, currency: "USD", at: AT }],
    partial: false,
  });
});

/** Answers the paid records' MGET with `replies` (the whole pipeline answer); every other command reaches the stand-in. */
async function withRecords<T>(replies: unknown[], run: () => Promise<T>): Promise<T> {
  await fixture;
  const original = redis.pipeline;
  redis.pipeline = async (commands) => (commands.length === 1 && commands[0][0] === "MGET" ? [...replies] : original.call(redis, commands));
  try {
    return await run();
  } finally {
    redis.pipeline = original;
  }
}

const recordWith = (change: Record<string, unknown>) => JSON.stringify({ ...JSON.parse(record), ...change });

// Codex Z on #2964: the MGET of the refunded sales' records is read in its exact shape, and every field a refund row
// exposes is checked, so a malformed financial record throws before the numbers or the affiliate book use it as complete.
for (const [label, replies] of [
  ["no reply", []],
  ["an extra reply", [[record], [record]]],
  ["records not a list", [{}]],
  ["records null", [null]],
  ["no record for the one asked", [[]]],
  ["two records for the one asked", [[record, record]]],
  ["a record that is a number", [[1200]]],
  ["a record that is not JSON", [["{not json"]]],
  ["a record that is a JSON list", [["[1,2]"]]],
  ["another order's record", [[recordWith({ order: "SYNTHORDER0002" })]]],
  ["cents as text", [[recordWith({ cents: "1200" })]]],
  ["cents negative", [[recordWith({ cents: -1 })]]],
  ["cents a fraction", [[recordWith({ cents: 12.5 })]]],
  ["a null capture", [[recordWith({ capture: null })]]],
  ["a capture that is not one", [[recordWith({ capture: "bad capture!" })]]],
  ["the currency an object", [[recordWith({ currency: {} })]]],
  ["the currency not three letters", [[recordWith({ currency: "US" })]]],
] as [string, unknown[]][]) {
  test(`the refunded sales' records: ${label} throws, never a refund row read as complete`, async () => {
    await withRecords(replies, () => assert.rejects(() => readPayPalRefundsWithCoverage(STATS, SINCE), UnknownReplyError));
  });
}

test("the refunded sales' records: a record confirmed missing is a partial reading; an exact one reads as before", async () => {
  assert.deepEqual(await withRecords([[null]], () => readPayPalRefundsWithCoverage(STATS, SINCE)), { rows: [], partial: true });
  assert.deepEqual(await withRecords([[record]], () => readPayPalRefundsWithCoverage(STATS, SINCE)), {
    rows: [{ order: ORDER, capture: "SYNTHCAPTURE01", cents: 1200, currency: "USD", at: AT }],
    partial: false,
  });
});

// The affiliate book reads readPayPalRefunds (lib/affiliates.ts): a partial reading is not every refund, so it throws
// there and the book sets refundsChecked = false, and no commission is paid on a sale whose refund was not read.
test("readPayPalRefunds: a partial reading throws, never 'these are all the refunds'; a complete one is its rows", async () => {
  await withRecords([[null]], () => assert.rejects(() => readPayPalRefunds(STATS, SINCE)));
  assert.deepEqual(await readPayPalRefunds(STATS, SINCE), [{ order: ORDER, capture: "SYNTHCAPTURE01", cents: 1200, currency: "USD", at: AT }]);
  assert.deepEqual(await readPayPalRefunds("st_synthetic_no_refunds", SINCE), []);
});
