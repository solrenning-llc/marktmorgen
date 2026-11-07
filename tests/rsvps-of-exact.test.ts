/**
 * The live events a member said they are coming to, for the copy of their data (lib/community-events.ts rsvpsOf,
 * lib/person-copy.ts), Claude 6 on #2957 (MÉDIO, privacy): read exactly (CX-123 rule 24). A reply from Redis in
 * another shape is never "no RSVPs" or "at 0": it throws, so the copy says it could not be read instead of coming
 * out silently without them. Synthetic data only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { rsvpsOf } from "@/lib/community-events";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";

type Command = (string | number)[];

const community = "0123456789abcdef0123456789abcdef";
const member = "fedcba9876543210fedcba9876543210";
const indexKey = `nl:cm:${community}:evs`;
const original = redis.pipeline;
const call = (c: Command[]) => original.call(redis, c);

async function seed() {
  redis.clear();
  await call([
    ["ZADD", indexKey, 1, "eventone"],
    ["ZADD", indexKey, 2, "eventtwo"],
    ["HSET", `nl:cm:${community}:ev:eventone:r`, member, "1700000000"],
  ]);
}

async function answered<T>(answer: (commands: Command[]) => Promise<unknown[]>, run: () => Promise<T>): Promise<T> {
  redis.pipeline = (async (commands: Command[]) => answer(commands)) as typeof redis.pipeline;
  try {
    return await run();
  } finally {
    redis.pipeline = original;
  }
}

const isIndex = (c: Command[]) => c.length === 1 && c[0][0] === "ZRANGEBYSCORE" && c[0][1] === indexKey;
const isRsvps = (c: Command[]) => c.length > 0 && c.every((x) => x[0] === "HGET");

test("the key names this test seeds are the ones rsvpsOf reads", async () => {
  await seed();
  const seen: Command[][] = [];
  const got = await answered(async (c) => (seen.push(c), call(c)), () => rsvpsOf(community, member));
  assert.ok(seen.some(isIndex), "the events' index is read");
  assert.deepEqual(got, [{ event: "eventone", at: 1700000000 }]);
});

// P1: the events' index in another shape.
const BAD_INDEX: [string, unknown[]][] = [
  ["text", ["eventone"]],
  ["null", [null]],
  ["object", [{}]],
  ["a number", [3]],
  ["a list with a number", [["eventone", 2]]],
  ["missing", []],
  ["two replies", [["eventone"], ["eventtwo"]]],
];
for (const [label, reply] of BAD_INDEX) {
  test(`P1: the events' index answered ${label}: unknown, never "no RSVPs"`, async () => {
    await seed();
    await assert.rejects(() => answered(async (c) => (isIndex(c) ? [...reply] : call(c)), () => rsvpsOf(community, member)), UnknownReplyError);
  });
}

// P1b: an RSVP's own reply in another shape.
const BAD_RSVP: [string, (good: unknown[]) => unknown[]][] = [
  ["a number", (good) => [1700000000, ...good.slice(1)]],
  ["an object", (good) => [{}, ...good.slice(1)]],
  ["text that is not a time", (good) => ["soon", ...good.slice(1)]],
  ["a negative time", (good) => ["-5", ...good.slice(1)]],
  ["a fraction", (good) => ["1.5", ...good.slice(1)]],
  ["one reply short", (good) => good.slice(1)],
  ["one reply too many", (good) => [...good, null]],
  ["a hole", (good) => { const out = [...good]; delete out[1]; return out; }],
];
for (const [label, change] of BAD_RSVP) {
  test(`P1b: an RSVP answered ${label}: unknown, never left out or at 0`, async () => {
    await seed();
    await assert.rejects(() => answered(async (c) => (isRsvps(c) ? change(await call(c)) : call(c)), () => rsvpsOf(community, member)), UnknownReplyError);
  });
}

test("confirmed absence: no events kept, no RSVPs", async () => {
  redis.clear();
  assert.deepEqual(await rsvpsOf(community, member), []);
});

test("confirmed absence: events kept, none answered by this member", async () => {
  await seed();
  await call([["HDEL", `nl:cm:${community}:ev:eventone:r`, member]]);
  assert.deepEqual(await rsvpsOf(community, member), []);
});
