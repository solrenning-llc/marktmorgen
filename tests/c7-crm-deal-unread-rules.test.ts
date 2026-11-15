/**
 * Issue #4810 follow-up (Claude 7, from the 51LL review): what a person's erasure and a person's copy of their data
 * (art. 15) do with a CRM deal that does not read.
 *
 *   - The erasure decides each deal as the person's or not, never by stopping the whole store: a readable deal by its
 *     address, exactly; an unreadable one is the person's when its raw text holds their address as a whole address,
 *     not theirs when it holds no part of it, and only one whose text could spell it through a JSON escape is unknown
 *     (the erasure throws then, as before). So one damaged deal of somebody else's never blocks every erasure for good.
 *   - The copy reads the same way: an unreadable deal that is theirs, or may be, makes the copy fail (UnknownReplyError)
 *     rather than come out "complete" without it; a deal of theirs in a stage the store removed is in the copy, with
 *     its stage left empty. Synthetic, the Redis stub.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dealNames, dealsOfPerson, forgetCrmPerson } from "@/lib/crm";
import { personKey } from "@/lib/person-key";
import { store as redis } from "./redis-stub";

const statsId = "crm_unread_rules";
const key = `nl:crm:deals:${statsId}`;
const email = "person@example.com";
const stages = [
  { id: "st_open", name: "Open", kind: "open" as const },
  { id: "st_won", name: "Won", kind: "won" as const },
  { id: "st_lost", name: "Lost", kind: "lost" as const },
];
const deal = (id: string, mail: string, stage = "st_open") => JSON.stringify({ id, title: `Deal ${id}`, email: mail, cents: 100, stage, note: "", createdAt: 1, updatedAt: 2 });
const outcome = async (run: () => Promise<unknown>) => {
  try {
    return await run();
  } catch {
    return "threw";
  }
};
const erase = () => outcome(() => forgetCrmPerson(statsId, personKey(statsId, email), email));
const kept = async (id: string) => (await redis.pipeline([["HEXISTS", key, id]]))[0];

test("dealNames: a readable deal by its address, an unreadable one by whole address in its text", () => {
  assert.equal(dealNames(deal("done000001", "Person@Example.com"), email), "yes");
  assert.equal(dealNames(deal("done000001", "other@example.com"), email), "no");
  assert.equal(dealNames(`{"email":"${email}"`, email), "yes");
  assert.equal(dealNames(`{"email":"other@example.com"`, email), "no");
  assert.equal(dealNames(`{"email":"nina-${email}"`, email), "no", "a longer address that ends in theirs is not theirs");
  assert.equal(dealNames(`{"email":"${email}.au"`, email), "no", "a longer address that starts with theirs is not theirs");
  assert.equal(dealNames(`{"email":"person\\u0040example.com"`, email), "unknown", "an escape could spell it");
  assert.equal(dealNames("not json at all", email), "no");
});

test("erasure: an unreadable deal of somebody else's never blocks the person's erasure", async () => {
  redis.clear();
  await redis.pipeline([["HSET", key, "dmine00001", deal("dmine00001", email)], ["HSET", key, "dother0001", '{"email":"other@example.com"']]);
  assert.notEqual(await erase(), "threw");
  assert.equal(await kept("dmine00001"), 0, "their readable deal is deleted");
  assert.equal(await kept("dother0001"), 1, "somebody else's unreadable deal is left as it is");
});

test("erasure: an unreadable deal naming the person is deleted with theirs", async () => {
  redis.clear();
  await redis.pipeline([["HSET", key, "dbroken001", `{"email":"${email}"`]]);
  assert.notEqual(await erase(), "threw");
  assert.equal(await kept("dbroken001"), 0);
});

test("erasure: an unreadable deal whose text could spell the address through an escape stops it", async () => {
  redis.clear();
  await redis.pipeline([["HSET", key, "descaped01", '{"email":"person\\u0040example.com"']]);
  assert.equal(await erase(), "threw");
  assert.equal(await kept("descaped01"), 1);
});

test("copy: their deal in a removed stage is in the copy with its stage empty", async () => {
  redis.clear();
  await redis.pipeline([["HSET", key, "dgonestage", deal("dgonestage", email, "st_removed")], ["HSET", key, "dopen00001", deal("dopen00001", email)], ["HSET", key, "dother0001", deal("dother0001", "other@example.com")]]);
  const rows = (await dealsOfPerson(statsId, email, stages)) as { id: string; stage: string }[];
  assert.deepEqual(rows.map((d) => [d.id, d.stage]).sort(), [["dgonestage", ""], ["dopen00001", "st_open"]]);
});

test("copy: an unreadable deal that is theirs, or may be, fails the copy; somebody else's does not", async () => {
  redis.clear();
  await redis.pipeline([["HSET", key, "dopen00001", deal("dopen00001", email)], ["HSET", key, "dother0001", '{"email":"other@example.com"']]);
  assert.notEqual(await outcome(() => dealsOfPerson(statsId, email, stages)), "threw");
  await redis.pipeline([["HSET", key, "dbroken001", `{"email":"${email}"`]]);
  assert.equal(await outcome(() => dealsOfPerson(statsId, email, stages)), "threw");
  await redis.pipeline([["HDEL", key, "dbroken001"], ["HSET", key, "descaped01", '{"email":"person\\u0040example.com"']]);
  assert.equal(await outcome(() => dealsOfPerson(statsId, email, stages)), "threw");
});
