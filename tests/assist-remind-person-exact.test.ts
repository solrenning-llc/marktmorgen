/**
 * The Store assistant's checkout reminder, read in its exact shape where a
 * person is deleted or asks for a copy of their data (CX-123 rule 24;
 * Claude 7's privacy hunt, 12 November 2026):
 *
 *   - forgetting a person (forgetAssistReminderPerson, run by
 *     lib/person-erasure.ts): a list of their checkouts, or a count of what
 *     went, of another shape is unknown, and the erasure says this part could
 *     not finish. Before, a lost list read as "no checkouts": the note of
 *     them was deleted, the consents with the address were kept for up to
 *     three days with nothing left to find them by, and the erasure said done;
 *   - the copy of their data (remindersOf, lib/person-copy.ts): a list, or a
 *     consent, of another shape is unknown, never "no reminders asked for".
 *
 * The real functions over the in-memory Redis (tests/redis-stub.ts), with
 * only one pipeline's reply replaced. Controls show the healthy answers
 * still forget and copy as before. Synthetic records only.
 */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { forgetAssistReminderPerson, remindersOf } from "@/lib/assistant-reminder";
import { assistRemindKey } from "@/lib/assistant-reminder-rules";
import { store as redis } from "./redis-stub";

type Commands = (string | number)[][];
type Pipe = (commands: Commands) => Promise<unknown[]>;
async function intercept<T>(when: (commands: Commands) => boolean, answer: (commands: Commands, real: Pipe) => Promise<unknown>, run: () => Promise<T>): Promise<T> {
  const original = redis.pipeline;
  const real: Pipe = (commands) => original.call(redis, commands);
  redis.pipeline = (async (commands: Commands) => (when(commands) ? answer(commands, real) : real(commands))) as typeof redis.pipeline;
  try {
    return await run();
  } finally {
    redis.pipeline = original;
  }
}

const STATS = "st_assist_remind_exact";
const EMAIL = "kept.buyer@example.com";
const SESSION = "cs_test_assistRemindExact0001";
// The note of one address's checkouts, as lib/assistant-reminder.ts names it (whoKey).
const WHO = `nl:assist:remindwho:${STATS}:${createHash("sha256").update(`nimbus-assist-remind:${STATS}:${EMAIL}`).digest("hex").slice(0, 32)}`;
const CONSENT = JSON.stringify({ s: STATS, e: EMAIL, t: "Email me a reminder if I don't finish this order", v: "1", l: "en", at: 1_000 });

async function seed(): Promise<void> {
  await redis.pipeline([
    ["SET", assistRemindKey(SESSION), CONSENT, "EX", 3600],
    ["SADD", WHO, SESSION],
    ["EXPIRE", WHO, 3600],
  ]);
}
const isMembers = (c: Commands) => c.length === 1 && c[0][0] === "SMEMBERS" && c[0][1] === WHO;
const isDelete = (c: Commands) => c.length === 1 && c[0][0] === "DEL" && c[0][1] === WHO;
const isConsentRead = (c: Commands) => c.length >= 1 && c[0][0] === "GET" && String(c[0][1]) === assistRemindKey(SESSION);
const SHAPES: [() => Promise<unknown>, string][] = [
  [async () => [null], "answered nothing"],
  [async () => ["cs_test_assistRemindExact0001"], "answered text"],
  [async () => [7], "answered a number"],
  [async () => [], "no reply"],
  [async () => ({}), "no list"],
];

test("forgetting a person: their checkouts' list in another shape is unknown, and their consent is kept to be found again", async (t) => {
  for (const [answer, label] of SHAPES) {
    await t.test(label, async () => {
      await seed();
      await assert.rejects(intercept(isMembers, answer, () => forgetAssistReminderPerson(STATS, EMAIL)), `forget: SMEMBERS ${label}`);
      // Nothing that would let a retry find the consent was taken away.
      const [members] = await redis.pipeline([["SMEMBERS", WHO]]);
      assert.deepEqual(members, [SESSION], "the note of their checkouts is kept for the erasure pressed again");
    });
  }
});

test("forgetting a person: a count of what went in another shape is unknown, never 'nothing here'", async (t) => {
  for (const [answer, label] of [
    [async () => [null], "DEL answered nothing"],
    [async () => ["2"], "DEL answered text"],
    [async () => [-1], "DEL answered -1"],
    [async () => [], "DEL with no reply"],
  ] as [() => Promise<unknown>, string][]) {
    await t.test(label, async () => {
      await seed();
      await assert.rejects(intercept(isDelete, answer, () => forgetAssistReminderPerson(STATS, EMAIL)), `forget: ${label}`);
    });
  }
});

test("the copy of a person's data: a list or a consent in another shape is unknown, never 'no reminders'", async (t) => {
  for (const [answer, label] of SHAPES) {
    await t.test(`list ${label}`, async () => {
      await seed();
      await assert.rejects(intercept(isMembers, answer, () => remindersOf(STATS, EMAIL)), `copy: SMEMBERS ${label}`);
    });
  }
  for (const [answer, label] of [
    [async () => [7], "GET answered a number"],
    [async () => ["not json"], "GET answered text that is no consent"],
    [async () => [], "GET with no reply"],
    [async () => ({}), "GET with no list"],
  ] as [() => Promise<unknown>, string][]) {
    await t.test(label, async () => {
      await seed();
      await assert.rejects(intercept(isConsentRead, answer, () => remindersOf(STATS, EMAIL)), `copy: ${label}`);
    });
  }
});

test("a member of the note that is no checkout id is unknown, never skipped (Codex X6 MEDIUM on #3929)", async (t) => {
  // Only a checkout id is ever added to the note (lib/assistant-reminder.ts, recordAssistReminder), so a member of
  // another shape is a reply that does not read: skipping it would delete the note and keep that consent, address
  // and all, with nothing left to find it by, and the erasure would say it finished.
  for (const [answer, label] of [
    [async () => [[`${SESSION} `]], "the only member altered"],
    [async () => [[SESSION, "not-a-checkout"]], "one member of two altered"],
    [async () => [[SESSION, 7]], "a member that is a number"],
  ] as [() => Promise<unknown>, string][]) {
    await t.test(`forget: ${label}`, async () => {
      await seed();
      await assert.rejects(intercept(isMembers, answer, () => forgetAssistReminderPerson(STATS, EMAIL)), `forget: ${label}`);
      const [members, consent] = await redis.pipeline([["SMEMBERS", WHO], ["GET", assistRemindKey(SESSION)]]);
      assert.deepEqual(members, [SESSION], "the note of their checkouts is kept for the erasure pressed again");
      assert.equal(consent, CONSENT, "the consent is kept with a way to find it");
    });
    await t.test(`copy: ${label}`, async () => {
      await seed();
      await assert.rejects(intercept(isMembers, answer, () => remindersOf(STATS, EMAIL)), `copy: ${label}`);
    });
  }
});

test("control: the healthy answers copy and forget as before", async () => {
  await seed();
  assert.deepEqual(await remindersOf(STATS, EMAIL), [{ address: EMAIL, sentence: "Email me a reminder if I don't finish this order", version: "1", at: 1_000 }]);
  // A consent gone by itself (its three days) while the note remains is simply not there.
  await redis.pipeline([["SADD", WHO, "cs_test_assistRemindExact0002"]]);
  assert.equal((await remindersOf(STATS, EMAIL)).length, 1);
  assert.equal(await forgetAssistReminderPerson(STATS, EMAIL), 2);
  const [members, consent] = await redis.pipeline([["SMEMBERS", WHO], ["GET", assistRemindKey(SESSION)]]);
  assert.deepEqual([members, consent], [[], null]);
  // Pressed again for somebody already gone: it finishes, and nothing comes back.
  await forgetAssistReminderPerson(STATS, EMAIL);
  assert.deepEqual(await remindersOf(STATS, EMAIL), []);
});
