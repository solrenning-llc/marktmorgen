/**
 * Rule 24 (synthetic): an unknown or off-shape Redis reply in the inbox is
 * never read as "nothing there" or "gone". A person's erasure never answers
 * done while their conversations stay kept, and the creator's inbox index
 * never drops a conversation that still exists.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { fileContact, forgetInboxPerson, readInbox } from "@/lib/inbox";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "owner.r24@example.test";
const ANA = "ana.r24@example.test";
const BEN = "ben.r24@example.test";

async function setup() {
  redis.clear();
  await claimHandle(OWNER, "r24inbox", "R24 Inbox", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_R24Inbox01", subscriptionId: "sub_R24Inbox01", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  assert.equal(await fileContact({ store, email: ANA, name: "Ana", text: "Hello, a question about the course." }), true);
  assert.equal(await fileContact({ store, email: BEN, name: "Ben", text: "Hello, do you do collaborations?" }), true);
  assert.equal((await readInbox(store.statsId)).length, 2);
  return store.statsId!;
}

/** Replaces the reply of the first pipeline whose first command is `op`. */
async function withReplyFor<T>(op: string, reply: unknown[], run: () => Promise<T>): Promise<T> {
  const original = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => (commands[0]?.[0] === op ? [...reply] : original(commands))) as typeof redis.pipeline;
  try {
    return await run();
  } finally {
    redis.pipeline = original;
  }
}

for (const [label, reply] of [["object", [{}]], ["text", ["x"]], ["missing", []]] as [string, unknown[]][]) {
  test(`forgetInboxPerson: a ${label} ZREVRANGE reply is not "no conversations" (erasure never reported done with 0)`, async () => {
    const statsId = await setup();
    const result = await withReplyFor("ZREVRANGE", reply, () => forgetInboxPerson(statsId, ANA)).then((n) => n, () => "threw");
    const left = (await readInbox(statsId)).filter((c) => c.email === ANA).length;
    assert.ok(result === "threw" || left === 0, `erasure answered ${String(result)} while ${left} of the person's conversations are still kept`);
  });
}

for (const [label, reply] of [["cut short", [[]]], ["object", [{}]], ["missing", []]] as [string, unknown[]][]) {
  test(`forgetInboxPerson: a ${label} MGET reply is not "not theirs"`, async () => {
    const statsId = await setup();
    const result = await withReplyFor("MGET", reply, () => forgetInboxPerson(statsId, ANA)).then((n) => n, () => "threw");
    const left = (await readInbox(statsId)).filter((c) => c.email === ANA).length;
    assert.ok(result === "threw" || left === 0, `erasure answered ${String(result)} while ${left} of the person's conversations are still kept`);
  });
}

for (const [label, reply] of [["cut short", [[]]], ["object", [{}]], ["missing", []]] as [string, unknown[]][]) {
  test(`readInbox: a ${label} MGET reply never drops live conversations from the index`, async () => {
    const statsId = await setup();
    await withReplyFor("MGET", reply, () => readInbox(statsId)).catch(() => null);
    assert.equal((await readInbox(statsId)).length, 2, "live buyer conversations were removed from the creator's inbox index");
  });
}

for (const [label, reply] of [["object", [{}]], ["text", ["x"]], ["missing", []]] as [string, unknown[]][]) {
  test(`readInbox: a ${label} ZREVRANGE reply is not an empty inbox`, async () => {
    const statsId = await setup();
    const result = await withReplyFor("ZREVRANGE", reply, () => readInbox(statsId)).then((list) => list.length, () => "threw");
    assert.equal(result, "threw", "an unknown index read was shown as an inbox with no conversations");
  });
}

for (const [label, reply] of [["cut short", [1]], ["text", ["1", "1"]], ["missing", []]] as [string, unknown[]][]) {
  test(`forgetInboxPerson: a ${label} DEL/ZREM reply is not "deleted"`, async () => {
    const statsId = await setup();
    const result = await withReplyFor("DEL", reply, () => forgetInboxPerson(statsId, ANA)).then((n) => n, () => "threw");
    const left = (await readInbox(statsId)).filter((c) => c.email === ANA).length;
    assert.ok(result === "threw" || left === 0, `erasure answered ${String(result)} while ${left} of the person's conversations are still kept`);
  });
}

test("readInbox and forgetInboxPerson still read a well-formed inbox and erase only that person", async () => {
  const statsId = await setup();
  assert.equal(await forgetInboxPerson(statsId, ANA), 1);
  const left = await readInbox(statsId);
  assert.deepEqual(left.map((c) => c.email), [BEN]);
  assert.equal(await forgetInboxPerson(statsId, ANA), 0);
});
