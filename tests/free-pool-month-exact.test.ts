/**
 * The month's free places as the owner's own checks show them
 * (lib/free-pool.ts, poolThisMonth; rule 24): the places handed out (GET of the
 * month's counter) and how many there are (from SCARD of the paying stores),
 * each read exactly. A counter that is not there is none handed out; a reply in
 * any other shape is unknown and shown as unknown (null), never as 0 places
 * taken nor as the smallest pool.
 *
 * Synthetic only: the in-memory Redis, its pipeline answered by hand.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { calendarWindow } from "@/lib/allowance-window";
import { poolThisMonth } from "@/lib/free-pool";
import { FREE_POOL_BASE_STORES, PAID_STORES_PER_FREE_STORE, PAYING_INDEX, freePoolSize } from "@/lib/free-pool-rules";
import { store as redis } from "./redis-stub";

const NOW = Date.now();
const COUNTER = `nl:free:n:${calendarWindow(NOW).id}`;

/** Runs `read` with the month's reading (GET, SCARD) answered by `reply`; every other call goes to the stub. */
async function answered<T>(reply: unknown, read: () => Promise<T>): Promise<T> {
  const original = redis.pipeline;
  redis.pipeline = (async (commands: (string | number)[][]) =>
    commands.length === 2 && commands[0]?.[0] === "GET" && commands[0]?.[1] === COUNTER && commands[1]?.[0] === "SCARD"
      ? reply
      : original(commands)) as typeof redis.pipeline;
  try {
    return await read();
  } finally {
    redis.pipeline = original;
  }
}

const UNKNOWN_COUNT: [string, unknown][] = [
  ["text that is not a whole number", "abc"],
  ["text below zero", "-1"],
  ["text with a fraction", "1.5"],
  ["a number below zero", -1],
  ["a fraction", 1.5],
  ["true", true],
  ["an object", {}],
  ["a list", ["3"]],
  ["nothing (undefined)", undefined],
];
const UNKNOWN_SCARD: [string, unknown][] = [
  ["text", "2"],
  ["null", null],
  ["a number below zero", -1],
  ["a fraction", 1.5],
  ["true", true],
  ["an object", {}],
  ["nothing (undefined)", undefined],
];

beforeEach(() => redis.clear());

test("read exactly: the places taken and the pool's size, a missing counter being none taken", async () => {
  assert.deepEqual(await poolThisMonth(NOW), { taken: 0, size: FREE_POOL_BASE_STORES }, "nothing yet: none taken, the base pool");
  await redis.pipeline([["SET", COUNTER, "3"], ...Array.from({ length: PAID_STORES_PER_FREE_STORE }, (_, i) => ["SADD", PAYING_INDEX, `payer${i}`])]);
  assert.deepEqual(await poolThisMonth(NOW), { taken: 3, size: freePoolSize(PAID_STORES_PER_FREE_STORE) }, "the counter and the paying stores");
  assert.deepEqual(await answered([7, 0], () => poolThisMonth(NOW)), { taken: 7, size: FREE_POOL_BASE_STORES }, "a counter answered as a number");
});

test("a counter in an unknown shape is shown as unknown, never as none taken", async () => {
  for (const [label, reply] of UNKNOWN_COUNT) {
    assert.deepEqual(await answered([reply, 0], () => poolThisMonth(NOW)), { taken: null, size: FREE_POOL_BASE_STORES }, label);
  }
});

test("the paying stores in an unknown shape: the pool's size is unknown, never the smallest", async () => {
  for (const [label, reply] of UNKNOWN_SCARD) {
    assert.deepEqual(await answered(["3", reply], () => poolThisMonth(NOW)), { taken: 3, size: null }, label);
  }
});

test("an answer cut short or not a list: both unknown", async () => {
  for (const [label, reply] of [["empty", []], ["one reply of two", ["3"]], ["three replies", ["3", 0, 0]], ["null", null], ["an object", {}]] as [string, unknown][]) {
    assert.deepEqual(await answered(reply, () => poolThisMonth(NOW)), { taken: null, size: null }, label);
  }
});
