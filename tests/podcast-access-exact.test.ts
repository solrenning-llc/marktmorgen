/**
 * A private podcast feed's access reads Redis only in its exact shape (CX-123 rules 24 and 30; Claude 4's sweep of
 * lib/podcast-access.ts). The erasure and the copy are in tests/podcast-erasure-exact.test.ts; this file holds what
 * decides a write, an access and a count:
 *
 *   - feedToken: an unknown read of the address's index is never "no feed yet", so it never writes a new index and
 *     grant; an unknown reply to the grant's write is never "made", so no link to a grant that may not exist is given.
 *   - readFeedToken: an unknown read of a grant is never "no such feed" (the feed route would answer 404, which a
 *     podcast app may take as the feed being gone for good): it throws, and the route answers a server error.
 *   - feedReadAllowed: a count that cannot be read or kept never lets the feed through past FEED_READS_A_DAY.
 *
 * Synthetic only: an in-memory Redis, no provider.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { FEED_READS_A_DAY, feedReadAllowed, feedToken, readFeedToken } from "@/lib/podcast-access";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

type Pipeline = typeof redis.pipeline;
const OWNER = "podcast-access-exact@example.test";
const original: Pipeline = redis.pipeline.bind(redis);

async function world() {
  redis.clear();
  redis.pipeline = original;
  await claimHandle(OWNER, "podaccess", "Podcast Access", "");
  await ensureStoreId(OWNER); await ensureStatsId(OWNER); await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_PodAccess", subscriptionId: "sub_PodAccess", active: true, tier: "pro", period: paidPeriod() });
  const made = await addProduct(OWNER, "Synthetic Radio", "", "19", null);
  assert.ok(made.ok);
  return { id: made.product.id, store: async () => (await storeForEmail(OWNER))! };
}

type Commands = (string | number)[][];
const one = (commands: Commands, name: string, prefix: string) =>
  commands.length === 1 && commands[0][0] === name && String(commands[0][1]).startsWith(prefix);
const grants = () => redis.keys().filter((k) => k.startsWith("nl:pod:t:")).length;
const indexes = () => redis.keys().filter((k) => k.startsWith("nl:pod:by:")).length;
const isGrantWrite = (commands: Commands) =>
  commands.length === 1 && commands[0][0] === "EVAL" && commands[0].some((x) => String(x).startsWith("nl:pod:t:"));

function answer(when: (commands: Commands) => boolean, reply: () => unknown) {
  redis.pipeline = (async (commands: Commands) => (when(commands) ? reply() : original(commands))) as Pipeline;
}

const unknownOne: [string, () => unknown][] = [
  ["no reply", () => []],
  ["a number", () => [5]],
  ["an object", () => [{}]],
  ["a list", () => [[]]],
  ["undefined", () => [undefined]],
  ["true", () => [true]],
  ["one reply too many", () => [null, null]],
  ["a hole", () => new Array(1)],
  ["not a list", () => null],
];

test("healthy control: a first feed writes one index and one grant, and the same address keeps it", async () => {
  const { id, store } = await world();
  const token = await feedToken(await store(), id, "ana@example.test");
  assert.equal(typeof token, "string");
  assert.equal(indexes(), 1);
  assert.equal(grants(), 1);
  assert.equal(await feedToken(await store(), id, "ana@example.test"), token);
  assert.equal((await readFeedToken(token!))?.e, "ana@example.test");
});

for (const [label, reply] of unknownOne) test(`a feed's index read answered as ${label} is never "no feed yet": nothing is written`, async () => {
  const { id, store } = await world();
  answer((c) => one(c, "GET", "nl:pod:by:"), reply);
  let token: unknown;
  try {
    token = await feedToken(await store(), id, "ben@example.test").catch((error: unknown) => error);
  } finally { redis.pipeline = original; }
  assert.ok(typeof token !== "string", "no feed is handed out on an unknown read");
  assert.equal(indexes(), 0, "no index is written");
  assert.equal(grants(), 0, "no grant holding the address is written");
});

for (const [label, value] of [["a number", 5], ["undefined", undefined], ["a word", "QUEUED"], ["true", true], ["null", null]] as const) {
  test(`a feed's grant write answered as ${label} hands out no link`, async () => {
    const { id, store } = await world();
    redis.pipeline = (async (commands: Commands) => (isGrantWrite(commands) ? [[0, value]] : original(commands))) as Pipeline;
    let token: unknown;
    try {
      token = await feedToken(await store(), id, "cleo@example.test").catch((error: unknown) => error);
    } finally { redis.pipeline = original; }
    assert.ok(typeof token !== "string", "a link to a grant that may not exist is never given");
  });
}

test("healthy control: a token with no grant is no feed, and a stored grant is read", async () => {
  const { id, store } = await world();
  assert.equal(await readFeedToken("a".repeat(48)), null, "a confirmed miss is a real 'no such feed'");
  const token = (await feedToken(await store(), id, "dana@example.test"))!;
  assert.deepEqual(await readFeedToken(token), { s: (await store()).statsId, h: "podaccess", p: id, e: "dana@example.test" });
});

for (const [label, reply] of unknownOne) test(`a feed's grant read answered as ${label} is never "no such feed"`, async () => {
  const { id, store } = await world();
  const token = (await feedToken(await store(), id, "eli@example.test"))!;
  answer((c) => one(c, "GET", "nl:pod:t:"), reply);
  try {
    await assert.rejects(readFeedToken(token), UnknownReplyError);
  } finally { redis.pipeline = original; }
  assert.equal((await readFeedToken(token))?.e, "eli@example.test");
});

test(`healthy control: a feed is put together ${FEED_READS_A_DAY} times a day and refused after, with the day's key kept two days`, async () => {
  redis.clear();
  redis.pipeline = original;
  const token = "b".repeat(48);
  const now = Date.UTC(2026, 10, 6, 12);
  for (let i = 0; i < FEED_READS_A_DAY; i++) assert.equal(await feedReadAllowed(token, now), true);
  assert.equal(await feedReadAllowed(token, now), false);
  const key = redis.keys().find((k) => k.startsWith("nl:pod:n:"))!;
  const [ttl] = await original([["TTL", key]]);
  assert.ok(typeof ttl === "number" && ttl > 86_400, "the day's count expires");
});

// The count is sent with its expiry in one request (INCR, EXPIRE NX), so each reply is the whole request's: the
// count's slot unknown beside a good expiry, or the wrong number of replies.
const unknownCounts: [string, () => unknown][] = [
  ["no reply", () => []],
  ["null", () => [null, 1]],
  ["a string", () => ["3", 1]],
  ["a list", () => [[], 1]],
  ["undefined", () => [undefined, 1]],
  ["a fraction", () => [1.5, 1]],
  ["a negative", () => [-1, 1]],
  ["true", () => [true, 1]],
  ["only the count", () => [1]],
  ["one reply too many", () => [1, 1, 1]],
  ["not a list", () => null],
];
const isDayCount = (commands: Commands) => commands[0]?.[0] === "INCR" && String(commands[0][1]).startsWith("nl:pod:n:");

for (const [label, reply] of unknownCounts) test(`a feed's day count answered as ${label} never lets the feed through`, async () => {
  redis.clear();
  answer(isDayCount, reply);
  try {
    await assert.rejects(feedReadAllowed("c".repeat(48)), UnknownReplyError);
  } finally { redis.pipeline = original; }
});

test("a feed's day count that cannot be kept at all never lets the feed through", async () => {
  redis.clear();
  redis.pipeline = (async () => { throw new Error("Redis request failed with status 503"); }) as Pipeline;
  try {
    await assert.rejects(feedReadAllowed("d".repeat(48)));
  } finally { redis.pipeline = original; }
});

/**
 * The day count's expiry is read too (finding L1 of Claude 4's team on #2888, rule 24 and rule 30): an EXPIRE that
 * answers anything but its own whole number never lets the feed through, and a day key whose expiry was lost once is
 * given one again by the next count, so no `nl:pod:n:` key outlives its two days (lib/data-families.ts, X(2)).
 */
const DROP = Symbol("drop");
function expiryAnswered(value: unknown, when: (count: number) => boolean = () => true) {
  let seen = 0;
  redis.pipeline = (async (commands: Commands) => {
    const replies = await original(commands);
    const at = commands.findIndex((c) => c[0] === "EXPIRE" && String(c[1]).startsWith("nl:pod:n:"));
    if (at < 0 || !when(++seen)) return replies;
    const copy = [...(replies as unknown[])];
    if (value === DROP) copy.splice(at, 1);
    else copy[at] = value;
    return copy;
  }) as Pipeline;
}

const unknownExpiries: [string, unknown][] = [
  ["zero", 0],
  ["an object", {}],
  ["nothing", DROP],
  ["null", null],
  ["undefined", undefined],
  ["a string", "1"],
  ["true", true],
  ["a list", []],
  ["two", 2],
];

for (const [label, value] of unknownExpiries) test(`the day's first count with its expiry answered as ${label} never lets the feed through`, async () => {
  redis.clear();
  expiryAnswered(value);
  try {
    await assert.rejects(feedReadAllowed("e".repeat(48), Date.UTC(2026, 10, 6, 12)), UnknownReplyError);
  } finally { redis.pipeline = original; }
});

for (const [label, value] of [["an object", {}], ["nothing", DROP], ["a string", "0"]] as const) {
  test(`a later count of the day with its expiry answered as ${label} never lets the feed through`, async () => {
    redis.clear();
    redis.pipeline = original;
    const token = "f".repeat(48);
    const now = Date.UTC(2026, 10, 6, 12);
    assert.equal(await feedReadAllowed(token, now), true);
    expiryAnswered(value);
    try {
      await assert.rejects(feedReadAllowed(token, now), UnknownReplyError);
    } finally { redis.pipeline = original; }
  });
}

test("a day key whose expiry was lost on the day's first count gets one on the next count", async () => {
  redis.clear();
  const token = "9".repeat(48);
  const now = Date.UTC(2026, 10, 6, 12);
  let lost = false;
  // The day's first EXPIRE never reaches Redis and the request fails, while what was sent beside it is kept.
  redis.pipeline = (async (commands: Commands) => {
    const at = commands.findIndex((c) => c[0] === "EXPIRE" && String(c[1]).startsWith("nl:pod:n:"));
    if (at < 0 || lost) return original(commands);
    lost = true;
    const rest = commands.filter((_, i) => i !== at);
    if (rest.length) await original(rest);
    throw new Error("Redis request failed with status 503");
  }) as Pipeline;
  try {
    await assert.rejects(feedReadAllowed(token, now));
  } finally { redis.pipeline = original; }
  const key = redis.keys().find((k) => k.startsWith("nl:pod:n:"))!;
  assert.ok(key, "the count was kept without its expiry");
  assert.equal((await original([["TTL", key]]))[0], -1, "the lost expiry is what this test is about");
  assert.equal(await feedReadAllowed(token, now), true);
  const [ttl] = await original([["TTL", key]]);
  assert.ok(typeof ttl === "number" && ttl > 0 && ttl <= 2 * 86_400, "the next count gives the day's key its expiry again");
});

test("healthy control: a later count whose expiry was already there (EXPIRE NX answers 0) lets the feed through", async () => {
  redis.clear();
  redis.pipeline = original;
  const token = "8".repeat(48);
  const now = Date.UTC(2026, 10, 6, 12);
  assert.equal(await feedReadAllowed(token, now), true);
  expiryAnswered(0);
  try {
    assert.equal(await feedReadAllowed(token, now), true);
  } finally { redis.pipeline = original; }
});
