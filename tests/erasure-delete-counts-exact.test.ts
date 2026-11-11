/**
 * Audit proof, Claude 6 (rule 24 audit of the erasure parts), CX-123 rules 24 and 30.
 *
 * Four erasure parts read their delete replies with Number(x) || 0 (or
 * Array.isArray(x) ? x : []), the shape already fixed in forgetLedgerCopy (#2711)
 * and forgetReadingsPerson (#3085): a reply of another shape was reported as
 * "0 removed, finished", so the person's erasure (lib/person-erasure.ts, and
 * lib/community-erasure.ts inside it) said done while data naming the person
 * might still be kept:
 *
 * - forgetAssistReminderPerson (lib/assistant-reminder.ts): the checkout
 *   reminder consents, which hold the address the buyer typed. An unknown
 *   SMEMBERS also became "no checkouts", so only the index went and the
 *   consents stayed, with nothing left to find them by.
 * - forgetLibraryPerson (lib/buyer-library.ts): the note that this address
 *   bought from or joined the store, in every quarter.
 * - forgetCommunityUnsub (lib/community-mail.ts): the member's unsubscribe token.
 * - forgetHandle (lib/community-mentions.ts): the member's @handle; an unknown
 *   HGET also became "not theirs". It is now one EVAL (check and delete in one
 *   step, tests/community-handle-forget-race.test.ts), read as 1 or 0 exactly.
 *
 * Expected: every off-shape reply rejects (UnknownReplyError), so the part is
 * said as not finished and retried; exact counts still count.
 */
import { createHash } from "node:crypto";
import { forgetAssistReminderPerson } from "@/lib/assistant-reminder";
import { assistRemindKey } from "@/lib/assistant-reminder-rules";
import { normaliseEmail } from "@/lib/auth";
import { forgetLibraryPerson } from "@/lib/buyer-library";
import { forgetCommunityUnsub, unsubKey } from "@/lib/community-mail";
import { forgetHandle } from "@/lib/community-mentions";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";

process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

const STATS = "5b1c0e9f3a7d4e2c8b6a9f0e1d2c3b4a";
const SID = "0a9b8c7d6e5f40312a3b4c5d6e7f8091";
const EMAIL = "reader@example.com";
const COMMUNITY = "c0ffee00c0ffee00c0ffee00c0ffee00";
const WHO = "m-7f3e2d1c";
const HANDLE = "reader.one";
const TOKEN = "u0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const SESSION = "cs_test_a1B2c3D4e5F6g7H8";

// One stand-in answer per command name; anything not set goes to the real stub.
let replies: Record<string, (commands: (string | number)[][]) => unknown> = {};
const sent: string[] = [];
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  const name = String(commands[0]?.[0] ?? "");
  sent.push(name);
  const fake = replies[name];
  if (fake && commands.every((c) => c[0] === name)) return fake(commands) as unknown[];
  return pipeline(commands);
}) as typeof redis.pipeline;

async function outcome(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return await run();
  } catch (error) {
    return `rejected: ${error instanceof Error ? error.name : "?"}`;
  }
}
const rejected = (got: unknown) => got === "rejected: UnknownReplyError";

// Off-shape answers to a pipeline of ONE delete.
const BAD_ONE: [string, unknown][] = [
  ["null", [null]],
  ["text", ["1"]],
  ["fractional", [0.5]],
  ["negative", [-1]],
  ["true", [true]],
  ["empty reply", []],
  ["second reply", [1, 1]],
  ["not a list", { result: 1 }],
];

const whoKey = (statsId: string, email: string) =>
  `nl:assist:remindwho:${statsId}:${createHash("sha256").update(`nimbus-assist-remind:${statsId}:${normaliseEmail(email)}`).digest("hex").slice(0, 32)}`;

void (async () => {
  // forgetAssistReminderPerson: the DEL of the index and its consents.
  for (const [label, bad] of [...BAD_ONE, ["more than the keys asked", [3]] as [string, unknown]]) {
    replies = { SMEMBERS: () => [[SESSION]], DEL: () => bad };
    is(`forgetAssistReminderPerson, DEL ${label}: never a finished count`, rejected(await outcome(() => forgetAssistReminderPerson(STATS, EMAIL))), true);
  }
  for (const n of [0, 1, 2]) {
    replies = { SMEMBERS: () => [[SESSION]], DEL: () => [n] };
    is(`forgetAssistReminderPerson: ${n} removed is ${n}`, await forgetAssistReminderPerson(STATS, EMAIL), n);
  }
  // Its SMEMBERS: an unknown list is not "no checkouts", and nothing is deleted on it (the index is the way back).
  for (const [label, bad] of [
    ["null", [null]],
    ["a number among the members", [[SESSION, 7]]],
    ["an object", [{ 0: SESSION }]],
    ["empty reply", []],
  ] as [string, unknown][]) {
    replies = { SMEMBERS: () => bad, DEL: () => [1] };
    sent.length = 0;
    const got = await outcome(() => forgetAssistReminderPerson(STATS, EMAIL));
    is(`forgetAssistReminderPerson, SMEMBERS ${label}: rejected`, rejected(got), true);
    is(`forgetAssistReminderPerson, SMEMBERS ${label}: no DEL sent`, sent.includes("DEL"), false);
  }
  // With the real stub: the index and the consent go, counted.
  replies = {};
  await redis.pipeline([["SADD", whoKey(STATS, EMAIL), SESSION], ["SET", assistRemindKey(SESSION), "{}"]]);
  is("forgetAssistReminderPerson: index and consent go, counted", await forgetAssistReminderPerson(STATS, EMAIL), 2);
  const [consent] = await redis.pipeline([["GET", assistRemindKey(SESSION)]]);
  is("forgetAssistReminderPerson: the consent is gone", consent, null);

  // forgetLibraryPerson: one SREM per quarter, each 0 or 1.
  const each = (n: number) => (commands: (string | number)[][]) => commands.map(() => n);
  for (const [label, make] of [
    ["one null", (c: (string | number)[][]) => c.map((_, i) => (i === 0 ? null : 0))],
    ["one text", (c: (string | number)[][]) => c.map((_, i) => (i === 0 ? "1" : 0))],
    ["one more than the one member", (c: (string | number)[][]) => c.map((_, i) => (i === 0 ? 2 : 0))],
    ["one negative", (c: (string | number)[][]) => c.map((_, i) => (i === 0 ? -1 : 0))],
    ["one reply short", (c: (string | number)[][]) => c.slice(1).map(() => 0)],
    ["one reply over", (c: (string | number)[][]) => [...c.map(() => 0), 0]],
    ["not a list", () => ({ result: 0 })],
  ] as [string, (c: (string | number)[][]) => unknown][]) {
    replies = { SREM: make };
    is(`forgetLibraryPerson, ${label}: never a finished count`, rejected(await outcome(() => forgetLibraryPerson(SID, EMAIL))), true);
  }
  replies = { SREM: each(0) };
  is("forgetLibraryPerson: all 0 is 0", await forgetLibraryPerson(SID, EMAIL), 0);
  replies = { SREM: (c) => c.map((_, i) => (i === 0 ? 1 : 0)) };
  is("forgetLibraryPerson: one quarter had it is 1", await forgetLibraryPerson(SID, EMAIL), 1);

  // forgetCommunityUnsub: the DEL of one token.
  for (const [label, bad] of [...BAD_ONE, ["more than the one key", [2]] as [string, unknown]]) {
    replies = { DEL: () => bad };
    is(`forgetCommunityUnsub, ${label}: never a finished count`, rejected(await outcome(() => forgetCommunityUnsub(TOKEN))), true);
  }
  replies = {};
  await redis.pipeline([["SET", unsubKey(TOKEN), `${COMMUNITY}|k|shop`]]);
  is("forgetCommunityUnsub: the token goes, counted", await forgetCommunityUnsub(TOKEN), 1);
  is("forgetCommunityUnsub: none left is none", await forgetCommunityUnsub(TOKEN), 0);

  // forgetHandle: one EVAL that deletes the handle only while it is theirs (FORGET_HANDLE), 1 or 0.
  for (const [label, bad] of [
    ...BAD_ONE,
    ["more than the one field", [2]],
    ["the owner's id", [WHO]],
    ["a list", [[1]]],
  ] as [string, unknown][]) {
    replies = { EVAL: () => bad };
    is(`forgetHandle, EVAL ${label}: never a finished count`, rejected(await outcome(() => forgetHandle(COMMUNITY, HANDLE, WHO))), true);
  }
  replies = { EVAL: () => [0] };
  is("forgetHandle: not theirs or already gone is 0", await forgetHandle(COMMUNITY, HANDLE, WHO), 0);
  replies = { EVAL: () => [1] };
  is("forgetHandle: theirs, removed, is 1", await forgetHandle(COMMUNITY, HANDLE, WHO), 1);
  // With the real stub: no owner, another member's, theirs.
  replies = {};
  const handles = `nl:cm:${COMMUNITY}:h`;
  is("forgetHandle: no owner is 0", await forgetHandle(COMMUNITY, HANDLE, WHO), 0);
  await redis.pipeline([["HSET", handles, HANDLE, "m-someone-else"]]);
  is("forgetHandle: another member's handle is kept, 0", await forgetHandle(COMMUNITY, HANDLE, WHO), 0);
  is("forgetHandle: another member's handle is still theirs", (await redis.pipeline([["HGET", handles, HANDLE]]))[0], "m-someone-else");
  await redis.pipeline([["HSET", handles, HANDLE, WHO]]);
  is("forgetHandle: theirs, removed, is 1", await forgetHandle(COMMUNITY, HANDLE, WHO), 1);
  is("forgetHandle: theirs, already gone, is 0", await forgetHandle(COMMUNITY, HANDLE, WHO), 0);
  done();
})();
