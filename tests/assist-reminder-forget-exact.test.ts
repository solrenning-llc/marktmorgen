/**
 * Rule 24 in an erasure (lib/assistant-reminder.ts, forgetAssistReminderPerson; lib/person-erasure.ts): the note of
 * which checkouts a person asked a reminder for (SMEMBERS) is read exactly. A reply cut short or of another shape
 * throws before anything is deleted, so the erasure is tried again, instead of deleting only the note and keeping
 * the consents with the address they typed (a queued reminder still found them and went to the erased person). The
 * DEL's own count is read exactly too: unknown is never "erased".
 *
 * Synthetic store and checkouts only.
 */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { forgetAssistReminderPerson } from "@/lib/assistant-reminder";
import { assistRemindKey } from "@/lib/assistant-reminder-rules";
import { store as redis } from "./redis-stub";

const STATS = "0123456789abcdef0123456789abcd01";
const EMAIL = "erase-me@example.com";
const who = `nl:assist:remindwho:${STATS}:${createHash("sha256").update(`nimbus-assist-remind:${STATS}:${EMAIL}`).digest("hex").slice(0, 32)}`;
const SESSIONS = ["cs_test_assistforget0001", "cs_test_assistforget0002"];
type Batch = (string | number)[][];
const pipeline = redis.pipeline.bind(redis);

async function seed(): Promise<void> {
  redis.clear();
  await pipeline([
    ["SADD", who, ...SESSIONS],
    ...SESSIONS.map((s) => ["SET", assistRemindKey(s), JSON.stringify({ to: EMAIL, at: 1 })]),
  ]);
}
const left = async () => (await pipeline(SESSIONS.map((s) => ["EXISTS", assistRemindKey(s)]))).reduce<number>((n, v) => n + Number(v), 0);

for (const [label, reply] of [["no reply", []], ["a number", [7]], ["null", [null]], ["a session that is not text", [[1]]]] as [string, unknown[]][]) {
  test(`the note read as ${label}: throws before anything is deleted`, async () => {
    await seed();
    redis.pipeline = (async (batch: Batch) => (batch.length === 1 && batch[0][0] === "SMEMBERS" && batch[0][1] === who ? reply : pipeline(batch))) as typeof redis.pipeline;
    let result: { value?: unknown; error?: unknown };
    try {
      result = { value: await forgetAssistReminderPerson(STATS, EMAIL) };
    } catch (error) {
      result = { error };
    } finally {
      redis.pipeline = pipeline;
    }
    assert.ok(result.error, `rejected, not ${JSON.stringify(result.value)}`);
    assert.equal(await left(), 2, "the consents are still there for the retry, with the note that finds them");
    assert.equal((await pipeline([["EXISTS", who]]))[0], 1);
  });
}

for (const [label, reply] of [["no reply", []], ["text", ["3"]], ["null", [null]]] as [string, unknown[]][]) {
  test(`the DEL answered as ${label}: unknown, never "erased"`, async () => {
    await seed();
    redis.pipeline = (async (batch: Batch) => {
      const real = await pipeline(batch);
      return batch.length === 1 && batch[0][0] === "DEL" && batch[0][1] === who ? reply : real;
    }) as typeof redis.pipeline;
    let threw = false;
    try {
      await forgetAssistReminderPerson(STATS, EMAIL);
    } catch {
      threw = true;
    } finally {
      redis.pipeline = pipeline;
    }
    assert.equal(threw, true);
  });
}

test("read exactly, every consent and the note go", async () => {
  await seed();
  assert.equal(await forgetAssistReminderPerson(STATS, EMAIL), 3);
  assert.equal(await left(), 0);
});
