/**
 * Deleting a person (lib/person-erasure.ts), the counts left after #2957's
 * first pass (Claude 5's MÉDIO and LEVES on c2055425): the four counts that
 * size the erasure's allowance next to the room and the certificates (deals,
 * conversations, a member's DMs, the community's events), the RSVPs and the
 * points a member's deletion reports, and the trace delete, are read exactly
 * (CX-123 rule 24). A reply that is not Redis's own count is not "nothing was
 * there": the erasure is sized as unavailable before the second allowance take,
 * or its step is said as not finished. And one step's unknown answer no longer
 * stops the community's later steps from running in the same pass.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { dealCount } from "@/lib/crm";
import { conversationCount } from "@/lib/inbox";
import { dmCount } from "@/lib/community-dm";
import { eventCount, forgetRsvpsPerson } from "@/lib/community-events";
import { forgetPointsPerson } from "@/lib/community-points";
import { forgetCommunityPerson } from "@/lib/community-erasure";
import { erasureSize } from "@/lib/person-erasure";
import type { ErasureScope } from "@/lib/erasure-rules";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";

type Command = (string | number)[];

const community = "0123456789abcdef0123456789abcdef";
const member = "fedcba9876543210fedcba9876543210";
const email = "fictional.member@example.test";
const statsId = "synthetic-stats";

/** Each reply that is not a count: text, null, negative, fraction, an object, or none at all. */
const BAD: [string, unknown[]][] = [
  ["text '1'", ["1"]],
  ["null", [null]],
  ["negative", [-1]],
  ["fraction", [1.5]],
  ["object", [{}]],
  ["missing", []],
];

async function withPipeline<T>(answer: (commands: Command[], original: (c: Command[]) => Promise<unknown[]>) => Promise<unknown[]>, run: () => Promise<T>): Promise<T> {
  const original = redis.pipeline;
  const call = (c: Command[]) => original.call(redis, c);
  redis.pipeline = (async (commands: Command[]) => answer(commands, call)) as typeof redis.pipeline;
  try {
    return await run();
  } finally {
    redis.pipeline = original;
  }
}

const withReplies = <T>(replies: unknown[], run: () => Promise<T>) => withPipeline(async () => [...replies], run);

const sizes: [string, () => Promise<number>][] = [
  ["the deals' count", () => dealCount(statsId)],
  ["the conversations' count", () => conversationCount(statsId)],
  ["the community's events count", () => eventCount(community)],
];

for (const [name, run] of sizes) {
  for (const [label, replies] of BAD) {
    test(`${name}: a ${label} reply throws, never counts as 0`, async () => {
      await assert.rejects(() => withReplies(replies, run));
    });
  }
}

for (const [label, replies] of [
  ["null first count", [null, 0]],
  ["text second count", [0, "1"]],
  ["object first count", [{}, 0]],
  ["fraction second count", [0, 0.5]],
  ["one reply of two", [1]],
] as [string, unknown[]][]) {
  test(`a member's DM count: a ${label} throws, never counts as 0`, async () => {
    await assert.rejects(() => withReplies(replies, () => dmCount(community, member)));
  });
}

const scope = {
  store: {} as Store,
  sid: "synthetic-sid",
  statsId,
  listId: null,
  email,
  person: "p-synthetic",
  learner: member,
  courses: [{ productId: "p1", courseId: "course-synthetic", lessonIds: [], moduleIds: [] }],
  productIds: ["p1"],
  communityId: community,
} satisfies ErasureScope;

const sizeCommand = (commands: Command[]) =>
  (commands.length === 1 && commands[0][0] === "HLEN" && commands[0][1] === `nl:crm:deals:${statsId}`) ||
  (commands.length === 1 && commands[0][0] === "ZCARD" && commands[0][1] === `nl:inbox:${statsId}:all`) ||
  (commands.length === 2 && commands[0][0] === "ZCARD" && commands[0][1] === `nl:cm:${community}:dm:i:${member}`) ||
  (commands.length === 1 && commands[0][0] === "ZCARD" && commands[0][1] === `nl:cm:${community}:evs`);

test("the erasure's size: the deals, conversations, DMs and events answered null reject it, never size it as 0", async () => {
  redis.clear();
  await assert.rejects(() =>
    withPipeline(async (commands, original) => (sizeCommand(commands) ? commands.map(() => null) : original(commands)), () => erasureSize(scope)),
  );
});

test("the erasure's size: healthy counts and confirmed absence are what Redis said", async () => {
  redis.clear();
  const none = await erasureSize(scope);
  assert.deepEqual([none.deals, none.conversations, none.dmConversations, none.events], [0, 0, 0, 0], "nothing kept: 0, as Redis answers it");
  await redis.pipeline([
    ["HSET", `nl:crm:deals:${statsId}`, "d1", "{}", "d2", "{}"],
    ["ZADD", `nl:inbox:${statsId}:all`, 1, "c1", 2, "c2", 3, "c3"],
    ["ZADD", `nl:cm:${community}:dm:i:${member}`, 1, "x"],
    ["ZADD", `nl:cm:${community}:dm:q:${member}`, 1, "y", 2, "z"],
    ["ZADD", `nl:cm:${community}:evs`, 1, "e1"],
  ]);
  const size = await erasureSize(scope);
  assert.deepEqual([size.deals, size.conversations, size.dmConversations, size.events], [2, 3, 3, 1]);
});

for (const [label, answer] of [
  ["the event list answered null", (c: Command[]) => (c[0][0] === "ZRANGEBYSCORE" ? [null] : undefined)],
  ["the event list answered an object", (c: Command[]) => (c[0][0] === "ZRANGEBYSCORE" ? [{}] : undefined)],
  ["an HDEL answered text", (c: Command[]) => (c[0][0] === "HDEL" ? c.map((x) => (x[0] === "HDEL" ? "1" : 1)) : undefined)],
  ["the access DEL answered 'OK'", (c: Command[]) => (c[0][0] === "HDEL" ? c.map((x) => (x[0] === "DEL" ? "OK" : 1)) : undefined)],
  ["one reply short", (c: Command[]) => (c[0][0] === "HDEL" ? c.slice(1).map(() => 1) : undefined)],
] as [string, (c: Command[]) => unknown[] | undefined][]) {
  test(`a member's RSVPs forgotten: ${label} throws, never counts as 0`, async () => {
    redis.clear();
    await redis.pipeline([["ZADD", `nl:cm:${community}:evs`, 1, "e1"]]);
    await assert.rejects(() => withPipeline(async (commands, original) => answer(commands) ?? original(commands), () => forgetRsvpsPerson(community, member, email)));
  });
}

for (const [label, replies] of BAD) {
  test(`a member's points forgotten: a ${label} first reply throws, never counts as 0`, async () => {
    await assert.rejects(() => withPipeline(async (commands) => [...replies, ...commands.slice(1).map(() => 0)], () => forgetPointsPerson(community, member)));
  });
}

test("a member's RSVPs and points: healthy and confirmed absence", async () => {
  redis.clear();
  assert.equal(await forgetRsvpsPerson(community, member, email), 0, "no events kept: 0");
  assert.equal(await forgetPointsPerson(community, member), 0, "no points kept: 0");
  await redis.pipeline([
    ["ZADD", `nl:cm:${community}:evs`, 1, "e1", 2, "e2"],
    ["HSET", `nl:cm:${community}:ev:e1:r`, member, "1"],
    ["ZADD", `nl:cm:${community}:pts`, 5, member],
  ]);
  assert.equal(await forgetRsvpsPerson(community, member, email), 1, "what HDEL said it removed");
  assert.equal(await forgetPointsPerson(community, member), 1, "what ZREM said it removed");
});

test("a member's community deletion: the trace DEL answered 'OK' is not done with 0", async () => {
  redis.clear();
  const trace = `nl:cm:${community}:tr:${member}`;
  await assert.rejects(() =>
    withPipeline(async (commands, original) => (commands.length === 1 && commands[0][0] === "DEL" && commands[0][1] === trace ? ["OK"] : original(commands)), () =>
      forgetCommunityPerson(community, member, email, []),
    ),
  );
});

test("a member's community deletion: an unknown room-leave answer still lets the later steps run, then says not done", async () => {
  redis.clear();
  const grant = `nl:cm:${community}:rg:${member}`;
  const sent: string[] = [];
  await assert.rejects(() =>
    withPipeline(
      async (commands, original) => {
        for (const c of commands) sent.push(`${c[0]} ${c[1]}`);
        return commands.length === 1 && commands[0][0] === "DEL" && commands[0][1] === grant ? ["OK"] : original(commands);
      },
      () => forgetCommunityPerson(community, member, email, []),
    ),
  );
  assert.ok(sent.includes(`HDEL nl:cm:${community}:wel`), "the access answers are still forgotten in the same pass");
  assert.ok(sent.some((s) => s.startsWith(`ZRANGEBYSCORE nl:cm:${community}:evs`)), "the RSVPs are still forgotten in the same pass");
});

test("a member's community deletion: healthy, nothing kept, is done with 0", async () => {
  redis.clear();
  assert.equal(await forgetCommunityPerson(community, member, email, []), 0);
});
