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
async function answered(match: (commands: (string | number)[][]) => boolean, answer: (real: unknown[]) => unknown, erase: () => Promise<unknown>): Promise<{ threw: boolean; value?: unknown; seen: number }> {
  const real = redis.pipeline.bind(redis) as Pipeline;
  let seen = 0;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (!match(commands)) return real(commands);
    seen += 1;
    return answer(await real(commands));
  }) as Pipeline;
  try {
    return { threw: false, value: await erase(), seen };
  } catch {
    return { threw: true, seen };
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
