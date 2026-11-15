/**
 * Issue #4810 follow-up (Claude 7, from the 51LL review): what a person's erasure and a person's copy of their data
 * (art. 15) do with a CRM deal that does not read.
 *
 *   - The erasure decides each deal as the person's or not, never by stopping the whole store: a readable deal by its
 *     address, exactly; an unreadable one is the person's when its text, as stored or with its JSON escapes read back
 *     (\u0040 included), holds their address as a whole address, and not theirs otherwise. A newline or a quote escaped
 *     in a note decides nothing, so a damaged deal of somebody else's with a note of several lines never blocks every
 *     erasure for good (second review).
 *   - The copy reads the same way: a deal of theirs that does not read is in the copy as its stored text (it is their
 *     data), so the copy is neither held up for good nor complete without it; a deal of theirs in a stage the store
 *     removed is in the copy, with its stage left empty. Synthetic, the Redis stub.
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
  assert.equal(dealNames(`{"email":"person\\u0040example.com"`, email), "yes", "an address spelled with an escape is still theirs");
  assert.equal(dealNames(`{"email":"other@example.com","note":"line one\\nline two \\"quoted\\" a\\/b"`, email), "no", "a newline, a quote or a slash escaped decides nothing");
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

test("erasure: an unreadable deal spelling the address with an escape is deleted with theirs", async () => {
  redis.clear();
  await redis.pipeline([["HSET", key, "descaped01", '{"email":"person\\u0040example.com"']]);
  assert.notEqual(await erase(), "threw");
  assert.equal(await kept("descaped01"), 0);
});

test("erasure: a damaged deal of somebody else's with a note of several lines never blocks it", async () => {
  redis.clear();
  await redis.pipeline([["HSET", key, "dmine00001", deal("dmine00001", email)], ["HSET", key, "dother0001", '{"email":"other@example.com","note":"first line\\nsecond \\"line\\"']]);
  assert.notEqual(await erase(), "threw");
  assert.equal(await kept("dmine00001"), 0);
  assert.equal(await kept("dother0001"), 1);
});

test("copy: their deal in a removed stage is in the copy with its stage empty", async () => {
  redis.clear();
  await redis.pipeline([["HSET", key, "dgonestage", deal("dgonestage", email, "st_removed")], ["HSET", key, "dopen00001", deal("dopen00001", email)], ["HSET", key, "dother0001", deal("dother0001", "other@example.com")]]);
  const { deals: rows, unread } = await dealsOfPerson(statsId, email, stages);
  assert.deepEqual(rows.map((d) => [d.id, d.stage]).sort(), [["dgonestage", ""], ["dopen00001", "st_open"]]);
  assert.deepEqual(unread, []);
});

test("copy: a deal of theirs that does not read is in the copy as stored; somebody else's is not", async () => {
  redis.clear();
  const broken = `{"email":"${email}"`;
  const escaped = '{"email":"person\\u0040example.com"';
  await redis.pipeline([["HSET", key, "dopen00001", deal("dopen00001", email)], ["HSET", key, "dother0001", '{"email":"other@example.com"'], ["HSET", key, "dbroken001", broken], ["HSET", key, "descaped01", escaped]]);
  const copy = await dealsOfPerson(statsId, email, stages);
  assert.deepEqual(copy.deals.map((d) => d.id), ["dopen00001"]);
  assert.deepEqual([...copy.unread].sort(), [broken, escaped].sort());
});
