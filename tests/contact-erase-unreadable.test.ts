/**
 * Deleting a person takes their row off the store's list even when the row
 * does not read (Claude 5's review of #2700, 6704714655). The row is kept
 * under the address itself, so it goes by its key without reading it; but
 * what the row would have told (its unsubscribe link's record, its place in
 * the list's counts) is then unknown, so the deletion says it is incomplete,
 * never done. A read or a receipt in an unknown shape is refused: nothing is
 * taken for absent or for gone (CX-123 rule 24).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { agreedKey, forgetContactPerson, leadsKey, tokenKey, unsubKey } from "@/lib/contacts";
import { erasePerson } from "@/lib/person-erasure";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

const LIST = "c".repeat(16);
const email = "unreadable-contact@example.test";
const TOKEN = "a".repeat(40);
const row = (listId: string) => redis.run(["HGET", leadsKey(listId), email]);

type Pipeline = typeof redis.pipeline;

/** Runs `erase` while pipelines that `match` are answered by `answer` (given what the real store answered). */
async function answered(match: (commands: (string | number)[][]) => boolean, answer: (real: unknown[]) => unknown, erase: () => Promise<unknown>): Promise<{ threw: boolean; value?: unknown; seen: number; error?: unknown }> {
  const real = redis.pipeline.bind(redis) as Pipeline;
  let seen = 0;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (!match(commands)) return real(commands);
    seen += 1;
    return answer(await real(commands));
  }) as Pipeline;
  try {
    return { threw: false, value: await erase(), seen };
  } catch (error) {
    return { threw: true, seen, error };
  } finally {
    redis.pipeline = real;
  }
}

const isRead = (listId: string) => (c: (string | number)[][]) => c.length === 1 && c[0][0] === "HGET" && c[0][1] === leadsKey(listId);
const isDelete = (listId: string) => (c: (string | number)[][]) => c[0]?.[0] === "HDEL" && c[0][1] === leadsKey(listId);

function readable(listId: string): void {
  redis.run(["HSET", leadsKey(listId), email, JSON.stringify({ agreed: true, agreedAt: "2026-11-01", firstAt: "2026-11-01", lastAt: "2026-11-01", titles: [], ids: [], source: "free", unsub: true, unsubAt: "2026-11-02", t: TOKEN })]);
  redis.run(["SET", tokenKey(TOKEN), `${listId}|${email}|shop`]);
  redis.run(["SET", agreedKey(listId), 3]);
  redis.run(["SET", unsubKey(listId), 2]);
}

for (const raw of ["{", "", "null", "[1,", "\"unterminated"]) {
  test(`a row that does not read (${JSON.stringify(raw)}) is deleted by its key and said as incomplete`, async () => {
    redis.clear();
    redis.run(["HSET", leadsKey(LIST), email, raw]);
    await assert.rejects(forgetContactPerson(LIST, email), /does not read|unknown/i, "never a quiet zero");
    assert.equal(row(LIST), null, "the row holding the address is gone");
  });
}

for (const [name, bad] of [
  ["missing", []],
  ["undefined", [undefined]],
  ["number", [7]],
  ["object", [{}]],
  ["array", [[]]],
  ["extra", [null, null]],
  ["sparse", new Array(1)],
] as [string, unknown[]][]) {
  test(`a read answered ${name} is unknown: refused, nothing deleted`, async () => {
    redis.clear();
    readable(LIST);
    const run = await answered(isRead(LIST), () => bad, () => forgetContactPerson(LIST, email));
    assert.equal(run.threw, true, "an unknown read is never taken for no row");
    assert.equal(run.seen, 1);
    assert.notEqual(row(LIST), null, "the row is kept for the retry");
    assert.equal(redis.run(["GET", tokenKey(TOKEN)]), `${LIST}|${email}|shop`);
  });

  test(`an unreadable row's deletion answered ${name} is unknown: refused`, async () => {
    redis.clear();
    redis.run(["HSET", leadsKey(LIST), email, "{"]);
    const run = await answered(isDelete(LIST), () => bad, () => forgetContactPerson(LIST, email));
    assert.equal(run.threw, true);
    assert.equal(run.seen, 1, "the row is deleted by its key, once");
  });

  test(`a readable row's deletion answered ${name} is unknown: refused, never counted as gone`, async () => {
    redis.clear();
    readable(LIST);
    const run = await answered(isDelete(LIST), () => bad, () => forgetContactPerson(LIST, email));
    assert.equal(run.threw, true, "an unknown receipt is never 'deleted'");
    assert.equal(run.seen, 1);
  });
}

test("a readable row still goes whole: row, token, counts", async () => {
  redis.clear();
  readable(LIST);
  assert.equal(await forgetContactPerson(LIST, email), 2);
  assert.equal(row(LIST), null);
  assert.equal(redis.run(["GET", tokenKey(TOKEN)]), null);
  assert.equal(Number(redis.run(["GET", agreedKey(LIST)])), 2);
  assert.equal(Number(redis.run(["GET", unsubKey(LIST)])), 1);
  assert.equal(await forgetContactPerson(LIST, email), 0, "a confirmed absent row is none");
});

test("the actual person-erasure flow is incomplete on an unreadable row, and the row is gone", async () => {
  redis.clear();
  const oldFetch = globalThis.fetch, oldLog = console.error;
  globalThis.fetch = async () => { throw new Error("No external provider allowed"); };
  const owner = "unreadable-contact-owner@example.test";
  await claimHandle(owner, "unreadablecontact", "Unreadable Contact", "");
  await ensureStoreId(owner); await ensureStatsId(owner); await ensureListId(owner);
  await setSubscription(owner, { customerId: "cus_Unreadable", subscriptionId: "sub_Unreadable", active: true, tier: "pro", period: paidPeriod() });
  const shop = (await storeForEmail(owner))!;
  assert.ok(shop.listId);
  const listId = shop.listId as string;
  redis.run(["HSET", leadsKey(listId), email, "{"]);
  console.error = () => {};
  try {
    const result = await erasePerson(shop, email, { kind: "person" });
    assert.equal(result.ok, false, "never 'it is done' while what the row held is unknown");
    assert.ok(!result.ok && result.reason === "incomplete" && result.failed.includes("lib/contacts.ts"));
    assert.equal(row(listId), null, "the row holding the address is gone");
  } finally {
    globalThis.fetch = oldFetch;
    console.error = oldLog;
  }
});

// Pre-review of eb9a47c179 (Claude 5, 7 November 2026): an unreadable row that still holds its unsubscribe token in
// its text left the token's record ("listId|address|handle", kept with no expiry) behind; the first erasure said
// incomplete, the retry found no row and said ok with the address still kept in clear.
const CUT_TOKEN = "b".repeat(40);
const cutRow = (token: string) => `{"agreed":true,"source":"free","unsub":false,"unsubAt":"","t":"${token}","titles":["A`;

test("an unreadable row's unsubscribe token, still in its text, goes with it: the retry is ok with nothing left", async () => {
  redis.clear();
  redis.run(["HSET", leadsKey(LIST), email, cutRow(CUT_TOKEN)]);
  redis.run(["SET", tokenKey(CUT_TOKEN), `${LIST}|${email}|shop`]);
  await assert.rejects(forgetContactPerson(LIST, email), /does not read/i, "the counts are still unknown: incomplete");
  assert.equal(row(LIST), null, "the row holding the address is gone");
  assert.equal(redis.run(["GET", tokenKey(CUT_TOKEN)]), null, "the token's record holding the address in clear is gone too");
  assert.equal(await forgetContactPerson(LIST, email), 0, "only then is a retry's absent row none");
});

test("the actual person-erasure flow: the retry's ok leaves no token record with the address", async () => {
  redis.clear();
  const oldFetch = globalThis.fetch, oldLog = console.error;
  globalThis.fetch = async () => { throw new Error("No external provider allowed"); };
  const owner = "unreadable-token-owner@example.test";
  await claimHandle(owner, "unreadabletoken", "Unreadable Token", "");
  await ensureStoreId(owner); await ensureStatsId(owner); await ensureListId(owner);
  await setSubscription(owner, { customerId: "cus_UnreadTok", subscriptionId: "sub_UnreadTok", active: true, tier: "pro", period: paidPeriod() });
  const shop = (await storeForEmail(owner))!;
  const listId = shop.listId as string;
  redis.run(["HSET", leadsKey(listId), email, cutRow(CUT_TOKEN)]);
  redis.run(["SET", tokenKey(CUT_TOKEN), `${listId}|${email}|unreadabletoken`]);
  console.error = () => {};
  try {
    const first = await erasePerson(shop, email, { kind: "person" });
    assert.ok(!first.ok && first.reason === "incomplete");
    const second = await erasePerson(shop, email, { kind: "person" });
    const left = redis.run(["GET", tokenKey(CUT_TOKEN)]);
    assert.ok(!(second.ok && typeof left === "string" && left.includes(email)), "never ok while the token's record still holds the address");
    assert.equal(left, null);
  } finally {
    globalThis.fetch = oldFetch;
    console.error = oldLog;
  }
});

for (const [name, text] of [
  ["cut inside the token", `{"agreed":true,"t":"${"b".repeat(17)}`],
  ["cut after the key", `{"agreed":true,"t":`],
  ["a token of another shape", `{"agreed":true,"t":"${"B".repeat(40)}","titles":[`],
] as [string, string][]) {
  test(`an unreadable row whose token cannot be read (${name}) is kept, and every retry stays incomplete`, async () => {
    redis.clear();
    redis.run(["HSET", leadsKey(LIST), email, text]);
    await assert.rejects(forgetContactPerson(LIST, email), /does not read/i);
    await assert.rejects(forgetContactPerson(LIST, email), /does not read/i, "a retry never says none while a token may be left");
    assert.equal(row(LIST), text, "the row is the only way to the token's record: it is kept, untouched");
  });
}

test("an unreadable row with no token in its text (\"t\":\"\") is deleted by its key alone", async () => {
  redis.clear();
  redis.run(["HSET", leadsKey(LIST), email, `{"agreed":true,"t":"","titles":["A`]);
  await assert.rejects(forgetContactPerson(LIST, email), /does not read/i);
  assert.equal(row(LIST), null);
  assert.equal(await forgetContactPerson(LIST, email), 0);
});

for (const [name, bad] of [
  ["missing", [1]],
  ["two", [1, 2]],
  ["string", [1, "1"]],
  ["negative", [1, -1]],
] as [string, unknown[]][]) {
  test(`an unreadable row's token deletion answered ${name} is unknown: refused`, async () => {
    redis.clear();
    redis.run(["HSET", leadsKey(LIST), email, cutRow(CUT_TOKEN)]);
    redis.run(["SET", tokenKey(CUT_TOKEN), `${LIST}|${email}|shop`]);
    const run = await answered(isDelete(LIST), () => bad, () => forgetContactPerson(LIST, email));
    assert.equal(run.threw, true);
    assert.match(String(run.error), /unknown shape/i, "an unknown receipt of the token's deletion is said as unknown");
    assert.equal(run.seen, 1, "the row and its token go in one request");
  });
}
