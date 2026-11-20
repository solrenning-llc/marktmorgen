/**
 * A private podcast feed's records are read only in their exact shape (CX-123 rules 24 and 30; sweep A5 finding 5,
 * tests/sweep-a5-podcast-erasure.proof.test.ts on claude5/sweep-a5, with its expectations turned around).
 *
 * The feed grant nl:pod:t:<sha(token)> holds the listener's email address, and the index nl:pod:by:... is the only
 * way back to it. Erasing a person (lib/person-erasure.ts) must therefore never delete the index while the token it
 * points to is unknown, and must never be counted as done then: the module throws, the erasure says "incomplete",
 * and a later run with a healthy reply finds the grant again and deletes it. The person's copy of their data
 * (feedsOf) says it could not read rather than "no feed", and a feed is never made twice for one address when the
 * SET NX that guards it answers in an unknown shape (an unindexed second grant would outlive the erasure).
 * Synthetic only: an in-memory Redis, no provider.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { feedToken, feedsOf, forgetPodcastPerson, readFeedToken } from "@/lib/podcast-access";
import { erasePerson } from "@/lib/person-erasure";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

type Pipeline = typeof redis.pipeline;
const OWNER = "podcast-exact-owner@example.test";
const original: Pipeline = redis.pipeline.bind(redis);

async function world(products = 1) {
  redis.clear();
  redis.pipeline = original;
  await claimHandle(OWNER, "podexact", "Podcast Exact", "");
  await ensureStoreId(OWNER); await ensureStatsId(OWNER); await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_PodExact", subscriptionId: "sub_PodExact", active: true, tier: "pro", period: paidPeriod() });
  const ids: string[] = [];
  for (let i = 0; i < products; i++) {
    const made = await addProduct(OWNER, `Synthetic Radio ${i + 1}`, "", "19", null);
    assert.ok(made.ok);
    ids.push(made.product.id);
  }
  const store = async () => (await storeForEmail(OWNER))!;
  return { ids, store };
}

const isIndexGet = (commands: (string | number)[][]) =>
  commands.length > 0 && commands.every((c) => c[0] === "GET" && String(c[1]).startsWith("nl:pod:by:"));
const isFeedDel = (commands: (string | number)[][]) =>
  commands.length === 1 && commands[0][0] === "DEL" && String(commands[0][1]).startsWith("nl:pod:by:");
const grants = () => redis.keys().filter((k) => k.startsWith("nl:pod:t:")).length;

function answer(when: (commands: (string | number)[][]) => boolean, reply: () => unknown) {
  redis.pipeline = (async (commands: (string | number)[][]) => (when(commands) ? reply() : original(commands))) as Pipeline;
}

test("healthy control: erasing a listener deletes the index and the grant with their address", async () => {
  const { ids, store } = await world();
  const token = (await feedToken(await store(), ids[0], "ana@example.test"))!;
  assert.equal((await readFeedToken(token))?.e, "ana@example.test");
  assert.deepEqual(await feedsOf(await store(), ids, "ana@example.test"), [ids[0]]);
  const gone = await forgetPodcastPerson(await store(), ids, "ana@example.test");
  assert.ok(gone >= 2, "the index and the grant are deleted");
  assert.equal(await readFeedToken(token), null);
  assert.deepEqual(await feedsOf(await store(), ids, "ana@example.test"), []);
  assert.equal(await forgetPodcastPerson(await store(), ids, "ana@example.test"), 0, "a confirmed nothing is a real zero");
});

const unknownTokens: [string, (n: number) => unknown][] = [
  ["no reply", () => []],
  ["a number", (n) => Array.from({ length: n }, () => 5)],
  ["an object", (n) => Array.from({ length: n }, () => ({}))],
  ["a list", (n) => Array.from({ length: n }, () => [])],
  ["undefined", (n) => Array.from({ length: n }, () => undefined)],
  ["one reply short", (n) => Array.from({ length: n - 1 }, () => null)],
  ["one reply too many", (n) => Array.from({ length: n + 1 }, () => null)],
  ["a hole", (n) => new Array(n)],
  ["not a list", () => null],
];

for (const [label, reply] of unknownTokens) test(`erasure with the feed tokens answered as ${label}: throws, keeps the index, a retry deletes the grant`, async () => {
  const { ids, store } = await world(2);
  const email = "ben@example.test";
  const token = (await feedToken(await store(), ids[0], email))!;
  const before = grants();
  answer(isIndexGet, () => reply(ids.length));
  try {
    await assert.rejects(forgetPodcastPerson(await store(), ids, email), UnknownReplyError, "the step is never counted as done");
  } finally { redis.pipeline = original; }
  assert.equal(grants(), before, "nothing was deleted on an unknown read");
  assert.equal(await feedToken(await store(), ids[0], email), token, "the index that leads to the grant is kept for the retry");
  assert.ok((await forgetPodcastPerson(await store(), ids, email)) >= 2);
  assert.equal(await readFeedToken(token), null, "the retry deletes the grant with the erased address");
});

for (const [label, reply] of [["no reply", () => []], ["a string", () => ["1"]], ["a negative", () => [-1]], ["a fraction", () => [1.5]]] as const) {
  test(`erasure with the DEL answered as ${label}: not counted as done`, async () => {
    const { ids, store } = await world();
    await feedToken(await store(), ids[0], "cleo@example.test");
    answer(isFeedDel, reply);
    try {
      await assert.rejects(forgetPodcastPerson(await store(), ids, "cleo@example.test"), UnknownReplyError);
    } finally { redis.pipeline = original; }
  });
}

test("the whole erasure says incomplete on an unknown feed read, and a later one finishes", async () => {
  const { ids, store } = await world();
  const email = "dana@example.test";
  const token = (await feedToken(await store(), ids[0], email))!;
  const log = console.error;
  console.error = () => {};
  answer(isIndexGet, () => []);
  try {
    const result = await erasePerson(await store(), email, { kind: "person" });
    assert.equal(result.ok, false, "an unknown feed read is never certified as erased");
    assert.ok(!result.ok && result.reason === "incomplete" && result.failed.includes("lib/podcast-access.ts"));
  } finally { redis.pipeline = original; console.error = log; }
  assert.equal((await readFeedToken(token))?.e, email, "the grant is still findable, not orphaned");
  const again = await erasePerson(await store(), email, { kind: "person" });
  assert.ok(again.ok || (again.reason === "incomplete" && !again.failed.includes("lib/podcast-access.ts")), "the feed module finishes on a healthy read");
  assert.equal(await readFeedToken(token), null);
});

for (const [label, reply] of unknownTokens) test(`the person's copy with the feed tokens answered as ${label}: says it could not read`, async () => {
  const { ids, store } = await world(2);
  await feedToken(await store(), ids[1], "eli@example.test");
  answer(isIndexGet, () => reply(ids.length));
  try {
    await assert.rejects(feedsOf(await store(), ids, "eli@example.test"), UnknownReplyError);
  } finally { redis.pipeline = original; }
  assert.deepEqual(await feedsOf(await store(), ids, "eli@example.test"), [ids[1]]);
});

for (const [label, value] of [["a number", 5], ["undefined", undefined], ["a word", "QUEUED"], ["true", true]] as const) {
  test(`a feed's SET NX answered as ${label} never makes a second, unindexed grant`, async () => {
    const { ids, store } = await world();
    const email = "finn@example.test";
    const first = (await feedToken(await store(), ids[0], email))!;
    const before = grants();
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (isIndexGet(commands)) return [];
      if (commands.length === 1 && commands[0][0] === "EVAL" && commands[0].some((x) => String(x).startsWith("nl:pod:by:"))) return [[0, value]];
      return original(commands);
    }) as Pipeline;
    let token: string | null = null;
    try {
      token = await feedToken(await store(), ids[0], email).catch(() => null);
    } finally { redis.pipeline = original; }
    assert.ok(token === null || token === first, "no new token is handed out");
    assert.equal(grants(), before, "no grant holding the address exists outside the index");
    assert.ok((await forgetPodcastPerson(await store(), ids, email)) >= 2);
    assert.equal(grants(), 0, "the erasure leaves no grant behind");
  });
}

test("healthy control: a taken SET NX answers the token already kept", async () => {
  const { ids, store } = await world();
  const email = "gil@example.test";
  const first = (await feedToken(await store(), ids[0], email))!;
  let reads = 0;
  // The first read misses (as a race would), so the SET NX is the one that finds the token already kept.
  answer((commands) => isIndexGet(commands) && reads++ === 0, () => [null]);
  let token: string | null = null;
  try { token = await feedToken(await store(), ids[0], email); } finally { redis.pipeline = original; }
  assert.equal(token, first);
  assert.equal(grants(), 1);
});
