/**
 * A person's inbox conversations: the erasure never passes over a kept
 * conversation that does not read, and their copy is never given as complete
 * without what it could not read (CX-123 rule 24; Claude 3 cloud I, erasure
 * audit 14/11/2026).
 *
 * forgetInboxPerson read each kept conversation exactly, but one that was
 * neither null nor readable was neither "gone" nor "theirs": it was passed
 * over and the part answered done. The person's copy read the inbox with
 * the studio's readers, which leave out a conversation that does not read
 * and read a messages reply of another shape as no messages. Synthetic data only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { fileContact, forgetInboxPerson, readInbox } from "@/lib/inbox";
import { erasureScope } from "@/lib/person-erasure";
import { COPIERS } from "@/lib/person-copy";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "owner.ie@example.test";
const ANA = "ana.ie@example.test";

async function setup() {
  redis.clear();
  await claimHandle(OWNER, "ieinbox", "IE Inbox", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_IEInbox001", subscriptionId: "sub_IEInbox001", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  assert.equal(await fileContact({ store, email: ANA, name: "Ana", text: "Hello, a question about the course." }), true);
  const [conversation] = await readInbox(store.statsId);
  const scope = (await erasureScope(store, ANA))!;
  return { statsId: store.statsId!, id: conversation.id, copy: () => COPIERS["lib/inbox.ts"](scope) };
}

async function withReplyFor<T>(op: string, reply: unknown[], run: () => Promise<T>): Promise<T> {
  const original = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => (commands[0]?.[0] === op ? [...reply] : original(commands))) as typeof redis.pipeline;
  try {
    return await run();
  } finally {
    redis.pipeline = original;
  }
}

test("forgetInboxPerson: a kept conversation that does not read is not passed over as done", async () => {
  const { statsId, id } = await setup();
  await redis.pipeline([["SET", `nl:inbox:${statsId}:c:${id}`, `{"email":"${ANA}"`]]);
  await assert.rejects(forgetInboxPerson(statsId, ANA), (error: Error) => error.name === "UnknownReplyError");
  assert.notEqual((await redis.pipeline([["GET", `nl:inbox:${statsId}:c:${id}`]]))[0], null, "the record is still there for a retry");
});

test("the copy: the person's conversation and its messages are copied", async () => {
  const { copy } = await setup();
  const found = (await copy()) as { messages: { text: string }[] }[];
  assert.deepEqual(found.map((c) => c.messages.map((m) => m.text)), [["Hello, a question about the course."]]);
});

test("the copy: a kept conversation that does not read is not left out", async () => {
  const { statsId, id, copy } = await setup();
  await redis.pipeline([["SET", `nl:inbox:${statsId}:c:${id}`, "{"]]);
  await assert.rejects(copy(), (error: Error) => error.name === "UnknownReplyError");
});

for (const [label, reply] of [["object", [{}]], ["text", ["x"]], ["missing", []]] as [string, unknown[]][]) {
  test(`the copy: a ${label} messages reply is not "no messages"`, async () => {
    const { copy } = await setup();
    await assert.rejects(withReplyFor("LRANGE", reply, () => copy()), (error: Error) => error.name === "UnknownReplyError");
  });
}
