/** Defensive regression: the group-purchase section of a personal-data copy requires an exact, store-owned record. Synthetic Redis and checkout responses only. */
import assert from "node:assert/strict";
import test from "node:test";
import { COPIERS, copyPerson } from "@/lib/person-copy";
import { importedKey } from "@/lib/imported-purchases";
import { UnknownReplyError } from "@/lib/redis-reply";
import type { ErasureScope } from "@/lib/erasure-rules";
import { claimHandle, ensureListId, ensureStatsId, storeForEmail } from "@/lib/store";
import { erasureScope } from "@/lib/person-erasure";
import { store as redis } from "./redis-stub";

const ID = "grp_" + "a".repeat(24), STATS = "b".repeat(32), EMAIL = "person@example.test";
const copier = COPIERS["lib/group-buy.ts"];
const pipeline = redis.pipeline.bind(redis);
const priorFetch = globalThis.fetch;
process.env.STRIPE_SECRET_KEY = "sk_test_group_copy_synthetic_only";
let bought = false;
globalThis.fetch = (async (input: string | URL | Request) => {
 const url = new URL(String(input instanceof Request ? input.url : input));
 assert.equal(url.hostname, "api.stripe.com", "only the in-process checkout fixture is allowed");
 assert.equal(url.pathname, "/v1/checkout/sessions");
 return Response.json({ object: "list", has_more: false, data: bought ? [{ id: "cs_test_" + "c".repeat(24), status: "complete", payment_status: "paid", payment_intent: "pi_GroupCopyFixture", metadata: { store: "groupcopy", product: "course_1", group: ID } }] : [] });
}) as typeof fetch;
const record = (extra: Record<string, unknown> = {}) => ({ id: ID, s: STATS, p: "course_1", people: 5, at: 1_790_000_000, paid: 1_790_000_010, ...extra });
const scope = (buyer: boolean) => ({ store: { sid: "groupcopy-sid", statsId: STATS, handle: "groupcopy", previousHandles: [], releasedHandles: [], ...(buyer ? { stripeAccountId: "acct_CopyOnly" } : {}) }, sid: "groupcopy-sid", statsId: STATS, listId: null, email: EMAIL, person: "d".repeat(32), learner: "e".repeat(32), courses: [], productIds: [], communityId: null }) as unknown as ErasureScope;
async function setup(buyer: boolean) {
 redis.pipeline = pipeline; redis.clear(); bought = buyer;
 const s = scope(buyer);
 if (!buyer) await pipeline([["HSET", importedKey(STATS, EMAIL), "course_1", JSON.stringify({ at: 1_790_000_000, job: "group:" + ID, items: null })]]);
 await pipeline([["SET", "nl:grp:" + ID, JSON.stringify(record())]]);
 return s;
}
function answer(reply: unknown): void {
 redis.pipeline = (async (commands: (string | number)[][]) => commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === "nl:grp:" + ID ? reply as unknown[] : pipeline(commands)) as typeof redis.pipeline;
}
const failures: [string, () => unknown][] = [
 ["missing pipeline reply", () => []], ["extra pipeline reply", () => [JSON.stringify(record()), null]],
 ["non-list envelope", () => ({ 0: JSON.stringify(record()), length: 1 })], ["sparse envelope", () => new Array(1)],
 ["non-text record", () => [42]], ["invalid JSON", () => ["{unread"]], ["JSON null", () => ["null"]], ["JSON array", () => ["[]"]],
 ...([
  ["record identity", { id: "grp_" + "f".repeat(24) }], ["missing identity", { id: undefined }],
  ["foreign store", { s: "f".repeat(32) }], ["missing store", { s: undefined }],
  ["missing product", { p: undefined }], ["invalid product", { p: "invalid product" }],
  ["zero places", { people: 0 }], ["fractional places", { people: 2.5 }], ["too many places", { people: 201 }],
  ["missing creation time", { at: undefined }], ["text creation time", { at: "1790000000" }], ["negative creation time", { at: -1 }],
  ["unrenderable creation time", { at: 8_640_000_000_001 }], ["text payment time", { paid: "1790000010" }], ["negative payment time", { paid: -1 }],
 ] as [string, Record<string, unknown>][]).map(([name, extra]) => [name, () => [JSON.stringify(record(extra))]] as [string, () => unknown]),
];
for (const buyer of [false, true]) {
 test(`${buyer ? "buyer" : "member"}: an exact own record is copied without writes`, async () => {
  const s = await setup(buyer); let writes = 0;
  redis.pipeline = (async (commands: (string | number)[][]) => { writes += commands.filter(c => !["GET", "HGETALL"].includes(String(c[0]))).length; return pipeline(commands); }) as typeof redis.pipeline;
  try {
   const rows = await copier(s);
   assert.deepEqual(rows, [buyer ? { youBought: true, product: "course_1", places: 5, at: new Date(1_790_000_000_000).toISOString(), paid: new Date(1_790_000_010_000).toISOString() } : { youTookAPlace: true, product: "course_1", at: new Date(1_790_000_000_000).toISOString() }]);
   assert.equal(writes, 0);
  } finally { redis.pipeline = pipeline; }
 });
 test(`${buyer ? "buyer" : "member"}: confirmed null means the record expired`, async () => {
  const s = await setup(buyer); answer([null]);
  try { assert.deepEqual(await copier(s), []); } finally { redis.pipeline = pipeline; }
 });
 test(`${buyer ? "buyer" : "member"}: legacy absence of paid time and valid place boundaries still copy`, async () => {
  for (const people of [2, 200]) {
   const s = await setup(buyer);
   await pipeline([["SET", "nl:grp:" + ID, JSON.stringify(record({ people, at: 0, paid: undefined }))]]);
   const rows = await copier(s);
   assert.deepEqual(rows, [buyer ? { youBought: true, product: "course_1", places: people, at: "" } : { youTookAPlace: true, product: "course_1", at: "" }]);
  }
 });
 for (const [name, reply] of failures) test(`${buyer ? "buyer" : "member"}: ${name} is unknown, never absence or another store's data`, async () => {
  const s = await setup(buyer); answer(reply());
  try { await assert.rejects(() => copier(s), UnknownReplyError); } finally { redis.pipeline = pipeline; }
 });
}

test("an invalid referenced group id is unknown before any group key is read", async () => {
 const s = await setup(false);
 await pipeline([["HSET", importedKey(STATS, EMAIL), "course_1", JSON.stringify({ at: 1_790_000_000, job: "group:not-a-group-id", items: null })]]);
 await assert.rejects(() => copier(s), UnknownReplyError);
});

test("two grants naming the same group copy the purchase only once", async () => {
 const s = await setup(false);
 await pipeline([["HSET", importedKey(STATS, EMAIL), "course_2", JSON.stringify({ at: 1_790_000_000, job: "group:" + ID, items: null })]]);
 assert.equal((await copier(s)).length, 1);
});

test("the full personal copy succeeds when healthy and refuses an unread group record", async () => {
 redis.pipeline = pipeline; redis.clear(); bought = false;
 const owner = "group-copy-owner@example.test";
 await claimHandle(owner, "groupcopyworld", "Group Copy", ""); await ensureListId(owner); await ensureStatsId(owner);
 const shop = (await storeForEmail(owner))!, s = (await erasureScope(shop, EMAIL))!;
 await pipeline([["HSET", importedKey(s.statsId, EMAIL), "course_1", JSON.stringify({ at: 1_790_000_000, job: "group:" + ID, items: null })], ["SET", "nl:grp:" + ID, JSON.stringify(record({ s: s.statsId }))]]);
 const healthy = await copyPerson(s);
 assert.equal(healthy.complete, true);
 assert.equal(healthy.sections.find(x => x.module === "lib/group-buy.ts")?.records.length, 1);
 answer([]);
 try { await assert.rejects(() => copyPerson(s), UnknownReplyError); } finally { redis.pipeline = pipeline; }
});

test.after(() => { redis.pipeline = pipeline; globalThis.fetch = priorFetch; });
