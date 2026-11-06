/**
 * PayPal's refunds and kept counts read only in Redis's exact shape (CX-123 rule 24, rule 30; LEVE).
 *
 * readPayPalRefundsWithCoverage reads the refunded marks with ZRANGEBYSCORE ... WITHSCORES (member, score pairs,
 * the score whole seconds as the watch writes it with String(now)) and their records with one MGET; paypalKept
 * reads ZCARDs. A reply that is missing, cut short, of odd length, with a score that is not whole seconds, or with
 * a slot too many is unknown: it is refused, never read as "no refunds", a refund at 0, or a count of 0. A key that
 * is not there (an empty list, a ZCARD of 0) is a known "none". Synthetic data only, written as the writers write it.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { paypalKept, readPayPalRefundsWithCoverage } from "@/lib/paypal-sales";
import { store as redis } from "./redis-stub";

const sid = "synthetic-paypal-refunds-exact";
const ORDER = "5O190127TN3647101";
const AT = 1_760_356_800;
const paid = { store: sid, order: ORDER, capture: "3C679366HH908701", email: "buyer@example.com", product: "p1", cents: 1500, currency: "usd", at: AT - 3600 };

redis.clear();
const fixture = (async () => {
  // As settle writes the record (SET ... NX EX) and the watch writes the refunded mark (ZADD with String(now)).
  await redis.pipeline([["SET", `nl:ppsell:paid:${ORDER}`, JSON.stringify(paid), "NX", "EX", 86_400]]);
  await redis.pipeline([["ZADD", `nl:ppsell:refunded:${sid}`, String(AT), ORDER]]);
  await redis.pipeline([["ZADD", `nl:ppsell:sales:${sid}`, String(AT - 3600), ORDER]]);
})();

/** The stand-in, with the reply to one command replaced. */
async function withReply<T>(command: string, reply: () => unknown[], run: () => Promise<T>): Promise<T> {
  const original = redis.pipeline;
  redis.pipeline = (async (commands: (string | number)[][]) => (commands[0]?.[0] === command ? reply() : original.call(redis, commands))) as typeof redis.pipeline;
  try {
    return await run();
  } finally {
    redis.pipeline = original;
  }
}

test("controls: the writers' own data reads exactly, and a store with none reads as none", async () => {
  await fixture;
  assert.deepEqual(await readPayPalRefundsWithCoverage(sid, AT - 86_400), {
    rows: [{ order: ORDER, capture: paid.capture, cents: 1500, currency: "usd", at: AT }],
    partial: false,
  });
  assert.deepEqual(await readPayPalRefundsWithCoverage("synthetic-paypal-refunds-none", 0), { rows: [], partial: false });
  assert.deepEqual(await paypalKept(sid, true), { sales: 1, refunds: 1 });
  assert.deepEqual(await paypalKept(sid, false), { sales: 1, refunds: 0 });
  assert.deepEqual(await paypalKept("synthetic-paypal-refunds-none", true), { sales: 0, refunds: 0 });
});

const ranges: [string, () => unknown[]][] = [
  ["a missing envelope", () => []],
  ["a null list", () => [null]],
  ["a string for the list", () => ["x"]],
  ["an odd-length list", () => [[ORDER]]],
  ["an odd-length list after a pair", () => [[ORDER, String(AT), ORDER]]],
  ["a score that is not a number", () => [[ORDER, "abc"]]],
  ["a fractional score", () => [[ORDER, "1.5"]]],
  ["a negative score", () => [[ORDER, "-5"]]],
  ["a zero score", () => [[ORDER, "0"]]],
  ["an empty score", () => [[ORDER, ""]]],
  ["a numeric score, not text", () => [[ORDER, AT]]],
  ["a member that is not text", () => [[42, String(AT)]]],
  ["a slot too many in the envelope", () => [[ORDER, String(AT)], "extra"]],
];
for (const [label, reply] of ranges) {
  test(`the refund list rejects ${label} rather than reading no refunds or a refund at 0`, async () => {
    await fixture;
    await withReply("ZRANGEBYSCORE", reply, () => assert.rejects(() => readPayPalRefundsWithCoverage(sid, AT - 86_400)));
  });
}

const records: [string, () => unknown[]][] = [
  ["a missing envelope", () => []],
  ["a null list", () => [null]],
  ["a list one short", () => [[]]],
  ["a list one too long", () => [[JSON.stringify(paid), null]]],
  ["a record that is not text", () => [[42]]],
  ["a slot too many in the envelope", () => [[JSON.stringify(paid)], "extra"]],
];
for (const [label, reply] of records) {
  test(`the refunds' records reject ${label} rather than reading them as missing`, async () => {
    await fixture;
    await withReply("MGET", reply, () => assert.rejects(() => readPayPalRefundsWithCoverage(sid, AT - 86_400)));
  });
}

const counts: [string, boolean, () => unknown[]][] = [
  ["a missing envelope", true, () => []],
  ["a reply cut short", true, () => [1]],
  ["a null count", true, () => [1, null]],
  ["a count as text", true, () => ["1", 1]],
  ["a negative count", true, () => [-1, 1]],
  ["a fractional count", true, () => [1.5, 1]],
  ["a slot too many", false, () => [1, 1]],
];
for (const [label, refunds, reply] of counts) {
  test(`the kept counts reject ${label} rather than counting 0`, async () => {
    await fixture;
    await withReply("ZCARD", reply, () => assert.rejects(() => paypalKept(sid, refunds)));
  });
}
