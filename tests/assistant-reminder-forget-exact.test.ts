/**
 * Rule 24 for the erasure and the copy of a person's checkout-reminder yeses
 * (lib/assistant-reminder.ts, forgetAssistReminderPerson and remindersOf).
 *
 * The note of the checkouts one address said yes on (SMEMBERS) was read as
 * "none" whenever its reply was out of shape: the erasure then deleted only
 * the note, reported success, and every yes it named stayed (with the typed
 * address) until it expired, unreachable, so a reminder still queued for it
 * was emailed to a person who had asked to be deleted. The copy of their data
 * said they had given no yes. Now an unreadable reply throws
 * UnknownReplyError: the erasure says this part could not finish (and can be
 * asked again), the copy fails whole. A confirmed empty set stays empty.
 * Synthetic data only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { forgetAssistReminderPerson, remindersOf } from "@/lib/assistant-reminder";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";

globalThis.fetch = (async (input: string | URL | Request) => {
  throw new Error(`no network in this test: ${String(input instanceof Request ? input.url : input)}`);
}) as typeof fetch;

const STATS = "0123456789abcdef0123456789abcdef";
const EMAIL = "buyer@assist-forget.example";
const SESSION = "cs_test_assistforgetexact0001";
const CONSENT = `nl:assist:remind:${SESSION}`;

/** Every command named answers `reply`; every other command is the stub's. */
async function withReply<T>(command: string, reply: () => unknown, run: () => Promise<T>): Promise<T> {
  const original = redis.pipeline;
  redis.pipeline = async (commands: (string | number)[][]) =>
    (commands[0]?.[0] === command ? reply() : original.call(redis, commands)) as Awaited<ReturnType<typeof original>>;
  try {
    return await run();
  } finally {
    redis.pipeline = original;
  }
}

const MALFORMED: [string, () => unknown][] = [
  ["no reply at all", () => []],
  ["a null in its slot", () => [null]],
  ["a number in its slot", () => [3]],
  ["an object in its slot", () => [{}]],
  ["a string in its slot", () => [SESSION]],
  ["a list with a number in it", () => [[1]]],
  ["a list with a hole", () => [new Array(1)]],
  ["two replies for one command", () => [[], []]],
];

for (const [label, reply] of MALFORMED) {
  test(`erasing a person's reminder yeses: ${label} is unknown, never nothing to erase`, async () => {
    redis.clear();
    await redis.pipeline([["SET", CONSENT, JSON.stringify({ s: STATS, e: EMAIL })]]);
    await withReply("SMEMBERS", reply, () => assert.rejects(() => forgetAssistReminderPerson(STATS, EMAIL), UnknownReplyError));
    const [kept] = await redis.pipeline([["EXISTS", CONSENT]]);
    assert.equal(kept, 1, "the yes is still there, so the erasure must not be said done");
  });

  test(`the copy of a person's reminder yeses: ${label} is unknown, never none`, async () => {
    redis.clear();
    await withReply("SMEMBERS", reply, () => assert.rejects(() => remindersOf(STATS, EMAIL), UnknownReplyError));
  });
}

test("erasing a person's reminder yeses: an unreadable count of what was deleted is unknown", async () => {
  redis.clear();
  await withReply("SMEMBERS", () => [[SESSION]], () =>
    withReply("DEL", () => ["OK"], () => assert.rejects(() => forgetAssistReminderPerson(STATS, EMAIL), UnknownReplyError)));
});

test("erasing a person's reminder yeses: a readable note deletes every yes it names", async () => {
  redis.clear();
  await redis.pipeline([["SET", CONSENT, JSON.stringify({ s: STATS, e: EMAIL })]]);
  const n = await withReply("SMEMBERS", () => [[SESSION]], () => forgetAssistReminderPerson(STATS, EMAIL));
  assert.ok(n >= 1, "the yes counts as deleted");
  const [kept] = await redis.pipeline([["EXISTS", CONSENT]]);
  assert.equal(kept, 0);
});

test("a confirmed empty note stays empty: nothing to erase, nothing to copy", async () => {
  redis.clear();
  // Resolves (never throws) with a count; the in-memory stand-in may count the empty note itself.
  const n = await forgetAssistReminderPerson(STATS, EMAIL);
  assert.ok(Number.isSafeInteger(n) && n >= 0 && n <= 1);
  assert.deepEqual(await remindersOf(STATS, EMAIL), []);
});

test("the copy: a yes that does not read is unknown, one that expired is not listed", async () => {
  redis.clear();
  await withReply("SMEMBERS", () => [[SESSION]], () =>
    withReply("GET", () => [7], () => assert.rejects(() => remindersOf(STATS, EMAIL), UnknownReplyError)));
  await withReply("SMEMBERS", () => [[SESSION]], () =>
    withReply("GET", () => [null], async () => assert.deepEqual(await remindersOf(STATS, EMAIL), [])));
});
