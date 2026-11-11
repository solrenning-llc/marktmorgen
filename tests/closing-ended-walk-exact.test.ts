/**
 * Rule 24 for the daily walk of stores whose plan ended (lib/plan-closing.ts,
 * closeEnded, the ENDED_INDEX pages).
 *
 * The final-closing walk just before it already throws on a page that does
 * not read. The ended walk did not: `Array.isArray(raw) ? raw : []` took a
 * page out of shape for an empty one, so the run ended as if every store
 * whose plan ended had been looked at, deleted the place it had kept and
 * returned normally. A store past its plan was then neither held, told nor
 * closed (its buyers not refunded, its files kept at our cost), with nothing
 * failing for anyone to see, and the place a long line had reached was lost.
 * Now a page out of shape (not a list of strings, an odd length, a score that
 * is not a number) throws UnknownReplyError and the kept place stays.
 * Synthetic data only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { closeEnded } from "@/lib/plan-closing";
import { ENDED_INDEX } from "@/lib/plan-standing";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";

globalThis.fetch = (async (input: string | URL | Request) => {
  throw new Error(`no network in this test: ${String(input instanceof Request ? input.url : input)}`);
}) as typeof fetch;

const AFTER = "nl:plan:closing:after";
const HANDS = { measure: async () => 0, list: async () => [], remove: async () => {} };

/** The ended walk's page answers `reply`; every other command is the stub's. */
async function withEndedPage<T>(reply: () => unknown, run: () => Promise<T>): Promise<T> {
  const original = redis.pipeline;
  redis.pipeline = async (commands: (string | number)[][]) =>
    (commands[0]?.[0] === "ZRANGEBYSCORE" && commands[0]?.[1] === ENDED_INDEX ? reply() : original.call(redis, commands)) as Awaited<ReturnType<typeof original>>;
  try {
    return await run();
  } finally {
    redis.pipeline = original;
  }
}

const MALFORMED: [string, () => unknown][] = [
  ["no reply at all", () => []],
  ["a null in its slot", () => [null]],
  ["a number in its slot", () => [3]],
  ["an object in its slot", () => [{}]],
  ["a string in its slot", () => ["store:a"]],
  ["a list with a number in it", () => [[1, "5"]]],
  ["a list with a hole", () => [new Array(2)]],
  ["a member with no score", () => [["store:a"]]],
  ["a score that is not a number", () => [["store:a", "soon"]]],
  ["two replies for one command", () => [[], []]],
];

for (const [label, reply] of MALFORMED) {
  test(`the ended walk: ${label} is unknown, never the end of the line`, async () => {
    redis.clear();
    await redis.pipeline([["SET", AFTER, "1700000000000"]]);
    await withEndedPage(reply, () => assert.rejects(() => closeEnded(Number.POSITIVE_INFINITY, Date.now(), HANDS), UnknownReplyError));
    const [kept] = await redis.pipeline([["GET", AFTER]]);
    assert.equal(kept, "1700000000000", "the place a long line had reached is kept");
  });
}

test("the ended walk: a confirmed empty line ends the walk and lets the place go", async () => {
  redis.clear();
  await redis.pipeline([["SET", AFTER, "1700000000000"]]);
  assert.deepEqual(await closeEnded(Number.POSITIVE_INFINITY, Date.now(), HANDS), []);
  const [kept] = await redis.pipeline([["GET", AFTER]]);
  assert.equal(kept, null);
});
