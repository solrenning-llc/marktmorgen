/**
 * Who is coming to a live event is read in its exact shape (CX-123 rule 24; Claude 5 on #2954): a page of HSCAN that
 * answers in another shape throws UnknownReplyError, never "nobody else", so a reminder or a cancellation is never
 * written down for only part of the people coming. An event nobody answered is an empty list. Synthetic data only.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { rsvpList } from "@/lib/community-events";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";

const COMMUNITY = "a".repeat(32);
const EVENT = "b".repeat(12);
const key = `nl:cm:${COMMUNITY}:ev:${EVENT}:r`;
const ONE = "c".repeat(32);
const TWO = "d".repeat(32);

type Batch = (string | number)[][];
async function withPages(pages: ((batch: Batch, answers: unknown[]) => unknown[])[], run: () => Promise<unknown>): Promise<{ value?: unknown; error?: unknown }> {
  const original = redis.pipeline.bind(redis);
  let page = 0;
  redis.pipeline = (async (batch: Batch) => {
    const answers = await original(batch);
    const alter = pages[page];
    page += 1;
    return alter ? alter(batch, answers) : answers;
  }) as typeof redis.pipeline;
  try {
    return { value: await run() };
  } catch (error) {
    return { error };
  } finally {
    redis.pipeline = original;
  }
}

test("healthy: everyone coming, in the order they said so", async () => {
  redis.clear();
  redis.run(["HSET", key, TWO, "20", ONE, "10"]);
  assert.deepEqual(await rsvpList(COMMUNITY, EVENT), [{ key: ONE, at: 10 }, { key: TWO, at: 20 }]);
});

test("confirmed absence: an event nobody answered is an empty list", async () => {
  redis.clear();
  assert.deepEqual(await rsvpList(COMMUNITY, EVENT), []);
});

test("healthy: a second page is read and joined", async () => {
  redis.clear();
  const result = await withPages(
    [() => [["7", [ONE, "10"]]], () => [["0", [TWO, "20"]]]],
    () => rsvpList(COMMUNITY, EVENT),
  );
  assert.deepEqual(result.value, [{ key: ONE, at: 10 }, { key: TWO, at: 20 }]);
});

for (const [label, reply] of [
  ["no reply", []],
  ["undefined", [undefined]],
  ["text", ["QUEUED"]],
  ["a cursor alone", [["0"]]],
  ["a page that is not a list", [["0", "nope"]]],
  ["a page with an odd count", [["0", [ONE]]]],
  ["a number for a member", [["0", [7, "10"]]]],
  ["a cursor that is not a cursor", [[{}, [ONE, "10"]]]],
] as [string, unknown[]][]) {
  test(`${label} on the first page throws, never "nobody coming"`, async () => {
    redis.clear();
    redis.run(["HSET", key, ONE, "10"]);
    const result = await withPages([() => reply], () => rsvpList(COMMUNITY, EVENT));
    assert.ok(result.error instanceof UnknownReplyError, `threw UnknownReplyError, not ${JSON.stringify(result.value)}`);
  });
  test(`${label} on a second page throws, never only the first page`, async () => {
    redis.clear();
    const result = await withPages([() => [["7", [ONE, "10"]]], () => reply], () => rsvpList(COMMUNITY, EVENT));
    assert.ok(result.error instanceof UnknownReplyError, `threw UnknownReplyError, not ${JSON.stringify(result.value)}`);
  });
}
